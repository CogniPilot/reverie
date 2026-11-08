/**
 * @fileoverview Teammate terminal, client side.
 *
 * - `rebuildTeammateMap` fills `teammatePanesByName` with every teammate that has its own tmux pane
 *   (`%N`) in a team with a lead session, so the teammate window opens as a terminal. The lead, an
 *   in-process teammate and a stale entry are left out.
 * - `loadTeams` reads `GET /api/teams` into `teams` and rebuilds both maps; a failed read keeps them.
 * - `initTeammateTerminal` reads the pane now and every 2 s while the window is in the page, redraws
 *   only when the pane changed, and stops once the window is gone.
 * - A rapid minimize, re-open and close (subagent-windows.js's real minimize path) leaves no timer
 *   behind, and a reply that arrives for a disposed or replaced terminal is never written.
 *
 * Real code under test: panels-ui.js and subagent-windows.js in a `vm` context against a stub app
 * and a minimal fake DOM (no jsdom), as in folder-grid-ui.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

const TEAM = {
  name: 'zorblat-team',
  leadSessionId: 's1',
  members: [
    { agentId: 'lead@zorblat-team', name: 'team-lead', agentType: 'team-lead', tmuxPaneId: '%1' },
    { agentId: 'tester@zorblat-team', name: 'tester', agentType: 'general-purpose', tmuxPaneId: '%7', color: 'green' },
    { agentId: 'inline@zorblat-team', name: 'inline', agentType: 'general-purpose', tmuxPaneId: 'in-process' },
    { agentId: 'plain@zorblat-team', name: 'plain', agentType: 'general-purpose' },
  ],
};

class FakeTerminal {
  static last: FakeTerminal;
  written: string[] = [];
  resets = 0;
  disposed = false;
  unicode = { activeVersion: '' };
  constructor() {
    FakeTerminal.last = this;
  }
  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler() {}
  onData() {}
  write(s: string) {
    this.written.push(s);
  }
  dispose() {
    this.disposed = true;
  }
  reset() {
    this.resets++;
    this.written = [];
  }
}

function loadApp(fetchImpl: (url: string) => unknown) {
  const ReverieApp = function ReverieApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const inPage = new Set<unknown>();
  const context = vm.createContext({
    ReverieApp,
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { getElementById: () => null, contains: (node: unknown) => inPage.has(node), addEventListener: () => {} },
    window: {
      addEventListener: vi.fn(),
      reverieCurrentXtermTheme: () => ({}),
      reverieCurrentSkinIsLight: () => false,
      ReverieTerminalFont: { resolve: () => 'monospace', resolveWeights: () => ({}) },
    },
    Terminal: FakeTerminal,
    FitAddon: {
      FitAddon: class {
        fit() {}
      },
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    DEFAULT_SCROLLBACK: 1000,
    // Late-bound so vi.useFakeTimers() reaches code running in the context.
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    fetch: vi.fn(async (url: string) => fetchImpl(url)),
  });
  for (const file of ['panels-ui.js', 'subagent-windows.js'])
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new ReverieApp() as Record<string, any>;
  app.teams = new Map();
  app.teammateMap = new Map();
  app.teammatePanesByName = new Map();
  app.teammateTerminals = new Map();
  app.subagentWindows = new Map();
  return { app, inPage, fetch: context.fetch as ReturnType<typeof vi.fn> };
}

const json = (body: unknown) => ({ json: async () => body });

describe('rebuildTeammateMap', () => {
  it("maps each teammate with its own tmux pane to the lead's session", () => {
    const { app } = loadApp(() => json({}));
    app.teammatePanesByName.set('gone', { paneTarget: '%3', sessionId: 'old', color: 'red' });
    app.teams.set(TEAM.name, TEAM);
    app.rebuildTeammateMap();
    expect([...app.teammatePanesByName.entries()]).toEqual([
      ['tester', { paneTarget: '%7', sessionId: 's1', color: 'green' }],
    ]);
    expect([...app.teammateMap.keys()]).toEqual(['tester', 'inline', 'plain']);
  });

  it('maps no pane for a team without a lead session', () => {
    const { app } = loadApp(() => json({}));
    app.teams.set(TEAM.name, { ...TEAM, leadSessionId: '' });
    app.rebuildTeammateMap();
    expect(app.teammatePanesByName.size).toBe(0);
  });
});

describe('loadTeams', () => {
  it('reads /api/teams and rebuilds both maps', async () => {
    const { app, fetch } = loadApp(() => json({ success: true, data: [TEAM, { name: 'broken' }] }));
    await app.loadTeams();
    expect(fetch).toHaveBeenCalledWith('/api/teams');
    expect([...app.teams.keys()]).toEqual([TEAM.name]);
    expect(app.teammatePanesByName.get('tester')).toEqual({ paneTarget: '%7', sessionId: 's1', color: 'green' });
  });

  it('keeps the teams it had when the read fails', async () => {
    const { app } = loadApp(() => {
      throw new Error('offline');
    });
    app.teams.set(TEAM.name, TEAM);
    app.rebuildTeammateMap();
    await app.loadTeams();
    expect(app.teams.size).toBe(1);
    expect(app.teammatePanesByName.has('tester')).toBe(true);
  });
});

describe('initTeammateTerminal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads the pane every 2 s, redraws only on change, and stops when the window is gone', async () => {
    vi.useFakeTimers();
    let pane = 'frame one';
    const { app, inPage, fetch } = loadApp(() => json({ success: true, data: { buffer: pane } }));
    const body = { innerHTML: '', classList: { add() {} } };
    const windowElement = { querySelector: () => body, classList: { add() {} } };
    inPage.add(body);
    app.initTeammateTerminal('tester@zorblat-team', { paneTarget: '%7', sessionId: 's1' }, windowElement);

    await vi.advanceTimersByTimeAsync(100);
    const terminal = FakeTerminal.last;
    const reads = () => fetch.mock.calls.filter(([url]) => url === '/api/sessions/s1/teammate-pane-buffer/%257').length;
    expect(reads()).toBe(1);
    expect(terminal.written).toEqual(['frame one']);

    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()).toBe(2);
    expect(terminal.resets).toBe(1); // unchanged pane: no second redraw

    pane = 'frame two';
    await vi.advanceTimersByTimeAsync(2000);
    expect(terminal.written).toEqual(['frame two']);
    expect(terminal.resets).toBe(2);

    inPage.delete(body);
    await vi.advanceTimersByTimeAsync(6000);
    expect(reads()).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('teammate terminal lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const AGENT = 'tester@zorblat-team';
  const PANE = { paneTarget: '%7', sessionId: 's1' };
  const windowFor = (body: unknown) => ({ querySelector: () => body, classList: { add() {} } });

  it('a rapid minimize, re-open and close leaves no timer and writes nothing to a disposed terminal', async () => {
    vi.useFakeTimers();
    const replies: Array<(value: unknown) => void> = [];
    const { app, inPage } = loadApp(() => new Promise((done) => replies.push(done)));
    const body = { innerHTML: '', classList: { add() {} } };
    inPage.add(body);
    app.initTeammateTerminal(AGENT, PANE, windowFor(body));
    await vi.advanceTimersByTimeAsync(50); // the terminal is open; its delayed start is still pending
    const first = FakeTerminal.last;
    app._disposeTeammateTerminalForMinimize(AGENT);
    app.initTeammateTerminal(AGENT, PANE, windowFor(body));
    await vi.advanceTimersByTimeAsync(150); // the re-opened terminal has started and asked for the pane
    const second = FakeTerminal.last;
    expect(second).not.toBe(first);
    expect(replies).toHaveLength(1); // the first terminal's cancelled start never asked
    app._disposeTeammateTerminalForMinimize(AGENT);
    replies.forEach((done) => done(json({ success: true, data: { buffer: 'late' } })));
    await vi.advanceTimersByTimeAsync(6300);
    expect(vi.getTimerCount()).toBe(0);
    expect(replies).toHaveLength(1);
    expect([first.disposed, second.disposed]).toEqual([true, true]);
    expect([first.written, second.written]).toEqual([[], []]);
  });

  it('a reply for a replaced terminal is dropped, and the new one draws its own', async () => {
    vi.useFakeTimers();
    const replies: Array<(value: unknown) => void> = [];
    const { app, inPage } = loadApp(() => new Promise((done) => replies.push(done)));
    const body = { innerHTML: '', classList: { add() {} } };
    inPage.add(body);
    app.initTeammateTerminal(AGENT, PANE, windowFor(body));
    await vi.advanceTimersByTimeAsync(100);
    const first = FakeTerminal.last;
    app._disposeTeammateTerminalForMinimize(AGENT);
    app.initTeammateTerminal(AGENT, PANE, windowFor(body));
    await vi.advanceTimersByTimeAsync(100);
    const second = FakeTerminal.last;
    expect(replies).toHaveLength(2);
    replies[0](json({ success: true, data: { buffer: 'old frame' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect([first.written, second.written]).toEqual([[], []]);
    replies[1](json({ success: true, data: { buffer: 'new frame' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.written).toEqual(['new frame']);
    app._disposeTeammateTerminalForMinimize(AGENT);
    expect(vi.getTimerCount()).toBe(0);
  });
});
