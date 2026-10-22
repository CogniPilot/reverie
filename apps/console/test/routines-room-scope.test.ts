/** Routine authorization through real routes and the exact production poster/membership callbacks. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { ChatroomService } from '../src/chatroom-service.js';
import { CronService, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import { RoutinesGrants } from '../src/routines-grants.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: audit }));

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const headers = (session: string) => ({ 'x-reverie-parent-session': session });
const source = ts.createSourceFile('server.ts', readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let posterSource: string;
let membershipSource: string;
function findWiring(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'this.cronService.setBotPoster') {
    posterSource = node.arguments[0].getText(source);
  }
  if (ts.isBinaryExpression(node) && node.left.getText(source) === 'this.cronPort.routines' && ts.isObjectLiteralExpression(node.right)) {
    const member = node.right.properties.find((p) => p.name?.getText(source) === 'isMember');
    if (member && ts.isPropertyAssignment(member)) membershipSource = member.initializer.getText(source);
  }
  ts.forEachChild(node, findWiring);
}
findWiring(source);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  audit.mockClear();
  const dir = mkdtempSync(join(tmpdir(), 'routines-scope-'));
  const people = [
    { id: 'employee-a', name: 'Alice', position: 'Developer', sessionId: A },
    { id: 'employee-b', name: 'Bob', position: 'Developer', sessionId: B },
  ];
  const sessions = new Map(people.map((e) => [e.sessionId, { id: e.sessionId, name: e.name, pid: null, mode: 'claude', isWorking: false }]));
  const chat = new ChatroomService({ file: join(dir, 'rooms.json'), getSession: (id) => sessions.get(id) as never, broadcast: () => {} });
  await chat.init();
  const room = chat.createRoom('shared', undefined);
  chat.addMember(room.id, A, {});
  chat.addMember(room.id, B, {});
  const other = chat.createRoom('other', undefined);
  chat.addMember(other.id, B, {});
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  const store = {
    getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, job: CronJob) => { jobs[id] = job; },
    removeCronJob: (id: string) => { delete jobs[id]; },
    getCronJobRuns: () => runs, setCronJobRun: (id: string, run: CronJobRun) => { runs[id] = run; },
    removeCronJobRun: (id: string) => { delete runs[id]; },
  };
  const cron = new CronService({ store, sessions: new Map(), broadcast: () => {} } as unknown as CronDeps);
  // Execute the production closures themselves: mutating server.ts must break these tests.
  expect(posterSource).toBeTruthy();
  expect(membershipSource).toBeTruthy();
  const context = { chatroomService: chat };
  const poster = new Function('companyStore', 'chatBots', `return (${posterSource});`)
    .call(context, { snapshot: () => ({ employees: people }) }, { get: () => undefined }) as BotPoster;
  const isMember = new Function(`return (${membershipSource});`).call(context) as (room: string, session: string) => boolean;
  cron.setBotPoster(poster);
  const grants = new RoutinesGrants(join(dir, 'grants.json'));
  await grants.init();
  await grants.set({ roles: [], employees: { 'employee-a': true, 'employee-b': true } });
  const app = Fastify();
  const notify = vi.fn(() => true);
  registerCronRoutes(app, { cron, routines: {
    grants, isMember, findEmployee: (id) => people.find((p) => p.sessionId === id),
    notificationRoomId: () => room.id, notify,
  } });
  installRouteErrorHandler(app);
  await app.ready();
  cleanup.push(async () => { await app.close(); await chat.stop(); rmSync(dir, { recursive: true, force: true }); });
  const input = { name: 'standup', action: 'post', roomId: room.id, postText: 'hello', enabled: true, scheduleType: 'interval', intervalMinutes: 5 };
  const create = (session = A, extra: object = {}) => app.inject({ method: 'POST', url: '/api/cron/jobs', headers: headers(session), payload: { ...input, ...extra } });
  const posts = () => chat.room(room.id)!.messages.filter((m) => m.text.startsWith('⏰ routine:'));
  return { app, chat, room, other, people, jobs, runs, cron, grants, create, input, posts, notify };
}

describe('routine room and author scope', () => {
  it('non-member create is HTTP 403 with jobs and room state unchanged', async () => {
    const f = await fixture();
    const before = structuredClone(f.other);
    const res = await f.create(A, { roomId: f.other.id });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(f.jobs).toEqual({});
    expect(f.other).toEqual(before);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('moving a routine to a non-member room is HTTP 403 with roomId and state unchanged', async () => {
    const f = await fixture();
    const id = (await f.create()).json().job.id;
    const before = structuredClone({ jobs: f.jobs, runs: f.runs, room: f.room, other: f.other });
    const notices = f.notify.mock.calls.length;
    const audits = audit.mock.calls.length;
    const res = await f.app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, headers: headers(A), payload: { roomId: f.other.id } });
    expect(res.statusCode).toBe(403);
    expect(f.jobs[id].roomId).toBe(f.room.id);
    expect({ jobs: f.jobs, runs: f.runs, room: f.room, other: f.other }).toEqual(before);
    expect(f.notify).toHaveBeenCalledTimes(notices);
    expect(audit).toHaveBeenCalledTimes(audits);
  });

  it.each(['removed', 'archived'] as const)('%s author can disable and delete its own routine, but cannot enable, edit or run it', async (scope) => {
    const f = await fixture();
    const id = (await f.create()).json().job.id;
    if (scope === 'removed') f.chat.removeMember(f.room.id, A);
    else f.chat.archiveRoom(f.room.id, true);
    const base = `/api/cron/jobs/${id}`;
    const disabled = await f.app.inject({ method: 'PUT', url: `${base}/enabled`, headers: headers(A), payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect(f.jobs[id].enabled).toBe(false);
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'post_job_disabled' }));
    const before = structuredClone({ jobs: f.jobs, runs: f.runs, room: f.room });
    const audits = audit.mock.calls.length;
    for (const [method, suffix, payload] of [
      ['PUT', '/enabled', { enabled: true }], ['POST', '/run', undefined], ['PUT', '', { postText: 'changed' }],
    ] as const) {
      const res = await f.app.inject({ method, url: `${base}${suffix}`, headers: headers(A), payload });
      expect(res.statusCode).toBe(403);
      expect({ jobs: f.jobs, runs: f.runs, room: f.room }).toEqual(before);
      expect(f.notify).toHaveBeenCalledTimes(2);
      expect(audit).toHaveBeenCalledTimes(audits);
    }
    expect((await f.app.inject({ method: 'DELETE', url: base, headers: headers(A) })).statusCode).toBe(200);
    expect(f.jobs[id]).toBeUndefined();
    expect(f.notify).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'post_job_deleted' }));
    expect(f.posts()).toEqual([]);
  });

  it('removal after create prevents the next production post and records why', async () => {
    const f = await fixture();
    const id = (await f.create()).json().job.id;
    f.chat.removeMember(f.room.id, A);
    const run = await f.cron.runNow(id);
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('no longer a member');
    expect(f.runs[run.id]).toEqual(run);
    expect(f.posts()).toEqual([]);
  });

  it('an archived room rejects create and the next production run posts nothing', async () => {
    const f = await fixture();
    const id = (await f.create()).json().job.id;
    f.chat.archiveRoom(f.room.id, true);
    expect((await f.create()).statusCode).toBe(403);
    const run = await f.cron.runNow(id);
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('archived');
    expect(f.posts()).toEqual([]);
  });

  it('employee A cannot edit, enable, run or delete B\'s routine; state stays unchanged', async () => {
    const f = await fixture();
    const id = (await f.create(B)).json().job.id;
    const before = structuredClone({ jobs: f.jobs, runs: f.runs, room: f.room });
    const notices = f.notify.mock.calls.length;
    for (const [method, suffix, payload] of [
      ['PUT', '', { postText: 'hijack' }], ['PUT', '/enabled', { enabled: false }],
      ['POST', '/run', undefined], ['DELETE', '', undefined],
    ] as const) {
      const res = await f.app.inject({ method, url: `/api/cron/jobs/${id}${suffix}`, headers: headers(A), payload });
      expect(res.statusCode).toBe(403);
      expect({ jobs: f.jobs, runs: f.runs, room: f.room }).toEqual(before);
      expect(f.notify).toHaveBeenCalledTimes(notices);
    }
  });

  it('the owner reads, edits, enables, runs and deletes any author routine without a grant or room seat', async () => {
    const f = await fixture();
    const id = (await f.create(B)).json().job.id;
    await f.grants.set({ roles: [], employees: {} });
    const base = `/api/cron/jobs/${id}`;
    expect((await f.app.inject(base)).json().postText).toBe('hello');
    expect((await f.app.inject({ method: 'PUT', url: base, payload: { postText: 'owner edit', roomId: f.other.id } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'PUT', url: `${base}/enabled`, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'PUT', url: `${base}/enabled`, payload: { enabled: true } })).statusCode).toBe(200);
    const ran = await f.app.inject({ method: 'POST', url: `${base}/run` });
    expect(ran.statusCode).toBe(200);
    expect(ran.json().run.status).toBe('posted');
    expect(f.chat.room(f.other.id)!.messages.at(-1)).toMatchObject({ from: { kind: 'agent', sessionId: B }, text: '⏰ routine: owner edit' });
    expect((await f.app.inject(`${base}/runs`)).json()[0].status).toBe('posted');
    f.chat.archiveRoom(f.other.id, true);
    expect((await f.app.inject({ method: 'PUT', url: base, payload: { name: 'owner can still maintain it' } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'DELETE', url: base })).statusCode).toBe(200);
    expect(f.jobs[id]).toBeUndefined();
    const owner = await f.app.inject({ method: 'POST', url: '/api/cron/jobs', payload: { ...f.input, roomId: f.other.id, botId: 'owner-bot' } });
    expect(owner.statusCode).toBe(200);
  });

  it('forged identity and bot fields cannot change the production author; rebind uses the current employee session', async () => {
    const f = await fixture();
    const job = (await f.create(A, { createdBy: { employeeId: 'employee-b' } })).json().job;
    expect(job).toMatchObject({ postAs: 'author', createdBy: { employeeId: 'employee-a' } });
    for (const extra of [{ botId: 'bot' }, { postAs: 'bot' }]) expect((await f.create(A, extra)).statusCode).toBe(403);
    await f.cron.runNow(job.id);
    expect(f.posts()[0]).toMatchObject({ from: { kind: 'agent', sessionId: A, name: 'Alice' }, text: '⏰ routine: hello' });
    const next = '0000003e-004c-4000-8000-00000000006f';
    f.people[0].sessionId = next;
    f.chat.room(f.room.id)!.members.find((m) => m.sessionId === A)!.sessionId = next;
    await f.cron.runNow(job.id);
    expect(f.posts()[1].from).toMatchObject({ kind: 'agent', sessionId: next, name: 'Alice' });
  });

  it('denies an ungranted employee while the owner can create; foreign reads retain only live allowlisted fields', async () => {
    const f = await fixture();
    const id = (await f.create(B, { postText: 'foreign secret' })).json().job.id;
    await f.grants.set({ roles: [], employees: {} });
    expect((await f.create()).statusCode).toBe(403);
    f.jobs[id].postLastText = 'cached secret';
    for (const url of ['/api/cron/jobs?all=1', `/api/cron/jobs/${id}`]) {
      const res = await f.app.inject({ url, headers: headers(A) });
      expect(res.body).not.toMatch(/foreign secret|cached secret/);
      const job = Array.isArray(res.json()) ? res.json()[0] : res.json();
      expect(Object.keys(job).sort()).toEqual([
        'id', 'name', 'action', 'postAs', 'createdBy', 'roomId', 'enabled', 'scheduleType',
        'intervalMinutes', 'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', 'lastStatus',
      ].sort());
    }
    expect((await f.app.inject({ method: 'POST', url: '/api/cron/jobs', payload: { ...f.input, botId: 'owner-bot' } })).statusCode).toBe(200);
  });
});
