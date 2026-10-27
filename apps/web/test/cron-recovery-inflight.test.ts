import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';
import { CronService, type CronDeps, type BotPoster } from '../src/cron/cron-service.js';
import { readFixedPr } from '../src/cron/fixed-github-watch.js';
import type { Fetcher } from '../src/cron/github-source.js';
import type { CronJobInput } from '../src/cron/cron-input.js';
import { Session } from '../src/session.js';
afterEach(() => vi.restoreAllMocks());

const head = 'a'.repeat(40);
const target = { owner: 'Example', repo: 'public', pull: 7 };
const reader =
  (checks: number): Fetcher =>
  async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes('/reviews?')
        ? []
        : url.includes('/check-runs?')
          ? {
              total_count: checks,
              check_runs: Array.from({ length: checks }, (_, i) => ({
                id: i + 1,
                head_sha: head,
                name: `check-${i}`,
                status: 'completed',
                conclusion: 'success',
              })),
            }
          : url.includes('/actions/runs?')
            ? { total_count: 0, workflow_runs: [] }
            : {
                number: 7,
                base: { repo: { private: false, full_name: 'Example/public' } },
                head: { sha: head },
                updated_at: '2026-10-24T01:00:00Z',
                state: 'open',
                merged: false,
                title: 'Public PR',
              },
  });
describe('independent deployment-sized and explicit recovery witnesses', () => {
  it('accepts and completely accounts a complete initial PR snapshot with 40 checks', async () => {
    const snapshot = await readFixedPr(target, undefined, reader(40));
    expect(snapshot.events).toHaveLength(41);
    expect(new Set(snapshot.events.map((event) => event.dedupe_key)).size).toBe(41);
  });
  it('explicit backup recovery removes the epoch and refuses duplicate delivery', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'watcher-review-')), 'state.json');
    const store = new StateStore(file);
    const service = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
    const posts: string[] = [];
    const bot = { id: 'watch', name: 'Watch', rooms: ['room'], maxPerHour: 100 };
    service.setBotPoster({
      getBot: () => bot,
      check: vi.fn(),
      post: vi.fn(),
      postWatchNotice: (_bot, _room, text) => {
        posts.push(text);
        return { messageId: `message-${posts.length}` };
      },
    } as BotPoster);
    service.setPostSources({
      github: async ({ args, last }) => ({
        _watchSnapshot: JSON.stringify(await readFixedPr(args, last, reader(0))),
      }),
    });
    const input: CronJobInput = {
      name: 'reviewer watcher',
      action: 'post',
      postSource: 'github',
      postSourceArgs: target,
      postText: '{message}',
      postChangeOnly: true,
      botId: 'watch',
      roomId: 'room',
      scheduleType: 'interval',
      intervalMinutes: 60,
      enabled: true,
    };
    const job = service.createJob(input, undefined, undefined, true);
    const oldState = JSON.stringify(store.getState());
    expect((await service.runNow(job.id))?.status).toBe('posted');
    expect(posts).toHaveLength(1);
    writeFileSync(file + '.bak', oldState);
    expect(store.recoverFromBackup()).toBe(true);
    expect(service.getJob(job.id)?.watchGeneration).toBeUndefined();
    await expect(service.runNow(job.id)).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(posts).toHaveLength(1);
    service.setEnabled(job.id, false);
    await store.saveNowAsync();
  });
  it('stops cleanup of further sessions when backup restoration happens during the first cleanup await', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watcher-cleanup-review-'));
    const file = join(directory, 'state.json');
    const store = new StateStore(file);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closed: string[] = [];
    const service = new CronService({
      store,
      broadcast: vi.fn(),
      sessions: new Map([
        ['one', {}],
        ['two', {}],
      ]),
      cleanupSession: async (id: string) => {
        closed.push(id);
        if (closed.length === 1) await blocked;
      },
    } as unknown as CronDeps);
    const job = service.createJob({
      name: 'reviewer launch',
      action: 'launch',
      agentType: 'shell',
      workingDir: directory,
      promptMode: 'inline_text',
      promptText: 'never submit',
      inputMode: 'paste',
      scheduleType: 'interval',
      intervalMinutes: 60,
      enabled: true,
    });
    for (const id of ['one', 'two'])
      store.setCronJobRun(id, {
        id,
        cronJobId: job.id,
        sessionId: id,
        sessionName: id,
        startedAt: 1,
        finishedAt: 2,
        status: 'completed',
        triggerType: 'scheduled',
        createdSessionUrl: null,
      } as never);
    await store.saveNowAsync();
    writeFileSync(file + '.bak', JSON.stringify(store.getState()));
    const pending = (
      service as unknown as { closePreviousRunSessions: (job: unknown, run: string) => Promise<void> }
    ).closePreviousRunSessions(job, 'new-run');
    expect(closed).toHaveLength(1);
    expect(store.recoverFromBackup()).toBe(true);
    release();
    await expect(pending).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(service.getJob(job.id)?.recoveryUncertain).toBe(true);
    expect(closed).toHaveLength(1);
    await store.saveNowAsync();
  });
});

