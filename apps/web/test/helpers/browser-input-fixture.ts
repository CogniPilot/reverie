/** Actual journal/delivery code with fake-indexeddb transactions. Web Locks below
 * model exclusive page leases only; real Chromium acceptance owns browser proof. */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { vi } from 'vitest';

export class FixtureLocks {
  private readonly pending = new Map<string, Promise<void>>();
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string; mode: string } | null) => T | Promise<T>
  ): Promise<T> {
    const prior = this.pending.get(name);
    if (prior && options.ifAvailable) return Promise.resolve(callback(null));
    const result = (prior || Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
    const settled = result.then(
      () => {},
      () => {}
    );
    this.pending.set(name, settled);
    void settled.then(() => {
      if (this.pending.get(name) === settled) this.pending.delete(name);
    });
    return result;
  }
}
export type InputRow = {
  sid: string;
  issuer: string;
  seq: number;
  data: string;
  useMux: boolean | null;
  phase: string;
  fingerprint: string;
  revision: number;
};
export interface RawInputBuffer {
  readonly sessionId: string;
  readonly data: string;
  readonly revision: number;
  append(text: string): boolean;
  flush(): Promise<boolean>;
}
export interface InputApp {
  _inputJournal: {
    issuer: string;
    snapshot(): Promise<{ records: InputRow[]; retained: InputRow[]; holds: { sid: string; reason: string }[] }>;
    close(): void;
    accept(
      sid: string,
      frames: string[],
      useMux?: boolean | null,
      reservation?: object
    ): Promise<{ kind: string; records?: InputRow[] }>;
  };
  _inputJournalReady: Promise<boolean>;
  _pendingDeliveries: Map<string, InputRow[]>;
  _inputFlights: Map<string, { record: InputRow }>;
  _inputOutcomes: Map<string, Promise<void>>;
  _inputDrainTasks: Map<string, Promise<void>>;
  _inputRetryAt: Map<string, number>;
  _inputRecoveryHolds?: Set<string>;
  _inputStorageUnavailable?: boolean;
  _unsavedInputDrafts: { sid: string; text: string }[];
  _clientId: string;
  _ws: { readyState: number; send(data: string): void } | null;
  _wsSessionId: string | null;
  _sendInputEphemeral(sid: string, text: string): void;
  _inputSocketFor(sid: string): { ws: { readyState: number; send(data: string): void }; lastRecvAt: number } | null;
  _registerInputSocket(
    sid: string,
    handle: { ws: { readyState: number; send(data: string): void }; lastRecvAt: number }
  ): void;
  _unregisterInputSocket(sid: string, handle: object): void;
  _onWsReady(sid: string): void;
  _loadReliableState(): Promise<boolean>;
  _retainUnqueuedInput(sid: string, text: string): void;
  _createRawInputBuffer(sid: string, changed?: (owner: RawInputBuffer) => void): RawInputBuffer;
  _flushLocalEchoTo(sid: string): Promise<boolean>;
  _sendInputAsync(sid: string, text: string, options?: { useMux?: boolean }): Promise<boolean>;
  _drainSession(sid: string): Promise<void>;
  _redeliverSweep(): void;
  _onWsInputAck(seq: number, message: object, sid?: string): Promise<void>;
  _onWsInputRefusal(seq: number, message: object, sid: string): Promise<void>;
  showToast: ReturnType<typeof vi.fn>;
}
export type InputFetch = (url: string, options?: RequestInit) => Promise<Response>;
export type IntakeSnapshot = {
  chars: number;
  units: number;
  rawPaused: boolean;
  pending: Array<{ sid: string; accepted: boolean }>;
  copies: Array<{ sid: string; text: string }>;
};
const publicRoot = resolve(import.meta.dirname, '../../src/web/public');
const source = ['constants.js', 'app.js', 'browser-input-journal.js', 'input-delivery.js']
  .map((name) => readFileSync(resolve(publicRoot, name), 'utf8'))
  .join('\n');

