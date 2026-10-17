/**
 * Reboot-restore route tests (src/web/routes/reboot-restore-routes.ts) via
 * app.inject(), no live port.
 *
 * Every entry these tests put on offer names a workspace that does not exist, so
 * the route's click-time workspace check rejects it before any `Session` is
 * constructed. That keeps the tests on the route's own guards — taking, scoping,
 * single-flighting and re-checking — and leaves pane creation to
 * test/reboot-restore.test.ts, which drives a real `Session` for it.
 *
 * The routes read the process-wide `rebootRestoreRegistry` singleton, so every
 * test resets it; a leaked entry would bleed into the next one.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerRebootRestoreRoutes } from '../../src/web/routes/reboot-restore-routes.js';
import { rebootRestoreRegistry } from '../../src/web/reboot-restore-registry.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { createMockRouteContext } from '../mocks/index.js';
import type { RebootRestoreEntry } from '../../src/reboot-restore.js';
import type { SessionState } from '../../src/types.js';

async function createHarness(authUser?: { username: string; role: 'admin' | 'user' }): Promise<FastifyInstance> {
  return createHarnessWithCtx(createMockRouteContext(), authUser);
}

async function createHarnessWithCtx(
  ctx: ReturnType<typeof createMockRouteContext>,
  authUser?: { username: string; role: 'admin' | 'user' }
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (authUser) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: typeof authUser }).authUser = authUser;
    });
  }
  registerRebootRestoreRoutes(app, ctx as never);

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

  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

/** An entry whose workspace is deliberately absent, so no pane is ever created. */
function offerEntry(sessionId: string, owner?: string): RebootRestoreEntry {
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: `/tmp/codeman-reboot-restore-missing/${sessionId}`,
    owner,
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: null,
      status: 'idle',
      workingDir: `/tmp/codeman-reboot-restore-missing/${sessionId}`,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'claude',
      owner,
    } as SessionState,
  };
}

afterEach(() => {
  rebootRestoreRegistry.reset();
});

describe('GET /api/reboot-restore', () => {
  it('reports nothing when no reboot left anything behind', async () => {
    const app = await createHarness();
    const res = await app.inject({ method: 'GET', url: '/api/reboot-restore' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.sessions).toEqual([]);
    await app.close();
  });

  it('names what is on offer, and says the scrollback is not coming back', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const app = await createHarness();
    const body = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b']);
    expect(body.scrollbackRestored).toBe(false);
    await app.close();
  });

  it('never carries the persisted record itself to the browser', async () => {
    rebootRestoreRegistry.set([offerEntry('a', 'alice')]);
    const app = await createHarness({ username: 'alice', role: 'admin' });
    const body = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(Object.keys(body.sessions[0]).sort()).toEqual(['id', 'mode', 'name', 'owner', 'workingDir']);
    expect(body.sessions[0].state).toBeUndefined();
    await app.close();
  });
});

describe('POST /api/reboot-restore/restore', () => {
  it('reports a workspace that is gone, and keeps offering it in case it comes back', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const app = await createHarness();

    const first = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(first.restored).toEqual([]);
    expect(first.skipped).toEqual([{ sessionId: 'a', reason: 'workspace-missing' }]);

    // Nothing was built, so the entry goes back: a repo can be restored from a
    // backup between two clicks, and losing the offer would be unrecoverable.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['a']);
    await app.close();
  });

  it('never re-offers a conversation that is already open', async () => {
    const entry = offerEntry('a');
    rebootRestoreRegistry.set([entry]);
    const app = await createHarness();
    const ctx = createMockRouteContext({ sessionId: entry.sessionId });
    // A session with that id is live, which is what the Resume list would produce.
    const liveApp = await createHarnessWithCtx(ctx);

    const res = (await liveApp.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.skipped).toEqual([{ sessionId: 'a', reason: 'already-live' }]);

    // Unlike a missing workspace, this one is dropped: it cannot stop being true.
    const left = (await liveApp.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions).toEqual([]);
    await liveApp.close();
    await app.close();
  });

  it('spends only the sessions the click named', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const app = await createHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reboot-restore/restore',
      payload: { sessionIds: ['b'] },
    });
    expect(res.json().data.skipped).toEqual([{ sessionId: 'b', reason: 'workspace-missing' }]);

    // 'a' was never taken, and 'b' came back because no pane was built for it.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    await app.close();
  });

  it('refuses a body it does not recognise rather than guessing', async () => {
    const app = await createHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/reboot-restore/restore',
      payload: { sessionIds: 'not-an-array' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it('turns a second concurrent restore away rather than interleaving it', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    // Claimed by a restore already in flight for this same owner (undefined in
    // single-user mode, which is what the harness runs as).
    expect(rebootRestoreRegistry.beginSpending(undefined)).toBe(true);
    const app = await createHarness();
    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(res.statusCode).toBe(409);
    rebootRestoreRegistry.endSpending(undefined);
    await app.close();
  });
});

describe('POST /api/reboot-restore/restore: multi-user workspace confinement', () => {
  const saved: Record<string, string | undefined> = {};
  let realDir: string;

  beforeEach(() => {
    saved.CODEMAN_MULTIUSER = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    // This branch sits AFTER the existsSync check, so the workspace has to be
    // real for the confinement rule to be the thing that rejects the entry.
    realDir = mkdtempSync(join(tmpdir(), 'codeman-reboot-restore-real-'));
  });

  afterEach(() => {
    if (saved.CODEMAN_MULTIUSER === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = saved.CODEMAN_MULTIUSER;
    rmSync(realDir, { recursive: true, force: true });
  });

  it("refuses a workspace outside the OWNER's case space, and leaves it on offer", async () => {
    const entry = offerEntry('a', 'alice');
    entry.workingDir = realDir;
    (entry.state as { workingDir: string }).workingDir = realDir;
    rebootRestoreRegistry.set([entry]);

    // An admin does the clicking. The confinement is still resolved against
    // alice, the entry's OWNER: `isWorkingDirAllowed` waves an admin through, so
    // reading the caller here would hand an admin the power to rebuild another
    // user's session anywhere on the box.
    const app = await createHarness({ username: 'root-user', role: 'admin' });
    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.restored).toEqual([]);
    expect(res.json().data.skipped).toEqual([{ sessionId: 'a', reason: 'workspace-forbidden' }]);

    // A withdrawn grant can be given back, so unlike `already-live` this is not
    // the permanent kind of refusal and the entry stays claimable.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['a']);
    await app.close();
  });
});

describe('POST /api/reboot-restore/dismiss', () => {
  it('drops the offer and leaves the banner with nothing to show', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const app = await createHarness();

    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
    expect(res.json().data.dismissed).toBe(2);

    const after = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(after.sessions).toEqual([]);
    await app.close();
  });
});
