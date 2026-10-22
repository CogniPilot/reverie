/** Real isolated console and Chromium: notification settings work without the removed webhook. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

describe('notification settings after webhook removal', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  const requests: string[] = [];
  beforeAll(async () => {
    server = new WebServer(0, false, true, '127.0.0.1');
    await server.start();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).app?.openAppSettings === 'function', null, {
      timeout: 30_000,
    });
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.click('[data-section="settings-notifications"]');
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60_000);
  it('shows notification settings with no webhook controls', async () => {
    expect(await page.locator('#settings-notifications').isVisible()).toBe(true);
    expect(await page.locator('#webhookGroup').count()).toBe(0);
    expect(await page.locator('[onclick*="Webhook"]').count()).toBe(0);
  });
  it('saves settings without a webhook request or keeping the modal open', async () => {
    const response = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() === 'PUT');
    await page.click('#appSettingsModal .set-foot .btn-primary');
    expect((await response).ok()).toBe(true);
    await page.waitForFunction(() => !document.getElementById('appSettingsModal')!.classList.contains('active'));
    expect(requests.some((path) => path.startsWith('/api/webhook'))).toBe(false);
  });
  it('the removed webhook API is absent', async () => {
    for (const [method, path] of [
      ['GET', '/api/webhook'],
      ['PUT', '/api/webhook'],
      ['POST', '/api/webhook/test'],
    ]) {
      const response = await page.request.fetch(`http://127.0.0.1:${server.boundPort}${path}`, { method });
      expect(response.status()).toBe(404);
    }
  });
});
