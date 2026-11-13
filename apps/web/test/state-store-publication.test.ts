import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { StateStore, StatePublicationUnconfirmedError } from '../src/state-store.js';
import { createInitialRalphSessionState } from '../src/types.js';
import type { CronJob } from '../src/types/cron.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});
const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const realAsync = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const owned: StateStore[] = [];
const sentinelFds: number[] = [];
beforeEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(real.renameSync);
  vi.mocked(fs.fsyncSync).mockImplementation(real.fsyncSync);
  vi.mocked(fs.closeSync).mockImplementation(real.closeSync);
  vi.mocked(asyncFs.rename).mockImplementation(realAsync.rename);
  vi.mocked(fs.unlinkSync).mockImplementation(real.unlinkSync);
  vi.mocked(asyncFs.unlink).mockImplementation(realAsync.unlink);
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.mocked(fs.renameSync).mockImplementation(real.renameSync);
  vi.mocked(fs.fsyncSync).mockImplementation(real.fsyncSync);
  vi.mocked(fs.closeSync).mockImplementation(real.closeSync);
  vi.mocked(asyncFs.rename).mockImplementation(realAsync.rename);
  vi.mocked(fs.unlinkSync).mockImplementation(real.unlinkSync);
  vi.mocked(asyncFs.unlink).mockImplementation(realAsync.unlink);
  for (const store of owned.splice(0)) if (!store.statePublicationHeld) await store.saveNowAsync();
  for (const fd of sentinelFds.splice(0)) real.closeSync(fd);
  vi.useRealTimers();
});

async function pending(file = join(fs.mkdtempSync(join(tmpdir(), 'publication-')), 'state.json')) {
  const store = new StateStore(file);
  owned.push(store);
  const job: CronJob = {
    id: 'watch', name: 'Synthetic watcher', agentType: 'shell', workingDir: '/synthetic',
    promptMode: 'inline_text', inputMode: 'paste', scheduleType: 'interval', intervalMinutes: 60,
    enabled: false, concurrencyPolicy: 'skip_if_same_agent_running', createdAt: 1, updatedAt: 1,
    lastRunAt: null, nextRunAt: null, lastStatus: null, lastDueKey: null,
    watchState: { generation: 'original', failures: 0, pending: { receipt: 'one', utc: 1, events: [] } },
  };
  await store.commitCronWatch(() => store.setCronJob(job.id, job));
  fs.writeFileSync(file + '.bak', fs.readFileSync(file));
  const acknowledge = () => {
    const current = store.getCronJob(job.id)!;
    current.postLastText = 'acknowledged cursor';
    current.watchState = { generation: 'original', failures: 0 };
    store.setCronJob(job.id, current);
  };
  return { file, store, acknowledge };
}

it.each(['rename-reply', 'directory-sync', 'directory-close'] as const)(
  'retains an uncertain acknowledged %s publication against every cached main-state writer', async (fault) => {
    const x = await pending();
    if (fault === 'rename-reply') vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      real.renameSync(from, to);
      throw new Error('synthetic lost rename reply');
    });
    if (fault === 'directory-sync') {
      let calls = 0;
      vi.mocked(fs.fsyncSync).mockImplementation(fd => {
        if (++calls === 2) throw new Error('synthetic directory sync error');
        real.fsyncSync(fd);
      });
    }
    if (fault === 'directory-close') {
      let calls = 0;
      vi.mocked(fs.closeSync).mockImplementation(fd => {
        real.closeSync(fd);
        if (++calls === 2) throw new Error('synthetic directory close error');
      });
    }
    const commit = x.store.commitCronWatch(x.acknowledge);
    const queued = x.store.saveNowAsync();
    await expect(commit).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    await expect(queued).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    expect(x.store.statePublicationHeld).toBe(true);
    expect(x.store.getCronJob('watch')?.watchState?.pending?.receipt).toBe('one');
    expect(x.store.getCronJob('watch')?.postLastText).toBeUndefined();
    const published = fs.readFileSync(x.file, 'utf8');
    expect(JSON.parse(published).cronJobs.watch.postLastText).toBe('acknowledged cursor');
    // Ordinary mutation, debounce, explicit flush, backup and circuit reset cannot replay old memory.
    x.store.setConfig({ maxConcurrentSessions: 7 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(x.store.saveNowAsync()).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    expect(() => x.store.saveNow()).toThrow(StatePublicationUnconfirmedError);
    expect(() => x.store.flush()).toThrow(StatePublicationUnconfirmedError);
    expect(x.store.recoverFromBackup()).toBe(false);
    expect(() => x.store.resetCircuitBreaker()).toThrow(StatePublicationUnconfirmedError);
    const beforeReset = x.store.getState();
    expect(() => x.store.reset()).toThrow(StatePublicationUnconfirmedError);
    expect(x.store.getState()).toBe(beforeReset);
    const mutate = vi.fn();
    await expect(x.store.commitCronWatch(mutate)).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    expect(mutate).not.toHaveBeenCalled();
    expect(fs.readFileSync(x.file, 'utf8')).toBe(published);
    expect(fs.readFileSync(x.file + '.bak', 'utf8')).not.toBe(published);
  }
);

