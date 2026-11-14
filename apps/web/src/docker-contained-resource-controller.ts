/** Docker-only orchestration of the fixed Rust resource helper. Canonical task
 * cursors precede create/start; a failed reply never authorizes a second effect. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type {
  DockerEmployeeContinuationRecord,
  DockerEmployeeOriginal,
  DockerEmployeeResourcePolicy,
  DockerEmployeePool,
} from './docker-employee-continuation-data.js';
import type { DockerContainedResourceController } from './docker-employee-engine.js';
import {
  DockerContinuationTask,
  type DockerContinuationTaskJournal,
  type DockerContinuationTaskRole,
} from './docker-continuation-task.js';
import type { DockerEngineCommand } from './docker-engine-command.js';

const cid = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const processIdentity = z
  .object({
    id: cid,
    pid: z.number().int().positive().safe(),
    startTicks: decimal,
    path: z.string().max(4096),
    dev: decimal,
    ino: decimal,
  })
  .strict();
const observation = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-resource-observation-v1'),
    boxId: cid,
    parent: z.object({ path: z.string().max(4096), dev: decimal, ino: decimal }).strict(),
    anchor: processIdentity,
    worker: processIdentity.nullable(),
    resources: z
      .object({
        memoryMax: z.string(),
        memoryHigh: z.string(),
        swapMax: z.string(),
        pidsMax: z.string(),
        cpuWeight: decimal,
        cpuMax: z.string().max(128),
        cpusetCpus: z.string().max(4096),
        cpusetCpusEffective: z.string().max(4096),
        cpusetMemsEffective: z.string().max(4096),
      })
      .strict(),
  })
  .strict();
type Observation = z.infer<typeof observation>;
type Config = Readonly<Record<string, unknown>>;
type Init = { id: string; pid: number; startTicks: string };
export interface DockerContainedResourcesConfiguration {
  readonly boxId: string;
  readonly deployment: string;
  readonly helperImageId: string;
  /** Canonical selected bindings AND retained destinations. These IDs are DATA;
   * Engine/current kernel observations must independently validate every one. */
  selectedWorkerContainerIds(): readonly string[];
  /** Original issued pool helpers from the canonical operation journal, for
   * later employees sharing the same actually acknowledged pool. */
  retainedPoolConfigurationTasks?(): readonly DockerContinuationTask[];
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
function cpus(raw: string): number[] {
  if (!raw || raw.length > 4096) refuse('DOCKER_RESOURCE_CPUSET_UNKNOWN');
  const result: number[] = [];
  for (const segment of raw.split(',')) {
    const match = /^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/.exec(segment);
    if (!match) refuse('DOCKER_RESOURCE_CPUSET_UNKNOWN');
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (last < first || last > 4095 || (result.length && first <= result[result.length - 1]!))
      refuse('DOCKER_RESOURCE_CPUSET_UNKNOWN');
    for (let value = first; value <= last; value++) result.push(value);
  }
  return result;
}
function startTicks(raw: string): string {
  // Linux comm may contain spaces and ')'; the fields follow its final ')'.
  if (raw.length > 4096 || !raw.startsWith('1 (')) refuse('DOCKER_RESOURCE_INIT_UNKNOWN');
  const value = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  if (!value || !/^[1-9][0-9]{0,19}$/.test(value)) refuse('DOCKER_RESOURCE_INIT_UNKNOWN');
  return value;
}
function canonicalCpus(values: readonly number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const first = values[index]!;
    let last = first;
    while (index + 1 < values.length && values[index + 1] === last + 1) last = values[++index]!;
    ranges.push(first === last ? String(first) : `${first}-${last}`);
  }
  return ranges.join(',');
}
export class DockerContainedResources implements DockerContainedResourceController {
  readonly #parent: string;
  readonly #slice: string;
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly journal: DockerContinuationTaskJournal,
    private readonly configuration: DockerContainedResourcesConfiguration
  ) {
    cid.parse(configuration.boxId);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(configuration.helperImageId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(configuration.deployment)
    )
      throw Error('Fixed contained resource configuration required');
    this.#slice = `reverie-box-${configuration.boxId}.slice`;
    this.#parent = `/reverie.slice/reverie-box.slice/${this.#slice}`;
  }
  async #inspect(id: string): Promise<Record<string, unknown>> {
    cid.parse(id);
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .length(1)
      .parse(JSON.parse(await this.command.run(['container', 'inspect', id])));
    if (rows[0]!.Id !== id) refuse('DOCKER_RESOURCE_CONTAINER_CHANGED');
    return rows[0]!;
  }
  async #init(id: string): Promise<Init | null> {
    const raw = await this.#inspect(id);
    const state = z
      .object({
        Running: z.boolean(),
        Paused: z.boolean(),
        Restarting: z.boolean(),
        Dead: z.boolean(),
        Pid: z.number().int().nonnegative().safe(),
      })
      .parse(raw.State);
    if (state.Paused || state.Restarting || state.Dead) refuse('DOCKER_RESOURCE_CONTAINER_UNKNOWN');
    if (!state.Running) return null;
    if (!state.Pid) refuse('DOCKER_RESOURCE_INIT_UNKNOWN');
    const host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    if (host.PidMode !== '' && host.PidMode !== 'private' && host.PidMode !== 'host')
      refuse('DOCKER_RESOURCE_PID_NAMESPACE_UNKNOWN');
    // Root resource anchors use host PID namespace; their own host PID is read
    // by the Rust probe. Workers must use a private namespace with PID1.
    if (host.PidMode === 'host') return { id, pid: state.Pid, startTicks: '' };
    const ticks = startTicks(await this.command.run(['exec', id, '/bin/cat', '/proc/1/stat']));
    const after = await this.#inspect(id);
    if (!isDeepStrictEqual(raw.State, after.State)) refuse('DOCKER_RESOURCE_INIT_CHANGED');
    return { id, pid: state.Pid, startTicks: ticks };
  }
  async #members(worker?: string): Promise<string[]> {
    const ids = [...this.configuration.selectedWorkerContainerIds()];
    if (ids.length > 64 || new Set(ids).size !== ids.length) refuse('DOCKER_RESOURCE_MEMBERS_UNKNOWN');
    const args: string[] = [];
    for (const id of ids.sort()) {
      cid.parse(id);
      if (id === worker) continue;
      const raw = await this.#inspect(id);
      const config = z.object({ Labels: z.record(z.string(), z.string()) }).parse(raw.Config);
      const host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
      if (config.Labels['reverie.boxed.instance'] !== this.configuration.deployment || host.PidMode === 'host')
        refuse('DOCKER_RESOURCE_MEMBER_BINDING_CHANGED');
      const init = await this.#init(id);
      if (init) args.push('--member', `${id}:${init.pid}:${init.startTicks}`);
    }
    return args;
  }
  #configuration(
    role: DockerContinuationTaskRole,
    name: string,
    args: readonly string[],
    writable?: { path: string; target: string }
  ): Config {
    const binds = ['/proc:/proc:ro', '/sys/fs/cgroup:/sys/fs/cgroup:ro'];
    if (writable) binds.push(`/sys/fs/cgroup${writable.path}:${writable.target}:rw`);
    return {
      Image: this.configuration.helperImageId,
      User: '0:0',
      Entrypoint: ['/bin/reverie-docker-resources'],
      Cmd: [...args],
      Env: [],
      WorkingDir: '/',
      Labels: {
        'org.reverie.purpose': 'boxed-resource-helper-v1',
        'reverie.box.resource.box': this.configuration.boxId,
        'reverie.box.resource.role': role,
        'reverie.box.resource.name': name,
      },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        CapAdd: [],
        // Docker adds this exact label option for a host PID namespace. Keep
        // it explicit so the immutable configuration comparison stays exact.
        SecurityOpt: ['no-new-privileges:true', 'label=disable'],
        NetworkMode: 'none',
        PidMode: 'host',
        CgroupnsMode: 'host',
        Binds: binds,
        AutoRemove: false,
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        Memory: 64 * 1024 ** 2,
        MemorySwap: 64 * 1024 ** 2,
        PidsLimit: 32,
        CgroupParent: role === 'anchor' ? this.#slice : '',
      },
    };
  }
  async #fixed(id: string, desired: Config): Promise<Record<string, unknown>> {
    const raw = await this.#inspect(id),
      config = z.record(z.string(), z.unknown()).parse(raw.Config),
      host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    const expected = desired.HostConfig as Record<string, unknown>;
    for (const key of ['Image']) if (raw[key] !== desired[key]) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
    for (const key of ['User', 'Entrypoint', 'Cmd', 'Labels', 'WorkingDir'])
      if (!isDeepStrictEqual(config[key], desired[key])) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
    if (config.Env !== null && !isDeepStrictEqual(config.Env, [])) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
    for (const key of [
      'Privileged',
      'ReadonlyRootfs',
      'CapDrop',
      'SecurityOpt',
      'NetworkMode',
      'PidMode',
      'CgroupnsMode',
      'Binds',
      'AutoRemove',
      'Memory',
      'MemorySwap',
      'PidsLimit',
      'RestartPolicy',
      'CgroupParent',
    ])
      if (!isDeepStrictEqual(host[key], expected[key])) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
    for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'Mounts', 'VolumesFrom'])
      if (host[key] !== null && host[key] !== undefined && !isDeepStrictEqual(host[key], []))
        refuse('DOCKER_RESOURCE_HELPER_PRIVILEGES_CHANGED');
    const mounts = z
      .array(z.object({ Type: z.literal('bind'), Source: z.string(), Destination: z.string(), RW: z.boolean() }))
      .parse(raw.Mounts);
    const expectedMounts = (expected.Binds as string[]).map((value) => {
      const [Source, Destination, mode] = value.split(':');
      return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
    });
    const ordered = (values: typeof expectedMounts) =>
      [...values].sort((a, b) => a.Destination!.localeCompare(b.Destination!));
    if (!isDeepStrictEqual(ordered(mounts), ordered(expectedMounts))) refuse('DOCKER_RESOURCE_HELPER_MOUNTS_CHANGED');
    return raw;
  }
  async #created(
    row: DockerEmployeeContinuationRecord,
    role: DockerContinuationTaskRole,
    name: string,
    config: Config,
    current: () => void
  ): Promise<DockerContinuationTask> {
    let task = this.journal.read(row, role);
    const base = {
      role,
      name,
      imageId: this.configuration.helperImageId,
      configurationDigest: dockerContinuationDigest(config),
    };
    const fresh = task === undefined;
    if (!task) {
      current();
      await this.journal.publish(row, undefined, { ...base, phase: 'create-issued' }, current);
      task = this.journal.read(row, role)!;
    }
    if (task.name !== name || task.imageId !== base.imageId || task.configurationDigest !== base.configurationDigest)
      refuse('DOCKER_RESOURCE_ORIGINAL_TASK_CHANGED');
    if (task.phase === 'create-issued') {
      const existing = (
        await this.command.run([
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          'label=reverie.box.resource.name=' + name,
          '--format',
          '{{.ID}}',
        ])
      ).trim();
      current();
      if (!existing && !fresh) refuse('DOCKER_RESOURCE_CREATE_UNCONFIRMED');
      const id = existing ? cid.parse(existing) : await this.command.create(name, config, current);
      current();
      await this.#fixed(id, config);
      current();
      await this.journal.publish(row, task, { ...base, phase: 'created', containerId: id }, current);
      task = this.journal.read(row, role)!;
    }
    if (!('containerId' in task)) refuse('DOCKER_RESOURCE_CREATE_UNCONFIRMED');
    await this.#fixed(task.containerId, config);
    current();
    return task;
  }
  async #anchor(row: DockerEmployeeContinuationRecord, current?: () => void): Promise<Init | null> {
    const name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32);
    const config = this.#configuration('anchor', name, ['anchor']);
    let task = this.journal.read(row, 'anchor');
    if (current) task = await this.#created(row, 'anchor', name, config, current);
    if (!task || !('containerId' in task)) return null;
    const raw = await this.#fixed(task.containerId, config);
    const state = z.object({ Running: z.boolean(), Pid: z.number().int().nonnegative().safe() }).parse(raw.State);
    if (!state.Running && task.phase === 'created' && current) {
      if ((raw.State as { Status?: unknown }).Status !== 'created') refuse('DOCKER_RESOURCE_ANCHOR_START_UNCONFIRMED');
      await this.journal.publish(row, task, { ...task, phase: 'start-issued' }, current);
      current();
      await this.command.run(['container', 'start', task.containerId]);
      current();
    }
    const init = await this.#init(task.containerId);
    if (!init) return null;
    const seen = await this.#probe(init, undefined);
    current?.();
    task = this.journal.read(row, 'anchor');
    if (current && task && ['created', 'start-issued'].includes(task.phase))
      await this.journal.publish(
        row,
        task,
        {
          role: task.role,
          name: task.name,
          imageId: task.imageId,
          configurationDigest: task.configurationDigest,
          phase: 'running',
          containerId: init.id,
          initPid: init.pid,
          initStartTicks: seen.anchor.startTicks,
        },
        current
      );
    if (task?.phase === 'running' && (task.initPid !== init.pid || task.initStartTicks !== seen.anchor.startTicks))
      refuse('DOCKER_RESOURCE_ANCHOR_REPLACED');
    return { ...init, startTicks: seen.anchor.startTicks };
  }
  async #probe(anchor: Init, worker?: Init): Promise<Observation> {
    const args = [
      worker ? 'probe-worker' : 'probe-pool',
      '--box-id',
      this.configuration.boxId,
      '--anchor-id',
      anchor.id,
      '--anchor-pid',
      String(anchor.pid),
      ...(anchor.startTicks ? ['--anchor-start', anchor.startTicks] : []),
      ...(await this.#members(worker?.id)),
    ];
    if (worker)
      args.push('--worker-id', worker.id, '--worker-pid', String(worker.pid), '--worker-start', worker.startTicks);
    const result = observation.parse(
      JSON.parse(await this.command.run(['exec', anchor.id, '/bin/reverie-docker-resources', ...args]))
    );
    if (
      result.boxId !== this.configuration.boxId ||
      result.parent.path !== this.#parent ||
      result.anchor.id !== anchor.id ||
      result.anchor.pid !== anchor.pid ||
      (anchor.startTicks && result.anchor.startTicks !== anchor.startTicks) ||
      (!worker && result.worker !== null) ||
      (worker &&
        (result.worker?.id !== worker.id ||
          result.worker.pid !== worker.pid ||
          result.worker.startTicks !== worker.startTicks ||
          result.worker.path !== `${this.#parent}/docker-${worker.id}.scope`))
    )
      refuse('DOCKER_RESOURCE_OBSERVATION_CHANGED');
    return result;
  }
  #matches(seen: Observation, policy: DockerEmployeeResourcePolicy['pool'], high: number | null): boolean {
    const r = seen.resources;
    return (
      r.memoryMax === String(policy.memoryMaxBytes) &&
      r.memoryHigh === (high === null ? 'max' : String(high)) &&
      r.swapMax === String(policy.swapMaxBytes) &&
      r.pidsMax === String(policy.pidsMax) &&
      r.cpuWeight === String(policy.cpuWeight) &&
      /^max [1-9][0-9]*$/.test(r.cpuMax) &&
      !!r.cpusetCpus &&
      isDeepStrictEqual(cpus(r.cpusetCpusEffective), policy.allowedCpus) &&
      isDeepStrictEqual(cpus(r.cpusetCpus), policy.allowedCpus)
    );
  }
  async #ack(
    task: DockerContinuationTask,
    fresh: Observation,
    policy: DockerEmployeeResourcePolicy,
    worker: boolean
  ): Promise<boolean> {
    if (
      !('containerId' in task) ||
      !['start-issued', 'running', 'completed'].includes(task.phase) ||
      task.role !== (worker ? 'leaf-helper' : 'pool-helper') ||
      task.imageId !== this.configuration.helperImageId
    )
      return false;
    const raw = await this.#inspect(task.containerId);
    const args = z.object({ Cmd: z.array(z.string()).min(1).max(512) }).parse(raw.Config).Cmd;
    if (args[0] !== (worker ? 'configure-high' : 'configure-pool')) return false;
    const writable = {
      path: worker ? fresh.worker!.path : this.#parent,
      target: worker ? '/run/reverie-worker-cgroup' : '/run/reverie-box-pool',
    };
    const config = this.#configuration(task.role, task.name, args, writable);
    if (dockerContinuationDigest(config) !== task.configurationDigest) return false;
    await this.#fixed(task.containerId, config);
    const state = z
      .object({
        Status: z.string(),
        Running: z.boolean(),
        ExitCode: z.number().int(),
        OOMKilled: z.boolean().optional(),
        Error: z.string().optional(),
      })
      .parse(raw.State);
    if (
      state.Status !== 'exited' ||
      state.Running ||
      state.ExitCode !== 0 ||
      state.OOMKilled === true ||
      (state.Error ?? '') !== ''
    )
      return false;
    const result = observation.parse(JSON.parse(await this.command.run(['container', 'logs', task.containerId])));
    if (task.phase === 'completed' && task.resultDigest !== dockerContinuationDigest(result)) return false;
    return (
      result.boxId === fresh.boxId &&
      isDeepStrictEqual(result.parent, fresh.parent) &&
      isDeepStrictEqual(result.anchor, fresh.anchor) &&
      isDeepStrictEqual(result.worker, worker ? fresh.worker : null) &&
      this.#matches(result, worker ? policy : policy.pool, worker ? policy.memoryHighBytes : null)
    );
  }
  async #poolAck(row: DockerEmployeeContinuationRecord, fresh: Observation): Promise<void> {
    const own = this.journal.read(row, 'pool-helper');
    if (own) {
      if (!(await this.#ack(own, fresh, row.policy, false))) refuse('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
      return;
    }
    const prior = this.configuration.retainedPoolConfigurationTasks?.() ?? [];
    if (prior.length > 64) refuse('DOCKER_RESOURCE_POOL_OWNERS_UNKNOWN');
    for (const task of prior) if (await this.#ack(task, fresh, row.policy, false)) return;
    refuse('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
  }
  async validate(_original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void> {
    if (policy.memoryHighBytes === null || !Number.isSafeInteger(policy.memoryMaxBytes + policy.swapMaxBytes))
      refuse('DOCKER_RESOURCE_FINITE_HIGH_REQUIRED');
    const rows = z
      .array(z.object({ Id: z.string() }))
      .length(1)
      .parse(JSON.parse(await this.command.run(['image', 'inspect', this.configuration.helperImageId])));
    if (rows[0]!.Id !== this.configuration.helperImageId) refuse('DOCKER_RESOURCE_HELPER_IMAGE_CHANGED');
  }
  async #configureTask(
    row: DockerEmployeeContinuationRecord,
    role: 'pool-helper' | 'leaf-helper',
    args: string[],
    writable: { path: string; target: string },
    current: () => void
  ): Promise<void> {
    const name = `reverie-boxed-${role}-${row.request.operationId}`;
    const config = this.#configuration(role, name, args, writable);
    let task = await this.#created(row, role, name, config, current);
    if (!('containerId' in task)) refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
    if (task.phase === 'created') {
      const raw = await this.#fixed(task.containerId, config);
      current();
      if ((raw.State as { Status?: unknown }).Status !== 'created') refuse('DOCKER_RESOURCE_HELPER_START_UNCONFIRMED');
      await this.journal.publish(row, task, { ...task, phase: 'start-issued' }, current);
      current();
      await this.command.run(['container', 'start', task.containerId]);
      current();
      task = this.journal.read(row, role)!;
    }
    if (!('containerId' in task)) refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
    const result = (await this.command.run(['container', 'wait', task.containerId])).trim();
    current();
    if (result !== '0') refuse('DOCKER_RESOURCE_HELPER_FAILED');
    const seen = observation.parse(JSON.parse(await this.command.run(['container', 'logs', task.containerId])));
    current();
    if (seen.boxId !== this.configuration.boxId) refuse('DOCKER_RESOURCE_HELPER_RESULT_CHANGED');
    if (task.phase === 'start-issued' || task.phase === 'running')
      await this.journal.publish(
        row,
        task,
        {
          role: task.role,
          name: task.name,
          imageId: task.imageId,
          configurationDigest: task.configurationDigest,
          phase: 'completed',
          containerId: task.containerId,
          resultDigest: dockerContinuationDigest(seen),
        },
        current
      );
  }
  async preparePool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const anchor = await this.#anchor(row, current);
    current();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const seen = await this.#probe(anchor);
    current();
    if (this.#matches(seen, row.policy.pool, null)) {
      await this.#poolAck(row, seen);
      current();
      return;
    }
    const p = row.policy.pool;
    await this.#configureTask(
      row,
      'pool-helper',
      [
        'configure-pool',
        '--box-id',
        this.configuration.boxId,
        '--anchor-id',
        anchor.id,
        '--anchor-pid',
        String(anchor.pid),
        '--anchor-start',
        anchor.startTicks,
        '--parent-dev',
        seen.parent.dev,
        '--parent-ino',
        seen.parent.ino,
        '--memory-max',
        String(p.memoryMaxBytes),
        '--swap-max',
        String(p.swapMaxBytes),
        '--pids-max',
        String(p.pidsMax),
        '--cpu-weight',
        String(p.cpuWeight),
        '--cpuset-cpus',
        canonicalCpus(p.allowedCpus),
      ],
      { path: this.#parent, target: '/run/reverie-box-pool' },
      current
    );
    const actual = await this.#probe(anchor);
    current();
    if (!this.#matches(actual, p, null)) refuse('DOCKER_RESOURCE_POOL_READBACK');
    await this.#poolAck(row, actual);
    current();
  }
  async observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null> {
    const anchor = await this.#anchor(row);
    if (!anchor) return null;
    const seen = await this.#probe(anchor);
    if (!this.#matches(seen, row.policy.pool, null)) return null;
    await this.#poolAck(row, seen);
    return {
      containerId: anchor.id,
      cgroupParent: this.#slice,
      policyDigest: dockerContinuationDigest(row.policy.pool),
      physicalDigest: dockerContinuationDigest({
        boxId: seen.boxId,
        parent: seen.parent,
        anchor: seen.anchor,
        resources: seen.resources,
      }),
    };
  }
  async #worker(row: DockerEmployeeContinuationRecord): Promise<Init> {
    if (!row.destination) refuse('DOCKER_RESOURCE_DESTINATION_REQUIRED');
    const raw = await this.#inspect(row.destination.containerId);
    const labels = z.object({ Labels: z.record(z.string(), z.string()) }).parse(raw.Config).Labels;
    if (
      raw.Image !== row.workerImage.imageId ||
      labels['reverie.boxed.instance'] !== this.configuration.deployment ||
      labels['reverie.boxed.employee'] !== row.employeeId ||
      labels['reverie.boxed.session'] !== row.request.sessionId ||
      labels['reverie.boxed.generation'] !== String(row.request.sessionGeneration) ||
      labels['reverie.boxed.operation'] !== row.request.operationId
    )
      refuse('DOCKER_RESOURCE_WORKER_CHANGED');
    const host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    if (host.PidMode === 'host') refuse('DOCKER_RESOURCE_WORKER_PID_NAMESPACE');
    const init = await this.#init(row.destination.containerId);
    if (!init) refuse('DOCKER_RESOURCE_WORKER_STOPPED');
    return init;
  }
  async read(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeResourcePolicy | null> {
    const pool = await this.observePool(row);
    if (!pool || !row.pool || !isDeepStrictEqual(pool, row.pool)) refuse('DOCKER_RESOURCE_POOL_CHANGED');
    const anchor = await this.#anchor(row);
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const seen = await this.#probe(anchor, await this.#worker(row));
    const issued = this.journal.read(row, 'leaf-helper');
    if (!issued || issued.phase === 'create-issued' || issued.phase === 'created') return null;
    if (!(await this.#ack(issued, seen, row.policy, true))) refuse('DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED');
    if (!this.#matches(seen, row.policy, row.policy.memoryHighBytes)) return null;
    return structuredClone(row.policy);
  }
  async configure(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const pool = await this.observePool(row);
    current();
    if (!pool || !row.pool || !isDeepStrictEqual(pool, row.pool)) refuse('DOCKER_RESOURCE_POOL_CHANGED');
    const anchor = await this.#anchor(row),
      worker = await this.#worker(row);
    current();
    if (!anchor || row.policy.memoryHighBytes === null) refuse('DOCKER_RESOURCE_FINITE_HIGH_REQUIRED');
    const seen = await this.#probe(anchor, worker);
    current();
    if (!seen.worker) refuse('DOCKER_RESOURCE_WORKER_READBACK');
    const p = row.policy;
    await this.#configureTask(
      row,
      'leaf-helper',
      [
        'configure-high',
        '--box-id',
        this.configuration.boxId,
        '--anchor-id',
        anchor.id,
        '--anchor-pid',
        String(anchor.pid),
        '--anchor-start',
        anchor.startTicks,
        '--worker-id',
        worker.id,
        '--worker-pid',
        String(worker.pid),
        '--worker-start',
        worker.startTicks,
        ...(await this.#members(worker.id)),
        '--leaf-dev',
        seen.worker.dev,
        '--leaf-ino',
        seen.worker.ino,
        '--memory-max',
        String(p.memoryMaxBytes),
        '--swap-max',
        String(p.swapMaxBytes),
        '--pids-max',
        String(p.pidsMax),
        '--memory-high',
        String(p.memoryHighBytes),
        '--cpu-weight',
        String(p.cpuWeight),
      ],
      { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
      current
    );
    const actual = await this.read(row);
    current();
    if (!actual) refuse('DOCKER_RESOURCE_WORKER_READBACK');
  }
}
