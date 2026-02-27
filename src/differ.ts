import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { join } from 'node:path';
import { getDiffsDir } from './storage.js';
import type { DiffResult, DiffRegion, Viewport } from './types.js';

const log = (msg: string) => process.stderr.write(`[difflens] ${msg}\n`);

function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

function normalizeDimensions(
  beforePng: PNG,
  afterPng: PNG
): { before: PNG; after: PNG; width: number; height: number } {
  const width = Math.max(beforePng.width, afterPng.width);
  const height = Math.max(beforePng.height, afterPng.height);

  const padImage = (png: PNG, targetW: number, targetH: number): PNG => {
    if (png.width === targetW && png.height === targetH) return png;

    const padded = new PNG({ width: targetW, height: targetH, fill: true });
    // Fill with transparent pixels
    padded.data.fill(0);

    // Copy original pixels
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const srcIdx = (y * png.width + x) * 4;
        const dstIdx = (y * targetW + x) * 4;
        padded.data[srcIdx] !== undefined && padded.data.copy(padded.data, dstIdx, srcIdx, srcIdx); // noop placeholder
        // Direct pixel copy
        padded.data[dstIdx] = png.data[srcIdx];
        padded.data[dstIdx + 1] = png.data[srcIdx + 1];
        padded.data[dstIdx + 2] = png.data[srcIdx + 2];
        padded.data[dstIdx + 3] = png.data[srcIdx + 3];
      }
    }
    return padded;
  };

  return {
    before: padImage(beforePng, width, height),
    after: padImage(afterPng, width, height),
    width,
    height,
  };
}

function clusterRegions(
  diffData: Uint8Array,
  width: number,
  height: number
): DiffRegion[] {
  const CELL_SIZE = 10;
  const MERGE_DISTANCE = 50;

  const cols = Math.ceil(width / CELL_SIZE);
  const rows = Math.ceil(height / CELL_SIZE);

  // Count changed pixels per grid cell
  // A pixel is "changed" if it's red in the diff output (R=255, G=0 or near 0)
  const cellCounts: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = diffData[idx];
      const g = diffData[idx + 1];
      const b = diffData[idx + 2];
      const a = diffData[idx + 3];
      // pixelmatch marks diff pixels as red (255, 0, 0) with full alpha
      if (r > 200 && g < 80 && b < 80 && a > 200) {
        const col = Math.floor(x / CELL_SIZE);
        const row = Math.floor(y / CELL_SIZE);
        cellCounts[row][col]++;
      }
    }
  }

  // Collect non-empty cells as initial boxes
  interface Box {
    x1: number; y1: number; x2: number; y2: number; changedPixels: number;
  }

  let boxes: Box[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (cellCounts[row][col] > 0) {
        boxes.push({
          x1: col * CELL_SIZE,
          y1: row * CELL_SIZE,
          x2: Math.min((col + 1) * CELL_SIZE, width),
          y2: Math.min((row + 1) * CELL_SIZE, height),
          changedPixels: cellCounts[row][col],
        });
      }
    }
  }

  // Iterative merge: merge boxes within proximity
  let merged = true;
  while (merged) {
    merged = false;
    const newBoxes: Box[] = [];
    const used = new Set<number>();

    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      let current = { ...boxes[i] };

      for (let j = i + 1; j < boxes.length; j++) {
        if (used.has(j)) continue;
        const other = boxes[j];

        // Check proximity
        const dx = Math.max(0, Math.max(current.x1, other.x1) - Math.min(current.x2, other.x2));
        const dy = Math.max(0, Math.max(current.y1, other.y1) - Math.min(current.y2, other.y2));

        if (dx <= MERGE_DISTANCE && dy <= MERGE_DISTANCE) {
          current = {
            x1: Math.min(current.x1, other.x1),
            y1: Math.min(current.y1, other.y1),
            x2: Math.max(current.x2, other.x2),
            y2: Math.max(current.y2, other.y2),
            changedPixels: current.changedPixels + other.changedPixels,
          };
          used.add(j);
          merged = true;
        }
      }

      newBoxes.push(current);
    }

    boxes = newBoxes;
  }

  // Convert to DiffRegion[]
  const totalPixels = width * height;
  return boxes
    .map((box): DiffRegion => {
      const regionWidth = box.x2 - box.x1;
      const regionHeight = box.y2 - box.y1;
      const regionPixels = regionWidth * regionHeight;
      return {
        x: box.x1,
        y: box.y1,
        width: regionWidth,
        height: regionHeight,
        changedPixels: box.changedPixels,
        percentChanged: (box.changedPixels / regionPixels) * 100,
        description: describePosition(box.x1, box.y1, regionWidth, regionHeight, width, height),
      };
    })
    .sort((a, b) => b.changedPixels - a.changedPixels);
}

