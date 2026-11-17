import { resourceCapacityHistory } from './helpers/docker-resource-capacity.js';
import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { DockerEmployeeEngine } from '../src/docker-employee-engine.js';
import { retainedDockerPoolTasks } from '../src/docker-shared-pool-lineage.js';
import { DockerEmployeeContinuationRecord as ContinuationRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerContinuationTaskRole } from '../src/docker-continuation-task.js';
import { fixture, helper, policy, deployment, writer } from './helpers/docker-resource-physical.js';
import {
  DockerResourceRevisionStore,
  dockerAttemptPublicationRefusal,
  dockerRevisedPolicy,
  type DockerResourceDesiredRevision,
} from '../src/docker-resource-revisions.js';
import {
  DockerContainedResources,
  requireDockerEffectiveResourceProof,
  dockerOtherResourceLimitsMatch,
} from '../src/docker-contained-resource-controller.js';

async function replacementLeafFixture(prepared?: ReturnType<typeof fixture>) {
  const f = prepared ?? fixture();
  if (!prepared) {
    await f.controller.preparePool(f.row(), f.current);
    await f.setPool();
    f.makeWorker();
    await f.controller.configure(f.row(), f.current);
  }
  f.ready();
  const original = f.tasks.get('leaf-helper')!;
  if (original.phase !== 'completed') throw Error('The original actual helper must have completed');
  const candidateId = 'f'.repeat(64),
    candidate = structuredClone(f.containers.get(original.containerId)!);
  const name = 'reverie-boxed-leaf-helper-' + 'e'.repeat(64);
  candidate.Id = candidateId;
  candidate.Name = '/' + name;
  (candidate.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] = name;
  // Controlled Engine data for the separately executed manual helper: the
  // actual adapter must re-earn its config, terminal state and native ACK.
  f.containers.set(candidateId, candidate);
  f.logs.set(candidateId, f.logs.get(original.containerId)!);
  f.containers.delete(original.containerId);
  f.logs.delete(original.containerId);
  const calls: string[][] = [];
  f.beforeRun((args) => {
    calls.push([...args]);
  });
  const snapshot = () => ({
    creates: [...f.creates],
    starts: [...f.starts],
    phases: [...f.phases],
    tasks: structuredClone([...f.tasks]),
  });
  return { f, original, candidateId, candidate, calls, snapshot };
}
describe('fixed Docker resource orchestration', () => {
  async function restartedResourceFixture() {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    await f.setPool();
    f.makeWorker();
    await f.controller.configure(f.row(), f.current);
    f.ready();
    for (const role of ['pool-helper', 'leaf-helper'] as const) {
      const task = f.tasks.get(role);
      if (!task || task.phase !== 'completed') throw Error('Completed fixture helper required');
      f.containers.delete(task.containerId);
      f.logs.delete(task.containerId);
    }
    f.driftEpoch();
    return f;
  }

  it('reads fresh approved limits after a host restart without old writer ACKs or effects', async () => {
    const f = await restartedResourceFixture(),
      original = structuredClone([...f.tasks]),
      calls: string[][] = [];
    f.beforeRun((args) => { calls.push([...args]); });
    await expect(f.controller.readExistingAfterHostRestart(f.row(), policy, f.current)).resolves.toEqual(policy);
    expect([...f.tasks]).toEqual(original);
    expect(calls.filter((args) => args.includes('probe-pool'))).toHaveLength(2);
    expect(calls.filter((args) => args.includes('probe-worker'))).toHaveLength(2);
    expect(
      calls.every(
        (args) =>
          (args[0] === 'container' && args[1] === 'inspect') ||
          (args[0] === 'exec' && (args[2] === '/bin/cat' || args.includes('probe-pool') || args.includes('probe-worker')))
      )
    ).toBe(true);
  });

  it('refuses wrong policy or changed proof scope after reboot', async () => {
    const f = await restartedResourceFixture();
    await expect(
      f.controller.readExistingAfterHostRestart(f.row(), { ...policy, cpuWeight: 42 }, f.current)
    ).rejects.toThrow('DOCKER_RESOURCE_REATTACH_SCOPE_CHANGED');
    f.setHigh(24 * 1024 ** 3);
    await expect(f.controller.readExistingAfterHostRestart(f.row(), policy, f.current)).rejects.toThrow(
      'DOCKER_RESOURCE_REATTACH_POLICY_UNCONFIRMED'
    );
    await expect(
      f.controller.readExistingAfterHostRestart(f.row(), { ...policy, memoryHighBytes: 24 * 1024 ** 3 }, f.current)
    ).resolves.toHaveProperty('memoryHighBytes', 24 * 1024 ** 3);
    f.beforeRun((args) => {
      if (args.includes('probe-worker')) f.revoke();
    });
    await expect(f.controller.readExistingAfterHostRestart(f.row(), policy, f.current)).rejects.toThrow('revoked');
  });

  it('re-earns a missing completed leaf ACK from a different exact terminal helper without rewriting its journal', async () => {
    const { f, calls, snapshot } = await replacementLeafFixture(),
      before = snapshot();
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
    expect(snapshot()).toEqual(before);
    expect(
      calls.filter(
        (args) =>
          args[0] === 'container' && args[1] === 'ls' && args.includes('label=reverie.box.resource.role=leaf-helper')
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(
      calls.every(
        (args) =>
          args[0] === 'image' ||
          (args[0] === 'container' && ['inspect', 'ls', 'logs'].includes(args[1]!)) ||
          (args[0] === 'exec' &&
            (args[2] === '/bin/cat' || args.includes('probe-pool') || args.includes('probe-worker')))
      )
    ).toBe(true);
  });
  it.each(['retired', 'replaced'] as const)(
    'keeps a same-leaf terminal ACK usable after an unrelated historical member is %s',
    async (membership) => {
      const { f, candidate, calls, snapshot } = await replacementLeafFixture();
      const args = (candidate.Config as { Cmd: string[] }).Cmd,
        old = '8'.repeat(64),
        replacement = '9'.repeat(64);
      args.splice(args.indexOf('--leaf-dev'), 0, '--member', old + ':300:30');
      let controller = f.controller;
      if (membership === 'replaced') {
        const raw = structuredClone(f.containers.get('d'.repeat(64))!);
        raw.Id = replacement;
        (raw.Config as { Labels: Record<string, string> }).Labels['reverie.boxed.employee'] =
          '77777777-7777-4777-8777-777777777777';
        (raw.State as Record<string, unknown>).Pid = 300;
        f.containers.set(replacement, raw);
        controller = new DockerContainedResources(f.command, f.journal, {
          boxId: 'b'.repeat(64),
          deployment,
          helperImageId: helper,
          selectedWorkerContainerIds: () => ['d'.repeat(64), replacement],
          retainedPoolConfigurationTasks: () => [],
        });
      }
      const before = snapshot();
      await expect(controller.read(f.row())).resolves.toEqual(policy);
      expect(snapshot()).toEqual(before);
      expect(calls.some((command) => command.includes(old))).toBe(false);
      if (membership === 'replaced')
        expect(calls.some((command) => command.includes(replacement + ':300:20'))).toBe(true);
    }
  );
  it('propagates a fresh native FOREIGN_CHILD refusal instead of accepting historical helper membership', async () => {
    const { f, snapshot } = await replacementLeafFixture();
    f.beforeRun((args) => {
      if (args[0] === 'exec' && args.includes('probe-worker')) throw Error('BOXED_RESOURCE_FOREIGN_CHILD');
    });
    const before = snapshot();
    await expect(f.controller.read(f.row())).rejects.toThrow('BOXED_RESOURCE_FOREIGN_CHILD');
    expect(snapshot()).toEqual(before);
  });
  it('keeps a repaired original16 ACK valid through a genuine approved48 helper and later read-only policy proof', async () => {
    const f = await revisionFixture();
    const { snapshot } = await replacementLeafFixture(f);
    const original = structuredClone([...f.tasks]),
      row = structuredClone(f.row());
    expect(await f.controller.read(f.row())).toEqual(policy);
    const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    expect(result).toEqual({ state: 'applied', policy: { ...policy, memoryHighBytes: 48 * 1024 ** 3 } });
    const before = snapshot();
    expect(await f.controller.read(f.row())).toEqual(result.policy);
    expect(() =>
      requireDockerEffectiveResourceProof(f.controller.existingPolicy(f.row(), result.policy), f.row(), result.policy)
    ).not.toThrow();
    expect(snapshot()).toEqual(before);
    expect([...f.tasks]).toEqual(original);
    expect(f.row()).toEqual(row);
  });
  it('does not turn unapproved actual48 into an effective policy through a historical original16 ACK', async () => {
    const { f, snapshot } = await replacementLeafFixture();
    f.setHigh(48 * 1024 ** 3);
    const before = snapshot();
    expect(await f.controller.read(f.row())).toBeNull();
    expect(() => f.controller.existingPolicy(f.row(), { ...policy, memoryHighBytes: 48 * 1024 ** 3 })).toThrow();
    expect(await f.controller.observeMemoryHigh(f.row(), f.current)).toMatchObject({
      actualMemoryHighBytes: 48 * 1024 ** 3,
      approved: false,
      approvalSource: null,
    });
    expect(snapshot()).toEqual(before);
  });
  it('requires closure rather than matching policy or worker arguments from an unrelated completed9080 helper', async () => {
    const { f, candidate, snapshot } = await replacementLeafFixture();
    const other = structuredClone(candidate),
      id = '6'.repeat(64),
      worker = '8'.repeat(64),
      name = 'reverie-boxed-leaf-helper-' + '7'.repeat(64);
    other.Id = id;
    other.Name = '/' + name;
    const config = other.Config as { Cmd: string[]; Labels: Record<string, string> },
      host = other.HostConfig as { Binds: string[] };
    config.Labels['reverie.box.resource.name'] = name;
    config.Cmd[config.Cmd.indexOf('--worker-id') + 1] = worker;
    config.Cmd[config.Cmd.indexOf('--worker-pid') + 1] = '300';
    config.Cmd[config.Cmd.indexOf('--worker-start') + 1] = '30';
    config.Cmd[config.Cmd.indexOf('--memory-high') + 1] = String(32 * 1024 ** 3);
    const previous = 'docker-' + 'd'.repeat(64) + '.scope',
      current = 'docker-' + worker + '.scope';
    host.Binds = host.Binds.map((bind) => bind.replace(previous, current));
    (other.Mounts as Array<{ Source: string }>).forEach((mount) => {
      mount.Source = mount.Source.replace(previous, current);
    });
    f.containers.set(id, other);
    const before = snapshot();
    await expect(f.controller.read(f.row())).resolves.toEqual(policy);
    expect(snapshot()).toEqual(before);
  });
  it.each([
    'running',
    'created',
    'pid',
    'paused',
    'restarting',
    'dead',
    'failed',
    'oom',
    'error',
    'image',
    'mount',
    'argv',
    'extra-flag',
    'ack-parent',
    'ack-worker',
    'ack-policy',
    'missing-ack',
    'unknown-other-writer',
    'issued-old',
    'present-invalid-old',
  ] as const)('refuses replacement leaf %s without any write or journal publication', async (change) => {
    const { f, candidate, candidateId, original, snapshot } = await replacementLeafFixture();
    const state = candidate.State as Record<string, unknown>,
      config = candidate.Config as { Cmd: string[] },
      ack = JSON.parse(f.logs.get(candidateId)!) as {
        parent: { ino: string };
        worker: { startTicks: string };
        resources: { memoryHigh: string };
      };
    if (change === 'running') {
      state.Status = 'running';
      state.Running = true;
      state.Pid = 300;
    }
    if (change === 'created') state.Status = 'created';
    if (change === 'pid') state.Pid = 300;
    if (change === 'paused') state.Paused = true;
    if (change === 'restarting') state.Restarting = true;
    if (change === 'dead') state.Dead = true;
    if (change === 'failed') state.ExitCode = 1;
    if (change === 'oom') state.OOMKilled = true;
    if (change === 'error') state.Error = 'unknown';
    if (change === 'image') candidate.Image = writer;
    if (change === 'mount')
      (candidate.Mounts as unknown[]).push({ Type: 'bind', Source: '/foreign', Destination: '/foreign', RW: true });
    if (change === 'argv') config.Cmd[config.Cmd.indexOf('--memory-high') + 1] = String(policy.memoryHighBytes + 1);
    if (change === 'extra-flag') config.Cmd.push('--unsafe', '1');
    if (change === 'ack-parent') ack.parent.ino = '999';
    if (change === 'ack-worker') ack.worker.startTicks = '999';
    if (change === 'ack-policy') ack.resources.memoryHigh = '999';
    f.logs.set(candidateId, change === 'missing-ack' ? '{}' : JSON.stringify(ack));
    if (change === 'unknown-other-writer') {
      const other = structuredClone(candidate),
        id = '6'.repeat(64),
        name = 'reverie-boxed-leaf-helper-' + '7'.repeat(64);
      other.Id = id;
      other.Name = '/' + name;
      (other.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] = name;
      other.State = {
        Status: 'running',
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 300,
        ExitCode: 0,
      };
      f.containers.set(id, other);
    }
    if (change === 'issued-old') {
      f.tasks.set('leaf-helper', {
        role: original.role,
        name: original.name,
        imageId: original.imageId,
        configurationDigest: original.configurationDigest,
        containerId: original.containerId,
        phase: 'start-issued',
      });
    }
    if (change === 'present-invalid-old') {
      const previous = structuredClone(candidate);
      previous.Id = original.containerId;
      previous.Name = '/' + original.name;
      (previous.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] = original.name;
      previous.State = {
        Status: 'running',
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 300,
        ExitCode: 0,
      };
      f.containers.set(original.containerId, previous);
    }
    const before = snapshot();
    await expect(f.controller.read(f.row())).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });
  it.each(['epoch', 'policy', 'journal', 'census', 'pool-writer'] as const)(
    'refuses late replacement %s drift after a native ACK await',
    async (change) => {
      const { f, candidateId } = await replacementLeafFixture();
      let changed = false;
      f.beforeRun((args) => {
        if (changed || args[0] !== 'container' || args[1] !== 'logs' || args[2] !== candidateId) return;
        changed = true;
        if (change === 'epoch') f.driftEpoch();
        if (change === 'policy') f.row().policy = { ...policy, memoryHighBytes: policy.memoryHighBytes + 1 };
        if (change === 'journal') f.tasks.delete('leaf-helper');
        if (change === 'census') f.containers.delete(candidateId);
        if (change === 'pool-writer') {
          const task = f.tasks.get('pool-helper')!;
          if (!('containerId' in task)) throw Error('Actual pool helper required');
          (f.containers.get(task.containerId)!.State as Record<string, unknown>).Running = true;
        }
      });
      const before = { creates: [...f.creates], starts: [...f.starts], phases: [...f.phases] };
      await expect(f.controller.read(f.row())).rejects.toThrow();
      expect(changed).toBe(true);
      expect({ creates: f.creates, starts: f.starts, phases: f.phases }).toEqual(before);
    }
  );
  it.each([
    'mode',
    'odd-length',
    'duplicate',
    'box',
    'cid',
    'pid',
    'birth',
    'overflow',
    'member',
    'duplicate-member',
    'missing-field',
    'weight',
    'unsupported-cpus',
  ] as const)('rejects unknown terminal leaf command %s before accepting its ACK', async (change) => {
    const { f, candidate, snapshot } = await replacementLeafFixture();
    const args = (candidate.Config as { Cmd: string[] }).Cmd;
    if (change === 'mode') args[0] = 'configure-pool';
    if (change === 'odd-length') args.pop();
    if (change === 'duplicate') args.push('--box-id', 'b'.repeat(64));
    if (change === 'box') args[args.indexOf('--box-id') + 1] = 'a'.repeat(64);
    if (change === 'cid') args[args.indexOf('--worker-id') + 1] = 'short';
    if (change === 'pid') args[args.indexOf('--worker-pid') + 1] = '-1';
    if (change === 'birth') args[args.indexOf('--worker-start') + 1] = '0';
    if (change === 'overflow') args[args.indexOf('--memory-max') + 1] = '18446744073709551616';
    if (change === 'member') args.push('--member', 'unknown');
    if (change === 'duplicate-member') args.push('--member', 'd'.repeat(64) + ':200:20');
    if (change === 'missing-field') args.splice(args.indexOf('--leaf-dev'), 2);
    if (change === 'weight') args[args.indexOf('--cpu-weight') + 1] = '10001';
    if (change === 'unsupported-cpus') args.push('--cpuset-cpus', '0-1');
    const before = snapshot();
    await expect(f.controller.read(f.row())).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });
  it('reprobes the native scope after the final matching replacement ACK before returning policy', async () => {
    const { f, candidateId } = await replacementLeafFixture();
    let acknowledgements = 0;
    f.beforeRun((args) => {
      if (args[0] === 'container' && args[1] === 'logs' && args[2] === candidateId && ++acknowledgements === 3)
        f.driftEpoch();
    });
    const before = { creates: [...f.creates], starts: [...f.starts], phases: [...f.phases] };
    await expect(f.controller.read(f.row())).rejects.toThrow();
    expect(acknowledgements).toBe(3);
    expect({ creates: f.creates, starts: f.starts, phases: f.phases }).toEqual(before);
  });
  it('a real canonical owner-row archival/reload leaves the native pool proof available to another employee', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const directory = await mkdtemp(join(tmpdir(), 'pool-canonical-native-'));
    try {
      const file = join(directory, 'company.json'),
        canonical = new CompanyStore(file);
      await canonical.init();
      const request = f.row().request;
      const original = {
        containerId: 'c'.repeat(64),
        imageId: 'sha256:' + 'd'.repeat(64),
        deployment,
        employeeId: f.row().employeeId,
        sessionId: request.sessionId,
        home: { type: 'bind', source: '/synthetic/home', destination: '/home/agent', readWrite: true },
        mountDigest: '1'.repeat(64),
        storageDigest: '2'.repeat(64),
        configurationDigest: '3'.repeat(64),
      };
      const row = ContinuationRecord.parse({
        version: 1,
        purpose: 'docker-employee-continuation-v1',
        employeeId: f.row().employeeId,
        sourceDigest: '4'.repeat(64),
        original,
        policy,
        request: {
          ...request,
          containerId: original.containerId,
          imageId: original.imageId,
          expectedPolicyDigest: '5'.repeat(64),
          expectedDestinationImageId: f.row().workerImage.imageId,
          enterOffice: false,
        },
        workerImage: { ...f.row().workerImage, sourceImageId: original.imageId, clientManifestDigest: '6'.repeat(64) },
        credentialId: '44444444-4444-4444-8444-444444444444',
        phase: 'pool-issued',
        tasks: [...f.tasks.values()],
      });
      await canonical.update((state) => {
        state.dockerEmployeeContinuations = [row];
      });
      await canonical.update((state) => {
        delete state.dockerEmployeeContinuations;
      });
      const restarted = new CompanyStore(file);
      await restarted.init();
      f.tasks.delete('pool-helper');
      // The old current-employee-only callback is now empty: the same fresh
      // native kernel values cannot supply the forgotten execution ACK.
      await expect(f.controller.observePool(f.row())).rejects.toThrow('POOL_HELPER_UNACKNOWLEDGED');
      f.retain(retainedDockerPoolTasks(restarted.snapshot(), 'reverie-boxed-anchor-' + 'b'.repeat(32), helper));
      f.row().employeeId = '77777777-7777-4777-8777-777777777777';
      f.row().request.operationId = '88888888-8888-4888-8888-888888888888';
      const before = { creates: [...f.creates], starts: [...f.starts] };
      expect(await f.controller.observePool(f.row())).not.toBeNull();
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
      f.changeHelper('pool-helper', 'restart');
      await expect(f.controller.observePool(f.row())).rejects.toThrow();
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('changed native epoch never adopts an old ACK or replays the anchor START', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    f.retain([f.tasks.get('pool-helper')!]);
    f.tasks.delete('pool-helper');
    const before = { creates: [...f.creates], starts: [...f.starts] };
    f.driftEpoch();
    await expect(f.controller.observePool(f.row())).rejects.toThrow('ANCHOR_REPLACED');
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });
  it('another unresolved writer blocks new configuration before CREATE or START', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const pending = f.tasks.get('pool-helper')!;
    if (!('containerId' in pending)) throw Error('fixture requires CID');
    (f.containers.get(pending.containerId)!.State as Record<string, unknown>).Running = true;
    f.retain([pending]);
    f.tasks.delete('pool-helper');
    f.requireConfigure();
    const before = { creates: [...f.creates], starts: [...f.starts] };
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('WRITER_UNCONFIRMED');
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });

  it('reuses a retired owner ACK only after fresh native proof and without effects', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const completed = f.tasks.get('pool-helper')!;
    f.retain([completed]);
    f.tasks.delete('pool-helper');
    const before = { creates: [...f.creates], starts: [...f.starts] };
    expect(await f.controller.observePool(f.row())).toMatchObject({
      policyDigest: expect.any(String),
    });
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    f.logs.set(('containerId' in completed && completed.containerId) || '', '{}');
    await expect(f.controller.observePool(f.row())).rejects.toThrow();
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });
  it.each(['running', 'missing', 'failed', 'stale-ack'] as const)(
    'retained %s writer cannot be hidden behind another completed ACK',
    async (mode) => {
      const f = fixture();
      await f.controller.preparePool(f.row(), f.current);
      const good = f.tasks.get('pool-helper')!;
      if (!('containerId' in good)) throw Error('fixture requires actual CID');
      const original = f.containers.get(good.containerId)!;
      const otherId = 'f'.repeat(64);
      f.containers.set(otherId, { ...structuredClone(original), Id: otherId });
      const { role, name, imageId, configurationDigest } = good;
      const other = {
        role,
        name,
        imageId,
        configurationDigest,
        containerId: otherId,
        phase: 'start-issued' as const,
      };
      if (mode === 'running') (f.containers.get(otherId)!.State as Record<string, unknown>).Running = true;
      else if (mode === 'missing') f.containers.delete(otherId);
      else if (mode === 'failed') (f.containers.get(otherId)!.State as Record<string, unknown>).ExitCode = 1;
      else f.logs.set(good.containerId, '{}');
      f.retain([good, other]);
      const before = { creates: [...f.creates], starts: [...f.starts] };
      if (mode === 'failed') expect(await f.controller.observePool(f.row())).not.toBeNull();
      else await expect(f.controller.observePool(f.row())).rejects.toThrow();
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    }
  );

  it('isolates helper names when two instances receive the same public operation ID', async () => {
    const first = fixture('b'.repeat(64)),
      second = fixture('c'.repeat(64));
    await first.controller.preparePool(first.row(), first.current);
    await second.controller.preparePool(second.row(), second.current);
    expect(first.row().request.operationId).toBe(second.row().request.operationId);
    expect(first.names[1]).not.toBe(second.names[1]);
  });
  it.each(['restart', 'parent'] as const)(
    'a changed helper %s cannot acknowledge successful resource enforcement',
    async (field) => {
      const f = fixture();
      await f.controller.preparePool(f.row(), f.current);
      await f.setPool();
      f.makeWorker();
      await f.controller.configure(f.row(), f.current);
      const before = [...f.starts];
      f.changeHelper('leaf-helper', field);
      await expect(f.controller.read(f.row())).rejects.toThrow('HELPER');
      expect(f.starts).toEqual(before);
    }
  );
  it.each(['pool-helper', 'leaf-helper'])(
    'matching kernel values cannot replace the original %s success acknowledgement',
    async (role) => {
      const f = fixture();
      if (role === 'pool-helper') {
        f.failHelper(role);
        await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('HELPER_FAILED');
        await expect(f.controller.observePool(f.row())).rejects.toThrow('UNACKNOWLEDGED');
      } else {
        await f.controller.preparePool(f.row(), f.current);
        await f.setPool();
        f.makeWorker();
        f.failHelper(role);
        await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_FAILED');
        await expect(f.controller.read(f.row())).rejects.toThrow('UNACKNOWLEDGED');
      }
      const starts = [...f.starts];
      expect(f.tasks.get(role as DockerContinuationTaskRole)?.phase).toBe('start-issued');
      expect(f.starts).toEqual(starts);
    }
  );
  it('records every effect first and confirms real scalar readbacks before returning policy', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    await f.setPool();
    f.makeWorker();
    await f.controller.configure(f.row(), f.current);
    expect(await f.controller.read(f.row())).toEqual(policy);
    expect(f.creates).toEqual(['anchor', 'pool-helper', 'leaf-helper']);
    expect(f.starts).toEqual(f.creates);
    expect(f.tasks.get('pool-helper')?.phase).toBe('completed');
    expect(f.tasks.get('leaf-helper')?.phase).toBe('completed');
    f.driftWeight();
    expect(await f.controller.read(f.row())).toBeNull();
  });
  it.each(['create', 'start'] as const)(
    'a lost %s reply stays retained and status never replays an effect',
    async (phase) => {
      const f = fixture();
      if (phase === 'create') f.loseCreate();
      else f.loseStart();
      await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('lost ' + phase);
      const before = { creates: [...f.creates], starts: [...f.starts] };
      await f.controller.observePool(f.row());
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    }
  );
  it('refuses revoked authority before creating anything', async () => {
    const f = fixture();
    f.revoke();
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('revoked');
    expect(f.creates).toEqual([]);
    expect(f.starts).toEqual([]);
  });
  it('refuses an extra mount on a retained helper without issuing another start', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const before = [...f.starts];
    f.foreignMount();
    await expect(f.controller.observePool(f.row())).rejects.toThrow('MOUNTS_CHANGED');
    expect(f.starts).toEqual(before);
  });
});

const revisionCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of revisionCleanups.splice(0).reverse()) cleanup();
});
async function revisionFixture(capable = true) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'resource-revision-'));
  const store = new DockerResourceRevisionStore(join(directory, 'journal'));
  revisionCleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  revisionCleanups.push(() => store.close());
  const f = fixture('b'.repeat(64), store, capable ? writer : undefined);
  await f.controller.preparePool(f.row(), f.current);
  await f.setPool();
  f.makeWorker();
  await f.controller.configure(f.row(), f.current);
  f.ready();
  const desired: DockerResourceDesiredRevision = {
    revision: '44444444-4444-4444-8444-444444444444',
    owner: null,
    scope: 'all-current-and-future',
    memoryHighBytes: 48 * 1024 ** 3,
  };
  await store.approve(desired, null, f.current);
  return { ...f, store, desired };
}
describe('approved leaf-only live memory revisions', () => {
  it('adopts current48 without writes, retaining original records and historical ACKs', async () => {
    const f = await revisionFixture(),
      row = structuredClone(f.row()),
      tasks = [...f.tasks],
      effects = { creates: [...f.creates], starts: [...f.starts] };
    f.setHigh(48 * 1024 ** 3);
    expect(await f.controller.read(f.row())).toBeNull();
    const ledgerBefore = fs.readFileSync(join(f.store.directory, 'revisions.json'));
    expect(await f.controller.observeMemoryHigh(f.row(), f.current)).toMatchObject({
      actualMemoryHighBytes: 48 * 1024 ** 3,
      actualLimits: {
        memoryHighBytes: 48 * 1024 ** 3,
        memoryMaxBytes: policy.memoryMaxBytes,
        swapMaxBytes: 0,
        pidsMax: 512,
        cpuWeight: 100,
        allowedCpus: [0, 1],
        cpuQuota: 'unlimited',
      },
      approved: false,
      approvalSource: null,
    });
    expect(fs.readFileSync(join(f.store.directory, 'revisions.json'))).toEqual(ledgerBefore);
    const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    expect(result).toEqual({ state: 'observed', policy: { ...policy, memoryHighBytes: 48 * 1024 ** 3 } });
    const ledgerAfter = fs.readFileSync(join(f.store.directory, 'revisions.json'));
    expect(await f.controller.observeMemoryHigh(f.row(), f.current)).toMatchObject({
      actualMemoryHighBytes: 48 * 1024 ** 3,
      approved: true,
      approvalSource: 'owner-revision',
      approvedRevision: f.desired.revision,
    });
    expect(fs.readFileSync(join(f.store.directory, 'revisions.json'))).toEqual(ledgerAfter);
    expect(f.row()).toEqual(row);
    expect([...f.tasks]).toEqual(tasks);
    expect({ creates: f.creates, starts: f.starts }).toEqual(effects);
    expect(await f.controller.read(f.row())).toEqual(result.policy);
    const proof = f.controller.existingPolicy(f.row(), result.policy);
    expect(() => requireDockerEffectiveResourceProof(proof, f.row(), result.policy)).not.toThrow();
    expect(() => requireDockerEffectiveResourceProof({ require() {} }, f.row(), result.policy)).toThrow();
    expect(() =>
      requireDockerEffectiveResourceProof(proof, { ...f.row(), credentialId: 'changed' }, result.policy)
    ).toThrow();
    await f.store.approve(
      { ...f.desired, revision: '55555555-5555-4555-8555-555555555555', memoryHighBytes: 32 * 1024 ** 3 },
      f.desired.revision,
      f.current
    );
    expect(await f.controller.read(f.row())).toEqual(result.policy);
  });
  it('journals one configure-high separately and returns real48, preserving launch authority', async () => {
    const f = await revisionFixture(),
      row = structuredClone(f.row()),
      tasks = [...f.tasks];
    const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    expect(result.state).toBe('applied');
    expect(result.policy.memoryHighBytes).toBe(48 * 1024 ** 3);
    expect(f.creates).toEqual(['anchor', 'pool-helper', 'leaf-helper', 'leaf-helper']);
    expect(f.starts).toEqual(f.creates);
    expect([...f.tasks]).toEqual(tasks);
    expect(f.row()).toEqual(row);
    expect(f.store.attempt(f.row(), f.desired.revision)?.state).toBe('applied');
    const createdWriter = f.configurations.at(-1)!;
    expect(createdWriter.config.Image).toBe(writer);
    expect((createdWriter.config.Labels as Record<string, string>)['org.reverie.resource.memory-high-only']).toBe('v1');
    const args = createdWriter.config.Cmd as string[];
    expect(args[0]).toBe('configure-memory-high');
    expect(args[args.indexOf('--cpuset-cpus') + 1]).toBe('0-1');
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('WORKER_READBACK');
    expect(f.starts).toHaveLength(4);
  });
  it('lost START holds matching facts until retained Exit0/ACK observation; never starts again', async () => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow('lost start');
    const before = { creates: [...f.creates], starts: [...f.starts] };
    expect(f.store.attempt(f.row(), f.desired.revision)?.state).toBe('helper');
    expect(await f.controller.read(f.row())).toBeNull();
    await expect(
      f.store.approve({ ...f.desired, revision: '55555555-5555-4555-8555-555555555555' }, f.desired.revision, f.current)
    ).rejects.toThrow('ORIGINAL_ATTEMPT_PENDING');
    expect((await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).state).toBe('applied');
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });
  it('lost CREATE observes the exact retained helper rather than creating another', async () => {
    const f = await revisionFixture();
    f.loseCreate();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow('lost create');
    expect(f.creates).toHaveLength(4);
    expect(f.starts).toHaveLength(3);
    expect((await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).state).toBe('applied');
    expect(f.creates).toHaveLength(4);
    expect(f.starts).toHaveLength(4);
  });
  it('changed non-high limits or revoked ownership refuse before any new effect', async () => {
    const f = await revisionFixture(),
      before = [...f.starts];
    f.driftWeight();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow('OTHER_LIMIT');
    expect(f.starts).toEqual(before);
    expect(f.creates).toHaveLength(3);
    f.revoke();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow('revoked');
    expect(f.starts).toEqual(before);
  });
});

