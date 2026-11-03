import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit } from '../src/submit-settle.js';
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

async function harness(lateHold = false) {
  let acquired: (() => void) | undefined;
  let composer = '';
  const screen = () => CLAUDE_EMPTY.replace('❯ ', `❯ ${composer}`);
  const keys: string[] = [];
  const io = {
    capture: screen,
    sleep: async () => {},
    typeText: async (text: string) => { keys.push(text); composer += text; },
    sendEnter: async () => { keys.push('Enter'); composer = ''; },
  };
  const mux = {
    capturePaneText: screen,
    sendInput: vi.fn(async (_id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) =>
      (await typeAndSubmit(io, input.replace(/\r/g, ''), { glyph: '❯', workingLine: 'esc to interrupt' }, 'move-hold', options.requireEmptyComposer)) !== 'not-written'),
  };
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'claude', useMux: true, mux: mux as never,
    muxSession: { muxName: 'reverie-owned-review', sessionId: 'test-session-1', pid: 42 } as never });
  ctx.sessions.set(session.id, session as never);
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner, remoteWake: { hasWakeTarget: vi.fn(async () => { if (lateHold) acquired = session.pauseCapacityRetry(); await Promise.resolve(); return false; }) } as never });
  installRouteErrorHandler(app);
  await app.ready();
  cleanups.push(async () => {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
    await app.close();
  });
  let seq = 0;
  const input = (text: string, agent: boolean, ifIdle = false) => app.inject({
    method: 'POST', url: '/api/sessions/test-session-1/input',
    headers: agent ? { 'x-reverie-parent-session': 'another-agent' } : {},
    payload: { input: `${text}\r`, clientId: 'review', seq: ++seq, ...(ifIdle ? { ifIdle: true } : {}) },
  });
  return { session, keys, input, release: () => acquired?.() };
}

it('independent: ordinary agent send never writes after a move acquires the composer during the wake-target await', async () => {
  const { session, keys, input, release } = await harness(true);
  expect(session.composerHeldByMove).toBe(false);
  const response = await input('agent note', true);
  expect(session.composerHeldByMove).toBe(true);
  expect([200, 409]).toContain(response.statusCode);
  console.log(JSON.stringify({phase:'after-route-await',status:response.statusCode,held:session.composerHeldByMove,syntheticKeys:keys}));
  // Refusal response may vary; the invariant is zero native text and zero Enter.
  expect(keys).toEqual([]);
  // A prewrite refusal must not spend the retry sequence.
  expect(session.shouldApplyInput('review', 1)).toBe(true);
  release();
});
