/**
 * @fileoverview The next runs of a schedule before it is saved (Bots page schedule form): `nextRuns` follows the cron's own
 * `computeNextRunAt`, and POST /api/cron/schedule-preview validates the schedule like a job and stores nothing.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextRuns } from '../src/cron/cron-time.js';
import { classify } from '../src/owner-auth/policy.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import type { CronJob } from '../src/types/cron.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

const job = (fields: Partial<CronJob>) => fields as CronJob;
// Thursday 2026-10-29 12:00 UTC: 08:00 in New York (EDT), 13:00 in Berlin (CET).
const AFTER = Date.UTC(2026, 9, 29, 12, 0);
const iso = (runs: number[]) => runs.map((at) => new Date(at).toISOString());

describe('nextRuns', () => {
  it('lists daily runs at the wall-clock time of the job time zone, across a daylight-saving change', () => {
    // New York leaves daylight saving on Sunday 2026-11-01: 09:00 is 13:00 UTC before and 14:00 UTC after.
    expect(iso(nextRuns(job({ scheduleType: 'daily', dailyTime: '09:00', timeZone: 'America/New_York' }), AFTER, 4))).toEqual([
      '2026-10-29T13:00:00.000Z',
      '2026-10-30T13:00:00.000Z',
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
    ]);
  });

  it('lists weekly runs on the chosen days only', () => {
    const runs = nextRuns(job({ scheduleType: 'weekly', weeklyDays: [1, 4], weeklyTime: '07:30', timeZone: 'Europe/Berlin' }), AFTER, 3);
    // Thursday 07:30 Berlin has passed at 13:00, so Monday, Thursday, Monday.
    expect(iso(runs)).toEqual(['2026-11-02T06:30:00.000Z', '2026-11-05T06:30:00.000Z', '2026-11-09T06:30:00.000Z']);
  });

  it('steps an interval from the time asked, ends a one-time job after one run, and has none for an incomplete schedule', () => {
    expect(nextRuns(job({ scheduleType: 'interval', intervalMinutes: 90 }), AFTER, 2)).toEqual([AFTER + 90 * 60_000, AFTER + 180 * 60_000]);
    expect(nextRuns(job({ scheduleType: 'once', runAt: AFTER + 5 }), AFTER, 3)).toEqual([AFTER + 5]);
    expect(nextRuns(job({ scheduleType: 'daily' }), AFTER, 3)).toEqual([]);
    expect(nextRuns(job({ scheduleType: 'weekly', weeklyDays: [], weeklyTime: '07:30' }), AFTER, 3)).toEqual([]);
  });
});

describe('POST /api/cron/schedule-preview', () => {
  let app: FastifyInstance;
  let cron: Record<string, ReturnType<typeof vi.fn>>;
  beforeEach(async () => {
    app = Fastify();
    installRouteErrorHandler(app);
    cron = { createJob: vi.fn(), updateJob: vi.fn(), listJobs: vi.fn(() => []), getJob: vi.fn() };
    registerCronRoutes(app, { cron } as never, trustedFixtureOwner);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });
  const preview = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/cron/schedule-preview', payload });

  it('answers the next runs and stores nothing', async () => {
    const before = Date.now();
    const res = await preview({ scheduleType: 'weekly', weeklyDays: [1, 4], weeklyTime: '07:30', timeZone: 'Europe/Berlin', count: 5 });
    expect(res.statusCode).toBe(200);
    const runs = (res.json().data ?? res.json()).runs as number[];
    expect(runs).toHaveLength(5);
    expect(runs[0]).toBeGreaterThan(before);
    const berlin = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const at of runs) expect(berlin.format(at)).toMatch(/^(Mon|Thu) 07:30$/);
    expect(cron.createJob).not.toHaveBeenCalled();
    expect(cron.updateJob).not.toHaveBeenCalled();
    const three = await preview({ scheduleType: 'interval', intervalMinutes: 30 });
    expect(((three.json().data ?? three.json()).runs as number[]).length).toBe(3);
  });

  it('refuses a schedule a job could not hold, with the same messages', async () => {
    for (const [payload, message] of [
      [{ scheduleType: 'daily' }, 'dailyTime is required for a daily schedule'],
      [{ scheduleType: 'weekly', weeklyTime: '07:30' }, 'weeklyDays and weeklyTime are required for a weekly schedule'],
      [{ scheduleType: 'daily', dailyTime: '09:00', timeZone: 'Mars/Olympus' }, 'timeZone must be an IANA zone'],
      [{ scheduleType: 'daily', dailyTime: '25:00' }, ''],
      [{ scheduleType: 'interval', intervalMinutes: 30, count: 11 }, ''],
      [{ scheduleType: 'interval', intervalMinutes: 30, postText: 'not a schedule field' }, ''],
    ] as const) {
      const res = await preview(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.body).toContain(message);
    }
  });

  it('is an owner route: agents and services cannot call it', () => {
    expect(classify('POST', '/api/cron/schedule-preview', '/api/cron/schedule-preview')).toBe('owner');
  });
});
