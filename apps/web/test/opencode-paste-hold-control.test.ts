import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ calls: [] as string[], onText: (() => {}) as () => void, composer: '' }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual,
    exec: vi.fn((cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (cmd.includes('send-keys') || cmd.includes('load-buffer') || cmd.includes('paste-buffer')) {
        port.calls.push(cmd);
        if (cmd.includes('load-buffer')) port.onText();
        if (cmd.includes('paste-buffer')) port.composer = 'agent note';
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

it('independent: actual OpenCode paste transport must not write text after a move takes its composer during buffer staging', async () => {
  port.calls.length = 0; port.composer = '';
  const oldPaste = process.env.REVERIE_OPENCODE_PASTE; process.env.REVERIE_OPENCODE_PASTE = '1';
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
    console.log(JSON.stringify({ phase: 'hold-after-buffer-before-paste', status: result.statusCode, held: session.composerHeldByMove,
      syntheticNativeCommands: port.calls }));
    expect(port.calls.some(cmd => cmd.includes('load-buffer'))).toBe(true);
    expect(port.calls.some(cmd => cmd.includes('paste-buffer'))).toBe(false);
    expect(port.calls.some(cmd => /\bEnter'?$/.test(cmd))).toBe(false);
    expect(session.shouldApplyInput('review-opencode', 1)).toBe(true); // staging alone typed no bytes: the seq is handed back
  } finally {
    release?.(); port.onText = () => {};
    if (oldPaste === undefined) delete process.env.REVERIE_OPENCODE_PASTE; else process.env.REVERIE_OPENCODE_PASTE = oldPaste;
    Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false);
    mux.destroy(); await app.close();
  }
});
