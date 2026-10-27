import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { StateStore } from '../src/state-store.js';
import { CronService, type CronDeps } from '../src/cron/cron-service.js';

const stores: StateStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.saveNowAsync(); });
function scheduler(store: StateStore, posts: string[]) {
  const service = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
  service.setBotPoster({
    getBot: () => undefined,
    check: () => { throw new Error('bot branch must not run'); },
    post: () => { throw new Error('bot branch must not run'); },
    postAsAuthor: (employee, room, text) => {
      expect(employee).toBe('fixture-employee');
      expect(room).toBe('fixture-room');
      posts.push(text); return { name: 'Fixture' };
    },
  });
  service.init(); return service;
}
async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'routine-recovery-owned-')), 'state.json');
  const store = new StateStore(file); stores.push(store);
  const posts: string[] = []; const service = scheduler(store, posts);
  const due = Date.now() + 1000;
  const job = service.createJob({ name: 'synthetic own post', action: 'post', roomId: 'fixture-room',
    postText: 'owned-synthetic-canary', scheduleType: 'once', runAt: due, enabled: true },
    undefined, { employeeId: 'fixture-employee', sessionId: 'fixture-session' });
  await store.saveNowAsync(); const old = readFileSync(file);
  await service.tickDueJobs(due); await setImmediate(); await store.saveNowAsync();
  expect(posts).toHaveLength(1); expect(service.getJob(job.id)?.completedOnce).toBe(true);
  expect(service.listRuns(job.id)).toHaveLength(1);
  expect(service.listRuns(job.id)[0]).toMatchObject({ triggerType: 'scheduled', status: 'posted' });
  return { file, store, service, posts, job, due, old };
}
describe('ordinary author routine recovery: actual StateStore + CronService', () => {
  it('normal current-state restart does not repeat a completed scheduled one-shot', async () => {
    const x = await fixture(); const restart = new StateStore(x.file); stores.push(restart);
    const service = scheduler(restart, x.posts);
    await service.tickDueJobs(x.due); await setImmediate();
    expect(x.posts).toHaveLength(1);
  });
  it('corrupt-main backup fallback must not replay the same scheduled one-shot', async () => {
    const x = await fixture();
    expect(readFileSync(x.file + '.bak').equals(x.old)).toBe(true);
    writeFileSync(x.file, 'corrupt-fixture-state');
    const recovered = new StateStore(x.file); stores.push(recovered);
    const service = scheduler(recovered, x.posts);
    await service.tickDueJobs(x.due); await setImmediate();
    expect(x.posts).toHaveLength(1);
  });
  it('explicit backup recovery must not replay the same scheduled one-shot', async () => {
    const x = await fixture();
    expect(readFileSync(x.file + '.bak').equals(x.old)).toBe(true);
    expect(x.store.recoverFromBackup()).toBe(true);
    await x.service.tickDueJobs(x.due); await setImmediate();
    // This is the safety requirement, deliberately not an assertion accepting duplicate delivery.
    expect(x.posts).toHaveLength(1);
  });
});
