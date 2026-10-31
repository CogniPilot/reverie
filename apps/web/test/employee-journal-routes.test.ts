/** Actual cookie classification; synthetic company, messages and an in-memory journal. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { callerOf, OWNER_COOKIE, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { EmployeeSchema, type CompanyEmployee } from '../src/company-types.js';
import { EmployeeJournalStore } from '../src/employee-journal.js';
import type { ChatMessage } from '../src/chatroom-store.js';
import { registerEmployeeJournalRoutes } from '../src/web/routes/employee-journal-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROOM = 'room-one';
describe('employee journal routes', () => {
  let root: string, app: FastifyInstance, ownerToken: string, serviceToken: string;
  let employees: CompanyEmployee[]; let store: EmployeeJournalStore;
  let messages: ChatMessage[]; let members: Set<string>;
  let session: { id: string; owner: undefined; pid: number | null };
  const hire = (id: string, sessionId: string) => EmployeeSchema.parse({ id, name: id, icon: 'A', position: 'Engineer', expertise: ['Testing'],
    sessionId, sessionGeneration: 1, createdAt: 1, desiredRunning: true });
  const post = (id: string, text: string, at: number, from: ChatMessage['from'] = { kind: 'user', name: 'Owner' }) =>
    messages.push({ id, roomId: ROOM, at, from, to: 'all', text });
  beforeEach(async () => {
    root = await mkdtemp(join(realpathSync(tmpdir()), 'employee-journal-'));
    const authStore = new OwnerAuthStore(join(root, 'owner.json'));
    const { oneTimePassword } = await bootstrap(authStore, 'synthetic-owner');
    serviceToken = await issueServiceToken(authStore, 'synthetic-service');
    const service = new OwnerAuthService({ store: authStore, auditFile: join(root, 'audit.jsonl') });
    employees = [hire('employee-one', SID), hire('employee-two', OTHER)];
    session = { id: SID, owner: undefined, pid: 123 };
    const ctx = { sessions: new Map([[SID, session], [OTHER, { id: OTHER, owner: undefined, pid: 456 }]]) } as unknown as SessionPort;
    store = EmployeeJournalStore.open(':memory:', () => Date.parse('2026-10-30T04:00:00Z'));
    messages = []; members = new Set([SID, OTHER]);
    post('m-source', 'Please use exact UTC times in every record.', 100);
    post('m-turn', 'Remember this: records carry exact UTC times.', 200);
    app = Fastify(); await app.register(cookie); registerOwnerRoutes(app, service, false);
    registerEmployeeJournalRoutes(app, ctx, { verifiedOwner: ownerVerifier({ service, ctx }),
      agentSession: request => { const caller = callerOf(request, { service, ctx }); return caller.kind === 'agent' ? caller.session : undefined; },
      company: () => ({ employees }), journal: () => store,
      visibleMessage: (sessionId, roomId, messageId) => {
        const message = messages.find(row => row.roomId === roomId && row.id === messageId);
        if (!members.has(sessionId) || !message) throw new Error('not visible');
        return structuredClone(message);
      } });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: 'synthetic-owner', password: oneTimePassword } });
    const changed = await app.inject({ method: 'POST', url: '/api/owner/password', headers: { origin: 'http://localhost' },
      cookies: { [OWNER_COOKIE]: login.cookies.find(value => value.name === OWNER_COOKIE)!.value },
      payload: { current: oneTimePassword, next: 'Synthetic!new-owner-journal-784' } });
    expect(changed.statusCode).toBe(200); ownerToken = changed.cookies.find(value => value.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => { await app?.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const as = (sessionId: string) => ({ 'x-reverie-parent-session': sessionId });
  const save = (sessionId = SID, body: object = { roomId: ROOM, turnId: 'm-turn', draft: { text: 'Records carry exact UTC times.', tags: ['promise'],
    sources: [{ roomId: ROOM, id: 'm-source', quote: 'exact UTC times' }] } }) =>
    app.inject({ method: 'POST', url: '/api/agent/journal/save', payload: body, headers: as(sessionId) });

  it('writes only to the caller’s own journal and refuses owner, service and spoofed callers', async () => {
    const saved = await save();
    expect(saved.statusCode).toBe(200); expect(saved.json().data).toMatchObject({ entryId: 1, turnId: 'm-turn', replayed: false });
    expect((await save(SID, { roomId: ROOM, turnId: 'm-turn', employeeId: 'employee-two', draft: {} })).statusCode).toBe(400);
    for (const response of [
      await app.inject({ method: 'POST', url: '/api/agent/journal/save', payload: { roomId: ROOM, turnId: 'm-turn', draft: {} }, cookies: { [OWNER_COOKIE]: ownerToken }, headers: as(SID) }),
      await app.inject({ method: 'POST', url: '/api/agent/journal/save', payload: { roomId: ROOM, turnId: 'm-turn', draft: {} }, headers: { [SERVICE_HEADER]: serviceToken, ...as(SID) } }),
      await app.inject({ method: 'GET', url: '/api/agent/journal/map', headers: as(SID.slice(0, 16)) }),
    ]) expect(response.statusCode).toBe(403);
    const mine = await app.inject({ url: '/api/agent/journal/recall?q=UTC', headers: as(SID) });
    expect(mine.json().data.entries).toHaveLength(1);
    expect(mine.json().data.entries[0]).toMatchObject({ interpretation: "the agent's own account, not verified", sources: [{ status: 'checked' }] });
    expect((await app.inject({ url: '/api/agent/journal/recall?q=UTC', headers: as(OTHER) })).json().data.entries).toEqual([]);
    expect((await app.inject({ url: '/api/agent/journal/receipt/m-turn', headers: as(OTHER) })).json().data.status).toBe('not_found');
    session.pid = null; expect((await app.inject({ url: '/api/agent/journal/map', headers: as(SID) })).statusCode).toBe(403);
    session.pid = 123; employees[0]!.onVacation = true; expect((await save()).statusCode).toBe(403);
  });

  it('returns gate records on refusal and reads sources only as the session can see them', async () => {
    post('m-ro', 'Read only, please: remember this.', 300);
    const refused = await save(SID, { roomId: ROOM, turnId: 'm-ro', draft: { text: 'x', tags: ['lesson'], sources: [{ roomId: ROOM, id: 'm-source', quote: 'UTC' }] } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ success: false, errorCode: 'JOURNAL_READ_ONLY' });
    expect(refused.json().gates.find((gate: { gate: string }) => gate.gate === 'read_only').outcome).toBe('fail');
    post('m-own', 'Remember this.', 300, { kind: 'agent', sessionId: SID, name: 'employee-one', employeeId: 'employee-one' });
    expect((await save(SID, { roomId: ROOM, turnId: 'm-own', draft: { text: 'x', tags: ['lesson'], sources: [{ roomId: ROOM, id: 'm-source', quote: 'UTC' }] } })).json().errorCode)
      .toBe('JOURNAL_TURN_SELF');
    const source = await app.inject({ url: `/api/agent/journal/source?roomId=${ROOM}&messageId=m-source`, headers: as(SID) });
    expect(source.json().data).toMatchObject({ id: 'm-source', at: '1970-01-01T00:00:00.100Z', from: 'Owner', truncated: false });
    members.delete(SID);
    expect((await app.inject({ url: `/api/agent/journal/source?roomId=${ROOM}&messageId=m-source`, headers: as(SID) })).statusCode).toBe(404);
  });

  it('lets the owner read any employee journal, without re-checking sources as that employee', async () => {
    await save();
    const page = await app.inject({ url: '/api/company/employees/employee-one/journal', cookies: { [OWNER_COOKIE]: ownerToken } });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.entries[0]).toMatchObject({ entryId: 1, sources: [{ status: 'unverified', detail: 'not re-checked in this view' }] });
    expect((await app.inject({ url: '/api/company/employees/employee-one/journal', headers: as(OTHER) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/company/employees/nobody/journal', cookies: { [OWNER_COOKIE]: ownerToken } })).statusCode).toBe(404);
  });

  it('gives the owner an employee\'s identity and memory block for a fresh backend, and says so when the journal is unreadable', async () => {
    const brief = () => app.inject({ url: '/api/company/employees/employee-one/memory-brief', cookies: { [OWNER_COOKIE]: ownerToken } });
    const empty = await brief();
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data.brief).toMatch(/^Identity and memory: you are "employee-one", "Engineer"\./);
    expect(empty.json().data.brief).toContain('Your journal has no entries yet.');
    await save();
    expect((await brief()).json().data.brief).toContain('#1 2026-10-30 "Records carry exact UTC times."');
    // Only this employee's own entries.
    expect((await app.inject({ url: '/api/company/employees/employee-two/memory-brief', cookies: { [OWNER_COOKIE]: ownerToken } })).json().data.brief)
      .toContain('Your journal has no entries yet.');
    vi.spyOn(store, 'highlights').mockImplementation(() => { throw new Error('database is locked'); });
    const unreadable = await brief();
    expect(unreadable.statusCode).toBe(200);
    expect(unreadable.json().data.brief).toContain('Your journal could not be read just now; use recall.');
    expect((await app.inject({ url: '/api/company/employees/employee-one/memory-brief', headers: as(SID) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/company/employees/nobody/memory-brief', cookies: { [OWNER_COOKIE]: ownerToken } })).statusCode).toBe(404);
  });
});