describe('late leaf writer exclusion', () => {
  it('unknown live helper blocks a new revision/binding until its own actual terminal ACK settles', async () => {
    const f = await revisionFixture();
    f.delayNextLeaf();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'lost live start'
    );
    expect((await f.controller.observeMemoryHigh(f.row(), f.current)).actualMemoryHighBytes).toBe(
      policy.memoryHighBytes
    );
    const next = { ...f.desired, revision: '55555555-5555-4555-8555-555555555555', memoryHighBytes: 32 * 1024 ** 3 };
    await expect(f.store.approve(next, f.desired.revision, f.current)).rejects.toThrow('ORIGINAL_ATTEMPT_PENDING');
    const rebound = {
      ...f.row(),
      request: { ...f.row().request, operationId: '66666666-6666-4666-8666-666666666666' },
    };
    expect(() => f.store.requireSettled(rebound, f.desired.revision)).toThrow('ORIGINAL_ATTEMPT_PENDING');
    expect(f.creates).toHaveLength(4);
    expect(f.starts).toHaveLength(4);
    f.completeLateLeaf();
    expect(await f.controller.read(f.row())).toBeNull();
    const repaired = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    const oldProof = f.controller.existingPolicy(f.row(), repaired.policy);
    await f.store.approve(next, f.desired.revision, f.current);
    expect((await f.controller.reviseMemoryHigh(f.row(), next.revision, f.current)).policy.memoryHighBytes).toBe(
      32 * 1024 ** 3
    );
    expect(f.creates).toHaveLength(5);
    expect(f.starts).toHaveLength(5);
    expect(() =>
      requireDockerEffectiveResourceProof(oldProof, f.row(), { ...policy, memoryHighBytes: 48 * 1024 ** 3 })
    ).toThrow();
  });
});

