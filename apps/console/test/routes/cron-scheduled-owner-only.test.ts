/**
 * @fileoverview Cron and scheduled-run WRITE routes are owner-only (stopgap until owner
 * authentication). They create or start unattended sessions (shell mode, a launchCommand, or full
 * permissions), and in single-user mode canAccessOwned and the privileged-command grant are always
 * true, so any agent could otherwise schedule them. A request carrying X-Reverie-Parent-Session (any
 * value) is refused; an absent header is still the owner; reads are unchanged. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { registerCronRoutes } from '../../src/web/routes/cron-routes.js';
import { registerScheduledRoutes } from '../../src/web/routes/scheduled-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

const AGENT = { 'x-reverie-parent-session': '0000002d-0035-4000-8000-000000000047' };
const job = {
  id: 'job-1',
  name: 'nightly',
  agentType: 'claude',
  workingDir: tmpdir(),
  promptMode: 'inline_text',
  promptText: 'hello',
  inputMode: 'paste',
  scheduleType: 'daily',
  dailyTime: '09:00',
  enabled: true,
  concurrencyPolicy: 'warn_only',
};
const body = { ...job, id: undefined };

describe('cron and scheduled-run writes are owner-only', () => {
  let app: FastifyInstance;
  let cron: Record<string, ReturnType<typeof vi.fn>>;
  let scheduled: { scheduledRuns: Map<string, unknown>; startScheduledRun: ReturnType<typeof vi.fn>; stopScheduledRun: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    app = Fastify();
    installRouteErrorHandler(app);
    cron = {
      listJobs: vi.fn(() => [job]),
      getJob: vi.fn(() => job),
      createJob: vi.fn(() => job),
      updateJob: vi.fn(() => job),
      deleteJob: vi.fn(() => true),
      setEnabled: vi.fn(() => job),
      runNow: vi.fn(async () => ({ id: 'run-1' })),
      countActiveAgents: vi.fn(() => 0),
      listRuns: vi.fn(() => []),
    };
    scheduled = {
      scheduledRuns: new Map([['run-1', { id: 'run-1' }]]),
      startScheduledRun: vi.fn(async () => ({ id: 'run-2' })),
      stopScheduledRun: vi.fn(async () => {}),
    };
    registerCronRoutes(app, { cron } as never);
    registerScheduledRoutes(app, scheduled as never);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const writes = [
    { method: 'POST', url: '/api/cron/jobs', payload: body, effect: () => cron.createJob },
    { method: 'PUT', url: '/api/cron/jobs/job-1', payload: { name: 'x' }, effect: () => cron.updateJob },
    { method: 'DELETE', url: '/api/cron/jobs/job-1', effect: () => cron.deleteJob },
    { method: 'PUT', url: '/api/cron/jobs/job-1/enabled', payload: { enabled: false }, effect: () => cron.setEnabled },
    { method: 'POST', url: '/api/cron/jobs/job-1/run', effect: () => cron.runNow },
    { method: 'POST', url: '/api/scheduled', payload: { prompt: 'go' }, effect: () => scheduled.startScheduledRun },
    { method: 'DELETE', url: '/api/scheduled/run-1', effect: () => scheduled.stopScheduledRun },
  ] as const;

  for (const write of writes) {
    it(`${write.method} ${write.url}: an agent is refused and nothing happens`, async () => {
      for (const header of [AGENT, { 'x-reverie-parent-session': '' }, { 'x-reverie-parent-session': 'bogus' }]) {
        const res = await app.inject({ method: write.method, url: write.url, payload: write.payload, headers: header });
        expect(res.statusCode).toBe(403);
        expect(res.json().success).toBe(false);
      }
      expect(write.effect()).not.toHaveBeenCalled();
    });

    it(`${write.method} ${write.url}: the owner (no header) still works`, async () => {
      const res = await app.inject({ method: write.method, url: write.url, payload: write.payload });
      expect(res.statusCode).toBe(200);
      expect(write.effect()).toHaveBeenCalledTimes(1);
    });
  }

  it('the /api/v1 alias is covered by the same hook (rewritten, not registered twice)', async () => {
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toContain('/api/v1/cron');
  });

  it('reads stay open to agents', async () => {
    for (const url of ['/api/cron/jobs', '/api/cron/jobs/job-1', '/api/cron/jobs/job-1/runs', '/api/cron/runs', '/api/scheduled']) {
      const res = await app.inject({ method: 'GET', url, headers: AGENT });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('a write route added later under the prefix is covered too', async () => {
    const late = Fastify();
    installRouteErrorHandler(late);
    registerCronRoutes(late, { cron } as never);
    late.post('/api/cron/jobs/:id/clone', async () => ({ success: true }));
    late.post('/api/elsewhere', async () => ({ success: true }));
    await late.ready();
    expect((await late.inject({ method: 'POST', url: '/api/cron/jobs/job-1/clone', headers: AGENT })).statusCode).toBe(403);
    expect((await late.inject({ method: 'POST', url: '/api/elsewhere', headers: AGENT })).statusCode).toBe(200);
    await late.close();
  });
});
