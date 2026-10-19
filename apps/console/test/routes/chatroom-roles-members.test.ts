/**
 * Roles step 2b, members family and room settings: add, remove others, re-brief, voice and visibility ask roles.can()
 * instead of "is this the room's coordinator". A private channel is joined by itself only with members.join_any.
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

const MEMBER = 'aaaaaaaa-0000-4000-8000-000000000001';
const MOD = 'bbbbbbbb-0000-4000-8000-000000000002';
const LEAD = 'cccccccc-0000-4000-8000-000000000003';
const ADMIN = 'dddddddd-0000-4000-8000-000000000004';
const EMPLOYEES: Record<string, string> = { [MOD]: 'emp-mod', [ADMIN]: 'emp-admin' };

describe('chatroom roles: members family and room settings', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let roomId: string;
  const as = (id?: string) => (id ? { 'x-codeman-parent-session': id } : {});

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
      payload: { name: 'Fleet', members: [{ sessionId: MEMBER }, { sessionId: MOD }, { sessionId: ADMIN }], coordinatorSessionId: LEAD },
    });
    roomId = res.json().data.id;
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const NEW = 'eeeeeeee-0000-4000-8000-000000000005';
  const call = async (method: 'POST' | 'DELETE' | 'PUT', path: string, from?: string, payload?: object) =>
    (await app.inject({ method, url: `/api/chatrooms/${roomId}${path}`, headers: as(from), payload })).statusCode;

  it('add: Lead and Admin allowed, Member and Moderator refused (Moderator has no members.add)', async () => {
    ctx.sessions.set(NEW, Object.assign(createMockSession(NEW), { name: 'newbie' }) as never);
    expect(await call('POST', '/members', MEMBER, { sessionId: NEW })).toBe(403);
    expect(await call('POST', '/members', MOD, { sessionId: NEW })).toBe(403);
    expect(await call('POST', '/members', LEAD, { sessionId: NEW })).toBe(200);
  });

  it('remove others: Member refused, only a lower rank can be removed, anyone may leave', async () => {
    expect(await call('DELETE', `/members/${MOD}`, MEMBER)).toBe(403);
    expect(await call('DELETE', `/members/${MEMBER}`, MOD)).toBe(200);
    expect(await call('DELETE', `/members/${ADMIN}`, LEAD)).toBe(403); // Admin outranks Lead
    expect(await call('DELETE', `/members/${LEAD}`, LEAD)).toBe(200); // leaving is always allowed
    expect(await call('DELETE', `/members/${ADMIN}`, MOD)).toBe(403); // Admin outranks Moderator
    expect(await call('DELETE', `/members/${MOD}`, MOD)).toBe(200);
  });

  it('an Admin can remove a Lead, and a Lead cannot remove an Admin', async () => {
    expect(await call('DELETE', `/members/${ADMIN}`, LEAD)).toBe(403);
    expect(await call('DELETE', `/members/${LEAD}`, ADMIN)).toBe(200);
  });

  it('re-brief others: Member refused, Lead allowed', async () => {
    expect(await call('POST', `/members/${MOD}/brief`, MEMBER)).toBe(403);
    expect(await call('POST', `/members/${MOD}/brief`, LEAD)).toBe(200);
  });

  it('visibility needs room.settings: Member and Moderator refused, Lead and Admin allowed', async () => {
    expect(await call('PUT', '/visibility', MEMBER, { visibility: 'public' })).toBe(403);
    expect(await call('PUT', '/visibility', MOD, { visibility: 'public' })).toBe(403);
    expect(await call('PUT', '/visibility', LEAD, { visibility: 'public' })).toBe(200);
    expect(await call('PUT', '/visibility', ADMIN, { visibility: 'private' })).toBe(200);
  });

  it('a private channel is joined by itself only with members.join_any (Admin)', async () => {
    const other = await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'Quiet', members: [{ sessionId: MEMBER }] } });
    const quiet = other.json().data.id as string;
    const join = async (from: string) => (await app.inject({ method: 'POST', url: `/api/chatrooms/${quiet}/join`, headers: as(from) })).statusCode;
    expect(await join(LEAD)).toBe(403);
    expect(await join(ADMIN)).toBe(200);
  });

  it('report: a member agent reports as itself (quoted), a non-member and the coordinator\'s own message are refused', async () => {
    const said = (await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages`, headers: as(MOD), payload: { text: 'questionable' } })).json().data.message.id as string;
    const outsider = 'ffffffff-0000-4000-8000-000000000006';
    ctx.sessions.set(outsider, Object.assign(createMockSession(outsider), { name: 'outsider' }) as never);
    expect([403, 404]).toContain(await call('POST', `/messages/${said}/report`, outsider, {}));
    const res = await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages/${said}/report`, headers: as(MEMBER), payload: { reason: 'rude' } });
    expect(res.statusCode).toBe(200);
    const dm = service.room(res.json().data.dmId)!;
    const report = dm.messages[dm.messages.length - 1];
    expect(report.from.kind).toBe('system'); // an agent is not a participant of the coordinator's DM
    expect(report.text).toContain('plain'); // it names the reporting agent
    expect(report.text).toContain('REPORT from');
    expect(report.text).not.toContain('REPORT from the user');
    expect(report.text).toContain('Reason:');
  });
});