describe('resource proof publication finalization', () => {
  it.each(['read', 'profile'] as const)(
    'failing fresh %s ACK cannot leave a retrievable effective-policy proof',
    async (path) => {
      const f = await revisionFixture();
      const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
      f.corruptLatestLog();
      if (path === 'read') await expect(f.controller.read(f.row())).rejects.toThrow();
      else await expect(f.controller.observeMemoryHigh(f.row(), f.current)).rejects.toThrow();
      expect(() => f.controller.existingPolicy(f.row(), result.policy)).toThrow();
    }
  );
});

describe('nullable original high DATA compatibility', () => {
  it('excludes high directly, preserving max/null encoding and every other limit without granting an ACK', async () => {
    const original = { ...policy, memoryHighBytes: null };
    const actual = {
      memoryMax: String(policy.memoryMaxBytes),
      memoryHigh: 'max',
      swapMax: '0',
      pidsMax: String(policy.pidsMax),
      cpuWeight: String(policy.cpuWeight),
      cpuMax: 'max 100000',
      cpusetCpus: '0-1',
      cpusetCpusEffective: '0-1',
      cpusetMemsEffective: '0',
    };
    expect(dockerOtherResourceLimitsMatch(actual, original)).toBe(true);
    expect(dockerOtherResourceLimitsMatch({ ...actual, memoryHigh: String(48 * 1024 ** 3) }, original)).toBe(true);
    expect(dockerOtherResourceLimitsMatch({ ...actual, cpuWeight: '99' }, original)).toBe(false);
    expect(
      dockerRevisedPolicy(original, {
        revision: '44444444-4444-4444-8444-444444444444',
        owner: null,
        scope: 'all-current-and-future',
        memoryHighBytes: 48 * 1024 ** 3,
      })
    ).toEqual({ ...policy, memoryHighBytes: 48 * 1024 ** 3 });
    const f = fixture();
    await expect(f.controller.validate(f.row().original, original)).rejects.toThrow('FINITE_HIGH_REQUIRED');
    expect(f.creates).toEqual([]);
    expect(f.starts).toEqual([]);
  });
});

