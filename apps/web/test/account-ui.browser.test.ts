/** Shared account actions must work without opening the retired Plans screen. */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(resolve(publicDir, file), 'utf8');
type Call = { path: string; method: string };
type Responder = (route: Route, call: Call) => Promise<boolean>;
type AccountWindow = Window & {
  app: {
    signInAccount(accountId: string, title: string): Promise<void>;
    signInAll(): Promise<void>;
    _sessionAccountLabel(id: string): string;
    _signIn: { view: { id: string }; polling?: boolean } | null;
    _plansEls?: unknown;
    refreshed?: number;
    labelsChanged?: boolean;
  };
  previousSignIn?: { polling?: boolean } | null;
};
const login = (id: string, state = 'starting') => ({
  id,
  accountId: 'test-account',
  provider: 'openai',
  state,
  message: state === 'signed_in' ? 'Signed in' : `Waiting for ${id}`,
});
const startPath = '/api/plans/accounts/test-account/login';

describe('shared account UI in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let errors: string[];
  let calls: Call[];
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
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

  async function open(respond?: Responder, width = 1280) {
    errors = [];
    calls = [];
    page = await browser.newPage({ viewport: { width, height: 640 } });
    await page.clock.install();
    page.on('pageerror', (error) => errors.push(error.message));
    // Every request is intercepted; this consumer fixture never contacts a vendor.
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (url.origin !== 'http://accounts.test') {
        errors.push(`Unexpected external request: ${url.origin}`);
        await route.abort();
        return;
      }
      if (path === '/' && request.method() === 'GET') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
        return;
      }
      if (!path.startsWith('/api/')) {
        await route.abort();
        return;
      }
      const call = { path, method: request.method() };
      calls.push(call);
      if (respond) {
        if (await respond(route, call)) return;
      } else {
        const data =
          path === '/api/plans' && call.method === 'GET'
            ? { accounts: [{ label: 'Test account', sessions: [{ id: 'test-session' }] }] }
            : path === '/api/plans/login-all' && call.method === 'POST'
              ? { logins: [login('test-login')], errors: [] }
              : path === '/api/plans/logins/test-login' && ['GET', 'DELETE'].includes(call.method)
                ? login('test-login', 'signed_in')
                : path === startPath && call.method === 'POST'
                  ? login('test-login')
                  : undefined;
        if (data) {
          await route.fulfill({ json: { ok: true, data } });
          return;
        }
      }
      errors.push(`Unexpected API request: ${call.method} ${path}`);
      await route.fulfill({ status: 500, json: { ok: false, error: 'Unexpected fixture request' } });
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

  async function visibleDialog(name: string) {
    const bounds = await page.getByRole('dialog').boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    const directory = process.env.TEST_ACCOUNT_SCREENSHOT_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: join(directory, `${name}.png`) });
    }
  }

  it('opens and cancels a single account sign-in without a Plans screen', async () => {
    await open();
    await page.evaluate(() => (window as unknown as AccountWindow).app.signInAccount('test-account', 'Test account'));
    const dialog = page.getByRole('dialog');
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.textContent()).toContain('Sign in: Test account');
    const cancelled = page.waitForResponse((response) => response.request().method() === 'DELETE');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as AccountWindow).app._signIn === null);
    await cancelled;
    expect(calls).toContainEqual({ path: '/api/plans/logins/test-login', method: 'DELETE' });
    expect(await page.locator('.plans-screen').count()).toBe(0);
  });

  it('starts batch sign-in from a fresh app and refreshes usage after completion', async () => {
    await open();
    await page.evaluate(() => (window as unknown as AccountWindow).app.signInAll());
    await page.waitForFunction(() => (window as unknown as AccountWindow).app.refreshed === 1);
    const dialog = page.getByRole('dialog');
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.textContent()).toContain('Signed in');
    expect(await page.locator('.signin-panel').count()).toBe(1);
    expect(await page.evaluate(() => (window as unknown as AccountWindow).app._plansEls)).toBeUndefined();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(0);
  });

  it('resolves session account labels and reuses the cached response', async () => {
    await open();
    expect(
      await page.evaluate(() => (window as unknown as AccountWindow).app._sessionAccountLabel('test-session'))
    ).toBe('');
    await page.waitForFunction(() => (window as unknown as AccountWindow).app.labelsChanged === true);
    expect(
      await page.evaluate(() => (window as unknown as AccountWindow).app._sessionAccountLabel('test-session'))
    ).toBe('Test account');
    expect(calls.filter((call) => call.path === '/api/plans')).toHaveLength(1);
  });

  // These are UI consumers of a closed synthetic API, not provider/auth-service proofs.
  for (const width of [320, 1280]) {
    it(`retries a refused account sign-in only on an explicit click at ${width}px`, async () => {
      let starts = 0;
      await open(async (route, call) => {
        if (call.path !== startPath || call.method !== 'POST') return false;
        starts++;
        await route.fulfill({
          status: starts === 1 ? 503 : 403,
          json: { ok: false, error: starts === 1 ? 'Synthetic service unavailable' : 'Synthetic sign-in forbidden' },
        });
        return true;
      }, width);
      await page.evaluate(() => (window as unknown as AccountWindow).app.signInAccount('test-account', 'Test account'));
      const dialog = page.getByRole('dialog');
      await expect.poll(() => dialog.getByRole('status').textContent()).toContain('Synthetic service unavailable');
      await page.clock.runFor(6000);
      expect(starts).toBe(1);
      const retry = dialog.getByRole('button', { name: 'Try again', exact: true });
      expect(await retry.isVisible()).toBe(true);
      await visibleDialog(`refused-${width}`);
      await retry.click();
      await expect.poll(() => page.getByRole('status').textContent()).toContain('Synthetic sign-in forbidden');
      expect(starts).toBe(2);
      expect(await page.getByRole('dialog').count()).toBe(1);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(calls).toEqual([
        { path: startPath, method: 'POST' },
        { path: startPath, method: 'POST' },
      ]);
    });

    it(`stops a failed account poll and exposes one explicit retry at ${width}px`, async () => {
      let starts = 0;
      let polls = 0;
      await open(async (route, call) => {
        if (call.path === startPath && call.method === 'POST') {
          starts++;
          await route.fulfill({ json: { ok: true, data: login(`attempt-${starts}`) } });
        } else if (call.path === '/api/plans/logins/attempt-1' && call.method === 'GET') {
          polls++;
          await route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic poll unavailable' } });
        } else if (call.path === '/api/plans/logins/attempt-2' && call.method === 'DELETE') {
          await route.fulfill({ json: { ok: true, data: login('attempt-2', 'cancelled') } });
        } else return false;
        return true;
      }, width);
      await page.evaluate(() => (window as unknown as AccountWindow).app.signInAccount('test-account', 'Test account'));
      await page.clock.runFor(1500);
      await expect.poll(() => page.getByRole('status').textContent()).toBe('The sign-in helper stopped. Try again.');
      await page.clock.runFor(6000);
      expect({ starts, polls }).toEqual({ starts: 1, polls: 1 });
      await visibleDialog(`failed-poll-${width}`);
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect.poll(() => page.getByRole('status').textContent()).toBe('Waiting for attempt-2');
      expect(starts).toBe(2);
      await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
      await expect
        .poll(() => calls.filter((call) => call.method === 'DELETE'))
        .toEqual([{ path: '/api/plans/logins/attempt-2', method: 'DELETE' }]);
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as AccountWindow).app.refreshed || 0)).toBe(0);
    });

    it(`starts another account attempt only through Wrong account at ${width}px`, async () => {
      let starts = 0;
      await open(async (route, call) => {
        if (call.path === startPath && call.method === 'POST') {
          starts++;
          await route.fulfill({ json: { ok: true, data: login(`choice-${starts}`) } });
        } else if (call.path === '/api/plans/logins/choice-1' && call.method === 'GET') {
          await route.fulfill({ json: { ok: true, data: login('choice-1', 'signed_in') } });
        } else if (call.path === '/api/plans/logins/choice-2' && call.method === 'DELETE') {
          await route.fulfill({ json: { ok: true, data: login('choice-2', 'cancelled') } });
        } else return false;
        return true;
      }, width);
      await page.evaluate(() => (window as unknown as AccountWindow).app.signInAccount('test-account', 'Test account'));
      await page.clock.runFor(1500);
      await expect.poll(() => page.getByRole('status').textContent()).toBe('Signed in');
      expect(await page.evaluate(() => (window as unknown as AccountWindow).app.refreshed)).toBe(1);
      await page.clock.runFor(6000);
      expect(starts).toBe(1);
      await visibleDialog(`wrong-account-${width}`);
      await page.getByRole('button', { name: 'Wrong account? Sign in again', exact: true }).click();
      await expect.poll(() => page.getByRole('status').textContent()).toBe('Waiting for choice-2');
      expect(starts).toBe(2);
      expect(await page.getByRole('dialog').count()).toBe(1);
      await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
      await expect
        .poll(() => calls.filter((call) => call.method === 'DELETE'))
        .toEqual([{ path: '/api/plans/logins/choice-2', method: 'DELETE' }]);
      expect(await page.getByRole('dialog').count()).toBe(0);
    });

    it(`ignores a delayed account poll after cancellation and replacement at ${width}px`, async () => {
      let starts = 0;
      let entered = false;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await open(async (route, call) => {
          if (call.path === startPath && call.method === 'POST') {
            starts++;
            await route.fulfill({ json: { ok: true, data: login(`delayed-${starts}`) } });
          } else if (call.path === '/api/plans/logins/delayed-1' && call.method === 'GET') {
            entered = true;
            await gate;
            await route.fulfill({ json: { ok: true, data: login('delayed-1', 'signed_in') } });
          } else if (/^\/api\/plans\/logins\/delayed-[12]$/.test(call.path) && call.method === 'DELETE') {
            await route.fulfill({ json: { ok: true, data: login(call.path.split('/').at(-1)!, 'cancelled') } });
          } else return false;
          return true;
        }, width);
        await page.evaluate(() => {
          const w = window as unknown as AccountWindow;
          return w.app.signInAccount('test-account', 'Test account').then(() => {
            w.previousSignIn = w.app._signIn;
          });
        });
        await page.clock.runFor(1500);
        await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
        await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
        await expect
          .poll(() => calls.filter((call) => call.method === 'DELETE'))
          .toEqual([{ path: '/api/plans/logins/delayed-1', method: 'DELETE' }]);
        await page.evaluate(() =>
          (window as unknown as AccountWindow).app.signInAccount('test-account', 'Test account')
        );
        await expect.poll(() => page.getByRole('status').textContent()).toBe('Waiting for delayed-2');
        release();
        await expect
          .poll(() => page.evaluate(() => (window as unknown as AccountWindow).previousSignIn?.polling))
          .toBe(false);
        expect(await page.getByRole('status').textContent()).toBe('Waiting for delayed-2');
        expect(await page.evaluate(() => (window as unknown as AccountWindow).app._signIn?.view.id)).toBe('delayed-2');
        expect(await page.evaluate(() => (window as unknown as AccountWindow).app.refreshed || 0)).toBe(0);
        expect(starts).toBe(2);
        await visibleDialog(`replacement-${width}`);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect
          .poll(() => calls.filter((call) => call.method === 'DELETE'))
          .toEqual([
            { path: '/api/plans/logins/delayed-1', method: 'DELETE' },
            { path: '/api/plans/logins/delayed-2', method: 'DELETE' },
          ]);
        expect(await page.getByRole('dialog').count()).toBe(0);
      } finally {
        release();
      }
    });
  }
});