it.each([1, 2])('never closes a consumed descriptor again after close %s reports an error', async (closeNumber) => {
  const x = await pending();
  let calls = 0;
  vi.mocked(fs.closeSync).mockImplementation(fd => {
    real.closeSync(fd);
    if (++calls === closeNumber) {
      const sentinel = real.openSync(x.file + '.sentinel', 'wx', 0o600);
      sentinelFds.push(sentinel);
      expect(sentinel).toBe(fd); // Physical fd reuse makes a second close observable.
      throw new Error('synthetic consuming close failure');
    }
  });
  await expect(x.store.commitCronWatch(x.acknowledge)).rejects.toThrow();
  expect(real.fstatSync(sentinelFds[0]).isFile()).toBe(true);
  expect(calls).toBe(closeNumber);
  expect(x.store.statePublicationHeld).toBe(closeNumber === 2);
});

it('a known pre-rename sync refusal retains pending evidence and allows a later checked commit', async () => {
  const x = await pending(), before = fs.readFileSync(x.file, 'utf8');
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('synthetic temp sync error'); });
  await expect(x.store.commitCronWatch(x.acknowledge)).rejects.toThrow('delivery held');
  expect(x.store.statePublicationHeld).toBe(false);
  expect(fs.readFileSync(x.file, 'utf8')).toBe(before);
  expect(x.store.getCronJob('watch')?.watchState?.pending?.receipt).toBe('one');
  await x.store.commitCronWatch(x.acknowledge);
  expect(new StateStore(x.file).getCronJob('watch')?.postLastText).toBe('acknowledged cursor');
});

it('a refused mutation does not acquire a publication fence or publish a new cursor', async () => {
  const x = await pending(), before = fs.readFileSync(x.file, 'utf8');
  const rename = vi.mocked(fs.renameSync).mock.calls.length;
  await expect(x.store.commitCronWatch(() => { x.acknowledge(); throw new Error('authority revoked'); })).rejects.toThrow();
  expect(x.store.statePublicationHeld).toBe(false);
  expect(fs.renameSync).toHaveBeenCalledTimes(rename);
  expect(fs.readFileSync(x.file, 'utf8')).toBe(before);
  await x.store.commitCronWatch(x.acknowledge);
});

it('retains both exact states when a first intent may have committed before its reply was lost', async () => {
  const x = await pending();
  const old = x.store.getCronJob('watch')!;
  delete old.watchState;
  x.store.setCronJob(old.id, old);
  await x.store.saveNowAsync();
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    real.renameSync(from, to); throw new Error('synthetic first intent reply loss');
  });
  const error = await x.store.commitCronWatch(() => {
    const job = x.store.getCronJob('watch')!;
    job.watchState = { generation: 'original', failures: 0,
      pending: { receipt: 'original-attempt', utc: 1, events: [] } };
    x.store.setCronJob(job.id, job);
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(StatePublicationUnconfirmedError);
  const cause = (error as StatePublicationUnconfirmedError).getPrivateEvidenceForReconciliation() as {
    watcherPublication: { before: string; attempted: string }; cleanupErrors: readonly unknown[];
  };
  expect(Object.isFrozen(cause)).toBe(true);
  expect(Object.isFrozen(cause.watcherPublication)).toBe(true);
  expect(inspect(error)).not.toContain('original-attempt');
  expect(JSON.stringify(error)).not.toContain('original-attempt');
  expect(JSON.parse(cause.watcherPublication.before).cronJobs.watch.watchState).toBeUndefined();
  expect(JSON.parse(cause.watcherPublication.attempted).cronJobs.watch.watchState.pending.receipt)
    .toBe('original-attempt');
  expect(x.store.statePublicationHeld).toBe(true);
  expect(JSON.parse(fs.readFileSync(x.file, 'utf8')).cronJobs.watch.watchState.pending.receipt)
    .toBe('original-attempt');
});

