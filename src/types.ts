export interface Viewport {
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  url: string;
  viewport?: Viewport;
  fullPage?: boolean;
  selector?: string;
  waitForSelector?: string;
  waitForTimeout?: number;
}

export interface SnapshotMetadata {
  id: string;
  url: string;
  viewport: Viewport;
  fullPage: boolean;
  selector?: string;
  timestamp: number;
  imagePath: string;
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  changedPixels: number;
  percentChanged: number;
  description: string;
}

export interface DiffResult {
  totalPixels: number;
  changedPixels: number;
  percentChanged: number;
  dimensions: {
    before: Viewport;
    after: Viewport;
    resized: boolean;
  };
  regions: DiffRegion[];
  diffImagePath: string;
  overlayImagePath: string;
}

export interface DiffReport {
  status: 'no_changes' | 'minor' | 'significant' | 'major';
  summary: string;
  percentChanged: number;
  dimensions: DiffResult['dimensions'];
  regions: DiffRegion[];
  diffImagePath: string;
  overlayImagePath: string;
}

export interface ResponsiveCheckResult {
  url: string;
  viewports: Array<{
    viewport: Viewport;
    report: DiffReport;
  }>;
  summary: string;
}

export interface ListSnapshotsOptions {
  url?: string;
  limit?: number;
}

export interface CleanupOptions {
  maxAge?: number; // milliseconds
  maxCount?: number;
  dryRun?: boolean;
}

export interface CleanupResult {
  deleted: string[];
  kept: number;
  dryRun: boolean;
}

export interface LayoutElement {
  selector: string;
  tagName: string;
  id?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

export interface LayoutChange {
  selector: string;
  type: 'moved' | 'resized' | 'style_changed' | 'added' | 'removed';
  description: string;
  before?: Partial<LayoutElement>;
  after?: Partial<LayoutElement>;
}

export type DiffLensErrorCode =
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'SELECTOR_NOT_FOUND'
  | 'SNAPSHOT_NOT_FOUND'
  | 'NO_BASELINE'
  | 'STORAGE_ERROR'
  | 'BROWSER_ERROR'
  | 'INVALID_INPUT';

export class DiffLensError extends Error {
  code: DiffLensErrorCode;

  constructor(code: DiffLensErrorCode, message: string) {
    super(message);
    this.name = 'DiffLensError';
    this.code = code;
  }
}
