import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';
import { CronService, type CronDeps } from '../src/cron/cron-service.js';
import { CronJobUpdateSchema } from '../src/web/schemas.js';
import type { CronJobInput } from '../src/cron/cron-input.js';
const stores: StateStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.saveNowAsync();
});
function setup(file = join(mkdtempSync(join(tmpdir(), 'routine-fence-')), 'state.json')) {
  const store = new StateStore(file);
  stores.push(store);
  const effects = vi.fn();
  const service = new CronService({
    store,
    broadcast: vi.fn(),
    sessions: new Map(),
    addSession: effects,
  } as unknown as CronDeps);
  service.setBotPoster({
    getBot: () => undefined,
    check: effects,
    post: effects,
    postAsAuthor: () => {
      effects();
      return { name: 'Synthetic' };
    },
  });
  return { store, service, effects, file };
}
const input = (): CronJobInput => ({
  name: 'Synthetic own routine',
  action: 'post',
  roomId: 'synthetic-room',
  postText: 'synthetic metadata reminder',
  scheduleType: 'interval',
  intervalMinutes: 5,
  enabled: true,
});
function job(x: ReturnType<typeof setup>) {
  return x.service.createJob(input(), undefined, { employeeId: 'synthetic-author' });
}
async function refuse(x: ReturnType<typeof setup>, id: string) {
  expect(x.service.getJob(id)?.recoveryUncertain).toBe(true);
  expect(x.service.getJob(id)?.enabled).toBe(false);
  await expect(x.service.runNow(id)).rejects.toThrow('RECOVERY_UNCERTAIN');
  expect(() => x.service.updateJob(id, { enabled: true })).toThrow('RECOVERY_UNCERTAIN');
  expect(() => x.service.updateJob(id, { recoveryUncertain: false } as never)).toThrow('RECOVERY_UNCERTAIN');
  expect(() => x.service.setEnabled(id, true)).toThrow('RECOVERY_UNCERTAIN');
  expect(() => x.service.deleteJob(id)).toThrow('RECOVERY_UNCERTAIN');
  expect(x.service.setEnabled(id, false)?.recoveryUncertain).toBe(true);
  await x.service.tickDueJobs(Date.now() + 60_000);
}
describe('shared ordinary cron recovery uncertainty', () => {
  it('normal primary restart retains existing author/manual/edit/enable semantics', async () => {
    const x = setup();
    const saved = job(x);
    await x.store.saveNowAsync();
    const restart = setup(x.file);
    expect(restart.service.getJob(saved.id)?.recoveryUncertain).toBeUndefined();
    expect((await restart.service.runNow(saved.id))?.status).toBe('posted');
    expect(restart.effects).toHaveBeenCalledTimes(1);
    expect(restart.service.updateJob(saved.id, { name: 'normal edit' })?.name).toBe('normal edit');
    expect(restart.service.setEnabled(saved.id, true)?.enabled).toBe(true);
    expect(restart.service.deleteJob(saved.id)).toBe(true);
  });
  it('constructor fallback cannot query/post or clear the same-ID hold via edit/re-enable/delete', async () => {
    const x = setup();
    const saved = job(x);
    await x.store.saveNowAsync();
    await x.service.runNow(saved.id);
    await x.store.saveNowAsync();
    expect(readFileSync(x.file + '.bak').length).toBeGreaterThan(0);
    writeFileSync(x.file, 'corrupt synthetic main');
    const recovered = setup(x.file);
    await refuse(recovered, saved.id);
    expect(recovered.effects).not.toHaveBeenCalled();
    await recovered.store.saveNowAsync();
    const restart = setup(x.file);
    await refuse(restart, saved.id);
    expect(restart.effects).not.toHaveBeenCalled();
  });
  it('explicit generated-backup restore retains the newer completed run and applies the same hold', async () => {
    const x = setup();
    const saved = job(x);
    await x.store.saveNowAsync();
    const run = await x.service.runNow(saved.id);
    await x.store.saveNowAsync();
    expect(x.store.recoverFromBackup()).toBe(true);
    expect(x.service.listRuns(saved.id).some((item) => item.id === run!.id && item.status === 'posted')).toBe(true);
    x.effects.mockClear();
    await refuse(x, saved.id);
    expect(x.effects).not.toHaveBeenCalled();
  });
  it('a backup omitting a later uncertain routine cannot erase its failed-run evidence', async () => {
    const x = setup();
    const empty = JSON.stringify(x.store.getState());
    const saved = job(x);
    x.service.setBotPoster({
      getBot: () => undefined,
      check: vi.fn(),
      post: vi.fn(),
      postAsAuthor: () => {
        x.effects();
        throw new Error('synthetic uncertain post');
      },
    });
    const failed = await x.service.runNow(saved.id);
    expect(failed?.status).toBe('failed');
    writeFileSync(x.file + '.bak', empty);
    expect(x.store.recoverFromBackup()).toBe(true);
    expect(x.service.listRuns(saved.id).some((item) => item.id === failed!.id)).toBe(true);
    x.effects.mockClear();
    await refuse(x, saved.id);
    expect(x.effects).not.toHaveBeenCalled();
  });
  it('launch jobs are also held before any source/session effects, without a new reconciliation port', async () => {
    const x = setup();
    const directory = mkdtempSync(join(tmpdir(), 'routine-launch-'));
    const saved = x.service.createJob({
      name: 'unstarted launch fixture',
      action: 'launch',
      agentType: 'shell',
      workingDir: directory,
      promptMode: 'inline_text',
      promptText: 'never execute',
      inputMode: 'paste',
      scheduleType: 'interval',
      intervalMinutes: 5,
      enabled: true,
    });
    writeFileSync(x.file + '.bak', JSON.stringify(x.store.getState()));
    expect(x.store.recoverFromBackup()).toBe(true);
    await refuse(x, saved.id);
    expect(x.effects).not.toHaveBeenCalled();
  });
  it('recovery refuses a queued ordinary save then fences a later restore and pending debounce', async () => {
    const x = setup();
    const saved = job(x);
    writeFileSync(x.file + '.bak', JSON.stringify(x.store.getState()));
    const queued = x.store.saveNowAsync();
    expect(x.store.recoverFromBackup()).toBe(false);
    await queued;
    x.store.save();
    expect(x.store.recoverFromBackup()).toBe(true);
    await x.store.saveNowAsync();
    const restart = setup(x.file);
    await refuse(restart, saved.id);
    expect(restart.effects).not.toHaveBeenCalled();
  });
  it('client input cannot assert or clear the server-kept recovery flag', () => {
    expect(CronJobUpdateSchema.parse({ recoveryUncertain: false })).not.toHaveProperty('recoveryUncertain');
    expect(CronJobUpdateSchema.parse({ recoveryUncertain: true })).not.toHaveProperty('recoveryUncertain');
  });
});
