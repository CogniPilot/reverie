/**
 * Preview before Run once: what a run would do, with no run record, status, schedule, change key, post or broadcast.
 * Labels here are placeholders; real bots and rooms are instance data.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const grant = vi.hoisted(() => ({ value: true }));
vi.mock('../src/user-store.js', async (orig) => ({ ...(await orig<object>()), canUsernameRunPrivilegedCommands: async () => grant.value }));

import { CronService, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import type { ChatBot } from '../src/chat-bots.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';
import type { CronJobInput } from '../src/cron/cron-input.js';

const bot: ChatBot = { id: 'routines', name: 'Routines', rooms: ['room-1'], maxPerHour: 2 };

function postInput(over: Partial<CronJobInput> = {}): CronJobInput {
  return {
    name: 'schedule refresh', action: 'post', botId: 'routines', roomId: 'room-1',
    postText: 'refresh the schedule', scheduleType: 'daily', dailyTime: '06:45', timeZone: 'UTC', enabled: true,
    ...over,
  };
}

function makeService(sessions: Map<string, unknown> = new Map()) {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  const store = {
    getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
    getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
    removeCronJobRun: (id: string) => { delete runs[id]; },
  };
  const broadcast = vi.fn();
  const service = new CronService({ store, broadcast, sessions } as unknown as CronDeps);
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
  return { service, posted, runs, jobs, broadcast };
}

/** Everything a preview must leave alone. */
function untouched(f: ReturnType<typeof makeService>, act: () => Promise<unknown>) {
  return async () => {
    const before = JSON.stringify({ jobs: f.jobs, runs: f.runs });
    const calls = f.broadcast.mock.calls.length;
    const posts = f.posted.length;
    const result = await act();
    expect(JSON.stringify({ jobs: f.jobs, runs: f.runs })).toBe(before);
    expect(f.broadcast.mock.calls.length).toBe(calls);
    expect(f.posted.length).toBe(posts);
    return result;
  };
}

