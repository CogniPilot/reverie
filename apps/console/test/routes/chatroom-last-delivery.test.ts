/**
 * An agent listing its own rooms (GET /api/chatrooms?member=self) is told where its last prompt came from; no one else is.
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

describe('last delivery in the room list', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;

  beforeEach(async () => {
    clock = 1_000_000;
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => clock });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [[A, 'alpha'], [B, 'bravo']] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const room = async (name: string) => (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name, members: [{ sessionId: A }, { sessionId: B }] } })).json().data.id as string;
  const mine = async (headers: Record<string, string> = { 'x-codeman-parent-session': A }, query = 'member=self') =>
    (await app.inject({ method: 'GET', url: `/api/chatrooms?${query}`, headers })).json().data;

  it('tells an agent the room its last prompt came from, then follows the next prompt', async () => {
    const one = await room('One');
    const two = await room('Two');
    // let the briefings of both rooms go out first
    for (let i = 0; i < 3; i++) {
      await service.delivery.flushAll();
      clock += 60_000;
    }
    await app.inject({ method: 'POST', url: `/api/chatrooms/${one}/messages`, payload: { text: 'hello one' } });
    await service.delivery.flushAll();
    expect((await mine()).lastDelivery.roomIds).toEqual([one]);
    clock += 60_000;
    await app.inject({ method: 'POST', url: `/api/chatrooms/${two}/messages`, payload: { text: 'hello two' } });
    await service.delivery.flushAll();
    expect((await mine()).lastDelivery.roomIds).toEqual([two]);
  });

  it('is absent for the user and for a list that is not "member=self"', async () => {
    const one = await room('One');
    for (let i = 0; i < 2; i++) {
      await service.delivery.flushAll();
      clock += 60_000;
    }
    await app.inject({ method: 'POST', url: `/api/chatrooms/${one}/messages`, payload: { text: 'hi' } });
    await service.delivery.flushAll();
    expect('lastDelivery' in (await mine({}, 'member=self'))).toBe(false);
    expect('lastDelivery' in (await mine({ 'x-codeman-parent-session': A }, ''))).toBe(false);
    expect('lastDelivery' in (await mine({ 'x-codeman-parent-session': A }, `member=${B}`))).toBe(false);
  });

  it('is null for an agent that has been delivered nothing yet', async () => {
    const id = (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'One', members: [{ sessionId: A }] } })).json().data.id as string;
    expect(id).toBeTruthy();
    service.delivery.forget(A);
    expect((await mine()).lastDelivery).toBeNull();
  });
});
