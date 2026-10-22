/** `reverie routine …`: schedule parsing (what --cron can and cannot mean) and the requests the verbs make. */
import { describe, expect, it } from 'vitest';
import {
  parseRoutineSchedule, routineAdd, routineList, routineRm, routineRun, routineRuns, routineShow, routineEnable, routineDisable,
  type AgentDeps, type RequestOptions,
} from '../src/cli-agent.js';

const ROOM = { id: 'room-aaaa1111', name: 'reverie', members: [] };
const JOB = { id: 'job-11112222-3333', name: 'standup', action: 'post', roomId: ROOM.id, postText: 'hi', scheduleType: 'daily', dailyTime: '09:00', timeZone: 'America/New_York', enabled: true, nextRunAt: Date.UTC(2026, 9, 19, 13, 0) };

function deps(jobs: unknown[] = [JOB], onJob?: (o: RequestOptions) => unknown) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
    json: false,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, o) => {
      calls.push(o);
      if (o.path === '/api/v1/chatrooms') return { status: 200, text: '', json: { success: true, data: { rooms: [ROOM] } } };
      if (o.path === '/api/v1/cron/jobs' && o.method === 'GET') return { status: 200, text: '', json: { success: true, data: jobs } };
      if (o.path.endsWith('/runs')) return { status: 200, text: '', json: { success: true, data: [{ startedAt: 1, status: 'failed', errorMessage: 'no longer a member' }, { startedAt: 2, status: 'posted' }] } };
      const custom = onJob?.(o);
      if (custom) return custom as never;
      if (o.method === 'POST' && o.path === '/api/v1/cron/jobs') return { status: 200, text: '', json: { success: true, data: { job: JOB } } };
      return { status: 200, text: '', json: { success: true, data: { run: { status: 'posted' } } } };
    },
  };
  return { d, calls, out, err };
}
const plain = (l: string[]) => l.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('routine schedules', () => {
  it('reads --every in minutes, hours and days, and refuses under 5 minutes', () => {
    expect(parseRoutineSchedule({ every: '30m' })).toEqual({ scheduleType: 'interval', intervalMinutes: 30 });
    expect(parseRoutineSchedule({ every: '2h' })).toEqual({ scheduleType: 'interval', intervalMinutes: 120 });
    expect(parseRoutineSchedule({ every: '1d' })).toEqual({ scheduleType: 'interval', intervalMinutes: 1440 });
    expect(parseRoutineSchedule({ every: '4m' })).toEqual({ error: 'a routine repeats at most every 5 minutes' });
    expect(parseRoutineSchedule({ every: 'soon' })).toHaveProperty('error');
  });

  it('reads --daily and --weekdays and refuses a bad clock', () => {
    expect(parseRoutineSchedule({ daily: '9:05' })).toEqual({ scheduleType: 'daily', dailyTime: '09:05' });
    expect(parseRoutineSchedule({ weekdays: '17:30' })).toEqual({ scheduleType: 'weekly', weeklyDays: [1, 2, 3, 4, 5], weeklyTime: '17:30' });
    expect(parseRoutineSchedule({ daily: '25:00' })).toHaveProperty('error');
  });

  it('maps only the cron lines that mean daily or weekly, and says why for the rest', () => {
    expect(parseRoutineSchedule({ cron: '0 9 * * *' })).toEqual({ scheduleType: 'daily', dailyTime: '09:00' });
    expect(parseRoutineSchedule({ cron: '30 8 * * 1-5' })).toEqual({ scheduleType: 'weekly', weeklyDays: [1, 2, 3, 4, 5], weeklyTime: '08:30' });
    expect(parseRoutineSchedule({ cron: '0 9 * * 1,3,7' })).toEqual({ scheduleType: 'weekly', weeklyDays: [0, 1, 3], weeklyTime: '09:00' });
    for (const bad of ['*/5 * * * *', '0 9 1 * *', '0 9 * 6 *', '0 9-17 * * *', '0 9 * *', '0 9 * * MON', '0 9 * * 5-1']) {
      const r = parseRoutineSchedule({ cron: bad });
      expect(r, bad).toHaveProperty('error');
      expect((r as { error: string }).error).toContain('cannot be scheduled');
    }
  });

  it('wants exactly one schedule flag', () => {
    expect(parseRoutineSchedule({})).toHaveProperty('error');
    expect(parseRoutineSchedule({ every: '5m', daily: '09:00' })).toHaveProperty('error');
  });
});

