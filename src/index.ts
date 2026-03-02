#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const log = (msg: string) => process.stderr.write(`[difflens] ${msg}\n`);

function printHelp(): void {
  const message = `DiffLens v${pkg.version} — visual diff MCP server for AI coding agents

Usage:
  difflens          Start MCP server (called automatically by Claude Code)
  difflens setup    Add DiffLens to .mcp.json in the current directory

Quick start:
  1. Run: difflens setup
  2. Restart Claude Code
  3. Ask Claude: "take a snapshot of http://localhost:3000"

Or use without installing (add to .mcp.json):
  { "mcpServers": { "difflens": { "command": "npx", "args": ["-y", "difflens-cli"] } } }
`;
  process.stdout.write(message);
}

const CLAUDE_MD_CONTENT = `# DiffLens — Instructions for Claude Code

## DiffLens Visual Verification (MANDATORY)

When this project has DiffLens MCP tools available, you MUST follow
this workflow for ANY change that affects visual UI (HTML, CSS, JSX,
TSX, Vue, Svelte, SCSS, Tailwind classes, component styling, layout
changes, or anything that would change how a page looks):

### Before making changes:
1. Ask the user what URL to check if you don't already know it
   (e.g. http://localhost:3000)
2. Call \`snapshot\` on that URL to save the current state as a baseline

### After making changes:
3. Call \`check\` on the same URL to compare against your snapshot
4. Read the diff report carefully
5. If there are ANY unintended changes (layout shifts, missing elements,
   color changes, overlaps, broken responsive behavior), fix them
   immediately
6. Call \`check\` again to verify your fixes worked
7. Only respond to the user once the diff report shows no unintended
   changes

### For responsive changes:
- Use \`check_responsive\` instead of \`check\` when the change involves
  layout, flexbox, grid, media queries, or anything that could look
  different on mobile vs desktop

### Rules:
- NEVER skip the visual check. Even if you're confident the change is
  correct, verify it.
- If the dev server is not running, tell the user to start it before
  you proceed with UI changes.
- If the diff shows problems you can't fix after 3 attempts, show the
  user the diff report and ask for guidance.
`;

const PRE_HOOK_CONTENT = `#!/bin/bash
# PreToolUse hook: remind Claude to snapshot before editing UI files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ "$FILE_PATH" =~ \\.(html|css|jsx|tsx|vue|svelte|scss|sass|less)$ ]]; then
  cat <<'HOOK_EOF'
{
  "additionalContext": "[DiffLens] You are about to edit a UI file. BEFORE making this edit, ensure you have already called \`snapshot\` on the dev server URL to save a baseline. If you haven't taken a snapshot yet for this task, do it NOW before proceeding with the edit. If the user hasn't told you the dev server URL, ask them first."
}
HOOK_EOF
  exit 0
fi

exit 0
`;

const POST_HOOK_CONTENT = `#!/bin/bash
# PostToolUse hook: remind Claude to run visual check after editing UI files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ "$FILE_PATH" =~ \\.(html|css|jsx|tsx|vue|svelte|scss|sass|less)$ ]]; then
  cat <<'HOOK_EOF'
{
  "additionalContext": "[DiffLens] You just edited a UI file. Once you are done with ALL edits for this change, call \`check\` (or \`check_responsive\` for layout changes) on the dev server URL to verify there are no unintended visual regressions. Do NOT skip this step."
}
HOOK_EOF
  exit 0
fi

exit 0
`;

