import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { expect, it, vi } from 'vitest';
// Long text goes to Codex as a bracketed paste (pastesInsteadOfKeys): load-buffer stages it, paste-buffer types it. A plan
// move that takes the composer while the buffer is staged must get nothing pasted; one that takes it after the paste gets the
// text left unsent (Enter withheld) and never replayed. Real route -> Session -> TmuxManager; only child_process is synthetic.
const port = vi.hoisted(() => ({ calls: [] as string[], at: '' as 'load-buffer' | 'paste-buffer' | '', hold: (() => {}) as () => void, composer: '' }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual,
    exec: vi.fn((cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      for (const verb of ['send-keys', 'load-buffer', 'paste-buffer', 'delete-buffer'] as const) {
        if (!cmd.includes(verb)) continue;
        port.calls.push(verb + (/\bEnter'?$/.test(cmd) ? ' Enter' : ''));
        if (verb === 'paste-buffer') port.composer = LONG;
        if (/\bEnter'?$/.test(cmd)) port.composer = '';
        if (verb === port.at) port.hold();
        break;
      }
      if (typeof callback === 'function') setImmediate(() => callback(null, '', ''));
      return { on: vi.fn(), kill: vi.fn(), pid: 42 };
    }),
    execSync: vi.fn(() => ''), spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), pid: 42 })),
  };
});
const LONG = 'a'.repeat(1100);
import { Session } from '../src/session.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

it.each([
  ['load-buffer', [], true],
  ['paste-buffer', ['paste-buffer'], false],
] as const)('a move hold taken at %s: Codex gets only %j typed, seq handed back: %s', async (at, typed, handedBack) => {
  port.calls.length = 0; port.composer = ''; port.at = at;
  const priorVitest = process.env.VITEST;
  delete process.env.VITEST;
  let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
  try { ({ TmuxManager } = await import('../src/tmux-manager.js?codex-paste-hold')); }
  finally { process.env.VITEST = priorVitest; }
  vi.spyOn(TmuxManager.prototype as never, 'loadSessions').mockImplementation(() => {});
  const mux = new TmuxManager();
  const binding = { muxName: 'reverie-00000052', sessionId: 'test-session-1', pid: 42, mode: 'codex' };
  (mux as unknown as { sessions: Map<string, unknown> }).sessions.set('test-session-1', binding);
  vi.spyOn(mux, 'capturePaneText').mockImplementation(() => `› ${port.composer}\n\n  gpt-6.1-sol high · /owned/fixture`);
  const session = new Session({ id: 'test-session-1', workingDir: '/owned/fixture', mode: 'codex', useMux: true, mux, muxSession: binding as never });
  let release: (() => void) | undefined;
  port.hold = () => { release ??= session.pauseCapacityRetry(); };
  const app = Fastify({ logger: false }); await app.register(fastifyCookie);
  const ctx = createMockRouteContext(); ctx.sessions.set(session.id, session as never);
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner, remoteWake: { hasWakeTarget: vi.fn(async () => false) } as never });
  installRouteErrorHandler(app); await app.ready();
  try {
    const result = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input',
      headers: { 'x-reverie-parent-session': 'another-agent' }, payload: { input: `${LONG}\r`, clientId: 'codex-paste', seq: 1 } });
    expect(session.composerHeldByMove).toBe(true);
    expect(port.calls.filter(c => c === 'paste-buffer' || c.startsWith('send-keys'))).toEqual(typed); // never an Enter
    expect(session.shouldApplyInput('codex-paste', 1)).toBe(handedBack);
    expect(result.json().errorCode === 'SESSION_BUSY').toBe(handedBack);
    if (!handedBack) expect(result.json()).toEqual({ delivered: false, typedUnsent: true });
  } finally {
    release?.(); port.hold = () => {}; port.at = '';
    Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false);
    mux.destroy(); await app.close();
  }
});
