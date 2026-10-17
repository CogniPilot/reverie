/**
 * @fileoverview Route tests for wake-on-LAN on `POST /api/sessions/:id/input`.
 *
 * The behavior that matters and cannot be tested at the registry level: a
 * wake-enabled remote session whose host is asleep must return 200 WITHOUT
 * writing into the stalled pane (the bytes would vanish), while every other
 * session keeps the historical fire-and-forget path untouched.
 *
 * The registry is injected through `registerSessionRoutes`'s test seam so no real
 * TCP connect, ssh, or WoL happens in CI.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '../../src/config/instance.js';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSessionRoutes, _resetPaneLivenessState } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { RemoteWakeRegistry, type RemoteWakeDeps } from '../../src/remote-wake.js';
import type { SessionRemote } from '../../src/types.js';

const SESSION_ID = 'remote-wake-session';

/**
 * Mirror production's envelope + status mapping (as inbox-routes.test.ts does): a
 * returned `createErrorResponse` carries its 4xx, a plain object is wrapped in
 * `{success:true, data}`. Without it every error would read as a 200.
 */
function installEnvelope(app: FastifyInstance): void {
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
}
const URL = `/api/sessions/${SESSION_ID}/input`;

afterEach(() => {
  sessionWaits.cancelAll(SESSION_ID);
  _resetPaneLivenessState();
});

interface Harness {
  app: FastifyInstance;
  ctx: ReturnType<typeof createMockRouteContext>;
  registry: RemoteWakeRegistry;
  probe: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  events: string[];
  /** Let a held wake finish (see `holdWake`). */
  releaseWake: () => void;
}

const remoteSession: SessionRemote = {
  hostId: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.168.50.137',
  username: 'j',
  remotePath: '/home/j/codeman-pi-test',
  wakeCommand: '/home/joe/bin/whuff',
};

async function harness(
  opts: {
    remote?: SessionRemote;
    hostUp?: boolean;
    holdWake?: boolean;
    /** Stands in for the auth middleware (multi-user mode); absent = synthetic admin. */
    authUser?: { username: string; role: 'admin' | 'user' };
  } = {}
): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (opts.authUser) {
    const authUser = opts.authUser;
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: typeof authUser }).authUser = authUser;
    });
  }
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  const session = ctx.sessions.get(SESSION_ID)!;
  session.remote = opts.remote ?? remoteSession;

  const probe = vi.fn(async () => opts.hostUp ?? false);
  const wake = vi.fn(async () => true);
  const events: string[] = [];
  // With instantaneous mocks the whole wake chain (wake -> wait -> reattach ->
  // flush) can finish inside one `await`, so a test that wants to observe the
  // in-flight state has to hold the readiness poll open.
  let release: (() => void) | null = null;
  const deps: RemoteWakeDeps = {
    probe,
    wake,
    waitUntilReady: () =>
      opts.holdWake
        ? new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          })
        : Promise.resolve(true),
    delay: async () => {},
    noteReconnected: () => {},
    broadcast: (event) => events.push(event),
    log: () => {},
  };
  const registry = new RemoteWakeRegistry(deps);

  registerSessionRoutes(app, ctx as never, { remoteWake: registry });
  installEnvelope(app);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, registry, probe, wake, events, releaseWake: () => release?.() };
}

const send = (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: URL, payload });

