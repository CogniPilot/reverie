/** Controlled physical Docker port shared by native-resource and metadata-only
 * reconciliation tests. Real decision owners run; no Engine/socket is used. */
import { expect } from 'vitest';
import type { DockerResourceRevisionStore } from '../../src/docker-resource-revisions.js';
export const writer = 'sha256:' + 'f'.repeat(64);
/** The separately pinned pool restore helper image. */
export const restorer = 'sha256:' + 'c1'.repeat(32);
import { readFileSync } from 'node:fs';
import type { DockerResourceRepairJournal } from '../../src/docker-resource-repair-journal.js';
import { isDeepStrictEqual } from 'node:util';
import { DockerContainedResources } from '../../src/docker-contained-resource-controller.js';
import {
  allowedDockerTaskTransition,
  type DockerContinuationTask,
  type DockerContinuationTaskRole,
} from '../../src/docker-continuation-task.js';
import type { DockerEmployeeContinuationRecord } from '../../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../../src/docker-engine-command.js';
import { classifyDockerResourceHelperFailure } from '../../src/docker-resource-helper-failure.js';
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
export function fixture(
  boxId = 'b'.repeat(64),
  revisions?: DockerResourceRevisionStore,
  writeImage?: string,
  leafWriterImage?: string,
  /** The office's repair journal and its file, with the restore helper image it may issue. */
  repair?: { journal: DockerResourceRepairJournal; path: string; restoreImage?: string }
) {
  let retained: DockerContinuationTask[] = [];
  /** What each failed helper printed, and the lines the next leaf and pool writers will print. */
  const stderr = new Map<string, string>(),
    leafFailures: string[] = [],
    poolFailures: string[] = [];
  /** The newest journaled phase of a repair writer, read from the journal's own file. */
  const repairPhase = (name: string): string | undefined => {
    if (!repair) return undefined;
    let raw: string;
    try {
      raw = readFileSync(repair.path, 'utf8');
    } catch {
      return undefined;
    }
    let phase: string | undefined;
    for (const line of raw.split('\n').filter(Boolean)) {
      const task = (JSON.parse(line) as { task?: { name: string; phase: string } }).task;
      if (task?.name === name) phase = task.phase;
    }
    return phase;
  };
  /** Whether a reload of the service manager reset what only a helper wrote to the worker's leaf. */
  let leafSwap = '0';
  let members: string[] = [];
  let parentInode = '2',
    anchorBirth = '10';
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
  const configurations: Array<{ name: string; config: Readonly<Record<string, unknown>> }> = [];
  let beforeImage: (() => void) | undefined;
  const creates: string[] = [],
    names: string[] = [],
    starts: string[] = [],
    phases: string[] = [];
  let configured = false,
    high: number | undefined,
    lostCreate = false,
    rejectCreate = false,
    lostStart = false,
    current = true,
    foreignMount = false,
    failedRole: string | undefined,
    changedHelper: { role: string; field: 'restart' | 'parent' } | undefined,
    weight = 100,
    delayLeaf = false,
    lateId: string | undefined,
    poolSwap = '0';
  /** `--member CID:PID:START` values of one command, and of the laptops that run now. */
  const declared = (args: readonly string[]) => args.filter((_value, index) => args[index - 1] === '--member');
  const live = () =>
    members
      .filter((id) => (containers.get(id)?.State as { Running?: boolean } | undefined)?.Running)
      .sort()
      .map((id) => `${id}:${(containers.get(id)!.State as { Pid: number }).Pid}:20`);
  const resources = (worker: boolean) => ({
    // Docker and systemd own a leaf's hard memory limit; only the pool's is a helper's.
    memoryMax: configured || (worker && leafSwap !== '0') ? String(policy.memoryMaxBytes) : 'max',
    memoryHigh: worker && high ? String(high) : 'max',
    swapMax: worker ? leafSwap : configured ? '0' : poolSwap,
    pidsMax: configured || (worker && leafSwap !== '0') ? String(worker ? 512 : 8192) : 'max',
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
      State: { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, Pid: 200 },
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
  /** The box's anchor, whichever container the fixture was given first. */
  const anchorId = () =>
    [...containers].find(
      ([, raw]) => (raw.Config as { Labels?: Record<string, string> }).Labels?.['reverie.box.resource.role'] === 'anchor'
    )?.[0] ?? [...containers.keys()][0]!;
  let beforeRun: ((args: readonly string[]) => void | Promise<void>) | undefined;
  let pauseLog: { entered: () => void; wait: Promise<void> } | undefined;
  /** What the laptop's own cgroup shows in its memory.stat, as a read inside it answers. */
  let memoryStat: string | Error = 'anon 1048576\nfile 4096\nshmem 0\n';
  let pauseCreate: { entered: () => void; wait: Promise<void> } | undefined;
  const command: DockerEngineCommand = {
    async create(name, config, guard) {
      guard();
      const role = (config.Labels as Record<string, string>)['reverie.box.resource.role']!;
      const revised = revisions?.desired(row.owner),
        attempt = revised ? revisions?.attempt(row, revised.revision) : undefined;
      expect(
        attempt?.state === 'helper' && attempt.task.name === name
          ? attempt.task.phase
          : (repairPhase(name) ?? tasks.get(role as DockerContinuationTaskRole)?.phase)
      ).toBe('create-issued');
      if (rejectCreate) {
        rejectCreate = false;
        throw Error('definite CREATE rejected');
      }
      if (pauseCreate) {
        const held = pauseCreate;
        pauseCreate = undefined;
        held.entered();
        await held.wait;
      }
      configurations.push({ name, config: structuredClone(config) });
      creates.push(role);
      names.push(name);
      // One repeated digit for the first nine, then a distinct padded number.
      const id =
        creates.length < 10 ? String(creates.length).repeat(64) : ('e' + String(creates.length)).padEnd(64, '0');
      const binds = (config.HostConfig as { Binds: string[] }).Binds;
      containers.set(id, {
        Id: id,
        Name: '/' + name,
        Image: config.Image,
        Config: {
          ...structuredClone(config),
          Labels: {
            'org.reverie.purpose': 'boxed-resource-helper-v1',
            ...(config.Image === writer ? { 'org.reverie.resource.memory-high-only': 'v1' } : {}),
            ...(config.Labels as Record<string, string>),
          },
        },
        HostConfig: structuredClone(config.HostConfig),
        Mounts: binds.map((value) => {
          const [Source, Destination, mode] = value.split(':');
          return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
        }),
        State: { Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0 },
      });
      if (lostCreate) {
        lostCreate = false;
        throw Error('lost create reply');
      }
      return id;
    },
    async run(args) {
      await beforeRun?.(args);
      if (args[0] === 'image') {
        const selected = beforeImage;
        beforeImage = undefined;
        selected?.();
        return JSON.stringify([
          {
            Id: args[2],
            Config: {
              User: '0:0',
              Entrypoint: ['/bin/reverie-docker-resources'],
              Labels: {
                'org.reverie.purpose': 'boxed-resource-helper-v1',
                ...(args[2] === writer ? { 'org.reverie.resource.memory-high-only': 'v1' } : {}),
                ...(args[2] === restorer ? { 'org.reverie.resource.pool-restore': 'v1' } : {}),
              },
            },
          },
        ]);
      }
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
        const every = args.flatMap((value, index) => (value === '--filter' ? [args[index + 1]!] : []));
        // As the Engine does it: several status filters are alternatives, every other filter must hold.
        const statuses = every.filter((filter) => filter.startsWith('status=')).map((filter) => filter.slice(7)),
          filters = every.filter((filter) => !filter.startsWith('status='));
        const status = (raw: Record<string, unknown>) => {
          const state = raw.State as { Status?: string; Running?: boolean; Paused?: boolean; Restarting?: boolean };
          if (state.Paused) return 'paused';
          if (state.Restarting) return 'restarting';
          return state.Running ? 'running' : (state.Status ?? 'exited');
        };
        return [...containers]
          .filter(([, raw]) => !statuses.length || statuses.includes(status(raw)))
          .filter(([id, raw]) =>
            filters.every((filter) => {
              if (filter.startsWith('id=')) return id === filter.slice(3);
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
        const revised = revisions?.desired(row.owner),
          attempt = revised ? revisions?.attempt(row, revised.revision) : undefined;
        const helperName = (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'];
        expect(
          attempt?.state === 'helper' && attempt.task.name === helperName
            ? attempt.task.phase
            : (repairPhase(helperName!) ?? tasks.get(role)?.phase)
        ).toBe('start-issued');
        starts.push(role);
        if (role === 'leaf-helper' && delayLeaf) {
          delayLeaf = false;
          lateId = id;
          raw.State = { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, Pid: 300 };
          throw Error('lost live start reply');
        }
        const command = (raw.Config as { Cmd: string[] }).Cmd;
        // What the real helper refuses by itself: a pool that has members is
        // never initialized, a restore names exactly the members that run, and
        // `configure-high` never writes a leaf whose swap limit is not approved.
        const refusal =
          command[0] === 'configure-pool' && live().length
            ? 'BOXED_RESOURCE_FOREIGN_CHILD; effectIssued=false\n'
            : command[0] === 'restore-pool' && !isDeepStrictEqual(declared(command), live())
              ? 'BOXED_RESOURCE_FOREIGN_CHILD; effectIssued=false\n'
              : command[0] === 'configure-high' && leafSwap !== '0'
                ? 'BOXED_RESOURCE_HARD_POLICY_MISMATCH; effectIssued=false\n'
                : undefined;
        const printed =
          (role === 'leaf-helper' ? leafFailures.shift() : role === 'pool-helper' ? poolFailures.shift() : undefined) ??
          refusal;
        raw.State = {
          Status: role === 'anchor' ? 'running' : 'exited',
          Running: role === 'anchor',
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: role === 'anchor' ? 100 : 0,
          ExitCode: role === failedRole || printed !== undefined ? 1 : 0,
        };
        if (printed !== undefined) {
          // A helper that failed prints its reason and no result, and may
          // have written the first limit before it stopped.
          stderr.set(id, printed);
          logs.set(id, '');
          if (printed.includes('confirmed=memory.high')) {
            const args = (raw.Config as { Cmd: string[] }).Cmd;
            high = Number(args[args.indexOf('--memory-high') + 1]);
          }
          return id;
        }
        if (role === 'pool-helper') configured = true;
        if (role === 'leaf-helper') {
          const args = (raw.Config as { Cmd: string[] }).Cmd;
          high = Number(args[args.indexOf('--memory-high') + 1]);
          if (args[0] !== 'configure-memory-high') weight = 100;
          if (args[0] === 'restore-high') leafSwap = '0';
        }
        if (role !== 'anchor') {
          const seen = observation(anchorId(), role === 'leaf-helper');
          logs.set(
            id,
            JSON.stringify(
              command[0] === 'restore-pool'
                ? {
                    version: 1,
                    purpose: 'reverie-boxed-restore-pool-ack-v1',
                    observation: seen,
                    members: declared(command).map((value) => {
                      const [member, pid, startTicks] = value.split(':');
                      return {
                        id: member,
                        pid: Number(pid),
                        startTicks,
                        path: parent + '/docker-' + member + '.scope',
                        dev: '1',
                        ino: '5',
                      };
                    }),
                  }
                : seen
            )
          );
        }
        if (lostStart) {
          lostStart = false;
          throw Error('lost start reply');
        }
        return id;
      }
      if (args[0] === 'container' && args[1] === 'wait')
        return String((containers.get(args[2]!)!.State as { ExitCode: number }).ExitCode) + '\n';
      if (args[0] === 'container' && args[1] === 'logs') {
        const raw = containers.get(args[2]!)!;
        if (pauseLog && (raw.Config as { Cmd: string[] }).Cmd[0] === 'configure-memory-high') {
          const selected = pauseLog;
          pauseLog = undefined;
          selected.entered();
          await selected.wait;
        }
        return logs.get(args[2]!)!;
      }
      if (args[0] === 'exec' && args[2] === '/bin/cat' && args[3] === '/sys/fs/cgroup/memory.stat') {
        if (memoryStat instanceof Error) throw memoryStat;
        return memoryStat;
      }
      if (args[0] === 'exec' && args[2] === '/bin/cat')
        return '1 (worker) S ' + [...Array(18).fill('0'), '20', '0'].join(' ') + '\n';
      if (args[0] === 'exec') return JSON.stringify(observation(args[1]!, args.includes('probe-worker')));
      throw Error('Unexpected fixed Docker command: ' + args.join(' '));
    },
    // The real allow-list decides; a helper that printed nothing is unknown.
    helperFailure: async (id) => classifyDockerResourceHelperFailure(stderr.get(id)),
  };
  const configuration = {
    boxId,
    deployment,
    helperImageId: helper,
    memoryHighHelperImageId: writeImage,
    leafWriterHelperImageId: leafWriterImage,
    poolRestoreHelperImageId: repair?.restoreImage,
    repairs: repair?.journal,
    selectedWorkerContainerIds: () => members,
    retainedPoolConfigurationTasks: () => retained,
  };
  const controller = new DockerContainedResources(command, journal, configuration, revisions);
  return {
    controller,
    /** What a read of the laptop's memory.stat answers from now on. */
    setMemoryStat: (value: string | Error) => {
      memoryStat = value;
    },
    withRevisions: (next: DockerResourceRevisionStore) =>
      new DockerContainedResources(command, journal, configuration, next),
    mutateRevisionHelper: (change: (raw: Record<string, unknown>) => void) => {
      const selected = [...containers.values()]
        .reverse()
        .find((raw) => (raw.Config as { Cmd?: string[] }).Cmd?.[0] === 'configure-memory-high');
      if (!selected) throw Error('No revision helper');
      change(selected);
    },
    configurations,
    changeWritePin: (image: string | undefined) => {
      configuration.memoryHighHelperImageId = image;
    },
    beforeNextImage: (hook: () => void) => {
      beforeImage = hook;
    },
    delayNextLeaf: () => {
      delayLeaf = true;
    },
    completeLateLeaf: () => {
      const raw = containers.get(lateId!)!,
        args = (raw.Config as { Cmd: string[] }).Cmd;
      high = Number(args[args.indexOf('--memory-high') + 1]);
      raw.State = {
        Status: 'exited',
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 0,
        ExitCode: 0,
      };
      logs.set(lateId!, JSON.stringify(observation([...containers.keys()][0]!, true)));
    },
    ready: () => {
      row = { ...row, phase: 'ready' };
    },
    resourcesIssued: () => {
      row = { ...row, phase: 'resources-issued' };
    },
    /** The next leaf writers exit 1 having printed these lines, in order. */
    failLeafWriters: (...lines: string[]) => {
      leafFailures.push(...lines);
    },
    /** The same for the next pool writers. */
    failPoolWriters: (...lines: string[]) => {
      poolFailures.push(...lines);
    },
    /** A reload of the host's service manager: every limit that only a helper
     * wrote is back at its default. The limits Docker owns are kept. */
    reloadServiceManager: () => {
      configured = false;
      poolSwap = 'max';
      if (containers.has(workerId)) {
        high = undefined;
        leafSwap = 'max';
      }
    },
    changeRestorePin: (image: string | undefined) => {
      configuration.poolRestoreHelperImageId = image;
    },
    /** The worker of this fixture's own record is one of the box's laptops. */
    selectWorker: () => {
      if (!members.includes(workerId)) members = [...members, workerId];
    },
    stopMember: (id: string) => {
      (containers.get(id)!.State as Record<string, unknown>).Running = false;
    },
    repairPhase,
    stderr,
    /** Another running laptop of the same box, as every later scope sees it. */
    addMember: (id: string, pid: number) => {
      containers.set(id, {
        Id: id,
        Image: row.workerImage.imageId,
        Config: { Labels: { 'reverie.boxed.instance': deployment } },
        HostConfig: { PidMode: '' },
        State: { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, Pid: pid },
      });
      members = [...members, id];
    },
    changeLeafWriterPin: (image: string | undefined) => {
      configuration.leafWriterHelperImageId = image;
    },
    setHigh: (value: number) => {
      high = value;
    },
    pauseRevisionAck: () => {
      let entered!: () => void, release!: () => void;
      const atAck = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pauseLog = { entered, wait };
      return { entered: atAck, release };
    },
    corruptLatestLog: () => {
      logs.set([...logs.keys()].at(-1)!, '{}');
    },
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
      new DockerContainedResources(
        command,
        journal,
        { ...configuration, retainedPoolConfigurationTasks: retained },
        revisions
      ),
    driftEpoch: () => {
      parentInode = '999';
      anchorBirth = '999';
    },
    requireConfigure: () => {
      configured = false;
    },
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
    revoke: () => {
      current = false;
    },
    current: () => {
      if (!current) throw Error('revoked');
    },
    rejectNextCreate: () => {
      rejectCreate = true;
    },
    pauseNextCreate: () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const wait = new Promise<void>((r) => {
        release = r;
      });
      pauseCreate = { entered: enter, wait };
      return { entered, release };
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
