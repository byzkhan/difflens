#!/usr/bin/env node

import { execSync } from 'node:child_process';

try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
} catch {
  process.stderr.write('\n  Failed to install Chromium. Run manually: npx playwright install chromium\n');
  process.exit(1);
}
