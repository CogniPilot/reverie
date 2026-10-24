/** Real Basic + owner policy + cron handlers. Synthetic grants only; no scheduler starts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { RoutinesGrants } from '../src/routines-grants.js';
import * as admin from '../src/owner-auth/admin.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import type { CronJob } from '../src/types/cron.js';

vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: async () => undefined }));
const SELF = '0000002d-0035-4000-8000-000000000047';
const OTHER = '00000038-0043-4000-8000-000000000060';
const BASIC = 'Basic ' + Buffer.from('admin:synthetic-shared').toString('base64');
const body = {
  action: 'post',
  name: 'routine',
  roomId: 'room-own',
  postText: 'bounded reminder',
  scheduleType: 'interval',
  intervalMinutes: 5,
  enabled: true,
};

describe('routine access through actual owner middleware', () => {
  let app: FastifyInstance;
  let dir: string;
  let grants: RoutinesGrants;
  let token: string;
  let savedPassword: string | undefined;
  let jobs: Map<string, CronJob>;
  let writes: ReturnType<typeof vi.fn>;
  let notice: boolean;
  const people = [
    { id: 'employee-own', name: 'Author', position: 'Engineer', session: SELF },
    { id: 'employee-other', name: 'Other', position: 'Engineer', session: OTHER },
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'routine-auth-'));
    savedPassword = process.env.REVERIE_PASSWORD;
    process.env.REVERIE_PASSWORD = 'synthetic-shared';
    const store = new OwnerAuthStore(join(dir, 'owner.json'));
    await admin.bootstrap(store, 'synthetic-owner');
    await admin.setPolicy(store, 'enforce', { forceLockoutRisk: true });
    token = await admin.issueServiceToken(store, 'synthetic-watcher');
    const service = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl') });
    grants = new RoutinesGrants(join(dir, 'grants.json'));
    await grants.init();
    await grants.set({ roles: [], employees: { 'employee-own': true } });
    jobs = new Map([
      ['mine', { id: 'mine', ...body, postAs: 'author', createdBy: { employeeId: 'employee-own' } } as CronJob],
      [
        'foreign',
        {
          id: 'foreign',
          ...body,
          postText: 'private foreign text',
          createdBy: { employeeId: 'employee-other' },
        } as CronJob,
      ],
      ['launch', { id: 'launch', action: 'launch', name: 'launch', launchCommand: 'forbidden' } as CronJob],
    ]);
    writes = vi.fn();
    notice = true;
    const cron = {
      listJobs: () => [...jobs.values()],
      getJob: (id: string) => jobs.get(id),
      createJob: (input: object, _owner: unknown, author: unknown) => {
        writes();
        const job = { ...input, id: 'new', createdBy: author } as CronJob;
        jobs.set('new', job);
        return job;
      },
      updateJob: (id: string, input: object) => {
        writes();
        const j = { ...jobs.get(id), ...input } as CronJob;
        jobs.set(id, j);
        return j;
      },
      deleteJob: (id: string) => {
        writes();
        return jobs.delete(id);
      },
      setEnabled: (id: string, enabled: boolean) => {
        writes();
        return { ...jobs.get(id), enabled };
      },
      runNow: async () => {
        writes();
        return { id: 'run' };
      },
      countActiveAgents: () => 0,
      listRuns: () => [{ id: 'run', cronJobId: 'foreign', status: 'success', prompt: 'private run text' }],
    };
    app = Fastify();
    await app.register(cookie);
    registerAuthMiddleware(app, false, '', service);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions: new Map(people.map((p) => [p.session, { id: p.session }])) } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: {
        known: () => true,
        related: (a, b) => a === b,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerCronRoutes(app, {
      cron,
      routines: {
        grants,
        findEmployee: (id: string) => people.find((p) => p.session === id),
        isMember: (room: string, sid: string) => room === 'room-own' && [SELF, OTHER].includes(sid),
        notificationRoomId: () => 'board',
        notify: () => notice,
      },
    } as never);
    registerChatBotRoutes(app, {
      list: () => [],
      set: () => {
        writes();
      },
      remove: () => {
        writes();
      },
    } as never);
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    if (savedPassword === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = savedPassword;
    await rm(dir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {}
  ) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: {
        authorization: BASIC,
        'x-reverie-parent-session': SELF,
        ...headers,
      },
    });

  it('allows scoped listing and own post create/edit/disable/run/delete with explicit grant', async () => {
    expect((await call('GET', '/api/cron/jobs')).json()).toHaveLength(1);
    expect((await call('POST', '/api/cron/jobs', body)).json().job.createdBy.employeeId).toBe('employee-own');
    expect((await call('PUT', '/api/cron/jobs/mine', { postText: 'updated' })).json().job.postText).toBe('updated');
    expect((await call('PUT', '/api/cron/jobs/mine/enabled', { enabled: false })).json().job.enabled).toBe(false);
    expect((await call('POST', '/api/cron/jobs/mine/run')).json().run.id).toBe('run');
    expect((await call('DELETE', '/api/cron/jobs/mine')).statusCode).toBe(200);
    expect(writes).toHaveBeenCalledTimes(5);
  });
  it('does not confer a grant or accept revoked grants', async () => {
    await grants.set({ roles: [], employees: {} });
    expect((await call('POST', '/api/cron/jobs', body)).statusCode).toBe(403);
    expect((await call('PUT', '/api/cron/jobs/mine', { postText: 'no' })).statusCode).toBe(403);
    expect(writes).not.toHaveBeenCalled();
  });
  it('refuses foreign create/edit rooms and missing announcement', async () => {
    expect((await call('POST', '/api/cron/jobs', { ...body, roomId: 'private-room' })).statusCode).toBe(403);
    expect((await call('PUT', '/api/cron/jobs/mine', { roomId: 'private-room' })).statusCode).toBe(403);
    notice = false;
    expect((await call('POST', '/api/cron/jobs', body)).statusCode).toBe(403);
    expect(writes).not.toHaveBeenCalled();
  });
  it('refuses all foreign mutations and launch mutations including conversion', async () => {
    for (const id of ['foreign', 'launch']) {
      for (const [method, suffix, payload] of [
        ['PUT', '', { postText: 'no' }],
        ['DELETE', '', undefined],
        ['PUT', '/enabled', { enabled: true }],
        ['POST', '/run', undefined],
      ] as const)
        expect((await call(method, '/api/cron/jobs/' + id + suffix, payload)).statusCode).toBe(403);
    }
    expect((await call('POST', '/api/cron/jobs', { action: 'launch' })).statusCode).toBe(403);
    expect((await call('PUT', '/api/cron/jobs/mine', { action: 'launch' })).statusCode).toBe(403);
    expect(writes).not.toHaveBeenCalled();
  });
  it('keeps bot/grant management and owner-only source fields refused', async () => {
    for (const [method, url, payload] of [
      ['PUT', '/api/routines-grants', { roles: ['Engineer'] }],
      ['GET', '/api/routines-grants', undefined],
      ['PUT', '/api/chat-bots/bot', { rooms: ['room-own'] }],
      ['DELETE', '/api/chat-bots/bot', undefined],
      ['POST', '/api/cron/jobs', { ...body, postSource: 'github', postSourceArgs: { owner: 'example', repo: 'example' } }],
      ['POST', '/api/cron/jobs', { ...body, botId: 'bot' }],
    ] as const)
      expect((await call(method, url, payload)).statusCode, method + ' ' + url).toBe(403);
    expect(grants.snapshot()).toEqual({ roles: [], employees: { 'employee-own': true } });
    expect(writes).not.toHaveBeenCalled();
  });
  it('redacts foreign job and run contents, including all-listing', async () => {
    const all = (await call('GET', '/api/cron/jobs?all=1')).json();
    expect(all.find((j: CronJob) => j.id === 'foreign').postText).toBeUndefined();
    expect((await call('GET', '/api/cron/jobs/foreign')).json().postText).toBeUndefined();
    expect((await call('GET', '/api/cron/jobs/foreign/runs')).json()[0].prompt).toBeUndefined();
    expect((await call('GET', '/api/cron/runs')).json()[0].prompt).toBeUndefined();
  });
  it('refuses invalid/missing authentication and service tokens without owner impersonation', async () => {
    expect((await call('GET', '/api/cron/jobs', undefined, { authorization: 'bad' })).statusCode).toBe(401);
    expect((await call('GET', '/api/cron/jobs', undefined, { 'x-reverie-parent-session': 'invalid' })).statusCode).toBe(
      403
    );
    for (const headers of [
      { 'x-reverie-service-token': token },
      { 'x-reverie-service-token': token, 'x-reverie-parent-session': '' },
    ]) {
      expect((await call('POST', '/api/cron/jobs', body, headers)).statusCode).toBe(403);
      expect((await call('GET', '/api/cron/jobs', undefined, headers)).statusCode).toBe(403);
    }
    expect(writes).not.toHaveBeenCalled();
  });
});
