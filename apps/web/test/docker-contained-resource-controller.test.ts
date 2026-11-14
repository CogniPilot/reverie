import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { retainedDockerPoolTasks } from '../src/docker-shared-pool-lineage.js';
import { DockerEmployeeContinuationRecord as ContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { isDeepStrictEqual } from 'node:util';
import { DockerContainedResources } from '../src/docker-contained-resource-controller.js';
import {
  allowedDockerTaskTransition,
  type DockerContinuationTask,
  type DockerContinuationTaskRole,
} from '../src/docker-continuation-task.js';
import type { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';

const helper = 'sha256:' + 'a'.repeat(64),
  workerId = 'd'.repeat(64);
const deployment = 'synthetic-box';
const policy = {
  memoryMaxBytes: 48 * 1024 ** 3,
  memoryHighBytes: 16 * 1024 ** 3,
  swapMaxBytes: 0,
  pidsMax: 512,
  cpuWeight: 100,
  allowedCpus: [0, 1],
  pool: {
    memoryMaxBytes: 48 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 8192,
    cpuWeight: 100,
    allowedCpus: [0, 1],
  },
};
function fixture(boxId = 'b'.repeat(64)) {
  let retained: DockerContinuationTask[] = [];
  const parent = `/reverie.slice/reverie-box.slice/reverie-box-${boxId}.slice`;
  let row = {
    employeeId: '11111111-1111-4111-8111-111111111111',
    request: {
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      sessionGeneration: 9,
    },
    policy,
    workerImage: { imageId: 'sha256:' + 'e'.repeat(64) },
    destination: { containerId: workerId },
  } as unknown as DockerEmployeeContinuationRecord;
  const tasks = new Map<DockerContinuationTaskRole, DockerContinuationTask>();
  const containers = new Map<string, Record<string, unknown>>();
  const logs = new Map<string, string>();
  const creates: string[] = [],
    names: string[] = [],
    starts: string[] = [],
    phases: string[] = [];
  let parentInode = '2',
    anchorBirth = '10';
  let configured = false,
    high = false,
    lostCreate = false,
    lostStart = false,
    current = true,
    foreignMount = false,
    failedRole: string | undefined,
    changedHelper: { role: string; field: 'restart' | 'parent' } | undefined,
    weight = 100;
  const resources = (worker: boolean) => ({
    memoryMax: configured ? String(policy.memoryMaxBytes) : 'max',
    memoryHigh: worker && high ? String(policy.memoryHighBytes) : 'max',
    swapMax: '0',
    pidsMax: configured ? String(worker ? 512 : 8192) : 'max',
    cpuWeight: String(worker ? weight : 100),
    cpuMax: 'max 100000',
    cpusetCpus: '0-1',
    cpusetCpusEffective: '0-1',
    cpusetMemsEffective: '0',
  });
  const observation = (anchor: string, worker: boolean) => ({
    version: 1,
    purpose: 'reverie-boxed-resource-observation-v1',
    boxId,
    parent: { path: parent, dev: '1', ino: parentInode },
    anchor: {
      id: anchor,
      pid: 100,
      startTicks: anchorBirth,
      path: parent + '/docker-' + anchor + '.scope',
      dev: '1',
      ino: '3',
    },
    worker: worker
      ? {
          id: workerId,
          pid: 200,
          startTicks: '20',
          path: parent + '/docker-' + workerId + '.scope',
          dev: '1',
          ino: '4',
        }
      : null,
    resources: resources(worker),
  });
  const makeWorker = () =>
    containers.set(workerId, {
      Id: workerId,
      Image: row.workerImage.imageId,
      Config: {
        Labels: {
          'reverie.boxed.instance': deployment,
          'reverie.boxed.employee': row.employeeId,
          'reverie.boxed.session': row.request.sessionId,
          'reverie.boxed.generation': '9',
          'reverie.boxed.operation': row.request.operationId,
        },
      },
      HostConfig: { PidMode: '' },
      State: {
        Status: 'running',
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 200,
      },
    });
  const journal = {
    read: (_row: DockerEmployeeContinuationRecord, role: DockerContinuationTaskRole) => tasks.get(role),
    async publish(
      _row: DockerEmployeeContinuationRecord,
      before: DockerContinuationTask | undefined,
      next: DockerContinuationTask,
      guard: () => void
    ) {
      guard();
      expect(isDeepStrictEqual(tasks.get(next.role), before)).toBe(true);
      expect(allowedDockerTaskTransition(before, next)).toBe(true);
      phases.push(next.role + ':' + next.phase);
      tasks.set(next.role, structuredClone(next));
      return row;
    },
  };
  const command: DockerEngineCommand = {
    async create(name, config, guard) {
      guard();
      const role = (config.Labels as Record<string, string>)['reverie.box.resource.role']!;
      expect(tasks.get(role as DockerContinuationTaskRole)?.phase).toBe('create-issued');
      creates.push(role);
      names.push(name);
      const id = String(creates.length).repeat(64);
      const binds = (config.HostConfig as { Binds: string[] }).Binds;
      containers.set(id, {
        Id: id,
        Image: helper,
        Config: structuredClone(config),
        HostConfig: structuredClone(config.HostConfig),
        Mounts: binds.map((value) => {
          const [Source, Destination, mode] = value.split(':');
          return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
        }),
        State: {
          Status: 'created',
          Running: false,
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: 0,
        },
      });
      if (lostCreate) {
        lostCreate = false;
        throw Error('lost create reply');
      }
      return id;
    },
    async run(args) {
      if (args[0] === 'image') return JSON.stringify([{ Id: helper }]);
      if (args[0] === 'container' && args[1] === 'inspect') {
        const value = structuredClone(containers.get(args[2]!)!);
        if (
          changedHelper &&
          (value.Config as { Labels?: Record<string, string> }).Labels?.['reverie.box.resource.role'] ===
            changedHelper.role
        ) {
          const host = value.HostConfig as Record<string, unknown>;
          if (changedHelper.field === 'restart') host.RestartPolicy = { Name: 'always', MaximumRetryCount: 0 };
          else host.CgroupParent = 'legacy.slice';
        }
        if (foreignMount && args[2] !== workerId)
          (value.Mounts as unknown[]).push({
            Type: 'bind',
            Source: '/synthetic-engine',
            Destination: '/run/reverie-engine/docker.sock',
            RW: true,
          });
        return JSON.stringify([value]);
      }
      if (args[0] === 'container' && args[1] === 'ls') {
        const name = args[args.indexOf('--filter') + 1]!.split('=').slice(1).join('=');
        return [...containers]
          .filter(
            ([, raw]) =>
              (raw.Config as { Labels?: Record<string, string> }).Labels?.['reverie.box.resource.name'] === name
          )
          .map(([id]) => id)
          .join('\n');
      }
      if (args[0] === 'container' && args[1] === 'start') {
        const id = args[2]!,
          raw = containers.get(id)!;
        const role = (raw.Config as { Labels: Record<string, string> }).Labels[
          'reverie.box.resource.role'
        ] as DockerContinuationTaskRole;
        expect(tasks.get(role)?.phase).toBe('start-issued');
        starts.push(role);
        raw.State = {
          Status: role === 'anchor' ? 'running' : 'exited',
          Running: role === 'anchor',
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: role === 'anchor' ? 100 : 0,
          ExitCode: role === failedRole ? 1 : 0,
        };
        if (role === 'pool-helper') configured = true;
        if (role === 'leaf-helper') {
          high = true;
          weight = 100;
        }
        if (role !== 'anchor')
          logs.set(id, JSON.stringify(observation([...containers.keys()][0]!, role === 'leaf-helper')));
        if (lostStart) {
          lostStart = false;
          throw Error('lost start reply');
        }
        return id;
      }
      if (args[0] === 'container' && args[1] === 'wait')
        return String((containers.get(args[2]!)!.State as { ExitCode: number }).ExitCode) + '\n';
      if (args[0] === 'container' && args[1] === 'logs') return logs.get(args[2]!)!;
      if (args[0] === 'exec' && args[2] === '/bin/cat')
        return '1 (worker) S ' + [...Array(18).fill('0'), '20', '0'].join(' ') + '\n';
      if (args[0] === 'exec') return JSON.stringify(observation(args[1]!, args.includes('probe-worker')));
      throw Error('Unexpected fixed Docker command: ' + args.join(' '));
    },
  };
  const controller = new DockerContainedResources(command, journal, {
    boxId,
    deployment,
    helperImageId: helper,
    selectedWorkerContainerIds: () => [],
    retainedPoolConfigurationTasks: () => retained,
  });
  return {
    controller,
    row: () => row,
    setPool: async () => {
      row = { ...row, pool: (await controller.observePool(row))! };
    },
    makeWorker,
    creates,
    names,
    starts,
    phases,
    tasks,
    retain: (values: DockerContinuationTask[]) => {
      retained = structuredClone(values);
    },
    containers,
    logs,
    driftEpoch: () => {
      parentInode = '999';
      anchorBirth = '999';
    },
    requireConfigure: () => {
      configured = false;
    },
    revoke: () => {
      current = false;
    },
    current: () => {
      if (!current) throw Error('revoked');
    },
    loseCreate: () => {
      lostCreate = true;
    },
    loseStart: () => {
      lostStart = true;
    },
    foreignMount: () => {
      foreignMount = true;
    },
    driftWeight: () => {
      weight = 39;
    },
    failHelper: (role: string) => {
      failedRole = role;
    },
    changeHelper: (role: string, field: 'restart' | 'parent') => {
      changedHelper = { role, field };
    },
  };
}
describe('fixed Docker resource orchestration', () => {
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
