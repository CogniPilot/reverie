/**
 * @fileoverview TerminalTile input rides the app's exactly-once queue, and only
 * what a human typed is queued.
 *
 * Before, the split pane's second terminal sent every xterm `onData` chunk as a
 * bare `{t:'i', d}` frame: no seq, no ACK, dropped while the socket was down,
 * never acknowledged an idle alert. It now goes through `app._sendInputAsync`,
 * over the pane's own socket registered in the app's input-socket map. That
 * queue PERSISTS and REDELIVERS, so it must never hold what xterm generates on
 * its own: a query reply (DA/CPR/OSC) is dropped, exactly as the primary pane
 * drops it, and a focus or mouse report goes out once, ephemeral.
 *
 * The socket's lifecycle is pinned here too: a transient drop reconnects on the
 * primary pane's backoff and refreshes the buffer without leaving a stale
 * "disconnected" marker under a healthy pane; codes that cannot get better stop
 * the pane once (`onExit`); a late close from a REPLACED socket is ignored; and
 * destroy() cancels a pending reconnect.
 *
 * The last blocks pin the soft-keyboard controller every tile wires
 * (terminal-keycode229-recovery.js, the primary pane's #441/#541 fixes): an
 * Android autocorrect is sent as an edit, not a duplicated line, a character
 * committed in the same task as Enter goes out ahead of the \r, and the
 * controller is bound to THIS tile's textarea, composition helper and session.
 *
 * Real code under test: constants.js + terminal-keycode229-recovery.js +
 * app.js (the queue) + terminal-ui.js (the shared input predicates) +
 * terminal-tile.js, in one `vm` context. xterm, the fit addon and WebSocket are
 * fakes (test/mocks/terminal-tile-fakes.ts); `connect()` runs for real.
 */
import { readFileSync } from 'node:fs';
import {performance} from 'node:perf_hooks';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {browserInputFixture, type InputApp} from './helpers/browser-input-fixture.js';
import { FakeFit, FakeSocket, FakeTerminal } from './mocks/terminal-tile-fakes.js';

const fetchMock = vi.fn();
const storageMock = {length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn()};

let fixture: ReturnType<typeof browserInputFixture>;
function loadContext() {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ReverieBase: { base: '' },
    // The keyCode-229 controller defaults its timers to window's. Late-bound,
    // like the context's own, so vi.useFakeTimers() reaches it; without them
    // its create() throws into the tile's catch and every controller test
    // would run against no controller at all.
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  };
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), debug: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    // Late-bound, so vi.useFakeTimers() (which swaps the globals) reaches code
    // running inside this context.
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: FakeSocket,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFit },
    fetch: (...args: unknown[]) => fetchMock(...args),
    location: { protocol: 'http:', host: 'reverie.test' },
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
    localStorage: storageMock,
    window: windowStub,
    MobileDetection: {
      isTouchDevice: () => false,
      isHandheldDevice: () => false,
      getDeviceType: () => 'desktop',
    },
  });
  // Queue deadlines and their timer callbacks must share the test's clock.
  Object.defineProperty(context, 'Date', {get: () => globalThis.Date});
  vm.runInContext(
    `${read('constants.js')}\n${read('terminal-keycode229-recovery.js')}\n${read('app.js')}\n` +
      `${read('terminal-ui.js')}\n${read('terminal-tile.js')}\n` +
      'globalThis.__ReverieApp = ReverieApp;',
    context
  );
  return {
    ReverieApp: (context as unknown as { __ReverieApp: { prototype: object } }).__ReverieApp,
    windowStub,
  };
}

const { windowStub } = loadContext();


type App = InputApp & Record<string, unknown> & {markIdleAlertSeen: ReturnType<typeof vi.fn>};
async function makeApp(): Promise<App> {
  fixture ||= browserInputFixture();
  const app = await fixture.page(async (url, options) => fetchMock(url, options), ['terminal-ui.js']) as App;
  app._clientId = 'c-test'; app._wsTabNonce = 'nonce-1'; app._extraInputSockets = new Map();
  app.loadAppSettingsFromStorage = () => ({});
  app._estimateReplayRows = (text: string) => text.split('\n').length;
  return app;
}

type Tile = {
  connect(): Promise<void>;
  destroy(): void;
  reconnectNow(): void;
  fit(opts?: { force?: boolean }): boolean;
  detachedSessions?: Set<string>;
  ws: FakeSocket | null;
  _reconnectAttempts: number;
};

/**
 * Every tile a test creates, destroyed after it. A tile closed with real timers
 * schedules a real reconnect, and one firing during a LATER test opens a socket
 * there (FakeSocket.instances is shared), which flaked under full-suite load.
 */
const liveTiles: Tile[] = [];
const TerminalTile = windowStub.TerminalTile as new (id: string, mount: unknown, opts?: object) => Tile;

async function connectTile(app: App, opts: Record<string, unknown> = {}) {
  windowStub.app = app;
  const tile = new TerminalTile(
    's-tile',
    { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    { mode: 'claude', ...opts }
  );
  liveTiles.push(tile);
  await tile.connect();
  const ws = FakeSocket.instances.at(-1)!;
  return { tile, ws, term: FakeTerminal.last! };
}

afterEach(async () => {
  for (const tile of liveTiles.splice(0)) tile.destroy();
  vi.useRealTimers();
  await fixture?.close();
  fixture = undefined as unknown as ReturnType<typeof browserInputFixture>;
});

beforeEach(() => {
  FakeTerminal.coreFactory = null;
  FakeFit.proposed = { cols: 80, rows: 24 };
  FakeSocket.instances = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { terminalBuffer: '' } }),
  }));
});

describe('TerminalTile socket identity', () => {
  it('connects with the tab identity plus a :tile suffix, never the primary pane cid', async () => {
    const { ws } = await connectTile(await makeApp());

    const cid = new URL(ws.url).searchParams.get('cid');
    expect(cid).toBe('c-test:nonce-1:tile');
  });
});

const inputReply = (data: object = {}, status = 200) => ({ok: status === 200, status, json: async () => ({success: status === 200, ...(status === 409 ? {errorCode: 'SESSION_BUSY'} : {}), data})});
async function expectFrames(ws: FakeSocket, count: number) {await expect.poll(() => ws.inputFrames().length).toBe(count);}
async function wsOutcome(app: App, ws: FakeSocket, fields: object) {
  ws.receive(fields);
  await Promise.all([...(app._inputOutcomes as Map<string, Promise<unknown>>).values()]);
}
async function committed(app: App) {await (app._inputAcceptTail as Promise<unknown>);}
/** The keyboard fixture's synthetic server explicitly confirms each actual
 * frame. This never changes the journal's pending/uncertain transition rules. */
async function confirmKeyboardFrames(ws: FakeSocket) {
  const app = windowStub.app as App;
  await committed(app);
  for (let count = 0; count < 256 && app._pendingDeliveries.get('s-tile')?.length; count++) {
    if (!app._inputFlights.has('s-tile')) {
      app._inputRetryAt.set('s-tile', 0);
      await app._drainSession('s-tile');
    }
    const seq = app._inputFlights.get('s-tile')?.record.seq;
    await expect.poll(() => ws.inputFrames().find(frame => frame.seq === seq)).toBeDefined();
    const frame = ws.inputFrames().find(frame => frame.seq === seq);
    expect(frame?.seq).toBeTypeOf('number');
    await wsOutcome(app, ws, {t: 'ia', seq: frame!.seq, confirmed: true});
  }
  expect(app._pendingDeliveries.get('s-tile')?.length || 0, JSON.stringify({frames: ws.inputFrames(),
    flight: app._inputFlights.get('s-tile'), held: app._inputRecoveryHolds?.has('s-tile'), storage: app._inputStorageUnavailable})).toBe(0);
}