describe('independent high-only helper capability and final native freshness', () => {
  it('old baseline helper remains valid for read/adoption but cannot be reused for a live high writer', async () => {
    const f = await revisionFixture(false);
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'WRITE_UNSUPPORTED'
    );
    expect(f.creates).toHaveLength(3);
    expect(f.starts).toHaveLength(3);
    expect(f.store.attempt(f.row(), f.desired.revision)).toBeUndefined();
    f.setHigh(48 * 1024 ** 3);
    expect((await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).state).toBe('observed');
    expect(f.starts).toHaveLength(3);
  });
  it.each(['read', 'profile'] as const)(
    'post-ACK %s reprobes actual limits and revokes previously held proof references',
    async (path) => {
      const f = await revisionFixture();
      const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
      const prior = f.controller.existingPolicy(f.row(), result.policy),
        paused = f.pauseRevisionAck();
      const pending = path === 'read' ? f.controller.read(f.row()) : f.controller.observeMemoryHigh(f.row(), f.current);
      await paused.entered;
      f.setHigh(32 * 1024 ** 3);
      paused.release();
      if (path === 'read') await expect(pending).rejects.toThrow('REVISION');
      else expect(await pending).toMatchObject({ actualMemoryHighBytes: 32 * 1024 ** 3, approved: false });
      expect(() => f.controller.existingPolicy(f.row(), result.policy)).toThrow();
      expect(() => requireDockerEffectiveResourceProof(prior, f.row(), result.policy)).toThrow();
    }
  );
});