function describePosition(
  x: number, y: number, w: number, h: number,
  imgW: number, imgH: number
): string {
  const cx = x + w / 2;
  const cy = y + h / 2;

  const horizontal = cx < imgW / 3 ? 'Left' : cx > (imgW * 2) / 3 ? 'Right' : 'Center';
  const vertical = cy < imgH / 3 ? 'Top' : cy > (imgH * 2) / 3 ? 'Bottom' : 'Middle';

  return `${vertical}-${horizontal.toLowerCase()} area (${w}x${h}px)`;
}

async function createOverlay(
  afterBuffer: Buffer,
  diffPng: PNG,
  regions: DiffRegion[],
  width: number,
  height: number,
  percentChanged: number
): Promise<Buffer> {
  // Layer 1: Semi-transparent dark overlay for unchanged areas
  const darkOverlay = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = diffPng.data[idx];
    const g = diffPng.data[idx + 1];
    const b = diffPng.data[idx + 2];
    const isChanged = r > 200 && g < 80 && b < 80;

    if (!isChanged) {
      // Darken unchanged areas
      darkOverlay[idx] = 0;
      darkOverlay[idx + 1] = 0;
      darkOverlay[idx + 2] = 0;
      darkOverlay[idx + 3] = 80; // semi-transparent black
    } else {
      darkOverlay[idx] = 0;
      darkOverlay[idx + 1] = 0;
      darkOverlay[idx + 2] = 0;
      darkOverlay[idx + 3] = 0; // transparent over changed areas
    }
  }

  // Layer 2: Red highlight on changed pixels
  const redHighlight = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = diffPng.data[idx];
    const g = diffPng.data[idx + 1];
    const b = diffPng.data[idx + 2];
    const isChanged = r > 200 && g < 80 && b < 80;

    if (isChanged) {
      redHighlight[idx] = 255;
      redHighlight[idx + 1] = 0;
      redHighlight[idx + 2] = 0;
      redHighlight[idx + 3] = 100; // semi-transparent red
    }
  }

  // Layer 3: Region borders (2px red)
  const borders = Buffer.alloc(width * height * 4);
  const BORDER_WIDTH = 2;
  for (const region of regions) {
    for (let px = region.x; px < region.x + region.width; px++) {
      for (let bw = 0; bw < BORDER_WIDTH; bw++) {
        // Top border
        const topY = region.y + bw;
        if (topY < height && px < width) {
          const idx = (topY * width + px) * 4;
          borders[idx] = 255; borders[idx + 1] = 50; borders[idx + 2] = 50; borders[idx + 3] = 220;
        }
        // Bottom border
        const botY = region.y + region.height - 1 - bw;
        if (botY >= 0 && botY < height && px < width) {
          const idx = (botY * width + px) * 4;
          borders[idx] = 255; borders[idx + 1] = 50; borders[idx + 2] = 50; borders[idx + 3] = 220;
        }
      }
    }
    for (let py = region.y; py < region.y + region.height; py++) {
      for (let bw = 0; bw < BORDER_WIDTH; bw++) {
        // Left border
        const leftX = region.x + bw;
        if (py < height && leftX < width) {
          const idx = (py * width + leftX) * 4;
          borders[idx] = 255; borders[idx + 1] = 50; borders[idx + 2] = 50; borders[idx + 3] = 220;
        }
        // Right border
        const rightX = region.x + region.width - 1 - bw;
        if (py < height && rightX >= 0 && rightX < width) {
          const idx = (py * width + rightX) * 4;
          borders[idx] = 255; borders[idx + 1] = 50; borders[idx + 2] = 50; borders[idx + 3] = 220;
        }
      }
    }
  }

  // Layer 4: Legend bar at bottom
  const legendHeight = 40;
  const totalHeight = height + legendHeight;
  const statusText = percentChanged === 0 ? 'No changes' :
    percentChanged < 1 ? 'Minor changes' :
    percentChanged < 10 ? 'Significant changes' : 'Major changes';
  const legendSvg = `<svg width="${width}" height="${legendHeight}">
    <rect width="${width}" height="${legendHeight}" fill="#1a1a2e"/>
    <rect x="10" y="10" width="20" height="20" fill="rgba(255,0,0,0.4)" stroke="#ff3232" stroke-width="2"/>
    <text x="40" y="25" fill="white" font-family="Arial, sans-serif" font-size="14">
      ${statusText} — ${percentChanged.toFixed(2)}% pixels changed — ${regions.length} region(s) detected
    </text>
  </svg>`;

  // Composite all layers
  const overlay = await sharp(afterBuffer)
    .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .composite([
      { input: await sharp(darkOverlay, { raw: { width, height, channels: 4 } }).png().toBuffer(), blend: 'over' },
      { input: await sharp(redHighlight, { raw: { width, height, channels: 4 } }).png().toBuffer(), blend: 'over' },
      { input: await sharp(borders, { raw: { width, height, channels: 4 } }).png().toBuffer(), blend: 'over' },
    ])
    .png()
    .toBuffer();

  // Extend canvas and add legend
  const final = await sharp(overlay)
    .extend({ bottom: legendHeight, background: { r: 0, g: 0, b: 0, alpha: 255 } })
    .composite([
      { input: Buffer.from(legendSvg), top: height, left: 0 },
    ])
    .png()
    .toBuffer();

  return final;
}

