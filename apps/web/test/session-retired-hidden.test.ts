/**
 * A session replaced after a plan switch is "retired": its row carries `retired`, and the page keeps it out of every tab list (initial state,
 * a created or updated session); a restore (the flag gone) brings it back as a tab. Loaded via `vm` with a stubbed context, like
 * session-close-fallback.test.ts. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadReverieAppClass() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const constants = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const source = readFileSync(resolve(dir, 'app.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__ReverieApp = ReverieApp;`, context);
  return (context as { __ReverieApp: new () => unknown }).__ReverieApp;
}

const ReverieApp = loadReverieAppClass();
const OLD = 'session-old';
const NEW = 'session-new';

type TestApp = Record<string, unknown> & {
  _onSessionCreated: (data: Record<string, unknown>) => void;
  _onSessionUpdated: (data: Record<string, unknown>) => void;
  handleInit: (data: Record<string, unknown>) => void;
  sessionOrder: string[];
  sessions: Map<string, Record<string, unknown>>;
  _onSessionDeleted: (data: { id: string }) => void;
};

function makeApp(): TestApp {
  const app = Object.create((ReverieApp as { prototype: object }).prototype) as TestApp;
  app.activeSessionId = null;
  app.sessionOrder = [];
  app.sessions = new Map();
  app._closingSessions = new Set();
  app.detachedSessions = new Set();
  app.isSoloWindow = false;
  app._wsSessionId = null;
  app.terminal = { clear: vi.fn() };
  app._cleanupSessionData = vi.fn((id: string) => {
    app.sessions.delete(id);
    const i = app.sessionOrder.indexOf(id);
    if (i !== -1) app.sessionOrder.splice(i, 1);
  });
  app.syncSessionOrder = vi.fn(function (this: TestApp) {
    for (const id of this.sessions.keys()) if (!this.sessionOrder.includes(id)) this.sessionOrder.push(id);
  });
  for (const name of ['renderSessionTabs', 'renderRalphStatePanel', 'renderProjectInsightsPanel', 'updateCost', 'stopSystemStatsPolling', 'startSystemStatsPolling', 'showWelcome', 'showToast', '_disconnectWs', '_redock', 'updateRespawnTokens', 'markSessionTabEntering', 'markTerminalEntering', 'markConnectionLineEntering', 'updateSubagentParentNames', 'recheckOrphanSubagents', 'updateConnectionLines', 'syncTabGroupsAfterUpdate', '_maybeAlertIdle']) {
    app[name] = vi.fn();
  }
  return app;
}

describe('retired sessions stay out of the tab list', () => {
  it('a created session that is retired gets no tab, and a later update without the flag (a restore) gives it one', () => {
    const app = makeApp();
    app._onSessionCreated({ id: OLD, retired: true });
    expect(app.sessions.has(OLD)).toBe(false);
    expect(app.sessionOrder).toEqual([]);
    app._onSessionUpdated({ session: { id: OLD, status: 'idle' } });
    expect(app.sessions.has(OLD)).toBe(true);
    expect(app.sessionOrder).toEqual([OLD]);
  });

  it('an update that retires an open session removes its tab, and the active one lands on the home screen', () => {
    const app = makeApp();
    app._onSessionCreated({ id: OLD });
    app._onSessionCreated({ id: NEW });
    app.activeSessionId = OLD;
    app._onSessionUpdated({ session: { id: OLD, retired: true } });
    expect(app.sessions.has(OLD)).toBe(false);
    expect(app.sessionOrder).toEqual([NEW]);
    expect(app.showWelcome).toHaveBeenCalled();
    // further updates for it while retired are ignored
    app._onSessionUpdated({ session: { id: OLD, retired: true, status: 'busy' } });
    expect(app.sessions.has(OLD)).toBe(false);
  });

  it('the initial state leaves retired sessions out (the one line that does it, run against the real handler source)', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    expect(src).toContain('data.sessions = data.sessions.filter((s) => !s.retired);');
    expect(src).toContain('(this._retiredHidden ||= new Set()).add(s.id)');
  });

  it('ordinary updates for a session that was never retired still just update it', () => {
    const app = makeApp();
    app._onSessionCreated({ id: NEW, name: 'a' });
    app._onSessionUpdated({ session: { id: NEW, name: 'b' } });
    expect(app.sessions.get(NEW)?.name).toBe('b');
    expect(app.sessionOrder).toEqual([NEW]);
  });
});
