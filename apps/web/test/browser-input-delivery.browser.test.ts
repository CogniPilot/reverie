/** Two real pages/storage owners through actual authenticated routes and Session input service. */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerInputIdentityRoutes } from '../src/web/routes/input-identity-routes.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerWsRoutes } from '../src/web/routes/ws-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { terminalInputFingerprint } from '../src/web/terminal-input-service.js';
import ts from 'typescript';

type RecordRow = {
  sid: string;
  issuer: string;
  seq: number;
  data: string;
  useMux: boolean | null;
  phase: string;
  fingerprint: string;
};
type App = {
  _inputStorageUnavailable?: boolean;
  _createRawInputBuffer(
    sid: string,
    changed?: (owner: { readonly data: string }) => void
  ): { append(text: string): boolean; flush(): Promise<boolean>; readonly data: string };
  _inputJournalReady: Promise<boolean>;
  _inputJournal: {
    issuer: string;
    snapshot(): Promise<{ records: RecordRow[]; retained: RecordRow[]; holds: object[] }>;
  };
  _pendingDeliveries: Map<string, RecordRow[]>;
  _inputRecoveryHolds: Set<string>;
  _unsavedInputDrafts: { sid: string; text: string }[];
  _loadReliableState(): Promise<boolean>;
  _sendInputAsync(sid: string, text: string, opts?: object): Promise<boolean>;
  _drainSession(sid: string): Promise<void>;
  _confirmOverlayInput(sid: string): Promise<boolean>;
  _inputFlights: Map<string, unknown>;
  _redeliverSweep(): void;
};
type Scope = { app: App; ReviewApp: { prototype: object } };
const publicRoot = resolve(import.meta.dirname, '../src/web/public');
const terminalSource = ts.createSourceFile(
  'terminal-ui.js',
  readFileSync(join(publicRoot, 'terminal-ui.js'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);
const rawDeclarations: ts.VariableDeclaration[] = [];
let rawActionCalls = 0;
function rawSource(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'retainRawAction')
    rawDeclarations.push(node);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'retainRawAction')
    rawActionCalls++;
  ts.forEachChild(node, rawSource);
}
rawSource(terminalSource);
if (rawDeclarations.length !== 1 || rawActionCalls !== 3)
  throw new Error('The actual primary raw action seams changed; review their retention contract');
const rawActionDeclaration = `const ${rawDeclarations[0].getText(terminalSource)};`;
const scripts = [
  'xterm.js',
  'constants.js',
  'mobile-handlers.js',
  'keyboard-accessory.js',
  'app.js',
  'browser-input-journal.js',
  'input-delivery.js',
  'input-cjk.js',
  'terminal-ui.js',
  'session-ui.js',
  'readmymind-ui.js',
  'overlay.js',
];
let browser: Browser, server: FastifyInstance, origin: string, directory: string, token: string;
let ctx: ReturnType<typeof createMockRouteContext>;
const writes = new Map<string, string[]>(),
  posts: Array<{ sid: string; input: string; clientId: string; seq: number; useMux?: boolean }> = [];
beforeAll(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'browser-input-delivery-'));
  const store = new OwnerAuthStore(join(directory, 'owner.json'));
  const auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  token = await auth.setup(
    'synthetic-browser-owner',
    'Browser-input-proof-42!',
    'Browser-input-proof-42!',
    '127.0.0.1'
  );
  ctx = createMockRouteContext();
  ctx.sessions.clear();
  server = Fastify();
  await server.register(cookie);
  await server.register(websocket);
  registerOwnerPolicy(server, {
    service: auth,
    ctx: ctx as unknown as SessionPort,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
      coordinated: () => false,
    },
  });
  registerInputIdentityRoutes(server, auth, false);
  registerSessionRoutes(server, ctx as never, { verifiedOwner: trustedFixtureOwner });
  registerWsRoutes(server, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
  installRouteErrorHandler(server);
  server.addHook('onRequest', (req, _reply, done) => {
    if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/input$/.test(req.url)) {
      // Body is captured below after parsing, never from personal state.
    }
    done();
  });
  server.addHook('preHandler', (req, _reply, done) => {
    if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/input$/.test(req.url))
      posts.push({ sid: (req.params as { id: string }).id, ...(req.body as Omit<(typeof posts)[number], 'sid'>) });
    done();
  });
  server.addHook('preSerialization', (req, _reply, payload, done) => {
    if (!req.url.startsWith('/api') || !payload || typeof payload !== 'object' || 'success' in payload)
      return done(null, payload);
    done(null, { success: true, data: payload });
  });
  server.get('/', (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div class="terminal-wrap"><div class="input-recovery-bar" id="inputRecoveryBar" role="alert" hidden></div><div id="fixtureTerminal"></div></div><textarea id="cjkInput"></textarea>'
      )
  );
  server.get('/script/:name', (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!scripts.includes(name)) return reply.code(404).send();
    return reply
      .type('text/javascript; charset=utf-8')
      .send(
        readFileSync(
          join(
            publicRoot,
            name === 'overlay.js' ? 'vendor/xterm-zerolag-input.js' : name === 'xterm.js' ? 'vendor/xterm.min.js' : name
          ),
          'utf8'
        ) + (name === 'app.js' ? '\nwindow.ReviewApp = ReverieApp;' : '')
      );
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  for (const session of ctx?.sessions.values() || []) {
    Object.assign(session, { ptyProcess: null });
    await (session as unknown as Session).stop(false);
  }
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function subject(id: string) {
  const session = new Session({ id, owner: 'owner', mode: 'shell', workingDir: directory, useMux: false });
  const output: string[] = [];
  writes.set(id, output);
  Object.assign(session, { ptyProcess: { write: (text: string) => output.push(text) } });
  ctx.sessions.set(id, session as never);
  return session;
}
async function page(context: BrowserContext, sid: string) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  for (const name of scripts) await page.addScriptTag({ url: `${origin}/script/${name}` });
  expect(errors).toEqual([]);
  await page.evaluate(async (sid) => {
    const scope = window as unknown as Scope;
    scope.app = Object.assign(Object.create(scope.ReviewApp.prototype), {
      activeSessionId: sid,
      sessions: new Map([[sid, { id: sid }]]),
      _pendingDeliveries: new Map(),
      _extraInputSockets: new Map(),
      showToast() {},
      _updateConnectionIndicator() {},
      markIdleAlertSeen() {},
    });
    if (!(await scope.app._loadReliableState())) throw new Error('Actual input journal failed to open');
  }, sid);
  await page.addScriptTag({
    content: 'app = window.app; window.ReviewCjk = CjkInput; window.ReviewBar = KeyboardAccessoryBar;',
  });
  return page;
}
async function assertRecoveredLayout(p: Page, prefix: string, selector = '[data-local-editor-draft]') {
  await p.addStyleTag({ content: readFileSync(join(publicRoot, 'styles.css'), 'utf8') });
  await p.addStyleTag({ content: readFileSync(join(publicRoot, 'vendor/xterm.css'), 'utf8') });
  await p.evaluate(async () => {
    type DisplayTerminal = {
      open(element: HTMLElement): void;
      loadAddon(addon: object): void;
      write(text: string, done: () => void): void;
    };
    const scope = window as unknown as Scope & { Terminal: new (options: object) => DisplayTerminal };
    const terminal = new scope.Terminal({ cols: 40, rows: 24 });
    terminal.open(document.getElementById('fixtureTerminal')!);
    const current = (scope.app as App & { _localEchoOverlay?: { rerender(): void } })._localEchoOverlay;
    if (current) terminal.loadAddon(current);
    await new Promise<void>((done) => terminal.write('> ', done));
    current?.rerender();
    Object.assign(scope.app, { terminal });
    (scope.app as App & { _syncRawInputAvailability(): void })._syncRawInputAvailability();
  });
  for (const width of [320, 390, 1280]) {
    await p.setViewportSize({ width, height: 800 });
    await p.bringToFront();
    await p.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    );
    const fields = await p.locator(selector).all();
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(await field.isVisible()).toBe(true);
      const rect = await field.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(800);
    }
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.TEST_INPUT_JOURNAL_SCREENSHOT_DIR) {
      await mkdir(process.env.TEST_INPUT_JOURNAL_SCREENSHOT_DIR, { recursive: true });
      await p.screenshot({ path: join(process.env.TEST_INPUT_JOURNAL_SCREENSHOT_DIR, prefix + '-' + width + '.png') });
    }
  }
}

async function context() {
  const context = await browser.newContext();
  await context.addCookies([{ name: OWNER_COOKIE, value: token, url: origin }]);
  return context;
}
const send = (page: Page, sid: string, text: string) =>
  page.evaluate(({ sid, text }) => (window as unknown as Scope).app._sendInputAsync(sid, text, { useMux: false }), {
    sid,
    text,
  });

it.each([false, true])(
  'two preloaded real pages deliver both distinct user actions once, same text=%s',
  async (same) => {
    const sid = `actual-two-pages-${same}`,
      session = subject(sid),
      c = await context();
    try {
      const [left, right] = await Promise.all([page(c, sid), page(c, sid)]);
      expect(await send(left, sid, 'first explicit input')).toBe(true);
      expect(await send(right, sid, same ? 'first explicit input' : 'second explicit input')).toBe(true);
      await expect.poll(() => writes.get(sid)?.length).toBe(2);
      const intents = posts.filter((row) => row.sid === sid);
      expect(intents).toHaveLength(2);
      expect(intents.map((row) => row.seq)).toEqual([1, 1]);
      expect(intents[0].clientId).not.toBe(intents[1].clientId);
      // Independent pages make no global typing-order promise; both original
      // actions must occur once even when storage/network scheduling interleaves.
      expect([...writes.get(sid)!].sort()).toEqual(
        ['first explicit input', same ? 'first explicit input' : 'second explicit input'].sort()
      );
      for (const intent of intents) expect(session.inputSeqSpent(intent.clientId, intent.seq)).toBe(true);
      expect(await left.evaluate(() => localStorage.getItem('reverie:pendingInput'))).toBeNull();
    } finally {
      await c.close();
    }
  }
);

