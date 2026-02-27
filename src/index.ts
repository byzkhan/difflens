#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  ensureStorageDirs,
  generateSnapshotId,
  saveSnapshot,
  loadSnapshotMetadata,
  loadSnapshotImage,
  findLatestSnapshot,
  listSnapshots,
  cleanupSnapshots,
  getDiffsDir,
} from './storage.js';
import { takeScreenshot, takeElementScreenshot, closeBrowser } from './screenshotter.js';
import { computeDiff } from './differ.js';
import { buildReport, buildResponsiveReport } from './report-builder.js';
import { DiffLensError } from './types.js';
import type { Viewport } from './types.js';

const log = (msg: string) => process.stderr.write(`[difflens] ${msg}\n`);

function errorResponse(err: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (err instanceof DiffLensError) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, code: err.code, message: err.message }),
      }],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: true, code: 'UNKNOWN', message }),
    }],
  };
}

async function main() {
  await ensureStorageDirs();

  const server = new McpServer({
    name: 'difflens',
    version: '1.0.0',
  });

  // Tool 1: snapshot
  server.tool(
    'snapshot',
    'Take a screenshot of a URL and save it as a baseline snapshot',
    {
      url: z.string().url().describe('The URL to screenshot (e.g. http://localhost:3000)'),
      width: z.number().optional().default(1280).describe('Viewport width in pixels'),
      height: z.number().optional().default(720).describe('Viewport height in pixels'),
      fullPage: z.boolean().optional().default(true).describe('Capture full scrollable page'),
      waitForSelector: z.string().optional().describe('CSS selector to wait for before capturing'),
      waitForTimeout: z.number().optional().describe('Additional wait time in ms after page load'),
    },
    async (params) => {
      try {
        const viewport: Viewport = { width: params.width, height: params.height };
        const id = generateSnapshotId();

        const imageBuffer = await takeScreenshot({
          url: params.url,
          viewport,
          fullPage: params.fullPage,
          waitForSelector: params.waitForSelector,
          waitForTimeout: params.waitForTimeout,
        });

        const metadata = await saveSnapshot(id, imageBuffer, {
          id,
          url: params.url,
          viewport,
          fullPage: params.fullPage,
          timestamp: Date.now(),
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              snapshot: {
                id: metadata.id,
                url: metadata.url,
                viewport: metadata.viewport,
                timestamp: new Date(metadata.timestamp).toISOString(),
                imagePath: metadata.imagePath,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // Tool 2: check
  server.tool(
    'check',
    'Take a new screenshot and compare it against the latest baseline (or a specific snapshot). Returns a diff report with change regions and an overlay image.',
    {
      url: z.string().url().describe('The URL to check for visual changes'),
      baselineId: z.string().optional().describe('Specific snapshot ID to compare against (uses latest if omitted)'),
      width: z.number().optional().default(1280).describe('Viewport width in pixels'),
      height: z.number().optional().default(720).describe('Viewport height in pixels'),
      fullPage: z.boolean().optional().default(true).describe('Capture full scrollable page'),
      waitForSelector: z.string().optional().describe('CSS selector to wait for before capturing'),
      waitForTimeout: z.number().optional().describe('Additional wait time in ms after page load'),
    },
    async (params) => {
      try {
        const viewport: Viewport = { width: params.width, height: params.height };

        // Find baseline
        let baselineId = params.baselineId;
        if (!baselineId) {
          const latest = await findLatestSnapshot(params.url);
          if (!latest) {
            throw new DiffLensError(
              'NO_BASELINE',
              `No baseline snapshot found for ${params.url}. Run 'snapshot' first.`
            );
          }
          baselineId = latest.id;
        }

        const baselineMetadata = await loadSnapshotMetadata(baselineId);
        const baselineImage = await loadSnapshotImage(baselineId);

        // Take new screenshot
        const currentImage = await takeScreenshot({
          url: params.url,
          viewport,
          fullPage: params.fullPage,
          waitForSelector: params.waitForSelector,
          waitForTimeout: params.waitForTimeout,
        });

        // Save the current screenshot too
        const currentId = generateSnapshotId();
        await saveSnapshot(currentId, currentImage, {
          id: currentId,
          url: params.url,
          viewport,
          fullPage: params.fullPage,
          timestamp: Date.now(),
        });

        // Compute diff
        const diffId = `${baselineId}_vs_${currentId}`;
        const diffResult = await computeDiff(baselineImage, currentImage, diffId);
        const report = buildReport(diffResult);

        // Read overlay image and return inline
        const overlayBuffer = await readFile(report.overlayImagePath);
        const overlayBase64 = overlayBuffer.toString('base64');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                baselineId,
                currentId,
                report: {
                  status: report.status,
                  summary: report.summary,
                  percentChanged: report.percentChanged,
                  dimensions: report.dimensions,
                  regions: report.regions,
                  diffImagePath: report.diffImagePath,
                  overlayImagePath: report.overlayImagePath,
                },
              }, null, 2),
            },
            {
              type: 'image' as const,
              data: overlayBase64,
              mimeType: 'image/png',
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // Tool 3: check_responsive
  server.tool(
    'check_responsive',
    'Run visual diff checks at multiple viewport widths to detect responsive design issues',
    {
      url: z.string().url().describe('The URL to check'),
      widths: z.array(z.number()).optional().default([375, 768, 1024, 1440]).describe('Viewport widths to test'),
      height: z.number().optional().default(720).describe('Viewport height'),
      fullPage: z.boolean().optional().default(true).describe('Capture full scrollable page'),
      waitForSelector: z.string().optional().describe('CSS selector to wait for'),
      waitForTimeout: z.number().optional().describe('Additional wait time in ms'),
    },
    async (params) => {
      try {
        const viewportResults: Array<{ viewport: Viewport; report: ReturnType<typeof buildReport> }> = [];

        for (const width of params.widths) {
          const viewport: Viewport = { width, height: params.height };

          // Find baseline for this viewport+url combo
          const allSnapshots = await listSnapshots({ url: params.url });
          const baseline = allSnapshots.find(
            s => s.viewport.width === width && s.viewport.height === params.height
          );

          if (!baseline) {
            // Take baseline snapshot first
            const id = generateSnapshotId();
            const imageBuffer = await takeScreenshot({
              url: params.url,
              viewport,
              fullPage: params.fullPage,
              waitForSelector: params.waitForSelector,
              waitForTimeout: params.waitForTimeout,
            });
            await saveSnapshot(id, imageBuffer, {
              id,
              url: params.url,
              viewport,
              fullPage: params.fullPage,
              timestamp: Date.now(),
            });

            viewportResults.push({
              viewport,
              report: buildReport({
                totalPixels: 0,
                changedPixels: 0,
                percentChanged: 0,
                dimensions: { before: viewport, after: viewport, resized: false },
                regions: [],
                diffImagePath: '',
                overlayImagePath: '',
              }),
            });
            continue;
          }

          const baselineImage = await loadSnapshotImage(baseline.id);
          const currentImage = await takeScreenshot({
            url: params.url,
            viewport,
            fullPage: params.fullPage,
            waitForSelector: params.waitForSelector,
            waitForTimeout: params.waitForTimeout,
          });

          const currentId = generateSnapshotId();
          await saveSnapshot(currentId, currentImage, {
            id: currentId,
            url: params.url,
            viewport,
            fullPage: params.fullPage,
            timestamp: Date.now(),
          });

          const diffId = `${baseline.id}_vs_${currentId}`;
          const diffResult = await computeDiff(baselineImage, currentImage, diffId);
          viewportResults.push({ viewport, report: buildReport(diffResult) });
        }

        const responsiveReport = buildResponsiveReport(params.url, viewportResults);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              ...responsiveReport,
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // Tool 4: snapshot_element
  server.tool(
    'snapshot_element',
    'Screenshot a specific DOM element by CSS selector and return the image inline',
    {
      url: z.string().url().describe('The URL containing the element'),
      selector: z.string().describe('CSS selector of the element to capture'),
      width: z.number().optional().default(1280).describe('Viewport width'),
      height: z.number().optional().default(720).describe('Viewport height'),
      waitForSelector: z.string().optional().describe('CSS selector to wait for before capturing'),
      waitForTimeout: z.number().optional().describe('Additional wait time in ms'),
    },
    async (params) => {
      try {
        const viewport: Viewport = { width: params.width, height: params.height };

        const imageBuffer = await takeElementScreenshot(
          params.url,
          params.selector,
          viewport,
          params.waitForSelector,
          params.waitForTimeout,
        );

        // Save as snapshot
        const id = generateSnapshotId();
        const metadata = await saveSnapshot(id, imageBuffer, {
          id,
          url: params.url,
          viewport,
          fullPage: false,
          selector: params.selector,
          timestamp: Date.now(),
        });

        const imageBase64 = imageBuffer.toString('base64');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                snapshot: {
                  id: metadata.id,
                  url: metadata.url,
                  selector: params.selector,
                  viewport: metadata.viewport,
                  timestamp: new Date(metadata.timestamp).toISOString(),
                  imagePath: metadata.imagePath,
                },
              }, null, 2),
            },
            {
              type: 'image' as const,
              data: imageBase64,
              mimeType: 'image/png',
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // Tool 5: list_snapshots
  server.tool(
    'list_snapshots',
    'List stored snapshots with optional URL filter',
    {
      url: z.string().optional().describe('Filter by URL'),
      limit: z.number().optional().default(20).describe('Maximum number of snapshots to return'),
    },
    async (params) => {
      try {
        const snapshots = await listSnapshots({
          url: params.url,
          limit: params.limit,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: snapshots.length,
              snapshots: snapshots.map(s => ({
                id: s.id,
                url: s.url,
                viewport: s.viewport,
                selector: s.selector,
                timestamp: new Date(s.timestamp).toISOString(),
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // Tool 6: cleanup
  server.tool(
    'cleanup',
    'Delete old snapshots by age or count. Supports dry run to preview what would be deleted.',
    {
      maxAgeHours: z.number().optional().describe('Delete snapshots older than this many hours'),
      maxCount: z.number().optional().describe('Keep at most this many snapshots (newest first)'),
      dryRun: z.boolean().optional().default(false).describe('Preview what would be deleted without actually deleting'),
    },
    async (params) => {
      try {
        const result = await cleanupSnapshots({
          maxAge: params.maxAgeHours ? params.maxAgeHours * 60 * 60 * 1000 : undefined,
          maxCount: params.maxCount,
          dryRun: params.dryRun,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              dryRun: result.dryRun,
              deletedCount: result.deleted.length,
              deletedIds: result.deleted,
              keptCount: result.kept,
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    await closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('DiffLens MCP server running on stdio');
}

main().catch((err) => {
  process.stderr.write(`[difflens] Fatal error: ${err}\n`);
  process.exit(1);
});
