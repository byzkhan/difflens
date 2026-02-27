import type { DiffResult, DiffReport, ResponsiveCheckResult, Viewport } from './types.js';

export function buildReport(diff: DiffResult): DiffReport {
  const { percentChanged, dimensions, regions, diffImagePath, overlayImagePath } = diff;

  let status: DiffReport['status'];
  if (percentChanged === 0) {
    status = 'no_changes';
  } else if (percentChanged < 1) {
    status = 'minor';
  } else if (percentChanged < 10) {
    status = 'significant';
  } else {
    status = 'major';
  }

  // Build human-readable summary
  const parts: string[] = [];

  parts.push(`${status.replace('_', ' ').toUpperCase()}: ${percentChanged.toFixed(2)}% pixels changed.`);

  if (dimensions.resized) {
    parts.push(
      `Page dimensions changed from ${dimensions.before.width}x${dimensions.before.height} ` +
      `to ${dimensions.after.width}x${dimensions.after.height}.`
    );
  }

  if (regions.length > 0) {
    parts.push(`${regions.length} changed region(s) detected:`);
    const topRegions = regions.slice(0, 5);
    for (let i = 0; i < topRegions.length; i++) {
      const r = topRegions[i];
      parts.push(`  ${i + 1}. ${r.description} — ${r.changedPixels} pixels (${r.percentChanged.toFixed(1)}% of region)`);
    }
    if (regions.length > 5) {
      parts.push(`  ... and ${regions.length - 5} more region(s)`);
    }
  }

  return {
    status,
    summary: parts.join('\n'),
    percentChanged,
    dimensions,
    regions,
    diffImagePath,
    overlayImagePath,
  };
}

export function buildResponsiveReport(
  url: string,
  viewportResults: Array<{ viewport: Viewport; report: DiffReport }>
): ResponsiveCheckResult {
  const parts: string[] = [`Responsive check for ${url} across ${viewportResults.length} viewport(s):\n`];

  for (const { viewport, report } of viewportResults) {
    parts.push(`--- ${viewport.width}x${viewport.height} ---`);
    parts.push(report.summary);
    parts.push('');
  }

  // Highlight cross-viewport differences
  const statuses = viewportResults.map(v => v.report.status);
  const uniqueStatuses = new Set(statuses);
  if (uniqueStatuses.size > 1) {
    parts.push('NOTE: Different viewports show different levels of change:');
    for (const { viewport, report } of viewportResults) {
      parts.push(`  ${viewport.width}px: ${report.status} (${report.percentChanged.toFixed(2)}%)`);
    }
  }

  return {
    url,
    viewports: viewportResults,
    summary: parts.join('\n'),
  };
}
