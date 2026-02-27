import { readdir, readFile, writeFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SnapshotMetadata, ListSnapshotsOptions, CleanupOptions, CleanupResult } from './types.js';
import { DiffLensError } from './types.js';

const STORAGE_ROOT = '.difflens';
const SNAPSHOTS_DIR = join(STORAGE_ROOT, 'snapshots');
const DIFFS_DIR = join(STORAGE_ROOT, 'diffs');

// Sequential write queue for concurrent safety
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn);
  writeQueue = result.then(() => {}, () => {});
  return result;
}

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  await mkdir(DIFFS_DIR, { recursive: true });
}

export function getSnapshotsDir(): string {
  return SNAPSHOTS_DIR;
}

export function getDiffsDir(): string {
  return DIFFS_DIR;
}

export function generateSnapshotId(label?: string): string {
  const timestamp = Date.now();
  const hex = randomBytes(4).toString('hex');
  if (label) {
    return `${timestamp}-${label}`;
  }
  return `${timestamp}-${hex}`;
}

export async function saveSnapshot(
  id: string,
  imageBuffer: Buffer,
  metadata: Omit<SnapshotMetadata, 'imagePath'>
): Promise<SnapshotMetadata> {
  return enqueueWrite(async () => {
    const imagePath = join(SNAPSHOTS_DIR, `${id}.png`);
    const metadataPath = join(SNAPSHOTS_DIR, `${id}.json`);
    const tmpImagePath = `${imagePath}.tmp`;
    const tmpMetadataPath = `${metadataPath}.tmp`;

    const fullMetadata: SnapshotMetadata = { ...metadata, imagePath };

    // Atomic writes: write to .tmp then rename
    await writeFile(tmpImagePath, imageBuffer);
    await rename(tmpImagePath, imagePath);

    await writeFile(tmpMetadataPath, JSON.stringify(fullMetadata, null, 2));
    await rename(tmpMetadataPath, metadataPath);

    return fullMetadata;
  });
}

export async function loadSnapshotMetadata(id: string): Promise<SnapshotMetadata> {
  const metadataPath = join(SNAPSHOTS_DIR, `${id}.json`);
  try {
    const data = await readFile(metadataPath, 'utf-8');
    return JSON.parse(data) as SnapshotMetadata;
  } catch {
    throw new DiffLensError('SNAPSHOT_NOT_FOUND', `Snapshot "${id}" not found`);
  }
}

export async function loadSnapshotImage(id: string): Promise<Buffer> {
  const imagePath = join(SNAPSHOTS_DIR, `${id}.png`);
  try {
    return await readFile(imagePath);
  } catch {
    throw new DiffLensError('SNAPSHOT_NOT_FOUND', `Snapshot image "${id}" not found`);
  }
}

export async function findLatestSnapshot(url: string): Promise<SnapshotMetadata | null> {
  const snapshots = await listSnapshots({ url });
  if (snapshots.length === 0) return null;
  // Already sorted by timestamp descending
  return snapshots[0];
}

export async function listSnapshots(options: ListSnapshotsOptions = {}): Promise<SnapshotMetadata[]> {
  try {
    const files = await readdir(SNAPSHOTS_DIR);
    const metadataFiles = files.filter(f => f.endsWith('.json'));

    const snapshots: SnapshotMetadata[] = [];
    for (const file of metadataFiles) {
      try {
        const data = await readFile(join(SNAPSHOTS_DIR, file), 'utf-8');
        const metadata = JSON.parse(data) as SnapshotMetadata;
        if (options.url && metadata.url !== options.url) continue;
        snapshots.push(metadata);
      } catch {
        // Skip corrupted metadata files
      }
    }

    // Sort by timestamp descending (newest first)
    snapshots.sort((a, b) => b.timestamp - a.timestamp);

    if (options.limit && options.limit > 0) {
      return snapshots.slice(0, options.limit);
    }
    return snapshots;
  } catch {
    return [];
  }
}

export async function cleanupSnapshots(options: CleanupOptions = {}): Promise<CleanupResult> {
  const { maxAge, maxCount, dryRun = false } = options;
  const now = Date.now();
  const allSnapshots = await listSnapshots();
  const toDelete: string[] = [];
  const toKeep: SnapshotMetadata[] = [];

  for (const snapshot of allSnapshots) {
    let shouldDelete = false;

    if (maxAge !== undefined && (now - snapshot.timestamp) > maxAge) {
      shouldDelete = true;
    }

    if (shouldDelete) {
      toDelete.push(snapshot.id);
    } else {
      toKeep.push(snapshot);
    }
  }

  // If maxCount is specified, mark excess snapshots for deletion (oldest first)
  if (maxCount !== undefined && toKeep.length > maxCount) {
    const excess = toKeep.splice(maxCount);
    for (const snapshot of excess) {
      toDelete.push(snapshot.id);
    }
  }

  if (!dryRun) {
    for (const id of toDelete) {
      try {
        await unlink(join(SNAPSHOTS_DIR, `${id}.png`));
      } catch { /* ignore */ }
      try {
        await unlink(join(SNAPSHOTS_DIR, `${id}.json`));
      } catch { /* ignore */ }
    }
  }

  return {
    deleted: toDelete,
    kept: toKeep.length,
    dryRun,
  };
}
