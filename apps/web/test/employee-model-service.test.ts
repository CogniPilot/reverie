/**
 * The employee model service against a scripted session: what it types, when it refuses, and how a
 * per-model limit is left and later restored. Frames: test/fixtures/claude-model-frames.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  EmployeeModelError,
  EmployeeModelService,
  type ModelEmployee,
  type ModelSession,
} from '../src/employee-model-service.js';
import { EmployeeModelStore } from '../src/employee-model-store.js';
import { DRAFT, FOOTER, IDLE, MENU, NOTICE, NOW, WORKING, frame } from './fixtures/claude-model-frames.js';

const RESET = Date.UTC(2026, 10, 26, 4, 0);

class FakeSession implements ModelSession {
  readonly id = 'session-1';
  mode = 'claude';
  pid: number | null = 42;
  isWorking = false;
  providerDispatchHeld = false;
  terminalInputHeld = false;
  paneDialog: string | null = null;
  displayModel: { model: string } | undefined = { model: 'Fable 5.2' };
  screen: string = IDLE;
  writes: Array<{ data: string; options?: { requireIdle?: boolean; requireEmptyComposer?: boolean } }> = [];
  /** What the CLI does with a typed `/model <id>`: report this display name. */
  answers: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-2': 'Fable 5.2' };
  /** What Escape leaves on screen. */
  afterEscape = IDLE;
  refreshed = 0;
  readScreen() {
    return this.screen;
  }
  async readScreenAsync() {
    return this.screen;
  }
  startupScreen() {
    return null;
  }
  refreshPaneDialog() {
    this.refreshed++;
  }
  async writeViaMux(data: string, options?: { requireIdle?: boolean; requireEmptyComposer?: boolean }) {
    this.writes.push({ data, ...(options ? { options } : {}) });
    if (data === '\x1b') this.screen = this.afterEscape;
    const model = /^\/model (\S+)\r$/.exec(data)?.[1];
    if (model && this.answers[model]) this.displayModel = { model: this.answers[model] };
    return true;
  }
}

function harness(options: { fallback?: string | null; mode?: string } = {}) {
  let now = NOW;
  const session = new FakeSession();
  if (options.mode) session.mode = options.mode;
  const store = new EmployeeModelStore(undefined);
  const posts: string[] = [];
  const logs: string[] = [];
  const employee: ModelEmployee = {
    id: 'employee-1',
    name: 'Stan',
    sessionId: session.id,
    onVacation: false,
    desiredRunning: true,
  };
  const service = new EmployeeModelService({
    store,
    employees: () => [employee],
    session: (id) => (id === session.id ? session : undefined),
    takesModel: (mode) => mode === 'claude',
    glyph: () => '❯',
    fallbackModel: () => (options.fallback === undefined ? 'claude-opus-5-5' : options.fallback),
    timeZone: () => 'UTC',
    post: (_owner, text) => posts.push(text),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (line) => logs.push(line),
  });
  return { service, session, store, posts, logs, employee, advance: (ms: number) => (now += ms), at: () => now };
}

const typed = (session: FakeSession) => session.writes.map((write) => write.data);

describe('choosing a model', () => {
  it('types /model into an idle empty composer through the gated write and reports it applied', async () => {
    const h = harness();
    const status = await h.service.choose(h.employee, { model: 'claude-opus-5-5' }, 'owner');
    expect(h.session.writes).toEqual([
      { data: '/model claude-opus-5-5\r', options: { requireIdle: true, requireEmptyComposer: true } },
    ]);
    expect(status).toMatchObject({
      state: 'applied',
      live: 'Opus 5.5',
      target: 'claude-opus-5-5',
      preferred: { model: 'claude-opus-5-5', by: 'owner' },
    });
    expect(h.store.get('employee-1').preferred?.model).toBe('claude-opus-5-5');
  });

  for (const [name, setup, reason] of [
    ['a non-empty composer', (s: FakeSession) => (s.screen = DRAFT), 'something is typed in its composer'],
    ['a limit menu', (s: FakeSession) => (s.screen = MENU), 'a usage-limit menu is showing'],
    ['a pane mid-turn', (s: FakeSession) => (s.isWorking = true), 'it is in the middle of a turn'],
    ['a working frame', (s: FakeSession) => (s.screen = WORKING), 'it is in the middle of a turn'],
    [
      'a first-run screen',
      (s: FakeSession) => (s.startupScreen = () => ({ screen: 'theme' })),
      'a start-up screen is showing',
    ],
    ['held input', (s: FakeSession) => (s.terminalInputHeld = true), 'its terminal input is held'],
  ] as const) {
    it(`never types into ${name}: the choice is kept pending`, async () => {
      const h = harness({ fallback: null });
      setup(h.session);
      const status = await h.service.choose(h.employee, { model: 'claude-opus-5-5' }, 'owner');
      expect(h.session.writes).toEqual([]);
      expect(status).toMatchObject({ state: 'pending', reason });
      expect(h.store.get('employee-1').preferred?.model).toBe('claude-opus-5-5');
    });
  }

  it('applies a pending choice at the next idle tick, and the effort after it', async () => {
    const h = harness({ fallback: null });
    h.session.screen = DRAFT;
    await h.service.choose(h.employee, { model: 'claude-opus-5-5', effort: 'high' }, 'employee Burt');
    expect(h.session.writes).toEqual([]);
    h.session.screen = IDLE;
    await h.service.tick();
    await h.service.tick();
    await h.service.tick();
    expect(typed(h.session)).toEqual(['/model claude-opus-5-5\r', '/effort high\r']);
    expect(h.service.status(h.employee).state).toBe('applied');
  });

  it('switches a relaunched session that came back on another model', async () => {
    const h = harness({ fallback: null });
    await h.service.choose(h.employee, { model: 'claude-opus-5-5' }, 'owner');
    h.session.displayModel = { model: 'Fable 5.2' };
    h.session.pid = 43;
    await h.service.tick();
    expect(typed(h.session)).toEqual(['/model claude-opus-5-5\r', '/model claude-opus-5-5\r']);
  });

  it('stops after a bounded number of unconfirmed tries', async () => {
    const h = harness({ fallback: null });
    h.session.answers = {};
    const first = await h.service.choose(h.employee, { model: 'claude-nonexistent-1' }, 'owner');
    expect(first.state).toBe('pending');
    for (let i = 0; i < 6; i++) {
      h.advance(30_000);
      await h.service.tick();
    }
    expect(typed(h.session)).toEqual(Array(3).fill('/model claude-nonexistent-1\r'));
    expect(h.service.status(h.employee)).toMatchObject({ state: 'failed' });
  });

  it('refuses a CLI that does not take a model this way', async () => {
    const h = harness({ mode: 'codex' });
    await expect(h.service.choose(h.employee, { model: 'claude-opus-5-5' }, 'owner')).rejects.toBeInstanceOf(
      EmployeeModelError
    );
    expect(h.session.writes).toEqual([]);
    expect(h.store.get('employee-1')).toEqual({});
  });
});

