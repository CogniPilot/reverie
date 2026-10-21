/**
 * The server half of the conversation shell: the user's read cursor and unread counts (kept with the
 * room, so per owner and across devices), direct messages, placement and archive, and who may see
 * a direct message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { loadChatrooms } from '../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';

type Room = {
  id: string;
  name: string;
  unread: number;
  mentions: number;
  workspace?: string;
  category?: string;
  archivedAt?: number;
  kind?: string;
  dm?: string[];
  lastMessageAt?: number;
};

describe('server counts and read cursor', () => {
  let app: FastifyInstance;
  let service: ChatroomService;
  let clock: number;
  let file: string;
  let events: Array<{ event: string; data: unknown }>;

  beforeEach(async () => {
    clock = 1_000;
    events = [];
    file = join(mkdtempSync(join(tmpdir(), 'chat-unread-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: (event, data) => events.push({ event, data }),
        now: () => clock,
        ownerNames: (owner) => (owner === undefined ? ['Pat'] : []),
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    for (const [id, name] of [
      [A, 'alpha'],
      [B, 'bravo'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      harness.ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  async function makeRoom(name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name, members: [{ sessionId: A }, { sessionId: B }] },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data.id as string;
  }
  const say = (id: string, from: string, text: string, to?: string[]) => {
    clock += 10;
    return app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-codeman-parent-session': from },
      payload: { text, ...(to ? { to } : {}) },
    });
  };
  const listed = async () =>
    Object.fromEntries(
      (await app.inject({ url: '/api/chatrooms' }))
        .json()
        .data.rooms.map((r: Room) => [r.name, r])
    ) as Record<string, Room & { userReadAt: number }>;

  it('counts agent messages after the cursor, with the ones that name the owner or the room apart', async () => {
    const id = await makeRoom('Fleet');
    clock += 10;
    await say(id, A, 'plain one');
    await say(id, B, 'plain two');
    await say(id, A, '@Pat this one is for you');
    const r = (await listed()).Fleet;
    expect(r.unread).toBe(3);
    expect(r.mentions).toBe(1);
  });

  it('a mention is @user, @owner, the owner\u2019s name or @everyone; not @all, @here, a part of a word or an address', async () => {
    const id = await makeRoom('Fleet');
    clock += 10;
    for (const text of ['@user please look', 'ping @OWNER', 'thanks @pat.', '@everyone standup']) await say(id, A, text);
    expect((await listed()).Fleet.mentions).toBe(4);
    const quiet = await makeRoom('Quiet');
    clock += 10;
    for (const text of ['mail pat@user.io', 'ask @users', '@patrick is away', '@allies', 'email me@here.com', 'no names at all', 'heads up @all', '@here now']) await say(quiet, A, text);
    const q = (await listed()).Quiet;
    expect(q.unread).toBe(8);
    expect(q.mentions).toBe(0);
  });

  it('an older message addressed to the user still counts as a mention', async () => {
    const id = await makeRoom('Fleet');
    clock += 10;
    service.room(id)!.messages.push({ id: 'old-1', at: clock + 1, from: { kind: 'agent', sessionId: A, name: 'alpha' }, to: ['user'], text: 'kept from before' } as never);
    const r = (await listed()).Fleet;
    expect(r.mentions).toBe(1);
  });

  it("does not count the user's own messages or system lines", async () => {
    const id = await makeRoom('Fleet');
    clock += 10;
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, payload: { text: 'from me' } });
    service.room(id)!.messages.push({
      id: 'sys-1',
      at: clock + 5,
      from: { kind: 'system', name: 'system' },
      text: 'someone joined',
      to: 'all',
    } as never);
    const r = (await listed()).Fleet;
    expect(r.unread).toBe(0);
    expect(r.mentions).toBe(0);
  });

  it('clears on read, never moves backward, and never past the newest message', async () => {
    const id = await makeRoom('Fleet');
    await say(id, A, 'one');
    const second = (await say(id, A, 'two')).json().data.message.at as number;
    await say(id, A, 'three');
    const half = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: { at: second } });
    expect(half.json().data).toMatchObject({ unread: 1, mentions: 0 });
    const back = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: { at: 1 } });
    expect(back.json().data.unread).toBe(1);
    const future = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: { at: 9_999_999 } });
    expect(future.json().data).toMatchObject({ unread: 0, mentions: 0 });
    // A message after the (clamped) cursor is unread again: the future was not pre-read.
    await say(id, A, 'four');
    expect((await listed()).Fleet.unread).toBe(1);
    const all = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} });
    expect(all.json().data.unread).toBe(0);
  });

  it('persists the cursor with the room so it survives a reload and any device', async () => {
    const id = await makeRoom('Fleet');
    await say(id, A, 'one');
    await say(id, A, 'to you', ['user']);
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} });
    await say(id, A, 'later');
    await service.stop();
    const saved = (await loadChatrooms(file)).find((r) => r.id === id)!;
    expect(saved.userReadAt).toBeGreaterThan(0);
    expect(saved.messages.filter((m) => m.at > saved.userReadAt!)).toHaveLength(1);
  });

  it('tells other devices: a cursor move broadcasts a read change, a no-op does not', async () => {
    const id = await makeRoom('Fleet');
    await say(id, A, 'one');
    events.length = 0;
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} });
    expect(events.filter((e) => (e.data as { action?: string }).action === 'read')).toHaveLength(1);
    events.length = 0;
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} });
    expect(events.filter((e) => (e.data as { action?: string }).action === 'read')).toHaveLength(0);
  });

  it('keeps the cursor for the user: an agent cannot mark a room read', async () => {
    const id = await makeRoom('Fleet');
    await say(id, B, 'one', ['user']);
    const res = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/read`,
      headers: { 'x-codeman-parent-session': A },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect((await listed()).Fleet.unread).toBe(1);
  });

  it('rejects a malformed body and an unknown room', async () => {
    const id = await makeRoom('Fleet');
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: { at: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: { nope: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/chatrooms/missing/read', payload: {} })).statusCode).toBe(404);
  });

  it('carries workspace, category and archive state so the client can roll counts up', async () => {
    const id = await makeRoom('Placed');
    (service.room(id) as { workspace?: string; category?: string }).workspace = 'Reverie';
    (service.room(id) as { workspace?: string; category?: string }).category = 'Build';
    const r = (await listed()).Placed as Room;
    expect([r.workspace, r.category]).toEqual(['Reverie', 'Build']);
  });

  it('keeps timestamps strictly increasing in a room, so a message sharing the read millisecond stays unread', async () => {
    const id = await makeRoom('Fleet');
    clock += 10;
    const first = (await say(id, A, 'one')).json().data.message.at as number;
    // Same millisecond on the server clock: no tick between the two posts.
    const second = (
      await app.inject({
        method: 'POST',
        url: `/api/chatrooms/${id}/messages`,
        headers: { 'x-codeman-parent-session': A },
        payload: { text: 'two' },
      })
    ).json().data.message.at as number;
    expect(second).toBeGreaterThan(first);
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: { at: first } });
    expect((await listed()).Fleet.unread).toBe(1);
    // A clock that steps backwards cannot reorder messages either.
    clock -= 5_000;
    const third = (
      await app.inject({
        method: 'POST',
        url: `/api/chatrooms/${id}/messages`,
        headers: { 'x-codeman-parent-session': B },
        payload: { text: 'three' },
      })
    ).json().data.message.at as number;
    expect(third).toBeGreaterThan(second);
  });

  it('counts a direct message with the user as mentions, and one between agents as nothing', async () => {
    const store = (
      service as unknown as {
        store: { openDm(p: string[], o: undefined, c: { now: number }): { room: { id: string } } };
      }
    ).store;
    const withUser = store.openDm(['user', A], undefined, { now: clock }).room;
    const amongAgents = store.openDm([A, B], undefined, { now: clock }).room;
    clock += 10;
    await say(withUser.id, A, 'psst');
    await say(amongAgents.id, A, 'private chatter');
    // Two-person direct messages have no name, so read the list as rows, not keyed by name.
    const rows = (await app.inject({ url: '/api/chatrooms' })).json().data.rooms as Array<Room>;
    const dmWithUser = rows.find((x) => x.id === withUser.id)!;
    const dmAmong = rows.find((x) => x.id === amongAgents.id)!;
    expect([dmWithUser.unread, dmWithUser.mentions]).toEqual([1, 1]);
    expect([dmAmong.unread, dmAmong.mentions]).toEqual([0, 0]);
    expect(dmWithUser.dm).toEqual(expect.arrayContaining(['user', A]));
    const read = await app.inject({ method: 'POST', url: `/api/chatrooms/${withUser.id}/read`, payload: {} });
    expect(read.json().data).toMatchObject({ unread: 0, mentions: 0 });
  });
});

describe('read cursor per owner in multi-user mode', () => {
  let previous: string | undefined;
  let service: ChatroomService;
  let app: FastifyInstance;

  const build = async (authUser: { username: string; role: 'admin' | 'user' }) => {
    previous = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    const file = join(mkdtempSync(join(tmpdir(), 'chat-unread-mu-')), 'chatrooms.json');
    const harness = await createRouteTestHarness(
      (fastify, c) => {
        service = new ChatroomService({
          file,
          getSession: (id) => c.sessions.get(id),
          broadcast: () => {},
          now: () => 5_000,
        });
        registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
      },
      { authUser }
    );
    app = harness.app;
  };
  afterEach(async () => {
    if (previous === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = previous;
    await service.stop();
    await app.close();
  });

  const seed = (owner: string) => {
    const room = service.createRoom('Mine', owner);
    (room.messages as unknown[]).push({
      id: 'm1',
      at: 6_000,
      from: { kind: 'agent', sessionId: A, name: 'alpha' },
      text: 'hello',
      to: ['user'],
    });
    return room.id;
  };

  it("lets a user clear their own room's unread", async () => {
    await build({ username: 'alice', role: 'user' });
    const id = seed('alice');
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} })).json().data.unread).toBe(0);
  });

  it("does not let an admin looking at someone else's room move that owner's cursor", async () => {
    await build({ username: 'root', role: 'admin' });
    const id = seed('alice');
    const res = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} });
    expect(res.statusCode).toBe(200);
    // The admin is told there is nothing for them to clear; the owner's cursor and counts are untouched.
    expect(res.json().data).toMatchObject({ unread: 0, mentions: 0 });
    expect(service.room(id)!.userReadAt ?? 0).toBeLessThan(6_000);
  });

  it("reports no unread for rooms the viewer does not own, so an admin's badge is never stuck", async () => {
    await build({ username: 'root', role: 'admin' });
    seed('alice');
    const own = service.createRoom('Roots', 'root');
    (own.messages as unknown[]).push({
      id: 'm2',
      at: 6_500,
      from: { kind: 'agent', sessionId: A, name: 'alpha' },
      text: 'hi',
      to: ['user'],
    });
    const rows = Object.fromEntries(
      (await app.inject({ url: '/api/chatrooms' })).json().data.rooms.map((r: Room) => [r.name, r])
    ) as Record<string, Room>;
    expect([rows.Mine.unread, rows.Mine.mentions]).toEqual([0, 0]);
    expect([rows.Roots.unread, rows.Roots.mentions]).toEqual([1, 1]);
  });

  it("hides another user's room from a plain user", async () => {
    await build({ username: 'bob', role: 'user' });
    const id = seed('alice');
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/read`, payload: {} })).statusCode).toBe(404);
  });
});