describe('TerminalTile input through committed journal custody', () => {
  it('holds a pending receipt barrier and later text until actual confirmation, never retransmitting', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open();
    term.type('original'); await expectFrames(ws, 1);
    await wsOutcome(app, ws, {t: 'ip', seq: 1}); term.type('later'); await committed(app);
    expect(app._pendingDeliveries.get('s-tile')?.map(row => row.data)).toEqual(['original', 'later']);
    expect(ws.inputFrames()).toHaveLength(1); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true}); await expectFrames(ws, 2);
    expect(ws.inputFrames().map(row => [row.seq, row.d])).toEqual([[1, 'original'], [2, 'later']]);
    expect(app.markIdleAlertSeen).toHaveBeenCalledExactlyOnceWith('s-tile');
    await wsOutcome(app, ws, {t: 'ia', seq: 2, confirmed: true});
  });
  it('pending HTTP polls the exact receipt GET and issues later text only after confirmation', async () => {
    const app = await makeApp(), posts: {input: string; seq: number}[] = [], reads: string[] = [];
    let confirmed = false;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes('/input-receipt?')) {reads.push(url); const q = new URL(url, 'http://fixture').searchParams;
        return inputReply({version: 1, clientId: q.get('clientId'), seq: Number(q.get('seq')), fingerprint: q.get('fingerprint'), state: confirmed ? 'confirmed' : 'pending'});}
      posts.push(JSON.parse(String(options?.body))); return inputReply(posts.length === 1 ? {pending: true} : {});
    });
    await app._sendInputAsync('s-http', 'original'); await app._drainSession('s-http');
    await app._sendInputAsync('s-http', 'later');
    await app._drainSession('s-http'); // Settle the acceptance-triggered backoff task first.
    expect(posts.map(row => row.seq)).toEqual([1]);
    app._inputRetryAt.set('s-http', 0); await app._drainSession('s-http'); expect(reads).toHaveLength(1); expect(posts).toHaveLength(1);
    confirmed = true; app._inputRetryAt.set('s-http', 0); await app._drainSession('s-http');
    await expect.poll(() => posts.map(row => [row.seq, row.input])).toEqual([[1, 'original'], [2, 'later']]);
    expect(reads).toHaveLength(2);
  });
  it('a typed-unsent original response warns but never spends an idle alert or sends Enter automatically', async () => {
    const app = await makeApp(), posts: object[] = [];
    fetchMock.mockImplementation(async (_url, options) => {posts.push(JSON.parse(options.body)); return posts.length === 1 ? inputReply({typedUnsent: true, delivered: false}, 409) : inputReply();});
    await app._sendInputAsync('s-http', 'text\r'); await app._drainSession('s-http');
    expect(posts).toHaveLength(1); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    expect((app.showToast as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ')).toMatch(/withheld/);
    await app._sendInputAsync('s-http', '\r');
    await expect.poll(() => {app._redeliverSweep(); return posts.length;}).toBe(2);
    expect(posts).toEqual([{input: 'text\r', seq: 1, clientId: app._inputJournal.issuer}, {input: '\r', seq: 2, clientId: app._inputJournal.issuer}]);
  });
  it('known-before-effect HTTP refusal backs off, then retries only the original exact tag', async () => {
    const app = await makeApp(), posts: object[] = [];
    fetchMock.mockImplementation(async (_url, options) => {posts.push(JSON.parse(options.body)); return posts.length === 1 ? inputReply({delivered: false}, 409) : inputReply();});
    await app._sendInputAsync('s-http', 'original'); await app._drainSession('s-http');
    await app._drainSession('s-http'); expect(posts).toHaveLength(1);
    app._inputRetryAt.set('s-http', 0); await app._drainSession('s-http');
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]);
  });
  it.each([{recoveryRequired: true}, {unconfirmed: true}, {held: true}])('HTTP uncertainty dominates typed-unsent: %j', async denial => {
    const app = await makeApp(); fetchMock.mockResolvedValue(inputReply({...denial, typedUnsent: true, delivered: false}, 409));
    await app._sendInputAsync('s-http', 'original'); await app._drainSession('s-http');
    expect(app._inputRecoveryHolds?.has('s-http')).toBe(true); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    expect(await app._sendInputAsync('s-http', 'blocked')).toBe(false); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('malformed or mismatched pending replies cannot settle the original frame or clear another hold', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('original'); await expectFrames(ws, 1);
    for (const msg of [{t: 'ip', seq: 2}, {t: 'ip', seq: 1, unexpected: true}]) await wsOutcome(app, ws, msg);
    expect(app._inputFlights.get('s-tile')?.record.phase).toBe('may-issued');
    expect(app._pendingDeliveries.get('s-tile')?.[0].data).toBe('original'); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });
  it('plain ACK is not confirmation and a late confirmed reply cannot clear uncertainty', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('original'); await expectFrames(ws, 1);
    await wsOutcome(app, ws, {t: 'ip', seq: 1}); await wsOutcome(app, ws, {t: 'ia', seq: 1});
    expect(app._inputRecoveryHolds?.has('s-tile')).toBe(true);
    await wsOutcome(app, ws, {t: 'ip', seq: 1}); await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true});
    expect(app._inputRecoveryHolds?.has('s-tile')).toBe(true); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    expect(ws.inputFrames()).toHaveLength(1);
  });
  it.each([{typedUnsent: true, delivered: true}, {typedUnsent: true, delivered: false, confirmed: true}, {typedUnsent: false, delivered: false}])('contradictory negative ACK holds the original: %j', async fields => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('original'); await expectFrames(ws, 1);
    await wsOutcome(app, ws, {t: 'ia', seq: 1, ...fields});
    expect(app._inputRecoveryHolds?.has('s-tile')).toBe(true); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    expect((await app._inputJournal.snapshot()).retained.concat((await app._inputJournal.snapshot()).records).map(row => row.data)).toEqual(['original']);
  });
  it('a restored pending receipt and later text are held under their original tags without pipelining', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('original'); await expectFrames(ws, 1);
    await wsOutcome(app, ws, {t: 'ip', seq: 1}); term.type('later'); await committed(app);
    const issuer = app._inputJournal.issuer; app._inputJournal.close();
    const restored = await makeApp(), next = await connectTile(restored); next.ws.open();
    expect(await restored._sendInputAsync('s-tile', 'blocked')).toBe(false);
    expect(next.ws.inputFrames()).toEqual([]); const state = await restored._inputJournal.snapshot();
    const retained = [...state.records, ...state.retained];
    expect(retained.every(row => row.issuer === issuer)).toBe(true);
    expect(retained.map(row => row.data)).toEqual(['original', 'later']);
    expect(state.holds.some(row => row.sid === 's-tile')).toBe(true);
  });
  it.each(['malformed-pending', 'unreadable', 'failed-envelope'] as const)('HTTP %s never acknowledges or replays its frame', async failure => {
    const app = await makeApp(); fetchMock.mockResolvedValue({ok: true, status: 200, json: async () => {
      if (failure === 'unreadable') throw Error('Synthetic truncated response');
      return failure === 'failed-envelope' ? {success: false} : {success: true, data: {pending: 'invalid'}};
    }});
    await app._sendInputAsync('s-http', 'original'); await app._drainSession('s-http');
    expect(app._inputRecoveryHolds?.has('s-http')).toBe(true); expect(fetchMock).toHaveBeenCalledOnce();
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });
  it('carries explicit mux choice on the actual tile socket, not just the HTTP fallback', async () => {
    const app = await makeApp(), {ws} = await connectTile(app); ws.open();
    await app._sendInputAsync('s-tile', 'original', {useMux: true}); await expectFrames(ws, 1);
    expect(ws.inputFrames()[0]).toMatchObject({cid: app._inputJournal.issuer, seq: 1, useMux: true});
    await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true});
  });
  it.each(['capacity', 'unavailable'])('known-never-issued %s retries the exact same frame after backoff', async reason => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('original'); await expectFrames(ws, 1);
    await wsOutcome(app, ws, {t: 'ir', seq: 1, retryable: true, reason});
    await app._drainSession('s-tile'); expect(ws.inputFrames()).toHaveLength(1);
    app._inputRetryAt.set('s-tile', 0); await app._drainSession('s-tile'); await expectFrames(ws, 2);
    expect(ws.inputFrames()[1]).toEqual(ws.inputFrames()[0]); await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true});
  });
  it('a contradictory refusal cannot refund an unknown effect or clear its hold', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('original'); await expectFrames(ws, 1);
    await wsOutcome(app, ws, {t: 'ie', held: true});
    await wsOutcome(app, ws, {t: 'ir', seq: 1, retryable: true, reason: 'unavailable', confirmed: true});
    app._inputRetryAt.set('s-tile', 0); await app._drainSession('s-tile');
    expect(app._inputRecoveryHolds?.has('s-tile')).toBe(true); expect(ws.inputFrames()).toHaveLength(1);
  });
  it.each([404, 410])('HTTP%s cannot acknowledge an idle alert or silently delete the original', async status => {
    const app = await makeApp(); fetchMock.mockResolvedValue(inputReply({}, status));
    await app._sendInputAsync('s-http', 'original'); await app._drainSession('s-http');
    expect(app._inputRecoveryHolds?.has('s-http')).toBe(true); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });
  it('an unmatched old ACK cannot spend a new idle alert', async () => {
    const app = await makeApp(), {ws} = await connectTile(app); ws.open();
    await wsOutcome(app, ws, {t: 'ia', seq: 99, confirmed: true}); expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });
  it('unconfirmed ACK holds later text and a confirmed duplicate never mints another sequence', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open();
    term.type('original'); await expectFrames(ws, 1); term.type('later'); await committed(app);
    await wsOutcome(app, ws, {t: 'ia', seq: 1, unconfirmed: true}); await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true, dup: true});
    expect(app._inputRecoveryHolds?.has('s-tile')).toBe(true); expect(ws.inputFrames()).toHaveLength(1);
    expect(app._pendingDeliveries.get('s-tile')?.map(row => row.seq)).toEqual([1, 2]);
  });
  it('confirmed duplicate settles only the original sequence and acknowledges its session alert', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); term.type('q'); await expectFrames(ws, 1);
    expect(ws.inputFrames()[0]).toMatchObject({d: 'q', seq: 1, cid: app._inputJournal.issuer});
    await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true, dup: true});
    expect(app._pendingDeliveries.has('s-tile')).toBe(false); expect(app.markIdleAlertSeen).toHaveBeenCalledExactlyOnceWith('s-tile');
    expect(ws.inputFrames()).toHaveLength(1);
  });
  it('the first dispatch sees every split frame committed, rather than a partial paste', async () => {
    const app = await makeApp(), {ws} = await connectTile(app); ws.open(); const text = 'x'.repeat(65536) + 'tail';
    await app._sendInputAsync('s-tile', text); await expectFrames(ws, 1);
    expect((await app._inputJournal.snapshot()).records.map(row => row.data).join('')).toBe(text);
    await wsOutcome(app, ws, {t: 'ia', seq: 1, confirmed: true}); await expectFrames(ws, 2);
    expect(ws.inputFrames().map(row => row.d).join('')).toBe(text); await wsOutcome(app, ws, {t: 'ia', seq: 2, confirmed: true});
  });
  it('input accepted before socket readiness is retained, then dispatched once through a current transport', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); const posts: object[] = [];
    fetchMock.mockImplementation(async (_url, options) => {posts.push(JSON.parse(options.body)); return inputReply();});
    term.type('before open'); await committed(app); await app._drainSession('s-tile'); ws.open();
    expect(posts).toHaveLength(1); expect(ws.inputFrames()).toEqual([]);
    expect(app._pendingDeliveries.has('s-tile')).toBe(false);
  });
  it('typing after a closed tile socket uses HTTP once without dropping the input', async () => {
    const app = await makeApp(), {ws, term} = await connectTile(app); ws.open(); ws.drop(); const posts: object[] = [];
    fetchMock.mockImplementation(async (_url, options) => {posts.push(JSON.parse(options.body)); return inputReply();});
    term.type('z'); await committed(app); await app._drainSession('s-tile');
    expect(posts).toEqual([{input: 'z', clientId: app._inputJournal.issuer, seq: 1}]); expect(ws.inputFrames()).toEqual([]);
  });
});

