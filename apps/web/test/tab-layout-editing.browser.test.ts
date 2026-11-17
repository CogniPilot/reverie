/**
 * @fileoverview Real-Chromium coverage for editing the grouped vertical rail.
 *
 * What DOM emulation cannot answer: a pointer drag (hit testing, capture, the
 * click that ends a drag), whether the inline group editor actually paints
 * inside the rail's nowrap/ellipsis header, and whether Escape on an open group
 * menu reaches the menu first. The shipping app.js, tab-layout-browser.js,
 * tab-rail-resize.js, api-client.js, webview-tabs.js, panels-ui.js and styles.css
 * are loaded into a page. Closed synthetic GET/PUT responses exercise stale
 * destinations and lost replies through the actual editor and toast.
 *
 * Port: none (page.route on a fake origin, no server).
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

const LAYOUT = {
  version: 4,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    {
      id: 'gx',
      name: 'Core',
      refs: [
        { kind: 'session', id: 'two' },
        { kind: 'webview', id: 'web' },
      ],
    },
    { id: 'gy', name: 'Later', refs: [{ kind: 'session', id: 'three' }] },
  ],
  ungrouped: [{ kind: 'session', id: 'one' }],
};
type Layout = typeof LAYOUT;
type Write = { baseVersion: number; layout: Layout };
type Reply = (route: Route, method: string, body: Write | null) => Promise<void>;
type LayoutWindow = Window & {
  __app: { tabLayout: Layout; _tabLayoutEditor: { hasPending(): boolean } };
  __activation: string | null;
};

describe('grouped rail editing in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let puts: any[] = [];
  let requests: string[] = [];
  let errors: string[] = [];
  let reply: Reply | null = null;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.clock.install();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://reverie.test') {
        errors.push(`Unexpected external request: ${url.origin}`);
        return route.abort();
      }
      if (url.pathname === '/' && request.method() === 'GET')
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      if (!url.pathname.startsWith('/api/')) return route.abort();
      const method = request.method();
      // app.js sends its startup breadcrumb every2s, including under the JS
      // clock. Accept that exact telemetry endpoint without hiding real errors.
      if (url.pathname === '/api/crash-diag' && method === 'POST') {
        const diagnostic = JSON.parse(request.postData() || '{}') as { data?: unknown; id?: unknown };
        if (
          Object.keys(diagnostic).sort().join(',') !== 'data,id' ||
          typeof diagnostic.id !== 'string' ||
          !/^[a-z0-9]+-[a-z0-9]{1,6}$/.test(diagnostic.id) ||
          typeof diagnostic.data !== 'string' ||
          !/^\d{2}:\d{2}:\d{2}\.\d{3} PAGE LOAD(?:\n\d{2}:\d{2}:\d{2}\.\d{3} LONG_TASK: \d+ms)*$/.test(diagnostic.data)
        )
          errors.push(`Unexpected startup diagnostics: ${request.postData()}`);
        return route.fulfill({ status: 204 });
      }
      if (url.pathname !== '/api/tab-layout' || !['GET', 'PUT'].includes(method)) {
        errors.push(`Unexpected API request: ${method} ${url.pathname}`);
        return route.abort();
      }
      requests.push(method);
      const body = method === 'PUT' ? (JSON.parse(request.postData() || '{}') as Write) : null;
      if (body) puts.push(body);
      if (reply) return reply(route, method, body);
      if (!body) {
        errors.push('Unexpected layout read');
        return route.abort();
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { layout: { ...body.layout, version: body.baseVersion + 1 } } }),
      });
    });
    await page.goto('http://reverie.test/');
    await page.setContent(`<!doctype html>
      <html data-tab-orientation="vertical" data-tab-rail-sort="manual">
        <head><style>${read('styles.css')}</style></head>
        <body>
          <main class="main" style="width:100%;height:760px">
            <aside class="tab-rail" id="tabRail" aria-label="Session navigation" style="width:280px"></aside>
            <button id="elsewhere">elsewhere</button>
            <textarea id="term" aria-label="stand-in for the terminal" style="position:absolute;left:700px;top:300px"></textarea>
          </main>
        </body>
      </html>`);
    await page.addScriptTag({
      content:
        'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
        'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
        read('constants.js') +
        '\n' +
        read('tab-layout-browser.js') +
        '\n' +
        read('app.js') +
        '\nwindow.ReverieApp = ReverieApp; window.__setApp = (value) => { app = value; };',
    });
    await page.addScriptTag({ content: read('tab-rail-resize.js') });
    await page.addScriptTag({ content: read('api-client.js') });
    await page.addScriptTag({ content: read('webview-tabs.js') });
    // Render actual shipped error feedback, rather than suppressing showToast.
    await page.addScriptTag({ content: read('panels-ui.js') });
    await page.evaluate(() => {
      const w = window as any;
      const app = Object.create(w.ReverieApp.prototype);
      app.$ = (id: string) => document.getElementById(id);
      app.sessions = new Map([
        ['one', { id: 'one', name: 'One', status: 'idle' }],
        ['two', { id: 'two', name: 'Two', status: 'idle' }],
        ['three', { id: 'three', name: 'Three', status: 'idle' }],
      ]);
      app.sessionOrder = ['one', 'two', 'three'];
      app.webviews = new Map([['web', { id: 'web', name: 'Web', url: 'https://example.test', icon: 'W' }]]);
      app.webviewOrder = ['web'];
      app.collapsedTabGroupIds = new Set();
      app._hiddenTabGroupByRef = new Map();
      app._inlineRenameActive = false;
      app.tabAlerts = new Map();
      app.terminalLoadStates = new Map();
      app.minimizedSubagents = new Map();
      app.hasTabDetachOverride = () => false;
      app.renderSubagentTabBadge = () => '';
      app.cancelHideSubagentDropdown = () => undefined;
      app.updateTabOverflowMode = () => undefined;
      app.updateConnectionLines = () => undefined;
      app._applyTabEntrances = () => undefined;
      app._scrollActiveTabIntoView = () => undefined;
      app.applySidebarFilter = () => undefined;
      app.isSessionSidebarActive = () => false;
      app._startSidebarRichClock = () => undefined;
      app._stopSidebarRichClock = () => undefined;
      app.loadAppSettingsFromStorage = () => ({});
      app.closeAllPanels = () => {
        w.__panelsClosed = true;
      };
      app.selectSession = (id: string) => {
        w.__activation = `session:${id}`;
      };
      app.openWebview = (id: string) => {
        w.__activation = `webview:${id}`;
      };
      w.__setApp(app);
      w.__app = app;
      // Escapes that reach the stand-in terminal (xterm listens on its textarea).
      w.__termEscapes = 0;
      document.getElementById('term')!.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') w.__termEscapes++;
      });
    });
  });

  afterAll(async () => browser.close());
  afterEach(() => expect(errors).toEqual([]));

  beforeEach(async () => {
    puts = [];
    requests = [];
    errors = [];
    reply = null;
    await page.evaluate((layout) => {
      const w = window as any;
      document.querySelector('.toast-container')?.replaceChildren();
      document.getElementById('sessionTabs')?.remove();
      document
        .getElementById('tabRail')!
        .insertAdjacentHTML(
          'afterbegin',
          '<div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs"></div>'
        );
      w.__app._tabKeydownHandler = null;
      w.__app._tabLayoutEditor?.dispose();
      w.__app._tabLayoutEditor = null;
      w.__app._tabLayoutCoordinator = null;
      w.__app._tabLayoutReloadPending = false;
      w.__app.tabLayout = null;
      w.__app.activeSessionId = 'one';
      w.__app.activeWebviewId = null;
      // The rail was just replaced: force the rebuild a skipped no-op would miss.
      w.__app._lastTabGroupStructureKey = null;
      w.__app._applyTabLayout(layout);
      w.__activation = null;
      w.__panelsClosed = false;
      w.__termEscapes = 0;
    }, LAYOUT);
    await page.mouse.move(1, 1);
  });

  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  async function drag(from: string, to: string, yFraction = 0.5) {
    const a = await box(from);
    const b = await box(to);
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 24, a.y + a.height / 2 + 8, { steps: 3 });
    await page.mouse.move(b.x + 30, b.y + b.height * yFraction, { steps: 6 });
    await page.mouse.up();
  }
  const settled = async () => {
    await page.waitForTimeout(80);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
  };
  async function screenshot(name: string) {
    const toast = page.locator('.toast-error.show');
    await expect.poll(() => toast.isVisible()).toBe(true);
    // CSS transitions use browser animation time, independently of the JS clock.
    await expect
      .poll(
        async () => {
          const bounds = await toast.boundingBox();
          return bounds ? bounds.x + bounds.width : Infinity;
        },
        { timeout: 3000 }
      )
      .toBeLessThanOrEqual(1280);
    const bounds = (await toast.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    const directory = process.env.TEST_TAB_LAYOUT_SCREENSHOT_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: join(directory, `${name}.png`) });
    }
  }

  it('drags a row from Ungrouped onto a group header: one PUT appending it there', async () => {
    await drag('.session-tab[data-id="one"]', '[data-tab-group-header="gy"]');
    await settled();
    expect(puts).toHaveLength(1);
    expect(puts[0].baseVersion).toBe(4);
    expect(puts[0].layout.groups[1].refs).toEqual([
      { kind: 'session', id: 'three' },
      { kind: 'session', id: 'one' },
    ]);
    expect(puts[0].layout.ungrouped).toEqual([]);
    // The click that ends a drag neither selected the row nor toggled the header.
    expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
    expect(await page.evaluate(() => (window as any).__app.collapsedTabGroupIds.size)).toBe(0);
    expect(await page.locator('.tab-layout-dragging, .tab-layout-drop-into').count()).toBe(0);
  });

  it('drags a row between two rows of another group (upper half = before)', async () => {
    await drag('.session-tab[data-id="three"]', '.session-tab[data-webview-id="web"]', 0.25);
    await settled();
    expect(puts).toHaveLength(1);
    expect(puts[0].layout.groups[0].refs.map((r: any) => r.id)).toEqual(['two', 'three', 'web']);
    expect(puts[0].layout.groups[1].refs).toEqual([]);
  });

  it('drags a group header above another group: a reorder', async () => {
    await drag('[data-tab-group-header="gy"]', '[data-tab-group-header="gx"]');
    await settled();
    expect(puts).toHaveLength(1);
    expect(puts[0].layout.groups.map((g: any) => g.id)).toEqual(['gy', 'gx']);
    expect(await page.locator('.tab-layout-group').first().getAttribute('data-tab-group-id')).toBe('gy');
  });

  it('Escape mid-drag cancels it without a write; a plain click still selects', async () => {
    const a = await box('.session-tab[data-id="one"]');
    const b = await box('[data-tab-group-header="gy"]');
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
    expect(await page.locator('.tab-layout-drop-into').count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settled();
    expect(puts).toHaveLength(0);

    await page.locator('.session-tab[data-id="two"] .tab-name').click();
    expect(await page.evaluate(() => (window as any).__activation)).toBe('session:two');
  });

  it('a press released outside the rail leaves nothing behind, and Escape still reaches the terminal', async () => {
    const a = await box('.session-tab[data-id="one"]');
    // Press on a row and flick out of the rail in ONE move, releasing out there:
    // the rail never sees the move or the release.
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(760, 600);
    await page.mouse.up();
    // The release was heard on window: the press is gone before any hover.
    expect(await page.evaluate(() => (window as any).__app._tabLayoutDrag)).toBeNull();
    // Hovering back with no button down must not turn into a phantom drag.
    const b = await box('[data-tab-group-header="gy"]');
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
    expect(await page.locator('.tab-layout-dragging, .tab-layout-drop-into, .tab-layout-drag-active').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__app._tabLayoutDrag)).toBeNull();

    // A real drag after that, cancelled with Escape, then one more completed.
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await drag('.session-tab[data-id="one"]', '[data-tab-group-header="gy"]');
    await settled();
    expect(puts).toHaveLength(1);

    // No drag listener is left in document capture swallowing Escape.
    await page.locator('#term').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).__termEscapes)).toBe(2);
    expect(await page.evaluate(() => (window as any).__app._tabLayoutDragKeydown)).toBeNull();
  });

  it('each guard holds on its own: buttons-up move, a second press, no stacked Escape listener', async () => {
    // Synthetic pointer events reach the cases a real mouse cannot isolate (a
    // release outside the WINDOW never reaches any listener of ours).
    const result = await page.evaluate(() => {
      const w = window as any;
      const rail = document.getElementById('sessionTabs')!;
      const at = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { clientX: r.left + 20, clientY: r.top + r.height / 2 };
      };
      const fire = (target: Element, type: string, init: PointerEventInit) =>
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', ...init })
        );
      const one = rail.querySelector('.session-tab[data-id="one"] .tab-name')!;
      const three = rail.querySelector('.session-tab[data-id="three"] .tab-name')!;
      const out: Record<string, unknown> = {};

      // 1. A pending press, then a move with no button down: cancelled, no drag.
      fire(one, 'pointerdown', { button: 0, buttons: 1, ...at(one) });
      fire(three, 'pointermove', { buttons: 0, ...at(three) });
      out.afterButtonsUp = w.__app._tabLayoutDrag;
      out.dragClass = rail.querySelectorAll('.tab-layout-dragging').length;

      // 2. An active drag whose release never arrived, then a new press.
      fire(one, 'pointerdown', { button: 0, buttons: 1, ...at(one) });
      fire(three, 'pointermove', { buttons: 1, ...at(three) });
      out.firstActive = w.__app._tabLayoutDrag?.active === true;
      const firstListener = w.__app._tabLayoutDragKeydown;
      fire(three, 'pointerdown', { button: 0, buttons: 1, ...at(three) });
      out.staleOrigin = rail.querySelectorAll('.tab-layout-dragging').length;
      out.firstListenerKept = w.__app._tabLayoutDragKeydown === firstListener;
      fire(one, 'pointermove', { buttons: 1, ...at(one) });
      fire(one, 'pointerup', { button: 0, buttons: 0, ...at(one) });
      out.leftover = w.__app._tabLayoutDragKeydown;
      return out;
    });
    expect(result.afterButtonsUp).toBeNull();
    expect(result.dragClass).toBe(0);
    expect(result.firstActive).toBe(true);
    expect(result.staleOrigin).toBe(0);
    expect(result.firstListenerKept).toBe(false);
    expect(result.leftover).toBeNull();
    await page.locator('#term').focus();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).__termEscapes)).toBe(1);
    await settled();
  });

  it('committing a group rename by clicking elsewhere leaves focus where the click put it', async () => {
    await page.evaluate(() => (window as any).__app.startTabGroupRename('gy'));
    const input = page.locator('.tab-layout-group-rename-input');
    await expect.poll(() => input.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Elsewhere');
    await page.locator('#term').click();
    await settled();
    expect(puts.at(-1).layout.groups[1].name).toBe('Elsewhere');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('term');
    // So Enter goes to the terminal, not to the header (which would collapse it).
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).__app.collapsedTabGroupIds.size)).toBe(0);
  });

  it('paints the inline group editor as you type, then saves the trimmed name', async () => {
    await page.locator('[data-tab-group-header="gx"]').hover();
    await page.locator('[data-tab-group-header="gx"] .tab-layout-group-menu').click();
    await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
    const input = page.locator('.tab-layout-group-rename-input');
    await expect.poll(() => input.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Front end');
    const paint = await input.evaluate((el: HTMLInputElement) => ({
      value: el.value,
      width: el.getBoundingClientRect().width,
      label: getComputedStyle(el.parentElement!).display,
      scrollWidth: el.scrollWidth,
    }));
    expect(paint.value).toBe('Front end');
    // The editor gets the header's free width, not a collapsed ellipsis slot.
    expect(paint.width).toBeGreaterThan(120);
    expect(paint.label).toBe('flex');
    await page.keyboard.press('Enter');
    await settled();
    expect(puts.at(-1).layout.groups[0].name).toBe('Front end');
    expect(await page.locator('[data-tab-group-header="gx"] .tab-layout-group-name').textContent()).toBe('Front end');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.tabGroupHeader)).toBe('gx');
  });

  it('opens the group menu from the header glyph and Escape closes only it', async () => {
    await page.locator('[data-tab-group-header="gy"]').hover();
    await page.locator('[data-tab-group-header="gy"] .tab-layout-group-menu').click();
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(1);
    // The glyph opened the menu without toggling the group.
    expect(await page.evaluate(() => (window as any).__app.collapsedTabGroupIds.size)).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(0);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.tabGroupHeader)).toBe('gy');

    await page.locator('[data-tab-group-header="gy"]').click({ button: 'right' });
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(1);
    await page.locator('#elsewhere').click();
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(0);
  });

  it('drops a stale pointer move whose destination disappeared without replaying the write', async () => {
    const current = structuredClone(LAYOUT);
    current.version = 9;
    current.groups = [{ ...current.groups[0], name: 'Concurrent name' }];
    current.ungrouped.push({ kind: 'session', id: 'three' });
    reply = async (route, method) => {
      expect(method).toBe('PUT');
      await route.fulfill({ status: 409, json: { success: false, data: { layout: current } } });
    };
    await drag('.session-tab[data-id="one"]', '[data-tab-group-header="gy"]');
    await expect
      .poll(() => page.locator('.toast-message').textContent())
      .toBe('Tab groups changed elsewhere; part of your edit no longer applies.');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as LayoutWindow).__app._tabLayoutEditor.hasPending()))
      .toBe(false);
    expect(puts).toHaveLength(1);
    expect(puts[0].baseVersion).toBe(4);
    expect(puts[0].layout.groups[1].refs.map((ref: { id: string }) => ref.id)).toEqual(['three', 'one']);
    expect(await page.locator('[data-tab-group-header="gy"]').count()).toBe(0);
    expect(await page.locator('[data-tab-group-header="gx"] .tab-layout-group-name').textContent()).toBe(
      'Concurrent name'
    );
    expect(
      await page
        .locator('.session-tab[data-id="one"]')
        .evaluate((el) => el.closest('.tab-layout-group')?.getAttribute('data-tab-group-id') || null)
    ).toBeNull();
    expect(await page.evaluate(() => (window as unknown as LayoutWindow).__app.tabLayout)).toEqual(current);
    expect(await page.evaluate(() => (window as unknown as LayoutWindow).__activation)).toBeNull();
    expect(await page.locator('.tab-layout-dragging, .tab-layout-drop-into').count()).toBe(0);
    await screenshot('stale-destination-1280');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.clock.runFor(5000);
    expect(await page.locator('.toast-error').count()).toBe(0);
    expect(requests).toEqual(['PUT']);
    expect(puts).toHaveLength(1);
  });

  it('reads a committed group rename after a lost reply without replay and saves only a later explicit edit', async () => {
    let current = structuredClone(LAYOUT);
    let readEntered = false;
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    try {
      reply = async (route, method, body) => {
        if (method === 'GET') {
          readEntered = true;
          await readGate;
          await route.fulfill({ json: { success: true, data: { layout: current } } });
          return;
        }
        expect(body!.baseVersion).toBe(current.version);
        current = { ...structuredClone(body!.layout), version: current.version + 1 };
        if (puts.length === 1) await route.abort('failed');
        else await route.fulfill({ json: { success: true, data: { layout: current } } });
      };
      await page.locator('[data-tab-group-header="gx"]').hover();
      await page.locator('[data-tab-group-header="gx"] .tab-layout-group-menu').click();
      await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
      await page.locator('.tab-layout-group-rename-input').fill('Committed before lost reply');
      await page.keyboard.press('Enter');
      await expect.poll(() => readEntered, { timeout: 5000 }).toBe(true);
      await expect.poll(() => page.locator('.toast-message').textContent()).toBe('Could not save tab groups.');
      expect(current.version).toBe(5);
      expect(current.groups[0].name).toBe('Committed before lost reply');
      expect(await page.locator('[data-tab-group-header="gx"] .tab-layout-group-name').textContent()).toBe('Core');
      expect(requests).toEqual(['PUT', 'GET']);
      expect(puts).toHaveLength(1);
      await screenshot('lost-reply-before-readback-1280');
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      releaseRead();
      await expect
        .poll(() => page.locator('[data-tab-group-header="gx"] .tab-layout-group-name').textContent())
        .toBe('Committed before lost reply');
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__app.tabLayout)).toEqual(current);
      await page.clock.runFor(5000);
      expect(requests).toEqual(['PUT', 'GET']);
      expect(puts).toHaveLength(1);
      await page.locator('[data-tab-group-header="gx"]').hover();
      await page.locator('[data-tab-group-header="gx"] .tab-layout-group-menu').click();
      await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
      await page.locator('.tab-layout-group-rename-input').fill('Explicit next edit');
      await page.keyboard.press('Enter');
      await expect.poll(() => puts.length).toBe(2);
      await expect.poll(() => page.evaluate(() => (window as unknown as LayoutWindow).__app.tabLayout.version)).toBe(6);
      expect(puts.map((body: Write) => body.baseVersion)).toEqual([4, 5]);
      expect(current.groups[0].name).toBe('Explicit next edit');
      expect(current.groups[1]).toEqual(LAYOUT.groups[1]);
      expect(current.ungrouped).toEqual(LAYOUT.ungrouped);
      expect(requests).toEqual(['PUT', 'GET', 'PUT']);
    } finally {
      releaseRead();
    }
  });
});
