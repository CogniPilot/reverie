import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../src/types.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const sessions: Session[] = [];
afterEach(async () => {
  // Fake attach clients have no OS process. Never signal a process or real tmux server.
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
});

function fixture(extra: Record<string, unknown> = {}) {
  const mux = {
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => true),
    isPaneDead: vi.fn(() => true),
    respawnPane: vi.fn(async () => 4242 as number | null),
    clearPaneExit: vi.fn(),
  };
  const session = new Session({
    workingDir: '/tmp', mode: 'opencode', useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: { sessionId: 'test-session', muxName: 'codeman-aaaaaaaa', pid: 4241 } as MuxSession,
    openCodeConfig: { model: 'local/model', continueSession: 'ses_000000000000000000000001' },
    ...extra,
  });
  sessions.push(session);
  const attach = { pid: 999_999_999, kill: vi.fn() };
  Object.assign(session, { ptyProcess: attach, _pid: attach.pid });
  return { session, mux, attach };
}

describe('interactive recovery with a retained attach client', () => {
  it('respawns a dead local pane in place with the stored thread, model and identity', async () => {
    const { session, mux, attach } = fixture();
    session.setPaneExit({ status: 137, at: 1000 });
    session.setOpenCodeThread('ses_000000000000000000000002');
    const before = session.toState();
    await session.startInteractive();
    expect(mux.respawnPane).toHaveBeenCalledOnce();
    expect(mux.respawnPane).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id, onlyIfDead: true,
      openCodeConfig: { model: 'local/model', continueSession: 'ses_000000000000000000000002' },
    }));
    expect(session.id).toBe(before.id);
    expect(session.pid).toBe(attach.pid);
    expect(attach.kill).not.toHaveBeenCalled();
    expect(session.paneExit).toBeUndefined();
    expect(mux.clearPaneExit).toHaveBeenCalledWith('codeman-aaaaaaaa');
    expect(session.paneLifecycleInFlight).toBe(false);
  });

  it('requires a current dead-pane observation rather than a cached exit or the attach pid', async () => {
    const { session, mux } = fixture();
    session.setPaneExit({ status: 137, at: 1000 });
    mux.isPaneDead.mockReturnValue(false);
    await expect(session.startInteractive()).rejects.toThrow('already has a running process');
    expect(mux.respawnPane).not.toHaveBeenCalled();
  });

  it.each([
    { useMux: false },
    { remote: { hostId: 'remote-one', label: 'Remote', host: 'remote.test', user: 'developer' } },
    { docker: { hostId: 'container-one', label: 'Container', containerName: 'test-container' } },
    { discoveredMuxSession: true },
  ])('does not reinterpret an unproven local CLI: %j', async (extra) => {
    const { session, mux } = fixture(extra);
    await expect(session.startInteractive()).rejects.toThrow('already has a running process');
    expect(mux.respawnPane).not.toHaveBeenCalled();
  });

  it('preserves the exit breaker and the closing-session guard', async () => {
    const { session, mux } = fixture();
    Object.assign(session, { _respawnBlocked: true });
    await expect(session.startInteractive()).rejects.toThrow('circuit breaker tripped');
    expect(mux.respawnPane).not.toHaveBeenCalled();
    session.resetRespawnBreaker(); session.markClosing(true);
    await expect(session.startInteractive()).rejects.toThrow('being closed');
    expect(mux.respawnPane).not.toHaveBeenCalled();
    session.markClosing(false);
  });

  it('does not create a replacement session or clear its exit when the pane vanished or respawn failed', async () => {
    const { session, mux } = fixture();
    session.setPaneExit({ status: 137, at: 1000 });
    mux.muxSessionExists.mockReturnValue(false);
    await expect(session.startInteractive()).rejects.toThrow('could not be restarted');
    expect(mux.respawnPane).not.toHaveBeenCalled();
    mux.muxSessionExists.mockReturnValue(true); mux.respawnPane.mockResolvedValue(null);
    await expect(session.startInteractive()).rejects.toThrow('could not be restarted');
    expect(mux.respawnPane).toHaveBeenCalledOnce();
    expect(session.paneExit?.status).toBe(137);
    expect(mux.clearPaneExit).not.toHaveBeenCalled();
    expect(session.paneLifecycleInFlight).toBe(false);
  });

  it('refuses a concurrent interactive start while the first pane recovery is in flight', async () => {
    const { session, mux } = fixture();
    let release!: (pid: number) => void;
    mux.respawnPane.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = session.startInteractive();
    await vi.waitFor(() => expect(mux.respawnPane).toHaveBeenCalledOnce());
    try {
      expect(session.paneLifecycleInFlight).toBe(true);
      await expect(session.startInteractive()).rejects.toThrow('already has a running process');
      expect(mux.respawnPane).toHaveBeenCalledOnce();
    } finally { release(4242); await first; }
  });

  it('keeps ordinary restartCli forceful, while interactive recovery asks tmux to refuse a newly live pane', async () => {
    const { session, mux } = fixture();
    await session.restartCli();
    expect(mux.respawnPane.mock.calls[0][0].onlyIfDead).toBeUndefined();
    mux.respawnPane.mockClear();
    await session.startInteractive();
    expect(mux.respawnPane.mock.calls[0][0].onlyIfDead).toBe(true);
  });

  it('recovers through the real interactive route and persists the cleared pane exit', async () => {
    const { session, mux } = fixture();
    session.setPaneExit({ status: 137, at: 1000 });
    const { app, ctx } = await createRouteTestHarness((app, ctx) => {
      app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
        const body = payload as { success?: boolean; errorCode?: ApiErrorCode };
        if (body.success === false && body.errorCode) reply.code(httpStatusForErrorCode(body.errorCode));
        done(null, body.success === undefined ? { success: true, data: body } : body);
      });
      registerSessionRoutes(app, ctx);
    });
    ctx.sessions.set(session.id, session as never);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/interactive` });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mux.respawnPane).toHaveBeenCalledOnce();
      expect(ctx.persistSessionState).toHaveBeenCalledWith(session);
      expect(session.toState().paneExit).toBeUndefined();
      expect(ctx.broadcast).toHaveBeenCalledWith('session:interactive', { id: session.id });
    } finally { await app.close(); }
  });
});