describe('legacy namespace and writer pin upgrade isolation', () => {
  it('selecting an independent new writer leaves exact old anchor/pool/leaf configurations and ACKs intact', async () => {
    const old = fixture(),
      next = fixture('b'.repeat(64), undefined, writer);
    for (const f of [old, next]) {
      await f.controller.preparePool(f.row(), f.current);
      await f.setPool();
      f.makeWorker();
      await f.controller.configure(f.row(), f.current);
      expect(await f.controller.read(f.row())).toEqual(policy);
    }
    expect(next.configurations).toEqual(old.configurations);
    expect(next.names).toEqual(old.names);
    expect(next.tasks).toEqual(old.tasks);
    expect(next.configurations.every((item) => item.config.Image === helper)).toBe(true);
  });
  it('a changed writer pin during capability await refuses before a writer cursor or CREATE', async () => {
    const f = await revisionFixture();
    f.beforeNextImage(() => f.changeWritePin('sha256:' + '9'.repeat(64)));
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'REVISION_CHANGED'
    );
    expect(f.creates).toHaveLength(3);
    expect(f.starts).toHaveLength(3);
    expect(f.store.attempt(f.row(), f.desired.revision)).toBeUndefined();
  });
  it('a changed pin revokes an already held proof and restoring the string cannot resurrect it', async () => {
    const f = await revisionFixture();
    const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    const proof = f.controller.existingPolicy(f.row(), result.policy);
    f.changeWritePin('sha256:' + '9'.repeat(64));
    expect(() => requireDockerEffectiveResourceProof(proof, f.row(), result.policy)).toThrow('PROOF_CHANGED');
    f.changeWritePin(writer);
    expect(() => requireDockerEffectiveResourceProof(proof, f.row(), result.policy)).toThrow('PROOF_CHANGED');
  });
});

describe('effective policy proof clock denial', () => {
  it.each([Number.NaN, -1])('a nonfinite/rolled-back clock %s permanently revokes that proof', async (now) => {
    const f = await revisionFixture(),
      result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    const proof = f.controller.existingPolicy(f.row(), result.policy),
      clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    try {
      expect(() => requireDockerEffectiveResourceProof(proof, f.row(), result.policy)).toThrow('PROOF_CHANGED');
    } finally {
      clock.mockRestore();
    }
    expect(() => requireDockerEffectiveResourceProof(proof, f.row(), result.policy)).toThrow('PROOF_CHANGED');
  });
});

describe('terminal high-only writer closure without invented ACK or replay', () => {
  it('lost START and ACK may close independently and adopt actual48; original cursor remains unknown', async () => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow('lost start');
    const original = f.store.attempt(f.row(), f.desired.revision)!;
    f.corruptLatestLog();
    const effects = { creates: [...f.creates], starts: [...f.starts] };
    f.changeWritePin(undefined); // Retained canonical issued image is read authority, not a new write selection.
    const result = await f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current);
    expect(result).toMatchObject({
      state: 'observed',
      writerClosed: true,
      originalOutcome: 'unknown',
      actualMemoryHighBytes: 48 * 1024 ** 3,
      enforcement: 'fresh-native-readback',
      allowedActions: [],
    });
    const after = f.store.attempt(f.row(), f.desired.revision)!;
    expect(after.state).toBe('observed-after-closure');
    expect('task' in after && after.task).toEqual('task' in original && original.task);
    expect('task' in after && after.task.phase).toBe('start-issued');
    expect(await f.controller.read(f.row())).toEqual({ ...policy, memoryHighBytes: 48 * 1024 ** 3 });
    expect({ creates: f.creates, starts: f.starts }).toEqual(effects);
  });
  it('known nonzero terminal leaves old outcome unknown and permits only a new explicit revision/writer', async () => {
    const f = await revisionFixture();
    f.failHelper('leaf-helper');
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'HELPER_FAILED'
    );
    f.setHigh(16 * 1024 ** 3);
    const original = f.store.attempt(f.row(), f.desired.revision)!;
    expect(await f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).toMatchObject({
      state: 'closed-writer',
      originalOutcome: 'unknown',
      enforcement: 'not-observed',
      allowedActions: ['reconcile', 'new-revision'],
    });
    const count = f.starts.length;
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'NEW_REVISION_REQUIRED'
    );
    expect(f.starts).toHaveLength(count);
    const next = { ...f.desired, revision: '55555555-5555-4555-8555-555555555555' };
    await f.store.approve(next, f.desired.revision, f.current);
    f.failHelper('');
    expect((await f.controller.reviseMemoryHigh(f.row(), next.revision, f.current)).state).toBe('applied');
    expect(f.starts).toHaveLength(count + 1);
    const previous = f.store.history(f.row())[0]!.attempt;
    expect(previous.state).toBe('closed-writer');
    expect('task' in previous && previous.task).toEqual('task' in original && original.task);
  });
  it.each([
    'running',
    'created',
    'restarting',
    'wrong-image',
    'wrong-config',
    'foreign-mount',
    'wrong-command',
    'changed-pid',
  ] as const)('%s cannot earn NoFutureWriter or another START', async (kind) => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    const before = f.store.attempt(f.row(), f.desired.revision),
      starts = [...f.starts],
      creates = [...f.creates];
    f.mutateRevisionHelper((raw) => {
      const state = raw.State as Record<string, unknown>,
        host = raw.HostConfig as Record<string, unknown>;
      if (kind === 'running') {
        state.Status = 'running';
        state.Running = true;
        state.Pid = 300;
      }
      if (kind === 'created') state.Status = 'created';
      if (kind === 'restarting') state.Restarting = true;
      if (kind === 'wrong-image') raw.Image = 'sha256:' + '9'.repeat(64);
      if (kind === 'wrong-config') host.RestartPolicy = { Name: 'always', MaximumRetryCount: 0 };
      if (kind === 'foreign-mount')
        (raw.Mounts as unknown[]).push({ Type: 'bind', Source: '/foreign', Destination: '/foreign', RW: true });
      if (kind === 'wrong-command') (raw.Config as { Cmd: string[] }).Cmd.push('--unapproved');
      if (kind === 'changed-pid') state.Pid = 99;
    });
    await expect(f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    expect(f.store.attempt(f.row(), f.desired.revision)).toEqual(before);
    expect(f.starts).toEqual(starts);
    expect(f.creates).toEqual(creates);
  });
  it('closed old writer is freshly checked again before a new revision can dispatch', async () => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    f.setHigh(16 * 1024 ** 3);
    await f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current);
    const next = { ...f.desired, revision: '55555555-5555-4555-8555-555555555555' };
    await f.store.approve(next, f.desired.revision, f.current);
    f.mutateRevisionHelper((raw) => {
      (raw.State as Record<string, unknown>).Running = true;
    });
    const before = [...f.starts];
    await expect(f.controller.reviseMemoryHigh(f.row(), next.revision, f.current)).rejects.toThrow();
    expect(f.starts).toEqual(before);
    expect(f.store.attempt(f.row(), next.revision)).toBeUndefined();
  });
});

