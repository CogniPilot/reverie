import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
/**
 * Agent routines: a post job an employee owns and speaks through as themselves. Covers the server rules (membership, cap,
 * interval, ownership, no forged author), the fire path (prefix, identity by employee id, auto-disable) and what a reader sees.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: async () => undefined }));
const multiUser = vi.hoisted(() => ({ on: false }));
vi.mock('../src/config/multiuser.js', async (orig) => ({ ...(await orig<object>()), isMultiUserMode: () => multiUser.on }));

import { CronService, AUTHOR_FAIL_LIMIT, AUTHOR_POSTS_PER_HOUR, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import { ChatroomStore, messageRecipients } from '../src/chatroom-store.js';
import { wakeRecipients } from '../src/chatroom-delivery.js';
import { RoutinesGrants } from '../src/routines-grants.js';
import { registerCronRoutes, ROUTINES_PER_AUTHOR } from '../src/web/routes/cron-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

interface Person { id: string; name: string; position: string; session: string }
const ALICE: Person = { id: 'e-alice', name: 'Alice', position: 'Tech lead', session: '0000002d-0035-4000-8000-000000000047' };
const BOB: Person = { id: 'e-bob', name: 'Bob', position: 'Designer', session: '00000038-0043-4000-8000-000000000060' };
const TEMP = { session: '0000003e-004c-4000-8000-00000000006f' };
const as = (p: { session: string }) => ({ 'x-reverie-parent-session': p.session });
const mine = {
  name: 'standup', action: 'post', roomId: 'room-1', postText: 'standup in 5',
  scheduleType: 'daily', dailyTime: '09:00', timeZone: 'America/New_York', enabled: true,
};

async function setup() {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  const store = {
    getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
    getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
    removeCronJobRun: (id: string) => { delete runs[id]; },
  };
  const people = [{ ...ALICE }, { ...BOB }];
  /** room id -> member session ids */
  const rooms: Record<string, string[]> = { 'room-1': [ALICE.session, BOB.session], 'room-2': [BOB.session] };
  const posts: Array<{ roomId: string; from: { sessionId?: string; name: string }; text: string }> = [];
  const systemLines: string[] = [];
  const cron = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
  const poster: BotPoster = {
    getBot: () => undefined,
    check: () => {},
    post: () => {},
    canPostAsAuthor: (employeeId, roomId) => {
      const e = people.find((p) => p.id === employeeId);
      if (!e) throw new Error('The author is no longer an employee');
      if (!rooms[roomId]?.includes(e.session)) throw new Error(`${e.name} is no longer a member of this room`);
    },
    postAsAuthor: (employeeId, roomId, text) => {
      const e = people.find((p) => p.id === employeeId);
      if (!e) throw new Error('The author is no longer an employee');
      if (!rooms[roomId]?.includes(e.session)) throw new Error(`${e.name} is no longer a member of this room`);
      posts.push({ roomId, from: { sessionId: e.session, name: e.name }, text: `⏰ routine: ${text}` });
      return { name: e.name };
    },
    notifyDisabled: (_id, _room, text) => void systemLines.push(text),
  };
  cron.setBotPoster(poster);
  const notify = vi.fn(() => true);
  const grants = new RoutinesGrants(join(mkdtempSync(join(tmpdir(), 'rt-')), 'g.json'));
  await grants.init();
  // Deny by default: the owner grants these two authors, as the live tree requires.
  await grants.set({ roles: [], employees: { [ALICE.id]: true, [BOB.id]: true } });
  const port = {
    cron,
    routines: {
      grants,
      findEmployee: (sid: string) => people.find((p) => p.session === sid),
      isMember: (room: string, sid: string) => !!rooms[room]?.includes(sid),
      notificationRoomId: () => 'room-board',
      notify,
    },
  };
  const app = Fastify({ logger: false });
  // Tests act as an owner-scoped user in multi-user mode by naming one in x-test-user.
  app.addHook('onRequest', async (req) => {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string') (req as unknown as { authUser: unknown }).authUser = { username: user, role: 'user' };
  });
  registerCronRoutes(app, port as never, trustedFixtureOwner);
  installRouteErrorHandler(app);
  await app.ready();
  const create = (who: Person | { session: string }, extra: object = {}) =>
    app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(who), payload: { ...mine, ...extra } });
  return { app, cron, jobs, runs, people, rooms, posts, systemLines, grants, create, notify };
}

