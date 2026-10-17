import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomStore } from '../../src/chatroom-store.js';

describe('temporary worker creation with company identity and channel inheritance', () => {
  let directory: string;
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let company: CompanyService;
  let rooms: ChatroomStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fleet-company-spawn-'));
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
    });
    app = Fastify();
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx, { company });
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
      headers: { 'x-codeman-parent-session': 'test-session-1' },
      payload: { workingDir: directory, mode: 'claude', ...extra },
    });

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
      headers: { 'x-codeman-parent-session': 'test-session-1' },
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
      headers: { 'x-codeman-parent-session': 'test-session-1' },
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
      headers: { 'x-codeman-parent-session': 'test-session-1' },
      payload: { caseName: 'never-created', chatroomId: room.id },
    });
    expect(response.json().success).toBe(false);
    expect(ctx.addSession).not.toHaveBeenCalled();
  });
});
