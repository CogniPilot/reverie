import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
for (const [label, width, height] of [
  ['desktop', 1280, 900],
  ['small-phone', 320, 740],
] as const) {
  it(`configures repository events with ordinary accessible controls on ${label}`, async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let revision = 0;
      let configs: any[] = [];
      const writes: any[] = [];
      const data = () => ({
        version: 1,
        revision,
        watches: configs.map((config) => ({
          config,
          status: {
            state: config.visibility === 'private' && !config.credentialId ? 'auth-required' : 'not-run',
            lastSuccessAt: null,
            nextPollAt: null,
            failures: 0,
            pendingCount: 0,
            lastError: null,
            legacyAdopted: false,
          },
        })),
      });
      await page.route('https://watcher-fixture.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith('/api/')) {
          const file = path === '/bots' ? 'bots.html' : path.slice(1);
          return route.fulfill({
            contentType: file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.js')
                ? 'application/javascript'
                : 'text/html',
            body: readFileSync(resolve(import.meta.dirname, '../src/web/public', file)),
          });
        }
        if (route.request().method() !== 'GET') {
          expect(path).toBe('/api/bot-watches/github');
          expect(route.request().method()).toBe('PUT');
          const body = route.request().postDataJSON();
          expect(body.version).toBe(1);
          expect(body.expectedRevision).toBe(revision);
          expect(body.watches).toHaveLength(1);
          expect(body.watches[0]).toMatchObject({
            owner: 'Example',
            repo: 'new-project',
            botId: 'github-issues',
            roomId: 'updates',
            events: { issues: false, pullRequests: true, workflowFailures: true },
            intervalMinutes: 30,
            enabled: true,
            credentialId: null,
          });
          writes.push(body);
          configs = body.watches;
          revision++;
          return route.fulfill({ json: { success: true, data: data() } });
        }
        const payloads: Record<string, unknown> = {
          '/api/bot-watches/github': data(),
          '/api/publication/tokens': { tokens: [] },
          '/api/chat-bots': {
            bots: [{ id: 'github-issues', name: 'Repository updates', rooms: ['updates'], maxPerHour: 30 }],
          },
          '/api/chatrooms': { rooms: [{ id: 'updates', name: 'updates' }] },
          '/api/company': { canManage: true, employees: [] },
          '/api/cron/jobs': [],
          '/api/cron/runs': [],
          '/api/cron/active': { jobs: [] },
        };
        expect(path in payloads).toBe(true);
        return route.fulfill({ json: { success: true, data: payloads[path] } });
      });
      await page.goto('https://watcher-fixture.test/bots');
      await page.getByRole('button', { name: 'Watch a repository', exact: true }).click();
      await page.getByLabel('Repository', { exact: true }).fill('Example/new-project');
      await page.getByLabel('Issues', { exact: true }).uncheck();
      await page.getByLabel('Check every (minutes)', { exact: true }).fill('30');
      await page.getByLabel('Repository visibility', { exact: true }).selectOption('private');
      await page.getByRole('button', { name: 'Save watcher', exact: true }).click();
      await expect.poll(async () => page.locator('#github-watches').textContent()).toContain('Credential required');
      expect(writes).toHaveLength(1);
      expect(await page.locator('#watch-dialog').evaluate((e) => (e as HTMLDialogElement).open)).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await page.locator('#github-watches').textContent()).toContain('Failed GitHub Actions runs');
      expect(errors).toEqual([]);
      if (process.env.GITHUB_WATCH_UI_SCREENSHOTS) {
        mkdirSync(process.env.GITHUB_WATCH_UI_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: resolve(process.env.GITHUB_WATCH_UI_SCREENSHOTS, `${label}.png`),
          fullPage: true,
        });
      }
    } finally {
      await browser.close();
    }
  }, 30000);
}