describe('what xterm generates never enters the durable queue', () => {
  it('fatal storage failure retains the first event and fences existing and newly created owned tiles', async () => {
    const app = await makeApp(), current = await connectTile(app);
    app._splitPane = current.tile; current.ws.open(); fixture.refuseStrict('ignored');
    current.term.type('first tile draft 😀'); await committed(app);
    expect(app._inputStorageUnavailable).toBe(true); expect(current.term.options.disableStdin).toBe(true);
    for (let count = 0; count < 100; count++) current.term.type('later raw keystroke');
    expect(app._unsavedInputDrafts.map(row => row.text)).toEqual(['first tile draft 😀']);
    const next = await connectTile(app); next.ws.open(); next.term.type('also fenced');
    expect(next.term.options.disableStdin).toBe(true); expect(current.ws.inputFrames()).toEqual([]); expect(next.ws.inputFrames()).toEqual([]);
    expect(app._unsavedInputDrafts.map(row => row.text)).toEqual(['first tile draft 😀']);
  });
  it('drops a DA query reply entirely', async () => {
    const app = await makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('\x1b[?1;2c');

    expect(ws.inputFrames()).toEqual([]);
    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
  });

  it('sends a mouse report once, without a seq, and never persists it', async () => {
    const app = await makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('\x1b[<0;10;5M');

    expect(ws.inputFrames()).toEqual([{ t: 'i', d: '\x1b[<0;10;5M' }]);
    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
  });

  it('sends a focus report once, without a seq', async () => {
    const app = await makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('\x1b[I');

    expect(ws.inputFrames()).toEqual([{ t: 'i', d: '\x1b[I' }]);
    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
  });
});

describe('TerminalTile leaves the input-socket map', () => {
  it('on close, so a later keystroke cannot be written into a dead socket', async () => {
    const app = await makeApp();
    const { ws } = await connectTile(app);
    ws.open();
    expect((app._extraInputSockets as Map<string, unknown>).has('s-tile')).toBe(true);

    ws.onclose?.({ code: 1006 });

    expect((app._extraInputSockets as Map<string, unknown>).has('s-tile')).toBe(false);
  });

  it('on destroy, while pending input stays queued for the HTTP sweep', async () => {
    const app = await makeApp();
    const { tile, ws, term } = await connectTile(app);
    ws.open();
    term.type('q');
    await expectFrames(ws, 1);

    tile.destroy();

    expect((app._extraInputSockets as Map<string, unknown>).has('s-tile')).toBe(false);
    expect(app._pendingDeliveries.get('s-tile')?.map((r) => r.data)).toEqual(['q']);
  });
});

const isMarker = (data: string) => data.includes('[disconnected');

