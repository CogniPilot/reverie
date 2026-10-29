import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit } from '../src/submit-settle.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

// Idle-only wake (`agent wake`) decided at the write, not before an await (independent PR70 review, 2026-10-29): the route's
// early look is only a pre-check, a turn can start inside the wake-target probe, and an empty composer alone does not prove
// idle. Same harness as wake-idle-race-witness.test.ts: the real route and a real Session over a fake mux.
const CODEX_EMPTY = '›\n  gpt-6.1-sol high · /owned/fixture\n? for shortcuts';
const CLAUDE_EMPTY = '● Done.\n────────────────────────────────\n❯ \n────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const CLAUDE_DRAFT = CLAUDE_EMPTY.replace('❯ ', '❯ a half-typed note to myself');

type Mux = { capturePaneText: () => string; sendInput: ReturnType<typeof vi.fn> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(mode: string, screen: string, remoteWake: Record<string, unknown> = { hasWakeTarget: vi.fn(async () => false) }, sendInput = vi.fn(async () => true)) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  const mux: Mux = { capturePaneText: () => screen, sendInput };
  const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: mode as never, useMux: true, mux: mux as never,
    muxSession: { muxName: 'reverie-owned-review', sessionId: 'test-session-1', pid: 42 } as never });
  ctx.sessions.set(session.id, session as never);
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner, remoteWake: remoteWake as never });
  installRouteErrorHandler(app);
  await app.ready();
  cleanups.push(async () => {
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
    await app.close();
  });
  const wake = (seq = 1) => app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input', payload: { input: 'wake\r', ifIdle: true, clientId: 'review', seq } });
  return { app, session, mux, wake };
}

describe('idle-only wake at the write boundary', () => {
  it('leaves a Claude Code draft alone (the empty-composer proof is not Codex-only)', async () => {
    const h = await harness('claude', CLAUDE_DRAFT);
    const response = await h.wake();
    expect(h.mux.sendInput).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ delivered: false });
  });

  it('wakes an idle Claude Code session through a gate that is re-checked at the keys', async () => {
    const h = await harness('claude', CLAUDE_EMPTY);
    const response = await h.wake();
    expect(response.json()).toEqual({ delivered: true });
    expect(h.mux.sendInput).toHaveBeenCalledOnce();
    const options = h.mux.sendInput.mock.calls[0][2] as { requireEmptyComposer?: boolean; stillIdle?: () => boolean };
    expect(options.requireEmptyComposer).toBe(true);
    // While its own write is in flight the gate still reads idle; a turn starting makes it refuse the remaining keys.
    (h.session as unknown as { _muxWritesInFlight: number })._muxWritesInFlight = 1;
    expect(options.stillIdle!()).toBe(true);
    Object.assign(h.session, { _isWorking: true });
    expect(options.stillIdle!()).toBe(false);
  });

  it('refuses a harness whose composer it cannot read rather than guess', async () => {
    const h = await harness('opencode', '┃ \n┃ some draft');
    const response = await h.wake();
    expect(h.mux.sendInput).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ delivered: false });
  });

  it('never buffers an idle-only wake for a sleeping host, and refuses one that went busy while the host woke', async () => {
    let session!: Session;
    const remoteWake = {
      hasWakeTarget: vi.fn(async () => true),
      handleInput: vi.fn(async () => 'buffered'),
      ensureAwake: vi.fn(async () => {
        Object.assign(session, { _isWorking: true, _status: 'busy' });
        return true;
      }),
    };
    const h = await harness('codex', CODEX_EMPTY, remoteWake);
    session = h.session;
    const response = await h.wake();
    expect(remoteWake.handleInput).not.toHaveBeenCalled();
    expect(remoteWake.ensureAwake).toHaveBeenCalledOnce();
    expect(h.mux.sendInput).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ delivered: false });
  });

  it('types one wake when two arrive together', async () => {
    let release!: (ok: boolean) => void;
    const sendInput = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const h = await harness('codex', CODEX_EMPTY, undefined, sendInput);
    const first = h.wake(1);
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledOnce());
    const second = await h.wake(2);
    expect(second.json()).toEqual({ delivered: false });
    release(true);
    expect((await first).json()).toEqual({ delivered: true });
    expect(sendInput).toHaveBeenCalledOnce();
  });
});

describe('typeAndSubmit idle gate', () => {
  const CLAUDE = { glyph: '❯', workingLine: 'esc to interrupt' };
  function io(screen: () => string) {
    const keys: string[] = [];
    return {
      keys,
      io: {
        capture: screen,
        sleep: async () => {},
        sendEnter: async () => { keys.push('Enter'); },
        typeText: async (text: string) => { keys.push(text); },
      },
    };
  }

  it('types nothing when the session is no longer idle at the keys', async () => {
    const m = io(() => CLAUDE_EMPTY);
    expect(await typeAndSubmit(m.io, 'wake', CLAUDE, 'pane', true, () => false)).toBe('not-written');
    expect(m.keys).toEqual([]);
  });

  it('withholds Enter when a turn starts while the text settles', async () => {
    let idle = true;
    const m = io(() => CLAUDE_EMPTY);
    m.io.typeText = async (text: string) => { m.keys.push(text); idle = false; };
    expect(await typeAndSubmit(m.io, 'wake', CLAUDE, 'pane', true, () => idle)).toBe('not-written');
    expect(m.keys).toEqual(['wake']);
  });

  it('requires a provably empty Claude Code composer when gated', async () => {
    const m = io(() => CLAUDE_DRAFT);
    expect(await typeAndSubmit(m.io, 'wake', CLAUDE, 'pane', true, () => true)).toBe('not-written');
    expect(m.keys).toEqual([]);
  });

  it('does not press the retry Enter once the session stopped being idle', async () => {
    let idle = true;
    let typed = false;
    const m = io(() => (typed ? CLAUDE_EMPTY.replace('❯ ', '❯ wake') : CLAUDE_EMPTY));
    m.io.typeText = async (text: string) => { m.keys.push(text); typed = true; };
    m.io.sendEnter = async () => { m.keys.push('Enter'); idle = false; };
    expect(await typeAndSubmit(m.io, 'wake', CLAUDE, 'pane', true, () => idle)).toBe('unverified');
    expect(m.keys).toEqual(['wake', 'Enter']);
  });
});