export function browserInputFixture() {
  const indexedDB = new IDBFactory(),
    locks = new FixtureLocks(),
    storage = new Map<string, string>();
  const apps: InputApp[] = [];
  const keyboards = new WeakMap<InputApp, object>();
  const intakes = new WeakMap<InputApp, { snapshot(): IntakeSnapshot }>();
  let epoch = 1;
  let transactionFault = false;
  let strictFault: 'throw' | 'ignored' | null = null;
  const transactionOptions: Array<IDBTransactionOptions | undefined> = [];
  const transaction = IDBDatabase.prototype.transaction;
  // Each opened database is wrapped below, never the shared IDB prototype.
  const request = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args: Parameters<typeof request>) => {
    const opened = request(...args);
    opened.addEventListener('success', () => {
      opened.result.transaction = function (...args: Parameters<typeof transaction>) {
        transactionOptions.push(args[2]);
        if (strictFault && args[1] === 'readwrite') {
          if (strictFault === 'throw') throw new DOMException('Strict storage is unsupported', 'NotSupportedError');
          args[2] = { durability: 'default' };
        }
        const tx = transaction.apply(this, args);
        if (transactionFault && args[1] === 'readwrite') queueMicrotask(() => tx.abort());
        return tx;
      };
    });
    return opened;
  };
  async function page(
    effect: InputFetch = async () => Response.json({ success: true, data: {} }),
    scripts: string[] = [],
    display: {
      transcriptPageKeys?: string[];
      now?: () => number;
      document?: object;
      mobileDetection?: object;
      mutationObserver?: unknown;
    } = {}
  ) {
    const context: Record<string, unknown> = {
      indexedDB,
      navigator: { locks },
      crypto: webcrypto,
      __reverieTranscriptPageKeys: display.transcriptPageKeys,
      addEventListener() {},
      removeEventListener() {},
    };
    const fetch: InputFetch = (url, options) =>
      url === '/api/input-identity'
        ? Promise.resolve(
            Response.json({ success: true, data: { version: 1, kind: 'session', scopeId: 'owned-fixture', epoch } })
          )
        : effect(url, options);
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      length: 0,
      key: () => null,
    };
    // Same JS realm is intentional: fake-indexeddb structuredClone returns
    // ordinary objects in this realm, as a real page's IndexedDB does there.
    const globals = {
      window: context,
      globalThis: context,
      document: display.document || {
        addEventListener() {},
        getElementById: () => null,
        documentElement: { dataset: {} },
      },
      localStorage,
      fetch,
      WebSocket: { OPEN: 1 },
      HTMLCanvasElement: class {},
      MobileDetection: display.mobileDetection || {},
      MutationObserver: display.mutationObserver,
      performance: { now: () => display.now?.() ?? performance.now() },
    };
    const extra = scripts.map((name) => readFileSync(resolve(publicRoot, name), 'utf8')).join('\n');
    const load = new Function(
      ...Object.keys(globals),
      `${source}\n${extra}\nreturn {App: ReverieApp,
      keyboard: typeof KeyboardAccessoryBar === 'undefined' ? null : KeyboardAccessoryBar,
      intake: window.ReverieInputJournal.intake,
      setApp(value) {app = value;}};`
    );
    const { App, keyboard, intake, setApp } = load(...Object.values(globals)) as {
      App: { prototype: object };
      keyboard: object | null;
      intake: { snapshot(): IntakeSnapshot };
      setApp(value: InputApp): void;
    };
    const app = Object.assign(Object.create(App.prototype), {
      activeSessionId: 'session-1',
      sessions: new Map(),
      _ws: null,
      _wsSessionId: null,
      showToast: vi.fn(),
      _updateConnectionIndicator: vi.fn(),
      markIdleAlertSeen: vi.fn(),
    }) as InputApp;
    apps.push(app);
    intakes.set(app, intake);
    if (keyboard) keyboards.set(app, keyboard);
    context.app = app;
    setApp(app);
    if (!(await app._loadReliableState())) throw new Error('Actual journal initialization failed');
    return app;
  }
  return {
    page,
    intake(app: InputApp) {
      const intake = intakes.get(app);
      if (!intake) throw new Error('Unknown fixture page');
      return intake;
    },
    keyboard(app: InputApp): object {
      const bar = keyboards.get(app);
      if (!bar) throw new Error('The actual keyboard module was not loaded for this app');
      return bar;
    },
    storage,
    locks,
    transactionOptions,
    refuseStrict: (mode: 'throw' | 'ignored') => {
      strictFault = mode;
    },
    abortWrites: (value = true) => {
      transactionFault = value;
    },
    changeIdentity: () => {
      epoch++;
    },
    async close() {
      for (const app of apps) app._inputJournal?.close();
      // Resolve lease-release continuations before a later test starts.
      await Promise.resolve();
    },
  };
}