/**
 * Lets the async buffer refresh settle: the fetch, the body read, the chunked
 * write AND the load's finally block, which is where a stale marker would be
 * stamped. Too few turns here and that assertion passes vacuously.
 */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('TerminalTile reconnects after a transient drop', () => {
  it('reopens on the backoff, refreshes the buffer, and leaves no stale marker', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const app = await makeApp();
    const { tile, ws, term } = await connectTile(app);
    ws.open();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { terminalBuffer: 'fresh screen' } }),
    }));

    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    expect(term.writes.filter(isMarker)).toEqual([expect.stringContaining('[disconnected, reconnecting')]);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances).toHaveLength(2);
    const ws2 = FakeSocket.instances[1];
    expect(ws2.url).toBe(ws.url);

    ws2.open();
    await settle();

    // The refresh reset the pane in-stream (never xterm's clear()) and replayed
    // the current screen, and nothing after that reset is a marker: the pane is
    // healthy again.
    expect(term.writes).not.toContain('<CLEAR>');
    const lastReset = term.writes.lastIndexOf('\x1bc');
    expect(lastReset).toBeGreaterThan(-1);
    expect(term.writes.slice(lastReset)).toEqual(['\x1bc', 'fresh screen']);
    expect(term.writes.slice(lastReset).some(isMarker)).toBe(false);
    expect(tile._reconnectAttempts).toBe(0);
    expect(tile.ws).toBe(ws2);
  });

  it('counts failed attempts and resets the count only on a successful open', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { tile, ws } = await connectTile(await makeApp());
    ws.open();

    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    FakeSocket.instances[1].onclose?.({ code: 1006 }); // the retry fails too
    expect(tile._reconnectAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    FakeSocket.instances[2].open();
    expect(tile._reconnectAttempts).toBe(0);
  });

  it('reconnects after the redelivery sweep force-closes a silent socket (1005)', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws } = await connectTile(await makeApp());
    ws.open();

    ws.onclose?.({ code: 1005 });
    await vi.advanceTimersByTimeAsync(300);

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('reconnectNow() skips the backoff, but never replaces an open socket', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { tile, ws } = await connectTile(await makeApp());
    ws.open();

    tile.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(1);

    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    tile.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(2);
    // The backoff timer it pre-empted must not open a third socket later.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe("the server's {t:'c'} frame refreshes the tile (a Claude pane's first prompt)", () => {
  // Session.startInteractive (session.ts) sends it once a fresh Claude pane
  // shows its prompt, meaning "refresh after startup"; the primary pane refetches
  // and replays (_onSessionClearTerminal). A tile used to run a bare xterm
  // clear(), which kept only the cursor's row: banner and transcript gone, and an
  // idle Claude never repaints them.
  it('refetches the capture and replays it, never a bare clear', async () => {
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { terminalBuffer: 'Claude Code banner\r\n❯ ' } }),
    }));

    ws.receive({ t: 'o', d: 'banner painted live' });
    ws.receive({ t: 'c' });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s-tile/terminal?full=1');
    expect(term.writes.at(-1)).toBe('Claude Code banner\r\n❯ ');
  });

  it('two clear frames during one refresh fetch once more, not twice', async () => {
    const { ws } = await connectTile(await makeApp());
    ws.open();
    fetchMock.mockClear();
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolveFetch) => {
          release = () =>
            resolveFetch({ ok: true, status: 200, json: async () => ({ data: { terminalBuffer: 'a' } }) });
        })
    );

    ws.receive({ t: 'c' });
    ws.receive({ t: 'c' });
    ws.receive({ t: 'c' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('TerminalTile stops for good on codes that cannot get better', () => {
  it.each([
    [4004, 'the session ended'],
    [4009, 'the session ended'],
    [4003, 'the server refused this connection'],
    [4010, 'another connection took over this pane'],
  ])('close %i: no reconnect, onExit once, marker says why', async (code, reason) => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const onExit = vi.fn();
    const { tile, ws, term } = await connectTile(await makeApp(), { onExit });
    ws.open();

    ws.onclose?.({ code });
    await vi.advanceTimersByTimeAsync(30_000);
    tile.reconnectNow();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(code);
    expect(term.writes.filter(isMarker)).toEqual([expect.stringContaining(reason)]);
  });
});

describe('TerminalTile ignores a socket it already replaced', () => {
  it('a late close (4010) from the old socket neither stops the pane nor unregisters its successor', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const onExit = vi.fn();
    const app = await makeApp();
    const { ws, term } = await connectTile(app, { onExit });
    ws.open();
    const lateClose = ws.onclose!;

    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.instances[1];
    ws2.open();

    // The server supersedes the old socket by cid; its close arrives late.
    lateClose({ code: 4010 });

    expect(onExit).not.toHaveBeenCalled();
    term.type('still typing');
    await expectFrames(ws2, 1);
    expect(ws2.inputFrames().map((f) => f.d)).toEqual(['still typing']);
  });
});

