/** Shipped terminal markup, queue and recovery UI with closed synthetic HTTP; no provider runs. */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(join(root, name), 'utf8');
const index = read('index.html');
const start = index.indexOf('      <div class="terminal-wrap">');
const end = index.indexOf('      <!-- Tile grid', start);
if (start < 0 || end <= start) throw new Error('Actual terminal markup was not found');
const origin = 'https://input-recovery.test';
const artifacts = process.env.TEST_INPUT_RECOVERY_SCREENSHOT_DIR;

async function fixture(page: Page, startup = false, held = true) {
  const requests: Array<{ method: string; path: string }> = [];
  let status: unknown = {
    success: true,
    data: { id: 'held-session', name: 'Synthetic employee', terminalInputHeld: true },
  };
  let statusCode = 200;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' +
          '<main class="main" style="height:100vh">' +
          index.slice(start, end) +
          '</main></body></html>',
      });
    if (request.method() === 'GET' && url.pathname === '/fonts/manrope-variable.woff2')
      return route.fulfill({
        contentType: 'font/woff2',
        body: readFileSync(join(root, 'fonts/manrope-variable.woff2')),
      });
    // app.js sends its ordinary page breadcrumb beacon on reload. Accept only
    // this diagnostic in the synthetic origin; it cannot reach any office.
    if (request.method() === 'POST' && url.pathname === '/api/crash-diag')
      return route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    if (request.method() === 'GET' && url.pathname === '/api/input-identity')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { version: 1, kind: 'anonymous', scopeId: 'synthetic-recovery-browser', epoch: 1 },
        }),
      });
    requests.push({ method: request.method(), path: url.pathname });
    if (request.method() === 'GET' && url.pathname === '/api/sessions/held-session')
      return route.fulfill({ status: statusCode, contentType: 'application/json', body: JSON.stringify(status) });
    return route.abort();
  });
  await page.goto(origin);
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: read('constants.js') });
  await page.addScriptTag({ content: read('mobile-handlers.js') });
  await page.addScriptTag({ content: read('app.js') + '\nwindow.__InputRecoveryApp = ReverieApp;' });
  await page.addScriptTag({ content: read('browser-input-journal.js') });
  await page.addScriptTag({ content: read('input-delivery.js') });
  await page.addScriptTag({ content: read('input-cjk.js') + '\nwindow.__InputRecoveryCjk = CjkInput;' });
  await page.addScriptTag({ content: read('terminal-ui.js') });
  await page.evaluate(
    async ({ isStartup, isHeld }) => {
      const scope = window as unknown as { app: Record<string, unknown> };
      // Exercise actual prototype methods; skip the unrelated application startup.
      const app = (scope.app = Object.create(
        (window as unknown as { __InputRecoveryApp: { prototype: object } }).__InputRecoveryApp.prototype
      ));
      Object.assign(app, {
        activeSessionId: 'held-session',
        sessions: new Map([
          [
            'held-session',
            {
              id: 'held-session',
              name: 'Synthetic employee',
              ...(isHeld ? (isStartup ? { providerDispatchHeld: true } : { terminalInputHeld: true }) : {}),
            },
          ],
        ]),
        _pendingDeliveries: new Map(),
        _seqCounters: new Map(),
        _postDraining: new Set(),
        _closingSessions: new Set(),
        _clientId: 'synthetic-client',
        _reliableMaxBytes: 1024 * 1024,
        _reliableAckTimeoutMs: 1,
        renderSessionTabs: () => {},
        updateCost: () => {},
        updateSubagentParentNames: () => {},
        _updateConnectionIndicator: () => {},
        showToast: () => {},
        markIdleAlertSeen: () => {},
      });
      if (!(await (app._loadReliableState as () => Promise<boolean>)()))
        throw new Error('The actual input journal did not open');
      const terminal = document.getElementById('terminalContainer')!;
      terminal.innerHTML = '<pre style="margin-top:200px">Synthetic terminal output remains available</pre>';
      (document.getElementById('cjkInput') as HTMLTextAreaElement).value = 'Preserve this unsent draft';
      (app._renderInputRecoveryBanner as () => void)();
    },
    { isStartup: startup, isHeld: held }
  );
  return {
    requests,
    errors,
    reply: (body: unknown, code = 200) => {
      status = body;
      statusCode = code;
    },
  };
}

it.each([false, true])('shows a persistent read-only diagnostic with narrow layouts, startup=%s', async (startup) => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const f = await fixture(page, startup);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const banner = page.locator('#inputRecoveryBar');
      expect(await banner.isVisible()).toBe(true);
      expect(await banner.textContent()).toContain('terminal is read-only');
      expect(await banner.textContent()).toContain(startup ? 'startup is unconfirmed' : 'unknown outcome');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const bounds = await banner.boundingBox();
      expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1).toBe(true);
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `${startup ? 'startup' : 'input'}-held-${width}.png`) });
      }
    }
    expect(await page.locator('#cjkInput').inputValue()).toBe('Preserve this unsent draft');
    expect(f.requests).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