export async function computeDiff(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  diffId: string
): Promise<DiffResult> {
  log('Computing visual diff...');

  const beforePng = decodePng(beforeBuffer);
  const afterPng = decodePng(afterBuffer);

  const beforeDims: Viewport = { width: beforePng.width, height: beforePng.height };
  const afterDims: Viewport = { width: afterPng.width, height: afterPng.height };
  const resized = beforeDims.width !== afterDims.width || beforeDims.height !== afterDims.height;

  const { before, after, width, height } = normalizeDimensions(beforePng, afterPng);

  // Run pixelmatch
  const diffOutput = new PNG({ width, height });
  const changedPixels = pixelmatch(
    before.data,
    after.data,
    diffOutput.data,
    width,
    height,
    { threshold: 0.1, includeAA: false, diffColor: [255, 0, 0] }
  );

  const totalPixels = width * height;
  const percentChanged = (changedPixels / totalPixels) * 100;

  log(`Diff: ${changedPixels}/${totalPixels} pixels changed (${percentChanged.toFixed(2)}%)`);

  // Save raw diff image
  const diffImagePath = join(getDiffsDir(), `${diffId}-diff.png`);
  const diffBuffer = PNG.sync.write(diffOutput);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(diffImagePath, diffBuffer);

  // Cluster changed regions
  const regions = clusterRegions(diffOutput.data, width, height);

  // Create overlay
  const overlayBuffer = await createOverlay(afterBuffer, diffOutput, regions, width, height, percentChanged);
  const overlayImagePath = join(getDiffsDir(), `${diffId}-overlay.png`);
  await writeFile(overlayImagePath, overlayBuffer);

  return {
    totalPixels,
    changedPixels,
    percentChanged,
    dimensions: { before: beforeDims, after: afterDims, resized },
    regions,
    diffImagePath,
    overlayImagePath,
  };
}