describe('TerminalTile destroy()', () => {
  it('cancels a pending reconnect and never reports an exit afterwards', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const onExit = vi.fn();
    const { tile, ws } = await connectTile(await makeApp(), { onExit });
    ws.open();

    ws.onclose?.({ code: 1006 });
    tile.destroy();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('TerminalTile geometry (#464: the pane and its PTY never disagree)', () => {
  const resizeFrames = (ws: FakeSocket) => ws.sent.filter((f) => f.t === 'z');

  it('announces its size as a desktop viewer when the socket opens', async () => {
    const { ws } = await connectTile(await makeApp());
    ws.open();

    expect(resizeFrames(ws)).toEqual([{ t: 'z', c: 80, r: 24, v: 'desktop' }]);
  });

  it('does not resend an unchanged size, sends a changed one, and force resends', async () => {
    const { tile, ws } = await connectTile(await makeApp());
    ws.open();

    expect(tile.fit()).toBe(false); // unchanged: nothing sent
    expect(resizeFrames(ws)).toHaveLength(1);

    FakeFit.proposed = { cols: 100, rows: 30 };
    expect(tile.fit()).toBe(true);
    expect(resizeFrames(ws).at(-1)).toEqual({ t: 'z', c: 100, r: 30, v: 'desktop' });

    expect(tile.fit({ force: true })).toBe(true);
    expect(resizeFrames(ws)).toHaveLength(3);
    // The primary pane's forced resize flag: without it Session.resize skips a
    // size equal to the one it last applied, and the forced resend did nothing.
    expect(resizeFrames(ws).at(-1)).toEqual({ t: 'z', c: 100, r: 30, v: 'desktop', f: true });
  });

  it('force on a closed socket sends nothing and says so', async () => {
    const { tile, ws } = await connectTile(await makeApp());
    ws.open();
    ws.drop(1006);

    expect(tile.fit({ force: true })).toBe(false);
    expect(resizeFrames(ws)).toHaveLength(1); // only the open's own announcement
  });

  describe('Redraw (Ctrl+Shift+R, the header button) on a focused tile', () => {
    type RedrawApp = App & {
      restoreTerminalSize(): Promise<void>;
      _noteFocusedTile(tile: unknown): void;
      detachedSessions?: Set<string>;
    };

    it('forces the resize through to the server and reports the size it sent', async () => {
      const app = await makeApp() as RedrawApp;
      const { tile, ws } = await connectTile(app);
      ws.open();
      app._noteFocusedTile(tile);

      await app.restoreTerminalSize();

      expect(resizeFrames(ws).at(-1)).toEqual({ t: 'z', c: 80, r: 24, v: 'desktop', f: true });
      expect(app.showToast).toHaveBeenCalledWith('Terminal restored to 80x24', 'success');
    });

    it('with the socket down, sends nothing and does not report a success', async () => {
      const app = await makeApp() as RedrawApp;
      const { tile, ws } = await connectTile(app);
      ws.open();
      app._noteFocusedTile(tile);
      ws.drop(1006);

      await app.restoreTerminalSize();

      expect(resizeFrames(ws)).toHaveLength(1);
      expect(app.showToast).not.toHaveBeenCalledWith(expect.stringContaining('restored'), 'success');
      expect(app.showToast).toHaveBeenCalledWith(
        'Terminal not connected: its size is sent when it reconnects',
        'warning'
      );
    });

    it('for a session popped out to its own window, says that window sizes it', async () => {
      const app = await makeApp() as RedrawApp;
      const detached = new Set<string>();
      app.detachedSessions = detached;
      const { tile, ws } = await connectTile(app, { detachedSessions: detached });
      ws.open();
      app._noteFocusedTile(tile);
      detached.add('s-tile'); // popped out after the tile opened

      await app.restoreTerminalSize();

      expect(resizeFrames(ws)).toHaveLength(1);
      expect(app.showToast).not.toHaveBeenCalledWith(expect.stringContaining('restored'), 'success');
      expect(app.showToast).toHaveBeenCalledWith('This session is sized by its own window', 'warning');
    });
  });

  it('re-announces an unchanged size on a reconnected socket', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws } = await connectTile(await makeApp());
    ws.open();
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.instances[1];

    ws2.open();

    expect(resizeFrames(ws2)).toEqual([{ t: 'z', c: 80, r: 24, v: 'desktop' }]);
  });

  it('applies no 40-column floor: a pane at the divider clamp gets its real width on both sides', async () => {
    const { tile, ws, term } = await connectTile(await makeApp());
    ws.open();

    FakeFit.proposed = { cols: 28, rows: 30 };
    tile.fit();

    expect(term.cols).toBe(28);
    expect(resizeFrames(ws).at(-1)).toEqual({ t: 'z', c: 28, r: 30, v: 'desktop' });
  });

  it('paneStarted() resends an unchanged size: the first one went out before there was a PTY', async () => {
    const { tile, ws } = await connectTile(await makeApp());
    ws.open();
    tile.paneStarted();
    expect(resizeFrames(ws)).toEqual([
      { t: 'z', c: 80, r: 24, v: 'desktop' },
      { t: 'z', c: 80, r: 24, v: 'desktop' },
    ]);
    // Only once: the size is recorded again, so a plain fit does not repeat it.
    tile.fit();
    expect(resizeFrames(ws)).toHaveLength(2);
  });

  it('paneStarted() on a hidden tile sends nothing, and its next fit sends the size', async () => {
    const { tile, ws } = await connectTile(await makeApp());
    ws.open();
    FakeFit.proposed = { cols: NaN, rows: NaN };
    tile.paneStarted();
    expect(resizeFrames(ws)).toHaveLength(1);
    // Shown again (a zoom ends) at the same size it had: still sent.
    FakeFit.proposed = { cols: 80, rows: 24 };
    tile.fit();
    expect(resizeFrames(ws)).toHaveLength(2);
  });

  it('paneStarted() before the socket opens sends nothing; the open sends the size once', async () => {
    const { tile, ws } = await connectTile(await makeApp());
    tile.paneStarted();
    expect(resizeFrames(ws)).toHaveLength(0);
    ws.open();
    expect(resizeFrames(ws)).toEqual([{ t: 'z', c: 80, r: 24, v: 'desktop' }]);
  });

  it('reports nothing while hidden (the fit addon measures NaN)', async () => {
    const { tile, ws, term } = await connectTile(await makeApp());
    ws.open();

    FakeFit.proposed = { cols: NaN, rows: NaN };
    tile.fit();

    expect(resizeFrames(ws)).toHaveLength(1);
    expect([term.cols, term.rows]).toEqual([80, 24]);
  });

  it('stands aside for a session detached into its own window', async () => {
    const { tile, ws } = await connectTile(await makeApp(), { detachedSessions: new Set(['s-tile']) });
    ws.open();
    FakeFit.proposed = { cols: 120, rows: 40 };

    expect(tile.fit()).toBe(false);

    expect(resizeFrames(ws)).toEqual([]);
  });

  it('adopts the column count the PTY reports, keeping its own rows', async () => {
    const { ws, term } = await connectTile(await makeApp());
    ws.open();

    ws.receive({ t: 'zc', c: 132, r: 50 });

    expect([term.cols, term.rows]).toEqual([132, 24]);
  });

  it('leaves the pane alone when the PTY agrees on width', async () => {
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    const before = term.resizes.length;

    ws.receive({ t: 'zc', c: 80, r: 60 });

    expect(term.resizes.length).toBe(before);
  });
});

describe('TerminalTile links and paste follow THIS pane', () => {
  it('registers the shared link provider on its own terminal, resolving its own session', async () => {
    const app = await makeApp();
    const register = vi.fn();
    app.registerFilePathLinkProvider = register;

    const { term } = await connectTile(app);

    expect(register).toHaveBeenCalledTimes(1);
    const target = register.mock.calls[0][0] as { terminal: unknown; getSessionId: () => string };
    expect(target.terminal).toBe(term);
    expect(target.getSessionId()).toBe('s-tile');
  });

  it("routes Ctrl+V into the paste trap with this pane's terminal and session", async () => {
    const app = await makeApp();
    const paste = vi.fn();
    app._handleImagePaste = paste;
    const { term } = await connectTile(app);

    const handled = term.keyHandler!({ type: 'keydown', key: 'v', ctrlKey: true, code: 'KeyV' });

    expect(handled).toBe(false);
    expect(paste).toHaveBeenCalledWith({ terminal: term, sessionId: 's-tile' });
  });

  it('leaves Ctrl+Shift+V (voice input) out of the paste trap', async () => {
    const app = await makeApp();
    const paste = vi.fn();
    app._handleImagePaste = paste;
    const { term } = await connectTile(app);

    term.keyHandler!({ type: 'keydown', key: 'V', ctrlKey: true, shiftKey: true, code: 'KeyV' });

    expect(paste).not.toHaveBeenCalled();
  });
});

describe("TerminalTile Ctrl+C copies through the primary pane's copy helpers", () => {
  const ctrlC = (extra: Record<string, unknown> = {}) => ({
    type: 'keydown',
    key: 'c',
    code: 'KeyC',
    ctrlKey: true,
    preventDefault: vi.fn(),
    ...extra,
  });

  it("copies THIS pane's selection; a failed write keeps it and focus returns to this pane", async () => {
    const app = await makeApp();
    const copyText = vi.fn(async () => false);
    app._copyText = copyText;
    const { term } = await connectTile(app);
    term.selection = 'npm run build';

    const ev = ctrlC();
    expect(term.keyHandler!(ev)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(ev.preventDefault).toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledWith('npm run build');
    expect(app.showToast).toHaveBeenCalledWith('Failed to copy', 'error');
    // As in the primary pane: nothing was copied, so the selection stays for a retry.
    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(term.selection).toBe('npm run build');
    // The execCommand fallback focuses a temporary textarea; the keyboard comes back here.
    expect(term.focus).toHaveBeenCalled();
  });

  it('a successful write clears the selection (a second Ctrl+C interrupts) and refocuses this pane', async () => {
    const app = await makeApp();
    app._copyText = vi.fn(async () => true);
    const { term } = await connectTile(app);
    term.selection = 'npm run build';

    expect(term.keyHandler!(ctrlC())).toBe(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(app.showToast).toHaveBeenCalledWith('Copied to clipboard', 'success');
    expect(term.clearSelection).toHaveBeenCalled();
    expect(term.focus).toHaveBeenCalled();
  });

  it('with nothing selected, Ctrl+C reaches the PTY and Ctrl+Shift+C does not', async () => {
    const app = await makeApp();
    const copyText = vi.fn(async () => true);
    app._copyText = copyText;
    const { term } = await connectTile(app);

    const plain = ctrlC();
    expect(term.keyHandler!(plain)).toBe(true);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    const shifted = ctrlC({ key: 'C', shiftKey: true });
    expect(term.keyHandler!(shifted)).toBe(false);
    expect(shifted.preventDefault).toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe('TerminalTile claims the keyboard for the app-level shortcuts', () => {
  it('focusing its terminal makes it the focused pane; destroy() hands the keyboard back', async () => {
    const app = await makeApp();
    const { tile, term } = await connectTile(app);
    expect(app._focusedTile ?? null).toBeNull();

    term.focusTextarea();
    expect(app._focusedTile).toBe(tile);

    tile.destroy();
    expect(app._focusedTile).toBeNull();
    expect(term.focusListeners).toEqual([]);
  });
});

describe('TerminalTile live-output flow control: a flood cannot pile up in xterm', () => {
  // The server applies no backpressure, and a tile used to write every live
  // frame straight into xterm: a flood it could not parse as fast piled up in
  // xterm's own queue without bound, until xterm's WriteBuffer threw past 50M
  // code units and onmessage's catch silently lost the frames. Now unparsed
  // (and held) output is counted per tile; past the budget a frame is dropped,
  // the tile stops writing onto the hole, and one debounced, bounded refresh
  // recaptures the screen (the primary pane's _scheduleDroppedOutputRecovery).
  const TileStatics = TerminalTile as unknown as { LIVE_BACKLOG_BUDGET: number };
  const defaultBudget = TileStatics.LIVE_BACKLOG_BUDGET;
  afterEach(() => {
    TileStatics.LIVE_BACKLOG_BUDGET = defaultBudget;
    delete windowStub.AbortController;
  });
  const out = (ws: FakeSocket, d: string) => ws.receive({ t: 'o', d });
  const inFlight = (tile: Tile) => (tile as unknown as { _liveInFlight: number })._liveInFlight;
  function serve(terminalBuffer: string) {
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { terminalBuffer } }),
    }));
  }

  it("the budget is a few MB, not the primary pane's 128 KB: a 1 MiB burst xterm has not parsed yet is still written", async () => {
    expect(defaultBudget).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(defaultBudget).toBeLessThanOrEqual(16 * 1024 * 1024);
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    serve('');
    term.holdParse = true;

    out(ws, 'z'.repeat(1024 * 1024));

    expect(term.writes.at(-1)).toHaveLength(1024 * 1024);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts output until xterm has parsed it, so parsed bytes no longer hold the budget', async () => {
    TileStatics.LIVE_BACKLOG_BUDGET = 100;
    const { tile, ws, term } = await connectTile(await makeApp());
    ws.open();
    term.holdParse = true;

    out(ws, 'a'.repeat(40));
    out(ws, 'b'.repeat(40));
    expect(inFlight(tile)).toBe(80);
    term.parse();
    expect(inFlight(tile)).toBe(0);
    out(ws, 'c'.repeat(90));

    expect(term.writes.slice(-3)).toEqual(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(90)]);
  });

  it('stops writing past the budget, and ONE debounced refresh recaptures the screen', async () => {
    TileStatics.LIVE_BACKLOG_BUDGET = 100;
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    serve('recovered screen');
    term.holdParse = true; // xterm falls behind

    out(ws, 'a'.repeat(60));
    out(ws, 'b'.repeat(60)); // 120 unparsed: past the budget, dropped
    out(ws, 'c');
    term.parse(); // xterm catches up, but the stream already has a hole:
    out(ws, 'd'); // nothing more is written onto it
    expect(term.writes.filter((w) => /^[abcd]/.test(w))).toEqual(['a'.repeat(60)]);
    expect(fetchMock).not.toHaveBeenCalled();

    term.holdParse = false;
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).not.toHaveBeenCalled(); // debounced, like the primary pane's
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s-tile/terminal?full=1');
    expect(term.writes.slice(-2)).toEqual(['\x1bc', 'recovered screen']);

    out(ws, 'live again');
    expect(term.writes.at(-1)).toBe('live again');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one recovery for the whole burst
  });

  it("a write xterm refuses (its 50M throw) is a drop that schedules the same recovery, never a swallowed 'malformed frame'", async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    serve('recovered screen');
    term.throwOnWrite = 'boom';

    out(ws, 'boom');
    out(ws, 'after the hole');
    expect(term.writes).not.toContain('after the hole');

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(term.writes.slice(-2)).toEqual(['\x1bc', 'recovered screen']);
  });

  it('frames held behind a replay count against the budget too, and a hole there is recovered by another refresh', async () => {
    TileStatics.LIVE_BACKLOG_BUDGET = 100;
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    fetchMock.mockClear();
    let answer!: (body: string) => void;
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolveBody) => {
          answer = (terminalBuffer) => resolveBody({ data: { terminalBuffer } });
        }),
    }));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { terminalBuffer: 'second capture' } }),
    }));

    ws.receive({ t: 'r' });
    await settle(); // the headers landed: from here frames are held
    out(ws, 'x'.repeat(60));
    out(ws, 'y'.repeat(60)); // the held queue would pass the budget: dropped
    answer('first capture');
    await settle();

    // The capture predates the hole, so nothing after it is written onto it.
    expect(term.writes.slice(-2)).toEqual(['\x1bc', 'first capture']);
    expect(term.writes).not.toContain('y'.repeat(60));
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(term.writes.slice(-2)).toEqual(['\x1bc', 'second capture']);
    out(ws, 'live again');
    expect(term.writes.at(-1)).toBe('live again');
  });

  it('a recovery that keeps failing is retried a bounded number of times, then lets live output through again', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });
    term.throwOnWrite = 'boom';

    out(ws, 'boom');
    out(ws, 'held back');
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
    }

    const { DROP_RECOVERY_MAX_ATTEMPTS } = windowStub.ReverieDroppedOutput as { DROP_RECOVERY_MAX_ATTEMPTS: number };
    expect(fetchMock).toHaveBeenCalledTimes(DROP_RECOVERY_MAX_ATTEMPTS);
    expect(term.writes).not.toContain('held back');
    out(ws, 'flowing');
    expect(term.writes.at(-1)).toBe('flowing'); // never left frozen
  });

  it('a recovery cut off at its deadline is not retried (a stalled link), and lets live output through again', async () => {
    windowStub.AbortController = AbortController;
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    fetchMock.mockClear();
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolveFetch, rejectFetch) => {
          init?.signal?.addEventListener('abort', () => rejectFetch(new Error('aborted')));
        })
    );
    term.throwOnWrite = 'boom';

    out(ws, 'boom');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000); // the full-capture budget runs out
    await settle();

    out(ws, 'flowing');
    expect(term.writes.at(-1)).toBe('flowing');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a reconnect starts the count over, and callbacks from before it count nothing', async () => {
    TileStatics.LIVE_BACKLOG_BUDGET = 100;
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { tile, ws, term } = await connectTile(await makeApp());
    ws.open();
    term.holdParse = true;
    out(ws, 'a'.repeat(60));
    expect(inFlight(tile)).toBe(60);

    ws.drop(1006);
    await vi.advanceTimersByTimeAsync(300);
    FakeSocket.instances.at(-1)!.open(); // reconnected: its refresh replaces the screen
    expect(inFlight(tile)).toBe(0);
    term.parse(); // the old write's callback lands after the reset
    expect(inFlight(tile)).toBe(0);
  });

  it('a reconnect drops a pending recovery: its own refresh replaces the screen', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    serve('');
    term.throwOnWrite = 'boom';
    out(ws, 'boom');

    ws.drop(1006);
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.instances.at(-1)!;
    ws2.open();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the reconnect's refresh
    out(ws2, 'flowing');
    expect(term.writes.at(-1)).toBe('flowing');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('destroy() cancels a pending recovery', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { tile, ws, term } = await connectTile(await makeApp());
    ws.open();
    fetchMock.mockClear();
    term.throwOnWrite = 'boom';
    out(ws, 'boom');
    const flow = tile as unknown as { _dropRecoveryTimer: unknown; _liveDropped: boolean };
    expect(flow._dropRecoveryTimer).not.toBeNull(); // the drop armed one recovery

    tile.destroy();
    // Cleared by destroy() itself, read before any timer runs: the timer's own
    // callback nulls the field and its destroyed guard skips the fetch, so the
    // fetch check below alone cannot tell a cleared timer from a leaked one.
    expect(flow._dropRecoveryTimer).toBeNull();
    expect(flow._liveDropped).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('destroy() starts the count over: a write callback xterm still owed counts nothing', async () => {
    TileStatics.LIVE_BACKLOG_BUDGET = 100;
    const { tile, ws, term } = await connectTile(await makeApp());
    ws.open();
    term.holdParse = true;
    out(ws, 'a'.repeat(60));
    expect(inFlight(tile)).toBe(60);

    tile.destroy();
    expect(inFlight(tile)).toBe(0);
    term.parse(); // a callback from before destroy() carries the old epoch
    expect(inFlight(tile)).toBe(0);
  });
});