it('refuses reset before changing memory while an actual asynchronous writer owns a snapshot', async () => {
  const x = await pending();
  x.store.setConfig({ maxConcurrentSessions: 7 });
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
    entered(); await gate; await realAsync.rename(from, to);
  });
  const pendingWrite = x.store.saveNowAsync();
  await writing;
  const before = x.store.getState();
  try {
    expect(() => x.store.reset()).toThrow('in progress');
    expect(x.store.getState()).toBe(before);
  } finally { release(); await pendingWrite; }
  expect(x.store.statePublicationHeld).toBe(false);
  expect(new StateStore(x.file).getConfig().maxConcurrentSessions).toBe(7);
});

it.each(['sync', 'async'] as const)('fences an uncertain ordinary %s rename before a queued acknowledged intent', async mode => {
  const x = await pending();
  x.store.setConfig({ maxConcurrentSessions: 7 });
  let pendingWrite: Promise<void>;
  if (mode === 'sync') {
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      real.renameSync(from, to); throw new Error('synthetic ordinary sync reply loss');
    });
    expect(() => x.store.saveNow()).toThrow(StatePublicationUnconfirmedError);
    pendingWrite = Promise.resolve();
  } else {
    vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
      await realAsync.rename(from, to); throw new Error('synthetic ordinary async reply loss');
    });
    pendingWrite = x.store.saveNowAsync();
  }
  const mutate = vi.fn(x.acknowledge);
  const intent = x.store.commitCronWatch(mutate);
  if (mode === 'async') await expect(pendingWrite).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
  await expect(intent).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
  expect(mutate).not.toHaveBeenCalled();
  expect(x.store.statePublicationHeld).toBe(true);
});

it.each(['sync', 'async'] as const)('retains ordinary %s primary and cleanup failures together', async mode => {
  const x = await pending();
  x.store.setConfig({ maxConcurrentSessions: 7 });
  const primary = new Error('synthetic rename uncertainty');
  const cleanup = new Error('synthetic unlink failure');
  let failure: unknown;
  if (mode === 'sync') {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw primary; });
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw cleanup; });
    try { x.store.saveNow(); } catch (error) { failure = error; }
  } else {
    vi.mocked(asyncFs.rename).mockRejectedValueOnce(primary);
    vi.mocked(asyncFs.unlink).mockRejectedValueOnce(cleanup);
    failure = await x.store.saveNowAsync().catch((error: unknown) => error);
  }
  expect(failure).toBeInstanceOf(StatePublicationUnconfirmedError);
  expect((failure as StatePublicationUnconfirmedError).getPrivateEvidenceForReconciliation())
    .toEqual({ error: primary, cleanupError: cleanup });
});

it.each(['state', 'parent.json/state', 'state.json'])(
  'inner-state flush cannot overwrite a fenced main file at %s', async name => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'publication-inner-'));
    const file = join(directory, name);
    const x = await pending(file);
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      real.renameSync(from, to); throw new Error('synthetic main publication reply loss');
    });
    await expect(x.store.commitCronWatch(x.acknowledge)).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    const published = fs.readFileSync(file, 'utf8');
    x.store.setRalphState('synthetic-inner', createInitialRalphSessionState('synthetic-inner'));
    x.store.flushAll();
    expect(fs.readFileSync(file, 'utf8')).toBe(published);
    const innerFile = file.endsWith('.json') ? file.slice(0, -5) + '-inner.json' : file + '-inner.json';
    expect(JSON.parse(fs.readFileSync(innerFile, 'utf8'))['synthetic-inner'].sessionId).toBe('synthetic-inner');
    const restored = new StateStore(file);
    expect(restored.getCronJob('watch')?.postLastText).toBe('acknowledged cursor');
    expect(restored.getRalphState('synthetic-inner')?.sessionId).toBe('synthetic-inner');
  }
);

