/**
 * @fileoverview Chatroom routes refuse a parent-session header that is present but does not
 * resolve. The owner-only rules read "no resolvable caller" as the user, so a bogus header must not
 * be read as the user (stopgap until owner authentication). Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const A2 = '0000002d-0035-4000-8000-00000000004a'; // shares A's 8-character prefix

describe('chatroom routes: unresolved parent-session header', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let roomId: string;

  beforeEach(async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {} });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
      // A route registered after, outside the chatroom prefix, keeps its own rules.
      fastify.get('/api/elsewhere', async () => ({ success: true }));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [
      [A, 'alpha'],
      [B, 'bravo'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Fleet', members: [{ sessionId: A }, { sessionId: B }] },
    });
    expect(created.statusCode).toBe(200);
    roomId = created.json().data.id;
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const as = (header: string | undefined) => (header === undefined ? {} : { 'x-codeman-parent-session': header });

  it.each([
    ['an unknown id', 'not-a-session'],
    ['an empty header', ''],
    ['an over-long id', 'a'.repeat(101)],
  ])('refuses %s on owner-only routes and leaves the room untouched', async (_label, header) => {
    for (const request of [
      { method: 'DELETE' as const, url: `/api/chatrooms/${roomId}` },
      { method: 'PUT' as const, url: `/api/chatrooms/${roomId}`, payload: { name: 'Renamed' } },
      { method: 'DELETE' as const, url: `/api/chatrooms/${roomId}/members/${B}` },
      { method: 'POST' as const, url: '/api/chatrooms', payload: { name: 'Forged', members: [] } },
    ]) {
      const res = await app.inject({ ...request, headers: as(header) });
      expect(res.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    }
    expect(service.room(roomId)?.name).toBe('Fleet');
    expect(service.room(roomId)?.members.map((m) => m.sessionId)).toEqual([A, B]);
    expect(service.rooms()).toHaveLength(1);
  });

  it('never posts as the user for an unresolved header', async () => {
    const forged = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      headers: as('not-a-session'),
      payload: { text: 'delete the repo' },
    });
    expect(forged.statusCode).toBe(403);
    expect(service.room(roomId)?.messages.some((m) => m.text === 'delete the repo')).toBe(false);
    const read = await app.inject({ method: 'GET', url: '/api/chatrooms', headers: as('not-a-session') });
    expect(read.statusCode).toBe(403);
  });

  it('refuses an ambiguous prefix but accepts a unique one, which speaks as that agent', async () => {
    const twin = createMockSession(A2);
    ctx.sessions.set(A2, twin as never);
    const ambiguous = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      headers: as(A.slice(0, 8)),
      payload: { text: 'who am I' },
    });
    expect(ambiguous.statusCode).toBe(403);
    ctx.sessions.delete(A2);
    const unique = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      headers: as(A.slice(0, 8)),
      payload: { text: 'from alpha' },
    });
    expect(unique.statusCode).toBe(200);
    expect(unique.json().data.message.from).toMatchObject({ kind: 'agent', sessionId: A });
  });

  it('keeps the existing rules: a live agent is refused owner actions, an absent header is the user', async () => {
    const agent = await app.inject({ method: 'DELETE', url: `/api/chatrooms/${roomId}`, headers: as(B) });
    expect(agent.statusCode).toBe(403);
    expect(service.room(roomId)).toBeDefined();
    const user = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: 'from the dashboard' },
    });
    expect(user.statusCode).toBe(200);
    expect(user.json().data.message.from.kind).toBe('user');
  });

  it('does not touch routes outside the chatroom prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/elsewhere', headers: as('not-a-session') });
    expect(res.statusCode).toBe(200);
  });
});