describe('the server coming back kicks Pane B', () => {
  it("handleInit's reconnect branch asks the split pane's tile to reconnect without waiting out its backoff", () => {
    // handleInit needs a whole app to run, so the wiring is pinned by source;
    // reconnectNow() itself is exercised above.
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = appSource.indexOf('if (keepTerminal && restoreId === previousActiveId');
    const branch = appSource.slice(start, appSource.indexOf('} else {', start));

    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain('this._splitPane?.reconnectNow?.();');
  });
});

/**
 * xterm's CompositionHelper, reduced to what the keyCode-229 controller touches.
 * Its `_handleAnyTextareaChanges` is xterm's own append-only diff as shipped
 * (node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts), so a
 * control without the controller reproduces the device-log duplicate, and its
 * `triggerDataEvent` feeds the tile's onData, as xterm's core service does.
 */
type Helper = {
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _coreService: { triggerDataEvent: (data: string, wasUserInput?: boolean) => void };
  _handleAnyTextareaChanges: () => void;
};

/**
 * Gives every FakeTerminal created from now on a composition helper. Returns
 * them in creation order, with xterm's own diff each one started with.
 */
function withCompositionHelpers() {
  const helpers: Helper[] = [];
  const originals: Array<Helper['_handleAnyTextareaChanges']> = [];
  FakeTerminal.coreFactory = (term) => {
    const helper: Helper = {
      _isComposing: false,
      _isSendingComposition: false,
      _dataAlreadySent: '',
      _coreService: { triggerDataEvent: (data: string) => term.type(data) },
      _handleAnyTextareaChanges(this: Helper) {
        const oldValue = term.textarea.value;
        setTimeout(() => {
          if (this._isComposing) return;
          const newValue = term.textarea.value;
          const diff = newValue.replace(oldValue, '');
          this._dataAlreadySent = diff;
          if (newValue.length > oldValue.length) this._coreService.triggerDataEvent(diff, true);
          else if (newValue.length < oldValue.length) this._coreService.triggerDataEvent('\x7f', true);
          else if (newValue !== oldValue) this._coreService.triggerDataEvent(newValue, true);
        }, 0);
      },
    };
    helpers.push(helper);
    originals.push(helper._handleAnyTextareaChanges);
    return { _compositionHelper: helper };
  };
  return Object.assign(helpers, { originals });
}

