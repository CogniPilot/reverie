/** owner-setup.py --go-live sends a partial PUT {dryRun:false}: it must change only that and keep everything else. */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { CronService, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

describe('go-live is a partial edit', () => {
  it('turns the dry run off and leaves the rest of the job as it was', async () => {
    const jobs: Record<string, CronJob> = {};
    const runs: Record<string, CronJobRun> = {};
    const store = {
      getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
      setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
      getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
      removeCronJobRun: (id: string) => { delete runs[id]; },
    };
    const cron = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
    cron.setBotPoster({ getBot: () => ({ id: 'routines', name: 'Routines', rooms: ['room-1'], maxPerHour: 5 }), check: () => {}, post: () => {} } as BotPoster);
    const app = Fastify({ logger: false });
    registerCronRoutes(app, { cron } as never);
    installRouteErrorHandler(app);
    await app.ready();
    const created = await app.inject({ method: 'POST', url: '/api/cron/jobs', payload: {
      name: 'Coffee', action: 'post', botId: 'routines', roomId: 'room-1', postText: '@Casey coffee', scheduleType: 'daily',
      dailyTime: '10:03', timeZone: 'America/New_York', dryRun: true, enabled: true } });
    const id = created.json().job.id as string;
    expect(cron.getJob(id)?.dryRun).toBe(true);

    const res = await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, payload: { dryRun: false } });
    expect(res.statusCode).toBe(200);
    expect(cron.getJob(id)).toMatchObject({ dryRun: false, name: 'Coffee', botId: 'routines', roomId: 'room-1', postText: '@Casey coffee', dailyTime: '10:03', timeZone: 'America/New_York', enabled: true });
    await app.close();
  });
});