describe('adjacent in-flight session effects use current job state', () => {
  it.each(['add', 'persist', 'listeners', 'missing'] as const)(
    'stops after%s before subsequent persistence/listener/start effects',
    async (step) => {
      const directory = mkdtempSync(join(tmpdir(), 'cron-session-fence-'));
      const file = join(directory, 'state.json');
      const store = new StateStore(file);
      const effects: string[] = [];
      // Even a regression cannot start a real engine/model in this fixture.
      const start = vi
        .spyOn(Session.prototype, 'startShell')
        .mockRejectedValue(new Error('synthetic start must never run'));
      vi.spyOn(Session.prototype, 'startInteractive').mockRejectedValue(new Error('synthetic start must never run'));
      let id: string;
      const recover = () => expect(store.recoverFromBackup()).toBe(true);
      const increment = store.incrementSessionsCreated.bind(store);
      vi.spyOn(store, 'incrementSessionsCreated').mockImplementation(() => {
        effects.push('increment');
        increment();
      });
      const service = new CronService({
        store,
        sessions: new Map(),
        broadcast: vi.fn(),
        addSession: async () => {
          effects.push('add');
          if (step === 'add') recover();
          if (step === 'missing') store.removeCronJob(id);
        },
        persistSessionState: () => {
          effects.push('persist');
          if (step === 'persist') recover();
        },
        setupSessionListeners: async () => {
          effects.push('listeners');
          if (step === 'listeners') recover();
        },
        getGlobalNiceConfig: async () => undefined,
        getModelConfig: async () => null,
        getClaudeModeConfig: async () => ({}),
        mux: { backend: 'tmux' },
      } as unknown as CronDeps);
      const job = service.createJob({
        name: 'unstarted synthetic session',
        action: 'launch',
        agentType: 'shell',
        workingDir: directory,
        promptMode: 'inline_text',
        promptText: 'never execute',
        inputMode: 'paste',
        scheduleType: 'once',
        runAt: Date.now() + 60_000,
        enabled: false,
      });
      id = job.id;
      await store.saveNowAsync();
      writeFileSync(file + '.bak', JSON.stringify(store.getState()));
      try {
        const run = await service.runNow(id);
        expect(run?.status).toBe('failed');
        expect(run?.errorMessage).toContain('RECOVERY_UNCERTAIN');
        expect(effects).toEqual(
          step === 'add' || step === 'missing'
            ? ['add']
            : step === 'persist'
              ? ['add', 'increment', 'persist']
              : ['add', 'increment', 'persist', 'listeners']
        );
        expect(start).not.toHaveBeenCalled();
      } finally {
        await store.saveNowAsync();
      }
    }
  );
  it('missing current job during cleanup cannot authorize the next session effect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cron-missing-fence-'));
    const store = new StateStore(join(directory, 'state.json'));
    const closed: string[] = [];
    let id: string;
    const service = new CronService({
      store,
      broadcast: vi.fn(),
      sessions: new Map([
        ['one', {}],
        ['two', {}],
      ]),
      cleanupSession: async (session: string) => {
        closed.push(session);
        store.removeCronJob(id);
      },
    } as unknown as CronDeps);
    const job = service.createJob({
      name: 'synthetic cleanup',
      action: 'launch',
      agentType: 'shell',
      workingDir: directory,
      promptMode: 'inline_text',
      promptText: 'never execute',
      inputMode: 'paste',
      scheduleType: 'interval',
      intervalMinutes: 60,
      enabled: false,
    });
    id = job.id;
    for (const session of ['one', 'two'])
      store.setCronJobRun(session, { id: session, cronJobId: id, sessionId: session, startedAt: 1 } as never);
    const cleanup = (
      service as unknown as { closePreviousRunSessions(job: unknown, run: string): Promise<void> }
    ).closePreviousRunSessions(job, 'new');
    await expect(cleanup).rejects.toThrow('RECOVERY_UNCERTAIN');
    expect(closed).toHaveLength(1);
    await store.saveNowAsync();
  });
  it('a normal cleanup error still permits the next cleanup when the job remains current/certain', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cron-certain-cleanup-'));
    const store = new StateStore(join(directory, 'state.json'));
    const closed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new CronService({
      store,
      broadcast: vi.fn(),
      sessions: new Map([
        ['one', {}],
        ['two', {}],
      ]),
      cleanupSession: async (session: string) => {
        closed.push(session);
        if (session === 'one') throw new Error('synthetic cleanup error');
      },
    } as unknown as CronDeps);
    const job = service.createJob({
      name: 'synthetic cleanup',
      action: 'launch',
      agentType: 'shell',
      workingDir: directory,
      promptMode: 'inline_text',
      promptText: 'never execute',
      inputMode: 'paste',
      scheduleType: 'interval',
      intervalMinutes: 60,
      enabled: false,
    });
    for (const session of ['one', 'two'])
      store.setCronJobRun(session, { id: session, cronJobId: job.id, sessionId: session, startedAt: 1 } as never);
    await (
      service as unknown as { closePreviousRunSessions(job: unknown, run: string): Promise<void> }
    ).closePreviousRunSessions(job, 'new');
    expect(closed).toEqual(['one', 'two']);
    await store.saveNowAsync();
  });
});