describe('POST /api/sessions/:id/input — wake-on-LAN', () => {
  it('buffers input instead of writing into a sleeping host, then flushes after the wake', async () => {
    const h = await harness({ hostUp: false, holdWake: true });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    const res = await send(h.app, { input: 'hallo', useMux: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { buffered: true } });
    // Nothing reached the pane: writing now would be swallowed by the stalled ssh.
    expect(session.writeBuffer).toEqual([]);
    expect(h.wake).toHaveBeenCalledWith({ kind: 'command', command: '/home/joe/bin/whuff' });
    expect(h.registry.isWaking(SESSION_ID)).toBe(true);

    h.releaseWake();
    await h.registry.wake(session);
    expect(session.writeBuffer).toEqual(['hallo']);
    expect(session.reattachRemote).toHaveBeenCalled();
  });

  it('flushes several inputs typed during a wake IN ORDER (the browser posts one per keystroke)', async () => {
    // The concurrency surface that only exists in production: xterm's onData posts each
    // keystroke as its OWN request, so a wake collects N concurrent buffer writes and must
    // replay them in order. Route-level, so it is covered on every run instead of only in a
    // hand-driven browser session.
    const h = await harness({ hostUp: false, holdWake: true });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    for (const chunk of ['h', 'a', 'llo']) {
      const res = await send(h.app, { input: chunk, useMux: true });
      expect(res.statusCode).toBe(200);
    }
    // Nothing written while the host is asleep/dead — that is the whole point.
    expect(session.writeBuffer).toEqual([]);

    h.releaseWake();
    await h.registry.wake(session);
    expect(session.writeBuffer).toEqual(['h', 'a', 'llo']);
  });

  it('keeps the historical fire-and-forget write when the host is reachable', async () => {
    const h = await harness({ hostUp: true });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    const res = await send(h.app, { input: 'hallo', useMux: true });

    expect(res.json()).toEqual({ success: true, data: {} }); // the historical bare answer, untouched
    await vi.waitFor(() => expect(session.writeBuffer).toEqual(['hallo']));
    expect(h.wake).not.toHaveBeenCalled();
    expect(session.reattachRemote).not.toHaveBeenCalled();
  });

  it('never probes or wakes a session without a wake command', async () => {
    const { wakeCommand, ...withoutWake } = remoteSession;
    const h = await harness({ remote: withoutWake as SessionRemote });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    await send(h.app, { input: 'hallo', useMux: true });

    await vi.waitFor(() => expect(session.writeBuffer).toEqual(['hallo']));
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('writes straight into a proxied host with a wake target: no probe, no buffer, no wake', async () => {
    // With a target configured, the old verdict buffered EVERY input for the life of
    // the session: the readiness poll can never succeed through a proxy, so nothing was
    // ever flushed (three inputs, nothing written, buffer non-empty — reproduced upstream).
    const h = await harness({ remote: { ...remoteSession, socksProxy: '127.0.0.1:1080' }, hostUp: false });
    const session = h.ctx.sessions.get(SESSION_ID)!;
    for (const input of ['a', 'b', 'c']) expect((await send(h.app, { input, useMux: true })).statusCode).toBe(200);
    expect(session.writeBuffer).toEqual(['a', 'b', 'c']);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.registry.pendingBytes(SESSION_ID)).toBe(0);
  });

  it('wakes before writing on the send-and-wait path (no buffering, the response waits anyway)', async () => {
    const h = await harness({ hostUp: false });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    await send(h.app, { input: 'hallo', useMux: true, wait: 'idle', waitTimeout: 60 });

    expect(h.wake).toHaveBeenCalledTimes(1);
    // `ensureAwake` is awaited on this path, so the write happens inline and the
    // waiter is registered against a live pane.
    expect(session.writeBuffer).toEqual(['hallo']);
  });
});

describe('GET /api/sessions/:id/reachability', () => {
  const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url });

  it('reports the probe result and how the host can be woken', async () => {
    const up = await harness({ hostUp: true });
    const upBody = (await get(up.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(upBody.data.reachable).toBe(true);
    expect(upBody.data.wakeConfigured).toBe('command');
    expect(upBody.data.label).toBe('Hufflepuff');

    const down = await harness({ hostUp: false });
    const downBody = (await get(down.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(downBody.data.reachable).toBe(false);
    // A reachability check is a QUESTION, never an action: the host stays asleep.
    expect(down.wake).not.toHaveBeenCalled();
  });

  it('says nothing can wake a host without a configured target', async () => {
    const { wakeCommand, ...withoutWake } = remoteSession;
    const h = await harness({ remote: withoutWake as SessionRemote, hostUp: false });
    const body = (await get(h.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(body.data.reachable).toBe(false);
    expect(body.data.wakeConfigured).toBe('none');
  });

  it('reports a proxied host as unknown, not unreachable, and never probes it', async () => {
    // A jump-host / SOCKS host does not answer the bare TCP probe even while ssh works;
    // `reachable:false` here drew a permanent banner over a healthy session.
    const h = await harness({ remote: { ...remoteSession, jumpHost: 'bastion.example' }, hostUp: false });
    const body = (await get(h.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(body.data.reachable).toBeNull();
    expect(body.data.probeable).toBe(false);
    expect(body.data.wakeConfigured).toBe('command');
    expect(h.probe).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/wake', () => {
  const wake = (app: FastifyInstance) => app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/wake` });

  it('wakes the host, reattaches the pane and reports both', async () => {
    const h = await harness({ hostUp: false });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    const body = (await wake(h.app)).json();

    expect(body.success).toBe(true);
    expect(body.data.woke).toBe(true);
    expect(body.data.reachable).toBe(true);
    expect(session.reattachRemote).toHaveBeenCalled();
  });

  it('answers with an error the UI can route to the config dialog', async () => {
    const { wakeCommand, ...withoutWake } = remoteSession;
    const h = await harness({ remote: withoutWake as SessionRemote, hostUp: false });

    const res = await wake(h.app);
    const body = res.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/No wake-on-LAN target/);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('does not send a wake when the host answers, but still settles the session', async () => {
    const h = await harness({ hostUp: true });
    const body = (await wake(h.app)).json();
    expect(body.data.woke).toBe(true);
    expect(h.wake).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions + attachRemoteSession — authorization before the wake', () => {
  // Remote hosts are admin-only infra everywhere else, and the attach wake spawns the
  // host's `wakeCommand` (or broadcasts a packet). Before this gate a non-admin could
  // post an attach for any configured hostId, have that executable run and the request
  // held for the wake budget, and only THEN get a 403 for the workingDir (reproduced
  // upstream: wake spy fired once, response 403).
  it('403s a non-admin in multi-user mode without probing or waking the host', async () => {
    const prev = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    try {
      // `session-routes.ts` reads hosts from the sandboxed data dir (module-load-time
      // constant), so a host with a wake command is written THERE: a regression would
      // find it and fire the spy.
      await mkdir(getDataDir(), { recursive: true });
      await writeFile(
        join(getDataDir(), 'remote-hosts.json'),
        JSON.stringify([
          {
            id: 'hufflepuff',
            label: 'Hufflepuff',
            host: '192.168.50.137',
            username: 'j',
            wakeCommand: '/home/joe/bin/whuff',
          },
        ])
      );
      const h = await harness({ hostUp: false, authUser: { username: 'mallory', role: 'user' } });
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { attachRemoteSession: { hostId: 'hufflepuff', remoteSessionName: 'codeman-abc12345' } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/admin-only/);
      expect(h.probe).not.toHaveBeenCalled();
      expect(h.wake).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      await h.app.close();
    } finally {
      if (prev === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = prev;
    }
  });
});

describe('POST /api/sessions/:id/input — what the caller is told', () => {
  it('says buffered, and dropped for a chunk over the wake buffer cap', async () => {
    // The non-wait branch always answered a bare `{}`; these fields are additive. Without
    // them a prompt over 4 KB posted to a sleeping host was accepted and silently lost.
    const h = await harness({ hostUp: false, holdWake: true });
    const small = await send(h.app, { input: 'hallo', useMux: true });
    expect(small.statusCode).toBe(200);
    expect(small.json()).toEqual({ success: true, data: { buffered: true } });

    const big = await send(h.app, { input: 'x'.repeat(5000), useMux: true });
    expect(big.statusCode).toBe(200);
    expect(big.json()).toEqual({ success: true, data: { buffered: true, dropped: true } });
    expect(h.registry.pendingBytes(SESSION_ID)).toBe(5);
    h.releaseWake();
    await h.registry.wake(h.ctx.sessions.get(SESSION_ID)!);
  });

  it('fails the send-and-wait path when the host never comes back, instead of writing into the stalled pane', async () => {
    // Readiness never arrives: the wake resolves false.
    const failing = await harnessWithFailingWake();
    const session = failing.ctx.sessions.get(SESSION_ID)!;
    const res = await send(failing.app, { input: 'hallo', useMux: true, wait: true, waitTimeout: 1000 });
    expect(res.statusCode).toBe(422);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(res.json().error).toMatch(/did not come back/);
    expect(session.writeBuffer).toEqual([]);
    await failing.app.close();
  });
});

/** A harness whose readiness poll answers false: the wake command runs, the host stays down. */
async function harnessWithFailingWake(): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  ctx.sessions.get(SESSION_ID)!.remote = remoteSession;
  const probe = vi.fn(async () => false);
  const wake = vi.fn(async () => true);
  const events: string[] = [];
  const registry = new RemoteWakeRegistry({
    probe,
    wake,
    waitUntilReady: async () => false,
    delay: async () => {},
    noteReconnected: () => {},
    broadcast: (event) => events.push(event),
    log: () => {},
  });
  registerSessionRoutes(app, ctx as never, { remoteWake: registry });
  installEnvelope(app);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, registry, probe, wake, events, releaseWake: () => {} };
}
