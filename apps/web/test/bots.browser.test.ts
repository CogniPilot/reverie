import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { CronJobSchema } from '../src/web/schemas.js';
let browser: Browser;
const publicDir = resolve(import.meta.dirname, '../src/web/public');
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
});
for (const [name, width, height] of [
  ['desktop', 1280, 900],
  ['phone', 390, 844],
] as const) {
  it(`shows truthful routine status and usable setup without horizontal overflow on ${name}`, async () => {
    const page = await browser.newPage({ viewport: { width, height } });
    const writes: unknown[] = [];
    try {
      await page.route('http://bots.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith('/api/')) {
          const file = path === '/bots' ? 'bots.html' : path.slice(1);
          return route.fulfill({
            contentType: file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.js')
                ? 'application/javascript'
                : 'text/html',
            body: readFileSync(resolve(publicDir, file)),
          });
        }
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          CronJobSchema.parse(body);
          writes.push(body);
          return route.fulfill({ json: { job: { id: 'new' } } });
        }
        const data = {
          '/api/cron/active': { jobs: [{ id: 'ci-watch', name: 'Build status' }] },
          '/api/company': { success: true, data: { employees: [{ id: 'expert', name: 'Example expert' }] } },
          '/api/chat-bots': {
            success: true,
            data: { bots: [{ id: 'ci', name: 'Build Watch', icon: '🔎', rooms: ['office'], maxPerHour: 20 }] },
          },
          '/api/chatrooms': { success: true, data: { rooms: [{ id: 'office', name: 'office' }] } },
          '/api/cron/jobs': [
            {
              id: 'ci-watch',
              name: 'Build status',
              action: 'post',
              botId: 'ci',
              roomId: 'office',
              enabled: true,
              scheduleType: 'interval',
              intervalMinutes: 15,
              nextRunAt: Date.now() + 900000,
              lastRunAt: Date.now() - 10000,
              lastStatus: 'created',
              postText: 'Build summary: {summary}',
              createdBy: { employeeId: 'expert' },
            },
            {
              id: 'remind',
              name: 'Weekly office reminder',
              action: 'post',
              postAs: 'author',
              roomId: 'office',
              enabled: false,
              scheduleType: 'weekly',
              weeklyDays: [1],
              weeklyTime: '09:00',
              timeZone: 'UTC',
            },
          ],
          '/api/cron/runs': [
            {
              id: 'run',
              cronJobId: 'ci-watch',
              status: 'created',
              startedAt: Date.now() - 10000,
              finishedAt: null,
              triggerType: 'scheduled',
            },
          ],
        };
        return route.fulfill({ json: data[path as keyof typeof data] });
      });
      await page.goto('http://bots.test/bots');
      await page.getByText('1 running now', { exact: true }).waitFor();
      expect(await page.locator('#routines article').count()).toBe(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      for (const control of await page
        .locator('.toolbar button, .toolbar input, .toolbar select, .card button')
        .all()) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      const searchBox = await page.locator('#search').boundingBox();
      const filterBox = await page.locator('#filter').boundingBox();
      expect(searchBox!.x + searchBox!.width <= filterBox!.x || searchBox!.y + searchBox!.height <= filterBox!.y).toBe(
        true
      );
      if (process.env.BOT_PREVIEW_DIR) {
        await mkdir(process.env.BOT_PREVIEW_DIR, { recursive: true });
        await page.screenshot({
          path: resolve(process.env.BOT_PREVIEW_DIR, 'bots-' + name + '.png'),
          fullPage: true,
        });
      }
      await page.getByLabel('Show', { exact: true }).selectOption('running');
      expect(await page.locator('#routines article').count()).toBe(1);
      await page.getByRole('button', { name: 'New routine', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New routine' });
      await dialog.getByLabel('Name', { exact: true }).fill('Office reminder');
      await dialog.getByLabel('Message', { exact: true }).fill('Please check the board');
      expect(await dialog.getByLabel('Enable schedule immediately').isChecked()).toBe(false);
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await dialog.getByRole('button', { name: 'Save routine' }).click();
      await page.waitForFunction(() => !document.querySelector('#routine-dialog')?.hasAttribute('open'));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ action: 'post', enabled: false });
    } finally {
      await page.close();
    }
  });
}
