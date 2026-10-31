import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * A post that names someone who is not in the room still goes out, and the response carries a heads-up (`warnings`) every front end
 * shows the same way: the CLI, MCP and the page all read this one list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { OfficeAuthService } from '../../src/owner-auth/office.js';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { bootstrap } from '../../src/owner-auth/admin.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const C = '0000003e-004c-4000-8000-00000000006f';
const AS = (id: string) => ({ 'x-reverie-parent-session': id });

describe('post warnings', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;
  let people: OfficeAuthService;

  const panes = (id: string): string[] => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer;
  const text = (id: string) => panes(id).join('');
  const names = new Map([[A, 'alpha'], [B, 'bravo'], [C, 'lead']]);

  beforeEach(async () => {
    clock = 1_000_000;
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const owner = new OwnerAuthStore(join(dirname(file), 'owner-auth.json'));
    await bootstrap(owner, 'fixture-owner', { enforce: true, now: clock });
    people = new OfficeAuthService({ store: owner, auditFile: join(dirname(file), 'audit.jsonl'), now: () => clock });
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => clock });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))), trustedFixtureOwner,
        undefined, undefined, { humanNames: (room) => people.members(room).map((person) => person.name) });
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of names) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  /** A room of the three agents (with `lead` as coordinator unless told not to), briefings already delivered and cleared. */
  const room = async (name = 'Reverie', coordinator = true, wake: 'mentions' | 'all' | null = null) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name, members: [{ sessionId: A }, { sessionId: B }, { sessionId: C }], ...(coordinator ? { coordinatorSessionId: C } : {}) },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;
    if (wake) expect((await app.inject({ method: 'PUT', url: `/api/chatrooms/${id}/wake`, payload: { mode: wake } })).statusCode).toBe(200);
    await settle();
    return id;
  };
  const settle = async () => {
    clock += 10_000;
    await service.delivery.flushAll();
    for (const id of names.keys()) panes(id).length = 0;
  };
  const post = (id: string, text: string, from?: string) =>
    app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, headers: from ? AS(from) : {}, payload: { text } });

  it('posts anyway and warns about an @name nobody in the room goes by', async () => {
    const id = await room();
    const res = await post(id, 'hi @linus and @LINUS, also @alpha', A);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.message.text).toBe('hi @linus and @LINUS, also @alpha');
    expect(data.warnings).toEqual([
      {
        code: 'stray-mention',
        names: ['linus'],
        text: '@linus is not in "Reverie", so they will not see this; ask a coordinator to add them, or post where they are',
      },
    ]);
  });

  it('says nothing for members (any case), @everyone, @user, @owner, and addresses', async () => {
    const id = await room();
    const res = await post(id, '@ALPHA @Bravo @lead @everyone @user @owner mail a@b.com foo@bar me@all.io', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings).toBeUndefined();
  });

  it('accepts an offline permitted limited human mention without changing owner or agent identity', async () => {
    const id = await room();
    const { person } = await people.create({ username: 'river-fixture', name: 'River', role: 'limited', rooms: [id] });
    const ownerNames = service.ownerNames();
    expect(people.members(service.room(id)!).find((p) => p.id === person.id)?.online).toBe(false);
    const res = await post(id, '@River please review @alpha', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings).toBeUndefined();
    expect(res.json().data.message.from).toMatchObject({ kind: 'agent', sessionId: A });
    expect(service.ownerNames()).toEqual(ownerNames);
    expect(service.ownerNames()).not.toContain('River');
    expect(service.room(id)!.members.some((m) => m.sessionId === person.id)).toBe(false);
    expect(ctx.sessions.has(person.id)).toBe(false);
  });

  it('keeps unknown names distinct from a permitted human', async () => {
    const id = await room();
    await people.create({ username: 'river-fixture', name: 'River', role: 'limited', rooms: [id] });
    const res = await post(id, '@River and @Nobody please review', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings.map((w: { names: string[] }) => w.names)).toEqual([['Nobody']]);
  });

  it('rechecks current room grants and excludes revoked or cross-room human names', async () => {
    const id = await room('Office'), other = await room('Elsewhere');
    const { person } = await people.create({ username: 'river-fixture', name: 'River', role: 'limited', rooms: [id] });
    expect((await post(id, '@River', A)).json().data.warnings).toBeUndefined();
    expect((await post(other, '@River', A)).json().data.warnings[0].names).toEqual(['River']);
    await people.update(person.id, { rooms: [other] });
    expect((await post(id, '@River', A)).json().data.warnings[0].names).toEqual(['River']);
    expect((await post(other, '@River', A)).json().data.warnings).toBeUndefined();
    await people.update(person.id, { disabled: true });
    expect((await post(other, '@River', A)).json().data.warnings[0].names).toEqual(['River']);
  });

  it('does not recognize human names from another owned room', async () => {
    const id = await room();
    await people.create({ username: 'river-fixture', name: 'River', role: 'limited', rooms: [id] });
    const owned = service.room(id)!;
    owned.owner = 'another-owner';
    expect(people.members(owned)).toEqual([]);
    const res = await post(id, '@River', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings[0].names).toEqual(['River']);
  });

  it('does not store a message when permitted human metadata cannot be read', async () => {
    const id = await room();
    const count = service.room(id)!.messages.length;
    people.members = () => { throw Error('Owned metadata failure'); };
    const res = await post(id, '@River', A);
    expect(res.statusCode).toBe(500);
    expect(service.room(id)!.messages).toHaveLength(count);
  });

  it('tells the writer @all and @here no longer notify anyone, and to use @everyone', async () => {
    const id = await room();
    const res = await post(id, '@all heads up, @HERE too', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings).toEqual([
      { code: 'retired-mention', names: ['all', 'here'], text: '@all and @here no longer notify anyone; use @everyone to reach the whole room' },
    ]);
    const one = await post(id, 'ping @here', A);
    expect(one.json().data.warnings[0].text).toBe('@here no longer notifies anyone; use @everyone to reach the whole room');
  });

  it('says nothing about @all or @here when a member really goes by that name', async () => {
    (ctx.sessions.get(C) as unknown as { name: string }).name = 'All';
    (ctx.sessions.get(B) as unknown as { name: string }).name = 'here';
    const id = await room();
    const res = await post(id, '@all and @HERE, please look', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings).toBeUndefined();
  });

  it('warns the owner too, and lists several names in one line', async () => {
    const id = await room();
    const res = await post(id, 'ping @linus and @ada');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings).toHaveLength(1);
    expect(res.json().data.warnings[0].names).toEqual(['linus', 'ada']);
    expect(res.json().data.warnings[0].text).toContain('@linus, @ada are not in "Reverie"');
  });

  it('a refused post carries no warning and a DM is called "Direct message"', async () => {
    const id = await room();
    const refused = await post(id, '@linus', '00000043-0053-4000-8000-00000000007a');
    expect(refused.statusCode).toBe(403);
    const dm = await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } });
    expect(dm.statusCode).toBe(200);
    const res = await post(dm.json().data.id, 'hello @linus');
    expect(res.json().data.warnings[0].text).toContain('"Direct message"');
  });

  /** Stand-in for the server's record of what a member has seen in a room (delivered to its prompt, or read). */
  const seenAs = (lookup: (sessionId: string, roomId: string) => { messageId: string; at: number } | string | undefined) => {
    service.lastSeen = (sessionId, roomId) => {
      const seen = lookup(sessionId, roomId);
      return typeof seen === 'string' ? { messageId: seen, at: 0 } : seen;
    };
  };
  const idOf = async (res: ReturnType<typeof post>) => (await res).json().data.message.id as string;

  it('warns about newer messages from others, in this room only, never counting its own posts', async () => {
    const id = await room('Reverie');
    const other = await room('Other');
    const first = await idOf(post(id, 'one', B));
    await post(id, 'two', C);
    await post(id, 'mine', A);
    await post(id, 'three', B);
    await post(other, 'elsewhere', C);
    seenAs(() => first);
    const res = await post(id, 'hello', A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.warnings).toEqual([
      {
        code: 'newer-unread',
        names: ['lead', 'bravo'],
        text: '2 newer messages from lead, bravo in "Reverie" came in before this was posted; run: reverie agent chat read',
      },
    ]);
  });

  it('is quiet when caught up, when the server has no record, or for a caller that is not an agent', async () => {
    const id = await room('Reverie');
    await post(id, 'one', B);
    const last = await idOf(post(id, 'two', C));
    seenAs(() => last);
    expect((await post(id, 'a', A)).json().data.warnings).toBeUndefined();
    seenAs(() => undefined);
    expect((await post(id, 'b', A)).json().data.warnings).toBeUndefined();
    const lastAt = (await post(id, 'x', C)).json().data.message.at as number;
    seenAs(() => ({ messageId: 'no-such-message', at: lastAt })); // marker gone from the window: its time decides
    expect((await post(id, 'c', A)).json().data.warnings).toBeUndefined();
    seenAs(() => ({ messageId: 'no-such-message', at: 0 }));
    expect((await post(id, 'c2', A)).json().data.warnings[0].code).toBe('newer-unread');
    seenAs(() => '00000000-0000-4000-8000-000000000000');
    expect((await post(id, 'd')).json().data.warnings).toBeUndefined();
  });

  it("names the owner by their display name, not the stored 'user'", async () => {
    const id = await room('Reverie');
    const first = await idOf(post(id, 'one', B));
    await post(id, 'owner here');
    seenAs(() => first);
    const plain = await post(id, 'hello', A);
    expect(plain.json().data.warnings[0].names).toEqual(['user']);
    service.ownerNames = () => ['Pat Doe', 'pat'];
    const named = await post(id, 'again', A);
    expect(named.json().data.warnings[0].names).toEqual(['Pat Doe']);
    expect(named.json().data.warnings[0].text).toContain('from Pat Doe in "Reverie"');
  });

  it('puts a stray @name and a newer-unread line side by side, one of each', async () => {
    const id = await room('Reverie');
    const first = await idOf(post(id, 'one', B));
    await post(id, 'two', C);
    seenAs(() => first);
    const res = await post(id, 'hi @linus', A);
    expect(res.json().data.warnings.map((w: { code: string }) => w.code)).toEqual(['stray-mention', 'newer-unread']);
  });

  it('keeps an away note on the member, shows it in the room, and clears it with an empty one', async () => {
    const id = await room('Reverie');
    const set = (away: string) =>
      app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members/${A}/status`, headers: AS(A), payload: { away } });
    const awayOf = async () => {
      const res = await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` });
      return (res.json().data.members as { sessionId: string; away?: string }[]).find((m) => m.sessionId === A)?.away;
    };
    expect((await set('back at 3')).statusCode).toBe(200);
    expect(await awayOf()).toBe('back at 3');
    expect((await set('')).statusCode).toBe(200);
    expect(await awayOf()).toBeUndefined();
    const other = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members/${B}/status`, headers: AS(A), payload: { away: 'x' } });
    expect(other.statusCode).toBe(403);
  });
});
