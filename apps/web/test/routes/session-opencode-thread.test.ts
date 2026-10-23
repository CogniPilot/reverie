import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * PUT /api/sessions/:id/opencode-thread: the owner points an OpenCode session at another thread for its next start.
 * The session keeps its id (identity, policies and pin are keyed to it); nothing restarts; an audit line is written.
 * Refused for an agent caller, a malformed id, a non-OpenCode or forking session, and a thread another session resumes.
 * The real Session then starts on the new thread and a reboot restore resumes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.fn();
vi.mock('../../src/session-lifecycle-log.js', async (orig) => {
  const actual = await orig<typeof import('../../src/session-lifecycle-log.js')>();
  return { ...actual, getLifecycleLog: () => ({ log, query: async () => [] }) };
});

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { MockSession } from '../mocks/index.js';
import { Session } from '../../src/session.js';
import { nativeOpenCodeThread } from '../../src/reboot-restore.js';

const OLD = 'ses_ebfc25d1affeGat27ERDSQqbqu';
const NEW = 'ses_fresh0000000000000000001';
const url = '/api/sessions/test-session-1/opencode-thread';

describe('PUT /api/sessions/:id/opencode-thread', () => {
  let h: RouteTestHarness;

  beforeEach(async () => {
    log.mockClear();
    h = await createRouteTestHarness((app, ctx) => registerSessionRoutes(app, ctx, { verifiedOwner: trustedFixtureOwner }));
    h.ctx._session.mode = 'opencode';
    h.ctx._session.openCodeConfig = { continueSession: OLD };
  });

  afterEach(async () => {
    await h.app.close();
  });

  const put = (payload: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'PUT', url, payload: payload as never, headers });

  it('sets the thread for the next start, persists it and writes one audit line', async () => {
    const res = await put({ thread: NEW });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ thread: NEW, previous: OLD });
    expect(h.ctx._session.openCodeThread).toBe(NEW);
    expect(h.ctx.persistSessionState).toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'thread_set', sessionId: 'test-session-1', extra: { from: OLD, to: NEW, by: 'owner' } })
    );
  });

  it('refuses an agent caller, whoever it is, and changes nothing', async () => {
    const res = await put({ thread: NEW }, { 'x-reverie-parent-session': 'test-session-1' });
    expect(res.statusCode).toBe(403);
    expect(h.ctx._session.openCodeThread).toBe(OLD);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a malformed thread id', async () => {
    for (const thread of ['', 'ses_', 'ses_../../x', '--fork', 'ses_a b c d e f g h', 42]) {
      const res = await put({ thread });
      expect(res.statusCode, String(thread)).toBe(400);
    }
    expect(h.ctx._session.openCodeThread).toBe(OLD);
  });

  it('refuses a session that is not OpenCode, or one that forks on every start', async () => {
    h.ctx._session.mode = 'claude';
    expect((await put({ thread: NEW })).statusCode).toBe(400);
    h.ctx._session.mode = 'opencode';
    h.ctx._session.openCodeConfig = { continueSession: OLD, forkSession: true };
    expect((await put({ thread: NEW })).statusCode).toBe(400);
    expect(h.ctx._session.openCodeThread).toBe(OLD);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a thread another live session already resumes', async () => {
    const other = new MockSession('other-1');
    other.name = 'Twin';
    h.ctx.sessions.set('other-1', other as never);
    h.ctx.store.getSession.mockImplementation((id: string) =>
      id === 'other-1' ? { openCodeConfig: { continueSession: NEW } } : undefined
    );
    const res = await put({ thread: NEW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Twin (other-1)');
    expect(h.ctx._session.openCodeThread).toBe(OLD);
  });

  it('404s an unknown session', async () => {
    const res = await h.app.inject({ method: 'PUT', url: '/api/sessions/nope/opencode-thread', payload: { thread: NEW } });
    expect(res.statusCode).toBe(404);
  });
});

describe('Session.setOpenCodeThread', () => {
  const session = (config: Record<string, unknown>) =>
    new Session({ workingDir: '/tmp', mode: 'opencode', openCodeConfig: config } as ConstructorParameters<typeof Session>[0]);

  it('keeps the rest of the config and is what the saved state and a reboot restore resume', () => {
    const s = session({ model: 'local_agent/qwen', continueSession: OLD, configContent: '{"default_agent": "chat"}' });
    s.setOpenCodeThread(NEW);
    expect(s.openCodeThread).toBe(NEW);
    const state = s.toState();
    expect(state.openCodeConfig).toEqual({ model: 'local_agent/qwen', continueSession: NEW, configContent: '{"default_agent": "chat"}' });
    expect(nativeOpenCodeThread(state)).toBe(NEW);
  });

  it('refuses a forking config and a non-OpenCode session', () => {
    expect(() => session({ continueSession: OLD, forkSession: true }).setOpenCodeThread(NEW)).toThrow(/forks/);
    const claude = new Session({ workingDir: '/tmp', mode: 'claude' } as ConstructorParameters<typeof Session>[0]);
    expect(() => claude.setOpenCodeThread(NEW)).toThrow(/OpenCode/);
  });
});