describe('routine verbs', () => {
  it('add sends a post job with no bot, no author and no postAs; the server decides who speaks', async () => {
    const { d, calls } = deps();
    expect(await routineAdd(d, { room: 'reverie', text: 'standup in 5', daily: '09:00', tz: 'America/New_York' })).toBe(0);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/v1/cron/jobs');
    expect(post?.body).toEqual({ name: 'routine daily 09:00 America/New_York', action: 'post', roomId: ROOM.id, postText: 'standup in 5', enabled: true, scheduleType: 'daily', dailyTime: '09:00', timeZone: 'America/New_York' });
    for (const k of ['botId', 'postAs', 'createdBy']) expect(post?.body).not.toHaveProperty(k);
  });

  it('add without --name never copies the text into the name, which other employees and the general can read', async () => {
    const { d, calls } = deps();
    expect(await routineAdd(d, { room: 'reverie', text: 'payroll for Bob slips to Friday', every: '2h' })).toBe(0);
    const body = calls.find((c) => c.method === 'POST')?.body as { name: string };
    expect(body.name).toBe('routine every 2h');
    expect(body.name).not.toContain('payroll');
  });

  it('add reads the time in America/New_York unless --tz says otherwise', async () => {
    const { d, calls } = deps();
    expect(await routineAdd(d, { room: 'reverie', text: 'standup', daily: '09:00' })).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ timeZone: 'America/New_York' });
  });

  it('add refuses bad input before any request', async () => {
    for (const o of [{ text: '', daily: '09:00' }, { text: 'a\nb', daily: '09:00' }, { text: 'x', every: '1m' }, { text: 'x' }, { text: 'x'.repeat(2001), daily: '09:00' }]) {
      const { d, calls } = deps();
      expect(await routineAdd(d, o), JSON.stringify(o).slice(0, 40)).toBe(4);
      expect(calls).toHaveLength(0);
    }
  });

  it('add passes the server\'s refusal through', async () => {
    const { d, err } = deps([], (o) => (o.method === 'POST' ? { status: 200, text: '', json: { success: false, errorCode: 'FORBIDDEN', error: 'You can only schedule a routine in a room you are a member of' } } : undefined));
    expect(await routineAdd(d, { room: 'reverie', text: 'x', daily: '09:00' })).toBe(1);
    expect(plain(err)).toContain('member of');
  });

  it('list shows the caller\'s routines with the schedule and the room name; --all asks the server for more', async () => {
    const { d, out, calls } = deps();
    expect(await routineList(d, { all: true })).toBe(0);
    expect(calls[0]?.query).toEqual({ all: '1' });
    expect(plain(out)).toContain('job-1111');
    expect(plain(out)).toContain('daily 09:00 America/New_York');
    expect(plain(out)).toContain('"reverie"');
  });

  it('rm, run and runs resolve an 8-character prefix, and refuse a shorter one without asking the server', async () => {
    const a = deps();
    expect(await routineRm(a.d, { id: 'job-1111' })).toBe(0);
    expect(a.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/cron/jobs/job-11112222-3333' });
    const b = deps();
    expect(await routineRun(b.d, { id: 'job-1111' })).toBe(0);
    expect(b.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/cron/jobs/job-11112222-3333/run' });
    const c = deps();
    expect(await routineRm(c.d, { id: 'job' })).toBe(4);
    expect(c.calls).toHaveLength(0);
    const d2 = deps();
    expect(await routineRm(d2.d, { id: 'nope-nope' })).toBe(1);
    const e = deps();
    expect(await routineRuns(e.d, { id: 'job-1111', count: 1 })).toBe(0);
    expect(plain(e.out)).toContain('posted');
    expect(plain(e.out)).not.toContain('no longer a member');
  });

  it('run reports a failed post as a failure', async () => {
    const { d, err } = deps([JOB], (o) => (o.path.endsWith('/run') ? { status: 200, text: '', json: { success: true, data: { run: { status: 'failed', errorMessage: 'Post failed: the author is no longer a member of this room' } } } } : undefined));
    expect(await routineRun(d, { id: 'job-1111' })).toBe(1);
    expect(plain(err)).toContain('no longer a member');
  });

  const ownerVerbs = [
    { verb: 'rm', call: routineRm, method: 'DELETE', suffix: '' },
    { verb: 'run', call: routineRun, method: 'POST', suffix: '/run' },
    { verb: 'show', call: routineShow, method: 'GET', suffix: undefined },
    { verb: 'enable', call: routineEnable, method: 'PUT', suffix: '/enabled' },
    { verb: 'disable', call: routineDisable, method: 'PUT', suffix: '/enabled' },
    { verb: 'runs', call: routineRuns, method: 'GET', suffix: '/runs' },
  ];

  it.each(ownerVerbs)('owner routine $verb ignores launch jobs sharing a post prefix and resolves the exact post', async ({ call, method, suffix }) => {
    const launch = { ...JOB, id: `${JOB.id}-launch`, action: 'launch', name: 'launch job' };
    for (const ref of [JOB.id.slice(0, 8), JOB.id]) {
      const { d, calls, out } = deps([launch, JOB]);
      d.ctx.selfId = '';
      expect(await call(d, { id: ref })).toBe(0);
      expect(calls.some((c) => c.path.includes(launch.id))).toBe(false);
      if (suffix === undefined) {
        expect(calls).toHaveLength(1);
        expect(plain(out)).toContain(JOB.name);
      } else {
        expect(calls.at(-1)).toMatchObject({ method, path: `/api/v1/cron/jobs/${JOB.id}${suffix}` });
      }
    }
  });

  it.each(ownerVerbs)('owner routine $verb refuses a launch-only match even by its full id', async ({ call }) => {
    const launch = { ...JOB, action: 'launch' };
    const { d, calls, err } = deps([launch]);
    d.ctx.selfId = '';
    expect(await call(d, { id: launch.id })).toBe(1);
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/cron/jobs' }]);
    expect(plain(err)).toContain('no routine');
  });
});
