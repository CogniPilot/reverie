import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit, writeGateActive } from '../src/submit-settle.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

// A plan move owns the composer of its source and its replacement (pauseCapacityRetry), and types its handoff there. An
// agent's input (send or wake: the request names its calling session) must not type into it meanwhile, or on Claude Code
// the handoff is appended to the agent's text. A person's own typing stays allowed (ungated-writer audit, 2026-10-29).
const CLAUDE_EMPTY = '● Done.\n────────────────────────────────\n❯ \n────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// `holdAt`: where a plan move takes the composer after the route's early check passed. 'probe': during the route's wake-target
// await; 'settle': after the agent's text went in, while it settles before Enter.
async function harness(holdAt?: 'probe' | 'settle') {
  let hold: (() => void) | undefined;
  let composer = '';
  const screen = () => CLAUDE_EMPTY.replace('❯ ', `❯ ${composer}`);
  const keys: string[] = [];
  const io = {
    capture: screen,
    sleep: async () => { if (holdAt === 'settle' && composer) hold ??= session.pauseCapacityRetry(); },
    typeText: async (text: string) => { keys.push(text); composer += text; },
    sendEnter: async () => { keys.push('Enter'); composer = ''; },
  };
  const mux = {
    capturePaneText: screen,
    sendInput: vi.fn(async (_id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) => {
      const text = input.replace(/\r/g, '');
      // As tmux-manager: a gated write is only ever text + Enter; any other shape is refused before a key.
      if (writeGateActive() && !(text && input.includes('\r'))) return false;
      if (!input.includes('\r')) { keys.push(text); composer += text; return true; }
      return (await typeAndSubmit(io, text, { glyph: '❯', workingLine: 'esc to interrupt' }, 'move-hold', options.requireEmptyComposer)) !== 'not-written';
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'claude', useMux: true, mux: mux as never,
    muxSession: { muxName: 'reverie-owned-review', sessionId: 'test-session-1', pid: 42 } as never });
  ctx.sessions.set(session.id, session as never);
  const pty = { write: vi.fn() };
  Object.assign(session, { ptyProcess: pty });
  const hasWakeTarget = vi.fn(async () => {
    if (holdAt === 'probe') hold ??= session.pauseCapacityRetry();
    await Promise.resolve();
    return false;
  });
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner, remoteWake: { hasWakeTarget } as never });
  installRouteErrorHandler(app);
  await app.ready();
  cleanups.push(async () => {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
    await app.close();
  });
  let seq = 0;
  const input = (text: string, agent: boolean, ifIdle = false, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/api/sessions/test-session-1/input',
    headers: agent ? { 'x-reverie-parent-session': 'another-agent' } : {},
    payload: { input: `${text}\r`, clientId: 'review', seq: ++seq, ...(ifIdle ? { ifIdle: true } : {}), ...extra },
  });
  return { session, keys, input, pty, release: () => hold?.(), seq: () => seq };
}

const BUSY = { status: 200, code: 'SESSION_BUSY' }; // the /api/v1 adapter maps it to 409
const shape = (r: { statusCode: number; json(): { errorCode?: string } }) => ({ status: r.statusCode, code: r.json().errorCode });

it('refuses an agent\'s send and wake while a plan move owns the composer, so its handoff is not appended to them', async () => {
  const { session, keys, input } = await harness();
  const release = session.pauseCapacityRetry(); // the plan move's hold, as plan-move-runtime takes it

  const send = await input('agent note', true);
  expect({ status: send.statusCode, code: send.json().errorCode }).toEqual({ status: 200, code: 'SESSION_BUSY' }); // the /api/v1 adapter maps it to 409
  const wake = await input('wake', true, true);
  expect({ status: wake.statusCode, code: wake.json().errorCode }).toEqual({ status: 200, code: 'SESSION_BUSY' }); // the /api/v1 adapter maps it to 409
  expect(keys).toEqual([]); // zero text, zero Enter

  // The move's handoff types into a clean composer: nothing of the agent's in front of it.
  expect(await session.writeViaMux('handoff text\r', { requireEmptyComposer: true })).toBe(true);
  expect(keys).toEqual(['handoff text', 'Enter']);

  // A person's own typing is not an agent write and is still delivered during the hold.
  const person = await input('owner line', false);
  expect(person.json().success).not.toBe(false);
  expect(keys).toEqual(['handoff text', 'Enter', 'owner line', 'Enter']);

  release();
  const after = await input('agent note', true);
  expect(after.json().success).not.toBe(false);
  expect(keys.slice(-2)).toEqual(['agent note', 'Enter']);
});

