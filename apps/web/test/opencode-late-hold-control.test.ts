import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ calls: [] as string[], onText: (() => {}) as () => void, composer: '' }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual,
    exec: vi.fn((cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (cmd.includes('send-keys')) {
        port.calls.push(cmd);
        if (cmd.includes('agent note')) { port.composer = 'agent note'; port.onText(); }
        if (/\bEnter'?$/.test(cmd)) port.composer = '';
      }
      if (typeof callback === 'function') setImmediate(() => callback(null, '', ''));
      return { on: vi.fn(), kill: vi.fn(), pid: 42 };
    }),
    execSync: vi.fn(() => ''), spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), pid: 42 })),
  };
});
import { Session } from '../src/session.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

it('independent: actual OpenCode transport withholds Enter after a plan move takes its composer during text delivery', async () => {
  port.calls.length = 0; port.composer = '';
  const priorVitest = process.env.VITEST;
  delete process.env.VITEST;
  let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
  try { ({ TmuxManager } = await import('../src/tmux-manager.js?independent-real-transport')); }
  finally { process.env.VITEST = priorVitest; }
  vi.spyOn(TmuxManager.prototype as never, 'loadSessions').mockImplementation(() => {});
  const mux = new TmuxManager();
  const binding = { muxName: 'reverie-00000051', sessionId: 'test-session-1', pid: 42, mode: 'opencode' };
  (mux as unknown as { sessions: Map<string, unknown> }).sessions.set('test-session-1', binding);
  vi.spyOn(mux, 'capturePaneText').mockImplementation(() => `┃ ${port.composer}\n\n  tab agents  ctrl+p commands`);
  const session = new Session({ id: 'test-session-1', workingDir: '/owned/fixture', mode: 'opencode', useMux: true,
    mux, muxSession: binding as never });
  let release: (() => void) | undefined;
  port.onText = () => { release = session.pauseCapacityRetry(); };
  const app = Fastify({ logger: false }); await app.register(fastifyCookie);
  const ctx = createMockRouteContext(); ctx.sessions.set(session.id, session as never);
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner,
    remoteWake: { hasWakeTarget: vi.fn(async () => false) } as never });
  installRouteErrorHandler(app); await app.ready();
  try {
    const result = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input',
      headers: { 'x-reverie-parent-session': 'another-agent' },
      payload: { input: 'agent note\r', clientId: 'review-opencode', seq: 1 } });
    expect(session.composerHeldByMove).toBe(true);
    console.log(JSON.stringify({ phase: 'hold-after-literal-text', status: result.statusCode, held: session.composerHeldByMove,
      syntheticNativeCommands: port.calls }));
    expect(port.calls.some(cmd => /\bEnter'?$/.test(cmd))).toBe(false);
    expect(session.shouldApplyInput('review-opencode', 1)).toBe(false); // text already typed: never replay it
  } finally {
    release?.(); port.onText = () => {};
    Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false);
    mux.destroy(); await app.close();
  }
});
