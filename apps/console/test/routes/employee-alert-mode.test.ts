import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

it('own-mode API refuses missing/unbound callers and caps leases without changing room visibility', async () => {
  const a = '0000002d-0035-4000-8000-000000000047';
  const b = '00000038-0043-4000-8000-000000000060';
  const dir = mkdtempSync(join(tmpdir(), 'alert-api-'));
  let service!: ChatroomService;
  const employeeOf = (id: string) => (id === a ? 'employee-a' : undefined);
  const { app, ctx } = await createRouteTestHarness((fastify, c) => {
    c.sessions.set(a, createMockSession(a));
    c.sessions.set(b, createMockSession(b));
    service = new ChatroomService({
      file: join(dir, 'rooms.json'),
      employeeOf,
      getSession: (id) => c.sessions.get(id),
      broadcast: () => {},
    });
    registerChatroomRoutes(fastify, c, service, new ChatFileStore(dir), undefined, undefined, employeeOf);
  });
  await service.init();
  try {
    expect(ctx.sessions.has(a)).toBe(true);
    const url = '/api/chatrooms/alert-mode';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: { 'x-codeman-parent-session': b } })).statusCode).toBe(403);
    const headers = { 'x-codeman-parent-session': a };
    const quiet = await app.inject({ method: 'POST', url, headers, payload: { mode: 'silent', durationMs: 3600000 } });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json().data.alertMode.mode).toBe('silent');
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { mode: 'silent', durationMs: 28800001 },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url, headers })).json().data.alertMode.mode).toBe('silent');
    const privateRoom = service.createRoom('private', undefined);
    const denied = await app.inject({ method: 'GET', url: `/api/chatrooms/${privateRoom.id}`, headers });
    expect(denied.statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { mode: 'ring', durationMs: 1 } })).json().data
        .alertMode
    ).toBeNull();
  } finally {
    await service.stop();
    await app.close();
  }
});