describe('closed-writer finalization and currentness', () => {
  it('lost durable closure finalizer retains full closed state; fresh reader independently adopts without START replay', async () => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    const starts = [...f.starts],
      nativeRename = fs.renameSync,
      nativeSync = fs.fsyncSync;
    let renamed = false;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      nativeRename(...args);
      renamed = true;
    });
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      nativeSync(fd);
      if (renamed) throw Error('lost closure finalize');
    });
    await expect(f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'lost closure'
    );
    rename.mockRestore();
    sync.mockRestore();
    expect(() => f.store.attempt(f.row(), f.desired.revision)).toThrow('PUBLICATION_UNCONFIRMED');
    const fresh = new DockerResourceRevisionStore(f.store.directory);
    revisionCleanups.push(() => fresh.close());
    expect(fresh.attempt(f.row(), f.desired.revision)?.state).toBe('closed-writer');
    expect((await f.withRevisions(fresh).reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).state).toBe(
      'observed'
    );
    expect(f.starts).toEqual(starts);
  });
  it('a helper which changes from exited to running across the native probe cannot close', async () => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    let checks = 0;
    f.beforeRun((args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        const attempt = f.store.attempt(f.row(), f.desired.revision)!;
        if (
          'task' in attempt &&
          'containerId' in attempt.task &&
          args[2] === attempt.task.containerId &&
          ++checks === 3
        )
          f.mutateRevisionHelper((raw) => {
            (raw.State as Record<string, unknown>).Running = true;
          });
      }
    });
    await expect(f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    expect(f.store.attempt(f.row(), f.desired.revision)?.state).toBe('helper');
  });
  it('revoked actor during retained image validation cannot publish closure', async () => {
    const f = await revisionFixture();
    f.loseStart();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    f.beforeNextImage(f.revoke);
    await expect(f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow('revoked');
    expect(f.store.attempt(f.row(), f.desired.revision)?.state).toBe('helper');
  });
});

it('does not report approved CPU facts when the actual native leaf weight changes', async () => {
  const f = fixture();
  await f.controller.preparePool(f.row(), f.current);
  await f.setPool();
  f.makeWorker();
  await f.controller.configure(f.row(), f.current);
  f.driftWeight();
  const starts = [...f.starts];
  await expect(f.controller.observeMemoryHigh(f.row(), f.current)).rejects.toThrow('OTHER_LIMIT_CHANGED');
  expect(f.starts).toEqual(starts);
});

describe('preSTART continuation and canonical intent retirement', () => {
  it.each(['create-issued', 'created'] as const)(
    '%s continuation uses only the original admitted task and one first START',
    async (phase) => {
      const f = await revisionFixture();
      if (phase === 'create-issued') f.loseCreate();
      else {
        let failed = false;
        f.beforeRun((args) => {
          if (!failed && args[0] === 'container' && args[1] === 'inspect') {
            const a = f.store.attempt(f.row(), f.desired.revision);
            if (a?.state === 'helper' && a.task.phase === 'created') {
              failed = true;
              throw Error('lost preSTART read');
            }
          }
        });
      }
      await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
      const attempt = f.store.attempt(f.row(), f.desired.revision)!;
      expect(attempt.state === 'helper' && attempt.task.phase).toBe(phase);
      const creates = f.creates.length,
        starts = f.starts.length;
      const result = await f.controller.continueMemoryHigh(f.row(), f.desired.revision, f.current);
      expect(result.state).toBe('applied');
      expect(f.creates).toHaveLength(creates);
      expect(f.starts).toHaveLength(starts + 1);
      await expect(f.controller.continueMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
        'CONTINUATION_NOT_ALLOWED'
      );
      expect(f.starts).toHaveLength(starts + 1);
    }
  );
  it('definitive CREATE rejection retires the unknown cursor and admits a new explicit revision without replay', async () => {
    const f = await revisionFixture();
    f.rejectNextCreate();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'CREATE rejected'
    );
    const original = f.store.attempt(f.row(), f.desired.revision)!;
    expect(f.store.actions(f.row(), f.desired.revision)).toEqual(['continue-original', 'abandon-original']);
    const count = { creates: f.creates.length, starts: f.starts.length };
    expect(await f.controller.abandonMemoryHigh(f.row(), f.desired.revision, f.current)).toMatchObject({
      state: 'unstarted-retired',
      intentRetired: true,
      originalOutcome: 'unknown',
      enforcement: 'not-observed',
    });
    expect(f.creates).toHaveLength(count.creates);
    expect(f.starts).toHaveLength(count.starts);
    const retired = f.store.attempt(f.row(), f.desired.revision)!;
    expect('task' in retired && retired.task).toEqual('task' in original && original.task);
    const next = { ...f.desired, revision: '55555555-5555-4555-8555-555555555555' };
    await f.store.approve(next, f.desired.revision, f.current);
    expect((await f.controller.reviseMemoryHigh(f.row(), next.revision, f.current)).state).toBe('applied');
    expect(f.creates).toHaveLength(count.creates + 1);
    expect(f.starts).toHaveLength(count.starts + 1);
  });
  it('late original CREATE can leave an inert orphan but its callback cannot publish START after retirement', async () => {
    const f = await revisionFixture(),
      paused = f.pauseNextCreate();
    const original = f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    const observed = original.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    await paused.entered;
    const starts = [...f.starts];
    await f.controller.abandonMemoryHigh(f.row(), f.desired.revision, f.current);
    paused.release();
    expect((await observed).ok).toBe(false);
    expect(f.starts).toEqual(starts);
    expect(f.store.attempt(f.row(), f.desired.revision)?.state).toBe('unstarted-retired');
    f.setHigh(48 * 1024 ** 3);
    expect(await f.controller.reconcileMemoryHigh(f.row(), f.desired.revision, f.current)).toMatchObject({
      state: 'observed',
      intentRetired: true,
      enforcement: 'fresh-native-readback',
    });
    expect(f.starts).toEqual(starts);
    expect(await f.controller.read(f.row())).toEqual({ ...policy, memoryHighBytes: 48 * 1024 ** 3 });
  });
  it('a created orphan which actually runs cannot be retired or authorize a new writer', async () => {
    const f = await revisionFixture();
    f.loseCreate();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    f.mutateRevisionHelper((raw) => {
      raw.State = { Status: 'running', Running: true, Pid: 300, Paused: false, Restarting: false, Dead: false };
    });
    const before = f.store.attempt(f.row(), f.desired.revision)!;
    await expect(f.controller.abandonMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    expect(f.store.attempt(f.row(), f.desired.revision)).toEqual(before);
  });
});

