/**
 * A plan switch gives an agent a new session. The owner (or the successor itself, proven by one shared conversation) moves the old
 * session's place in every room to it: role, goal, settings, direct messages; the new member is briefed; a different agent never can.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
const D = '00000043-0053-4000-8000-00000000007a';
const AS = (id: string) => ({ 'x-codeman-parent-session': id });

describe('a plan switch: the old session\'s place moves to its successor', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;

  const panes = (id: string): string[] => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer;
  const text = (id: string) => panes(id).join('');
  const names = new Map([[A, 'alpha'], [B, 'alpha'], [C, 'lead'], [D, 'alpha']]);
  let file: string;
  const retiredChanged: string[][] = [];

  beforeEach(async () => {
    retiredChanged.length = 0;
    clock = 1_000_000;
    file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => clock, retiredChanged: (ids) => retiredChanged.push(ids) });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
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
  const room = async (name = 'Fleet', coordinator = true, wake: 'mentions' | 'all' | null = null) => {
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
  const sessionOf = (id: string) => ctx.sessions.get(id) as unknown as { claudeSessionId: string | null };
  const as = (id?: string) => (id ? { 'x-codeman-parent-session': id } : {});
  const replace = (from: string, to: string, caller?: string) =>
    app.inject({ method: 'POST', url: '/api/chatrooms/members/replace', headers: as(caller), payload: { from, to } });
  const make = async (name: string, members: string[], coordinator?: string) =>
    (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name, members: members.map((sessionId) => ({ sessionId })), ...(coordinator ? { coordinatorSessionId: coordinator } : {}) } })).json().data.id as string;
  const memberOf = (roomId: string, sid: string) => service.room(roomId)?.members.find((m) => m.sessionId === sid);
  const audit = () => (existsSync(`${file}.audit.jsonl`) ? readFileSync(`${file}.audit.jsonl`, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  it('the owner moves it: role (coordinator included), goal, progress, voice and notify carry over, in every room, and the successor is briefed', async () => {
    const r1 = await make('Ops', [A, C], A);
    const r2 = await make('Dev', [A, C]);
    await app.inject({ method: 'POST', url: `/api/chatrooms/${r1}/members/${A}/status`, payload: { goal: 'run ops', progress: 'halfway' } });
    await app.inject({ method: 'PUT', url: `/api/chatrooms/${r2}/members/${A}/notify`, payload: { mode: 'mentions' } });
    await settle();
    const res = await replace(A, B);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rooms.map((r: { name: string }) => r.name).sort()).toEqual(['Dev', 'Ops']);
    expect(memberOf(r1, A)).toBeUndefined();
    expect(memberOf(r1, B)).toMatchObject({ role: 'coordinator', goal: 'run ops', progress: 'halfway' });
    expect(memberOf(r2, B)).toMatchObject({ role: 'agent', notify: 'mentions' });
    expect(service.room(r1)?.members.find((m) => m.role === 'coordinator')?.sessionId).toBe(B);
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(B).join('')).toContain('Reverie chatroom "Ops"');
    expect(panes(B).join('')).toContain('COORDINATOR');
    const msgs = (await app.inject({ method: 'GET', url: `/api/chatrooms/${r1}/messages` })).json().data.messages as Array<{ text: string; from: { kind: string } }>;
    expect(msgs.some((m) => m.from.kind === 'system' && m.text === 'alpha moved to a new session')).toBe(true);
    expect(audit().find((a) => a.action === 'replace-session')).toMatchObject({ from: A, to: B });
  });

  it('a direct message follows, and a successor that is already a member just takes over the coordinator seat', async () => {
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data.id as string;
    const r = await make('Ops', [A, B], A);
    await replace(A, B);
    expect(service.room(dm)?.members.map((m) => m.sessionId)).toEqual([B]);
    expect(service.room(dm)?.dm?.sort()).toEqual(['user', B].sort());
    expect(service.room(r)?.members.map((m) => [m.sessionId, m.role])).toEqual([[B, 'coordinator']]);
  });

  it('a successor that is already a member (made with its parent\'s header) inherits goal, progress, voice, notify and away, but keeps what it set itself', async () => {
    const r = await make('Ops', [A, B], A);
    await app.inject({ method: 'POST', url: `/api/chatrooms/${r}/members/${A}/status`, payload: { goal: 'run ops', progress: 'halfway', away: 'back at 3' } });
    await app.inject({ method: 'POST', url: `/api/chatrooms/${r}/members/${B}/status`, payload: { progress: 'just started' } });
    await app.inject({ method: 'PUT', url: `/api/chatrooms/${r}/members/${A}/notify`, payload: { mode: 'mentions' } });
    const old = memberOf(r, A);
    if (old) old.voice = true;
    expect((await replace(A, B)).statusCode).toBe(200);
    expect(service.room(r)?.members).toHaveLength(1);
    expect(memberOf(r, B)).toMatchObject({ role: 'coordinator', goal: 'run ops', progress: 'just started', away: 'back at 3', notify: 'mentions', voice: true });
  });

  it('an agent may only hand over its OWN place, to a successor that resumes its thread and was made by it or the owner', async () => {
    const r = await make('Ops', [A, C], A);
    sessionOf(A).claudeSessionId = 'thread-a';
    // an impostor with the same NAME and another thread, or none
    sessionOf(D).claudeSessionId = 'thread-d';
    expect((await replace(A, D, D)).statusCode).toBe(403);
    expect((await replace(A, D, A)).statusCode).toBe(403);
    sessionOf(D).claudeSessionId = null;
    expect((await replace(A, D, A)).statusCode).toBe(403);
    // the same thread, but the caller is not the old session: the successor itself, or another agent's script
    sessionOf(B).claudeSessionId = 'thread-a';
    expect((await replace(A, B, B)).statusCode).toBe(403);
    expect((await replace(A, B, C)).statusCode).toBe(403);
    // a row another agent created "resuming" A's thread (the hole): refused even when A is the caller
    (ctx.sessions.get(D) as unknown as { parentSessionId?: string }).parentSessionId = C;
    sessionOf(D).claudeSessionId = 'thread-a';
    expect((await replace(A, D, A)).statusCode).toBe(403);
    expect((await replace(A, D, C)).statusCode).toBe(403);
    expect(memberOf(r, A)?.role).toBe('coordinator');
    expect(memberOf(r, B)).toBeUndefined();
    expect(memberOf(r, D)).toBeUndefined();
    // the old session hands over to the successor it (or the owner) made: allowed
    expect((await replace(A, B, A)).statusCode).toBe(200);
    expect(memberOf(r, B)?.role).toBe('coordinator');
  });

  it('a successor made by the old session itself is accepted; the owner can still move anything', async () => {
    const r = await make('Ops', [A, C], A);
    sessionOf(A).claudeSessionId = 'thread-a';
    sessionOf(B).claudeSessionId = 'thread-a';
    (ctx.sessions.get(B) as unknown as { parentSessionId?: string }).parentSessionId = A;
    expect((await replace(A, B, A)).statusCode).toBe(200);
    // a fresh thread, an old session that is gone: only the owner
    const r2 = await make('Dev', [C, D], D);
    ctx.sessions.delete(D);
    sessionOf(A).claudeSessionId = 'fresh-thread';
    expect((await replace(D, A, A)).statusCode).toBe(403);
    expect((await replace(D, A)).statusCode).toBe(200);
    expect(memberOf(r2, A)?.role).toBe('coordinator');
    expect(memberOf(r, B)?.role).toBe('coordinator');
  });

  it('a successor whose thread IS the old row id (it resumed the old session) is accepted from the old session', async () => {
    const r = await make('Ops', [A, C], A);
    sessionOf(B).claudeSessionId = A;
    expect((await replace(A, B, A)).statusCode).toBe(200);
    expect(memberOf(r, B)?.role).toBe('coordinator');
  });

  it('retires the old session: it is in no room, hidden, listed for the owner, and cannot be added back', async () => {
    const r1 = await make('Ops', [A, C], A);
    const r2 = await make('Dev', [A, C]);
    await replace(A, B);
    const list = (await app.inject({ method: 'GET', url: '/api/chatrooms/retired' })).json().data.retired as Array<{ sessionId: string; successorId: string; rooms: Array<{ name: string }>; restorable: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: A, successorId: B, restorable: true });
    expect(list[0].rooms.map((x) => x.name).sort()).toEqual(['Dev', 'Ops']);
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms' })).json().data.retired).toEqual([A]);
    const back = await app.inject({ method: 'POST', url: `/api/chatrooms/${r2}/members`, payload: { sessionId: A } });
    expect(back.statusCode).toBe(409);
    expect(memberOf(r1, A)).toBeUndefined();
  });

  it('only the owner lists, restores or forgets a retired session; restoring swaps the places back and retires the successor', async () => {
    const r1 = await make('Ops', [A, C], A);
    await replace(A, B);
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms/retired', headers: as(C) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/retired/${A}/restore`, headers: as(C) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/chatrooms/retired/${A}`, headers: as(C) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms' , headers: as(C) })).json().data.retired).toEqual([]);
    const restored = await app.inject({ method: 'POST', url: `/api/chatrooms/retired/${A}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(memberOf(r1, A)?.role).toBe('coordinator');
    expect(memberOf(r1, B)).toBeUndefined();
    const list = (await app.inject({ method: 'GET', url: '/api/chatrooms/retired' })).json().data.retired as Array<{ sessionId: string }>;
    expect(list.map((x) => x.sessionId)).toEqual([B]);
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/retired/${A}/restore` })).statusCode).toBe(404);
    // a session that no longer exists cannot be restored, only forgotten
    ctx.sessions.delete(B);
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/retired/${B}/restore` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/chatrooms/retired/${B}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/chatrooms/retired' })).json().data.retired).toEqual([]);
  });

  it('tells the console when a session is retired, restored or deleted, and Delete closes the old session itself', async () => {
    await make('Ops', [A, C], A);
    await replace(A, B);
    expect(retiredChanged).toEqual([[A, B]]);
    await app.inject({ method: 'POST', url: `/api/chatrooms/retired/${A}/restore` });
    expect(retiredChanged.at(-1)).toEqual([B, A]);
    // B is now the retired one: deleting it closes that session (terminal and row) and drops the entry
    const cleanup = (ctx as unknown as { cleanupSession: { mock: { calls: unknown[][] } } }).cleanupSession;
    expect((await app.inject({ method: 'DELETE', url: `/api/chatrooms/retired/${B}` })).statusCode).toBe(200);
    expect(cleanup.mock.calls.some((c) => c[0] === B && c[1] === true)).toBe(true);
    expect(retiredChanged.at(-1)).toEqual([B]);
    expect(service.isRetired(B)).toBe(false);
    // an agent cannot delete one
    await replace(A, B);
    expect((await app.inject({ method: 'DELETE', url: `/api/chatrooms/retired/${A}`, headers: as(C) })).statusCode).toBe(403);
    expect(cleanup.mock.calls.filter((c) => c[0] === A)).toHaveLength(0);
  });

  it('the retired list survives a restart', async () => {
    await make('Ops', [A, C], A);
    await replace(A, B);
    await service.stop();
    const again = new ChatroomService({ file, getSession: (id) => ctx.sessions.get(id), broadcast: () => undefined });
    await again.init();
    expect(again.retiredSessions().map((r) => [r.sessionId, r.successorId])).toEqual([[A, B]]);
    expect(again.isRetired(A)).toBe(true);
    await again.stop();
  });

  it('refuses the same session, an unknown new session, and does nothing for an old one that is in no room', async () => {
    await make('Ops', [A, C]);
    expect((await replace(A, A)).statusCode).toBe(400);
    expect((await replace(A, '00000046-0058-4000-8000-000000000084')).statusCode).toBe(404);
    const none = await replace(D, B);
    expect(none.statusCode).toBe(200);
    expect(none.json().data.rooms).toEqual([]);
  });
});