const HOOKS_SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          {
            type: 'command',
            command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/difflens-pre-edit.sh',
            timeout: 5,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          {
            type: 'command',
            command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/difflens-post-edit.sh',
            timeout: 5,
          },
        ],
      },
    ],
  },
};

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function setupCommand(): Promise<void> {
  const cwd = process.cwd();

  // 1. Write/merge .mcp.json
  const mcpPath = join(cwd, '.mcp.json');
  let config: Record<string, unknown> = {};

  try {
    const existing = await readFile(mcpPath, 'utf-8');
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  (config.mcpServers as Record<string, unknown>).difflens = {
    command: 'difflens',
    args: [],
  };

  await writeFile(mcpPath, JSON.stringify(config, null, 2) + '\n');
  process.stdout.write(`  ${green('✓')} Added DiffLens MCP server to .mcp.json\n`);

  // 2. Write CLAUDE.md (append if exists, create if not)
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  try {
    const existing = await readFile(claudeMdPath, 'utf-8');
    if (!existing.includes('DiffLens Visual Verification')) {
      await writeFile(claudeMdPath, existing + '\n' + CLAUDE_MD_CONTENT);
      process.stdout.write(`  ${green('✓')} Appended DiffLens instructions to CLAUDE.md\n`);
    } else {
      process.stdout.write(`  ${green('✓')} CLAUDE.md already has DiffLens instructions\n`);
    }
  } catch {
    await writeFile(claudeMdPath, CLAUDE_MD_CONTENT);
    process.stdout.write(`  ${green('✓')} Created CLAUDE.md with DiffLens instructions\n`);
  }

  // 3. Write hook scripts
  const hooksDir = join(cwd, '.claude', 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const preHookPath = join(hooksDir, 'difflens-pre-edit.sh');
  const postHookPath = join(hooksDir, 'difflens-post-edit.sh');

  await writeFile(preHookPath, PRE_HOOK_CONTENT);
  await chmod(preHookPath, 0o755);
  await writeFile(postHookPath, POST_HOOK_CONTENT);
  await chmod(postHookPath, 0o755);
  process.stdout.write(`  ${green('✓')} Installed Claude Code hooks in .claude/hooks/\n`);

  // 4. Write/merge .claude/settings.json with hooks config
  const settingsPath = join(cwd, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};

  try {
    const existing = await readFile(settingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist — start fresh
  }

  // Merge hooks config
  const existingHooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const newHooks = HOOKS_SETTINGS.hooks as Record<string, unknown[]>;

  for (const [event, matchers] of Object.entries(newHooks)) {
    if (!existingHooks[event]) {
      existingHooks[event] = [];
    }
    // Only add if not already present
    const existing = JSON.stringify(existingHooks[event]);
    for (const matcher of matchers) {
      if (!existing.includes('difflens-pre-edit') && !existing.includes('difflens-post-edit')) {
        (existingHooks[event] as unknown[]).push(matcher);
      }
    }
  }

  settings.hooks = existingHooks;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  process.stdout.write(`  ${green('✓')} Added hooks to .claude/settings.json\n`);

  // Welcome banner
  const banner = `
  ${dim('┌─────────────────────────────────────────────┐')}
  ${dim('│')}                                             ${dim('│')}
  ${dim('│')}   ${cyan('◆')} ${bold('DiffLens')} ${dim(`v${pkg.version}`)} — setup complete        ${dim('│')}
  ${dim('│')}                                             ${dim('│')}
  ${dim('└─────────────────────────────────────────────┘')}

  ${bold('What happens now:')}

    ${green('1.')} Restart Claude Code
    ${green('2.')} Make any UI change — Claude snapshots and verifies automatically

    You say ${dim('"move the button to the right"')} and Claude will:
    ${dim('→')} snapshot the page ${dim('→')} make the edit ${dim('→')} check the diff ${dim('→')} fix regressions

  ${bold('Tools available to Claude:')}

    ${yellow('snapshot')}           Screenshot a page as a baseline
    ${yellow('check')}              Diff current page against baseline
    ${yellow('check_responsive')}   Diff at multiple viewport widths
    ${yellow('snapshot_element')}   Screenshot a specific DOM element
    ${yellow('list_snapshots')}     List stored snapshots
    ${yellow('cleanup')}            Delete old snapshots

  ${dim('GitHub: https://github.com/byzkhan/difflens')}
`;
  process.stdout.write(banner);
}

// --- CLI dispatch ---
const subcommand = process.argv[2];

if (subcommand === 'setup') {
  setupCommand().catch((err) => {
    process.stderr.write(`[difflens] Setup failed: ${err}\n`);
    process.exit(1);
  });
} else if (!subcommand && process.stdin.isTTY) {
  printHelp();
  process.exit(0);
} else {
  // Non-TTY stdin (MCP mode) or unknown subcommand → start server
  startServer();
}

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

async function startMcpServer() {
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

function startServer() {
  startMcpServer().catch((err) => {
    process.stderr.write(`[difflens] Fatal error: ${err}\n`);
    process.exit(1);
  });
}
