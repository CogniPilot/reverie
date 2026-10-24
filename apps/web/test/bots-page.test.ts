import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerBotsPageRoutes } from '../src/web/routes/bots-page-routes.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { CronService, type CronDeps } from '../src/cron/cron-service.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

const app = Fastify();
let task: string, full: string, restricted: string;
beforeAll(async () => {
  task = await mkdtemp(join(tmpdir(), 'bots-page-'));
  const store = new OwnerAuthStore(join(task, 'owner.json'));
  const password = (await bootstrap(store, 'fixture-owner')).oneTimePassword;
  const service = new OwnerAuthService({ store, auditFile: join(task, 'audit.jsonl') });
  await app.register(cookie);
  registerOwnerRoutes(app, service, false);
  const verifiedOwner = ownerVerifier({ service, ctx: { sessions: new Map() } as never });
  registerBotsPageRoutes(app, verifiedOwner);
  const jobs: Record<string, CronJob> = {},
    runs: Record<string, CronJobRun> = {};
  const cron = new CronService({
    sessions: new Map(),
    broadcast: () => {},
    store: {
      getCronJobs: () => jobs,
      getCronJob: (id: string) => jobs[id] ?? null,
      setCronJob: (id: string, job: CronJob) => {
        jobs[id] = job;
      },
      removeCronJob: (id: string) => {
        delete jobs[id];
      },
      getCronJobRuns: () => runs,
      getCronJobRun: (id: string) => runs[id] ?? null,
      setCronJobRun: (id: string, run: CronJobRun) => {
        runs[id] = run;
      },
      removeCronJobRun: (id: string) => {
        delete runs[id];
      },
    },
  } as unknown as CronDeps);
  registerCronRoutes(app, { cron } as never, verifiedOwner);
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/owner/login',
    payload: { username: 'fixture-owner', password },
  });
  restricted = login.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  const changed = await app.inject({
    method: 'POST',
    url: '/api/owner/password',
    cookies: { [OWNER_COOKIE]: restricted },
    payload: { current: password, next: 'Coral!water71-riverMaple' },
  });
  expect(changed.statusCode).toBe(200);
  full = changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
});
afterAll(async () => {
  await app.close();
  await rm(task, { recursive: true, force: true });
});

describe('bots dashboard owner boundary', () => {
  it('restricts the live execution projection to the real owner and returns no persisted-history guesses', async () => {
    for (const headers of [{}, { 'x-reverie-parent-session': 'agent' }, { 'x-reverie-service-token': 'service' }])
      expect((await app.inject({ url: '/api/cron/active', headers })).statusCode).toBe(403);
    const response = await app.inject({ url: '/api/cron/active', cookies: { [OWNER_COOKIE]: full } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobs: [] });
  });
  it('records owner provenance from real authentication, ignores supplied actor claims and refuses header-only authors', async () => {
    const payload = {
      name: 'Fixture message',
      action: 'post',
      botId: 'fixture',
      roomId: 'room',
      postText: 'Hello',
      scheduleType: 'interval',
      intervalMinutes: 10,
      enabled: false,
      createdByOwner: false,
      createdBy: { employeeId: 'forged' },
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/cron/jobs',
          payload,
          headers: { 'x-reverie-parent-session': 'agent' },
        })
      ).statusCode
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      payload,
      cookies: { [OWNER_COOKIE]: full },
    });
    expect(response.statusCode).toBe(200);
    const job = response.json().job;
    expect(job.createdByOwner).toBe(true);
    expect(job.createdBy).toBeUndefined();
    const edited = await app.inject({
      method: 'PUT',
      url: '/api/cron/jobs/' + job.id,
      payload: { postText: 'Updated', createdByOwner: false },
      cookies: { [OWNER_COOKIE]: full },
    });
    expect(edited.json().job.createdByOwner).toBe(true);
  });
  it('requires a real unrestricted owner and rejects agent/service and cross-origin callers even with the owner cookie', async () => {
    for (const url of ['/bots', '/bots.js', '/bots.css']) {
      for (const token of [undefined, 'forged', restricted])
        expect((await app.inject({ url, cookies: token ? { [OWNER_COOKIE]: token } : {} })).statusCode).toBe(403);
      for (const headers of [
        { 'x-reverie-parent-session': 'agent' },
        { 'x-reverie-service-token': 'service' },
        { origin: 'https://other.test' },
        { 'sec-fetch-site': 'cross-site' },
      ])
        expect((await app.inject({ url, cookies: { [OWNER_COOKIE]: full }, headers })).statusCode).toBe(403);
      const response = await app.inject({ url, cookies: { [OWNER_COOKIE]: full } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});
