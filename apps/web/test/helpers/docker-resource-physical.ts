/** Controlled physical Docker port shared by native-resource and metadata-only
 * reconciliation tests. Real decision owners run; no Engine/socket is used. */
import { expect } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { DockerContainedResources } from '../../src/docker-contained-resource-controller.js';
import {
  allowedDockerTaskTransition,
  type DockerContinuationTask,
  type DockerContinuationTaskRole,
} from '../../src/docker-continuation-task.js';
import type { DockerEmployeeContinuationRecord } from '../../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../../src/docker-engine-command.js';
export const helper = 'sha256:' + 'a'.repeat(64),
  workerId = 'd'.repeat(64);
export const deployment = 'synthetic-box';
export const policy = {
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
export function fixture(boxId = 'b'.repeat(64)) {
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
  let beforeRun: ((args: readonly string[]) => void | Promise<void>) | undefined;
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
      await beforeRun?.(args);
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
        const filters = args.flatMap((value, index) => (value === '--filter' ? [args[index + 1]!] : []));
        return [...containers]
          .filter(([, raw]) =>
            filters.every((filter) => {
              if (!filter.startsWith('label=')) throw Error('Unexpected fixture census');
              const [key, ...rest] = filter.slice(6).split('=');
              return (raw.Config as { Labels?: Record<string, string> }).Labels?.[key!] === rest.join('=');
            })
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
    command,
    journal,
    beforeRun: (run: ((args: readonly string[]) => void | Promise<void>) | undefined) => {
      beforeRun = run;
    },
    controllerWith: (retained: () => readonly DockerContinuationTask[]) =>
      new DockerContainedResources(command, journal, {
        boxId,
        deployment,
        helperImageId: helper,
        selectedWorkerContainerIds: () => [],
        retainedPoolConfigurationTasks: retained,
      }),
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