describe('run preview', () => {
  it('shows the message, sender, checks and effects of Run once, and Run once then posts exactly that', async () => {
    const f = makeService();
    const j = f.service.createJob(postInput({ postChangeOnly: true }));
    const preview = await untouched(f, () => f.service.preview(j.id))();
    expect(preview).toMatchObject({
      jobId: j.id, action: 'post', outcome: 'post', sender: 'Routines', roomId: 'room-1', text: 'refresh the schedule',
    });
    const p = preview as NonNullable<Awaited<ReturnType<CronService['preview']>>>;
    expect(p.checks).toEqual([{ label: 'Bot is registered', ok: true }, { label: 'Bot may post in this room now', ok: true }]);
    expect(p.effects).toEqual([
      'Posts one message as Routines in the room.', 'Records the run in history.',
      'Remembers this text, so the same text is not posted again.', 'Does not change the schedule or the next run time.',
    ]);
    const nextRunAt = f.service.getJob(j.id)?.nextRunAt;
    const run = await f.service.runNow(j.id);
    expect(run?.status).toBe('posted');
    expect(f.posted).toEqual([{ roomId: 'room-1', text: p.text }]);
    expect(f.service.getJob(j.id)?.nextRunAt).toBe(nextRunAt);
  });

  it('a dry-run routine says Run once records a dry run and posts nothing', async () => {
    const f = makeService();
    const j = f.service.createJob(postInput({ dryRun: true }));
    const p = await untouched(f, () => f.service.preview(j.id))();
    expect(p).toMatchObject({ outcome: 'dry-run', text: 'refresh the schedule' });
    expect((p as { effects: string[] }).effects[0]).toBe('Records a dry run in history; posts nothing.');
  });

  it('names the failing check for an unknown bot, a room off the allowlist and a used-up hourly cap', async () => {
    const f = makeService();
    const unknown = f.service.createJob(postInput({ botId: 'nobody' }));
    expect(await untouched(f, () => f.service.preview(unknown.id))()).toMatchObject({
      outcome: 'blocked', checks: [{ label: 'Bot is registered', ok: false, detail: 'No bot "nobody" is registered' }],
    });
    const off = f.service.createJob(postInput({ roomId: 'room-2' }));
    expect(await untouched(f, () => f.service.preview(off.id))()).toMatchObject({
      outcome: 'blocked', checks: [{ ok: true }, { label: 'Bot may post in this room now', ok: false, detail: 'not on the allowlist' }],
    });
    const capped = f.service.createJob(postInput({ name: 'capped' }));
    await f.service.runNow(capped.id);
    await f.service.runNow(capped.id);
    expect(await untouched(f, () => f.service.preview(capped.id))()).toMatchObject({
      outcome: 'blocked', checks: [{ ok: true }, { ok: false, detail: 'hourly cap' }],
    });
  });

  it('reads a data source once, shows the rendered text, and explains a skip without moving the change key', async () => {
    const f = makeService();
    let load = 5;
    const read = vi.fn(async () => ({ load15: load, cpus: 4 }));
    f.service.setPostSources({ 'host-load': read });
    const j = f.service.createJob(postInput({ postSource: 'host-load', postText: 'load {load15}', postWhen: { field: 'load15', op: 'gt', value: 4 } }));
    expect(await untouched(f, () => f.service.preview(j.id))()).toMatchObject({ outcome: 'post', text: 'load 5', readsSource: 'host-load' });
    expect(read).toHaveBeenCalledTimes(1);
    load = 2;
    expect(await untouched(f, () => f.service.preview(j.id))()).toMatchObject({
      outcome: 'skip', reason: 'Condition not met: load15 gt 4 (now 2)', readsSource: 'host-load',
    });
    f.service.setPostSources({ 'host-load': async () => { throw new Error('probe failed'); } });
    expect(await untouched(f, () => f.service.preview(j.id))()).toMatchObject({
      outcome: 'blocked', checks: [{ ok: true }, { label: 'Data source "host-load" reads', ok: false, detail: 'probe failed' }],
    });
  });

  it('an author routine without a poster, an agent job with a missing directory, and an unknown id', async () => {
    const f = makeService();
    // An author routine belongs to an employee; this service has no author poster, so a run would fail.
    const author = f.service.createJob(postInput({ postAs: 'author', botId: undefined }), undefined, { employeeId: 'e-alex' });
    expect(await untouched(f, () => f.service.preview(author.id))()).toMatchObject({
      outcome: 'blocked', sender: 'Routine author', checks: [{ label: 'Author can post', ok: false, detail: 'This routine has no author who can post' }],
    });
    // The directory existed when the job was made and is gone now.
    const dir = mkdtempSync(join(tmpdir(), 'cron-preview-'));
    const launch = f.service.createJob({
      name: 'nightly', agentType: 'shell', workingDir: dir, promptMode: 'inline_text', promptText: 'run the checks',
      scheduleType: 'daily', dailyTime: '02:00', timeZone: 'UTC', enabled: false,
    } as CronJobInput);
    rmSync(dir, { recursive: true });
    expect(await untouched(f, () => f.service.preview(launch.id))()).toMatchObject({
      action: 'launch', outcome: 'blocked', text: 'run the checks',
      checks: [{ label: 'Prompt resolves', ok: true }, { label: 'Working directory exists', ok: false }, { label: 'Other sessions of this agent', ok: true },
        { label: 'Session limit', ok: true }, { label: 'Owner grant for shell or launch-command jobs', ok: true }],
    });
    expect(await f.service.preview('missing')).toBeNull();
  });

  it('tells a data source it is a preview, so a source that logs real runs writes nothing', async () => {
    const f = makeService();
    const seen: unknown[] = [];
    f.service.setPostSources({ 'burn-watch': async (ctx) => { seen.push(ctx.preview); return { maxPct: 10, accounts: 1 }; } });
    const j = f.service.createJob(postInput({ postSource: 'burn-watch', postText: 'burn {maxPct}' }));
    await untouched(f, () => f.service.preview(j.id))();
    await f.service.runNow(j.id);
    expect(seen).toEqual([true, undefined]);
  });

  it('checks an author the way posting would, and says not verified when the server cannot check without posting', async () => {
    const f = makeService();
    const author = f.service.createJob(postInput({ postAs: 'author', botId: undefined }), undefined, { employeeId: 'e-alex' });
    const poster = { ...(f.service as unknown as { poster: BotPoster }).poster, postAsAuthor: () => ({ name: 'Alex' }) } as BotPoster;
    f.service.setBotPoster(poster);
    expect(await f.service.preview(author.id)).toMatchObject({
      outcome: 'blocked', checks: [{ label: 'Author can post', ok: false, detail: 'Not verified: this server cannot check the author without posting' }],
    });
    f.service.setBotPoster({ ...poster, canPostAsAuthor: () => { throw new Error('The author is no longer an employee'); } });
    expect(await untouched(f, () => f.service.preview(author.id))()).toMatchObject({
      outcome: 'blocked', checks: [{ label: 'Author can post', ok: false, detail: 'The author is no longer an employee' }],
    });
    f.service.setBotPoster({ ...poster, canPostAsAuthor: () => {} });
    expect(await f.service.preview(author.id)).toMatchObject({ outcome: 'post', checks: [{ label: 'Author can post', ok: true }, { ok: true }] });
  });

  it('says a session job would be refused at the session limit, unless closing its own earlier session frees room', async () => {
    const sessions = new Map(Array.from({ length: 50 }, (_, i) => [`s${i}`, { id: `s${i}` }]));
    const f = makeService(sessions);
    const dir = mkdtempSync(join(tmpdir(), 'cron-preview-'));
    try {
      const input = { name: 'nightly', agentType: 'shell', workingDir: dir, promptMode: 'inline_text', promptText: 'run the checks',
        scheduleType: 'daily', dailyTime: '02:00', timeZone: 'UTC', enabled: false } as CronJobInput;
      const keep = f.service.createJob({ ...input, autoClosePreviousSession: false } as CronJobInput);
      const p = await untouched(f, () => f.service.preview(keep.id))();
      expect(p).toMatchObject({ outcome: 'blocked' });
      expect((p as { checks: Array<{ label: string; ok: boolean; detail?: string }> }).checks.find((c) => c.label === 'Session limit')).toEqual({
        label: 'Session limit', ok: false, detail: 'Maximum concurrent sessions (50) reached',
      });
      const closing = f.service.createJob(input);
      expect(await f.service.preview(closing.id)).toMatchObject({ outcome: 'blocked' }); // nothing of its own to close
      f.runs.r1 = { id: 'r1', cronJobId: closing.id, sessionId: 's3', sessionName: null, startedAt: 1, finishedAt: 2,
        status: 'prompt_sent', triggerType: 'scheduled', createdSessionUrl: null };
      const freed = await f.service.preview(closing.id);
      expect(freed).toMatchObject({ outcome: 'launch' });
      expect((freed as { checks: Array<{ label: string; ok: boolean; detail?: string }> }).checks.find((c) => c.label === 'Session limit')).toMatchObject({
        label: 'Session limit', ok: true, detail: 'Maximum concurrent sessions (50) reached; Run once first closes 1 earlier session of this routine',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-checks the owner grant a shell job needs, as the launch does, and blocks when it is gone', async () => {
    const f = makeService();
    const dir = mkdtempSync(join(tmpdir(), 'cron-preview-'));
    try {
      const j = f.service.createJob({ name: 'nightly', agentType: 'shell', workingDir: dir, promptMode: 'inline_text', promptText: 'run the checks',
        scheduleType: 'daily', dailyTime: '02:00', timeZone: 'UTC', enabled: false } as CronJobInput);
      expect(await f.service.preview(j.id)).toMatchObject({ outcome: 'launch' });
      grant.value = false;
      const p = await untouched(f, () => f.service.preview(j.id))();
      expect(p).toMatchObject({ outcome: 'blocked' });
      expect((p as { checks: Array<{ label: string; ok: boolean; detail?: string }> }).checks.at(-1)).toEqual({
        label: 'Owner grant for shell or launch-command jobs', ok: false, detail: 'Owner lacks the can-bypass-permissions grant for shell/launchCommand jobs',
      });
    } finally {
      grant.value = true;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