/**
 * Drives a tile the way an Android soft keyboard drives xterm. The fake xterm
 * runs no CompositionHelper.keydown of its own, so `key229()` does what xterm
 * does, in xterm's order: the custom key handler first, then (keyCode 229, no
 * composition) the helper's `_handleAnyTextareaChanges()`, read off the helper
 * at call time so the controller's patch is what runs.
 */
function softKeyboard(term: FakeTerminal, helper: Helper) {
  const textarea = term.textarea;
  const key229 = () => {
    term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 229 });
    helper._handleAnyTextareaChanges();
  };
  return {
    key229,
    /** One appended character, settled on its own timer before the next key. */
    typeKeys(text: string) {
      for (const ch of text) {
        key229();
        textarea.value += ch;
        vi.advanceTimersByTime(1);
      }
    },
    /** The textarea now reads `value` (what the keyboard's input event left there). */
    edit(value: string) {
      textarea.value = value;
    },
    /** Enter: the custom handler, then xterm's own \r, then xterm clearing its textarea. */
    enter() {
      const passed = term.keyHandler!({ type: 'keydown', key: 'Enter', keyCode: 13 });
      if (passed) term.type('\r');
      textarea.value = '';
    },
  };
}

/** Every byte the tile sent as input, in order. */
const joinFrames = (frames: Array<{ d?: string }>) => frames.map((f) => f.d ?? '').join('');
const wireOf = (ws: FakeSocket) => joinFrames(ws.inputFrames());

/** The line a shell ends up with: every DEL erases the character before it. */
function lineOf(frames: Array<{ d?: string }>) {
  const out: string[] = [];
  for (const ch of joinFrames(frames)) {
    if (ch === '\x7f') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

type ControllerTile = Tile & { _keyCode229Recovery: unknown };

describe("TerminalTile wires the primary pane's soft-keyboard controller (#441, #541)", () => {
  it("installs on THIS tile's composition helper and textarea, and destroy() restores xterm's own", async () => {
    const helpers = withCompositionHelpers();
    const { tile, term } = await connectTile(await makeApp());
    const helper = helpers[0];
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();

    // The controller patched this tile's helper (xterm's diff is no longer the one that runs) and
    // listens on this tile's textarea in the CAPTURE phase (see the module's measured table).
    expect(helper._handleAnyTextareaChanges).not.toBe(helpers.originals[0]);
    const captured = term.textareaListeners.filter((l) => l.capture === true).map((l) => l.type);
    expect(captured.sort()).toEqual(['compositionend', 'compositionstart', 'input']);

    tile.destroy();

    expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
    expect(helper._handleAnyTextareaChanges).toBe(helpers.originals[0]);
    expect(term.textareaListeners).toEqual([]);
  });

  it('an autocorrect on space is sent as an edit, not a duplicated line', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const helpers = withCompositionHelpers();
    const app = await makeApp();
    app.activeSessionId = 'some-other-session';
    const { tile, ws, term } = await connectTile(app);
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.typeKeys('testing the peompt');
    // The device log's shape: ONE keydown deleting five characters, a second inserting `rompt `,
    // both before any timer runs.
    kb.key229();
    kb.edit('testing the p');
    kb.key229();
    kb.edit('testing the prompt ');
    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

    const frames = ws.inputFrames();
    expect(lineOf(frames)).toBe('testing the prompt ');
    expect(frames.filter((f) => f.d === '\x7f')).toHaveLength(5);
    // Every byte went to THIS tile's session through the exactly-once queue, never the active one.
    expect(frames.every((f) => Number.isInteger(f.seq))).toBe(true);
    expect(app._pendingDeliveries.has('s-tile')).toBe(false);
    expect(app._pendingDeliveries.has('some-other-session')).toBe(false);
  });

  it('control: without the controller, xterm alone duplicates the line exactly as the device did', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const helpers = withCompositionHelpers();
    const saved = windowStub.ReverieKeyCode229Recovery;
    delete windowStub.ReverieKeyCode229Recovery;
    try {
      const { tile, ws, term } = await connectTile(await makeApp());
      expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
      ws.open();
      const kb = softKeyboard(term, helpers[0]);

      kb.typeKeys('testing the peompt');
      kb.key229();
      kb.edit('testing the p');
      kb.key229();
      kb.edit('testing the prompt ');
      vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

      expect(lineOf(ws.inputFrames())).toBe('testing the peompttesting the prompt rompt ');
    } finally {
      windowStub.ReverieKeyCode229Recovery = saved;
    }
  });

  it('a 229 last character in the same task as Enter goes out ahead of the \\r (#441 + #541)', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const helpers = withCompositionHelpers();
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.typeKeys('hell');
    // One task: the last character's keydown and edit, then Enter, no timer in between.
    kb.key229();
    kb.edit('hello');
    kb.enter();
    // Settled synchronously at the Enter keydown, not by its timer.
    await confirmKeyboardFrames(ws);
    expect(wireOf(ws)).toBe('hello\r');

    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);
    const wire = wireOf(ws);
    expect(wire).toBe('hello\r');
    expect(wire).not.toContain('\x7f');
  });

  it('an autocorrect plus Enter in one task submits the corrected line', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const helpers = withCompositionHelpers();
    const { ws, term } = await connectTile(await makeApp());
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.typeKeys('testing the peompt');
    kb.key229();
    kb.edit('testing the p');
    kb.key229();
    kb.edit('testing the prompt ');
    kb.enter();
    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

    const frames = ws.inputFrames();
    expect(lineOf(frames)).toBe('testing the prompt \r');
    expect(frames.filter((f) => f.d === '\x7f')).toHaveLength(5);
  });

  it('a 229 keystroke xterm diffed itself is delivered once, not again by the recovery', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const helpers = withCompositionHelpers();
    const { tile, ws, term } = await connectTile(await makeApp());
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.key229();
    kb.edit('y');
    term.textarea.fire('input', { inputType: 'insertText', data: 'y', isComposing: false });
    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['y']);
  });
});