describe('preSTART retirement versus an admitted continuation', () => {
  it('retirement wins the created-task CAS and poisons a paused original START publication', async () => {
    const f = await revisionFixture();
    f.loseCreate();
    await expect(f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow();
    let enter!: () => void,
      release!: () => void,
      held = false;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    f.beforeRun(async (args) => {
      const a = f.store.attempt(f.row(), f.desired.revision);
      if (
        !held &&
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        a?.state === 'helper' &&
        a.task.phase === 'created'
      ) {
        held = true;
        enter();
        await wait;
      }
    });
    const pending = f.controller.continueMemoryHigh(f.row(), f.desired.revision, f.current).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    await entered;
    const starts = [...f.starts];
    expect((await f.controller.abandonMemoryHigh(f.row(), f.desired.revision, f.current)).state).toBe(
      'unstarted-retired'
    );
    release();
    expect((await pending).ok).toBe(false);
    expect(f.starts).toEqual(starts);
    expect(f.store.attempt(f.row(), f.desired.revision)?.state).toBe('unstarted-retired');
  });
});

describe('retired CREATE versus a new authorized revision', () => {
  it('a new writer may finish before the old CREATE reply; the retained old orphan never starts', async () => {
    const f = await revisionFixture(),
      paused = f.pauseNextCreate();
    const old = f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    await paused.entered;
    await f.controller.abandonMemoryHigh(f.row(), f.desired.revision, f.current);
    const next = { ...f.desired, revision: '55555555-5555-4555-8555-555555555555' };
    await f.store.approve(next, f.desired.revision, f.current);
    expect((await f.controller.reviseMemoryHigh(f.row(), next.revision, f.current)).state).toBe('applied');
    const starts = [...f.starts];
    paused.release();
    expect((await old).ok).toBe(false);
    expect(f.starts).toEqual(starts);
    expect((await f.controller.read(f.row()))?.memoryHighBytes).toBe(48 * 1024 ** 3);
    expect(f.store.history(f.row())[0]!.attempt.state).toBe('unstarted-retired');
  });
});

describe('unstarted retirement publication finalizer', () => {
  it('a lost retirement finalizer fences the paused CREATE callback and a fresh reader can adopt independently', async () => {
    const f = await revisionFixture(),
      paused = f.pauseNextCreate();
    const old = f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    await paused.entered;
    const starts = [...f.starts],
      renameNative = fs.renameSync,
      syncNative = fs.fsyncSync;
    let renamed = false;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      renameNative(...args);
      renamed = true;
    });
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      syncNative(fd);
      if (renamed) throw Error('lost retirement finalizer');
    });
    await expect(f.controller.abandonMemoryHigh(f.row(), f.desired.revision, f.current)).rejects.toThrow(
      'retirement finalizer'
    );
    rename.mockRestore();
    sync.mockRestore();
    paused.release();
    expect((await old).ok).toBe(false);
    expect(f.starts).toEqual(starts);
    const fresh = new DockerResourceRevisionStore(f.store.directory);
    revisionCleanups.push(() => fresh.close());
    expect(fresh.attempt(f.row(), f.desired.revision)?.state).toBe('unstarted-retired');
    f.setHigh(48 * 1024 ** 3);
    const result = await f.withRevisions(fresh).reconcileMemoryHigh(f.row(), f.desired.revision, f.current);
    expect(result).toMatchObject({ state: 'observed', intentRetired: true, originalOutcome: 'unknown' });
    expect(result).not.toHaveProperty('writerClosed');
    expect(f.starts).toEqual(starts);
  });
});

describe('capacity refusal before any helper publication/effect', () => {
  it.each([false, true])('fresh actual matching policy=%s cannot bypass the ledger byte budget', async (matching) => {
    const f = await revisionFixture();
    if (matching) f.setHigh(48 * 1024 ** 3);
    const state = { ...resourceCapacityHistory(f.desired, matching ? 50 : 1024), version: 2 as const };
    fs.writeFileSync(join(f.store.directory, 'revisions.json'), JSON.stringify(state));
    const before = { creates: [...f.creates], starts: [...f.starts] };
    let error: unknown;
    try {
      await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    } catch (cause) {
      error = cause;
    }
    expect(dockerAttemptPublicationRefusal(error)).toMatchObject({
      action: 'apply',
      publication: 'not-issued',
      revision: f.desired.revision,
    });
    expect(f.creates).toEqual(before.creates);
    expect(f.starts).toEqual(before.starts);
    expect(f.store.attempt(f.row(), f.desired.revision)).toBeUndefined();
  });
});

describe('capacity-limited read-only adoption', () => {
  it('still adopts genuine matching facts when only an entire helper reservation would be too large', async () => {
    const f = await revisionFixture();
    f.setHigh(48 * 1024 ** 3);
    fs.writeFileSync(
      join(f.store.directory, 'revisions.json'),
      JSON.stringify({ ...resourceCapacityHistory(f.desired, 4096), version: 2 })
    );
    const before = { creates: [...f.creates], starts: [...f.starts] };
    const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    expect(result.state).toBe('observed');
    expect(f.creates).toEqual(before.creates);
    expect(f.starts).toEqual(before.starts);
  });
});

describe('read-owned effective resource proofs', () => {
  it('retains an unchanged original read across profile and concurrent native reads without new effects', async () => {
    const f = await revisionFixture();
    await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    const effects = { creates: [...f.creates], starts: [...f.starts], tasks: structuredClone([...f.tasks]) };
    const actual = (await f.controller.read(f.row()))!;
    const proof = f.controller.existingPolicy(f.row(), actual);
    const engine = new DockerEmployeeEngine(
      f.command,
      deployment,
      f.controller,
      {
        imageId: f.row().workerImage.imageId,
        clientManifestDigest: 'a'.repeat(64),
        sourceImageIds: [f.row().workerImage.imageId],
      },
      f.journal,
      helper,
      'b'.repeat(64)
    );
    expect(engine.existingResourcePolicyCurrent(f.row(), actual)).toBe(true);
    await f.controller.observeMemoryHigh(f.row(), f.current);
    expect(() => requireDockerEffectiveResourceProof(proof, f.row(), actual)).not.toThrow();
    expect(engine.existingResourcePolicyCurrent(f.row(), actual)).toBe(true);
    const paused = f.pauseRevisionAck();
    const pending = f.controller.read(f.row());
    await paused.entered;
    expect(engine.existingResourcePolicyCurrent(f.row(), actual)).toBe(true);
    paused.release();
    const second = (await pending)!;
    expect(second).toEqual(actual);
    expect(second).not.toBe(actual);
    expect(engine.existingResourcePolicyCurrent(f.row(), actual)).toBe(true);
    expect(engine.existingResourcePolicyCurrent(f.row(), second)).toBe(true);
    expect(() => engine.existingResourcePolicyCurrent(f.row(), structuredClone(actual))).toThrow('PROOF_REQUIRED');
    expect({ creates: [...f.creates], starts: [...f.starts], tasks: structuredClone([...f.tasks]) }).toEqual(effects);
    engine.close();
  });
  it('keeps the five-second proof deadline despite unchanged reads and rejects later native identity drift', async () => {
    const f = await revisionFixture();
    const result = await f.controller.reviseMemoryHigh(f.row(), f.desired.revision, f.current);
    const proof = f.controller.existingPolicy(f.row(), result.policy);
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 5001);
    try {
      expect(() => requireDockerEffectiveResourceProof(proof, f.row(), result.policy)).toThrow('PROOF_CHANGED');
    } finally {
      clock.mockRestore();
    }
    const read = (await f.controller.read(f.row()))!;
    const fresh = f.controller.existingPolicy(f.row(), read);
    f.driftEpoch();
    await expect(f.controller.observeMemoryHigh(f.row(), f.current)).rejects.toThrow();
    expect(() => requireDockerEffectiveResourceProof(fresh, f.row(), read)).toThrow('PROOF_CHANGED');
  });
});
