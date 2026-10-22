import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { CompanyError, CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomStore } from '../../src/chatroom-store.js';

// Launching needs an installed CLI; the thread test only checks what the launch is given.
vi.mock('../../src/utils/cli-resolver.js', async (original) => ({
  ...(await original<typeof import('../../src/utils/cli-resolver.js')>()),
  isCliAvailable: () => true,
  resolveCliBinDir: () => '/usr/bin',
  missingCliMessage: () => null,
}));

describe('temporary worker creation with company identity and channel inheritance', () => {
  let directory: string;
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let company: CompanyService;
  let rooms: ChatroomStore;
  const threads = new Map<string, string>();
  const failures: Array<{ employeeId?: string; replacedSessionIds: string[]; error: string }> = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-company-spawn-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    ctx = createMockRouteContext();
    rooms = new ChatroomStore();
    company = new CompanyService(store, {
      getSession: (id) => ctx.sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
      threadOf: (id) => threads.get(id),
    });
    threads.clear();
    failures.length = 0;
    app = Fastify();
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx, { company, onReplacementFailed: (info) => failures.push(info) });
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const spawn = (extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-reverie-parent-session': 'test-session-1' },
      payload: { workingDir: directory, mode: 'claude', ...extra },
    });

  // No parent header: the owner, not an agent.
  const owner = (extra = {}) =>
    app.inject({ method: 'POST', url: '/api/sessions', payload: { workingDir: directory, mode: 'claude', ...extra } });

  it('gives a random human name/icon and joins the parent’s only channel', async () => {
    const room = rooms.create('Engineering', undefined);
    rooms.addMember(room.id, 'test-session-1');
    const response = await spawn();
    expect(response.statusCode).toBe(200);
    const { session, identity } = response.json();
    expect(session.name).toMatch(/^[A-Za-z]+$/);
    expect(identity.icon).toBeTruthy();
    expect(room.members.find((m) => m.sessionId === session.id)?.icon).toBe(identity.icon);
    expect(company.view().temporaryAgents[0].name).toBe(session.name);
    expect(company.view().employees).toHaveLength(0);
  });

  it('preserves explicitly chosen name/icon and requires an explicit channel when ambiguous', async () => {
    const one = rooms.create('Engineering', undefined);
    const two = rooms.create('Design', undefined);
    rooms.addMember(one.id, 'test-session-1');
    rooms.addMember(two.id, 'test-session-1');
    const chosen = await spawn({ name: 'Taylor', icon: '🎨', channelId: two.id });
    expect(chosen.json().session.name).toBe('Taylor');
    expect(two.members.find((m) => m.sessionId === chosen.json().session.id)?.icon).toBe('🎨');
    const ambiguous = await spawn();
    expect(ambiguous.json().identity.channelId).toBeUndefined();
    expect(one.members).toHaveLength(1);
    expect(two.members).toHaveLength(2);
  });

  it('refuses an employee\'s name for a new session, and lets the employee\'s own session replace itself by employee id', async () => {
    const ada = await company.hire({ name: 'Ada', icon: '🔭', position: 'Scientist', expertise: ['x'], sessionId: 'test-session-1', researchEnabled: false });
    const before = ctx.sessions.size;
    const byName = await spawn({ name: 'Ada' });
    expect(byName.json().success).toBe(false);
    expect(byName.json().error).toContain('existing employee');
    expect(byName.json().errorCode).toBe('CONFLICT');
    expect((await spawn({ employeeId: 'no-such-employee' })).json().errorCode).toBe('NOT_FOUND');
    expect(ctx.sessions.size).toBe(before);
    const replaced = await spawn({ employeeId: ada.id });
    expect(replaced.statusCode).toBe(200);
    const created = replaced.json().session;
    expect(company.view().employees).toHaveLength(1);
    expect(company.view().employees[0].sessionId).toBe(created.id);
    expect(company.view().temporaryAgents).toHaveLength(0);
  });

  it('resumes the employee\'s own thread when its session is replaced, whatever the old session ran', async () => {
    const ada = await company.hire({ name: 'Ada', icon: '🔭', position: 'Scientist', expertise: ['x'], sessionId: 'test-session-1', researchEnabled: false });
    await company.setThread(ada.id, undefined, 'ses_chosen');
    ctx.cleanupSession.mockImplementation(async (id: string) => void ctx.sessions.delete(id));
    const replaced = await owner({ employeeId: ada.id, mode: 'opencode' });
    expect(replaced.statusCode).toBe(200);
    const thread = (r: { json(): { session: { openCodeConfig?: { continueSession?: unknown } } } }) => r.json().session.openCodeConfig?.continueSession;
    expect(thread(replaced)).toBe('ses_chosen');
    // A caller's own thread choice is not overridden.
    const own = await owner({ employeeId: ada.id, mode: 'opencode', openCodeConfig: { continueSession: 'ses_caller' } });
    expect(own.statusCode).toBe(200);
    expect(thread(own)).toBe('ses_caller');
  });

  describe('replacing an employee that is still running its thread', () => {
    const hire = async () => {
      const ada = await company.hire({ name: 'Ada', icon: '🔭', position: 'Scientist', expertise: ['x'], sessionId: 'test-session-1', researchEnabled: false });
      await company.setThread(ada.id, undefined, 'ses_chosen');
      return ada;
    };

    it('stops the old session before the owner\'s replacement launches', async () => {
      const ada = await hire();
      const order: string[] = [];
      ctx.cleanupSession.mockImplementation(async (id: string) => {
        order.push(`stop ${id}`);
        ctx.sessions.delete(id);
      });
      const addSession = ctx.addSession.getMockImplementation()!;
      ctx.addSession.mockImplementation(async (session: { id: string }, ...rest: unknown[]) => {
        order.push(`add ${session.id}`);
        return addSession(session, ...rest);
      });
      const response = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(response.statusCode).toBe(200);
      expect(order[0]).toBe('stop test-session-1');
      expect(order[1]).toBe(`add ${response.json().session.id}`);
      expect(ctx.sessions.has('test-session-1')).toBe(false);
    });

    it('tells an agent caller, even the employee\'s own session, to stop the old one first', async () => {
      const ada = await hire();
      const response = await spawn({ employeeId: ada.id, mode: 'opencode' });
      expect(response.json().errorCode).toBe('CONFLICT');
      expect(response.json().error).toContain('Stop');
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      expect(ctx.addSession).not.toHaveBeenCalled();
      expect(company.view().employees[0].sessionId).toBe('test-session-1');
    });

    it('tells an agent replacing its own running session to ask the owner', async () => {
      const ada = await hire();
      const response = await spawn({ employeeId: ada.id, mode: 'opencode' });
      expect(response.json().error).toContain('ask the owner');
    });

    it('reports a launch that throws after the old session was stopped, and frees the claim', async () => {
      const ada = await hire();
      ctx.cleanupSession.mockImplementation(async (id: string) => void ctx.sessions.delete(id));
      const addSession = ctx.addSession.getMockImplementation()!;
      ctx.addSession.mockRejectedValueOnce(new Error('tmux gone'));
      const failed = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      expect(failures).toEqual([{ employeeId: ada.id, replacedSessionIds: ['test-session-1'], error: 'tmux gone' }]);
      ctx.addSession.mockImplementation(addSession);
      const retry = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(retry.json().error ?? '').not.toContain('already being replaced');
    });

    it('reports a failed rebind too, but not a refusal that stopped nothing', async () => {
      const ada = await hire();
      await spawn({ employeeId: ada.id, mode: 'opencode' });
      expect(failures).toEqual([]);
      ctx.cleanupSession.mockImplementation(async (id: string) => void ctx.sessions.delete(id));
      vi.spyOn(company, 'completeSpawn').mockRejectedValue(new CompanyError('Session already bound', 409));
      await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(failures).toHaveLength(1);
      expect(failures[0].employeeId).toBe(ada.id);
    });

    it('lets only one launch at a time start on a thread, employee or not', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const addSession = ctx.addSession.getMockImplementation()!;
      ctx.addSession.mockImplementationOnce(async (...args: unknown[]) => {
        await gate;
        return addSession(...args);
      });
      const body = { mode: 'opencode', openCodeConfig: { continueSession: 'ses_shared' } };
      const first = owner(body);
      await vi.waitFor(() => expect(ctx.addSession).toHaveBeenCalled());
      const second = await owner(body);
      expect(second.json().errorCode).toBe('CONFLICT');
      expect(second.json().error).toContain('Another launch');
      release();
      expect((await first).statusCode).toBe(200);
    });

    it('refuses when the old session survives the stop, instead of running two on one thread', async () => {
      const ada = await hire();
      const response = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(ctx.cleanupSession).toHaveBeenCalledWith('test-session-1', true, 'employee_replaced');
      expect(response.json().errorCode).toBe('CONFLICT');
      expect(ctx.addSession).not.toHaveBeenCalled();
    });

    it('treats a header whose session cannot be found as no one, never as the owner', async () => {
      const ada = await hire();
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'x-reverie-parent-session': 'test-session-1' },
        payload: { workingDir: directory, mode: 'opencode', employeeId: ada.id, parentSessionId: 'zzz' },
      });
      expect(response.json().errorCode).toBe('FORBIDDEN');
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      expect(ctx.addSession).not.toHaveBeenCalled();
      expect(company.view().employees[0].sessionId).toBe('test-session-1');
    });

    it('stops the old session when the owner asks for the employee\'s own thread explicitly, and refuses an agent', async () => {
      const ada = await hire();
      // The employee's own session owns that conversation, so the resume guard lets the request through to the thread guard.
      (ctx.sessions.get('test-session-1') as unknown as { claudeSessionId: string }).claudeSessionId = 'ses_chosen';
      const agent = await spawn({ employeeId: ada.id, mode: 'opencode', openCodeConfig: { continueSession: 'ses_chosen' } });
      expect(agent.json().errorCode).toBe('CONFLICT');
      expect(ctx.addSession).not.toHaveBeenCalled();
      ctx.cleanupSession.mockImplementation(async (id: string) => void ctx.sessions.delete(id));
      const response = await owner({ employeeId: ada.id, mode: 'opencode', openCodeConfig: { continueSession: 'ses_chosen' } });
      expect(response.statusCode).toBe(200);
      expect(ctx.cleanupSession).toHaveBeenCalledWith('test-session-1', true, 'employee_replaced');
    });

    it('resumes the old session\'s thread for an employee hired before threads were recorded', async () => {
      const ada = await company.hire({ name: 'Ada', icon: '🔭', position: 'Scientist', expertise: ['x'], sessionId: 'test-session-1', researchEnabled: false });
      expect(company.view().employees[0].threadId).toBeUndefined();
      ctx.store.getSession.mockImplementation((id: string) => (id === 'test-session-1' ? { openCodeConfig: { continueSession: 'ses_old' } } : undefined));
      ctx.cleanupSession.mockImplementation(async (id: string) => {
        ctx.sessions.delete(id);
        ctx.store.getSession.mockReturnValue(undefined);
      });
      const response = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(response.statusCode).toBe(200);
      expect(response.json().session.openCodeConfig?.continueSession).toBe('ses_old');
    });

    it('refuses any launch onto a thread another live session already runs', async () => {
      ctx.store.getSession.mockImplementation((id: string) => (id === 'test-session-1' ? { openCodeConfig: { continueSession: 'ses_busy' } } : undefined));
      const response = await owner({ mode: 'opencode', openCodeConfig: { continueSession: 'ses_busy' } });
      expect(response.json().errorCode).toBe('CONFLICT');
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      expect(ctx.addSession).not.toHaveBeenCalled();
    });

    it('lets only one replacement of an employee run at a time', async () => {
      const ada = await hire();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      ctx.cleanupSession.mockImplementation(async (id: string) => {
        await gate;
        ctx.sessions.delete(id);
      });
      const first = owner({ employeeId: ada.id, mode: 'opencode' });
      await vi.waitFor(() => expect(ctx.cleanupSession).toHaveBeenCalled());
      const second = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(second.json().errorCode).toBe('CONFLICT');
      expect(second.json().error).toContain('already being replaced');
      release();
      expect((await first).statusCode).toBe(200);
      expect(ctx.addSession).toHaveBeenCalledTimes(1);
    });

    it('does not stop the old session when the request is refused later for another reason', async () => {
      const ada = await hire();
      const response = await app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'ada-restart', mode: 'opencode', employeeId: ada.id, customModel: { endpointId: 'missing', modelId: 'x' } },
      });
      expect(response.json().success).toBe(false);
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      expect(company.view().employees[0].sessionId).toBe('test-session-1');
    });

    it('removes the session it just started when the rebind fails, so no orphan keeps running', async () => {
      const ada = await hire();
      ctx.cleanupSession.mockImplementation(async (id: string) => void ctx.sessions.delete(id));
      vi.spyOn(company, 'completeSpawn').mockRejectedValue(new CompanyError('Session already bound', 409));
      const response = await owner({ employeeId: ada.id, mode: 'opencode' });
      expect(response.json().errorCode).toBe('CONFLICT');
      const created = ctx.addSession.mock.calls[0][0].id as string;
      expect(ctx.cleanupSession).toHaveBeenCalledWith(created, true, 'spawn_failed');
      expect(ctx.sessions.has(created)).toBe(false);
    });

    it('does the same on quick-start', async () => {
      const ada = await hire();
      ctx.cleanupSession.mockImplementation(async (id: string) => void ctx.sessions.delete(id));
      vi.spyOn(company, 'completeSpawn').mockRejectedValue(new CompanyError('Session already bound', 409));
      const response = await app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'ada-restart', mode: 'opencode', employeeId: ada.id },
      });
      expect(response.json().success).toBe(false);
      const created = ctx.addSession.mock.calls[0][0].id as string;
      expect(ctx.cleanupSession).toHaveBeenCalledWith(created, true, 'quick_start_error');
    });
  });

  it('refuses an unauthorized explicit channel before creating any session', async () => {
    const room = rooms.create('Private', undefined);
    const response = await spawn({ channelId: room.id });
    expect(response.json().success).toBe(false);
    expect(ctx.addSession).not.toHaveBeenCalled();
    expect(room.members).toHaveLength(0);
  });

  it('refuses invalid avatars, leaves shell session naming untouched and preserves explicit empty names', async () => {
    expect((await spawn({ icon: 'unbounded avatar' })).json().success).toBe(false);
    const shell = await spawn({ mode: 'shell', name: 'My shell' });
    expect(shell.json().session.name).toBe('My shell');
    expect(shell.json().identity).toBeUndefined();
    const empty = await spawn({ name: '' });
    expect(empty.json().identity.name).toBe('');
  });

  it('applies the same identity/channel workflow to the actual quick-start CLI spawn path', async () => {
    const room = rooms.create('Engineering', undefined);
    rooms.addMember(room.id, 'test-session-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      headers: { 'x-reverie-parent-session': 'test-session-1' },
      payload: { caseName: 'company-worker', mode: 'claude' },
    });
    expect(response.statusCode).toBe(200);
    const { sessionId, identity } = response.json();
    expect(sessionId).toBeTruthy();
    expect(ctx.sessions.get(sessionId)?.name).toBe(identity.name);
    expect(identity.name).toMatch(/^[A-Za-z]+$/);
    expect(room.members.find((m) => m.sessionId === sessionId)?.icon).toBe(identity.icon);
    const chosen = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      headers: { 'x-reverie-parent-session': 'test-session-1' },
      payload: { caseName: 'company-worker2', mode: 'claude', sessionName: 'Taylor', icon: '🎨', chatroomId: room.id },
    });
    expect(chosen.json().identity).toEqual({ name: 'Taylor', icon: '🎨', channelId: room.id });
    expect(ctx.sessions.get(chosen.json().sessionId)?.name).toBe('Taylor');
  });

  it('rejects an unauthorized quick-start channel before any case or session is created', async () => {
    const room = rooms.create('Private', undefined);
    const response = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      headers: { 'x-reverie-parent-session': 'test-session-1' },
      payload: { caseName: 'never-created', chatroomId: room.id },
    });
    expect(response.json().success).toBe(false);
    expect(ctx.addSession).not.toHaveBeenCalled();
  });
});
