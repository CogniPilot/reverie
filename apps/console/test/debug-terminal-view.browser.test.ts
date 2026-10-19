/** Conversation-first navigation and the minimal agent terminal in real Chromium. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, member, room } from './helpers/chat-app-harness.mjs';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const A = 'a1111111-0000-4000-8000-000000000001';
const B = 'b2222222-0000-4000-8000-000000000002';

describe('minimal agent terminal in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let errors: string[];
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

  async function open(width = 1280, query = '', stored = '') {
    errors = [];
    page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on('pageerror', (error) => errors.push(error.message));
    const server = createServer([room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')])]);
    await page.route('http://reverie.test/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await server.handle(url.pathname + url.search, {
        method: request.method(),
        body: request.postData() ? JSON.parse(request.postData()!) : undefined,
      });
      await route.fulfill({ status: response.status, json: await response.json() });
    });
    await page.route('http://reverie.test/chat-app.css', (route) =>
      route.fulfill({ contentType: 'text/css', body: read('chat-app.css') })
    );
    await page.route('http://reverie.test/chat-app.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: read('chat-app.js') })
    );
    await page.route('http://reverie.test/board', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Board</h1><p>Usage and resets</p>' })
    );
    await page.route('http://reverie.test/?*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.route('http://reverie.test/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.goto('http://reverie.test/' + query, { waitUntil: 'domcontentloaded' });
    await page.setContent(`<!doctype html><html><head><style>${read('styles.css')}\n${read('mobile.css')}</style></head><body>
      <div class="app">
        <header class="header"><div class="header-brand">Codeman</div><button>Settings</button><div id="sessionTabs">All sessions</div></header>
        <main class="main"><aside id="tabRail">Session rail</aside><aside id="sessionSidebar">Session list</aside>
          <div class="terminal-wrap"><div id="terminalContainer" class="terminal-container"><textarea aria-label="Terminal"></textarea></div><textarea id="cjkInput" aria-label="CJK input"></textarea></div>
          <section id="tileGrid">Tiled sessions</section><div id="webviewLayer">Web view</div><div id="welcomeOverlay">Welcome</div>
        </main>
        <div class="modal" id="appSettingsModal" style="display:none">Legacy settings</div>
      </div><svg id="connectionLines"><path d="M0 0L100 100"/></svg>
    </body></html>`);
    await page.evaluate(
      ({ stored }) => {
        if (stored) sessionStorage.setItem('reverie:view', stored);
        (window as any).CodemanUrlSession = {
          sessionIdFromFragment: (hash: string) => new URLSearchParams(hash.replace(/^#/, '')).get('session'),
        };
      },
      { stored }
    );
    await page.addScriptTag({
      content: `
        class CodemanApp {
          constructor() {
            this.sessions = new Map([
              ['${A}', {id:'${A}', name:'alpha', mode:'shell'}],
              ['${B}', {id:'${B}', name:'bravo', mode:'shell'}]
            ]);
            this.activeSessionId = '${B}';
            this.selected = [];
            this.toasts = [];
            this.pendingHooks = new Map();
            this._connectionStatus = 'connected';
          }
          _api(path, opts = {}) {
            return fetch(path, {method:opts.method || 'GET', headers:{'Content-Type':'application/json'},
              ...(opts.body === undefined ? {} : {body:JSON.stringify(opts.body)})});
          }
          selectSession(id) { this.activeSessionId = id; this.selected.push(id); }
          showToast(text) { this.toasts.push(text); }
          getSessionName(session) { return session.name; }
          _chatVoiceTarget() { return null; }
          _bindChatMic() {}
          setConnectionStatus(status) { this._connectionStatus = status; }
          closeSplitPane() {}
        }
        window.CodemanApp = CodemanApp;
        window.app = new CodemanApp();
        ${read('chatroom-ui.js')}
        ${read('chat-media.js')}
      `,
    });
    await page.waitForFunction(() => (window as any).reverieChat?.built);
    if (await page.evaluate(() => (window as any).reverieChat.view === 'chat')) {
      await page.waitForSelector('.ca-item[data-key="page:board"]', { state: 'attached' });
    }
    return server;
  }

  it.each([1280, 390])('shows only the chosen terminal and Back to chat at %ipx', async (width) => {
    await open(width);
    const shell = page.locator('#chatApp');
    expect(await shell.isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Debug terminals', exact: true }).count()).toBe(0);
    await page.evaluate(() => (window as any).reverieChat.showDebug('a1111111-0000-4000-8000-000000000001'));
    await page.evaluate(() => {
      document.getElementById('appSettingsModal')!.style.display = 'block';
    });
    expect(await shell.isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: 'Back to chat', exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole('textbox', { name: 'Terminal', exact: true }).isVisible()).toBe(true);
    for (const selector of [
      '.header',
      '#sessionTabs',
      '#tabRail',
      '#sessionSidebar',
      '#connectionLines',
      '#appSettingsModal',
      '#tileGrid',
      '#webviewLayer',
    ]) {
      expect(await page.locator(selector).isVisible()).toBe(false);
    }
    expect(await page.evaluate(() => (window as any).app.selected)).toEqual([A]);
    const terminal = await page.locator('#terminalContainer').boundingBox();
    expect(terminal!.x).toBeGreaterThanOrEqual(0);
    expect(terminal!.x + terminal!.width).toBeLessThanOrEqual(width + 1);
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    expect(await shell.isVisible()).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('reverie:view'))).toBeNull();
  });

  it('keeps full legacy controls behind the explicit query flag', async () => {
    await open(1280, '?legacy=1');
    expect(await page.locator('html').getAttribute('data-reverie-view')).toBe('debug');
    expect(await page.locator('.header').isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible()).toBe(true);
    expect(await page.locator('#sessionTabs').isVisible()).toBe(true);
  });

  it('restores a requested debug view with minimal chrome and closes tile/split views for an agent pick', async () => {
    await open(1280, '', 'debug');
    expect(await page.locator('.header').isVisible()).toBe(false);
    await page.evaluate(() => {
      const w = window as any;
      w.app._tileGrid = { open: true };
      w.app.closeTileGrid = () => {
        w.app._tileGrid.open = false;
        w.closedTiles = true;
      };
      w.app.closeSplitPane = () => {
        w.closedSplit = true;
      };
      w.reverieChat.showDebug('a1111111-0000-4000-8000-000000000001');
    });
    expect(
      await page.evaluate(() => ({ tiles: (window as any).closedTiles, split: (window as any).closedSplit }))
    ).toEqual({ tiles: true, split: true });
    expect(await page.getByRole('textbox', { name: 'Terminal', exact: true }).isVisible()).toBe(true);
  });

  it('offers Board and its usage view, while #plans opens no page', async () => {
    await open(1280, '#plans');
    expect(await page.locator('.ca-pages .ca-item').allTextContents()).toEqual(['Board']);
    expect(await page.locator('.ca-page').count()).toBe(0);
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    expect(await page.locator('.ca-page-frame').getAttribute('src')).toBe('/board');
    await page.frameLocator('.ca-page-frame').getByText('Usage and resets').waitFor({ state: 'visible' });
    expect(await page.frameLocator('.ca-page-frame').getByText('Usage and resets').isVisible()).toBe(true);
  });
  it('fits the debug terminal to keyboard height and viewport panning, then restores it', async () => {
    await open(390);
    await page.evaluate(() => (window as any).reverieChat.showDebug('a1111111-0000-4000-8000-000000000001'));
    for (const [height, top, event] of [[480, 32, 'resize'], [480, 64, 'scroll'], [560, 0, 'resize'], [844, 0, 'resize']] as const) {
      await page.evaluate(({height, top, event}) => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', {value: height, configurable: true});
        Object.defineProperty(vv, 'offsetTop', {value: top, configurable: true});
        vv.dispatchEvent(new Event(event));
      }, {height, top, event});
      const main = await page.locator('.app > .main').boundingBox();
      const terminal = await page.locator('#terminalContainer').boundingBox();
      const back = await page.getByRole('button', {name:'Back to chat', exact:true}).boundingBox();
      expect(main!.y).toBeCloseTo(top + 48, 0);
      expect(main!.y + main!.height).toBeLessThanOrEqual(top + height + 1);
      expect(terminal!.y + terminal!.height).toBeLessThanOrEqual(top + height + 1);
      expect(back!.y).toBeGreaterThanOrEqual(top);
      expect(back!.y + back!.height).toBeLessThanOrEqual(top + 48);
    }
    await page.getByRole('button', {name:'Back to chat', exact:true}).click();
    expect(await page.locator('#chatApp').isVisible()).toBe(true);
  });

});
