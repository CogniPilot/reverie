/** Bug 11: explicit verified-owner restarts record running intent through the real routes; automatic paths never do. */
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../src/types.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

let directory: string;
let store: CompanyStore;
let service: CompanyService;
const sessions: Session[] = [];

function deadPaneSession() {
  const mux = {
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => true),
    isPaneDead: vi.fn(() => true),
    respawnPane: vi.fn(async () => 4242 as number | null),
    clearPaneExit: vi.fn(),
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'opencode',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: { sessionId: 'test-session', muxName: 'reverie-bbbbbbbb', pid: 4241 } as MuxSession,
    openCodeConfig: { model: 'local/model', continueSession: 'ses_000000000000000000000001' },
  });
  sessions.push(session);
  // Fake attach client with no OS process; never signals a real process or tmux server.
  const attach = { pid: 999_999_998, kill: vi.fn() };
  Object.assign(session, { ptyProcess: attach, _pid: attach.pid });
  session.setPaneExit({ status: 137, at: 1000 });
  return session;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'reverie-restart-intent-'));
  store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function compose(verifiedOwner: (req: unknown) => boolean = trustedFixtureOwner) {
  const session = deadPaneSession();
  const rooms = new ChatroomStore();
  service = new CompanyService(store, {
    getSession: (id) => (id === session.id ? { id, name: 'Ada', owner: undefined } : undefined),
    chatrooms: {
      rooms: () => rooms.list(),
      room: (id) => rooms.get(id),
      addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
    },
  } as never);
  await service.hire({
    name: 'Ada',
    icon: '🔭',
    position: 'Engineer',
    expertise: ['systems'],
    sessionId: session.id,
  } as never);
  const { app, ctx } = await createRouteTestHarness((app, ctx) => {
    app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
      const body = payload as { success?: boolean; errorCode?: ApiErrorCode };
      if (body.success === false && body.errorCode) reply.code(httpStatusForErrorCode(body.errorCode));
      done(null, body.success === undefined ? { success: true, data: body } : body);
    });
    registerSessionRoutes(app, ctx, { verifiedOwner, company: service } as never);
  });
  ctx.sessions.set(session.id, session as never);
  const intent = () => store.snapshot().employees.find((e) => e.sessionId === session.id)?.desiredRunning;
  return { app, ctx, session, intent };
}

describe('bug 11: explicit owner restarts record running intent; automatic paths never do', () => {
  const owner = () => true;
  async function modeSwitch(
    app: { inject: Function },
    session: Session,
    ctx: any,
    restarted: boolean,
    during?: () => Promise<void>
  ) {
    session.setPinned(true);
    vi.spyOn(session, 'restartCli').mockImplementation(async () => {
      await during?.(); // something that lands while the pane restarts
      return restarted;
    });
    ctx.mux = { ...(ctx.mux ?? {}), getSession: () => ({ pid: null }), updateSessionMode: vi.fn() };
    return app.inject({ method: 'POST', url: `/api/sessions/${session.id}/mode`, payload: { mode: 'claude' } });
  }

  it('owner stop, then an explicit owner mode restart records true; a stale observation cannot change it', async () => {
    const { app, ctx, session, intent } = await compose(owner);
    try {
      await service.setDesiredRunning(session.id, false); // owner Stop
      await service.recordObservedRunning(session.id); // a late background observation never revives it
      expect(intent()).toBe(false);
      const response = await modeSwitch(app, session, ctx, true);
      expect(response.statusCode, response.body).toBe(200);
      expect(intent()).toBe(true); // the explicit restart is remembered
      await service.recordObservedRunning(session.id); // a stale observation after the restart
      expect(intent()).toBe(true);
      await service.setDesiredRunning(session.id, false); // a later owner Stop still wins
      expect(intent()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('a failed restart records nothing', async () => {
    const { app, ctx, session, intent } = await compose(owner);
    try {
      await service.setDesiredRunning(session.id, false);
      await modeSwitch(app, session, ctx, false);
      expect(intent()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('bug 17: the interactive route never starts an owner-stopped expert (auto re-attach or breaker restart)', async () => {
    const { app, session, intent } = await compose(owner);
    try {
      await service.setDesiredRunning(session.id, false);
      const respawn = vi.spyOn(session, 'startInteractive');
      for (const payload of [undefined, { clearBreaker: true }]) {
        const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/interactive`, payload });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toContain('stopped by the owner');
        expect(intent()).toBe(false);
      }
      expect(respawn).not.toHaveBeenCalled(); // the process was never started against the owner's Stop
    } finally {
      await app.close();
    }
  });

  it('bug 17: a running expert (intent true) and unknown intent still re-attach, recording nothing new', async () => {
    const { app, session, intent } = await compose(owner);
    try {
      await service.setDesiredRunning(session.id, true); // as the hire flow records
      expect(intent()).toBe(true);
      const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/interactive` });
      expect(response.statusCode).toBe(200);
      expect(intent()).toBe(true);
      await store.update((state) => {
        delete state.employees.find((e) => e.sessionId === session.id)!.desiredRunning;
      });
      session.setPaneExit({ status: 137, at: 2000 });
      const again = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/interactive` });
      expect(again.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('an owner Stop that lands mid-start wins over the restart', async () => {
    const { app, ctx, session, intent } = await compose(owner);
    try {
      await service.setDesiredRunning(session.id, false);
      await modeSwitch(app, session, ctx, true, () => service.setDesiredRunning(session.id, false));
      expect(intent()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('intent is claimed before the launch, so the start itself sees running intent', async () => {
    const { app, ctx, session, intent } = await compose(owner);
    try {
      await service.setDesiredRunning(session.id, false);
      let seen: boolean | undefined;
      await modeSwitch(app, session, ctx, true, async () => {
        seen = intent();
      });
      expect(seen).toBe(true);
      expect(intent()).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a vacationing employee is not restarted into running intent', async () => {
    const { app, ctx, session, intent } = await compose(owner);
    try {
      await store.update((state) => {
        const e = state.employees.find((x) => x.sessionId === session.id)!;
        e.onVacation = true;
        e.desiredRunning = false;
      });
      const response = await modeSwitch(app, session, ctx, true);
      expect(response.json().success).not.toBe(true);
      expect(intent()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('a request that is not the verified owner records nothing', async () => {
    const { app, ctx, session, intent } = await compose(() => false);
    try {
      await service.setDesiredRunning(session.id, false);
      const response = await modeSwitch(app, session, ctx, true);
      expect(response.statusCode).toBe(403);
      expect(intent()).toBe(false);
    } finally {
      await app.close();
    }
  });
});
