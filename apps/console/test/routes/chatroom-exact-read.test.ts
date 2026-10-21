import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

it('exact-read routes preserve membership scope, require an agent and never acknowledge on GET', async () => {
  const a = '0000002d-0035-4000-8000-000000000047';
  const b = '00000038-0043-4000-8000-000000000060';
  const dir = mkdtempSync(join(tmpdir(), 'exact-api-'));
  let service!: ChatroomService;
  const { app } = await createRouteTestHarness((fastify, c) => {
    c.sessions.set(a, createMockSession(a));
    c.sessions.set(b, createMockSession(b));
    service = new ChatroomService({ file: join(dir, 'rooms.json'), getSession: (id) => c.sessions.get(id), broadcast: () => {} });
    registerChatroomRoutes(fastify, c, service, new ChatFileStore(dir));
  });
  await service.init();
  try {
    service.delivery.stop();
    const room = service.createRoom('private', undefined);
    service.addMember(room.id, a);
    const message = service.post(room.id, { kind: 'user', name: 'owner' }, 'read this', 'all', { deliver: false });
    service.delivery.holdForInspection(a, [{ roomId: room.id, messageId: message.id }]);
    const headers = { 'x-codeman-parent-session': a };
    const url = `/api/chatrooms/${room.id}/messages/${message.id}`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: { 'x-codeman-parent-session': b } })).statusCode).toBe(404);
    const read = await app.inject({ method: 'GET', url, headers });
    expect(read.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms/delivery-status', headers })).json().data.blocked).toBe(true);
    expect((await app.inject({ method: 'POST', url: url + '/read-ack', headers, payload: { readToken: 'guessed' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: url + '/read-ack', headers, payload: { readToken: read.json().data.readToken } })).statusCode).toBe(200);
    expect(service.deliveryStatus(a).blocked).toBe(false);
    expect(service.room(room.id)?.messages.some((m) => m.id === message.id)).toBe(true);
  } finally { await service.stop(); await app.close(); }
});
