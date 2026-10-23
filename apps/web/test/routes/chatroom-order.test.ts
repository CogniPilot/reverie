import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * The owner's channel order: `PUT /api/chatrooms/order` gives the listed channels positions 1..n; it is saved with the rooms (a restart keeps
 * it), only the owner sets it, and it changes nothing an agent sees.
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

describe('channel order', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let file: string;
  const events: string[] = [];

  beforeEach(async () => {
    events.length = 0;
    file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: (event) => events.push(event),
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))), trustedFixtureOwner);
    });
    app = harness.app;
    ctx = harness.ctx;
    const s = createMockSession(A);
    s.name = 'alpha';
    ctx.sessions.set(A, s as never);
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const make = async (name: string) =>
    (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name, members: [{ sessionId: A }] } })).json().data.id as string;
  const order = (ids: string[], headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: '/api/chatrooms/order', headers, payload: { ids } });
  const positions = async () =>
    Object.fromEntries(
      ((await app.inject({ method: 'GET', url: '/api/chatrooms' })).json().data.rooms as Array<{ name: string; position?: number }>).map((r) => [r.name, r.position])
    );

  it('the owner sets it; the list carries each channel\'s position, and a channel nobody placed has none', async () => {
    const [x, y, z] = [await make('X'), await make('Y'), await make('Z')];
    expect(await positions()).toEqual({ X: undefined, Y: undefined, Z: undefined });
    const res = await order([z, x]);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.placed).toBe(2);
    expect(await positions()).toEqual({ X: 2, Y: undefined, Z: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms' })).json().data.features.order).toBe(true);
    void y;
  });

  it('skips unknown ids, repeats and direct messages, and an empty list places nothing', async () => {
    const [x, y] = [await make('X'), await make('Y')];
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data.id as string;
    const res = await order(['nope', y, dm, y, x]);
    expect(res.json().data.placed).toBe(2);
    expect(await positions()).toMatchObject({ Y: 1, X: 2 });
    expect((await order([])).json().data.placed).toBe(0);
    expect((await order([x, 7 as unknown as string])).statusCode).toBe(400);
  });

  it('no agent sets it, and the order survives a restart', async () => {
    const [x, y] = [await make('X'), await make('Y')];
    expect((await order([y, x], { 'x-reverie-parent-session': A })).statusCode).toBe(403);
    expect(await positions()).toEqual({ X: undefined, Y: undefined });
    await order([y, x]);
    await service.stop();
    const again = new ChatroomService({ file, getSession: (id) => ctx.sessions.get(id), broadcast: () => undefined });
    await again.init();
    expect([again.room(y)?.position, again.room(x)?.position]).toEqual([1, 2]);
    await again.stop();
  });

  it('is announced so open pages refresh, and a room view for an agent still lists rooms as before', async () => {
    const [x] = [await make('X'), await make('Y')];
    events.length = 0;
    await order([x]);
    expect(events).toContain('chatroom:changed');
    const mine = (await app.inject({ method: 'GET', url: '/api/chatrooms?member=self', headers: { 'x-reverie-parent-session': A } })).json().data.rooms;
    expect(mine.length).toBe(2);
  });
});
