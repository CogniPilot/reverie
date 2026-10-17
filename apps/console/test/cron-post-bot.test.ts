/**
 * Routine bot: per-job time zones, the 'post' cron action, the bot registry and its limits.
 * Labels here are placeholders; real bots and rooms are instance data.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNextRunAt, isValidTimeZone } from '../src/cron/cron-time.js';
import { CronService, POST_CATCH_UP_MS, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import { CronJobSchema } from '../src/web/schemas.js';
import { burnWatchData, plansPaceData, renderTemplate, validatePostSource } from '../src/cron/post-sources.js';
import type { PlanRow } from '../src/plan-accounts.js';
import { ChatBotRegistry, parseBot, type ChatBot } from '../src/chat-bots.js';
import { ChatroomStore, messageRecipients } from '../src/chatroom-store.js';
import { senderLabel } from '../src/chatroom-delivery.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';
import type { CronJobInput } from '../src/cron/cron-input.js';

const NY = 'America/New_York';
const at = (iso: string) => Date.parse(iso);

function job(partial: Partial<CronJob>): CronJob {
  return {
    id: 'j1', name: 'n', agentType: 'shell', workingDir: '/', promptMode: 'inline_text', inputMode: 'paste',
    scheduleType: 'daily', enabled: true, concurrencyPolicy: 'warn_only', createdAt: 0, updatedAt: 0,
    lastRunAt: null, nextRunAt: null, lastStatus: null, lastDueKey: null, ...partial,
  };
}

describe('per-job time zone', () => {
  it('reads a daily time in the job zone, across both offsets of the year', () => {
    const d = job({ dailyTime: '06:45', timeZone: NY });
    // 2026-10-17 is EDT (UTC-4); 2026-12-01 is EST (UTC-5).
    expect(computeNextRunAt(d, at('2026-10-17T00:00:00Z'))).toBe(at('2026-10-17T10:45:00Z'));
    expect(computeNextRunAt(d, at('2026-12-01T00:00:00Z'))).toBe(at('2026-12-01T11:45:00Z'));
  });

  it('moves to the next day once today is past, and keeps the wall time over a DST change', () => {
    const d = job({ dailyTime: '08:05', timeZone: NY });
    expect(computeNextRunAt(d, at('2026-10-17T13:00:00Z'))).toBe(at('2026-10-18T12:05:00Z'));
    // Fall back is 2026-11-01 at 02:00 EDT; 08:05 on Nov 1 is already EST.
    expect(computeNextRunAt(d, at('2026-10-31T13:00:00Z'))).toBe(at('2026-11-01T13:05:00Z'));
  });

  it('fires a time that does not exist (spring forward) shifted by the jump, once', () => {
    const d = job({ dailyTime: '02:30', timeZone: NY });
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT.
    const next = computeNextRunAt(d, at('2026-03-08T00:00:00Z'));
    expect(next).toBe(at('2026-03-08T07:30:00Z'));
  });

  it('picks the first of a repeated time (fall back)', () => {
    const d = job({ dailyTime: '01:30', timeZone: NY });
    expect(computeNextRunAt(d, at('2026-11-01T00:00:00Z'))).toBe(at('2026-11-01T05:30:00Z')); // 01:30 EDT
  });

  it('weekly days are the days in the job zone', () => {
    // Sunday 2026-10-18 at 23:30 ET is Monday in UTC; a Sunday-only job must fire on the ET Sunday.
    const w = job({ scheduleType: 'weekly', weeklyTime: '23:30', weeklyDays: [0], timeZone: NY });
    expect(computeNextRunAt(w, at('2026-10-17T12:00:00Z'))).toBe(at('2026-10-19T03:30:00Z'));
  });

  it('rejects an unknown zone in the schema', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    const r = CronJobSchema.safeParse({ ...postInput(), timeZone: 'Mars/Base' });
    expect(r.success).toBe(false);
  });
});

function postInput(over: Partial<CronJobInput> = {}): CronJobInput {
  return {
    name: 'schedule refresh', action: 'post', botId: 'routines', roomId: 'room-1',
    postText: '@Alex refresh the schedule', scheduleType: 'daily', dailyTime: '06:45', timeZone: NY, enabled: true,
    ...over,
  };
}

describe('post job schema', () => {
  it('needs no session fields, but needs bot, room and text', () => {
    expect(CronJobSchema.safeParse(postInput()).success).toBe(true);
    for (const f of ['botId', 'roomId', 'postText'] as const) {
      expect(CronJobSchema.safeParse(postInput({ [f]: undefined })).success).toBe(false);
    }
  });
  it('still requires the session fields for a launch job', () => {
    const r = CronJobSchema.safeParse({ name: 'x', scheduleType: 'daily', dailyTime: '01:00', enabled: true });
    expect(r.success).toBe(false);
  });
  it('rejects a multi-line post', () => {
    expect(CronJobSchema.safeParse(postInput({ postText: 'a\nb' })).success).toBe(false);
  });
});

const bot: ChatBot = { id: 'routines', name: 'Routines', rooms: ['room-1'], maxPerHour: 2 };

function makeService() {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  const store = {
    getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
    getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
    removeCronJobRun: (id: string) => { delete runs[id]; },
  };
  const service = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
  const posted: Array<{ roomId: string; text: string }> = [];
  const poster: BotPoster = {
    getBot: (id) => (id === bot.id ? bot : undefined),
    check: (b, roomId, recent) => {
      if (!b.rooms.includes(roomId)) throw new Error('not on the allowlist');
      if (recent >= b.maxPerHour) throw new Error('hourly cap');
    },
    post: (_b, roomId, text) => { posted.push({ roomId, text }); },
  };
  service.setBotPoster(poster);
  return { service, posted, runs };
}

describe('post action', () => {
  it('posts on Run Now and records a posted run', async () => {
    const { service, posted } = makeService();
    const j = service.createJob(postInput());
    const run = await service.runNow(j.id);
    expect(run?.status).toBe('posted');
    expect(posted).toEqual([{ roomId: 'room-1', text: '@Alex refresh the schedule' }]);
    expect(j.agentType).toBe('shell'); // placeholder, never launched
  });

  it('dry run records what it would post and posts nothing', async () => {
    const { service, posted } = makeService();
    const j = service.createJob(postInput({ dryRun: true }));
    const run = await service.runNow(j.id);
    expect(run?.status).toBe('skipped');
    expect(run?.errorMessage).toMatch(/Dry run: Routines would post in room-1/);
    expect(posted).toEqual([]);
  });

  it('refuses a room off the allowlist and an unknown bot', async () => {
    const { service, posted } = makeService();
    const off = service.createJob(postInput({ roomId: 'room-2' }));
    expect((await service.runNow(off.id))?.errorMessage).toMatch(/allowlist/);
    const unknown = service.createJob(postInput({ botId: 'nobody' }));
    expect((await service.runNow(unknown.id))?.errorMessage).toMatch(/No bot "nobody"/);
    expect(posted).toEqual([]);
  });

  it('caps the bot per hour across its jobs', async () => {
    const { service, posted } = makeService();
    const a = service.createJob(postInput({ name: 'a' }));
    const b = service.createJob(postInput({ name: 'b' }));
    await service.runNow(a.id);
    await service.runNow(b.id);
    const third = await service.runNow(a.id);
    expect(third?.status).toBe('failed');
    expect(third?.errorMessage).toMatch(/hourly cap/);
    expect(posted).toHaveLength(2);
  });

  it('fires on time from the tick and then moves to the next day', async () => {
    const { service, posted } = makeService();
    const j = service.createJob(postInput());
    const due = j.nextRunAt as number;
    await service.tickDueJobs(due + 1000);
    expect(posted).toHaveLength(1);
    expect((service.getJob(j.id) as CronJob).nextRunAt).toBeGreaterThan(due);
  });

  it('skips a post that is more than the catch-up window late', async () => {
    const { service, posted, runs } = makeService();
    const j = service.createJob(postInput());
    const due = j.nextRunAt as number;
    await service.tickDueJobs(due + POST_CATCH_UP_MS + 60_000);
    expect(posted).toEqual([]);
    expect(Object.values(runs)[0].errorMessage).toMatch(/^Missed/);
    expect((service.getJob(j.id) as CronJob).nextRunAt).toBeGreaterThan(due);
  });
});

describe('bot registry', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'bots-')), 'chat-bots.json');

  it('persists a bot with a private file and loads it back', async () => {
    const f = file();
    await new ChatBotRegistry(f).set('routines', { name: 'Routines', icon: '⏰', rooms: ['room-1'] });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const loaded = new ChatBotRegistry(f).get('routines');
    expect(loaded).toMatchObject({ name: 'Routines', icon: '⏰', rooms: ['room-1'], maxPerHour: 30 });
  });

  it('treats a damaged file as no bots, and drops one invalid entry', () => {
    const f = file();
    writeFileSync(f, '{nope');
    expect(new ChatBotRegistry(f).list()).toEqual([]);
    writeFileSync(f, JSON.stringify({ good: { name: 'Good', rooms: [] }, bad: { name: '', rooms: [] } }));
    expect(new ChatBotRegistry(f).list().map((b) => b.id)).toEqual(['good']);
    expect(readFileSync(f, 'utf-8')).toContain('bad'); // loading never rewrites the file
  });

  it('validates names, ids, rooms and the cap', () => {
    expect(() => parseBot({ name: '@Alex', rooms: [] }, 'x')).toThrow();
    expect(() => parseBot({ name: 'ok', rooms: [] }, 'Bad Id')).toThrow();
    expect(() => parseBot({ name: 'ok', rooms: 'all' }, 'x')).toThrow();
    expect(() => parseBot({ name: 'ok', rooms: [], maxPerHour: 0 }, 'x')).toThrow();
  });
});

describe('bot sender in a room', () => {
  it('posts to everyone, is not a member, and shows to agents as a scheduled bot', () => {
    const store = new ChatroomStore();
    const room = store.create('work', undefined);
    const m = store.post(room.id, { kind: 'bot', botId: 'routines', name: 'Routines' }, '@Alex hi');
    expect(m.to).toBe('all');
    expect(room.members).toEqual([]);
    expect(messageRecipients(room, m)).toEqual([]);
    expect(senderLabel(m.from)).toBe('BOT "Routines" (scheduled)');
  });
  it('cannot post in a direct message', () => {
    const store = new ChatroomStore();
    const { room } = store.openDm(['user', 'aaaaaaaa-0000-0000-0000-000000000001'], undefined);
    expect(() => store.post(room.id, { kind: 'bot', botId: 'r', name: 'R' }, 'hi')).toThrow(/direct message/);
  });
});

describe('built-in data sources', () => {
  const row = (label: string, weekly: number, projected: number | null, runsOutAt: number | null, banked?: number): PlanRow =>
    ({
      label, signedIn: true,
      pace: { weekly, projected, runsOutAt },
      bankedResets: banked === undefined ? null : { availableCount: banked, earliestExpiresAt: 1_000_000 + 7_200_000 },
    }) as unknown as PlanRow;

  it('summarises plans-pace as worst case plus banked resets', () => {
    const d = plansPaceData([row('A', 40, 80, null), row('B', 70, 120, 1_000_000 + 3_600_000, 2)], 1_000_000);
    expect(d).toMatchObject({ accounts: 2, maxWeekly: 70, maxProjected: 120, minHoursToRunOut: 1, bankedAvailable: 2, bankedSoonestExpiryHours: 2, worst: 'B' });
    expect(plansPaceData([], 0)).toMatchObject({ accounts: 0 });
  });

  it('renders placeholders and validates fields', () => {
    expect(renderTemplate('load {load15} on {cpus}, {nope}', { load15: 3.5, cpus: 8 })).toBe('load 3.5 on 8, n/a');
    expect(validatePostSource('host-load', 'load {load15}', { field: 'load15', op: 'gt', value: 4 })).toBeNull();
    expect(validatePostSource('host-load', 'x {bogus}', undefined)).toMatch(/not a field/);
    expect(validatePostSource('host-load', 'x', { field: 'worst', op: 'gt', value: 1 })).toMatch(/must be one of/);
    expect(validatePostSource('nope', 'x', undefined)).toMatch(/Unknown data source/);
  });

  it('the schema checks a source post and rejects conditions without a source', () => {
    const ok = { postSource: 'host-load', postText: 'load {load15}', postWhen: { field: 'load15', op: 'gt', value: 4 } };
    expect(CronJobSchema.safeParse(postInput(ok)).success).toBe(true);
    expect(CronJobSchema.safeParse(postInput({ ...ok, postText: '{bogus}' })).success).toBe(false);
    expect(CronJobSchema.safeParse(postInput({ postChangeOnly: true })).success).toBe(false);
  });

  function sourced(load: { v: number }) {
    const ctx = makeService();
    ctx.service.setPostSources({ 'host-load': async () => ({ load15: load.v, cpus: 8 }) });
    return ctx;
  }

  it('posts the rendered text only when the condition holds; scheduled silence leaves no run', async () => {
    const load = { v: 1 };
    const { service, posted, runs } = sourced(load);
    const j = service.createJob(postInput({ postSource: 'host-load', postText: '@Morgan load {load15} on {cpus} CPUs', postWhen: { field: 'load15', op: 'gt', value: 4 } }));
    await service.tickDueJobs((j.nextRunAt as number) + 1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toEqual([]);
    expect(Object.keys(runs)).toHaveLength(0);
    // Run Now explains why nothing was posted.
    const manual = await service.runNow(j.id);
    expect(manual?.status).toBe('skipped');
    expect(manual?.errorMessage).toMatch(/Condition not met: load15 gt 4 \(now 1\)/);
    load.v = 6;
    const run = await service.runNow(j.id);
    expect(run?.status).toBe('posted');
    expect(posted).toEqual([{ roomId: 'room-1', text: '@Morgan load 6 on 8 CPUs' }]);
  });

  it('change-only skips an identical scheduled post but posts a changed one', async () => {
    const load = { v: 6 };
    const { service, posted } = sourced(load);
    const j = service.createJob(postInput({ postSource: 'host-load', postText: 'load {load15}', postChangeOnly: true }));
    await service.runNow(j.id);
    expect(posted).toHaveLength(1);
    const next = (service.getJob(j.id) as CronJob).nextRunAt as number;
    await service.tickDueJobs(next + 1000); // same text: silent
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1);
    load.v = 7;
    await service.runNow(j.id);
    expect(posted.map((p) => p.text)).toEqual(['load 6', 'load 7']);
  });

  it('a source that fails to read records a failed run', async () => {
    const { service } = makeService();
    const j = service.createJob(postInput({ postSource: 'host-load', postText: 'load {load15}' }));
    const run = await service.runNow(j.id);
    expect(run?.status).toBe('failed');
  });
});

describe('source post edits', () => {
  it('null clears a saved condition and keeps the source', () => {
    const { service } = makeService();
    const j = service.createJob(postInput({ postSource: 'host-load', postText: 'load {load15}', postWhen: { field: 'load15', op: 'gt', value: 4 } }));
    const u = service.updateJob(j.id, { postWhen: null }) as CronJob;
    expect(u.postWhen).toBeUndefined();
    expect(u.postSource).toBe('host-load');
  });
});

describe('burn-watch source', () => {
  const plan = (label: string, over: Record<string, unknown> = {}): PlanRow =>
    ({ label, signedIn: true, sessions: [{ name: 'Morgan' }], bankedResets: null,
      pace: { weekly: 50, burnPerHour: 1, projected: 90, weekReset: 2_000_000_000, runsOutAt: null }, ...over }) as unknown as PlanRow;
  const alerting = (label: string) => plan(label, { pace: { weekly: 90, burnPerHour: 2, projected: 130, weekReset: 2_000_000_000, runsOutAt: 1_900_000_000 } });

  it('lists a plan that runs out before reset and a banked reset; times stay out of the key', () => {
    const d = burnWatchData([alerting('globex'), plan('codex', { bankedResets: { availableCount: 2, earliestExpiresAt: 5 } }), plan('ok')]);
    expect(d.alerts).toBe(2);
    expect(d.message).toMatch(/^Burn watch: ALERT globex \(Morgan\) runs out .* UTC, before its reset .* UTC; ALERT BANKED codex \(Morgan\): 2 free reset/);
    expect(d._key).toBe('ALERT globex (Morgan) runs out|ALERT BANKED codex (Morgan): 2');
    expect(burnWatchData([plan('ok')])).toMatchObject({ alerts: 0, _key: '', message: expect.stringMatching(/No alerts/) });
  });

  it('posts when the alert set changes and once when it clears; first quiet run is silent', async () => {
    let rows: PlanRow[] = [plan('ok')];
    const ctx = makeService();
    ctx.service.setPostSources({ 'burn-watch': async () => burnWatchData(rows) });
    const j = ctx.service.createJob(postInput({ postSource: 'burn-watch', postText: '{message}', postChangeOnly: true, scheduleType: 'interval', intervalMinutes: 60 }));
    const tick = async () => {
      const next = (ctx.service.getJob(j.id) as CronJob).nextRunAt as number;
      await ctx.service.tickDueJobs(next + 1000);
      await new Promise((r) => setTimeout(r, 20));
    };
    await tick();
    expect(ctx.posted).toHaveLength(0); // quiet baseline
    rows = [alerting('globex')];
    await tick();
    expect(ctx.posted).toHaveLength(1);
    await tick(); // same set
    expect(ctx.posted).toHaveLength(1);
    rows = [plan('ok')];
    await tick();
    expect(ctx.posted.map((p) => p.text.includes('No alerts'))).toEqual([false, true]);
    await tick();
    expect(ctx.posted).toHaveLength(2);
  });
});
