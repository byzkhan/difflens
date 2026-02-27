# DiffLens

MCP server that gives AI coding agents "eyes" for UI work. It screenshots localhost pages before and after code changes, compares them visually, and returns structured diff reports with overlay images.

## Quick Start

```bash
npm install -g difflens
cd your-project
difflens setup
# Restart Claude Code — DiffLens is now active
```

Then ask Claude: *"take a snapshot of http://localhost:3000"*

### Use without installing

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "difflens": {
      "command": "npx",
      "args": ["-y", "difflens"]
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

## Example Workflow

```
You:    Take a snapshot of http://localhost:3000
Agent:  [calls snapshot] ✓ Saved baseline snapshot abc123

        ... you edit some CSS ...

You:    Check localhost:3000 for visual changes
Agent:  [calls check] SIGNIFICANT: 4.2% pixels changed.
        2 changed region(s) detected:
          1. Top-left area (400x60px) — header color change
          2. Middle-center area (600x200px) — card layout shift
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
