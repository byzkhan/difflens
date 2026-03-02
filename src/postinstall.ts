#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// Install Chromium
try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
} catch {
  console.error('\n  Failed to install Chromium. Run manually: npx playwright install chromium\n');
  process.exit(1);
}

// Welcome message
const message = `
  ${dim('┌─────────────────────────────────────────────┐')}
  ${dim('│')}                                             ${dim('│')}
  ${dim('│')}   ${cyan('◆')} ${bold('DiffLens')} ${dim(`v${pkg.version}`)}                        ${dim('│')}
  ${dim('│')}   ${dim('Visual diff MCP server for AI agents')}      ${dim('│')}
  ${dim('│')}                                             ${dim('│')}
  ${dim('└─────────────────────────────────────────────┘')}

  ${bold('Get started:')}

    ${green('1.')} cd into your project directory
    ${green('2.')} Run ${cyan('difflens setup')}
    ${green('3.')} Restart Claude Code
    ${green('4.')} Make any UI change — Claude snapshots and verifies automatically

  ${bold('What happens:')}

    You say ${dim('"move the button to the right"')} and Claude will:
    ${dim('→')} snapshot the page ${dim('→')} make the edit ${dim('→')} check the diff ${dim('→')} fix regressions

  ${bold('Or add to .mcp.json manually:')}

    ${dim('{')} "mcpServers": ${dim('{')} "difflens": ${dim('{')}
        "command": "npx", "args": ["-y", "difflens-cli"]
    ${dim('} } }')}

  ${bold('Tools available to Claude:')}

    ${yellow('snapshot')}           Screenshot a page as a baseline
    ${yellow('check')}              Diff current page against baseline
    ${yellow('check_responsive')}   Diff at multiple viewport widths
    ${yellow('snapshot_element')}   Screenshot a specific DOM element
    ${yellow('list_snapshots')}     List stored snapshots
    ${yellow('cleanup')}            Delete old snapshots

  ${dim('GitHub: https://github.com/byzkhan/difflens')}
`;

process.stderr.write(message + '\n');
