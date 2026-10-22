/**
 * Roles step 2, messages family: delete, restore, pin, poll close, emote removal, post and react now ask roles.can()
 * instead of "is this the user". Member refused / Lead allowed / Moderator allowed, rank decides targeting, and a
 * channel override reaches the post route.
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
import { RolesStore, seedAssignmentsFromEnv } from '../../src/roles.js';

const MEMBER = '0000002d-0035-4000-8000-000000000047';
const MOD = '00000038-0043-4000-8000-000000000060';
const LEAD = '0000003e-004c-4000-8000-00000000006f';
const ADMIN = '00000043-0053-4000-8000-00000000007a';
const EMPLOYEES: Record<string, string> = { [MOD]: 'emp-mod', [ADMIN]: 'emp-admin' };

describe('chatroom roles: messages family', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let roomId: string;
  const as = (id?: string) => (id ? { 'x-reverie-parent-session': id } : {});

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatroom-roles-'));
    const roles = new RolesStore(join(dir, 'roles.json'), [
      { employeeId: 'emp-mod', roleId: 'moderator' },
      { employeeId: 'emp-admin', roleId: 'admin' },
    ]);
    await roles.init();
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file: join(dir, 'chatrooms.json'), getSession: (id) => c.sessions.get(id), broadcast: () => undefined });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))), undefined, roles, (id) => EMPLOYEES[id]);
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [[MEMBER, 'plain'], [MOD, 'mod'], [LEAD, 'lead'], [ADMIN, 'admin']] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Reverie', members: [{ sessionId: MEMBER }, { sessionId: MOD }, { sessionId: ADMIN }], coordinatorSessionId: LEAD },
    });
    roomId = res.json().data.id;
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const post = async (from: string | undefined, text: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages`, headers: as(from), payload: { text } });
    return { status: res.statusCode, id: res.json().data?.message?.id as string };
  };
  const call = async (method: 'POST' | 'DELETE', path: string, from?: string, payload?: object) =>
    (await app.inject({ method, url: `/api/chatrooms/${roomId}${path}`, headers: as(from), payload })).statusCode;

  it('delete: Member refused, Lead and Moderator allowed on a lower rank, never on a higher one or the Owner', async () => {
    const own = await post(undefined, 'from the owner');
    const plain = await post(MEMBER, 'from a member');
    const lead = await post(LEAD, 'from the lead');
    const mod = await post(MOD, 'from the moderator');
    expect(await call('DELETE', `/messages/${plain.id}`, MEMBER)).toBe(403);
    expect(await call('DELETE', `/messages/${own.id}`, LEAD)).toBe(403); // the Owner is never a target
    expect(await call('DELETE', `/messages/${mod.id}`, LEAD)).toBe(403); // Moderator outranks Lead
    expect(await call('DELETE', `/messages/${plain.id}`, LEAD)).toBe(200);
    expect(await call('DELETE', `/messages/${lead.id}`, MOD)).toBe(200);
    expect(await call('DELETE', `/messages/${mod.id}`, ADMIN)).toBe(200);
    expect(await call('DELETE', `/messages/${own.id}`)).toBe(200); // the user, as always
  });

  it('restore: needs the deleter\'s rank; the Owner\'s and a Moderator\'s deletions are not undone from below', async () => {
    const byLead = await post(MEMBER, 'deleted by the lead');
    expect(await call('DELETE', `/messages/${byLead.id}`, LEAD)).toBe(200);
    expect(await call('POST', `/messages/${byLead.id}/restore`, MEMBER)).toBe(403);
    expect(await call('POST', `/messages/${byLead.id}/restore`, LEAD)).toBe(200);

    const byOwner = await post(MEMBER, 'deleted by the owner');
    expect(await call('DELETE', `/messages/${byOwner.id}`)).toBe(200);
    expect(await call('POST', `/messages/${byOwner.id}/restore`, LEAD)).toBe(403);
    expect(await call('POST', `/messages/${byOwner.id}/restore`, ADMIN)).toBe(403); // the Owner's counts as rank 100
    expect(await call('POST', `/messages/${byOwner.id}/restore`)).toBe(200);

    const byMod = await post(MEMBER, 'deleted by a moderator');
    expect(await call('DELETE', `/messages/${byMod.id}`, MOD)).toBe(200);
    expect(await call('POST', `/messages/${byMod.id}/restore`, LEAD)).toBe(403);
    expect(await call('POST', `/messages/${byMod.id}/restore`, MOD)).toBe(200);
  });

  it('a system notice is an Owner-only delete target', async () => {
    const room = service.room(roomId)!;
    room.messages.push({ id: 'sys-1', roomId, at: Date.now(), from: { kind: 'system' } as never, to: 'all', text: 'notice' } as never);
    expect(await call('DELETE', '/messages/sys-1', ADMIN)).toBe(403);
    expect(await call('DELETE', '/messages/sys-1')).toBe(200);
  });

  it('pin: Member refused, Lead and Moderator allowed', async () => {
    const m = await post(MEMBER, 'pin me');
    expect(await call('POST', `/messages/${m.id}/pin`, MEMBER)).toBe(403);
    expect(await call('POST', `/messages/${m.id}/pin`, MOD)).toBe(200);
    expect(await call('DELETE', `/messages/${m.id}/pin`, LEAD)).toBe(200);
  });

  it('poll close: the author, or a role with polls.close_others', async () => {
    const make = async (from: string) =>
      (await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/polls`, headers: as(from), payload: { question: 'Ship it?', options: ['yes', 'no'] } })).json().data.message.id as string;
    const byLead = await make(LEAD);
    expect(await call('POST', `/messages/${byLead}/poll/close`, MEMBER)).toBe(403);
    expect(await call('POST', `/messages/${byLead}/poll/close`, MOD)).toBe(200);
    const byMember = await make(MEMBER);
    expect(await call('POST', `/messages/${byMember}/poll/close`, MEMBER)).toBe(200); // its own
  });

  it('emote removal: Member and Lead refused, Moderator passes the permission, a global emote stays the user\'s', async () => {
    expect(await call('DELETE', '/emotes/nope', MEMBER)).toBe(403);
    expect(await call('DELETE', '/emotes/nope', LEAD)).toBe(403); // Lead does not hold emotes.remove
    expect(await call('DELETE', '/emotes/nope', MOD)).toBe(404); // allowed; there is no such emote
    expect(await call('DELETE', '/emotes/nope?scope=global', ADMIN)).toBe(403);
    expect(await call('DELETE', '/emotes/nope?scope=global')).toBe(404);
  });

  it('a channel override on member reaches post and react, but not a role ranked above the setter', async () => {
    const m = await post(LEAD, 'something to react to');
    const room = service.room(roomId)!;
    room.overrides = [{ target: { kind: 'role', id: 'member' }, allow: [], deny: ['messages.post', 'messages.react'], setByRank: 40 }];
    expect((await post(MEMBER, 'blocked')).status).toBe(403);
    expect((await post(MOD, 'moderators still talk')).status).toBe(200);
    expect((await post(LEAD, 'so does the lead')).status).toBe(200);
    const react = (from: string) => call('POST', `/messages/${m.id}/reactions`, from, { emoji: '👍', on: true });
    expect(await react(MEMBER)).toBe(403);
    expect(await react(MOD)).toBe(200);
    room.overrides = [{ target: { kind: 'role', id: 'member' }, allow: [], deny: ['messages.post'], setByRank: 100 }];
    expect((await post(ADMIN, 'owner-set deny binds an Admin too')).status).toBe(403);
    expect((await post(undefined, 'the user posts')).status).toBe(200);
  });

  it('REVERIE_ROLES_SEED: usable entries pass, every dropped one is logged with its reason', () => {
    const logged: string[] = [];
    const seeds = seedAssignmentsFromEnv(
      JSON.stringify([{ employeeId: 'a', roleId: 'admin' }, { employeeId: 'b', roleId: 'member' }, { employeeId: 'c', roleId: 'nope' }, { roleId: 'admin' }, 7]),
      (l) => logged.push(l)
    );
    expect(seeds).toEqual([{ employeeId: 'a', roleId: 'admin' }]);
    expect(logged).toHaveLength(4);
    expect(logged.join('\n')).toMatch(/entry 1 dropped: member/);
    expect(logged.join('\n')).toMatch(/entry 2 dropped: unknown role "nope"/);
    const bad: string[] = [];
    expect(seedAssignmentsFromEnv('{oops', (l) => bad.push(l))).toEqual([]);
    expect(seedAssignmentsFromEnv('{"a":1}', (l) => bad.push(l))).toEqual([]);
    expect(bad).toHaveLength(2);
    expect(seedAssignmentsFromEnv(undefined)).toEqual([]);
  });
});
