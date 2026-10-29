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

// Review of dabc602: an ungated writeViaMux without '\r' (e.g. orchestrator-loop's '/compact') reaches
// _verifySubmitted, which clears _verifierGate and then returns early without re-arming the verifier. The verifier
// still tracks the earlier gated write, so its later Enter would go out with no gate.
for (const [second, shown] of [[null, 'wake'], ['/compact', 'wake'], ['/compact', 'wake/compact'], [' ', 'wake']] as const) {
  it(`gated write's delayed Enter stays gated${second ? ` after an ungated '${second}' write, composer '${shown}'` : ' (baseline)'}`, async () => {
    vi.useFakeTimers();
    const screen = { text: `›\n${FOOTER}` };
    let enters = 0;
    const { session, mux } = codexSession(screen);
    const sendInput = mux.sendInput.getMockImplementation()!;
    mux.sendInput.mockImplementation(async (id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) => {
      if (input === '\r') { enters++; return true; }
      if (!input.includes('\r')) return true; // a plain text write lands; nothing to submit
      return sendInput(id, input, options);
    });
    mux.capturePaneText = () => screen.text;
    const delivered = session.writeViaMux('wake\r', { requireEmptyComposer: true, requireIdle: true });
    await vi.advanceTimersByTimeAsync(0);
    screen.text = `› wake\n${FOOTER}`; // first Enter ignored: the text is still in the composer
    await vi.advanceTimersByTimeAsync(20_000);
    await delivered;
    if (second) expect(await session.writeViaMux(second, { opencodeGuard: true })).toBe(true);
    screen.text = `› ${shown}\n${FOOTER}`;
    Object.assign(session, { _isWorking: true, _status: 'busy' }); // the gate closes
    const before = enters;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(enters).toBe(before);
  });
}
