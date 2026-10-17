/** The cron service with the real github source: incomplete reads are posted, cursors move only after a post. */
import { describe, it, expect, vi } from 'vitest';
import { CronService, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';
import type { PostSourceData } from '../src/cron/post-sources.js';

function make(source: (ctx: { last?: string }) => Promise<PostSourceData>, failPost = false) {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  const store = {
    getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
    getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
    removeCronJobRun: (id: string) => { delete runs[id]; },
  };
  const posted: string[] = [];
  const cron = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
  const poster: BotPoster = {
    getBot: () => ({ id: 'routines', name: 'Routines', rooms: ['r'], maxPerHour: 50 }),
    check: () => {},
    post: (_b, _r, text) => { if (failPost) throw new Error('room gone'); posted.push(text); },
  };
  cron.setBotPoster(poster);
  cron.setPostSources({ github: source });
  const job = cron.createJob({
    name: 'watch', action: 'post', botId: 'routines', roomId: 'r', postText: '{lines}', postSource: 'github',
    postSourceArgs: { owner: 'o', repo: 'r' }, postChangeOnly: true, postWhen: { field: 'items', op: 'gt', value: 0 },
    scheduleType: 'interval', intervalMinutes: 720, enabled: true,
  } as never);
  return { cron, job, jobs, posted };
}

describe('github job', () => {
  it('posts monitoring incomplete even when the template, condition and change-only would be silent, and keeps the cursor', async () => {
    const { cron, job, jobs, posted } = make(async () => ({ items: 0, lines: '', _hold: 1, _key: 'C1', message: 'GitHub o/r: monitoring incomplete (x)' }));
    jobs[job.id]!.postLastText = 'C1';
    await cron.runNow(job.id);
    expect(posted).toEqual(['GitHub o/r: monitoring incomplete (x)']);
    expect(jobs[job.id]!.postLastText).toBe('C1');
  });
  it('moves the cursor only after the post succeeded', async () => {
    const src = async () => ({ items: 1, lines: 'PR #1 opened', _key: 'C2', message: 'm' });
    const ok = make(src);
    await ok.cron.runNow(ok.job.id);
    expect(ok.posted).toEqual(['PR #1 opened']);
    expect(ok.jobs[ok.job.id]!.postLastText).toBe('C2');
    const bad = make(src, true);
    await bad.cron.runNow(bad.job.id);
    expect(bad.posted).toEqual([]);
    expect(bad.jobs[bad.job.id]!.postLastText).toBeUndefined();
  });
  it('hands the source its arguments and the saved cursor', async () => {
    const seen: unknown[] = [];
    const { cron, job, jobs } = make(async (ctx) => { seen.push(ctx); return { items: 0, lines: '', _key: '' , message: 'm' }; });
    jobs[job.id]!.postLastText = 'C3';
    await cron.runNow(job.id);
    expect(seen[0]).toEqual({ args: { owner: 'o', repo: 'r' }, last: 'C3' });
  });
  it('restarts from a baseline when the job is pointed at another repository', () => {
    const { cron, job, jobs } = make(async () => ({ items: 0, lines: '', _key: '', message: 'm' }));
    jobs[job.id]!.postLastText = 'C4';
    cron.updateJob(job.id, { postSourceArgs: { owner: 'o', repo: 'other' } });
    expect(jobs[job.id]!.postLastText).toBeUndefined();
    jobs[job.id]!.postLastText = 'C5';
    cron.updateJob(job.id, { postSourceArgs: { owner: 'o', repo: 'other' } });
    expect(jobs[job.id]!.postLastText).toBe('C5');
  });
});
