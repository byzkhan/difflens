# DiffLens

MCP server that gives AI coding agents "eyes" for UI work. It screenshots localhost pages before and after code changes, compares them visually, and returns structured diff reports with overlay images.

## Quick Start

```bash
npm install -g difflens-cli
cd your-project
difflens setup
# Restart Claude Code — DiffLens is now active
```

DiffLens works automatically — just make UI requests as normal. Claude will snapshot before changes and verify after, without you having to ask.

### Use without installing

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "difflens": {
      "command": "npx",
      "args": ["-y", "difflens-cli"]
    }
  }
}
```

## How It Works

1. **Snapshot** a page to save a baseline screenshot
2. Make changes to your code
3. **Check** the page — DiffLens takes a new screenshot, runs a pixel-level diff against the baseline, clusters changed regions, and returns a report with an annotated overlay image

The overlay dims unchanged areas, highlights changed pixels in red, draws borders around detected regions, and includes a legend bar with the change percentage.

## Install from Source

```bash
git clone https://github.com/byzkhan/difflens.git
cd difflens
npm install
npm run build
```

## Tools

### snapshot

Take a screenshot and save it as a baseline.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to screenshot |
| `width` | number | 1280 | Viewport width |
| `height` | number | 720 | Viewport height |
| `fullPage` | boolean | true | Capture full scrollable page |
| `waitForSelector` | string | — | CSS selector to wait for before capture |
| `waitForTimeout` | number | — | Extra wait time in ms |

### check

Take a new screenshot and diff it against the latest baseline (or a specific snapshot). Returns a structured report and an overlay image.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to check |
| `baselineId` | string | latest | Specific snapshot ID to compare against |
| `width` | number | 1280 | Viewport width |
| `height` | number | 720 | Viewport height |
| `fullPage` | boolean | true | Capture full scrollable page |
| `waitForSelector` | string | — | CSS selector to wait for |
| `waitForTimeout` | number | — | Extra wait time in ms |

The report includes:
- **status**: `no_changes`, `minor` (<1%), `significant` (<10%), or `major` (>10%)
- **percentChanged**: exact pixel change percentage
- **regions**: list of changed areas with position descriptions and pixel counts
- **overlay image**: annotated composite showing exactly what changed

### check_responsive

Run visual diffs at multiple viewport widths to catch responsive design regressions.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to check |
| `widths` | number[] | [375, 768, 1024, 1440] | Viewport widths to test |
| `height` | number | 720 | Viewport height |
| `fullPage` | boolean | true | Capture full scrollable page |
| `waitForSelector` | string | — | CSS selector to wait for |
| `waitForTimeout` | number | — | Extra wait time in ms |

### snapshot_element

Screenshot a specific DOM element by CSS selector. Returns the image inline.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL containing the element |
| `selector` | string | required | CSS selector to capture |
| `width` | number | 1280 | Viewport width |
| `height` | number | 720 | Viewport height |
| `waitForSelector` | string | — | CSS selector to wait for |
| `waitForTimeout` | number | — | Extra wait time in ms |

### list_snapshots

List stored snapshots with optional filtering.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | — | Filter by URL |
| `limit` | number | 20 | Max results |

### cleanup

Delete old snapshots by age or count.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxAgeHours` | number | — | Delete snapshots older than this |
| `maxCount` | number | — | Keep at most this many (newest first) |
| `dryRun` | boolean | false | Preview without deleting |

## Automatic Workflow

DiffLens includes a `CLAUDE.md` file and Claude Code hooks that make visual verification fully automatic. You don't need to mention DiffLens — Claude does it on its own:

```
You:    Move the login button to the right side of the header
Agent:  [calls snapshot on localhost:3000 — saves baseline]
        [edits header CSS]
        [calls check — compares before/after]

        Done. Moved the login button to the right side of the header.
        Visual check confirmed: only the button position changed,
        no unintended layout shifts or regressions.
```

If Claude detects unintended changes in the diff, it fixes them automatically and re-checks until the result is clean.

### How it works under the hood

1. **CLAUDE.md** instructs Claude to always snapshot before UI edits and check after
2. **Claude Code hooks** fire on every file edit — if the file is a UI file (.html, .css, .jsx, .tsx, .vue, .svelte, .scss), they remind Claude to snapshot/check
3. Claude reads the diff report, fixes any regressions, and only responds once the visual output is verified

### Manual usage

You can also use DiffLens explicitly:

```
You:    Take a snapshot of http://localhost:3000
Agent:  [calls snapshot] Saved baseline abc123

You:    Check localhost:3000 for visual changes
Agent:  [calls check] 4.2% pixels changed — 2 regions detected
        [shows overlay image]
```

## Storage

All data is stored locally in `.difflens/`:
- `.difflens/snapshots/` — PNG screenshots + JSON metadata
- `.difflens/diffs/` — diff images and overlay composites

Add `.difflens/` to your `.gitignore`.

## Implementation Details

- **Browser reuse**: Playwright Chromium launches once and stays alive. Each screenshot creates an isolated `BrowserContext` (~200ms vs ~3s for a new browser).
- **Deterministic captures**: Anti-animation CSS is injected before page JS runs. Animations, transitions, and caret blink are disabled. Timezone is locked to UTC, locale to en-US.
- **Region clustering**: Changed pixels are grouped into a 10x10px grid, then nearby cells are merged within 50px proximity. This turns raw pixel noise into meaningful "the header changed" regions.
- **Atomic writes**: Snapshots are written to `.tmp` files then renamed, preventing corruption from concurrent access.
- **stdio-safe**: All logging goes to stderr. stdout is reserved for MCP protocol messages.

## Tech Stack

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [Playwright](https://playwright.dev/) — headless browser automation
- [pixelmatch](https://github.com/mapbox/pixelmatch) — pixel-level image comparison
- [sharp](https://sharp.pixelplumbing.com/) — image compositing for overlays
- [pngjs](https://github.com/lukeapage/pngjs) — PNG encoding/decoding
- [Zod](https://zod.dev/) — input validation for tool schemas

## License

MIT
