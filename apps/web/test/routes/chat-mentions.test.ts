/**
 * @fileoverview `GET /api/chatrooms/mentions` against a database-backed ChatroomService: the exact-caller guard, what the
 * feed returns, cursor paging, the room filter, and that reading it moves no seen mark and acknowledges nothing.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService } from '../../src/chatroom-service.js';
import { registerChatTurnSummary } from '../../src/web/routes/chat-turn-summary.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const headers = { 'x-reverie-parent-session': A };
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'chat-mentions-'));
  let context!: MockRouteContext;
  const service = new ChatroomService({
    file: join(directory, 'rooms.json'),
    database: join(directory, 'chat.db'),
    employeeOf: (id) => 'employee-' + id,
    getSession: (id) => context.sessions.get(id),
    timeZone: () => 'America/New_York',
    broadcast: () => {},
  });
  const { app } = await createRouteTestHarness((app, ctx) => {
    context = ctx;
    ctx.sessions.set(A, createMockSession(A));
    ctx.sessions.set(B, createMockSession(B));
    ctx.sessions.get(A).name = 'Reviewer';
    ctx.sessions.get(B).name = 'Peer';
    registerChatTurnSummary(app, ctx, service);
    app.addHook('onClose', async () => {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    });
  });
  await service.init();
  const office = service.createRoom('Office');
  const lab = service.createRoom('Lab');
  for (const room of [office, lab]) {
    service.addMember(room.id, A);
    service.addMember(room.id, B);
  }
  const peer = { kind: 'agent', sessionId: B, name: 'Peer' } as const;
  const say = (roomId: string, text: string) => service.post(roomId, peer, text, 'all', { deliver: false });
  return { app, service, office, lab, say };
}

it('requires the exact caller and validates its query', async () => {
  const f = await fixture();
  try {
    expect((await f.app.inject({ url: '/api/chatrooms/mentions' })).statusCode).toBe(403);
    for (const query of ['?limit=0', '?limit=201', '?holds=yes', '?since=m9.1.x', '?actor=' + B])
      expect((await f.app.inject({ url: '/api/chatrooms/mentions' + query, headers })).statusCode, query).toBe(400);
  } finally {
    await f.app.close();
  }
});

it('returns mentions across rooms, holds on request, and moves no seen mark', async () => {
  const f = await fixture();
  try {
    const one = f.say(f.office.id, '@Reviewer please look at the branch');
    f.say(f.office.id, 'general chatter');
    const two = f.say(f.lab.id, '@everyone standup in 5');
    const hold = f.say(f.lab.id, 'HOLD the release, CI is red');
    const seen = f.service.lastSeen(A, f.office.id);
    const ack = vi.spyOn(f.service.delivery, 'acknowledgeRead');
    const since = String(one.at - 1);
    const plain = await f.app.inject({ url: `/api/chatrooms/mentions?since=${since}`, headers });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['cache-control']).toBe('no-store');
    const data = plain.json().data;
    expect(data.items.map((i: { messageId: string }) => i.messageId)).toEqual([one.id, two.id]);
    expect(data).toMatchObject({ complete: true, source: 'database', timeZone: 'America/New_York' });
    const withHolds = (await f.app.inject({ url: `/api/chatrooms/mentions?since=${since}&holds=1`, headers })).json()
      .data;
    expect(withHolds.items.map((i: { messageId: string }) => i.messageId)).toEqual([one.id, two.id, hold.id]);
    const labOnly = (
      await f.app.inject({ url: `/api/chatrooms/mentions?since=${since}&roomId=${f.lab.id}`, headers })
    ).json().data;
    expect(labOnly.items.map((i: { messageId: string }) => i.messageId)).toEqual([two.id]);
    expect(f.service.lastSeen(A, f.office.id)).toEqual(seen);
    expect(ack).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it('pages forward by cursor and returns nothing new after the last page', async () => {
  const f = await fixture();
  try {
    const posted = [1, 2, 3].map((n) => f.say(f.office.id, `@Reviewer item ${n}`));
    const first = (
      await f.app.inject({ url: `/api/chatrooms/mentions?since=${posted[0].at - 1}&limit=2`, headers })
    ).json().data;
    expect(first.items.map((i: { messageId: string }) => i.messageId)).toEqual([posted[0].id, posted[1].id]);
    expect(first.complete).toBe(false);
    const second = (await f.app.inject({ url: `/api/chatrooms/mentions?since=${first.next}&limit=2`, headers })).json()
      .data;
    expect(second.items.map((i: { messageId: string }) => i.messageId)).toEqual([posted[2].id]);
    const third = (await f.app.inject({ url: `/api/chatrooms/mentions?since=${second.next}`, headers })).json().data;
    expect(third.items).toEqual([]);
    expect(third.next).toBe(second.next);
  } finally {
    await f.app.close();
  }
});
