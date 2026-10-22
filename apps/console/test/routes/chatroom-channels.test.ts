/**
 * Public and private channels. A room is private (members only) unless the owner makes it public. An agent lists the rooms it is in,
 * can list the public channels it is not in (name, topic and size only) and join one itself; a private channel is not there for it at
 * all. A non-member sees nothing said in a room. Only the owner or the room's coordinator changes visibility. Direct messages are always private.
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
const C = '0000003e-004c-4000-8000-00000000006f';
const AS = (id: string) => ({ 'x-reverie-parent-session': id });

describe('public and private channels', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let events: Array<{ event: string; data: unknown }>;

  beforeEach(async () => {
    events = [];
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: (event, data) => events.push({ event, data }) });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [[A, 'alpha'], [B, 'bravo'], [C, 'lead']] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const make = async (name: string, members: string[], topic?: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name, members: members.map((sessionId) => ({ sessionId })) } });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;
    if (topic) await app.inject({ method: 'PUT', url: `/api/chatrooms/${id}`, payload: { topic } });
    return id;
  };
  const setVisibility = (id: string, visibility: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: `/api/chatrooms/${id}/visibility`, headers, payload: { visibility } });
  const publicList = (as?: string) => app.inject({ method: 'GET', url: '/api/chatrooms/public', headers: as ? AS(as) : {} });
  const joinChannel = (id: string, as: string) => app.inject({ method: 'POST', url: `/api/chatrooms/${id}/join`, headers: AS(as), payload: {} });

  it('every room is private until the owner changes it, and the room view says which', async () => {
    const id = await make('general', [A]);
    const view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    expect(view.visibility).toBe('private');
    expect((await setVisibility(id, 'public')).json().data.visibility).toBe('public');
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms' })).json().data.rooms.find((r: { id: string }) => r.id === id).visibility).toBe('public');
    expect((await setVisibility(id, 'private')).json().data.visibility).toBe('private');
  });

  it('only the owner changes it, with a strict value, never a direct message', async () => {
    const id = await make('News', [A]);
    expect((await setVisibility(id, 'public', AS(A))).statusCode).toBe(403);
    expect((await setVisibility(id, 'secret')).statusCode).toBe(400);
    expect((await setVisibility('nope', 'public')).statusCode).toBe(404);
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data;
    expect((await setVisibility(dm.id, 'public')).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${dm.id}` })).json().data.visibility).toBe('private');
  });

  it('the room\'s coordinator may make it public or private, every other agent may not, and every change is logged in the room', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Ops', members: [{ sessionId: A }, { sessionId: B }], coordinatorSessionId: B },
    });
    const id = res.json().data.id as string;
    const lines = async () =>
      ((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/messages` })).json().data.messages as Array<{ from: { kind: string }; text: string }>)
        .filter((m) => m.from.kind === 'system' && /made this channel/.test(m.text))
        .map((m) => m.text);
    expect((await setVisibility(id, 'public', AS(A))).statusCode).toBe(403);
    expect((await setVisibility(id, 'public', AS(C))).statusCode).toBe(404); // not in the room: it does not exist for C
    expect(await lines()).toEqual([]);
    const made = await setVisibility(id, 'public', AS(B));
    expect(made.statusCode).toBe(200);
    expect(made.json().data.visibility).toBe('public');
    expect(((await publicList(C)).json().data.rooms as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);
    expect((await setVisibility(id, 'public', AS(B))).statusCode).toBe(200); // already public: nothing new is logged
    expect((await setVisibility(id, 'private', AS(B))).json().data.visibility).toBe('private');
    expect(await lines()).toEqual(['bravo made this channel public', 'bravo made this channel private']);
    // the owner can always override, and is named as the owner
    expect((await setVisibility(id, 'public')).json().data.visibility).toBe('public');
    expect((await lines()).at(-1)).toBe('The owner made this channel public');
    // an agent that is not in the room does not even see it
    expect((await setVisibility(id, 'private', AS(C))).statusCode).toBe(404);
    expect((await setVisibility(id, 'secret', AS(B))).statusCode).toBe(400);
  });

  it('lists only public channels, and only name, topic and size, never a private one or what is said in one', async () => {
    const pub = await make('News', [A, B], 'Daily digest');
    await app.inject({ method: 'POST', url: `/api/chatrooms/${pub}/messages`, payload: { text: 'secret plan inside' } });
    await make('Staff room', [A]);
    await setVisibility(pub, 'public');
    const list = (await publicList(C)).json().data.rooms as Array<Record<string, unknown>>;
    expect(list).toEqual([{ id: pub, name: 'News', topic: 'Daily digest', memberCount: 2, joined: false }]);
    expect(JSON.stringify(list)).not.toContain('secret plan');
    // a member sees itself as joined
    expect(((await publicList(A)).json().data.rooms as Array<{ joined: boolean }>)[0].joined).toBe(true);
    // the room the agent is not in is not in its own list of rooms
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms?member=self', headers: AS(C) })).json().data.rooms).toEqual([]);
  });

  it('an agent joins a public channel itself, through the add checks, and a private one refuses with what to do', async () => {
    const pub = await make('News', [A]);
    const priv = await make('general', [A]);
    await setVisibility(pub, 'public');
    const refused = await joinChannel(priv, C);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain('ask the owner');
    const ok = await joinChannel(pub, C);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.joined).toBe(true);
    expect(service.room(pub)!.members.some((m) => m.sessionId === C)).toBe(true);
    // shown in the room, and a second join changes nothing
    expect(service.room(pub)!.messages.some((m) => m.from.kind === 'system' && /joined/.test(m.text))).toBe(true);
    expect((await joinChannel(pub, C)).json().data.joined).toBe(false);
    // the owner does not join (it adds), a direct message cannot be joined, an unknown room is 404
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${pub}/join`, payload: {} })).statusCode).toBe(403);
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data;
    expect((await joinChannel(dm.id, C)).statusCode).toBe(404);
    expect((await joinChannel('nope', C)).statusCode).toBe(404);
  });

  it('a session that is not a live chat session cannot join: the same checks as being added', async () => {
    const pub = await make('News', [A]);
    await setVisibility(pub, 'public');
    const res = await joinChannel(pub, '00000043-0053-4000-8000-00000000007a');
    expect(res.statusCode).not.toBe(200);
    expect(service.room(pub)!.members.map((m) => m.sessionId)).toEqual([A]);
  });

  it('a non-member sees nothing of a room: private is 404, public says how to join, and after joining it reads and posts', async () => {
    const pub = await make('News', [A]);
    const priv = await make('general', [A]);
    await setVisibility(pub, 'public');
    for (const [id, headers] of [[priv, AS(C)], [pub, AS(C)]] as const) {
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/messages`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, headers, payload: { text: 'hello' } })).statusCode).toBe(404);
    }
    const hint = (await app.inject({ method: 'GET', url: `/api/chatrooms/${pub}/messages`, headers: AS(C) })).json().error as string;
    expect(hint).toContain('join it first');
    expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${priv}/messages`, headers: AS(C) })).json().error).not.toContain('join');
    await joinChannel(pub, C);
    expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${pub}/messages`, headers: AS(C) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${pub}/messages`, headers: AS(C), payload: { text: 'hello' } })).statusCode).toBe(200);
  });

  it('leaving removes the session, and the owner still sees every room', async () => {
    const pub = await make('News', [A]);
    await setVisibility(pub, 'public');
    await joinChannel(pub, C);
    const left = await app.inject({ method: 'DELETE', url: `/api/chatrooms/${pub}/members/${C}`, headers: AS(C) });
    expect(left.statusCode).toBe(200);
    expect(service.room(pub)!.members.some((m) => m.sessionId === C)).toBe(false);
    const priv = await make('general', [A]);
    const all = (await app.inject({ method: 'GET', url: '/api/chatrooms' })).json().data.rooms as Array<{ id: string }>;
    expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([pub, priv]));
  });

  it('the visibility survives a restart', async () => {
    const id = await make('News', [A]);
    await setVisibility(id, 'public');
    await service.stop();
    const again = new ChatroomService({ file: (service as unknown as { deps: { file: string } }).deps.file, getSession: (sid) => ctx.sessions.get(sid), broadcast: () => {} });
    await again.init();
    expect(again.room(id)?.visibility).toBe('public');
    await again.stop();
  });
});