it('keeps recovery status and focused controls through updates and refused refreshes', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const f = await fixture(page);
    f.reply({ success: false, error: 'Synthetic disconnected observation' }, 503);
    const refresh = page.getByRole('button', { name: 'Refresh input status' });
    await refresh.click();
    await expect.poll(() => page.locator('.input-recovery-status').textContent()).toContain('Could not refresh');
    await page.evaluate(() => {
      const app = (window as unknown as { app: { _onSessionUpdated: (data: unknown) => void } }).app;
      app._onSessionUpdated({ session: { id: 'held-session', terminalInputHeld: true } });
    });
    expect(await refresh.evaluate((button) => button === document.activeElement)).toBe(true);
    expect(await page.locator('.input-recovery-status').textContent()).toContain('Could not refresh');
    f.reply({ success: true, data: { id: 'another-session', terminalInputHeld: false } });
    await refresh.click();
    await expect.poll(() => page.locator('.input-recovery-status').textContent()).toContain('Could not refresh');
    expect(await page.locator('#inputRecoveryBar').isVisible()).toBe(true);
    expect(await page.locator('#cjkInput').inputValue()).toBe('Preserve this unsent draft');
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

it('updates the displayed recovery reason without replacing its focused control or losing the draft', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
    const f = await fixture(page);
    f.reply({ success: false, error: 'Synthetic disconnected observation' }, 503);
    const refresh = page.getByRole('button', { name: 'Refresh input status' });
    await refresh.click();
    await expect.poll(() => page.locator('.input-recovery-status').textContent()).toContain('Could not refresh');
    await page.evaluate(() => {
      const app = (window as unknown as { app: { _onSessionUpdated: (data: unknown) => void } }).app;
      app._onSessionUpdated({ session: { id: 'held-session', providerDispatchHeld: true } });
    });
    await expect.poll(() => page.locator('#inputRecoveryBar').textContent()).toContain('startup is unconfirmed');
    expect(await refresh.evaluate((button) => button === document.activeElement)).toBe(true);
    expect(await page.locator('.input-recovery-status').textContent()).toContain('Could not refresh');
    await page.evaluate(() => {
      const app = (window as unknown as { app: { _onSessionUpdated(data: unknown): void } }).app;
      app._onSessionUpdated({ session: { id: 'held-session', name: 'Partial status update' } });
    });
    expect(await page.locator('#inputRecoveryBar').textContent()).toContain('startup is unconfirmed');
    expect(await refresh.evaluate((button) => button === document.activeElement)).toBe(true);
    await page.evaluate(() => {
      const app = (
        window as unknown as { app: { _inputReloadRequired: Set<string>; _renderInputRecoveryBanner(): void } }
      ).app;
      app._inputReloadRequired = new Set(['held-session']);
      app._renderInputRecoveryBanner();
    });
    expect(await page.locator('#inputRecoveryBar').textContent()).toContain('Reload this browser');
    expect(await refresh.evaluate((button) => button === document.activeElement)).toBe(true);
    expect(await page.locator('.input-recovery-status').textContent()).toContain('Could not refresh');
    expect(await page.locator('#cjkInput').inputValue()).toBe('Preserve this unsent draft');
    expect(f.requests).toEqual([{ method: 'GET', path: '/api/sessions/held-session' }]);
    expect(f.errors).toEqual([]);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, 'changed-recovery-reason-320.png') });
    }
  } finally {
    await browser.close();
  }
});

