import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';
import { CronService, type CronDeps, type BotPoster } from '../src/cron/cron-service.js';
import { CronJobSchema } from '../src/web/schemas.js';
import type { CronJobInput } from '../src/cron/cron-input.js';
import { readFixedPr } from '../src/cron/fixed-github-watch.js';
import type { Fetcher } from '../src/cron/github-source.js';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const input = (): CronJobInput => ({
  name: 'public PR notice',
  action: 'post',
  postSource: 'github',
  postSourceArgs: { owner: 'Example', repo: 'public', pull: 7 },
  postText: '{message}',
  postChangeOnly: true,
  botId: 'watch',
  roomId: 'room',
  scheduleType: 'interval',
  intervalMinutes: 60,
  enabled: true,
});
const head = 'a'.repeat(40);
const fixture: Fetcher = async (url) => ({
  ok: true,
  status: 200,
  json: async () =>
    url.includes('/reviews?')
      ? []
      : url.includes('/check-runs?')
        ? { total_count: 0, check_runs: [] }
        : url.includes('/actions/runs?')
          ? { total_count: 0, workflow_runs: [] }
          : {
              number: 7,
              base: { repo: { private: false, full_name: 'Example/public' } },
              head: { sha: head },
              updated_at: '2026-10-24T01:00:00Z',
              state: 'open',
              merged: false,
              title: 'safe public title',
            },
});
const stores: StateStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) await s.saveNowAsync();
});
function setup(file = join(mkdtempSync(join(tmpdir(), 'watch-fixture-')), 'state.json')) {
  const store = new StateStore(file);
  stores.push(store);
  const service = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
  const posts: string[] = [];
  const bot = { id: 'watch', name: 'Watch', rooms: ['room'], maxPerHour: 100 };
  const poster: BotPoster = {
    getBot: () => bot,
    check: vi.fn(),
    post: () => {
      throw new Error('ordinary delivery must never run');
    },
    postWatchNotice: (_bot, _room, text) => {
      posts.push(text);
      return { messageId: 'message-1' };
    },
  };
  service.setBotPoster(poster);
  service.setPostSources({
    github: async ({ args, last }) => {
      const snapshot = await readFixedPr(args, last, fixture);
      return { _watchSnapshot: JSON.stringify(snapshot) };
    },
  });
  return { file, store, service, posts, poster };
}
describe('fixed watcher actual state/delivery integration', () => {
  function fortyChecks(x: ReturnType<typeof setup>, completed: () => boolean): void {
    const forty: Fetcher = async (url, init) => {
      if (!url.includes('/check-runs?')) return fixture(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 40,
          check_runs: Array.from({ length: 40 }, (_, i) => ({
            id: i + 1,
            head_sha: head,
            name: `public check ${i + 1}`,
            status: completed() ? 'completed' : 'queued',
            conclusion: completed() ? 'success' : null,
          })),
        }),
      };
    };
    x.service.setPostSources({
      github: async ({ args, last }) => ({ _watchSnapshot: JSON.stringify(await readFixedPr(args, last, forty)) }),
    });
  }
  it('delivers every event of the 40-check baseline and mass completion, and deduplicates both after restart', async () => {
    const first = setup();
    const job = first.service.createJob(input(), undefined, undefined, true);
    let completed = false;
    fortyChecks(first, () => completed);
    expect((await first.service.runNow(job.id))?.status).toBe('posted');
    expect(first.posts).toHaveLength(1);
    expect(first.service.getJob(job.id)?.watchState?.delivery?.events).toHaveLength(41);
    const initialCursor = JSON.parse(first.service.getJob(job.id)!.postLastText!);
    expect(initialCursor.events).toHaveLength(41);
    await first.store.saveNowAsync();
    const restart = setup(first.file);
    fortyChecks(restart, () => completed);
    expect((await restart.service.runNow(job.id))?.status).toBe('skipped');
    expect(restart.posts).toEqual([]);
    completed = true;
    expect((await restart.service.runNow(job.id))?.status).toBe('posted');
    expect(restart.posts).toHaveLength(1);
    expect(restart.service.getJob(job.id)?.watchState?.delivery?.events).toHaveLength(40);
    expect(JSON.parse(restart.service.getJob(job.id)!.postLastText!).events).toHaveLength(81);
    await restart.store.saveNowAsync();
    const again = setup(first.file);
    fortyChecks(again, () => completed);
    expect((await again.service.runNow(job.id))?.status).toBe('skipped');
    expect(again.posts).toEqual([]);
  });
  it('never silently seeds the 40-check baseline on failed delivery, including restart', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    fortyChecks(x, () => false);
    x.poster.postWatchNotice = () => {
      throw new Error('synthetic ambiguous post');
    };
    expect((await x.service.runNow(job.id))?.status).toBe('failed');
    expect(x.service.getJob(job.id)?.postLastText).toBeUndefined();
    expect(x.service.getJob(job.id)?.watchState?.pending?.events).toHaveLength(41);
    const restart = setup(x.file);
    fortyChecks(restart, () => true);
    await restart.service.runNow(job.id);
    expect(restart.posts).toEqual([]);
    expect(restart.service.getJob(job.id)?.postLastText).toBeUndefined();
  });
  it('explicit pre-delivery backup recovery preserves newer receipt but fences every mutation and duplicate post', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    const beforeDelivery = JSON.stringify(x.store.getState());
    await x.service.runNow(job.id);
    expect(x.posts).toHaveLength(1);
    const delivered = x.service.getJob(job.id)!.watchState!.delivery;
    writeFileSync(x.file + '.bak', beforeDelivery);
    expect(x.store.recoverFromBackup()).toBe(true);
    expect(x.service.getJob(job.id)?.enabled).toBe(false);
    expect(x.service.getJob(job.id)?.watchGeneration).toBeUndefined();
    expect(x.service.getJob(job.id)?.watchState?.delivery).toEqual(delivered);
    await expect(x.service.runNow(job.id)).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(x.posts).toHaveLength(1);
    expect(() => x.service.updateJob(job.id, { name: 'restore epoch' })).toThrow();
    expect(() => x.service.setEnabled(job.id, true)).toThrow();
    expect(() => x.service.deleteJob(job.id)).toThrow();
    x.service.setEnabled(job.id, false);
    await x.store.saveNowAsync();
    const restart = setup(x.file);
    await expect(restart.service.runNow(job.id)).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(restart.posts).toEqual([]);
  });
  it('backup predating the job cannot erase its retained pending uncertainty or run evidence', async () => {
    const x = setup();
    const emptyBackup = JSON.stringify(x.store.getState());
    const job = x.service.createJob(input(), undefined, undefined, true);
    x.poster.postWatchNotice = () => {
      throw new Error('synthetic ambiguous post');
    };
    const failed = await x.service.runNow(job.id);
    const pending = x.service.getJob(job.id)!.watchState!.pending;
    writeFileSync(x.file + '.bak', emptyBackup);
    expect(x.store.recoverFromBackup()).toBe(true);
    expect(x.service.getJob(job.id)?.watchState?.pending).toEqual(pending);
    expect(x.service.listRuns(job.id).some((run) => run.id === failed!.id)).toBe(true);
    expect(x.service.getJob(job.id)?.watchGeneration).toBeUndefined();
    expect(() => x.service.updateJob(job.id, { name: 'erase fence' })).toThrow();
    expect(() => x.service.setEnabled(job.id, true)).toThrow();
    expect(() => x.service.deleteJob(job.id)).toThrow();
    await x.store.saveNowAsync();
    const restart = setup(x.file);
    await expect(restart.service.runNow(job.id)).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(restart.posts).toEqual([]);
    expect(restart.service.getJob(job.id)?.watchState?.pending).toEqual(pending);
  });
  it('explicit recovery fences an already-started metadata read before it can deliver', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    writeFileSync(x.file + '.bak', JSON.stringify(x.store.getState()));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    x.service.setPostSources({
      github: async ({ args, last }) => {
        await blocked;
        return { _watchSnapshot: JSON.stringify(await readFixedPr(args, last, fixture)) };
      },
    });
    const running = x.service.runNow(job.id);
    expect(x.store.recoverFromBackup()).toBe(true);
    release();
    await running;
    expect(x.posts).toEqual([]);
    expect(x.service.getJob(job.id)?.watchGeneration).toBeUndefined();
  });
  it('refuses recovery during an actual old asynchronous save, then restores only fenced state through the writer', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    writeFileSync(x.file + '.bak', JSON.stringify(x.store.getState()));
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writing = new Promise<void>((r) => {
      entered = r;
    });
    vi.mocked(asyncFs.writeFile).mockImplementation(async (...args: Parameters<typeof asyncFs.writeFile>) => {
      entered();
      await gate;
      return original(...args);
    });
    const oldSave = x.store.saveNowAsync();
    expect(x.store.recoverFromBackup()).toBe(false); // queued, before its first I/O starts
    await writing;
    expect(x.store.recoverFromBackup()).toBe(false);
    expect(x.service.getJob(job.id)?.watchGeneration).toBe(job.watchGeneration);
    release();
    await oldSave;
    vi.mocked(asyncFs.writeFile).mockImplementation(original);
    expect(x.store.recoverFromBackup()).toBe(true);
    await x.store.saveNowAsync();
    const restart = setup(x.file);
    expect(restart.service.getJob(job.id)?.watchGeneration).toBeUndefined();
    await expect(restart.service.runNow(job.id)).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(restart.posts).toEqual([]);
  });
  it('requires verified owner configuration and refuses second job including case variants/disabled jobs', () => {
    const x = setup();
    expect(() => x.service.createJob(input())).toThrow('verified owner');
    expect(() => x.service.createJob(input(), undefined, { employeeId: 'worker' }, true)).toThrow();
    x.service.createJob({ ...input(), enabled: false }, undefined, undefined, true);
    expect(() =>
      x.service.createJob(
        { ...input(), postSourceArgs: { owner: 'example', repo: 'PUBLIC', pull: 7 } },
        undefined,
        undefined,
        true
      )
    ).toThrow('one fixed');
    const restart = setup(x.file);
    // In-memory duplicate rejection is complemented by persisted/reloaded control below.
    expect(restart.posts).toEqual([]);
  });
  it('schema rejects conditions, arbitrary template, kinds, too-fast poll and author branch', () => {
    expect(CronJobSchema.safeParse(input()).success).toBe(true);
    for (const over of [
      { postText: '@someone {message}' },
      { postWhen: { field: 'items', op: 'gt', value: 0 } },
      { postAs: 'author' },
      { intervalMinutes: 1 },
      { postSourceArgs: { owner: 'Example', repo: 'public', pull: 7, kinds: ['pulls'] } },
    ])
      expect(CronJobSchema.safeParse({ ...input(), ...over }).success).toBe(false);
  });
  it('persists intent before posting and acknowledged receipts/cursor after posting; restart does not duplicate', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    const post = x.poster.postWatchNotice!;
    x.poster.postWatchNotice = (...args) => {
      const disk = new StateStore(x.file).getCronJob(job.id)!;
      expect(disk.watchState?.pending?.events).toHaveLength(1);
      expect(disk.postLastText).toBeUndefined();
      return post(...args);
    };
    expect((await x.service.runNow(job.id))?.status).toBe('posted');
    expect(x.posts).toHaveLength(1);
    const disk = new StateStore(x.file).getCronJob(job.id)!;
    expect(disk.watchState?.pending).toBeUndefined();
    expect(disk.watchState?.delivery?.result).toBe('DELIVERED');
    expect(disk.watchState?.delivery?.events[0]?.target_id).toBe('example/public#7');
    expect(disk.postLastText).toBeTruthy();
    const restart = setup(x.file);
    expect((await restart.service.runNow(job.id))?.status).toBe('skipped');
    expect(restart.posts).toEqual([]);
    expect(() => restart.service.createJob(input(), undefined, undefined, true)).toThrow();
  });
  it('holds ambiguous failed post across restart and refuses edits/delete that erase its fence', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    x.poster.postWatchNotice = () => {
      throw new Error('secret token error must not leak');
    };
    const failed = await x.service.runNow(job.id);
    expect(failed?.errorMessage).toContain('WATCH_DELIVERY_UNCERTAIN');
    expect(failed?.errorMessage).not.toContain('secret');
    expect(x.service.getJob(job.id)?.postLastText).toBeUndefined();
    const restart = setup(x.file);
    expect((await restart.service.runNow(job.id))?.status).toBe('failed');
    expect(restart.posts).toEqual([]);
    expect(() => restart.service.updateJob(job.id, { name: 'reset' })).toThrow('reconciliation');
    expect(() => restart.service.deleteJob(job.id)).toThrow('reconciliation');
    expect(restart.service.setEnabled(job.id, false)?.enabled).toBe(false);
  });
  it('a lost post acknowledgement commit keeps durable pending fence and does not resend on restart', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    const real = x.store.commitCronWatch.bind(x.store);
    let calls = 0;
    vi.spyOn(x.store, 'commitCronWatch').mockImplementation(async (fn) => {
      if (++calls >= 2) throw new Error('disk failure');
      return real(fn);
    });
    expect((await x.service.runNow(job.id))?.status).toBe('failed');
    expect(x.posts).toHaveLength(1);
    const restart = setup(x.file);
    expect(restart.service.getJob(job.id)?.postLastText).toBeUndefined();
    expect((await restart.service.runNow(job.id))?.status).toBe('failed');
    expect(restart.posts).toEqual([]);
  });
  it('actual receipt fsync failure rolls back the in-memory cursor before ordinary saves and restart', async () => {
    const x = setup();
    const unrelatedConfig = x.store.getState().config;
    const job = x.service.createJob(input(), undefined, undefined, true);
    const real = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
    let calls = 0;
    vi.mocked(syncFs.fsyncSync).mockImplementation((fd) => {
      if (++calls === 3) throw new Error('synthetic ack fsync failure');
      real(fd);
    });
    expect((await x.service.runNow(job.id))?.status).toBe('failed');
    expect(x.posts).toHaveLength(1);
    await x.store.saveNowAsync();
    expect(x.service.getJob(job.id)?.postLastText).toBeUndefined();
    expect(x.store.getState().config).toBe(unrelatedConfig);
    const restart = setup(x.file);
    expect(restart.service.getJob(job.id)?.watchState?.pending).toBeTruthy();
    await restart.service.runNow(job.id);
    expect(restart.posts).toEqual([]);
    vi.mocked(syncFs.fsyncSync).mockImplementation(real);
  });
  it('caps pre-effect query retries at three; errors contain no external/private strings', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    let calls = 0;
    x.service.setPostSources({
      github: async () => {
        calls++;
        throw new Error('PRIVATE response body @person token');
      },
    });
    for (let n = 0; n < 5; n++)
      expect((await x.service.runNow(job.id))?.errorMessage).not.toMatch(/PRIVATE|@person|token/);
    expect(calls).toBe(3);
    expect(x.posts).toEqual([]);
    expect(x.service.getJob(job.id)?.postLastText).toBeUndefined();
  });
  it('serializes overlapping polls and fences disabling while metadata read awaits', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    x.service.setPostSources({
      github: async () => {
        await blocked;
        return { _watchSnapshot: JSON.stringify(await readFixedPr(input().postSourceArgs, undefined, fixture)) };
      },
    });
    const first = x.service.runNow(job.id);
    expect(await x.service.runNow(job.id)).toBeNull();
    x.service.setEnabled(job.id, false);
    release();
    await first;
    expect(x.posts).toEqual([]);
  });
  it('refuses persisted duplicate jobs even if manually loaded, and generationless backup recovery', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    x.store.setCronJob('duplicate', { ...job, id: 'duplicate' });
    await x.store.saveNowAsync();
    const restart = setup(x.file);
    await restart.service.runNow(job.id);
    expect(restart.posts).toEqual([]);
    writeFileSync(x.file + '.bak', readFileSync(x.file));
    writeFileSync(x.file, 'corrupt');
    const recovered = setup(x.file);
    expect(recovered.service.getJob(job.id)?.watchGeneration).toBeUndefined();
    await expect(recovered.service.runNow(job.id)).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(recovered.posts).toEqual([]);
  });
  it('dry run has no delivery, intent or cursor mutation', async () => {
    const x = setup();
    const job = x.service.createJob({ ...input(), dryRun: true }, undefined, undefined, true);
    expect((await x.service.runNow(job.id))?.status).toBe('skipped');
    expect(x.posts).toEqual([]);
    expect(job.watchState).toBeUndefined();
    expect(job.postLastText).toBeUndefined();
  });
  it('case-only configuration edits preserve dedup cursor; backup fences cannot be edited or re-enabled', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    await x.service.runNow(job.id);
    const oldCursor = x.service.getJob(job.id)!.postLastText;
    x.service.updateJob(job.id, { postSourceArgs: { owner: 'example', repo: 'PUBLIC', pull: 7 } });
    expect(x.service.getJob(job.id)!.postLastText).toBe(oldCursor);
    expect((await x.service.runNow(job.id))?.status).toBe('skipped');
    expect(x.posts).toHaveLength(1);
    writeFileSync(x.file + '.bak', readFileSync(x.file));
    writeFileSync(x.file, 'corrupt');
    const recovered = setup(x.file);
    expect(() => recovered.service.updateJob(job.id, { name: 'cosmetic' })).toThrow();
    recovered.service.setEnabled(job.id, false);
    expect(() => recovered.service.setEnabled(job.id, true)).toThrow();
  });
  it('queues durable intent after an actual old asynchronous save, and synchronous save cannot overtake it', async () => {
    const x = setup();
    const job = x.service.createJob(input(), undefined, undefined, true);
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writing = new Promise<void>((r) => {
      entered = r;
    });
    vi.mocked(asyncFs.writeFile).mockImplementation(async (...args: Parameters<typeof asyncFs.writeFile>) => {
      entered();
      await gate;
      return original(...args);
    });
    const oldSave = x.store.saveNowAsync();
    await writing;
    const intent = x.store.commitCronWatch(() => {
      job.watchState = {
        generation: job.watchGeneration!,
        failures: 0,
        pending: { receipt: 'receipt', utc: Date.now(), events: [] },
      };
      x.store.setCronJob(job.id, job);
    });
    x.store.saveNow();
    release();
    await Promise.all([oldSave, intent]);
    await x.store.saveNowAsync();
    expect(new StateStore(x.file).getCronJob(job.id)?.watchState?.pending?.receipt).toBe('receipt');
  });
});
