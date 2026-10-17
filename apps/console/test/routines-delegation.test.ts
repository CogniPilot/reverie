/**
 * Delegated post-job authoring (F.3): the owner grants the permission to roles or employees; a delegate authors post jobs,
 * and every such change is announced in the boardroom and audited first. Bots, allowlists and caps stay owner-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const audits: Array<Record<string, unknown>> = [];
vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: async (e: Record<string, unknown>) => void audits.push(e) }));

import { ChatBotRegistry, type ChatBot } from '../src/chat-bots.js';
import { CronService, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import { RoutinesGrants } from '../src/routines-grants.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'deleg-'));
const AVERY = { id: 'e-avery', name: 'Avery', position: 'CTO', session: '7cb49893-0000-4000-8000-000000000001' };
const CASEY = { id: 'e-casey', name: 'Casey', position: 'COO', session: 'c7042061-0000-4000-8000-000000000002' };
const DEV = { id: 'e-dev', name: 'Dev', position: 'Developer', session: 'd0000000-0000-4000-8000-000000000003' };
const people = [AVERY, CASEY, DEV];
const BOARD = 'room-board';

const jobs: Record<string, CronJob> = {};
const runs: Record<string, CronJobRun> = {};
const store = {
  getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
  setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
  getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
  removeCronJobRun: (id: string) => { delete runs[id]; },
};

const body = {
  name: 'refresh', action: 'post', botId: 'routines', roomId: 'room-1', postText: 'hello',
  scheduleType: 'daily', dailyTime: '06:45', timeZone: 'America/New_York', enabled: true,
};
const as = (p: { session: string }) => ({ 'x-codeman-parent-session': p.session });

let notices: string[];
let noticeWorks: boolean;
let boardroom: string | undefined;

async function setup() {
  for (const k of Object.keys(jobs)) delete jobs[k];
  audits.length = 0;
  notices = [];
  noticeWorks = true;
  boardroom = BOARD;
  const cron = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
  const bot: ChatBot = { id: 'routines', name: 'Routines', rooms: ['room-1', BOARD], maxPerHour: 5 };
  cron.setBotPoster({ getBot: () => bot, check: () => {}, post: () => {} } as BotPoster);
  const registry = new ChatBotRegistry(join(tmp(), 'chat-bots.json'));
  await registry.set('routines', { name: 'Routines', rooms: ['room-1', BOARD], maxPerHour: 5 });
  const file = join(tmp(), 'routines-grants.json');
  const grants = new RoutinesGrants(file);
  await grants.init();
  const port = {
    cron,
    routines: {
      grants,
      findEmployee: (sid: string) => people.find((p) => p.session === sid),
      boardroomId: () => boardroom,
      notify: (_room: string, text: string) => (noticeWorks ? (notices.push(text), true) : false),
    },
  };
  const app = Fastify({ logger: false });
  registerCronRoutes(app, port as never);
  registerChatBotRoutes(app, registry);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, cron, registry, grants, file };
}

describe('delegated post jobs', () => {
  beforeEach(() => void 0);

  it.each([AVERY, CASEY])('lets the $position role author, edit, disable, run and delete, announcing and auditing each', async (who) => {
    const { app } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(who), payload: body });
    const id = created.json().job.id as string;
    expect((await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, headers: as(who), payload: { postText: 'changed' } })).json().job).toBeTruthy();
    expect((await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}/enabled`, headers: as(who), payload: { enabled: false } })).json().job.enabled).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/api/cron/jobs/${id}/run`, headers: as(who) })).json().success).not.toBe(false);
    expect((await app.inject({ method: 'DELETE', url: `/api/cron/jobs/${id}`, headers: as(who) })).json().success).not.toBe(false);
    expect(jobs[id]).toBeUndefined();
    expect(notices).toHaveLength(5);
    expect(notices[0]).toContain(`${who.name} (${who.position}) created post job "refresh"`);
    expect(notices[1]).toContain('edited');
    expect(audits.map((a) => a.action)).toEqual(['post_job_created', 'post_job_edited', 'post_job_disabled', 'post_job_ran', 'post_job_deleted']);
    expect(audits.every((a) => String(a.admin).startsWith(who.name))).toBe(true);
    await app.close();
  });

  it('refuses a role without the permission, and honours a per-employee grant and a per-employee denial', async () => {
    const { app, grants } = await setup();
    const post = (who: { session: string }) => app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(who), payload: body });
    expect((await post(DEV)).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    await grants.set({ roles: ['CTO', 'COO'], employees: { [DEV.id]: true, [AVERY.id]: false } });
    expect((await post(DEV)).json().job).toBeTruthy();
    expect((await post(AVERY)).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(Object.keys(jobs)).toHaveLength(1);
    await app.close();
  });

  it.each([['unknown session', { 'x-codeman-parent-session': 'garbage' }], ['empty header', { 'x-codeman-parent-session': '' }]])(
    'refuses an unknown caller (%s) and changes nothing',
    async (_n, headers) => {
      const { app } = await setup();
      const res = await app.inject({ method: 'POST', url: '/api/cron/jobs', headers, payload: body });
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
      expect(Object.keys(jobs)).toHaveLength(0);
      expect(notices).toHaveLength(0);
      await app.close();
    }
  );

  it('refuses a caller flagged as holding web content, even with the permission', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: { ...as(CASEY), 'x-codeman-tainted': '1' }, payload: body });
    expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(Object.keys(jobs)).toHaveLength(0);
    await app.close();
  });

  it('keeps plans-pace and burn-watch jobs boardroom-only for a delegate', async () => {
    const { app } = await setup();
    const make = (roomId: string, postSource: string) => app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(AVERY), payload: { ...body, roomId, postSource, postText: postSource === 'burn-watch' ? '{message}' : '{summary}' } });
    expect((await make('room-1', 'plans-pace')).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect((await make('room-1', 'burn-watch')).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect((await make(BOARD, 'plans-pace')).json().job).toBeTruthy();
    // Retargeting an existing boardroom plans job to another room is the same refusal.
    const id = Object.keys(jobs)[0] as string;
    const res = await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, headers: as(AVERY), payload: { roomId: 'room-1' } });
    expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(jobs[id]?.roomId).toBe(BOARD);
    await app.close();
  });

  it('makes no change when the boardroom cannot be told (no notice, no boardroom)', async () => {
    const { app } = await setup();
    noticeWorks = false;
    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(AVERY), payload: body })).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    noticeWorks = true;
    boardroom = undefined;
    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(AVERY), payload: body })).json()).toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(Object.keys(jobs)).toHaveLength(0);
    expect(audits).toHaveLength(0);
    await app.close();
  });

  it('never lets a delegate touch bots, allowlists or caps', async () => {
    const { app, registry } = await setup();
    const before = JSON.stringify(registry.list());
    const put = await app.inject({ method: 'PUT', url: '/api/chat-bots/routines', headers: as(AVERY), payload: { name: 'Routines', rooms: ['room-1', 'room-9'], maxPerHour: 500 } });
    const del = await app.inject({ method: 'DELETE', url: '/api/chat-bots/routines', headers: as(AVERY) });
    expect(put.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(del.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(JSON.stringify(registry.list())).toBe(before);
    await app.close();
  });

  it('audits the owner too, without a boardroom notice', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/cron/jobs', payload: body });
    expect(res.json().job).toBeTruthy();
    expect(audits).toEqual([expect.objectContaining({ admin: 'owner', action: 'post_job_created' })]);
    expect(notices).toHaveLength(0);
    await app.close();
  });
});

describe('launch jobs stay owner-only for every agent (the route-wide stopgap)', () => {
  const launch = {
    name: 'nightly', action: 'launch', agentType: 'claude', workingDir: '/tmp', promptMode: 'inline_text', promptText: 'do things',
    inputMode: 'typed', concurrencyPolicy: 'warn_only', scheduleType: 'daily', dailyTime: '03:00', timeZone: 'America/New_York', enabled: true,
  };

  it('refuses a delegate creating a launch job, and a non-delegate creating either kind', async () => {
    const { app, cron } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(AVERY), payload: launch });
    expect(res.statusCode).toBe(403);
    expect(cron.listJobs()).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(DEV), payload: launch })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(DEV), payload: body })).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(cron.listJobs()).toHaveLength(0);
    expect(notices).toEqual([]);
    await app.close();
  });

  it('refuses a delegate editing, enabling, running or deleting a stored launch job', async () => {
    const { app, cron } = await setup();
    const stored = cron.createJob(launch as never);
    const before = JSON.stringify(cron.getJob(stored.id));
    for (const [method, url, payload] of [
      ['PUT', `/api/cron/jobs/${stored.id}`, { name: 'renamed' }],
      ['PUT', `/api/cron/jobs/${stored.id}/enabled`, { enabled: false }],
      ['POST', `/api/cron/jobs/${stored.id}/run`, undefined],
      ['DELETE', `/api/cron/jobs/${stored.id}`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: as(AVERY), payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(JSON.stringify(cron.getJob(stored.id))).toBe(before);
    expect(notices).toEqual([]);
    await app.close();
  });

  it('refuses a delegate turning a post job into a launch job by edit', async () => {
    const { app, cron } = await setup();
    const id = (await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: as(AVERY), payload: body })).json().job.id as string;
    const before = JSON.stringify(cron.getJob(id));
    const res = await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, headers: as(AVERY), payload: { action: 'launch', agentType: 'claude', workingDir: '/tmp', promptMode: 'inline_text', promptText: 'x', inputMode: 'typed' } });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(cron.getJob(id))).toBe(before);
    // Naming the same action is an ordinary edit.
    expect((await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, headers: as(AVERY), payload: { action: 'post', postText: 'again' } })).json().job).toBeTruthy();
    await app.close();
  });

  it('still lets the owner (no header) author launch jobs', async () => {
    const { app, cron } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/cron/jobs', payload: launch });
    expect(res.statusCode).toBe(200);
    expect(cron.listJobs()).toHaveLength(1);
    await app.close();
  });
});

describe('the grants themselves', () => {
  it('ship role defaults only (no names, ids or emails)', async () => {
    const { grants } = await setup();
    expect(grants.snapshot()).toEqual({ roles: ['CTO', 'COO'], employees: {} });
  });

  it('are changed by the owner alone, validated, and persist', async () => {
    const { app, file } = await setup();
    const put = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'PUT', url: '/api/routines-grants', headers, payload: payload as object });
    // A delegate with the permission still cannot grant it.
    expect((await put(as(AVERY), { roles: ['CTO', 'Developer'], employees: {} })).json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect((await put({}, { roles: 'CTO' })).json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect((await put({}, { roles: ['CTO'], employees: { x: 'yes' } })).json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    const ok = await put({}, { roles: ['CTO', 'Developer'], employees: { [CASEY.id]: true } });
    expect(ok.json()).toMatchObject({ success: true, data: { roles: ['CTO', 'Developer'] } });
    const reloaded = new RoutinesGrants(file);
    await reloaded.init();
    expect(reloaded.allows(DEV)).toBe(true);
    expect(reloaded.allows(CASEY)).toBe(true);
    expect(audits.at(-1)).toMatchObject({ admin: 'owner', action: 'routines_grants_set' });
    await app.close();
  });
});