describe("the tile's onData tells the controller only about what a human typed", () => {
  /** A keystroke xterm refused: a keydown, then the committed `insertText` it did not forward. */
  const orphan = (term: FakeTerminal, data: string) => {
    term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 65 });
    term.textarea.fire('input', { inputType: 'insertText', data, isComposing: false });
  };

  it('recovers a refused insertText through a query reply and a focus report, to this tile', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const app = await makeApp();
    const { tile, ws, term } = await connectTile(app);
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();
    ws.open();

    orphan(term, 'x');
    term.type('\x1b[?1;2c'); // a DA reply xterm answers on its own: dropped, and not "xterm spoke"
    term.type('\x1b[I'); // a focus report: sent ephemeral, and not "xterm spoke" either
    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

    const frames = ws.inputFrames();
    expect(frames.map((f) => f.d)).toEqual(['\x1b[I', 'x']);
    const recovered = frames.find((f) => f.d === 'x')!;
    expect(Number.isInteger(recovered.seq)).toBe(true);
    expect(app._pendingDeliveries.has('s-tile')).toBe(false);
    expect(app.markIdleAlertSeen).toHaveBeenCalledExactlyOnceWith('s-tile');
  });

  it("never counts the controller's own recovered bytes as xterm's: two refused inserts after one keydown both arrive", async () => {
    // Pins WHERE the notify lives: in the onData lambda, not in _onTerminalData(), which the
    // recovered bytes also go through. Counted there, the first recovery would read as "xterm
    // spoke" for the second candidate, which shares its keydown snapshot, and drop it.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();

    term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 65 });
    term.textarea.fire('input', { inputType: 'insertText', data: 'a', isComposing: false });
    term.textarea.fire('input', { inputType: 'insertText', data: 'b', isComposing: false });
    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['a', 'b']);
  });

  it('stands down when xterm really did deliver the keystroke', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
    const { ws, term } = await connectTile(await makeApp());
    ws.open();

    orphan(term, 'x');
    term.type('x'); // xterm's own canonical emission for this keystroke
    vi.advanceTimersByTime(1);
    await confirmKeyboardFrames(ws);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['x']);
  });
});

describe('the controller can never break a tile', () => {
  type FakeController = {
    handleKeyEvent: ReturnType<typeof vi.fn>;
    notifyCanonicalData: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let saved: unknown;
  beforeEach(() => {
    saved = windowStub.ReverieKeyCode229Recovery;
  });
  afterEach(() => {
    windowStub.ReverieKeyCode229Recovery = saved;
  });

  const fakeController = (overrides: Partial<FakeController> = {}): FakeController => ({
    handleKeyEvent: vi.fn(),
    notifyCanonicalData: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  });

  it('a create() that throws leaves the tile connected and typing', async () => {
    windowStub.ReverieKeyCode229Recovery = {
      create: () => {
        throw new Error('broken');
      },
    };
    const { tile, ws, term } = await connectTile(await makeApp());
    expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
    ws.open();

    term.type('a');
    await expectFrames(ws, 1);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['a']);
  });

  it("a handleKeyEvent that throws leaves every one of the tile's key gates working", async () => {
    const controller = fakeController({
      handleKeyEvent: vi.fn(() => {
        throw new Error('broken');
      }),
    });
    windowStub.ReverieKeyCode229Recovery = { create: () => controller };
    const { term } = await connectTile(await makeApp());

    expect(term.keyHandler!({ type: 'keydown', key: '1', code: 'Digit1', altKey: true })).toBe(false);
    expect(term.keyHandler!({ type: 'keydown', key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(false);
    expect(term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 229 })).toBe(true);
    expect(term.keyHandler!({ type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65 })).toBe(true);
    // It still ran first, for every one of them.
    expect(controller.handleKeyEvent).toHaveBeenCalledTimes(4);
  });

  it('a destroy() that throws still lets the tile dispose its xterm', async () => {
    const controller = fakeController({
      destroy: vi.fn(() => {
        throw new Error('broken');
      }),
    });
    windowStub.ReverieKeyCode229Recovery = { create: () => controller };
    const { tile, term } = await connectTile(await makeApp());
    const dispose = vi.spyOn(term, 'dispose');

    tile.destroy();

    expect(controller.destroy).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
  });

  it('each tile gets its own controller on its own textarea, and destroys only its own', async () => {
    const made: Array<{ options: { textarea: unknown }; controller: FakeController }> = [];
    windowStub.ReverieKeyCode229Recovery = {
      create: (options: { textarea: unknown }) => {
        const controller = fakeController();
        made.push({ options, controller });
        return controller;
      },
    };
    const app = await makeApp();
    const a = await connectTile(app);
    const b = await connectTile(app);

    expect(made).toHaveLength(2);
    expect(made[0].options.textarea).toBe(a.term.textarea);
    expect(made[1].options.textarea).toBe(b.term.textarea);

    a.tile.destroy();

    expect(made[0].controller.destroy).toHaveBeenCalledTimes(1);
    expect(made[1].controller.destroy).not.toHaveBeenCalled();
  });
});

describe('terminal-tile.js keeps the controller call where it works (source pin)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-tile.js'), 'utf8');

  it('calls handleKeyEvent ABOVE the IME early return, so a 229 keydown reaches it', () => {
    const call = source.indexOf('this._keyCode229Recovery?.handleKeyEvent?.(ev)');
    const earlyReturn = source.indexOf("ev.key === 'Process' || ev.keyCode === 229) return true");
    expect(call).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(call).toBeLessThan(earlyReturn);
  });

  it("hands the controller this tile's own composition helper", () => {
    expect(source).toMatch(/getCompositionHelper:\s*\(\)\s*=>\s*this\.terminal\?\._core\?\._compositionHelper/);
  });
});