it('retains a startup diagnostic learned from status without overwriting newer session metadata', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const f = await fixture(page);
    await page.evaluate(() => {
      const app = (window as unknown as { app: { _onSessionUpdated(data: unknown): void } }).app;
      app._onSessionUpdated({ session: { id: 'held-session', name: 'Newer SSE metadata' } });
    });
    const refresh = page.getByRole('button', { name: 'Refresh input status' });
    for (const providerDispatchHeld of [true, false]) {
      f.reply({ success: true, data: { id: 'held-session', name: 'Old status response', providerDispatchHeld } });
      await refresh.click();
      await expect
        .poll(() => page.locator('.input-recovery-status').textContent())
        .toContain('Input still needs recovery');
      expect(await page.locator('#inputRecoveryBar').textContent()).toContain('startup is unconfirmed');
      expect(await refresh.evaluate((button) => button === document.activeElement)).toBe(true);
    }
    const state = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: { sessions: Map<string, unknown>; _sendInputAsync(sid: string, text: string): Promise<boolean> };
        }
      ).app;
      return {
        session: app.sessions.get('held-session'),
        accepted: await app._sendInputAsync('held-session', 'must not be issued'),
      };
    });
    expect(state).toEqual({ session: { id: 'held-session', name: 'Newer SSE metadata' }, accepted: false });
    expect(await page.locator('#cjkInput').inputValue()).toBe('Preserve this unsent draft');
    expect(f.requests).toEqual(
      Array.from({ length: 2 }, () => ({ method: 'GET', path: '/api/sessions/held-session' }))
    );
    expect(f.errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

it('restores the journal hold and retained input records across a reload without replay', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const f = await fixture(page, false, false);
    await page.evaluate(async () => {
      const app = (window as unknown as { app: Record<string, unknown> }).app;
      const journal = app._inputJournal as {
        accept(sid: string, frames: string[]): Promise<{ kind: string; records: Record<string, unknown>[] }>;
        claim(record: Record<string, unknown>): Promise<Record<string, unknown> | null>;
        settle(record: Record<string, unknown>, phase: string): Promise<unknown>;
      };
      // Arrange uncertainty through the actual durable owner. No transport or
      // provider is dispatched by this UI fixture.
      const accepted = await journal.accept('held-session', ['uncertain original', 'queued unsent draft']);
      if (accepted.kind !== 'accepted') throw new Error('Actual journal refused the synthetic input');
      const original = await journal.claim(accepted.records[0]);
      if (!original) throw new Error('Actual journal did not retain the original claim');
      await journal.settle(original, 'unconfirmed');
    });
    const reloaded = await fixture(page, false, false);
    const pending = await page.evaluate(async () => {
      const app = (window as unknown as { app: Record<string, unknown> }).app;
      (app._renderInputRecoveryBanner as () => void)();
      if (
        await (app._sendInputAsync as (sid: string, text: string) => Promise<boolean>)(
          'held-session',
          'must not be issued'
        )
      )
        throw new Error('Input was accepted during recovery');
      await (app._drainSession as (sid: string) => Promise<void>)('held-session');
      (app._redeliverSweep as () => void)();
      return (
        app._inputJournal as {
          snapshot(): Promise<{ holds: { sid: string }[]; records: { data: string }[]; retained: { data: string }[] }>;
        }
      ).snapshot();
    });
    expect(await page.locator('#inputRecoveryBar').isVisible()).toBe(true);
    expect(pending.holds.some((hold) => hold.sid === 'held-session')).toBe(true);
    expect([...pending.records, ...pending.retained].map((record) => record.data)).toEqual([
      'uncertain original',
      'queued unsent draft',
    ]);
    expect(f.requests).toEqual([]);
    expect(f.errors).toEqual([]);
    expect(reloaded.requests).toEqual([]);
    expect(reloaded.errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

it.each([false, true])(
  'cannot clear observed denial or overwrite newer metadata with a status read, startup=%s',
  async (startup) => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage();
      const f = await fixture(page, startup);
      f.reply({
        success: true,
        data: {
          id: 'held-session',
          name: 'Old status snapshot',
          terminalInputHeld: false,
          providerDispatchHeld: false,
        },
      });
      const refresh = page.getByRole('button', { name: 'Refresh input status' });
      await page.evaluate(() => {
        const app = (window as unknown as { app: { _onSessionUpdated: (data: unknown) => void } }).app;
        app._onSessionUpdated({ session: { id: 'held-session', name: 'Newer SSE metadata' } });
      });
      await refresh.click();
      await expect
        .poll(() => page.locator('.input-recovery-status').textContent())
        .toContain('Input still needs recovery');
      expect(await refresh.evaluate((button) => button === document.activeElement)).toBe(true);
      expect(await page.locator('#inputRecoveryBar').isVisible()).toBe(true);
      const state = await page.evaluate(() => {
        const app = (window as unknown as { app: Record<string, unknown> }).app;
        (app._sendInputAsync as (sid: string, input: string) => void)('held-session', 'must not be issued');
        return {
          session: (app.sessions as Map<string, unknown>).get('held-session'),
          held: (app._sessionInputHeld as (sid: string) => boolean)('held-session'),
          pending: (app._pendingDeliveries as Map<string, unknown>).size,
        };
      });
      expect(state).toEqual({ session: { id: 'held-session', name: 'Newer SSE metadata' }, held: true, pending: 0 });
      expect(f.requests).toEqual([{ method: 'GET', path: '/api/sessions/held-session' }]);
      expect(f.errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }
);

it('retains a pending IME draft when the server holds input before its actual delayed flush', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    await page.clock.install();
    const f = await fixture(page);
    await page.evaluate(() => {
      const app = (window as unknown as { app: Record<string, unknown> }).app;
      const cjk = (window as unknown as { __InputRecoveryCjk: { init: (options: unknown) => void } })
        .__InputRecoveryCjk;
      // Fresh synthetic precondition: the draft starts before any observed hold.
      app._inputRecoveryHolds = new Set();
      (app.sessions as Map<string, unknown>).set('held-session', { id: 'held-session' });
      cjk.init({ send: (text: string) => (app._handleCjkInput as (text: string) => boolean)(text) });
      const textarea = document.getElementById('cjkInput') as HTMLTextAreaElement;
      textarea.value = '\u200b保留 pending IME draft';
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'draft' }));
      (app._holdInputRecovery as (id: string) => void)('held-session');
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { app: { _pendingDeliveries: Map<string, unknown> } }).app._pendingDeliveries.size
        )
      )
      .toBe(0);
    // The real debounce runs on the browser clock; inspect its completed flush.
    await page.clock.runFor(300);
    expect(await page.locator('#cjkInput').inputValue()).toBe('\u200b保留 pending IME draft');
    expect(f.requests).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
