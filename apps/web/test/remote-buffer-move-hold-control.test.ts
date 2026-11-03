import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit } from '../src/submit-settle.js';
import { RemoteWakeRegistry } from '../src/remote-wake.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

it.each([true, false])('buffered remote input keeps its agent origin through a plan-move hold: agent=%s', async (agent) => {
  let composer = '';
  const keys: string[] = [];
  const screen = () => `● Done.\n────────────────────────────────\n❯ ${composer}\n────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
  const io = { capture: screen, sleep: async () => {},
    typeText: async (text: string) => { keys.push(text); composer += text; },
    sendEnter: async () => { keys.push('Enter'); composer = ''; } };
  const mux = { capturePaneText: screen,
    sendInput: vi.fn(async (_id: string, input: string, options: { requireEmptyComposer?: boolean } = {}) =>
      (await typeAndSubmit(io, input.replace(/\r/g, ''), { glyph: '❯', workingLine: 'esc to interrupt' }, 'remote-hold', options.requireEmptyComposer)) !== 'not-written') };
  const session = new Session({ id: 'test-session-1', workingDir: '/owned/fixture', mode: 'claude', useMux: true,
    remote: { hostId: 'owned-host', label: 'Owned fixture', host: '192.0.2.1', wakeCommand: 'synthetic-wake' } as never,
    mux: mux as never, muxSession: { muxName: 'reverie-owned-review', sessionId: 'test-session-1', pid: 42 } as never });
  Object.assign(session, { reattachRemote: vi.fn(async () => true) });
  let ready!: (value: boolean) => void;
  const readiness = new Promise<boolean>(resolve => { ready = resolve; });
  const registry = new RemoteWakeRegistry({ probe: async () => false, wake: async () => true,
    waitUntilReady: async () => readiness, delay: async () => {} });
  const app = Fastify({ logger: false }); await app.register(fastifyCookie);
  const ctx = createMockRouteContext(); ctx.sessions.set(session.id, session as never);
  registerSessionRoutes(app, ctx as never, { verifiedOwner: trustedFixtureOwner, remoteWake: registry });
  installRouteErrorHandler(app); await app.ready();
  let release: (() => void) | undefined;
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input',
      headers: agent ? { 'x-reverie-parent-session': 'another-agent' } : {},
      payload: { input: 'synthetic queued note\r', clientId: 'remote-buffer-review', seq: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ buffered: true });
    expect(keys).toEqual([]);
    release = session.pauseCapacityRetry();
    ready(true);
    await registry.wake(session);
    console.log(JSON.stringify({ agent, held: session.composerHeldByMove, bufferedAck: response.json(), syntheticKeys: keys }));
    expect(keys).toEqual(agent ? [] : ['synthetic queued note', 'Enter']);
  } finally {
    ready(true); release?.();
    Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false);
    registry.stop(); await app.close();
  }
});