it('refuses an agent\'s send whose move hold began after the route\'s early check, on every write path, and hands its seq back', async () => {
  for (const extra of [{}, { useMux: true }, { useMux: false }, { wait: true, waitTimeout: 1000 }]) {
    const { session, keys, input, pty, release, seq } = await harness('probe');
    expect(shape(await input('agent note', true, false, extra))).toEqual(BUSY);
    expect(keys).toEqual([]); // zero text, zero Enter
    expect(pty.write).not.toHaveBeenCalled(); // no raw fallback either
    expect(session.shouldApplyInput('review', seq())).toBe(true); // nothing was typed, so the retry is not a duplicate
    release();
  }
});

it('refuses an agent\'s wake whose move hold began during the wake-target await', async () => {
  const { session, keys, input, release, seq } = await harness('probe');
  expect(shape(await input('wake', true, true))).toEqual(BUSY);
  expect(keys).toEqual([]);
  expect(session.shouldApplyInput('review', seq())).toBe(true);
  release();
});

it('withholds Enter when a move takes the composer while the agent\'s text settles: typed-unsent, never replayed', async () => {
  for (const extra of [{}, { useMux: true }]) {
    const { session, keys, input, pty, release, seq } = await harness('settle');
    const res = await input('agent note', true, false, extra);
    expect(res.json().success).not.toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0)); // the fire-and-forget write's settle
    expect(keys).toEqual(['agent note']); // the text is in the composer, its Enter withheld
    expect(pty.write).not.toHaveBeenCalled(); // and no raw write of it a second time
    expect(session.shouldApplyInput('review', seq())).toBe(false); // the seq stays spent: a retry cannot type it again
    if (!('useMux' in extra)) expect(res.json()).toEqual({ delivered: false, typedUnsent: true });
    release();
  }
});

it('leaves a person\'s typing alone when a move takes the composer after the early check', async () => {
  const { keys, input, release } = await harness('probe');
  expect((await input('owner line', false)).json().success).not.toBe(false);
  expect(keys).toEqual(['owner line', 'Enter']);
  release();
});

it('keeps an agent\'s ordinary send ordinary with no move hold: not idle-only, and any key shape', async () => {
  const { session, keys, input, pty } = await harness();
  Object.assign(session, { _isWorking: true }); // a turn is running: a wake would refuse, a send does not
  expect((await input('agent note', true)).json().success).not.toBe(false);
  expect(keys).toEqual(['agent note', 'Enter']);
  // Text with no Enter is a shape the key gate cannot follow: it goes out as a single write, not refused.
  expect(await session.writeViaMux('partial', { fromUser: true, agentInput: true })).toBe(true);
  expect(keys.at(-1)).toBe('partial');
  expect(session.write('raw', { fromUser: true, agentInput: true })).toBe(true);
  expect(pty.write).toHaveBeenCalledWith('raw');
});

it('withholds the submit verifier\'s later Enter for an agent\'s write once a move takes the composer', async () => {
  vi.useFakeTimers();
  try {
    for (const [mode, glyph] of [['claude', '❯'], ['opencode', '┃']] as const) {
      const sent: string[] = [];
      // The first Enter is ignored, so the text stays in the composer and the verifier would press Enter again later.
      const screen = `● Done.\n${glyph} agent note\n  ⏵⏵ footer`;
      const mux = { capturePaneText: () => screen, sendInput: vi.fn(async (_id: string, input: string) => { sent.push(input); return true; }) };
      const session = new Session({ id: `verifier-${mode}`, workingDir: '/tmp', mode, useMux: true, mux: mux as never,
        muxSession: { muxName: 'reverie-owned-review', sessionId: `verifier-${mode}`, pid: 42 } as never });
      try {
        expect(await session.writeViaMux('agent note\r', { fromUser: true, opencodeGuard: mode === 'opencode', agentInput: true })).toBe(true);
        const release = session.pauseCapacityRetry();
        await vi.advanceTimersByTimeAsync(65_000);
        expect(sent.filter(key => key === '\r')).toEqual([]); // no later Enter into the held composer
        release();
      } finally {
        Object.assign(session, { ptyProcess: null, _muxSession: null });
        await session.stop(false);
      }
    }
  } finally {
    vi.useRealTimers();
  }
});
