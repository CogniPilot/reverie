/** The office puts approved limits back by itself after a reload of the host's
 * service manager reset them. Real controller and repair journal; only the
 * Docker transport and the kernel are the shared controlled fixture. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, helper, policy, restorer, workerId } from './helpers/docker-resource-physical.js';
import { DockerResourceRepairJournal } from '../src/docker-resource-repair-journal.js';
import {
  DockerContinuationTask,
  allowedDockerTaskTransition,
  dockerFailedWriterHold,
} from '../src/docker-continuation-task.js';
import { DockerPoolReconciliationReceipt } from '../src/docker-contained-resource-controller.js';
import { dockerSupersededHelperProven } from '../src/docker-engine-command.js';
import { dockerResourceHelperConfiguration } from '../src/docker-resource-helper-inspection.js';

const boxId = 'b'.repeat(64),
  other = '8'.repeat(64),
  REFUSED = 'BOXED_RESOURCE_FOREIGN_CHILD; effectIssued=false\n';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function office(options: { restoreImage?: string | null; journal?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pool-restore-'));
  directories.push(directory);
  const path = join(directory, 'docker-resource-repair.jsonl');
  const journal = new DockerResourceRepairJournal(path, boxId);
  const f = fixture(
    boxId,
    undefined,
    undefined,
    undefined,
    options.journal === false
      ? undefined
      : { journal, path, restoreImage: options.restoreImage === null ? undefined : (options.restoreImage ?? restorer) }
  );
  const commands = () => f.configurations.map(({ config }) => (config.Cmd as string[])[0]);
  const last = () => f.configurations.at(-1)!.config as { Cmd: string[]; Image: string };
  const entries = () =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as { attemptId: string; target: { kind: string }; task?: DockerContinuationTask })
      : [];
  return { f, path, journal, commands, last, entries };
}
/** One laptop that finished its set-up in a pool this operation initialized. */
async function runningLaptop(options: Parameters<typeof office>[0] = {}) {
  const o = office(options),
    { f } = o;
  await f.controller.preparePool(f.row(), f.current);
  await f.setPool();
  f.makeWorker();
  f.selectWorker();
  await f.controller.configure(f.row(), f.current);
  f.ready();
  return o;
}
const members = (args: readonly string[]) => args.filter((_value, index) => args[index - 1] === '--member');

describe('pool writer task records', () => {
  const base = {
    role: 'pool-helper' as const,
    name: 'reverie-boxed-pool-helper-' + '1'.repeat(64),
    imageId: helper,
    configurationDigest: '2'.repeat(64),
  };
  const started = { ...base, phase: 'start-issued' as const, containerId: '3'.repeat(64) };
  const failed = (failure: string, attempt?: number) =>
    DockerContinuationTask.parse({ ...started, phase: 'failed', exitCode: 1, failure, ...(attempt ? { attempt } : {}) });
  it('lets a started pool writer end as a recorded failure, and a refused one be followed by a new attempt', () => {
    const refused = failed('refused');
    expect(allowedDockerTaskTransition(started, refused)).toBe(true);
    expect(dockerFailedWriterHold(refused)).toBe('DOCKER_RESOURCE_HELPER_RETRY_PENDING');
    const next = { ...base, name: 'reverie-boxed-pool-helper-' + '4'.repeat(64), phase: 'create-issued' as const };
    expect(allowedDockerTaskTransition(refused, { ...next, attempt: 2 })).toBe(true);
    // The same name, a skipped index or an acknowledged writer is never a successor.
    expect(allowedDockerTaskTransition(refused, { ...next, name: base.name, attempt: 2 })).toBe(false);
    expect(allowedDockerTaskTransition(refused, { ...next, attempt: 3 })).toBe(false);
    expect(
      allowedDockerTaskTransition({ ...started, phase: 'completed', resultDigest: '5'.repeat(64) }, { ...next, attempt: 2 })
    ).toBe(false);
  });
  it('still holds a pool writer whose end is not understood, and a refused leaf writer', () => {
    for (const failure of ['unknown', 'close-unconfirmed']) {
      const held = failed(failure);
      expect(dockerFailedWriterHold(held)).not.toBe('DOCKER_RESOURCE_HELPER_RETRY_PENDING');
      expect(
        allowedDockerTaskTransition(held, {
          ...base,
          name: 'reverie-boxed-pool-helper-' + '4'.repeat(64),
          phase: 'create-issued',
          attempt: 2,
        })
      ).toBe(false);
    }
    const leaf = DockerContinuationTask.parse({ ...failed('refused'), role: 'leaf-helper' });
    expect(dockerFailedWriterHold(leaf)).toBe('DOCKER_RESOURCE_HELPER_REFUSED');
    // Any other role still cannot fail or be rerun.
    expect(DockerContinuationTask.safeParse({ ...failed('refused'), role: 'identity-helper' }).success).toBe(false);
  });
});

