/** Shared account actions must work without opening the retired Plans screen. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(resolve(publicDir, file), 'utf8');

describe('shared account UI in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let errors: string[];
  let calls: { path: string; method: string }[];
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  });
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => browser?.close());

  async function open() {
    errors = [];
    calls = [];
    page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://accounts.test/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
        return;
      }
      calls.push({ path, method: request.method() });
      const login = {
        id: 'test-login',
        accountId: 'test-account',
        provider: 'openai',
        state: 'starting',
        message: 'Starting',
      };
      const data =
        path === '/api/plans'
          ? { accounts: [{ label: 'Test account', sessions: [{ id: 'test-session' }] }] }
          : path === '/api/plans/login-all'
            ? { logins: [login], errors: [] }
            : path.startsWith('/api/plans/logins/')
              ? { ...login, state: 'signed_in', message: 'Signed in' }
              : login;
      await route.fulfill({ json: { ok: true, data } });
    });
    await page.goto('http://accounts.test/', { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: read('styles.css') });
    await page.addScriptTag({
      content: `
      class ReverieApp {
        async _chatApi(path, opts = {}) {
          return (await fetch(path, { method: opts.method || 'GET' })).json();
        }
        refreshSubscriptionUsage() { this.refreshed = (this.refreshed || 0) + 1; }
        _scheduleSessionSwitcher() { this.labelsChanged = true; }
      }
      window.app = new ReverieApp();
    `,
    });
    await page.addScriptTag({ content: read('account-ui.js') });
  }

  it('opens and cancels a single account sign-in without a Plans screen', async () => {
    await open();
    await page.evaluate(() => (window as any).app.signInAccount('test-account', 'Test account'));
    const dialog = page.getByRole('dialog');
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.textContent()).toContain('Sign in: Test account');
    const cancelled = page.waitForResponse((response) => response.request().method() === 'DELETE');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => (window as any).app._signIn === null);
    await cancelled;
    expect(calls).toContainEqual({ path: '/api/plans/logins/test-login', method: 'DELETE' });
    expect(await page.locator('.plans-screen').count()).toBe(0);
  });

  it('starts batch sign-in from a fresh app and refreshes usage after completion', async () => {
    await open();
    await page.evaluate(() => (window as any).app.signInAll());
    await page.waitForFunction(() => (window as any).app.refreshed === 1);
    const dialog = page.getByRole('dialog');
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.textContent()).toContain('Signed in');
    expect(await page.locator('.signin-panel').count()).toBe(1);
    expect(await page.evaluate(() => (window as any).app._plansEls)).toBeUndefined();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(0);
  });

  it('resolves session account labels and reuses the cached response', async () => {
    await open();
    expect(await page.evaluate(() => (window as any).app._sessionAccountLabel('test-session'))).toBe('');
    await page.waitForFunction(() => (window as any).app.labelsChanged === true);
    expect(await page.evaluate(() => (window as any).app._sessionAccountLabel('test-session'))).toBe('Test account');
    expect(calls.filter((call) => call.path === '/api/plans')).toHaveLength(1);
  });
});
