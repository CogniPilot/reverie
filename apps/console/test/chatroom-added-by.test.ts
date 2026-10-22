/**
 * @fileoverview Chatroom members record which agent added them (`addedBy`), so owner sign-in can
 * tell owner-made seats from agent-made ones. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession, type MockRouteContext } from './mocks/index.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';

const LEAD = '0000002d-0035-4000-8000-000000000047';
const WORKER = '00000038-0043-4000-8000-000000000060';
const OTHER = '0000003e-004c-4000-8000-00000000006f';

describe('chatroom members record who added them', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;

  beforeEach(async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-added-by-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => 1_000_000 });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const id of [LEAD, WORKER, OTHER]) ctx.sessions.set(id, createMockSession(id) as never);
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const members = (roomId: string) => service.room(roomId)!.members.map((m) => [m.sessionId, m.role, m.addedBy]);

  it('the user creates and adds without a mark; an agent-built room and its adds carry the agent', async () => {
    const owned = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Owned', members: [{ sessionId: WORKER }], coordinatorSessionId: LEAD },
    });
    expect(owned.statusCode).toBe(200);
    const ownedId = owned.json().data.id;
    expect(members(ownedId)).toEqual([
      [WORKER, 'agent', undefined],
      [LEAD, 'coordinator', undefined],
    ]);

    // The owner-appointed coordinator adds a member: marked as its add.
    const add = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${ownedId}/members`,
      headers: { 'x-reverie-parent-session': LEAD },
      payload: { sessionId: OTHER },
    });
    expect(add.statusCode).toBe(200);
    expect(members(ownedId)).toContainEqual([OTHER, 'agent', LEAD]);

    // A room the coordinator builds itself: every seat, its own included, is marked.
    const built = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      headers: { 'x-reverie-parent-session': LEAD },
      payload: { name: 'Built', members: [{ sessionId: OTHER }] },
    });
    expect(built.statusCode).toBe(200);
    expect(members(built.json().data.id)).toEqual([
      [OTHER, 'agent', LEAD],
      [LEAD, 'coordinator', LEAD],
    ]);

    // The user's own add stays unmarked.
    const userAdd = await app.inject({ method: 'POST', url: `/api/chatrooms/${built.json().data.id}/members`, payload: { sessionId: WORKER } });
    expect(userAdd.statusCode).toBe(200);
    expect(members(built.json().data.id)).toContainEqual([WORKER, 'agent', undefined]);
  });

  it('the mark survives a reload', async () => {
    const room = service.createRoom('Kept', undefined);
    service.addMember(room.id, WORKER, { addedBy: LEAD });
    await service.stop();
    const file = (service as unknown as { deps: { file: string } }).deps.file;
    const reloaded = new ChatroomService({ file, getSession: (id) => ctx.sessions.get(id), broadcast: () => {}, now: () => 1 });
    await reloaded.init();
    expect(reloaded.room(room.id)!.members[0].addedBy).toBe(LEAD);
    await reloaded.stop();
  });
});