describe('the shared pool after a reload of the service manager', () => {
  it('restores a populated pool with exactly the members that run, and adopts the acknowledgement', async () => {
    const { f, commands, last, entries } = await runningLaptop();
    f.addMember(other, 300);
    f.reloadServiceManager();
    await expect(f.controller.observePool(f.row())).resolves.toBeNull();
    const before = [...f.tasks];
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    expect(commands().at(-1)).toBe('restore-pool');
    expect(last().Image).toBe(restorer);
    expect(members(last().Cmd)).toEqual([`${other}:300:20`, `${workerId}:200:20`]);
    // The same approved limits, and nothing of the laptop's own record is rewritten.
    expect(last().Cmd.slice(last().Cmd.indexOf('--memory-max'), last().Cmd.indexOf('--member'))).toEqual([
      '--memory-max',
      String(policy.pool.memoryMaxBytes),
      '--swap-max',
      '0',
      '--pids-max',
      '8192',
      '--cpu-weight',
      '100',
      '--cpuset-cpus',
      '0-1',
    ]);
    expect([...f.tasks]).toEqual(before);
    expect(entries().map((entry) => entry.task?.phase)).toEqual(['create-issued', 'created', 'start-issued', 'completed']);
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
    // A second request finds nothing to write.
    const creates = f.creates.length;
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('unchanged');
    expect(f.creates).toHaveLength(creates);
  });

  it('re-earns an acknowledgement for limits that match when none survives', async () => {
    const { f, commands, entries } = await runningLaptop();
    const original = f.tasks.get('pool-helper')!;
    if (original.phase !== 'completed') throw Error('Completed pool helper required');
    f.containers.delete(original.containerId);
    f.logs.delete(original.containerId);
    // The limits are intact; only the proof of them is gone.
    await expect(f.controller.observePool(f.row())).rejects.toThrow('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
    await expect(f.controller.capturePoolObservation(policy.pool, f.current)).rejects.toThrow(
      'DOCKER_POOL_ORIGINAL_ACK_MISSING'
    );
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    expect(commands().at(-1)).toBe('restore-pool');
    expect(entries().at(-1)!.task!.phase).toBe('completed');
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.current);
    const record = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, f.current);
    expect(record).toMatchObject({ version: 2, poolRestoreHelperImageId: restorer });
    expect(record.configuration).toEqual(entries().at(-1)!.task);
  });

  it('initializes an empty pool with the operation’s own configure-pool, as before', async () => {
    const { f, commands, last, path } = office();
    await f.controller.preparePool(f.row(), f.current);
    expect(f.creates).toEqual(['anchor', 'pool-helper']);
    expect(commands().at(-1)).toBe('configure-pool');
    expect(last().Image).toBe(helper);
    expect(members(last().Cmd)).toEqual([]);
    expect(f.tasks.get('pool-helper')).toMatchObject({ phase: 'completed' });
    expect(existsSync(path)).toBe(false);
  });

  it('restores from a laptop set-up that reaches a pool other laptops already run in', async () => {
    const { f, commands, last, entries } = office();
    f.addMember(other, 300);
    await f.controller.preparePool(f.row(), f.current);
    // No configure-pool is ever issued against a pool that has members.
    expect(commands()).toEqual(['anchor', 'restore-pool']);
    expect(members(last().Cmd)).toEqual([`${other}:300:20`]);
    expect(f.tasks.get('pool-helper')).toBeUndefined();
    expect(entries().at(-1)!.task!.phase).toBe('completed');
    await expect(f.controller.observePool(f.row())).resolves.toMatchObject({ cgroupParent: `reverie-box-${boxId}.slice` });
  });

  it('settles a set-up’s failed pool writer as a proven failure and restores on the next request', async () => {
    const { f, commands, entries } = office();
    // What an earlier office did: it issued configure-pool against a pool that had members.
    f.failPoolWriters(REFUSED);
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    f.addMember(other, 300);
    const failed = f.tasks.get('pool-helper')!;
    expect(failed.phase).toBe('start-issued');
    // A read neither waits on the failed writer nor mistakes its empty output for an acknowledgement.
    await expect(f.controller.observePool(f.row())).resolves.toBeNull();
    const starts = f.starts.length;
    await f.controller.settleFailedWriter(f.row(), f.current);
    expect(f.tasks.get('pool-helper')).toMatchObject({ phase: 'failed', exitCode: 1, failure: 'refused' });
    expect(f.starts).toHaveLength(starts);
    await f.controller.preparePool(f.row(), f.current);
    expect(commands()).toEqual(['anchor', 'configure-pool', 'restore-pool']);
    // The failed attempt stays recorded as failed; the restore has its own cursor.
    expect(f.tasks.get('pool-helper')).toMatchObject({ phase: 'failed' });
    expect(entries().at(-1)!.task!.phase).toBe('completed');
    await expect(f.controller.observePool(f.row())).resolves.not.toBeNull();
    // Its container is still there and poisons no later read of every pool writer.
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.current);
    expect(DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, f.current).configuration).toEqual(
      entries().at(-1)!.task
    );
  });

  it('adopts another writer’s acknowledgement beside a failed own writer that is not settled yet', async () => {
    const { f } = office();
    f.failPoolWriters(REFUSED);
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    const own = f.tasks.get('pool-helper')!;
    f.addMember(other, 300);
    // Another request restores the pool while this set-up's failed writer is still on record as started.
    f.tasks.delete('pool-helper');
    await f.controller.preparePool(f.row(), f.current);
    f.tasks.set('pool-helper', own);
    const phases = [...f.phases];
    await expect(f.controller.observePool(f.row())).resolves.not.toBeNull();
    expect(f.phases).toEqual(phases);
  });

  it('issues the next own attempt for an empty pool after a failure that was a lost read', async () => {
    const { f, commands } = office();
    f.failPoolWriters('BOXED_RESOURCE_PID_EXITED; effectIssued=false\n');
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    await f.controller.preparePool(f.row(), f.current);
    expect(commands()).toEqual(['anchor', 'configure-pool', 'configure-pool']);
    expect(f.names[1]).not.toBe(f.names[2]);
    expect(f.tasks.get('pool-helper')).toMatchObject({ phase: 'completed', name: f.names[2] });
  });

  it('holds a set-up whose pool writer ended in a way the office does not understand', async () => {
    const { f } = office();
    f.failHelper('pool-helper');
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    const creates = f.creates.length;
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN');
    expect(f.tasks.get('pool-helper')).toMatchObject({ phase: 'failed', failure: 'unknown' });
    expect(f.creates).toHaveLength(creates);
  });

  it('refuses clearly, and creates nothing, when no restore helper image is configured', async () => {
    const { f, path } = await runningLaptop({ restoreImage: null });
    f.reloadServiceManager();
    const creates = [...f.creates];
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_POOL_RESTORE_HELPER_REQUIRED');
    expect(f.creates).toEqual(creates);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses without a repair journal instead of initializing a populated pool', async () => {
    const { f } = await runningLaptop({ journal: false });
    f.reloadServiceManager();
    const creates = [...f.creates];
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_REPAIR_UNAVAILABLE');
    expect(f.creates).toEqual(creates);
  });

  it('refuses a restore image that is not built for restoring', async () => {
    const { f } = await runningLaptop({ restoreImage: 'sha256:' + '6'.repeat(64) });
    f.reloadServiceManager();
    const creates = [...f.creates];
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_POOL_RESTORE_UNSUPPORTED');
    expect(f.creates).toEqual(creates);
  });

  it('issues nothing when a laptop starts while the pool is being read', async () => {
    const { f, path } = await runningLaptop();
    f.reloadServiceManager();
    let probes = 0;
    f.beforeRun((args) => {
      // The read that names the pool to the helper, after its own members were collected.
      if (args.includes('probe-pool') && ++probes === 3) f.addMember(other, 300);
    });
    const creates = [...f.creates];
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_MEMBERS_CHANGED');
    expect(f.creates).toEqual(creates);
    expect(existsSync(path)).toBe(false);
  });

  it('records a restore the helper refused because a member changed, and restores on the next request', async () => {
    const { f, entries, last } = await runningLaptop();
    f.reloadServiceManager();
    f.beforeRun((args) => {
      // Another laptop starts between the last read and the helper's own check.
      if (args[0] === 'container' && args[1] === 'start') f.addMember(other, 300);
    });
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    f.beforeRun(undefined);
    expect(members(last().Cmd)).toEqual([`${workerId}:200:20`]);
    expect(entries().at(-1)!.task).toMatchObject({ phase: 'failed', exitCode: 1, failure: 'refused' });
    await expect(f.controller.observePool(f.row())).resolves.toBeNull();
    // The failed attempt is terminal. One new attempt names the members that run now.
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    expect(members(last().Cmd)).toEqual([`${other}:300:20`, `${workerId}:200:20`]);
    expect(new Set(entries().map((entry) => entry.attemptId)).size).toBe(2);
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
  });

  it('resumes an attempt whose create reply was lost as itself', async () => {
    const { f, entries } = await runningLaptop();
    f.reloadServiceManager();
    f.loseCreate();
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('lost create reply');
    const creates = f.creates.length,
      starts = f.starts.length;
    expect(entries().at(-1)!.task!.phase).toBe('create-issued');
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    // The CREATE of the one attempt is not repeated, and it is started once.
    expect(f.creates).toHaveLength(creates);
    expect(f.starts).toHaveLength(starts + 1);
    expect(new Set(entries().map((entry) => entry.attemptId)).size).toBe(1);
    expect(entries().at(-1)!.task!.phase).toBe('completed');
  });

  it('closes an attempt whose writer was never created, and issues one new attempt', async () => {
    const { f, entries, path } = await runningLaptop();
    f.reloadServiceManager();
    f.rejectNextCreate();
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('definite CREATE rejected');
    expect(entries().at(-1)!.task!.phase).toBe('create-issued');
    const creates = f.creates.length;
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    // The first attempt is closed as never created; nothing of it was ever started.
    expect(f.creates).toHaveLength(creates + 1);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.abandoned === true)).toHaveLength(1);
    expect(new Set(entries().map((entry) => entry.attemptId)).size).toBe(2);
    expect(entries().at(-1)!.task!.phase).toBe('completed');
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
  });

  it('never starts an attempt again whose start reply was lost, and settles its cursor before the next one', async () => {
    const { f, entries } = await runningLaptop();
    f.reloadServiceManager();
    f.loseStart();
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('lost start reply');
    const creates = f.creates.length,
      starts = f.starts.length;
    expect(entries().at(-1)!.task!.phase).toBe('start-issued');
    // The writer did run. Its own terminal acknowledgement is read; nothing is issued.
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('unchanged');
    expect(f.creates).toHaveLength(creates);
    expect(f.starts).toHaveLength(starts);
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
    // The next reload: the open cursor is recorded finished as itself, then one new attempt follows.
    f.reloadServiceManager();
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    expect(f.creates).toHaveLength(creates + 1);
    expect(f.starts).toHaveLength(starts + 1);
    const attempts = [...new Set(entries().map((entry) => entry.attemptId))];
    expect(attempts).toHaveLength(2);
    expect(
      attempts.map((id) => entries().filter((entry) => entry.attemptId === id).at(-1)!.task!.phase)
    ).toEqual(['completed', 'completed']);
  });

  it('holds while an issued restore writer has not ended', async () => {
    const { f } = await runningLaptop();
    f.reloadServiceManager();
    f.loseStart();
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('lost start reply');
    const id = [...f.containers.keys()].at(-1)!;
    f.containers.get(id)!.State = {
      Status: 'running',
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: 900,
      ExitCode: 0,
    };
    const creates = f.creates.length;
    // No reader adopts anything beside a writer that may still be writing.
    await expect(f.controller.observePool(f.row())).rejects.toThrow('DOCKER_RESOURCE_POOL_WRITER_UNCONFIRMED');
    expect(f.creates).toHaveLength(creates);
  });

  it('keeps an exited restore writer closed after another restore image is selected', async () => {
    const { f, commands, last } = await runningLaptop();
    f.reloadServiceManager();
    await f.controller.repairPool(f.row(), f.current);
    const next = 'sha256:' + '5'.repeat(64);
    f.changeRestorePin(next);
    // The earlier writer no longer acknowledges anything under the new selection,
    // and it is not an unknown writer either: the laptop's own acknowledgement still stands.
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
    await expect(f.controller.capturePoolObservation(policy.pool, f.current)).resolves.toBeInstanceOf(
      DockerPoolReconciliationReceipt
    );
    f.reloadServiceManager();
    // The fixture's Engine knows one restore image; the new selection is refused as unsupported, never bypassed.
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_POOL_RESTORE_UNSUPPORTED');
    expect(commands().filter((command) => command === 'restore-pool')).toHaveLength(1);
    expect(last().Image).toBe(restorer);
  });
});

