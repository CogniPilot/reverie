import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit } from '../src/submit-settle.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

// The between-text-and-Enter case (independent PR70 review, 2026-10-29): the text went in, then the write's gate closed.
// It is preserved, never cleared, reported as typed-but-unsent rather than "nothing was typed", and never typed again.
const FOOTER = '  gpt-6.1-sol high · /owned/fixture';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.useRealTimers();
});

/** A real Session over a mux whose sendInput runs the real typeAndSubmit against a scripted pane. */
function codexSession(screen: { text: string }, hooks: { onType?: (s: Session) => void; onSleep?: (s: Session) => void } = {}) {
  const keys: string[] = [];
  let session!: Session;
  const io = {
    capture: () => screen.text,
    typeText: async (text: string) => {
      keys.push(text);
      screen.text = `› ${text}\n${FOOTER}`;
      hooks.onType?.(session);
    },
    sleep: async () => hooks.onSleep?.(session),
    sendEnter: async () => {
      keys.push('Enter');
      screen.text = `• Working (esc to interrupt)\n›\n${FOOTER}`;
    },
  };
  const mux = {
    capturePaneText: () => screen.text,
    sendInput: vi.fn(async (_id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) =>
      (await typeAndSubmit(io, input.replace(/\r/g, ''), { glyph: '›', workingLine: 'esc to interrupt' }, 'control', options.requireEmptyComposer)) !== 'not-written'),
  };
  session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'codex', useMux: true, mux: mux as never,
    muxSession: { muxName: 'reverie-owned-review', sessionId: 'test-session-1', pid: 42 } as never });
  cleanups.push(async () => {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
  });
  return { session, mux, keys };
}

it('control: a wake whose turn starts between text and Enter is preserved, reported typed-unsent, and not typed again', async () => {
  const screen = { text: `›\n${FOOTER}` };
  const { session, mux, keys } = codexSession(screen, { onType: (s) => Object.assign(s, { _isWorking: true, _status: 'busy' }) });
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  ctx.sessions.set(session.id, session as never);
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner, remoteWake: { hasWakeTarget: vi.fn(async () => false) } as never });
  installRouteErrorHandler(app);
  await app.ready();
  cleanups.push(() => app.close());
  const wake = (seq: number) => app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input', payload: { input: 'wake\r', ifIdle: true, clientId: 'review', seq } });

  const first = await wake(1);
  expect(first.json()).toEqual({ delivered: false, typedUnsent: true });
  expect(keys).toEqual(['wake']); // the text went in; Enter never did
  expect(screen.text).toContain('› wake'); // preserved, not cleared

  // The turn ends; the composer still holds the unsent text, so a second wake types nothing on top of it.
  Object.assign(session, { _isWorking: false, _status: 'idle' });
  const second = await wake(2);
  expect(second.json()).toEqual({ delivered: false });
  expect(keys).toEqual(['wake']);
  expect(mux.sendInput).toHaveBeenCalledOnce();
});

it('control: a capacity "continue" fenced by a plan move keeps later writes off it and is not retried', async () => {
  vi.useFakeTimers();
  const screen = { text: `› earlier request\n■ Selected model is at capacity. Please try a different model.\n›\n${FOOTER}` };
  let release: (() => void) | undefined;
  const { session, mux, keys } = codexSession(screen, { onSleep: (s) => { release ??= s.pauseCapacityRetry(); } });
  const retry = (session as unknown as { _capacityRetry: { deps: { delaysMs: number[] }; check(): void } })._capacityRetry;
  retry.deps.delaysMs = [1, 1, 1];
  retry.check();
  await vi.advanceTimersByTimeAsync(1);
  expect(keys).toEqual(['continue']); // fenced: no Enter while the plan move holds the composer
  expect(screen.text).toContain('› continue'); // preserved

  // A plan-move handoff (an empty-composer write) cannot type after the retained text.
  expect(await session.writeViaMux('handoff text\r', { requireEmptyComposer: true })).toBe(false);
  // Releasing the hold looks again, but a composer holding text is no capacity stall: nothing is retried.
  release!();
  await vi.advanceTimersByTimeAsync(10);
  expect(keys).toEqual(['continue']);
  expect(mux.sendInput).toHaveBeenCalledOnce();
});

it('control: the delayed submit check of a gated write presses nothing once that write\'s gate has closed', async () => {
  vi.useFakeTimers();
  // The pane goes unreadable after Enter, so the inline check cannot tell (unverified) and the session's delayed verifier
  // is armed for the wake; then a turn starts. Its later Enter answers to the same gate and must be withheld.
  const screen = { text: `›\n${FOOTER}` };
  let enters = 0;
  const { session, mux } = codexSession(screen);
  const sendInput = mux.sendInput.getMockImplementation()!;
  mux.sendInput.mockImplementation(async (id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) => {
    if (input === '\r') { enters++; return true; }
    return sendInput(id, input, options);
  });
  mux.capturePaneText = () => screen.text;
  const delivered = session.writeViaMux('wake\r', { requireEmptyComposer: true, requireIdle: true });
  await vi.advanceTimersByTimeAsync(0);
  screen.text = `› wake\n${FOOTER}`; // the first Enter was ignored: the text is still in the composer
  await vi.advanceTimersByTimeAsync(20_000);
  await delivered;
  Object.assign(session, { _isWorking: true, _status: 'busy' });
  const before = enters;
  await vi.advanceTimersByTimeAsync(65_000);
  expect(enters).toBe(before);
});

it('control: a gated wake\'s delayed Enter waits out a different write that is in flight', async () => {
  vi.useFakeTimers();
  const screen = { text: `›\n${FOOTER}` };
  let enters = 0;
  const { session, mux } = codexSession(screen);
  const sendInput = mux.sendInput.getMockImplementation()!;
  mux.sendInput.mockImplementation(async (id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) => {
    if (input === '\r') { enters++; return true; }
    return sendInput(id, input, options);
  });
  const delivered = session.writeViaMux('wake\r', { requireEmptyComposer: true, requireIdle: true });
  await vi.advanceTimersByTimeAsync(0);
  screen.text = `› wake\n${FOOTER}`; // the first Enter was ignored; the verifier is armed for the wake
  await vi.advanceTimersByTimeAsync(20_000);
  await delivered;
  // Another write (not the wake) is now in flight: one write in flight, which the wake's own keys were allowed.
  (session as unknown as { _beginMuxWrite(): number })._beginMuxWrite();
  const before = enters;
  await vi.advanceTimersByTimeAsync(65_000);
  expect(enters).toBe(before);
});
