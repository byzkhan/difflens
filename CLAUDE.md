# DiffLens — Instructions for Claude Code

## DiffLens Visual Verification (MANDATORY)

When this project has DiffLens MCP tools available, you MUST follow
this workflow for ANY change that affects visual UI (HTML, CSS, JSX,
TSX, Vue, Svelte, SCSS, Tailwind classes, component styling, layout
changes, or anything that would change how a page looks):

### Before making changes:
1. Ask the user what URL to check if you don't already know it
   (e.g. http://localhost:3000)
2. Call `snapshot` on that URL to save the current state as a baseline

### After making changes:
3. Call `check` on the same URL to compare against your snapshot
4. Read the diff report carefully
5. If there are ANY unintended changes (layout shifts, missing elements,
   color changes, overlaps, broken responsive behavior), fix them
   immediately
6. Call `check` again to verify your fixes worked
7. Only respond to the user once the diff report shows no unintended
   changes

### For responsive changes:
- Use `check_responsive` instead of `check` when the change involves
  layout, flexbox, grid, media queries, or anything that could look
  different on mobile vs desktop

### Rules:
- NEVER skip the visual check. Even if you're confident the change is
  correct, verify it.
- If the dev server is not running, tell the user to start it before
  you proceed with UI changes.
- If the diff shows problems you can't fix after 3 attempts, show the
  user the diff report and ask for guidance.