describe('an office found held after a reload, with its helper containers removed by hand', () => {
  it('restores the pool and the laptop in place and reads both as approved again', async () => {
    const { f, commands } = await runningLaptop();
    // The pool was initialized by another operation's record; this laptop's record names no pool writer.
    const pool = f.tasks.get('pool-helper')!,
      leaf = f.tasks.get('leaf-helper')!;
    if (pool.phase !== 'completed' || leaf.phase !== 'completed') throw Error('Completed helpers required');
    const initial = (f.containers.get(pool.containerId)!.Config as { Cmd: string[] }).Cmd;
    f.tasks.delete('pool-helper');
    for (const id of [pool.containerId, leaf.containerId]) {
      f.containers.delete(id);
      f.logs.delete(id);
    }
    f.addMember(other, 300);
    f.reloadServiceManager();
    // Another employee's set-up issued configure-pool against the populated pool. Its helper exited
    // with an error and printed nothing; the container is still on the host and on no record here.
    const failedId = '5'.repeat(64),
      name = 'reverie-boxed-pool-helper-' + '6'.repeat(64),
      parent = `/reverie.slice/reverie-box.slice/reverie-box-${boxId}.slice`;
    const config = dockerResourceHelperConfiguration(
      boxId,
      'pool-helper',
      name,
      initial,
      { path: parent, target: '/run/reverie-box-pool' },
      helper
    );
    f.containers.set(failedId, {
      Id: failedId,
      Name: '/' + name,
      Image: helper,
      Config: structuredClone(config),
      HostConfig: structuredClone(config.HostConfig),
      Mounts: (config.HostConfig as { Binds: string[] }).Binds.map((bind) => {
        const [Source, Destination, mode] = bind.split(':');
        return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
      }),
      State: { Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, ExitCode: 1 },
    });
    f.logs.set(failedId, '');
    await expect(f.controller.observePool(f.row())).resolves.toBeNull();
    await expect(f.controller.capturePoolObservation(policy.pool, f.current)).rejects.toThrow(
      'DOCKER_POOL_POLICY_CHANGED'
    );
    const before = commands().length;
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    // The pool is exactly what the laptop's record holds, so the record needs no change.
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
    await expect(f.controller.read(f.row())).rejects.toThrow('DOCKER_RESOURCE_LEAF_ACK_MISSING');
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
    expect(commands().slice(before)).toEqual(['restore-pool', 'restore-high']);
    // Nothing was started but those two helpers, and the failed one is still there, untouched.
    expect(f.starts.slice(-2)).toEqual(['pool-helper', 'leaf-helper']);
    expect(f.containers.has(failedId)).toBe(true);
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.current);
    expect(DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, f.current)).toMatchObject({ version: 2 });
  });
});