describe('leaving a model that reached its limit', () => {
  for (const [name, screen, escape] of [
    ['its menu', MENU, true],
    ['its auto-continue footer', FOOTER, true],
    ['its notice', NOTICE, false],
  ] as const) {
    it(`answers ${name} with Escape only, switches, nudges and says so once`, async () => {
      const h = harness();
      h.session.screen = screen;
      h.session.paneDialog = escape ? 'Esc to cancel' : null;
      await h.service.tick();
      const keys = typed(h.session);
      expect(keys[0]).toBe(escape ? '\x1b' : '/model claude-opus-5-5\r');
      expect(keys).toContain('/model claude-opus-5-5\r');
      // Never a menu choice: no digit, no bare Enter.
      expect(keys.some((key) => /^[0-9]\r?$|^\r$/.test(key))).toBe(false);
      expect(keys.at(-1)).toMatch(
        /^Reverie: your fable usage limit was reached, so you now run on claude-opus-5-5 .*Continue where you left off\.\r$/
      );
      expect(h.session.refreshed).toBe(escape ? 1 : 0);
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0]).toMatch(
        /^Stan: Fable 5\.2 reached its usage limit, switched to claude-opus-5-5( until .+)?\.$/
      );
      expect(h.store.get('employee-1').fallback).toMatchObject({
        from: 'Fable 5.2',
        to: 'claude-opus-5-5',
        restore: 'claude-fable-5-2',
      });
      await h.service.tick();
      expect(h.posts).toHaveLength(1);
    });
  }

  it('names the stated reset time in the office line', async () => {
    const h = harness();
    h.session.screen = NOTICE;
    await h.service.tick();
    expect(h.posts).toEqual([
      'Stan: Fable 5.2 reached its usage limit, switched to claude-opus-5-5 until Nov 26, 4:00 AM UTC.',
    ]);
    expect(h.store.get('employee-1').fallback?.resetAt).toBe(RESET);
  });

  it('waits when Escape does not close the prompt, and types nothing else', async () => {
    const h = harness();
    h.session.screen = MENU;
    h.session.afterEscape = MENU;
    await h.service.tick();
    expect(typed(h.session)).toEqual(['\x1b', '\x1b']);
    expect(h.store.get('employee-1').fallback).toBeUndefined();
    expect(h.posts).toEqual([]);
  });

  it('switches back after the reset and forgets the fallback', async () => {
    const h = harness();
    h.session.screen = NOTICE;
    await h.service.tick();
    h.session.screen = frame(['● Back at work.'], { model: 'Opus 5.5' });
    const before = h.session.writes.length;
    h.advance(RESET - h.at() + 60_000);
    await h.service.tick();
    // Inside the two-minute buffer after the stated reset: nothing yet.
    expect(h.session.writes).toHaveLength(before);
    h.advance(120_000);
    await h.service.tick();
    expect(typed(h.session).at(-1)).toBe('/model claude-fable-5-2\r');
    expect(h.session.displayModel).toEqual({ model: 'Fable 5.2' });
    expect(h.store.get('employee-1').fallback).toBeUndefined();
    expect(h.logs.some((line) => line.includes('back on claude-fable-5-2'))).toBe(true);
  });

  it('does nothing when the company turned the switch off, or for an account-wide limit', async () => {
    const off = harness({ fallback: null });
    off.session.screen = MENU;
    await off.service.tick();
    expect(off.session.writes).toEqual([]);
    const account = harness();
    account.session.screen = frame(["  ⎿  You've hit your limit · resets 1:40pm (America/New_York)"]);
    await account.service.tick();
    expect(account.session.writes).toEqual([]);
  });

  it('lets a person’s choice replace a fallback in force', async () => {
    const h = harness();
    h.session.screen = NOTICE;
    await h.service.tick();
    h.session.screen = IDLE;
    const status = await h.service.choose(h.employee, { model: 'claude-fable-5-2' }, 'owner');
    expect(status).toMatchObject({ state: 'applied', target: 'claude-fable-5-2' });
    expect(status.fallback).toBeUndefined();
  });
});