describe('agent routines: what the server accepts', () => {
  it('refuses a room the author is not in, on create and on an edit to another room', async () => {
    const { app, create, jobs } = await setup();
    expect((await create(ALICE, { roomId: 'room-2' })).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    const id = (await create(ALICE)).json().job.id as string;
    const res = await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, headers: as(ALICE), payload: { roomId: 'room-2' } });
    expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(jobs[id]?.roomId).toBe('room-1');
    await app.close();
  });

  it('takes the author from the caller and ignores a forged createdBy; rejects postAs and botId', async () => {
    const { create, jobs, app } = await setup();
    const made = (await create(ALICE, { createdBy: { employeeId: 'e-bob' } })).json().job as CronJob;
    expect(made).toMatchObject({ postAs: 'author', createdBy: { employeeId: 'e-alice' } });
    expect(made.botId).toBeUndefined();
    expect((await create(ALICE, { postAs: 'bot' })).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    expect((await create(ALICE, { postAs: 'author' })).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    expect((await create(ALICE, { botId: 'routines' })).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(Object.keys(jobs)).toHaveLength(1);
    await app.close();
  });

  it('caps an author at 20 routines, and an interval under 5 minutes; the owner keeps the short interval', async () => {
    const { create, app, jobs } = await setup();
    for (let i = 0; i < ROUTINES_PER_AUTHOR; i++) expect((await create(ALICE, { name: `r${i}` })).json().job).toBeTruthy();
    expect((await create(ALICE, { name: 'one too many' })).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    // Another employee is not affected by Alice's count.
    expect((await create(BOB, { name: 'bob' })).json().job).toBeTruthy();
    const quick = { scheduleType: 'interval', intervalMinutes: 4, dailyTime: undefined };
    expect((await create(BOB, { ...quick, name: 'fast' })).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    expect((await create(BOB, { ...quick, intervalMinutes: 5, name: 'ok' })).json().job).toBeTruthy();
    const owner = await app.inject({ method: 'POST', url: '/api/cron/jobs', payload: { ...mine, botId: 'routines', ...quick, intervalMinutes: 1, name: 'owner' } });
    expect(owner.json().job).toBeTruthy();
    expect(Object.keys(jobs)).toHaveLength(ROUTINES_PER_AUTHOR + 3);
    await app.close();
  });

  it('lets an author change only its own routines, never another author\'s or an owner job', async () => {
    const { create, app, cron, jobs } = await setup();
    const authorJobId = (await create(ALICE)).json().job.id as string;
    const ownerJob = cron.createJob({ ...mine, name: 'owner', botId: 'routines' } as never);
    for (const target of [authorJobId, ownerJob.id]) {
      const who = target === authorJobId ? BOB : ALICE;
      for (const [method, url, payload] of [
        ['PUT', `/api/cron/jobs/${target}`, { postText: 'hijack' }],
        ['PUT', `/api/cron/jobs/${target}/enabled`, { enabled: false }],
        ['POST', `/api/cron/jobs/${target}/run`, undefined],
        ['DELETE', `/api/cron/jobs/${target}`, undefined],
      ] as const) {
        const res = await app.inject({ method, url, headers: as(who), payload });
        expect(res.json(), `${who.name} ${method} ${url}`).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
      }
    }
    expect(jobs[authorJobId]?.postText).toBe('standup in 5');
    expect(Object.keys(jobs)).toHaveLength(2);
    await app.close();
  });

  it('refuses a temporary agent with a reason, a revoked employee, a tainted caller and a data source', async () => {
    const { create, app, grants, jobs } = await setup();
    const temp = (await create(TEMP)).json();
    expect(temp).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(temp.error).toContain('Temporary agents cannot own routines');
    await grants.set({ roles: [], employees: { [BOB.id]: false } });
    expect((await create(BOB)).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    const tainted = await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: { ...as(ALICE), 'x-reverie-tainted': '1' }, payload: mine });
    expect(tainted.json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    for (const extra of [{ postSource: 'host-load', postText: '{load}' }, { dryRun: true }, { postChangeOnly: true }]) {
      expect((await create(ALICE, extra)).json(), JSON.stringify(extra)).toMatchObject({ success: false });
    }
    expect(Object.keys(jobs)).toHaveLength(0);
    await app.close();
  });

  it('lists an agent\'s own routines; ?all=1 adds the others without their text', async () => {
    const { create, app } = await setup();
    const a = (await create(ALICE, { name: 'mine', postText: 'secret plan' })).json().job as CronJob;
    await create(BOB, { name: 'bobs', roomId: 'room-2', postText: 'bob private text' });
    const own = (await app.inject({ method: 'GET', url: '/api/cron/jobs', headers: as(ALICE) })).json() as CronJob[];
    expect(own.map((j) => j.name)).toEqual(['mine']);
    const all = (await app.inject({ method: 'GET', url: '/api/cron/jobs?all=1', headers: as(ALICE) })).json() as CronJob[];
    expect(all.map((j) => j.name).sort()).toEqual(['bobs', 'mine']);
    expect(all.find((j) => j.name === 'bobs')?.postText).toBeUndefined();
    expect(all.find((j) => j.name === 'mine')?.postText).toBe('secret plan');
    const other = (await app.inject({ method: 'GET', url: `/api/cron/jobs/${all.find((j) => j.name === 'bobs')?.id}`, headers: as(ALICE) })).json();
    expect(other.postText).toBeUndefined();
    expect(a.postText).toBe('secret plan');
    await app.close();
  });
  it('applies owner scope before ?all=1: another owner\'s routine is never listed to an agent in multi-user mode', async () => {
    const { create, app } = await setup();
    multiUser.on = true;
    try {
      const made = (await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: { ...as(ALICE), 'x-test-user': 'owner-a' }, payload: { ...mine, name: 'a-private' } })).json();
      expect(made.job?.owner).toBe('owner-a');
      const builder = { ...as(BOB), 'x-test-user': 'owner-b' };
      const listed = (await app.inject({ method: 'GET', url: '/api/cron/jobs?all=1', headers: builder })).json() as CronJob[];
      expect(listed.map((j) => j.name)).not.toContain('a-private');
      const runs = (await app.inject({ method: 'GET', url: '/api/cron/runs', headers: builder })).json() as unknown[];
      expect(runs).toEqual([]);
    } finally {
      multiUser.on = false;
    }
    await create(ALICE);
    await app.close();
  });

  it('shows another author only an allowlist of a routine and its runs: no rendered text, no error that quotes it', async () => {
    const { create, app, cron, jobs } = await setup();
    const id = (await create(BOB, { name: 'bobs', roomId: 'room-2', postText: 'bob private text', dryRun: undefined })).json().job.id as string;
    jobs[id] = { ...jobs[id], dryRun: true, postLastText: 'rendered secret', notes: 'bob note' } as CronJob;
    await cron.runNow(id);
    const mineId = (await create(ALICE, { name: 'mine' })).json().job.id as string;
    const seen = async (url: string, who: Person) => (await app.inject({ method: 'GET', url, headers: as(who) })).body;
    for (const url of ['/api/cron/jobs?all=1', `/api/cron/jobs/${id}`, `/api/cron/jobs/${id}/runs`, '/api/cron/runs']) {
      const body = await seen(url, ALICE);
      for (const leak of ['bob private text', 'rendered secret', 'bob note', 'Dry run']) expect(body, `${url} leaks ${leak}`).not.toContain(leak);
    }
    // The schedule and outcome of the other routine are still visible, and the author reads its own in full.
    expect(await seen(`/api/cron/jobs/${id}/runs`, ALICE)).toContain('skipped');
    expect(await seen(`/api/cron/jobs/${id}/runs`, BOB)).toContain('Dry run');
    expect(mineId).toBeTruthy();
    await app.close();
  });

  it('keeps the hourly post count when the routines are deleted and made again', async () => {
    const { create, app, cron, posts } = await setup();
    const first = (await create(ALICE)).json().job.id as string;
    for (let i = 0; i < AUTHOR_POSTS_PER_HOUR; i++) await cron.runNow(first);
    expect(posts).toHaveLength(AUTHOR_POSTS_PER_HOUR);
    expect((await app.inject({ method: 'DELETE', url: `/api/cron/jobs/${first}`, headers: as(ALICE) })).statusCode).toBe(200);
    expect(cron.getJob(first)).toBeFalsy();
    const again = (await create(ALICE, { name: 'again' })).json().job.id as string;
    const run = await cron.runNow(again);
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('Limit of');
    expect(posts).toHaveLength(AUTHOR_POSTS_PER_HOUR);
    await app.close();
  });

  it('keeps the hourly post count across a restart with no jobs or runs left on file', async () => {
    let saved: Record<string, number[]> = {};
    const quota = { load: () => structuredClone(saved), save: (p: Record<string, number[]>) => { saved = structuredClone(p); } };
    const one = await setup();
    one.cron.setAuthorQuota(quota);
    const first = (await one.create(ALICE)).json().job.id as string;
    for (let i = 0; i < AUTHOR_POSTS_PER_HOUR; i++) await one.cron.runNow(first);
    expect(one.posts).toHaveLength(AUTHOR_POSTS_PER_HOUR);
    await one.app.close();
    // A new service over empty job and run records (history pruned, then restarted) reads the saved count.
    const two = await setup();
    two.cron.setAuthorQuota(quota);
    const again = (await two.create(ALICE)).json().job.id as string;
    const run = await two.cron.runNow(again);
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('Limit of');
    expect(two.posts).toHaveLength(0);
    // Another author is not affected.
    const other = (await two.create(BOB)).json().job.id as string;
    expect((await two.cron.runNow(other)).status).toBe('posted');
    await two.app.close();
  });
});

describe('agent routines: when one fires', () => {
  it('posts as the author with the server prefix, and as the same person after a rebind to a new session', async () => {
    const { create, app, cron, posts, people, rooms } = await setup();
    const id = (await create(ALICE)).json().job.id as string;
    await cron.runNow(id);
    expect(posts).toEqual([{ roomId: 'room-1', from: { sessionId: ALICE.session, name: 'Alice' }, text: '⏰ routine: standup in 5' }]);
    // The employee moves to a new session (a restart); the seat moves with it.
    const fresh = '00000043-0053-4000-8000-00000000007a';
    people[0]!.session = fresh;
    rooms['room-1'] = [fresh, BOB.session];
    await cron.runNow(id);
    expect(posts[1]?.from).toEqual({ sessionId: fresh, name: 'Alice' });
    await app.close();
  });

  it('fails the run when the author left the room, and switches the routine off after three failures with one notice', async () => {
    const { create, app, cron, jobs, rooms, runs, systemLines } = await setup();
    const id = (await create(ALICE)).json().job.id as string;
    rooms['room-1'] = [BOB.session];
    for (let i = 0; i < AUTHOR_FAIL_LIMIT; i++) {
      expect(jobs[id]?.enabled).toBe(true);
      await cron.runNow(id);
    }
    const failed = Object.values(runs).filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(AUTHOR_FAIL_LIMIT);
    expect(failed[0]?.errorMessage).toContain('no longer a member');
    expect(jobs[id]?.enabled).toBe(false);
    expect(systemLines).toHaveLength(1);
    expect(systemLines[0]).toContain('switched off after 3 failed runs');
    await app.close();
  });

  it('resets the failure count after a good post', async () => {
    const { create, app, cron, jobs, rooms } = await setup();
    const id = (await create(ALICE)).json().job.id as string;
    rooms['room-1'] = [BOB.session];
    await cron.runNow(id);
    await cron.runNow(id);
    expect(jobs[id]?.failStreak).toBe(2);
    rooms['room-1'] = [ALICE.session, BOB.session];
    await cron.runNow(id);
    expect(jobs[id]?.failStreak).toBe(0);
    rooms['room-1'] = [BOB.session];
    await cron.runNow(id);
    await cron.runNow(id);
    expect(jobs[id]?.enabled).toBe(true);
    await app.close();
  });

  it('stops at 30 posts an hour per author without counting that toward the auto-disable', async () => {
    const { create, app, cron, jobs, posts } = await setup();
    const id = (await create(ALICE)).json().job.id as string;
    for (let i = 0; i < 33; i++) await cron.runNow(id);
    expect(posts).toHaveLength(30);
    expect(jobs[id]?.enabled).toBe(true);
    await app.close();
  });

  it('a routine post never wakes or reaches its own author, even when its text names the author', () => {
    const store = new ChatroomStore();
    const room = store.create('ops', undefined);
    store.addMember(room.id, ALICE.session);
    store.addMember(room.id, BOB.session);
    const names: Record<string, string> = { [ALICE.session]: 'Alice', [BOB.session]: 'Bob' };
    const nameOf = (id: string) => names[id] ?? id;
    const message = store.post(room.id, { kind: 'agent', sessionId: ALICE.session, name: 'Alice' }, '⏰ routine: @Alice @all @everyone standup', 'all');
    const recipients = messageRecipients(room, message);
    expect(recipients).toEqual([BOB.session]);
    expect([...wakeRecipients(room, message, recipients, nameOf)]).not.toContain(ALICE.session);
  });
});

describe('agent routines: preview before Run once', () => {
  it('previews an own routine with no run, post or announcement; another author\'s routine and unknown ids are refused', async () => {
    const { app, create, runs, posts, notify } = await setup();
    const id = (await create(ALICE)).json().job.id as string;
    const announced = notify.mock.calls.length;
    const preview = await app.inject({ url: `/api/cron/jobs/${id}/preview`, headers: as(ALICE) });
    expect(preview.json()).toMatchObject({
      preview: { jobId: id, action: 'post', outcome: 'post', sender: 'Routine author', roomId: 'room-1', text: 'standup in 5' },
    });
    expect(preview.json().preview.checks.map((c: { label: string; ok: boolean }) => [c.label, c.ok])).toEqual([
      ['Author can post', true], ['Author hourly limit', true],
    ]);
    expect(Object.keys(runs)).toEqual([]);
    expect(posts).toEqual([]);
    expect(notify.mock.calls.length).toBe(announced);
    expect((await app.inject({ url: `/api/cron/jobs/${id}/preview`, headers: as(BOB) })).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect((await app.inject({ url: '/api/cron/jobs/missing/preview', headers: as(ALICE) })).json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
    // Run once is the real thing, and its result is the run record.
    const run = await app.inject({ method: 'POST', url: `/api/cron/jobs/${id}/run`, headers: as(ALICE) });
    expect(run.json().run).toMatchObject({ status: 'posted', triggerType: 'manual_run_now' });
    expect(posts.map((p) => p.text)).toEqual(['⏰ routine: standup in 5']);
  });

  it('shows a removed author as a failing check, as posting would, instead of a green one', async () => {
    const { app, create, people } = await setup();
    const id = (await create(ALICE)).json().job.id as string;
    people.splice(people.findIndex((p) => p.id === ALICE.id), 1);
    const preview = (await app.inject({ url: `/api/cron/jobs/${id}/preview`, headers: { 'x-test-user': 'owner' } })).json().preview;
    expect(preview).toMatchObject({ outcome: 'blocked', checks: [{ label: 'Author can post', ok: false, detail: 'The author is no longer an employee' }] });
  });
});
