# Handbook layout evidence

These screenshots show the packaged plugins guide rendered by Chromium with
synthetic source only. The desktop view keeps navigation at the left gutter and
aligns search with the readable article column. The phone view uses a horizontal
navigation row with a scrolling cue.

- [Desktop, 1440 px](handbook-1440.png)
- [Phone, 390 px](handbook-390.png)

[Browser checks](../../apps/web/test/handbook.browser.test.ts) render the real
Handbook route output through an isolated Fastify instance. They cover the index
and every guide at 320, 390, 700, 768, 1024, 1440 and 1920 px: alignment, article
width, document overflow, keyboard access to offscreen navigation, search and
active-page links. No office instance, provider or credentials are used.

From the repository root, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed
Chromium binary if Playwright's browser is unavailable, then run:

```bash
nix develop --command bash -c 'cd apps/web && npm run test:browser -- test/handbook.browser.test.ts'
```

Set `HANDBOOK_SCREENSHOT_DIR` to this directory to refresh both images. Keep
browser temporary files under the project's owned scratch directory.
