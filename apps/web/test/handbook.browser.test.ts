import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { HANDBOOK_PAGES, registerHandbookRoutes } from '../src/web/routes/handbook-routes.js';

// Render only the packaged handbook. No live office, accounts or provider processes.
const app = Fastify();
registerHandbookRoutes(app);
let browser: Browser;
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
  await app.close();
});

for (const width of [1920, 1440, 1024, 900, 768, 610, 390, 320]) {
  it(`aligns navigation, search and every article without page overflow at ${width}px`, async () => {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      colorScheme: width === 320 ? 'light' : 'dark',
    });
    try {
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        expect(url.origin).toBe('http://handbook.test');
        const response = await app.inject(url.pathname + url.search);
        await route.fulfill({
          status: response.statusCode,
          headers: response.headers as Record<string, string>,
          body: response.body,
        });
      });
      for (const path of ['/handbook', ...HANDBOOK_PAGES.map((p) => `/handbook/${p.slug}`)]) {
        await page.goto('http://handbook.test' + path);
        const layout = await page.evaluate(() => {
          const bounds = (selector: string) => {
            const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
            return { x, y, width, height };
          };
          return {
            nav: bounds(innerWidth > 900 ? '.desktop-guides' : '.guide-picker'),
            search: bounds('form'),
            article: bounds('article'),
            brand: bounds('header strong'),
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        expect(layout.scrollWidth, path).toBeLessThanOrEqual(width);
        expect(layout.search.x, path).toBe(layout.article.x);
        expect(layout.article.width, path).toBeLessThanOrEqual(780);
        expect(await page.locator('article h1').count()).toBe(1);
        if (width > 900) {
          expect(layout.brand.x).toBe(24);
          expect(layout.nav.x).toBe(24);
          expect(layout.search.y).toBe(layout.nav.y);
          expect(layout.article.x).toBe(280);
          expect(layout.article.width).toBeGreaterThan(400);
        } else {
          expect(layout.nav.x).toBe(16);
          expect(layout.article.x).toBe(16);
          expect(layout.nav.height).toBeLessThan(100);
          expect(layout.search.y).toBeGreaterThan(layout.nav.y + layout.nav.height);
          // A native disclosure replaces the horizontal scrolling strip.
          await page.locator('.guide-picker summary').click();
          const navigation = page.getByRole('navigation', { name: 'Choose a guide', exact: true });
          await navigation.getByRole('link').last().focus();
          const link = await navigation.getByRole('link').last().boundingBox();
          expect(link!.x).toBeGreaterThanOrEqual(0);
          expect(link!.x + link!.width).toBeLessThanOrEqual(width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          await page.locator('.guide-picker summary').click();
        }
      }
      await page.goto('http://handbook.test/handbook');
      await page.getByRole('textbox', { name: 'Search handbook' }).fill('Pyright');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.waitForURL('**/handbook?q=Pyright');
      expect(await page.locator('.card').count()).toBe(1);
      await page.locator('.card a').click();
      await page.waitForURL('**/handbook/plugins');
      expect(await page.locator('.desktop-guides [aria-current="page"]').textContent()).toBe('Optional chat plugins');
      if (width <= 900)
        expect(await page.locator('.guide-picker summary').textContent()).toContain('Optional chat plugins');
      if (process.env.HANDBOOK_SCREENSHOT_DIR && [1440, 610, 390].includes(width)) {
        await mkdir(process.env.HANDBOOK_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.HANDBOOK_SCREENSHOT_DIR, `handbook-${width}.png`),
          fullPage: true,
        });
        if (width === 610) {
          await page.locator('.guide-picker summary').click();
          await page.screenshot({ path: join(process.env.HANDBOOK_SCREENSHOT_DIR, 'handbook-610-selector.png') });
        }
      }
    } finally {
      await page.close();
    }
  });
}