it('two actual primary WebSockets use distinct journal issuers and confirmed receipts without HTTP replay', async () => {
  const sid = 'actual-two-websockets';
  subject(sid);
  const c = await context();
  try {
    const [left, right] = await Promise.all([page(c, sid), page(c, sid)]);
    for (const p of [left, right]) {
      await p.evaluate((sid) => {
        const app = (window as unknown as { app: App & { _connectWs(sid: string): void } }).app;
        Object.assign(app, { _wsTabNonce: crypto.randomUUID(), sendResize() {}, _startMobileResizeRetry() {} });
        app._connectWs(sid);
      }, sid);
      await p.waitForFunction(() => (window as unknown as { app: { _wsReady: boolean } }).app._wsReady === true);
    }
    expect(await send(left, sid, 'same explicit WS text')).toBe(true);
    expect(await send(right, sid, 'same explicit WS text')).toBe(true);
    await expect.poll(() => writes.get(sid)).toEqual(['same explicit WS text', 'same explicit WS text']);
    for (const p of [left, right])
      await expect
        .poll(() => p.evaluate((sid) => (window as unknown as Scope).app._pendingDeliveries.get(sid)?.length || 0, sid))
        .toBe(0);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it('an old actual browser POST without the protocol marker is refused before any Session effect', async () => {
  const sid = 'actual-old-browser',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        const response = await fetch(`/api/sessions/${sid}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'must not write', useMux: false }),
        });
        return { status: response.status, body: await response.json() };
      }, sid)
    ).toMatchObject({ status: 409, body: { success: false, reloadRequired: true } });
    expect(writes.get(sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it('the actual Stop and Read My Mind controls use journaled protocol2 input against the real routes', async () => {
  const sid = 'actual-existing-caller-controls',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        const app = (
          window as unknown as {
            app: App & { stopClaude(): Promise<boolean>; sendReadMyMind(enter: boolean): Promise<boolean> };
          }
        ).app;
        const button = document.createElement('button');
        button.className = 'btn-toolbar btn-stop';
        button.textContent = 'Stop';
        document.body.append(button);
        let result = Promise.resolve(false);
        button.addEventListener('click', () => {
          result = app.stopClaude();
        });
        button.click();
        const first = await result;
        button.click();
        const second = await result;
        const field = document.createElement('input');
        field.id = 'readMyMindPrompt';
        field.value = 'Chosen prompt';
        document.body.append(field);
        Object.assign(app, { _rmm: { sessionId: sid, selected: 0 } });
        const chosen = await app.sendReadMyMind(true);
        return [first, second, chosen];
      }, sid)
    ).toEqual([false, true, true]);
    await expect
      .poll(async () => {
        await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
        return writes.get(sid);
      })
      .toEqual(['\x03', 'Chosen prompt\r']);
    expect(posts.filter((row) => row.sid === sid).map((row) => row.seq)).toEqual([1, 2]);
  } finally {
    await c.close();
  }
});

it('100 actual editable Send clicks after storage failure retain one draft and no orphan copies or effects', async () => {
  const sid = 'actual-repeat-editable',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        const app = (window as unknown as { app: App & { sendReadMyMind(enter: boolean): Promise<boolean> } }).app;
        const modal = document.createElement('div');
        modal.id = 'readMyMindModal';
        modal.className = 'active';
        const field = document.createElement('input');
        field.id = 'readMyMindPrompt';
        field.value = 'Editable draft 😀';
        modal.append(field);
        const button = document.createElement('button');
        button.textContent = 'Send';
        modal.append(button);
        document.body.append(modal);
        Object.assign(app, { _rmm: { sessionId: sid, selected: 0 } });
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
          const tx = original.apply(this, args);
          if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
          return tx;
        };
        let result = Promise.resolve(false);
        button.addEventListener('click', () => {
          result = app.sendReadMyMind(true);
        });
        const answers = [];
        for (let count = 0; count < 100; count++) {
          button.click();
          answers.push(await result);
        }
        return {
          answers,
          draft: field.value,
          open: modal.classList.contains('active'),
          retained: app._unsavedInputDrafts.length,
        };
      }, sid)
    ).toEqual({ answers: Array(100).fill(false), draft: 'Editable draft 😀', open: true, retained: 0 });
    expect(await p.locator('[data-unqueued-input]').count()).toBe(0);
    expect(writes.get(sid)).toEqual([]);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it.each([false, true])('raw A custody survives delayed acceptance and switching to B, A abort=%s', async (abort) => {
  const a = `actual-raw-owner-a-${abort}`,
    b = `actual-raw-owner-b-${abort}`,
    c = await context();
  subject(a);
  subject(b);
  try {
    const p = await page(c, a);
    await p.evaluate(
      ({ a, b, abort }) => {
        const s = window as unknown as Scope & { releaseRawA(): void; rawATask: Promise<boolean> };
        const app = s.app,
          originalSend = app._sendInputAsync.bind(app);
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        s.releaseRawA = release;
        app._sendInputAsync = async (sid, text, options) => {
          if (sid === a) {
            await gate;
            if (abort) {
              const original = IDBDatabase.prototype.transaction;
              IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
                const tx = original.apply(this, args);
                if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
                return tx;
              };
            }
          }
          return originalSend(sid, text, options);
        };
        const ownerA = app._createRawInputBuffer(a);
        ownerA.append('A-one');
        s.rawATask = ownerA.flush();
        ownerA.append(' A-two');
        Object.assign(app, { activeSessionId: b });
        const ownerB = app._createRawInputBuffer(b);
        ownerB.append('B-only');
        void ownerB.flush();
      },
      { a, b, abort }
    );
    await expect.poll(() => writes.get(b)).toEqual(['B-only']);
    expect(writes.get(a)).toEqual([]);
    expect(
      await p.evaluate(async () => {
        const s = window as unknown as { releaseRawA(): void; rawATask: Promise<boolean> };
        s.releaseRawA();
        return s.rawATask;
      })
    ).toBe(!abort);
    if (abort) {
      expect(await p.locator('[data-unqueued-input]').inputValue()).toBe('');
      expect(await p.evaluate(() => (window as unknown as Scope).app._unsavedInputDrafts)).toEqual([
        { sid: a, text: 'A-one' },
        { sid: a, text: ' A-two' },
      ]);
      // The attempted prefix and its still-unsubmitted tail retain separate opaque reservations.
      // Their original ordered bytes remain one copyable draft when selecting the original SID.
      await p.evaluate((sid) => {
        const app = (window as unknown as Scope).app as App & { _renderInputRecoveryBanner(): void };
        Object.assign(app, { activeSessionId: sid });
        app._renderInputRecoveryBanner();
      }, a);
      expect(await p.locator('[data-unqueued-input]').inputValue()).toBe('A-one A-two');
      await p.evaluate(async (sid) => {
        const app = (window as unknown as Scope).app;
        app._redeliverSweep();
        await app._drainSession(sid);
      }, a);
      expect(await p.locator('[data-unqueued-input]').inputValue()).toBe('A-one A-two');
      expect(writes.get(a)).toEqual([]);
    } else {
      await expect
        .poll(async () => {
          await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
          return writes.get(a);
        })
        .toEqual(['A-one', ' A-two']);
    }
    expect(writes.get(b)).toEqual(['B-only']);
  } finally {
    await c.close();
  }
});

it.each([false, true])(
  'Clear flushes the original raw owner before its control and never replays it, in-flight=%s',
  async (inFlight) => {
    const sid = `actual-raw-clear-${inFlight}`,
      c = await context();
    subject(sid);
    try {
      const p = await page(c, sid);
      await p.evaluate(
        ({ sid, inFlight }) => {
          type Owner = ReturnType<App['_createRawInputBuffer']>;
          const s = window as unknown as Scope & {
            clearTask: Promise<boolean>;
            releaseClear(): void;
            clearOwner: Owner;
          };
          const app = s.app as App & { clearTerminalInput(): Promise<boolean> },
            send = app._sendInputAsync.bind(app);
          let release!: () => void;
          const gate = new Promise<void>((done) => {
            release = done;
          });
          s.releaseClear = release;
          app._sendInputAsync = async (id, text, options) => {
            if (text === 'before clear') await gate;
            return send(id, text, options);
          };
          const owner = (s.clearOwner = app._createRawInputBuffer(sid, (current) => {
            if ((app as unknown as { _pendingInputOwner: Owner })._pendingInputOwner === current)
              Object.assign(app, { _pendingInput: current.data });
          }));
          Object.assign(app, { _pendingInputOwner: owner });
          owner.append('before clear');
          if (inFlight) void owner.flush();
          s.clearTask = app.clearTerminalInput();
        },
        { sid, inFlight }
      );
      expect(writes.get(sid)).toEqual([]);
      expect(posts.filter((row) => row.sid === sid)).toEqual([]);
      expect(
        await p.evaluate(async () => {
          const s = window as unknown as { clearTask: Promise<boolean>; releaseClear(): void };
          s.releaseClear();
          return s.clearTask;
        })
      ).toBe(true);
      await expect
        .poll(async () => {
          await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
          return writes.get(sid);
        })
        .toEqual(['before clear', '\x15']);
      await p.evaluate(async () => {
        const owner = (window as unknown as { clearOwner: ReturnType<App['_createRawInputBuffer']> }).clearOwner;
        await owner.flush();
        owner.append('after clear');
        await owner.flush();
      });
      await expect
        .poll(async () => {
          await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
          return writes.get(sid);
        })
        .toEqual(['before clear', '\x15', 'after clear']);
      expect(posts.filter((row) => row.sid === sid).map((row) => row.seq)).toEqual([1, 2, 3]);
    } finally {
      await c.close();
    }
  }
);

it('Clear refuses a stale raw revision without sending its control or dropping newer text', async () => {
  const sid = 'actual-stale-clear',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        const app = (window as unknown as Scope).app as App & { clearTerminalInput(): Promise<boolean> };
        const send = app._sendInputAsync.bind(app);
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        app._sendInputAsync = async (id, text, options) => {
          if (text === 'before') await gate;
          return send(id, text, options);
        };
        const owner = app._createRawInputBuffer(sid);
        Object.assign(app, { _pendingInputOwner: owner });
        owner.append('before');
        const clear = app.clearTerminalInput();
        owner.append(' after');
        release();
        return clear;
      }, sid)
    ).toBe(false);
    await expect
      .poll(async () => {
        await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
        return writes.get(sid);
      })
      .toEqual(['before', ' after']);
    expect(posts.filter((row) => row.sid === sid).some((row) => row.input === '\x15')).toBe(false);
  } finally {
    await c.close();
  }
});

it.each(['modifier', 'paste', 'backspace'] as const)(
  'the actual raw %s action seam retains only its orphan event on transaction abort',
  async (kind) => {
    const sid = `actual-raw-action-${kind}`,
      c = await context();
    subject(sid);
    try {
      const p = await page(c, sid);
      await p.addScriptTag({
        content: `window.reviewRawAction = (function(){${rawActionDeclaration} return retainRawAction;}).call(window.app);`,
      });
      expect(
        await p.evaluate(
          async ({ sid, kind }) => {
            const s = window as unknown as Scope & {
              reviewRawAction(
                sid: string,
                raw: string,
                action: (reservation: object, sid: string) => Promise<boolean>
              ): Promise<boolean>;
              ReviewBar: { _setCtrl(on: boolean): void; isCtrlArmed(): boolean };
              XtermZerolagInput: {
                ZerolagInputAddon: new () => { appendText(text: string): void; pendingText: string };
              };
            };
            const overlay = new s.XtermZerolagInput.ZerolagInputAddon();
            overlay.appendText('editable prefix');
            Object.assign(s.app, { _localEchoEnabled: true, _localEchoOverlay: overlay });
            const original = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
              const tx = original.apply(this, args);
              if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
              return tx;
            };
            const app = s.app as App & {
              _acceptTerminalDraftAction(
                sid: string,
                raw: string,
                modifiers?: boolean,
                reservation?: object
              ): Promise<boolean>;
              _acceptOverlayBackspace(sid: string, overlay: object, reservation?: object): Promise<boolean>;
            };
            const raw = kind === 'modifier' ? 'x' : kind === 'paste' ? '\x1b[200~pasted 😀\x1b[201~' : '\x7f';
            if (kind === 'modifier') s.ReviewBar._setCtrl(true);
            const action = (reservation: object, originalSid: string) =>
              kind === 'backspace'
                ? app._acceptOverlayBackspace(originalSid, overlay, reservation)
                : app._acceptTerminalDraftAction(originalSid, raw, kind === 'modifier', reservation);
            const accepted = await s.reviewRawAction(sid, raw, action);
            return {
              accepted,
              raw,
              draft: overlay.pendingText,
              retained: app._unsavedInputDrafts,
              ctrl: s.ReviewBar.isCtrlArmed(),
            };
          },
          { sid, kind }
        )
      ).toMatchObject({
        accepted: false,
        draft: 'editable prefix',
        retained: [
          { sid, text: kind === 'modifier' ? 'x' : kind === 'paste' ? '\x1b[200~pasted 😀\x1b[201~' : '\x7f' },
        ],
        ctrl: kind === 'modifier',
      });
      expect(writes.get(sid)).toEqual([]);
      expect(posts.filter((row) => row.sid === sid)).toEqual([]);
    } finally {
      await c.close();
    }
  }
);

it.each(['append-during-acceptance', 'append-before-dispatch', 'consecutive-enter'] as const)(
  'an original editor claim is consumed once through actual storage: %s',
  async (mode) => {
    const sid = 'actual-editor-' + mode,
      c = await context();
    subject(sid);
    try {
      const p = await page(c, sid);
      expect(
        await p.evaluate(
          async ({ sid, mode }) => {
            type Overlay = { appendText(text: string): void; pendingText: string };
            const scope = window as unknown as Scope & { XtermZerolagInput: { ZerolagInputAddon: new () => Overlay } };
            const app = scope.app as App & {
              _acceptTerminalDraftAction(id: string, suffix: string): Promise<boolean>;
              _terminalDraftTail?: Promise<unknown>;
            };
            const overlay = new scope.XtermZerolagInput.ZerolagInputAddon();
            overlay.appendText('A😀');
            Object.assign(app, { _localEchoEnabled: true, _localEchoOverlay: overlay });
            let release!: () => void, entered!: () => void;
            const gate = new Promise<void>((done) => {
              release = done;
            });
            const began = new Promise<void>((done) => {
              entered = done;
            });
            if (mode === 'append-before-dispatch') app._terminalDraftTail = gate;
            else {
              const journal = app._inputJournal as App['_inputJournal'] & {
                accept(...args: unknown[]): Promise<unknown>;
              };
              const accept = journal.accept.bind(journal);
              let first = true;
              journal.accept = async (...args) => {
                if (first) {
                  first = false;
                  entered();
                  await gate;
                }
                return accept(...args);
              };
            }
            const first = app._acceptTerminalDraftAction(sid, '\r');
            if (mode !== 'append-before-dispatch') await began;
            if (mode !== 'consecutive-enter') overlay.appendText('B😺');
            const second = app._acceptTerminalDraftAction(sid, '\r');
            release();
            return { accepted: await Promise.all([first, second]), draft: overlay.pendingText };
          },
          { sid, mode }
        )
      ).toEqual({ accepted: [true, true], draft: '' });
      const expected = mode === 'consecutive-enter' ? ['A😀', '\r', '\r'] : ['A😀', '\r', 'B😺', '\r'];
      await expect
        .poll(async () => {
          await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
          return writes.get(sid);
        })
        .toEqual(expected);
      expect(posts.filter((row) => row.sid === sid).map((row) => row.input)).toEqual(expected);
    } finally {
      await c.close();
    }
  }
);

it('a dispatched original claim cannot consume deleted and retyped equal Unicode draft bytes', async () => {
  const sid = 'actual-editor-retype',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        type Overlay = { appendText(text: string): void; removeChar(): unknown; pendingText: string };
        const scope = window as unknown as Scope & { XtermZerolagInput: { ZerolagInputAddon: new () => Overlay } };
        const app = scope.app as App & { _acceptTerminalDraftAction(id: string, suffix: string): Promise<boolean> };
        const overlay = new scope.XtermZerolagInput.ZerolagInputAddon();
        overlay.appendText('😀');
        Object.assign(app, { _localEchoEnabled: true, _localEchoOverlay: overlay });
        const journal = app._inputJournal as App['_inputJournal'] & { accept(...args: unknown[]): Promise<unknown> },
          accept = journal.accept.bind(journal);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((done) => {
            release = done;
          }),
          began = new Promise<void>((done) => {
            entered = done;
          });
        journal.accept = async (...args) => {
          entered();
          await gate;
          return accept(...args);
        };
        const original = app._acceptTerminalDraftAction(sid, '\r');
        await began;
        overlay.removeChar();
        overlay.appendText('😀');
        release();
        const accepted = await original,
          successor = overlay.pendingText;
        journal.accept = accept;
        return { accepted, successor };
      }, sid)
    ).toEqual({ accepted: true, successor: '😀' });
    await expect
      .poll(async () => {
        await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
        return writes.get(sid);
      })
      .toEqual(['😀', '\r']);
    expect(posts.filter((row) => row.sid === sid).map((row) => row.input)).toEqual(['😀', '\r']);
  } finally {
    await c.close();
  }
});

it('an original queued gesture refuses a replacement editor without reading or clearing its draft', async () => {
  const sid = 'actual-editor-replaced',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        type Overlay = { appendText(text: string): void; pendingText: string };
        const scope = window as unknown as Scope & { XtermZerolagInput: { ZerolagInputAddon: new () => Overlay } };
        const app = scope.app as App & {
          _acceptTerminalDraftAction(id: string, suffix: string): Promise<boolean>;
          _terminalDraftTail?: Promise<unknown>;
          _renderInputRecoveryBanner(): void;
          _rawInputBlocked(id: string): boolean;
          activeSessionId: string;
          sessions: Map<string, object>;
        };
        const original = new scope.XtermZerolagInput.ZerolagInputAddon();
        original.appendText('original');
        Object.assign(app, { _localEchoEnabled: true, _localEchoOverlay: original });
        let release!: () => void;
        app._terminalDraftTail = new Promise<void>((done) => {
          release = done;
        });
        const action = app._acceptTerminalDraftAction(sid, '\r');
        const successor = new scope.XtermZerolagInput.ZerolagInputAddon();
        successor.appendText('successor');
        Object.assign(app, { _localEchoOverlay: successor });
        release();
        const accepted = await action;
        const appView = app;
        appView.sessions.set('different-session', { id: 'different-session' });
        appView.activeSessionId = 'different-session';
        appView._renderInputRecoveryBanner();
        const copy = document.querySelector<HTMLTextAreaElement>('[data-local-editor-draft]');
        return {
          accepted,
          original: original.pendingText,
          successor: successor.pendingText,
          copy: copy?.value,
          originalSid: copy?.dataset.originalSessionId,
          readOnly: copy?.readOnly,
          blocked: appView._rawInputBlocked(sid),
          rows: app._unsavedInputDrafts.length,
        };
      }, sid)
    ).toEqual({
      accepted: false,
      original: 'original',
      successor: 'successor',
      copy: 'original',
      originalSid: sid,
      readOnly: true,
      blocked: false,
      rows: 1,
    });
    expect(writes.get(sid)).toEqual([]);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it('refused A prevents its dependent Enter from sending only appended B and retains both raw controls', async () => {
  const sid = 'actual-editor-refused-dependent',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    await p.addScriptTag({
      content: `window.reviewRawAction = (function(){${rawActionDeclaration} return retainRawAction;}).call(window.app);`,
    });
    expect(
      await p.evaluate(async (sid) => {
        type Overlay = { appendText(text: string): void; pendingText: string };
        const scope = window as unknown as Scope & {
          XtermZerolagInput: { ZerolagInputAddon: new () => Overlay };
          reviewRawAction(
            id: string,
            raw: string,
            action: (reservation: object, sid: string) => Promise<boolean>
          ): Promise<boolean>;
        };
        const app = scope.app as App & {
          _acceptTerminalDraftAction(
            id: string,
            suffix: string,
            modifiers?: boolean,
            reservation?: object
          ): Promise<boolean>;
        };
        const overlay = new scope.XtermZerolagInput.ZerolagInputAddon();
        overlay.appendText('A');
        Object.assign(app, { _localEchoEnabled: true, _localEchoOverlay: overlay });
        const journal = app._inputJournal as App['_inputJournal'] & { accept(...args: unknown[]): Promise<unknown> },
          accept = journal.accept.bind(journal);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((done) => {
            release = done;
          }),
          began = new Promise<void>((done) => {
            entered = done;
          });
        journal.accept = async (...args) => {
          entered();
          await gate;
          return accept(...args);
        };
        const first = scope.reviewRawAction(sid, '\r', (reservation, id) =>
          app._acceptTerminalDraftAction(id, '\r', false, reservation)
        );
        await began;
        overlay.appendText('B');
        const second = scope.reviewRawAction(sid, '\r', (reservation, id) =>
          app._acceptTerminalDraftAction(id, '\r', false, reservation)
        );
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
          const tx = transaction.apply(this, args);
          if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
          return tx;
        };
        release();
        return {
          accepted: await Promise.all([first, second]),
          draft: overlay.pendingText,
          retained: app._unsavedInputDrafts,
        };
      }, sid)
    ).toEqual({
      accepted: [false, false],
      draft: 'AB',
      retained: [
        { sid, text: '\r' },
        { sid, text: '\r' },
      ],
    });
    expect(writes.get(sid)).toEqual([]);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it('Clear completion cannot clear same-revision successor editor and raw owner after A to B to A', async () => {
  const sid = 'actual-clear-editor-aba',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        type Overlay = {
          appendText(text: string): void;
          setFlushed(count: number, text: string): void;
          pendingText: string;
          draftRevision: number;
        };
        const scope = window as unknown as Scope & { XtermZerolagInput: { ZerolagInputAddon: new () => Overlay } };
        const app = scope.app as App & { clearTerminalInput(): Promise<boolean | undefined> };
        const original = new scope.XtermZerolagInput.ZerolagInputAddon();
        original.appendText('original');
        original.setFlushed(1, 'x');
        const raw = app._createRawInputBuffer(sid);
        Object.assign(app, { _localEchoEnabled: true, _localEchoOverlay: original, _pendingInputOwner: raw });
        const journal = app._inputJournal as App['_inputJournal'] & { accept(...args: unknown[]): Promise<unknown> },
          accept = journal.accept.bind(journal);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((done) => {
            release = done;
          }),
          began = new Promise<void>((done) => {
            entered = done;
          });
        journal.accept = async (...args) => {
          entered();
          await gate;
          return accept(...args);
        };
        const clear = app.clearTerminalInput();
        await began;
        Object.assign(app, { activeSessionId: 'other' });
        const successor = new scope.XtermZerolagInput.ZerolagInputAddon();
        successor.appendText('successor');
        successor.setFlushed(1, 'y');
        Object.assign(app, {
          activeSessionId: sid,
          _localEchoOverlay: successor,
          _pendingInputOwner: app._createRawInputBuffer(sid),
        });
        release();
        const accepted = await clear;
        return {
          accepted: accepted === true,
          original: original.pendingText,
          successor: successor.pendingText,
          sameRevision: original.draftRevision === successor.draftRevision,
        };
      }, sid)
    ).toEqual({ accepted: false, original: 'original', successor: 'successor', sameRevision: true });
    await expect
      .poll(async () => {
        await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
        return writes.get(sid);
      })
      .toEqual(['\x7f']);
  } finally {
    await c.close();
  }
});

it.each(['flush', 'backspace', 'marker-replacement', 'composer-append', 'composer-replacement'] as const)(
  'editor receipts bind the actual flush/marker/composer owner during delayed acceptance: %s',
  async (mode) => {
    const sid = 'actual-editor-seam-' + mode,
      c = await context();
    subject(sid);
    try {
      const p = await page(c, sid);
      const result = await p.evaluate(
        async ({ sid, mode }) => {
          type Overlay = {
            appendText(text: string): void;
            pendingText: string;
            setFlushed(count: number, text: string): void;
            getFlushed(): { count: number; text: string };
          };
          const scope = window as unknown as Scope & {
            XtermZerolagInput: { ZerolagInputAddon: new () => Overlay };
            ReviewBar: { composePrompt(): Promise<unknown> };
          };
          const app = scope.app as App & {
            _flushLocalEchoTo(id: string): Promise<boolean>;
            _acceptOverlayBackspace(id: string, overlay: Overlay): Promise<boolean>;
            _acceptTerminalDraftAction(id: string, suffix: string): Promise<boolean>;
          };
          const overlay = new scope.XtermZerolagInput.ZerolagInputAddon();
          if (mode === 'flush' || mode.startsWith('composer')) overlay.appendText('A');
          if (mode !== 'flush') overlay.setFlushed(1, 'X');
          Object.assign(app, {
            _localEchoEnabled: true,
            _localEchoOverlay: overlay,
            _pendingInputOwner: app._createRawInputBuffer(sid),
          });
          const journal = app._inputJournal as App['_inputJournal'] & { accept(...args: unknown[]): Promise<unknown> },
            accept = journal.accept.bind(journal);
          let release!: () => void,
            entered!: () => void,
            first = true;
          const gate = new Promise<void>((done) => {
              release = done;
            }),
            began = new Promise<void>((done) => {
              entered = done;
            });
          journal.accept = async (...args) => {
            if (first) {
              first = false;
              entered();
              await gate;
            }
            return accept(...args);
          };
          const pending =
            mode === 'flush'
              ? app._flushLocalEchoTo(sid)
              : mode.startsWith('composer')
                ? scope.ReviewBar.composePrompt()
                : app._acceptOverlayBackspace(sid, overlay);
          await began;
          let successor: Overlay | null = null;
          if (mode === 'marker-replacement') overlay.setFlushed(1, 'X');
          else if (mode === 'composer-replacement') {
            successor = new scope.XtermZerolagInput.ZerolagInputAddon();
            successor.appendText('successor');
            successor.setFlushed(1, 'Y');
            Object.assign(app, { _localEchoOverlay: successor, _pendingInputOwner: app._createRawInputBuffer(sid) });
          } else overlay.appendText('B');
          release();
          const accepted = await pending;
          const before = {
            draft: overlay.pendingText,
            flushed: overlay.getFlushed(),
            dialogs: document.querySelectorAll('.prompt-composer-overlay').length,
          };
          journal.accept = accept;
          let retry: unknown;
          if (mode === 'flush') retry = await app._flushLocalEchoTo(sid);
          else if (mode === 'backspace') retry = await app._acceptTerminalDraftAction(sid, '\r');
          else if (mode === 'composer-append') await scope.ReviewBar.composePrompt();
          return {
            accepted: accepted === true,
            before,
            retry: retry === true,
            after: overlay.pendingText,
            successor: successor?.pendingText,
            successorFlushed: successor?.getFlushed(),
            composer: document.querySelector<HTMLTextAreaElement>('.prompt-composer-textarea')?.value,
            recovered: app._unsavedInputDrafts,
            copy: document.querySelector<HTMLTextAreaElement>('[data-local-editor-draft]')?.value,
          };
        },
        { sid, mode }
      );
      if (mode === 'flush') {
        expect(result).toMatchObject({
          accepted: false,
          before: { draft: 'B', flushed: { count: 1, text: 'A' } },
          retry: true,
          after: '',
        });
        await expect
          .poll(async () => {
            await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
            return writes.get(sid);
          })
          .toEqual(['A', 'B']);
        expect(await p.evaluate(async (sid) => (window as unknown as Scope).app._confirmOverlayInput(sid), sid)).toBe(
          true
        );
      } else if (mode === 'backspace') {
        expect(result).toMatchObject({
          accepted: true,
          before: { draft: 'B', flushed: { count: 0, text: '' } },
          retry: true,
          after: '',
        });
        await expect
          .poll(async () => {
            await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
            return writes.get(sid);
          })
          .toEqual(['\x7f', 'B', '\r']);
      } else if (mode === 'marker-replacement') {
        expect(result).toMatchObject({
          accepted: true,
          before: { draft: '', flushed: { count: 1, text: 'X' } },
          after: '',
        });
        await expect.poll(() => writes.get(sid)).toEqual(['\x7f']);
      } else if (mode === 'composer-append') {
        expect(result).toMatchObject({
          before: { draft: 'AB', flushed: { count: 0, text: '' }, dialogs: 0 },
          after: '',
          composer: 'AB',
          recovered: [{ sid, text: 'XA', kind: 'local-draft' }],
          copy: 'XA',
        });
        await expect.poll(() => writes.get(sid)).toEqual(['\x7f']);
      } else {
        expect(result).toMatchObject({
          before: { draft: 'A', flushed: { count: 0, text: '' }, dialogs: 0 },
          after: 'A',
          successor: 'successor',
          successorFlushed: { count: 1, text: 'Y' },
          recovered: [{ sid, text: 'XA', kind: 'local-draft' }],
          copy: 'XA',
        });
        expect(result.composer).toBeUndefined();
        await expect.poll(() => writes.get(sid)).toEqual(['\x7f']);
        await assertRecoveredLayout(p, 'recovered-original-transfer');
        expect(await p.locator('[data-local-editor-draft]').inputValue()).toBe('XA');
        expect(
          await p.evaluate(
            () =>
              ((window as unknown as Scope).app as App & { _localEchoOverlay: { pendingText: string } })
                ._localEchoOverlay.pendingText
          )
        ).toBe('successor');
      }
    } finally {
      await c.close();
    }
  }
);

it('Enter waits for its original flush and consumes its causal marker before a later prompt is cleared', async () => {
  const sid = 'actual-causal-flush-enter',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(async (sid) => {
        type Overlay = {
          appendText(text: string): void;
          pendingText: string;
          getFlushed(): { count: number; text: string };
        };
        const scope = window as unknown as Scope & { XtermZerolagInput: { ZerolagInputAddon: new () => Overlay } };
        const app = scope.app as App & {
          _flushLocalEchoTo(id: string): Promise<boolean>;
          _acceptTerminalDraftAction(id: string, suffix: string): Promise<boolean>;
          clearTerminalInput(): Promise<boolean>;
        };
        const overlay = new scope.XtermZerolagInput.ZerolagInputAddon();
        overlay.appendText('A');
        Object.assign(app, { _localEchoEnabled: true, _localEchoOverlay: overlay });
        const journal = app._inputJournal as App['_inputJournal'] & { accept(...args: unknown[]): Promise<unknown> },
          accept = journal.accept.bind(journal);
        let releaseFlush!: () => void,
          enteredFlush!: () => void,
          releaseEnter!: () => void,
          enteredEnter!: () => void,
          call = 0;
        const flushGate = new Promise<void>((done) => {
            releaseFlush = done;
          }),
          flushBegan = new Promise<void>((done) => {
            enteredFlush = done;
          });
        const enterGate = new Promise<void>((done) => {
            releaseEnter = done;
          }),
          enterBegan = new Promise<void>((done) => {
            enteredEnter = done;
          });
        journal.accept = async (...args) => {
          const current = ++call;
          if (current === 1) {
            enteredFlush();
            await flushGate;
          }
          if (current === 2) {
            enteredEnter();
            await enterGate;
          }
          return accept(...args);
        };
        const flush = app._flushLocalEchoTo(sid);
        await flushBegan;
        const enter = app._acceptTerminalDraftAction(sid, '\r');
        releaseFlush();
        await enterBegan;
        overlay.appendText('B');
        releaseEnter();
        const accepted = await Promise.all([flush, enter]);
        const nextDraft = overlay.pendingText,
          submittedMarker = overlay.getFlushed();
        journal.accept = accept;
        const nextAccepted = await app._flushLocalEchoTo(sid),
          nextMarker = overlay.getFlushed();
        const cleared = await app.clearTerminalInput();
        return {
          accepted,
          nextDraft,
          submittedMarker,
          nextAccepted,
          nextMarker,
          cleared,
          retained: app._unsavedInputDrafts,
        };
      }, sid)
    ).toEqual({
      accepted: [true, true],
      nextDraft: 'B',
      submittedMarker: { count: 0, text: '' },
      nextAccepted: true,
      nextMarker: { count: 1, text: 'B' },
      cleared: true,
      retained: [],
    });
    await expect
      .poll(async () => {
        await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
        return writes.get(sid);
      })
      .toEqual(['A', '\r', 'B', '\x7f']);
    expect(posts.filter((row) => row.sid === sid).map((row) => row.input)).toEqual(['A', '\r', 'B', '\x7f']);
  } finally {
    await c.close();
  }
});

it('a genuine detached editor copy is deduplicated by its private receipt and stays readable across navigation', async () => {
  const sid = 'original-editor-copy',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate((sid) => {
        type Overlay = { appendText(text: string): void; claimPendingDraft(): { text: string; revision: number } };
        const scope = window as unknown as Scope & { XtermZerolagInput: { ZerolagInputAddon: new () => Overlay } };
        const editor = new scope.XtermZerolagInput.ZerolagInputAddon();
        editor.appendText('Recovered 😀 original draft');
        const receipt = editor.claimPendingDraft();
        const app = scope.app as App & {
          _retainEditorDraft(id: string, editor: Overlay, receipt: object): void;
          _renderInputRecoveryBanner(): void;
          _rawInputBlocked(id: string): boolean;
          activeSessionId: string;
          sessions: Map<string, object>;
        };
        app._retainEditorDraft(sid, editor, receipt);
        app._retainEditorDraft(sid, editor, receipt);
        app._retainEditorDraft(sid, editor, { ...receipt });
        app.sessions.set('new-editor', { id: 'new-editor' });
        app.activeSessionId = 'new-editor';
        app._renderInputRecoveryBanner();
        const field = document.querySelector<HTMLTextAreaElement>('[data-local-editor-draft]');
        return {
          copies: app._unsavedInputDrafts.length,
          value: field?.value,
          readOnly: field?.readOnly,
          originalSid: field?.dataset.originalSessionId,
          blocked: app._rawInputBlocked('new-editor'),
        };
      }, sid)
    ).toEqual({ copies: 1, value: 'Recovered 😀 original draft', readOnly: true, originalSid: sid, blocked: false });
    await assertRecoveredLayout(p, 'recovered-local-draft');
    expect(writes.get(sid)).toEqual([]);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it('an actual storage abort preserves the draft and performs no input POST or Session write', async () => {
  const sid = 'actual-storage-abort';
  subject(sid);
  const c = await context();
  try {
    const p = await page(c, sid);
    await p.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
        const tx = original.apply(this, args);
        if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
        return tx;
      };
    });
    expect(
      await p.evaluate(async (sid) => {
        const owner = (window as unknown as Scope).app._createRawInputBuffer(sid);
        owner.append('draft that must remain visible');
        return owner.flush();
      }, sid)
    ).toBe(false);
    expect(writes.get(sid)).toEqual([]);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
    expect(await p.locator('[data-unqueued-input]').inputValue()).toBe('draft that must remain visible');
  } finally {
    await c.close();
  }
});

it('a lost successful HTTP response is held and never turns into another input POST', async () => {
  const sid = 'actual-lost-response';
  subject(sid);
  const c = await context();
  try {
    const p = await page(c, sid);
    await p.route(`**/api/sessions/${sid}/input`, async (route) => {
      await route.fetch();
      await route.abort();
    });
    expect(await send(p, sid, 'one possible effect')).toBe(true);
    await expect.poll(() => writes.get(sid)).toEqual(['one possible effect']);
    await expect
      .poll(() => p.evaluate((sid) => (window as unknown as Scope).app._inputRecoveryHolds?.has(sid), sid))
      .toBe(true);
    await p.evaluate(() => (window as unknown as Scope).app._redeliverSweep());
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
    await p.close();
    const restored = await page(c, sid);
    expect(await send(restored, sid, 'must not replay or retag')).toBe(false);
    expect(writes.get(sid)).toEqual(['one possible effect']);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
  } finally {
    await c.close();
  }
});

it('the actual browser SHA agrees with the server for omitted, mux and explicit raw choices', async () => {
  const sid = 'actual-sha-parity';
  subject(sid);
  const c = await context();
  try {
    const p = await page(c, sid);
    const records = await p.evaluate(async (sid) => {
      const scope = window as unknown as Scope;
      const journal = scope.app._inputJournal as unknown as {
        accept(sid: string, frames: string[], mux: boolean | null): Promise<{ records: RecordRow[] }>;
      };
      const result = [];
      for (const mode of [null, true, false]) result.push((await journal.accept(sid, ['text\r'], mode)).records[0]);
      return result;
    }, sid);
    for (const record of records)
      expect(record.fingerprint).toBe(
        terminalInputFingerprint({ input: record.data, ...(record.useMux === null ? {} : { useMux: record.useMux }) })
      );
    expect(new Set(records.map((row) => row.fingerprint)).size).toBe(3);
    expect(posts.filter((row) => row.sid === sid)).toEqual([]);
  } finally {
    await c.close();
  }
});

it('pending uses only receipt GET until the original actual mux attempt confirms once', async () => {
  const sid = 'actual-pending-receipt',
    session = subject(sid),
    c = await context();
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (text, options) => {
    await pending;
    return session.write(text, options);
  });
  try {
    const p = await page(c, sid);
    expect(
      await p.evaluate(
        (sid) => (window as unknown as Scope).app._sendInputAsync(sid, 'original async text', { useMux: true }),
        sid
      )
    ).toBe(true);
    await expect.poll(() => posts.filter((row) => row.sid === sid).length).toBe(1);
    await expect
      .poll(() => p.evaluate((sid) => (window as unknown as Scope).app._pendingDeliveries.get(sid)?.[0]?.phase, sid))
      .toBe('pending');
    expect(await send(p, sid, 'later text')).toBe(true);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
    expect(writes.get(sid)).toEqual([]);
    await p.waitForTimeout(1050);
    await p.evaluate((sid) => (window as unknown as Scope).app._drainSession(sid), sid);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
    expect(mux).toHaveBeenCalledOnce();
    release();
    await expect.poll(() => writes.get(sid)).toEqual(['original async text']);
    await p.waitForTimeout(1050);
    await p.evaluate((sid) => (window as unknown as Scope).app._drainSession(sid), sid);
    await expect.poll(() => posts.filter((row) => row.sid === sid).length).toBe(2);
    await expect.poll(() => writes.get(sid)).toEqual(['original async text', 'later text']);
    expect(mux).toHaveBeenCalledOnce();
  } finally {
    release();
    mux.mockRestore();
    await c.close();
  }
});

it('actual CJK keeps a same-text replacement draft and newly rearmed Ctrl when an older storage acceptance finishes', async () => {
  const sid = 'actual-cjk-aba';
  subject(sid);
  const c = await context();
  try {
    const p = await page(c, sid);
    await p.evaluate(() => {
      const scope = window as unknown as {
        app: App & { _handleCjkInput(text: string): Promise<boolean> };
        ReviewCjk: { init(options: { send: (text: string) => Promise<boolean> }): void };
        ReviewBar: { _setCtrl(value: boolean): void };
        releaseAcceptance?: () => void;
        acceptanceWaiting?: boolean;
      };
      const journal = scope.app._inputJournal as unknown as { accept: (...args: unknown[]) => Promise<unknown> };
      const original = journal.accept.bind(journal);
      journal.accept = async (...args) => {
        const result = await original(...args);
        scope.acceptanceWaiting = true;
        await new Promise<void>((done) => {
          scope.releaseAcceptance = done;
        });
        return result;
      };
      scope.ReviewCjk.init({ send: (text) => scope.app._handleCjkInput(text) });
      scope.ReviewBar._setCtrl(true);
      const field = document.getElementById('cjkInput') as HTMLTextAreaElement;
      field.value = 'a';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'a', bubbles: true }));
    });
    await p.waitForFunction(() => (window as unknown as { acceptanceWaiting: boolean }).acceptanceWaiting);
    expect(await p.locator('#cjkInput').inputValue()).toBe('a');
    await p.evaluate(() => {
      const field = document.getElementById('cjkInput') as HTMLTextAreaElement;
      field.value = '';
      field.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
      field.value = 'a';
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'a', bubbles: true }));
      const scope = window as unknown as { ReviewBar: { _setCtrl(value: boolean): void }; releaseAcceptance(): void };
      scope.ReviewBar._setCtrl(false);
      scope.ReviewBar._setCtrl(true);
      scope.releaseAcceptance();
    });
    await expect.poll(() => posts.filter((row) => row.sid === sid).length).toBe(1);
    expect(await p.locator('#cjkInput').inputValue()).toBe('a');
    expect(
      await p.evaluate(() => (window as unknown as { ReviewBar: { isCtrlArmed(): boolean } }).ReviewBar.isCtrlArmed())
    ).toBe(true);
    expect(posts.filter((row) => row.sid === sid)[0].input).toBe('\x01');
    await p.waitForTimeout(300);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
  } finally {
    await c.close();
  }
});

it('an unchanged real CJK draft clears only after durable acceptance, while failure preserves it and Ctrl', async () => {
  const sid = 'actual-cjk-acceptance',
    c = await context();
  subject(sid);
  try {
    const p = await page(c, sid);
    await p.evaluate(() => {
      const s = window as unknown as {
        app: { _handleCjkInput(text: string): Promise<boolean> };
        ReviewCjk: { init(options: { send(text: string): Promise<boolean> }): void };
      };
      s.ReviewCjk.init({ send: (text) => s.app._handleCjkInput(text) });
      const field = document.getElementById('cjkInput') as HTMLTextAreaElement;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
      field.value = 'x';
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true }));
    });
    await expect.poll(() => p.locator('#cjkInput').inputValue()).toBe('\u200b');
    await expect.poll(() => writes.get(sid)).toEqual(['x']);
    await p.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
        const tx = original.apply(this, args);
        if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
        return tx;
      };
      (window as unknown as { ReviewBar: { _setCtrl(value: boolean): void } }).ReviewBar._setCtrl(true);
      const field = document.getElementById('cjkInput') as HTMLTextAreaElement;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      field.value = 'a';
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'a', bubbles: true }));
    });
    await expect.poll(() => p.evaluate(() => (window as unknown as Scope).app._inputStorageUnavailable)).toBe(true);
    expect(await p.locator('[data-unqueued-input]').count()).toBe(0);
    expect(await p.locator('#cjkInput').inputValue()).toBe('a');
    expect(
      await p.evaluate(() => (window as unknown as { ReviewBar: { isCtrlArmed(): boolean } }).ReviewBar.isCtrlArmed())
    ).toBe(true);
    expect(writes.get(sid)).toEqual(['x']);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
  } finally {
    await c.close();
  }
});

it.each([
  [320, 'throw'],
  [390, 'ignored'],
  [1280, 'throw'],
] as const)(
  'strict storage failure remains visible and preserves the first raw event at width%s (%s)',
  async (width, mode) => {
    const sid = `actual-strict-storage-${width}`,
      c = await context();
    subject(sid);
    try {
      const p = await page(c, sid),
        errors: string[] = [];
      p.on('pageerror', (error) => errors.push(error.message));
      await p.setViewportSize({ width, height: 800 });
      await p.addStyleTag({ content: readFileSync(join(publicRoot, 'styles.css'), 'utf8') });
      await p.addStyleTag({ content: readFileSync(join(publicRoot, 'vendor/xterm.css'), 'utf8') });
      expect(
        await p.evaluate(
          async ({ mode, sid }) => {
            type Terminal = {
              options: { disableStdin: boolean };
              open(element: HTMLElement): void;
              input(text: string, user: boolean): void;
              onData(callback: (text: string) => void): void;
            };
            const s = window as unknown as Scope & {
              Terminal: new () => Terminal;
              rawAccepted?: Promise<boolean>;
              rawEvents: number;
              transactionModes: string[];
            };
            const terminal = new s.Terminal();
            Object.assign(s.app, { terminal });
            terminal.open(document.getElementById('fixtureTerminal')!);
            s.rawEvents = 0;
            s.transactionModes = [];
            terminal.onData((text) => {
              s.rawEvents++;
              const owner = s.app._createRawInputBuffer(sid);
              owner.append(text);
              s.rawAccepted = owner.flush();
            });
            const field = document.getElementById('cjkInput') as HTMLTextAreaElement;
            field.value = 'Editable IME draft remains here';
            const original = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
              s.transactionModes.push(args[2]?.durability || 'default');
              if (args[1] === 'readwrite') {
                if (mode === 'throw') throw new DOMException('Strict storage unavailable', 'NotSupportedError');
                return original.call(this, args[0], args[1]);
              }
              return original.apply(this, args);
            };
            terminal.input('First raw draft — retain 😀 exactly', true);
            return await s.rawAccepted;
          },
          { mode, sid }
        )
      ).toBe(false);
      await expect
        .poll(() => p.locator('[data-unqueued-input]').inputValue())
        .toBe('First raw draft — retain 😀 exactly');
      expect(await p.locator('#inputRecoveryBar').isVisible()).toBe(true);
      expect(await p.locator('#inputRecoveryBar').textContent()).toContain('storage unavailable');
      expect(await p.locator('#cjkInput').inputValue()).toBe('Editable IME draft remains here');
      expect(
        await p.evaluate(() => {
          const s = window as unknown as Scope & { rawEvents: number; transactionModes: string[] };
          const terminal = (
            s.app as unknown as {
              terminal: { options: { disableStdin: boolean }; input(text: string, user: boolean): void };
            }
          ).terminal;
          terminal.input('must not create another raw event', true);
          for (let count = 0; count < 100; count++)
            (s.app as unknown as { _handleCjkInput(text: string): boolean })._handleCjkInput('still editable');
          return {
            disabled: terminal.options.disableStdin,
            events: s.rawEvents,
            strictOnly: s.transactionModes.every((mode) => mode === 'strict'),
            retainedEvents: s.app._unsavedInputDrafts.length,
          };
        })
      ).toEqual({ disabled: true, events: 1, strictOnly: true, retainedEvents: 1 });
      expect(writes.get(sid)).toEqual([]);
      expect(posts.filter((row) => row.sid === sid)).toEqual([]);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const bounds = await p.locator('[data-unqueued-input]').boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      if (process.env.TEST_INPUT_JOURNAL_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_INPUT_JOURNAL_SCREENSHOT_DIR, { recursive: true });
        await p.screenshot({
          path: join(process.env.TEST_INPUT_JOURNAL_SCREENSHOT_DIR, `storage-failure-${width}.png`),
        });
      }
      expect(errors).toEqual([]);
    } finally {
      await c.close();
    }
  }
);

it('a separate physical key waits for genuine overlay delivery, not storage acceptance or a timer', async () => {
  const sid = 'actual-overlay-key-order',
    session = subject(sid),
    c = await context();
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (text, options) => {
    await pending;
    return session.write(text, options);
  });
  const keys: string[] = [];
  try {
    const p = await page(c, sid);
    // This physical-key endpoint remains outside journal/native acceptance.
    // Intercept it so the test can prove ordering without invoking any tmux.
    await p.route(`**/api/sessions/${sid}/send-key`, (route) => {
      keys.push(route.request().postDataJSON().key as string);
      return route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    });
    await p.evaluate(() => {
      const s = window as unknown as {
        app: Record<string, unknown>;
        XtermZerolagInput: { ZerolagInputAddon: new () => { appendText(text: string): void } };
      };
      s.app._localEchoEnabled = true;
      const overlay = new s.XtermZerolagInput.ZerolagInputAddon();
      overlay.appendText('original overlay text\r');
      s.app._localEchoOverlay = overlay;
    });
    const key = () =>
      p.evaluate(() =>
        (window as unknown as { app: { _sendModifiedEnter(key: string): Promise<boolean> } }).app._sendModifiedEnter(
          'S-Enter'
        )
      );
    expect(await key()).toBe(false);
    expect(keys).toEqual([]);
    expect(writes.get(sid)).toEqual([]);
    await expect.poll(() => posts.filter((row) => row.sid === sid).length).toBe(1);
    release();
    await expect.poll(() => writes.get(sid)).toEqual(['original overlay text\r']);
    await expect
      .poll(() => p.evaluate((sid) => (window as unknown as Scope).app._pendingDeliveries.get(sid)?.length || 0, sid))
      .toBe(0);
    expect(await key()).toBe(true);
    expect(keys).toEqual(['S-Enter']);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
  } finally {
    release();
    mux.mockRestore();
    await c.close();
  }
});

/** Diagnostic RED cases only; not production deadlines or acceptance waivers. */
async function custodyTrace(name: string, facts: object) {
  const directory = process.env.TEST_INPUT_CUSTODY_REPRO_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name + '.json'), JSON.stringify(facts, null, 2) + '\n');
}

async function settleCustodyFixture(...steps: Array<() => Promise<unknown>>) {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned browser custody fixture cleanup is unconfirmed');
}

it('known storage acceptance is displayed separately while the original status refresh remains pending', async () => {
  const sid = 'stored-original-refresh-pending',
    c = await context();
  subject(sid);
  const p = await page(c, sid);
  try {
    await p.clock.install();
    await p.evaluate((sid) => {
      type AppWithRefresh = App & { _refreshInputJournal(): Promise<void> };
      const scope = window as unknown as Scope & {
        refreshProbe?: { entered: boolean; settled: boolean; release(): void; restore(): void; task: Promise<boolean> };
      };
      const app = scope.app as AppWithRefresh;
      const original = app._refreshInputJournal.bind(app);
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const probe = {
        entered: false,
        settled: false,
        release,
        restore: () => {
          app._refreshInputJournal = original;
        },
        task: Promise.resolve(false),
      };
      scope.refreshProbe = probe;
      app._refreshInputJournal = async () => {
        probe.entered = true;
        await gate;
        await original();
      };
      probe.task = app._sendInputAsync(sid, 'stored once').then((accepted) => {
        probe.settled = true;
        return accepted;
      });
    }, sid);
    await p.waitForFunction(() => (window as unknown as { refreshProbe: { entered: boolean } }).refreshProbe.entered);
    await p.clock.fastForward(10000);
    await expect
      .poll(() => p.locator('[data-input-acceptance-pending]').textContent())
      .toContain('Local input stored — status refresh is still pending');
    expect(await p.locator('[data-input-acceptance-pending]').textContent()).not.toContain(
      'acceptance is still pending'
    );
    expect(
      await p.evaluate(async () => {
        const scope = window as unknown as Scope & { refreshProbe: { settled: boolean } };
        return {
          settled: scope.refreshProbe.settled,
          stored: (await scope.app._inputJournal.snapshot()).records.map((row) => row.data),
        };
      })
    ).toEqual({ settled: false, stored: ['stored once'] });
    expect(writes.get(sid)).toEqual([]);
    await assertRecoveredLayout(p, 'stored-status-refresh-pending', '[data-input-acceptance-pending]');
    expect(
      await p.evaluate(async (sid) => {
        const scope = window as unknown as Scope & {
          refreshProbe: { release(): void; task: Promise<boolean>; restore(): void };
        };
        scope.refreshProbe.release();
        const accepted = await scope.refreshProbe.task;
        await scope.app._drainSession(sid);
        scope.refreshProbe.restore();
        return accepted;
      }, sid)
    ).toBe(true);
    expect(writes.get(sid)).toEqual(['stored once']);
    expect(posts.filter((row) => row.sid === sid)).toHaveLength(1);
  } finally {
    await settleCustodyFixture(
      async () => {
        if (!p.isClosed())
          await p.evaluate(async () => {
            const probe = (
              window as unknown as { refreshProbe?: { release(): void; task: Promise<boolean>; restore(): void } }
            ).refreshProbe;
            if (!probe) return;
            probe.release();
            await Promise.allSettled([probe.task]);
            probe.restore();
          });
      },
      () => c.close()
    );
  }
});

it('a real queued WebLock keeps original acceptance pending while shared raw intake stops at its capacity', async () => {
  const sid = 'custody-held-dispatch',
    c = await context();
  subject(sid);
  let p: Page | undefined, blocker: Page | undefined;
  let observed:
    | {
        bytes: number;
        allAppendsAccepted: boolean;
        status: string;
        originalSha256: string;
        errorVisible: boolean;
        nativePendingLocks: number;
        overflowCopies: number;
        laterRawAccepted: boolean;
      }
    | undefined;
  let cleanup:
    | {
        settled: string[];
        status?: string;
        retainedChars: number;
        rawOwnerChars?: number;
        retainedSha256: string;
        nativePendingLocks: number;
        nativeHeldLocks: number;
      }
    | undefined;
  try {
    p = await page(c, sid);
    blocker = await c.newPage();
    await blocker.goto(origin);
    await blocker.evaluate(() => {
      const scope = window as unknown as {
        releaseLock?: () => void;
        heldLock?: Promise<unknown>;
        lockAcquired?: boolean;
      };
      const gate = new Promise<void>((done) => {
        scope.releaseLock = done;
      });
      scope.heldLock = navigator.locks.request('reverie-input-journal-v2:dispatch', { mode: 'exclusive' }, async () => {
        scope.lockAcquired = true;
        await gate;
      });
    });
    await blocker.waitForFunction(() => (window as unknown as { lockAcquired?: boolean }).lockAcquired === true);
    await p.evaluate(async (sid) => {
      const app = (window as unknown as Scope).app;
      if (!(await app._sendInputAsync(sid, 'S'))) throw new Error('Seed storage did not accept');
    }, sid);
    await expect
      .poll(() =>
        p!.evaluate(
          async () =>
            (await navigator.locks.query()).pending?.filter((lock) => lock.name === 'reverie-input-journal-v2:dispatch')
              .length || 0
        )
      )
      .toBeGreaterThan(0);
    observed = await p.evaluate(async (sid) => {
      type Owner = ReturnType<App['_createRawInputBuffer']>;
      const scope = window as unknown as Scope & {
        rawProbe?: { owner: Owner; pending: Promise<unknown>; status: string };
      };
      const app = scope.app;
      const owner = app._createRawInputBuffer(sid);
      const frame = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(65536));
        for (let i = 0; i < bytes.length; i++) bytes[i] = 32 + (bytes[i] % 95);
        return new TextDecoder().decode(bytes);
      };
      owner.append(frame().slice(1));
      const probe: NonNullable<typeof scope.rawProbe> = (scope.rawProbe = {
        owner,
        status: 'pending',
        pending: Promise.resolve(),
      });
      probe.pending = owner.flush().then((value) => {
        probe.status = value ? 'accepted' : 'refused';
        return value;
      });
      let allAppendsAccepted = true,
        received = owner.data;
      // Including the one-character seed, exactly 4MiB plus one64KiB ASCII frame.
      for (let i = 0; i < 64; i++) {
        const event = frame();
        received += event;
        allAppendsAccepted = owner.append(event) && allAppendsAccepted;
      }
      const laterRawAccepted = app._createRawInputBuffer('later-original-session').append('must remain blocked');
      return {
        bytes: owner.data.length,
        allAppendsAccepted,
        status: probe.status,
        originalSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(received)))]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
        errorVisible:
          app._inputStorageUnavailable === true || document.getElementById('inputRecoveryBar')?.hidden === false,
        nativePendingLocks: 0,
        overflowCopies: app._unsavedInputDrafts.length,
        laterRawAccepted,
      };
    }, sid);
    observed.nativePendingLocks = await p.evaluate(
      async () =>
        (await navigator.locks.query()).pending?.filter((lock) => lock.name === 'reverie-input-journal-v2:dispatch')
          .length || 0
    );
    await expect.poll(() => p!.locator('[data-input-acceptance-pending]').isVisible(), { timeout: 15000 }).toBe(true);
    expect(
      await p.evaluate(() => (window as unknown as Scope & { rawProbe: { status: string } }).rawProbe.status)
    ).toBe('pending');
    expect(writes.get(sid)).toEqual([]);
    await assertRecoveredLayout(
      p,
      'acceptance-pending-and-overflow',
      '[data-input-acceptance-pending], [data-unqueued-input]'
    );
  } finally {
    await settleCustodyFixture(
      async () => {
        if (p && !p.isClosed())
          await p.evaluate(() => {
            const app = (window as unknown as Scope).app as App & {
              _inputJournal: App['_inputJournal'] & { close(): void };
            };
            app._inputJournal.close();
          });
      },
      async () => {
        if (blocker && !blocker.isClosed())
          await blocker.evaluate(async () => {
            const s = window as unknown as { releaseLock?: () => void; heldLock?: Promise<unknown> };
            s.releaseLock?.();
            await s.heldLock;
          });
      },
      async () => {
        if (p && !p.isClosed())
          cleanup = await p.evaluate(async (sid) => {
            const s = window as unknown as Scope & {
              rawProbe?: { owner: ReturnType<App['_createRawInputBuffer']>; pending: Promise<unknown>; status: string };
            };
            const app = s.app as App & { _inputDrainTasks: Map<string, Promise<unknown>> };
            const settled = await Promise.allSettled([s.rawProbe?.pending, app._inputDrainTasks.get(sid)]);
            const retained = app._unsavedInputDrafts.map((row) => row.text).join('');
            const locks = await navigator.locks.query();
            return {
              settled: settled.map((item) => item.status),
              status: s.rawProbe?.status,
              retainedChars: app._unsavedInputDrafts.reduce((n, row) => n + row.text.length, 0),
              rawOwnerChars: s.rawProbe?.owner.data.length,
              retainedSha256: [
                ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(retained))),
              ]
                .map((value) => value.toString(16).padStart(2, '0'))
                .join(''),
              nativePendingLocks: locks.pending?.length || 0,
              nativeHeldLocks: locks.held?.length || 0,
            };
          }, sid);
      },
      () => c.close()
    );
  }
  await custodyTrace('held-dispatch-buffer', {
    observed,
    cleanup,
    sessionWrites: writes.get(sid)?.length,
    qualification: 'Real lock held by second page; sample is pending-until-release, not a fake product timeout.',
  });
  expect(observed?.nativePendingLocks).toBeGreaterThan(0);
  expect(observed).toMatchObject({
    allAppendsAccepted: false,
    errorVisible: true,
    overflowCopies: 1,
    laterRawAccepted: false,
  });
  expect(cleanup?.retainedSha256).toBe(observed?.originalSha256);
  expect(cleanup).toMatchObject({
    settled: ['fulfilled', 'fulfilled'],
    status: 'refused',
    rawOwnerChars: 0,
    nativePendingLocks: 0,
    nativeHeldLocks: 0,
  });
  expect(writes.get(sid)).toEqual([]);
  expect(observed?.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

it.each(['commit', 'abort'] as const)(
  'the original native IDB %s settles pending acceptance without a timer inventing cancellation',
  async (outcome) => {
    const sid = 'custody-original-postwrite-' + outcome,
      c = await context();
    subject(sid);
    let originalPage: Page | undefined;
    type Identity = { version: number; kind: string; scopeId: string; epoch: number };
    let before: unknown;
    let completion:
      | {
          kind: string;
          nativeOutcome: string;
          originalIssuer: string;
          records?: RecordRow[];
          closedBeforeCommit: boolean;
          identity: Identity;
          oldAdmitted: boolean;
          oldClaimReason: string;
          oldDispatched: boolean;
          oldEffects: number;
        }
      | undefined;
    let restoration:
      | {
          rows: Array<{ sid: string; issuer: string; seq: number; phase: string; chars: number }>;
          holds: object[];
          sameIdentity: boolean;
          freshIssuer: string;
        }
      | undefined;
    let oldPageWrites = -1;
    try {
      originalPage = await page(c, sid);
      // Only the notice clock is controlled; the original IDB request/transaction remain native.
      // The separate queued-WebLock case proves the real ten-second wall-clock notice.
      await originalPage.clock.install();
      await originalPage.evaluate((sid) => {
        type NativeProbe = {
          release(): void;
          abort(): void;
          done?: Promise<void>;
          accept?: Promise<{ kind: string; records?: RecordRow[] }>;
          bodyAdded: boolean;
          complete: boolean;
          guardReached: boolean;
          closed: boolean;
          settled: boolean;
          outcome: string;
          requests: number;
          restore(): void;
        };
        const scope = window as unknown as Scope & { nativeProbe?: NativeProbe };
        const transaction = IDBDatabase.prototype.transaction,
          add = IDBObjectStore.prototype.add;
        let held: IDBTransaction | null = null,
          keep = true;
        const end = performance.now() + 30000;
        const probe: NativeProbe = (scope.nativeProbe = {
          release: () => {
            keep = false;
          },
          abort: () => {
            held?.abort();
          },
          bodyAdded: false,
          complete: false,
          guardReached: false,
          closed: false,
          settled: false,
          outcome: 'pending',
          requests: 0,
          restore: () => {
            IDBDatabase.prototype.transaction = transaction;
            IDBObjectStore.prototype.add = add;
          },
        });
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
          const tx = transaction.apply(this, args);
          if (!held && args[1] === 'readwrite' && this.name === 'reverie-input-journal-v2') {
            held = tx;
            probe.done = new Promise<void>((done) => {
              tx.addEventListener('complete', () => {
                probe.complete = true;
                probe.outcome = 'commit';
                done();
              });
              tx.addEventListener('abort', () => {
                probe.outcome = 'abort';
                done();
              });
            });
            const store = tx.objectStore('records');
            const hold = () => {
              const request = store.get('owned-no-record');
              probe.requests++;
              request.addEventListener('success', () => {
                if (keep && performance.now() < end && probe.requests < 100000) hold();
                else if (keep) probe.guardReached = true;
              });
            };
            hold();
          }
          return tx;
        };
        IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
          const request = add.call(this, value, key);
          if (
            this.transaction === held &&
            this.name === 'records' &&
            value &&
            typeof value === 'object' &&
            'sid' in value &&
            value.sid === sid
          )
            request.addEventListener('success', () => {
              probe.bodyAdded = true;
            });
          return request;
        };
        const journal = scope.app._inputJournal as App['_inputJournal'] & {
          accept(sid: string, frames: string[]): Promise<{ kind: string; records?: RecordRow[] }>;
        };
        probe.accept = journal.accept(sid, ['original local input before close']).then((result) => {
          probe.settled = true;
          return result;
        });
      }, sid);
      await originalPage.waitForFunction(
        () => (window as unknown as { nativeProbe: { bodyAdded: boolean } }).nativeProbe.bodyAdded
      );
      await originalPage.clock.fastForward(10000);
      await expect
        .poll(
          async () => {
            const state = await originalPage!.evaluate(() => {
              const scope = window as unknown as {
                nativeProbe: { settled: boolean; complete: boolean; guardReached: boolean; requests: number };
                ReverieInputJournal: { intake: { snapshot(): { pending: object[] } } };
              };
              return {
                settled: scope.nativeProbe.settled,
                complete: scope.nativeProbe.complete,
                guardReached: scope.nativeProbe.guardReached,
                requests: scope.nativeProbe.requests,
                pendingOwners: scope.ReverieInputJournal.intake.snapshot().pending.length,
              };
            });
            return { ...state, visible: await originalPage!.locator('[data-input-acceptance-pending]').isVisible() };
          },
          { timeout: 15000 }
        )
        .toMatchObject({ visible: true, settled: false, complete: false, guardReached: false, pendingOwners: 1 });
      expect(await originalPage.locator('[data-input-acceptance-pending]').textContent()).toContain(
        'acceptance is still pending'
      );
      before = await originalPage.evaluate(() => {
        const scope = window as unknown as Scope & {
          nativeProbe: { closed: boolean; complete: boolean; guardReached: boolean; settled: boolean };
        };
        const observed = {
          complete: scope.nativeProbe.complete,
          guardReached: scope.nativeProbe.guardReached,
          settled: scope.nativeProbe.settled,
        };
        (scope.app._inputJournal as App['_inputJournal'] & { close(): void }).close();
        scope.nativeProbe.closed = true;
        return observed;
      });
      expect(before).toEqual({ complete: false, guardReached: false, settled: false });
      completion = await originalPage.evaluate(async (outcome) => {
        const scope = window as unknown as Scope & {
          nativeProbe: {
            release(): void;
            abort(): void;
            done: Promise<void>;
            accept: Promise<{ kind: string; records?: RecordRow[] }>;
            closed: boolean;
            outcome: string;
            restore(): void;
          };
        };
        if (outcome === 'abort') scope.nativeProbe.abort();
        scope.nativeProbe.release();
        const result = await scope.nativeProbe.accept;
        await scope.nativeProbe.done;
        scope.nativeProbe.restore();
        const journal = scope.app._inputJournal as App['_inputJournal'] & {
          descriptor: Identity;
          admitted(row: RecordRow): boolean;
          claim(row: RecordRow): Promise<RecordRow | null>;
          dispatch(row: RecordRow, effect: () => void): Promise<boolean>;
        };
        const row = result.records?.[0];
        const oldAdmitted = row ? journal.admitted(row) : false;
        let oldClaimReason = row ? 'unexpected-success' : 'no-accepted-row',
          oldEffects = 0;
        try {
          if (row) await journal.claim(row);
        } catch (error) {
          oldClaimReason = error instanceof Error && 'reason' in error ? String(error.reason) : 'unknown-error';
        }
        const oldDispatched = row
          ? await journal.dispatch(row, () => {
              oldEffects++;
            })
          : false;
        return {
          ...result,
          nativeOutcome: scope.nativeProbe.outcome,
          originalIssuer: journal.issuer,
          identity: journal.descriptor,
          oldAdmitted,
          oldClaimReason,
          oldDispatched,
          oldEffects,
          closedBeforeCommit: scope.nativeProbe.closed,
        };
      }, outcome);
      oldPageWrites = writes.get(sid)?.length || 0;
      const restored = await page(c, sid);
      restoration = await restored.evaluate(
        async ({ sid, identity }) => {
          const app = (window as unknown as Scope).app;
          const journal = app._inputJournal as App['_inputJournal'] & { descriptor: Identity };
          const state = await app._inputJournal.snapshot();
          await app._drainSession(sid);
          return {
            sameIdentity:
              journal.descriptor.version === identity.version &&
              journal.descriptor.kind === identity.kind &&
              journal.descriptor.scopeId === identity.scopeId &&
              journal.descriptor.epoch === identity.epoch,
            freshIssuer: journal.issuer,
            rows: state.records.map((row) => ({
              sid: row.sid,
              issuer: row.issuer,
              seq: row.seq,
              phase: row.phase,
              chars: row.data.length,
            })),
            holds: state.holds,
          };
        },
        { sid, identity: completion.identity }
      );
    } finally {
      try {
        if (originalPage && !originalPage.isClosed())
          await originalPage.evaluate(async () => {
            const p = (
              window as unknown as {
                nativeProbe?: { release(): void; done?: Promise<void>; accept?: Promise<unknown>; restore(): void };
              }
            ).nativeProbe;
            if (!p) return;
            p.release();
            await Promise.allSettled([p.done, p.accept]);
            p.restore();
          });
      } finally {
        await c.close();
      }
    }
    await custodyTrace('postwrite-close-restoration-' + outcome, {
      before,
      completion: completion && {
        kind: completion.kind,
        nativeOutcome: completion.nativeOutcome,
        closedBeforeCommit: completion.closedBeforeCommit,
        oldAdmitted: completion.oldAdmitted,
        oldClaimReason: completion.oldClaimReason,
        oldDispatched: completion.oldDispatched,
        oldEffects: completion.oldEffects,
        originalTags: completion.records?.map((row) => ({
          issuer: row.issuer,
          seq: row.seq,
          sid: row.sid,
          phase: row.phase,
        })),
      },
      restoration: restoration && {
        rows: restoration.rows,
        holds: restoration.holds,
        sameIdentity: restoration.sameIdentity,
        freshPageIssuerDiffers: restoration.freshIssuer !== completion?.records?.[0]?.issuer,
      },
      oldPageWrites,
      sessionWrites: writes.get(sid)?.length,
      qualification:
        'Notice timing uses Playwright Clock; the separate WebLock case proves real ten-second timing. The actual original native transaction stays incomplete and its promise unsettled at the notice. Only native completion/abort determines acceptance; same authenticated scope/epoch prepared restoration remains intended after actual commit.',
    });
    expect(completion).toMatchObject({
      kind: outcome === 'commit' ? 'accepted' : 'not-queued',
      nativeOutcome: outcome,
      closedBeforeCommit: true,
      oldAdmitted: false,
      oldClaimReason: outcome === 'commit' ? 'journal-closed' : 'no-accepted-row',
      oldDispatched: false,
      oldEffects: 0,
    });
    expect(oldPageWrites).toBe(0);
    expect(restoration?.sameIdentity).toBe(true);
    expect(restoration?.holds).toEqual([]);
    expect(restoration?.rows).toEqual(
      completion?.records?.map((row) => ({
        issuer: row.issuer,
        seq: row.seq,
        sid: row.sid,
        phase: 'prepared',
        chars: row.data.length,
      })) || []
    );
    expect(restoration?.freshIssuer).not.toBe(completion?.originalIssuer);
    expect(writes.get(sid)).toEqual(outcome === 'commit' ? ['original local input before close'] : []);
    expect(posts.filter((row) => row.sid === sid)).toMatchObject(
      outcome === 'commit'
        ? [
            {
              clientId: completion?.records?.[0]?.issuer,
              seq: completion?.records?.[0]?.seq,
              input: 'original local input before close',
            },
          ]
        : []
    );
  }
);