it('keeps ordinary main and inner state distinct for an extensionless custom state file', () => {
  const file = join(fs.mkdtempSync(join(tmpdir(), 'publication-distinct-')), 'state');
  const store = new StateStore(file);
  owned.push(store);
  store.setConfig({ maxConcurrentSessions: 7 });
  store.setRalphState('synthetic-inner', createInitialRalphSessionState('synthetic-inner'));
  store.flushAll();
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).config?.maxConcurrentSessions).toBe(7);
  expect(JSON.parse(fs.readFileSync(file + '-inner.json', 'utf8'))['synthetic-inner'].sessionId)
    .toBe('synthetic-inner');
});

it('notifies a fixed hold once after installing its fence and isolates subscriber failures', async () => {
  const x = await pending();
  expect(x.store.getStatePublicationStatus()).toEqual({ version: 1, kind: 'no-hold-observed' });
  const removed = vi.fn();
  const remove = x.store.onStatePublicationHold(removed);
  remove();
  remove();
  const observations: Array<{ held: boolean; frozen: boolean }> = [];
  const observed = vi.fn((status) => {
    observations.push({ held: x.store.statePublicationHeld, frozen: Object.isFrozen(status) });
  });
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  const secret = 'PRIVATE_SUBSCRIBER_AND_STATE_EVIDENCE';
  x.store.onStatePublicationHold(() => {
    throw new Error(secret);
  });
  x.store.onStatePublicationHold(async () => {
    throw new Error(secret);
  });
  const unsubscribe = x.store.onStatePublicationHold(observed);
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    real.renameSync(from, to);
    throw new Error(secret);
  });
  const failure = await x.store.commitCronWatch(x.acknowledge).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(StatePublicationUnconfirmedError);
  expect(observed).toHaveBeenCalledExactlyOnceWith({ version: 1, kind: 'unconfirmed' });
  expect(observations).toEqual([{ held: true, frozen: true }]);
  expect(removed).not.toHaveBeenCalled();
  expect(x.store.getStatePublicationStatus()).toEqual({ version: 1, kind: 'unconfirmed' });
  await expect(x.store.saveNowAsync()).rejects.toBe(failure);
  expect(observed).toHaveBeenCalledOnce();
  expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
  expect(inspect(failure)).not.toContain(secret);
  unsubscribe();
  unsubscribe();
  logs.mockRestore();
});


it('retains the original publication error and still notifies when its first diagnostic logger throws', async () => {
  const x = await pending();
  const publicationFailure = new Error('PRIVATE_ORIGINAL_PUBLICATION');
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('PRIVATE_LOGGER_FAILURE');
  });
  const observed = vi.fn();
  x.store.onStatePublicationHold(() => {
    throw new Error('PRIVATE_OBSERVER_FAILURE');
  });
  x.store.onStatePublicationHold(observed);
  try {
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      real.renameSync(from, to);
      throw publicationFailure;
    });
    const failure: unknown = await x.store.commitCronWatch(x.acknowledge).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StatePublicationUnconfirmedError);
    if (!(failure instanceof StatePublicationUnconfirmedError))
      throw new Error('Original publication error was replaced');
    expect(failure.getPrivateEvidenceForReconciliation()).toMatchObject({ error: publicationFailure });
    expect(x.store.statePublicationHeld).toBe(true);
    expect(observed).toHaveBeenCalledExactlyOnceWith({ version: 1, kind: 'unconfirmed' });
    await expect(x.store.saveNowAsync()).rejects.toBe(failure);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_');
    expect(inspect(failure)).not.toContain('PRIVATE_');
  } finally {
    logger.mockRestore();
  }
});