describe('repair writers that a newer one superseded', () => {
  /** The Engine port's own proof decides; the fixture only applies the removal. */
  function removing(f: Awaited<ReturnType<typeof runningLaptop>>['f']) {
    const removed: string[] = [];
    Object.assign(f.command, {
      removeSupersededHelper: async (
        id: string,
        proof: Parameters<typeof dockerSupersededHelperProven>[2],
        current: () => void
      ) => {
        current();
        if (!dockerSupersededHelperProven(f.containers.get(id) as never, id, proof)) throw Error('not removable');
        f.containers.delete(id);
        f.logs.delete(id);
        removed.push(id);
      },
    });
    return removed;
  }
  const containerOf = (task: DockerContinuationTask | undefined) =>
    task && 'containerId' in task ? task.containerId : undefined;

  it('keeps one acknowledged restore per target across many reloads, and every set-up writer', async () => {
    const { f, entries } = await runningLaptop();
    const removed = removing(f);
    const setUp = ['pool-helper', 'leaf-helper'].map((role) => containerOf(f.tasks.get(role as 'pool-helper'))!);
    for (let reload = 0; reload < 4; reload++) {
      f.reloadServiceManager();
      await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
      await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    }
    const command = (raw: Record<string, unknown>) => (raw.Config as { Cmd?: string[] }).Cmd?.[0] ?? '';
    const helpers = [...f.containers].filter(([, raw]) => ['restore-pool', 'restore-high'].includes(command(raw)));
    expect(helpers.map(([, raw]) => command(raw)).sort()).toEqual(['restore-high', 'restore-pool']);
    expect(removed).toHaveLength(6);
    // What is left is the newest attempt of each target, and the laptop's own set-up writers are untouched.
    const newest = (kind: string) => containerOf(entries().filter((entry) => entry.target.kind === kind).at(-1)!.task);
    expect(helpers.map(([id]) => id).sort()).toEqual([newest('pool'), newest('leaf')].sort());
    for (const id of setUp) expect(f.containers.has(id)).toBe(true);
    await expect(f.controller.observePool(f.row())).resolves.toEqual(f.row().pool);
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
  });

  it('removes a failed attempt once a later one is acknowledged, and nothing before that', async () => {
    const { f, entries } = await runningLaptop();
    const removed = removing(f);
    f.reloadServiceManager();
    f.failPoolWriters(REFUSED);
    await expect(f.controller.repairPool(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    const failed = containerOf(entries().at(-1)!.task)!;
    expect(removed).toEqual([]);
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    expect(removed).toEqual([failed]);
  });

  it('never removes a writer the company record names, and a refused removal fails no repair', async () => {
    const { f, entries } = await runningLaptop();
    f.reloadServiceManager();
    await f.controller.repairPool(f.row(), f.current);
    const published = entries().at(-1)!.task!;
    f.retain([published]);
    const removed = removing(f);
    f.reloadServiceManager();
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
    expect(removed).toEqual([]);
    expect(f.containers.has(containerOf(published)!)).toBe(true);
    Object.assign(f.command, {
      removeSupersededHelper: async () => {
        throw Error('Engine refused the removal');
      },
    });
    f.reloadServiceManager();
    await expect(f.controller.repairPool(f.row(), f.current)).resolves.toBe('restored');
  });
});

describe('a running laptop after a reload of the service manager', () => {
  async function reloaded(deleteOriginal = false) {
    const o = await runningLaptop(),
      { f } = o;
    const original = f.tasks.get('leaf-helper')!;
    if (original.phase !== 'completed') throw Error('Completed leaf helper required');
    f.reloadServiceManager();
    await f.controller.repairPool(f.row(), f.current);
    if (deleteOriginal) {
      f.containers.delete(original.containerId);
      f.logs.delete(original.containerId);
    }
    return { ...o, original };
  }

  it('puts its own approved limits back in place with restore-high', async () => {
    const { f, commands, last, entries } = await reloaded();
    await expect(f.controller.read(f.row())).resolves.toBeNull();
    const tasks = structuredClone([...f.tasks]);
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    expect(commands().at(-1)).toBe('restore-high');
    expect(last().Image).toBe(helper);
    expect(last().Cmd).toEqual(expect.arrayContaining(['--worker-id', workerId, '--memory-high', String(policy.memoryHighBytes), '--swap-max', '0']));
    // The finished set-up's own record is never rewritten.
    expect([...f.tasks]).toEqual(tasks);
    expect(entries().at(-1)).toMatchObject({ target: { kind: 'leaf', workerId }, task: { phase: 'completed' } });
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
    const creates = f.creates.length;
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('unchanged');
    expect(f.creates).toHaveLength(creates);
  });

  it('never rewrites a leaf with the set-up writer, which does not write the swap limit', async () => {
    const { f, commands } = await reloaded();
    await f.controller.repairLeaf(f.row(), f.current);
    expect(commands().filter((command) => command === 'configure-high')).toHaveLength(1);
  });

  it('earns a new acknowledgement when the set-up writer’s container is gone', async () => {
    const { f, commands } = await reloaded(true);
    await expect(f.controller.read(f.row())).rejects.toThrow('DOCKER_RESOURCE_LEAF_ACK_MISSING');
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    expect(commands().at(-1)).toBe('restore-high');
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
  });

  it('re-earns an acknowledgement for a leaf whose limits are intact', async () => {
    const o = await runningLaptop(),
      { f, commands } = o;
    const original = f.tasks.get('leaf-helper')!;
    if (original.phase !== 'completed') throw Error('Completed leaf helper required');
    f.containers.delete(original.containerId);
    f.logs.delete(original.containerId);
    await expect(f.controller.read(f.row())).rejects.toThrow('DOCKER_RESOURCE_LEAF_ACK_MISSING');
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    expect(commands().at(-1)).toBe('restore-high');
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
  });

  it('waits for the shared pool: a leaf is not written while the pool is unconfirmed', async () => {
    const { f } = await runningLaptop();
    f.reloadServiceManager();
    const creates = [...f.creates];
    await expect(f.controller.repairLeaf(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_POOL_CHANGED');
    expect(f.creates).toEqual(creates);
  });

  it('is offered only for a laptop whose set-up has finished', async () => {
    const { f } = await runningLaptop();
    f.resourcesIssued();
    await expect(f.controller.repairLeaf(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_REPAIR_SCOPE_UNSUPPORTED');
  });

  it('records a failed leaf restore and issues one new attempt on the next request', async () => {
    const { f, entries } = await reloaded();
    f.failLeafWriters('BOXED_RESOURCE_PID_EXITED; effectIssued=false\n');
    await expect(f.controller.repairLeaf(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    expect(entries().at(-1)!.task).toMatchObject({ phase: 'failed', failure: 'lost-process' });
    await expect(f.controller.read(f.row())).resolves.toBeNull();
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
  });

  it('reads a laptop whose only surviving acknowledgement is a restore beside a failed restore', async () => {
    const { f } = await reloaded(true);
    f.failLeafWriters('BOXED_RESOURCE_PID_EXITED; effectIssued=false\n');
    await expect(f.controller.repairLeaf(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_FAILED');
    await expect(f.controller.repairLeaf(f.row(), f.current)).resolves.toBe('restored');
    // The failed writer printed nothing: it is skipped, not parsed.
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
  });
});

describe('the repair journal file', () => {
  const name = (digit: string) => 'reverie-boxed-pool-helper-' + digit.repeat(64);
  const task = (digit: string, phase: 'create-issued' | 'created' | 'start-issued' | 'completed') =>
    DockerContinuationTask.parse({
      role: 'pool-helper',
      name: name(digit),
      imageId: restorer,
      configurationDigest: '2'.repeat(64),
      phase,
      ...(phase === 'create-issued' ? {} : { containerId: digit.repeat(64) }),
      ...(phase === 'completed' ? { resultDigest: '3'.repeat(64) } : {}),
    });
  const row = {} as never;
  function journal(budget: number) {
    const directory = mkdtempSync(join(tmpdir(), 'repair-journal-'));
    directories.push(directory);
    const path = join(directory, 'docker-resource-repair.jsonl');
    return { path, journal: new DockerResourceRepairJournal(path, boxId, budget) };
  }
  /** One whole attempt, from its intent to its acknowledgement. */
  const finish = (j: DockerResourceRepairJournal, digit: string) =>
    j.attempt({ kind: 'pool' }, () => {}, async (attempt) => {
      let before: DockerContinuationTask | undefined;
      for (const phase of ['create-issued', 'created', 'start-issued', 'completed'] as const) {
        const next = task(digit, phase);
        await attempt.journal.publish(row, before, next, () => {});
        before = next;
      }
      return attempt.fresh;
    });

  it('resumes the open attempt of a target as itself and begins a new one only after it ended', async () => {
    const { journal: j } = journal(64 * 1024);
    const first = await j.attempt({ kind: 'pool' }, () => {}, async (attempt) => {
      await attempt.journal.publish(row, undefined, task('4', 'create-issued'), () => {});
      return attempt.id;
    });
    // Another target has its own cursor.
    const leaf = await j.attempt({ kind: 'leaf', workerId }, () => {}, async (attempt) => attempt.fresh);
    expect(leaf).toBe(true);
    const resumed = await j.attempt({ kind: 'pool' }, () => {}, async (attempt) => {
      expect(attempt.journal.read(row, 'pool-helper')).toEqual(task('4', 'create-issued'));
      // A cursor only moves forward from what is recorded.
      await expect(attempt.journal.publish(row, undefined, task('4', 'created'), () => {})).rejects.toThrow(
        'DOCKER_RESOURCE_REPAIR_JOURNAL_CHANGED'
      );
      attempt.abandon(() => {});
      await expect(
        attempt.journal.publish(row, task('4', 'create-issued'), task('4', 'created'), () => {})
      ).rejects.toThrow('DOCKER_RESOURCE_REPAIR_JOURNAL_CHANGED');
      return [attempt.id, attempt.fresh];
    });
    expect(resumed).toEqual([first, false]);
    expect(await finish(j, '5')).toBe(true);
    expect(j.poolTasks().map((value) => value.phase)).toEqual(['create-issued', 'completed']);
    expect(j.finished({ kind: 'pool' })).toEqual([task('5', 'completed')]);
    // Another box sharing the file sees none of it.
    expect(new DockerResourceRepairJournal(join(directories.at(-1)!, 'docker-resource-repair.jsonl'), 'c'.repeat(64)).poolTasks()).toEqual([]);
  });

  it('sets a full file of finished attempts aside and keeps the attempt in hand whole', async () => {
    const { path, journal: j } = journal(6 * 1024);
    for (const digit of ['1', '4', '5', '6', '8', '9', 'a', 'c', 'd', 'e']) await finish(j, digit);
    expect(existsSync(path + '.previous')).toBe(true);
    expect(readFileSync(path, 'utf8').length).toBeLessThanOrEqual(6 * 1024);
    expect(j.finished({ kind: 'pool' }).at(-1)).toEqual(task('e', 'completed'));
  });

  it('never moves a file that still holds an open attempt', async () => {
    const { path, journal: j } = journal(6 * 1024);
    await j.attempt({ kind: 'leaf', workerId }, () => {}, async (attempt) => {
      await attempt.journal.publish(
        row,
        undefined,
        DockerContinuationTask.parse({ ...task('f', 'create-issued'), role: 'leaf-helper', name: 'reverie-boxed-leaf-helper-' + 'f'.repeat(64) }),
        () => {}
      );
    });
    let refused: unknown;
    for (const digit of ['1', '4', '5', '6', '8', '9', 'a', 'c', 'd', 'e'])
      await finish(j, digit).catch((error: unknown) => {
        refused ??= error;
      });
    expect(String(refused)).toContain('DOCKER_RESOURCE_REPAIR_JOURNAL_FULL');
    expect(existsSync(path + '.previous')).toBe(false);
  });
});
