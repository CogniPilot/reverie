/** Docker-only orchestration of the fixed Rust resource helper. Canonical task
 * cursors precede create/start; a failed reply never authorizes a second effect. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DockerResourceObservation as observation,
  type DockerResourceObservation as Observation,
  DockerPoolObservationRecord,
} from './docker-pool-observation-data.js';
import { DockerEmployeePoolPolicy } from './docker-employee-continuation-data.js';
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
import {
  DockerResourceRevisionStore,
  dockerResourceScope,
  dockerResourceAttemptKey,
  dockerRevisedPolicy,
  DockerResourceLeafIdentity,
  type DockerResourceDesiredRevision,
  type DockerResourceAttempt,
} from './docker-resource-revisions.js';
import type { DockerEngineCommand } from './docker-engine-command.js';

const cid = z.string().regex(/^[a-f0-9]{64}$/);
type Config = Readonly<Record<string, unknown>>;
type Init = { id: string; pid: number; startTicks: string };
const poolObservationOrigin = Symbol('actual native pool observation');
export class DockerPoolReconciliationReceipt {
  readonly #record: DockerPoolObservationRecord;
  readonly #current: () => void;
  #claimed = false;
  constructor(origin: unknown, record: DockerPoolObservationRecord, current: () => void) {
    if (origin !== poolObservationOrigin) refuse('DOCKER_POOL_OBSERVATION_ORIGIN_REQUIRED');
    this.#record = DockerPoolObservationRecord.parse(structuredClone(record));
    this.#current = current;
  }
  require(): void {
    void this.#record;
    this.#current();
  }
  snapshot(current: () => void): DockerPoolObservationRecord {
    const record = this.#record;
    this.#current();
    current();
    return structuredClone(record);
  }
  claim(current: () => void): DockerPoolObservationRecord {
    const record = this.#record; // Brand before invoking any caller callback.
    if (this.#claimed) refuse('DOCKER_POOL_OBSERVATION_ALREADY_CONSUMED');
    this.#current();
    current();
    this.#claimed = true;
    return structuredClone(record);
  }
}
Object.freeze(DockerPoolReconciliationReceipt.prototype);
export interface DockerContainedResourcesConfiguration {
  readonly boxId: string;
  readonly deployment: string;
  readonly helperImageId: string;
  /** Independently qualified fixed high-only image. Never replaces the original anchor/helper pin. */
  readonly memoryHighHelperImageId?: string;
  /** Canonical selected bindings AND retained destinations. These IDs are DATA;
   * Engine/current kernel observations must independently validate every one. */
  selectedWorkerContainerIds(): readonly string[];
  /** Original issued pool helpers from the canonical operation journal, for
   * later employees sharing the same actually acknowledged pool. */
  retainedPoolConfigurationTasks?(): readonly DockerContinuationTask[];
}
function refuse(code = 'DOCKER_RESOURCE_REVISION_CHANGED'): never {
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
/** Pure DATA comparison only. A boolean never supplies a native resource or owner proof. */
export function dockerOtherResourceLimitsMatch(
  r: Observation['resources'],
  policy: DockerEmployeeResourcePolicy['pool']
): boolean {
  return (
    r.memoryMax === String(policy.memoryMaxBytes) &&
    r.swapMax === String(policy.swapMaxBytes) &&
    r.pidsMax === String(policy.pidsMax) &&
    r.cpuWeight === String(policy.cpuWeight) &&
    /^max [1-9][0-9]*$/.test(r.cpuMax) &&
    !!r.cpusetCpus &&
    isDeepStrictEqual(cpus(r.cpusetCpusEffective), policy.allowedCpus) &&
    isDeepStrictEqual(cpus(r.cpusetCpus), policy.allowedCpus)
  );
}
const effectiveOrigin = Symbol('fresh native approved leaf revision');
/** Read-only correlation, never resource or provider effect authority. */
export class DockerEffectiveResourceProof {
  readonly #scope: string;
  readonly #policy: DockerEmployeeResourcePolicy;
  readonly #revision: DockerResourceDesiredRevision;
  readonly #attempt: DockerResourceAttempt;
  readonly #store: DockerResourceRevisionStore;
  readonly #observed: number;
  readonly #fresh: () => void;
  #revoked = false;
  constructor(
    origin: symbol,
    row: DockerEmployeeContinuationRecord,
    policy: DockerEmployeeResourcePolicy,
    revision: DockerResourceDesiredRevision,
    attempt: DockerResourceAttempt,
    store: DockerResourceRevisionStore,
    observed: number,
    fresh: () => void
  ) {
    if (origin !== effectiveOrigin) refuse('DOCKER_RESOURCE_REVISION_PROOF_REQUIRED');
    this.#scope = dockerResourceScope(row);
    this.#policy = structuredClone(policy);
    this.#revision = structuredClone(revision);
    this.#attempt = structuredClone(attempt);
    this.#store = store;
    this.#observed = observed;
    this.#fresh = fresh;
    Object.freeze(this);
  }
  require(row: DockerEmployeeContinuationRecord, policy: DockerEmployeeResourcePolicy): void {
    if (this.#revoked) refuse('DOCKER_RESOURCE_REVISION_PROOF_CHANGED');
    try {
      this.#fresh();
      const elapsed = performance.now() - this.#observed;
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > 5000 ||
        dockerResourceScope(row) !== this.#scope ||
        !isDeepStrictEqual(policy, this.#policy) ||
        this.#attempt.state === 'helper' ||
        !isDeepStrictEqual(this.#store.revision(row.owner, this.#revision.revision), this.#revision) ||
        !isDeepStrictEqual(this.#store.attempt(row, this.#revision.revision), this.#attempt) ||
        !this.#store.approved(row).some(({ attempt }) => isDeepStrictEqual(attempt, this.#attempt))
      )
        refuse('DOCKER_RESOURCE_REVISION_PROOF_CHANGED');
    } catch (cause) {
      this.#revoked = true;
      throw cause;
    }
  }
}
Object.freeze(DockerEffectiveResourceProof.prototype);
export function requireDockerEffectiveResourceProof(
  proof: unknown,
  row: DockerEmployeeContinuationRecord,
  actual: DockerEmployeeResourcePolicy
): void {
  DockerEffectiveResourceProof.prototype.require.call(proof as DockerEffectiveResourceProof, row, actual);
}
export class DockerContainedResources implements DockerContainedResourceController {
  readonly #parent: string;
  readonly #slice: string;
  readonly #proofs = new Map<string, DockerEffectiveResourceProof>();
  readonly #epochs = new Map<string, symbol>();
  readonly #observedAt = new WeakMap<object, number>();
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly journal: DockerContinuationTaskJournal,
    private readonly configuration: DockerContainedResourcesConfiguration,
    private readonly revisions?: DockerResourceRevisionStore
  ) {
    cid.parse(configuration.boxId);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(configuration.helperImageId) ||
      (configuration.memoryHighHelperImageId !== undefined &&
        !/^sha256:[a-f0-9]{64}$/.test(configuration.memoryHighHelperImageId)) ||
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
    writable?: { path: string; target: string },
    imageId = this.configuration.helperImageId
  ): Config {
    const binds = ['/proc:/proc:ro', '/sys/fs/cgroup:/sys/fs/cgroup:ro'];
    if (writable) binds.push(`/sys/fs/cgroup${writable.path}:${writable.target}:rw`);
    return {
      Image: imageId,
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
        ...(args[0] === 'configure-memory-high' ? { 'org.reverie.resource.memory-high-only': 'v1' } : {}),
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
      .array(
        z.object({
          Type: z.literal('bind'),
          Source: z.string(),
          Destination: z.string(),
          RW: z.boolean(),
        })
      )
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
    current: () => void,
    journal: DockerContinuationTaskJournal = this.journal
  ): Promise<DockerContinuationTask> {
    let task = journal.read(row, role);
    const base = {
      role,
      name,
      imageId: String(config.Image),
      configurationDigest: dockerContinuationDigest(config),
    };
    const fresh = task === undefined;
    if (!task) {
      current();
      await journal.publish(row, undefined, { ...base, phase: 'create-issued' }, current);
      task = journal.read(row, role)!;
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
      await journal.publish(row, task, { ...base, phase: 'created', containerId: id }, current);
      task = journal.read(row, role)!;
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
    const state = z
      .object({
        Running: z.boolean(),
        Pid: z.number().int().nonnegative().safe(),
      })
      .parse(raw.State);
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
    const started = performance.now();
    const result = observation.parse(
      JSON.parse(await this.command.run(['exec', anchor.id, '/bin/reverie-docker-resources', ...args]))
    );
    this.#observedAt.set(result, started);
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
    return (
      dockerOtherResourceLimitsMatch(seen.resources, policy) &&
      seen.resources.memoryHigh === (high === null ? 'max' : String(high))
    );
  }
  async #ack(
    task: DockerContinuationTask,
    fresh: Observation,
    policy: DockerEmployeeResourcePolicy['pool'],
    high: number | null,
    worker: boolean,
    revisionImage?: string
  ): Promise<boolean> {
    if (
      !('containerId' in task) ||
      !['start-issued', 'running', 'completed'].includes(task.phase) ||
      task.role !== (worker ? 'leaf-helper' : 'pool-helper') ||
      task.imageId !== (revisionImage ?? this.configuration.helperImageId)
    )
      return false;
    const raw = await this.#inspect(task.containerId);
    const args = z.object({ Cmd: z.array(z.string()).min(1).max(512) }).parse(raw.Config).Cmd;
    if (args[0] !== (revisionImage ? 'configure-memory-high' : worker ? 'configure-high' : 'configure-pool'))
      return false;
    const writable = {
      path: worker ? fresh.worker!.path : this.#parent,
      target: worker ? '/run/reverie-worker-cgroup' : '/run/reverie-box-pool',
    };
    const config = this.#configuration(task.role, task.name, args, writable, revisionImage);
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
      this.#matches(result, policy, high)
    );
  }
  async #poolWriterClosed(task: DockerContinuationTask): Promise<boolean> {
    if (task.phase === 'create-issued' || task.phase === 'created') return true;
    if (task.role !== 'pool-helper' || task.imageId !== this.configuration.helperImageId || !('containerId' in task))
      return false;
    const raw = await this.#inspect(task.containerId);
    const args = z.array(z.string()).min(1).max(512).parse(z.record(z.string(), z.unknown()).parse(raw.Config).Cmd);
    if (args[0] !== 'configure-pool') return false;
    const expected = this.#configuration('pool-helper', task.name, args, {
      path: this.#parent,
      target: '/run/reverie-box-pool',
    });
    if (dockerContinuationDigest(expected) !== task.configurationDigest) return false;
    await this.#fixed(task.containerId, expected);
    const state = z
      .object({
        Status: z.string(),
        Running: z.boolean(),
        Paused: z.boolean(),
        Restarting: z.boolean(),
        Dead: z.boolean(),
        ExitCode: z.number().int(),
        OOMKilled: z.boolean().optional(),
        Error: z.string().optional(),
      })
      .parse(raw.State);
    // Terminal failure can close a possible writer, but can NEVER acknowledge
    // resource configuration. Only #ack below supplies that independent proof.
    return (
      state.Status === 'exited' &&
      !state.Running &&
      !state.Paused &&
      !state.Restarting &&
      !state.Dead &&
      state.ExitCode >= 0 &&
      state.ExitCode <= 255 &&
      (state.Error ?? '') === ''
    );
  }
  async #poolWritersClosed(except?: DockerContinuationTask): Promise<void> {
    const prior = this.configuration.retainedPoolConfigurationTasks?.() ?? [];
    if (prior.length > 128) refuse('DOCKER_RESOURCE_POOL_OWNERS_UNKNOWN');
    for (const task of prior) {
      if (
        except &&
        task.name === except.name &&
        task.imageId === except.imageId &&
        task.configurationDigest === except.configurationDigest &&
        ('containerId' in task ? task.containerId : undefined) ===
          ('containerId' in except ? except.containerId : undefined)
      )
        continue;
      if (!(await this.#poolWriterClosed(task))) refuse('DOCKER_RESOURCE_POOL_WRITER_UNCONFIRMED');
    }
  }
  async #poolAck(row: DockerEmployeeContinuationRecord, fresh: Observation): Promise<void> {
    const own = this.journal.read(row, 'pool-helper');
    const prior = this.configuration.retainedPoolConfigurationTasks?.() ?? [];
    if (prior.length > 128) refuse('DOCKER_RESOURCE_POOL_OWNERS_UNKNOWN');
    // A delayed earlier configure must not race this fresh probe. Its persisted
    // START fence remains unknown until the ORIGINAL fixed container is terminal.
    await this.#poolWritersClosed();
    if (own) {
      if (!(await this.#ack(own, fresh, row.policy.pool, null, false)))
        refuse('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
      return;
    }
    for (const task of prior) if (await this.#ack(task, fresh, row.policy.pool, null, false)) return;
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
    current: () => void,
    revision?: { id: string; journal: DockerContinuationTaskJournal; imageId: string }
  ): Promise<void> {
    const journal = revision?.journal ?? this.journal;
    const name = `reverie-boxed-${role}-${dockerContinuationDigest([this.configuration.boxId, role, row.request.operationId, ...(revision ? [revision.id] : [])])}`;
    const config = this.#configuration(role, name, args, writable, revision?.imageId);
    let task = await this.#created(row, role, name, config, current, journal);
    if (!('containerId' in task)) refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
    if (task.phase === 'created') {
      const raw = await this.#fixed(task.containerId, config);
      current();
      if ((raw.State as { Status?: unknown }).Status !== 'created') refuse('DOCKER_RESOURCE_HELPER_START_UNCONFIRMED');
      await journal.publish(row, task, { ...task, phase: 'start-issued' }, current);
      current();
      await this.command.run(['container', 'start', task.containerId]);
      current();
      task = journal.read(row, role)!;
    }
    if (!('containerId' in task)) refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
    const result = (await this.command.run(['container', 'wait', task.containerId])).trim();
    current();
    if (result !== '0') refuse('DOCKER_RESOURCE_HELPER_FAILED');
    const seen = observation.parse(JSON.parse(await this.command.run(['container', 'logs', task.containerId])));
    current();
    if (seen.boxId !== this.configuration.boxId) refuse('DOCKER_RESOURCE_HELPER_RESULT_CHANGED');
    if (task.phase === 'start-issued' || task.phase === 'running')
      await journal.publish(
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
  #poolArguments(seen: Observation, policy: DockerEmployeeResourcePolicy['pool']): string[] {
    return [
      'configure-pool',
      '--box-id',
      this.configuration.boxId,
      '--anchor-id',
      seen.anchor.id,
      '--anchor-pid',
      String(seen.anchor.pid),
      '--anchor-start',
      seen.anchor.startTicks,
      '--parent-dev',
      seen.parent.dev,
      '--parent-ino',
      seen.parent.ino,
      '--memory-max',
      String(policy.memoryMaxBytes),
      '--swap-max',
      String(policy.swapMaxBytes),
      '--pids-max',
      String(policy.pidsMax),
      '--cpu-weight',
      String(policy.cpuWeight),
      '--cpuset-cpus',
      canonicalCpus(policy.allowedCpus),
    ];
  }
  async #poolCensus(role: 'anchor' | 'pool-helper'): Promise<string[]> {
    const raw = await this.command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=org.reverie.purpose=boxed-resource-helper-v1',
      '--filter',
      'label=reverie.box.resource.box=' + this.configuration.boxId,
      '--filter',
      'label=reverie.box.resource.role=' + role,
      '--format',
      '{{.ID}}',
    ]);
    if (Buffer.byteLength(raw) > 16384) refuse('DOCKER_POOL_CENSUS_UNCONFIRMED');
    const ids = raw.trim()
      ? raw
          .trim()
          .split(String.fromCharCode(10))
          .map((value) => cid.parse(value))
      : [];
    if (ids.length > 128 || new Set(ids).size !== ids.length) refuse('DOCKER_POOL_CENSUS_UNCONFIRMED');
    return ids.sort();
  }
  /** Re-earn an ORIGINAL actual native ACK. No create/start/configure path. */
  async capturePoolObservation(
    input: DockerEmployeeResourcePolicy['pool'],
    current: () => void
  ): Promise<DockerPoolReconciliationReceipt> {
    const policy = DockerEmployeePoolPolicy.parse(input);
    current();
    const anchors = await this.#poolCensus('anchor');
    current();
    if (anchors.length !== 1) refuse('DOCKER_POOL_ANCHOR_UNCONFIRMED');
    const id = anchors[0]!,
      name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32),
      configuration = this.#configuration('anchor', name, ['anchor']);
    await this.#fixed(id, configuration);
    current();
    const init = await this.#init(id);
    current();
    if (!init) refuse('DOCKER_POOL_ANCHOR_UNCONFIRMED');
    const fresh = await this.#probe(init);
    current();
    if (!this.#matches(fresh, policy, null)) refuse('DOCKER_POOL_POLICY_CHANGED');
    await this.#poolWritersClosed();
    current();
    const ids = await this.#poolCensus('pool-helper');
    current();
    if (!ids.length) refuse('DOCKER_POOL_ORIGINAL_ACK_MISSING');
    const matches: DockerContinuationTask[] = [];
    for (const candidate of ids) {
      const raw = await this.#inspect(candidate);
      current();
      const label = z.record(z.string(), z.string()).parse(z.record(z.string(), z.unknown()).parse(raw.Config).Labels);
      const taskName = z
        .string()
        .regex(/^reverie-boxed-pool-helper-[a-f0-9]{64}$/)
        .parse(label['reverie.box.resource.name']);
      const expected = this.#configuration('pool-helper', taskName, this.#poolArguments(fresh, policy), {
        path: this.#parent,
        target: '/run/reverie-box-pool',
      });
      await this.#fixed(candidate, expected);
      current();
      const state = z
        .object({
          Status: z.string(),
          Running: z.boolean(),
          Paused: z.boolean(),
          Restarting: z.boolean(),
          Dead: z.boolean(),
          ExitCode: z.number().int(),
          OOMKilled: z.boolean().optional(),
          Error: z.string().optional(),
        })
        .parse(raw.State);
      if (
        state.Status !== 'exited' ||
        state.Running ||
        state.Paused ||
        state.Restarting ||
        state.Dead ||
        state.ExitCode !== 0 ||
        state.OOMKilled === true ||
        (state.Error ?? '') !== ''
      )
        refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
      const ack = observation.parse(JSON.parse(await this.command.run(['container', 'logs', candidate])));
      current();
      const task = DockerContinuationTask.parse({
        role: 'pool-helper',
        name: taskName,
        imageId: this.configuration.helperImageId,
        configurationDigest: dockerContinuationDigest(expected),
        phase: 'completed',
        containerId: candidate,
        resultDigest: dockerContinuationDigest(ack),
      });
      if (!(await this.#ack(task, fresh, policy, null, false))) refuse('DOCKER_POOL_ORIGINAL_ACK_CHANGED');
      current();
      matches.push(task);
    }
    if (!matches.length) refuse('DOCKER_POOL_ORIGINAL_ACK_MISSING');
    if (
      !isDeepStrictEqual(await this.#poolCensus('pool-helper'), ids) ||
      !isDeepStrictEqual(await this.#poolCensus('anchor'), anchors)
    )
      refuse('DOCKER_POOL_CENSUS_UNCONFIRMED');
    current();
    await this.#fixed(id, configuration);
    current();
    const confirmed = await this.#probe({ ...init, startTicks: fresh.anchor.startTicks });
    current();
    if (
      !isDeepStrictEqual(
        { parent: fresh.parent, anchor: fresh.anchor },
        { parent: confirmed.parent, anchor: confirmed.anchor }
      ) ||
      !this.#matches(confirmed, policy, null)
    )
      refuse('DOCKER_POOL_EPOCH_CHANGED');
    for (const task of matches) {
      if (!(await this.#ack(task, confirmed, policy, null, false))) refuse('DOCKER_POOL_ORIGINAL_ACK_CHANGED');
      current();
    }
    if (
      !isDeepStrictEqual(await this.#poolCensus('pool-helper'), ids) ||
      !isDeepStrictEqual(await this.#poolCensus('anchor'), anchors)
    )
      refuse('DOCKER_POOL_CENSUS_UNCONFIRMED');
    current();
    // All actual writers are closed and their original ACKs prove this SAME
    // epoch/policy. Picking one is new observation correlation, never a claim
    // about which historical employee or operation caused the pool state.
    const retained = this.configuration.retainedPoolConfigurationTasks?.() ?? [];
    const chosen =
      matches.find((task) =>
        retained.some(
          (prior) =>
            'containerId' in prior &&
            'containerId' in task &&
            prior.containerId === task.containerId &&
            prior.name === task.name &&
            prior.imageId === task.imageId &&
            prior.configurationDigest === task.configurationDigest &&
            (prior.phase !== 'completed' || task.phase !== 'completed' || prior.resultDigest === task.resultDigest)
        )
      ) ?? matches[0]!;
    const record = DockerPoolObservationRecord.parse({
      version: 1,
      purpose: 'reverie-boxed-pool-observation-v1',
      boxId: this.configuration.boxId,
      deployment: this.configuration.deployment,
      helperImageId: this.configuration.helperImageId,
      poolPolicy: policy,
      epoch: { boxId: confirmed.boxId, parent: confirmed.parent, anchor: confirmed.anchor },
      anchorTask: {
        role: 'anchor',
        name,
        imageId: this.configuration.helperImageId,
        configurationDigest: dockerContinuationDigest(configuration),
        phase: 'running',
        containerId: id,
        initPid: confirmed.anchor.pid,
        initStartTicks: confirmed.anchor.startTicks,
      },
      configuration: chosen,
    });
    return new DockerPoolReconciliationReceipt(poolObservationOrigin, record, current);
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
    await this.#poolWritersClosed(this.journal.read(row, 'pool-helper'));
    current();
    const p = row.policy.pool;
    await this.#configureTask(
      row,
      'pool-helper',
      this.#poolArguments(seen, p),
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
  #beginRead(row: DockerEmployeeContinuationRecord): symbol {
    const epoch = Symbol('actual native observation');
    this.#proofs.delete(row.request.operationId);
    this.#epochs.set(row.request.operationId, epoch);
    if (this.#epochs.size > 128) {
      const oldest = this.#epochs.keys().next().value!;
      this.#epochs.delete(oldest);
      this.#proofs.delete(oldest);
    }
    return epoch;
  }
  #fresh(seen: Observation): number {
    const started = this.#observedAt.get(seen),
      now = performance.now();
    if (
      started === undefined ||
      !Number.isFinite(started) ||
      !Number.isFinite(now) ||
      now < started ||
      now - started > 5000
    )
      refuse('DOCKER_RESOURCE_REVISION_OBSERVATION_EXPIRED');
    return started;
  }
  async #refresh(seen: Observation, current: () => void = () => {}): Promise<Observation> {
    if (!seen.worker) refuse('DOCKER_RESOURCE_WORKER_READBACK');
    current();
    const latest = await this.#probe(
      { id: seen.anchor.id, pid: seen.anchor.pid, startTicks: seen.anchor.startTicks },
      { id: seen.worker.id, pid: seen.worker.pid, startTicks: seen.worker.startTicks }
    );
    current();
    if (!isDeepStrictEqual(this.#identity(seen), this.#identity(latest)))
      refuse('DOCKER_RESOURCE_REVISION_IDENTITY_CHANGED');
    this.#fresh(latest);
    return latest;
  }
  async #highOnlyImage(current: () => void): Promise<string> {
    const selected = this.configuration.memoryHighHelperImageId;
    if (!selected) refuse('DOCKER_RESOURCE_MEMORY_HIGH_WRITE_UNSUPPORTED');
    current();
    const raw = z
      .array(
        z.object({
          Id: z.string(),
          Config: z.object({
            User: z.string(),
            Entrypoint: z.array(z.string()),
            Labels: z.record(z.string(), z.string()),
          }),
        })
      )
      .length(1)
      .parse(JSON.parse(await this.command.run(['image', 'inspect', selected])))[0]!;
    current();
    // This is an additional deny-only check on the operator-qualified immutable image pin.
    // Neither a request-provided label nor the old configure-high mode can substitute.
    if (
      raw.Id !== selected ||
      raw.Config.User !== '0:0' ||
      !isDeepStrictEqual(raw.Config.Entrypoint, ['/bin/reverie-docker-resources']) ||
      raw.Config.Labels['org.reverie.purpose'] !== 'boxed-resource-helper-v1' ||
      raw.Config.Labels['org.reverie.resource.memory-high-only'] !== 'v1'
    )
      refuse('DOCKER_RESOURCE_MEMORY_HIGH_WRITE_UNSUPPORTED');
    return selected;
  }
  /** Both historical ACK and fresh actual kernel facts. The ACK is never reported as current limits. */
  async #live(row: DockerEmployeeContinuationRecord, current: () => void = () => {}): Promise<Observation | null> {
    current();
    const pool = await this.observePool(row);
    current();
    if (!pool || !row.pool || !isDeepStrictEqual(pool, row.pool)) refuse('DOCKER_RESOURCE_POOL_CHANGED');
    const anchor = await this.#anchor(row);
    current();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const worker = await this.#worker(row);
    current();
    const seen = await this.#probe(anchor, worker);
    current();
    const issued = this.journal.read(row, 'leaf-helper');
    if (!issued || issued.phase === 'create-issued' || issued.phase === 'created') return null;
    if (!(await this.#ack(issued, seen, row.policy, row.policy.memoryHighBytes, true))) refuse('DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED');
    current();
    return this.#refresh(seen, current);
  }
  #identity(seen: Observation): DockerResourceLeafIdentity {
    return DockerResourceLeafIdentity.parse({
      boxId: seen.boxId,
      parent: seen.parent,
      anchor: seen.anchor,
      worker: seen.worker,
    });
  }
  #desired(row: DockerEmployeeContinuationRecord, revision?: string): DockerResourceDesiredRevision {
    const desired = this.revisions?.desired(row.owner);
    if (!desired || (revision !== undefined && desired.revision !== revision)) refuse();
    return desired;
  }
  #approved(
    row: DockerEmployeeContinuationRecord,
    seen: Observation
  ):
    | {
        policy: DockerEmployeeResourcePolicy;
        desired: DockerResourceDesiredRevision;
        attempt: DockerResourceAttempt;
      }
    | undefined {
    if (!this.revisions) return undefined;
    for (const { desired, attempt } of this.revisions.approved(row)) {
      const policy = dockerRevisedPolicy(row.policy, desired);
      if (
        attempt.state === 'helper' ||
        !this.#matches(seen, policy, policy.memoryHighBytes) ||
        !isDeepStrictEqual(attempt.identity, this.#identity(seen))
      )
        continue;
      return { policy, desired, attempt };
    }
    return undefined;
  }
  #publishProof(
    row: DockerEmployeeContinuationRecord,
    candidate: {
      policy: DockerEmployeeResourcePolicy;
      desired: DockerResourceDesiredRevision;
      attempt: DockerResourceAttempt;
    },
    seen: Observation,
    epoch: symbol
  ): void {
    const baselineImage = this.configuration.helperImageId,
      writeImage = this.configuration.memoryHighHelperImageId;
    let revoked = false;
    const proof = new DockerEffectiveResourceProof(
      effectiveOrigin,
      row,
      candidate.policy,
      candidate.desired,
      candidate.attempt,
      this.revisions!,
      this.#fresh(seen),
      () => {
        if (
          this.#epochs.get(row.request.operationId) !== epoch ||
          this.configuration.helperImageId !== baselineImage ||
          this.configuration.memoryHighHelperImageId !== writeImage
        )
          revoked = true;
        if (revoked) refuse('DOCKER_RESOURCE_REVISION_PROOF_CHANGED');
      }
    );
    proof.require(row, candidate.policy);
    this.#proofs.set(row.request.operationId, proof);
    if (this.#proofs.size > 128) this.#proofs.delete(this.#proofs.keys().next().value!);
  }
  existingPolicy(
    row: DockerEmployeeContinuationRecord,
    actual: DockerEmployeeResourcePolicy
  ): DockerEffectiveResourceProof {
    const proof = this.#proofs.get(row.request.operationId);
    requireDockerEffectiveResourceProof(proof, row, actual);
    return proof!;
  }
  async read(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeResourcePolicy | null> {
    const epoch = this.#beginRead(row);
    let seen = await this.#live(row);
    if (!seen) return null;
    if (this.#matches(seen, row.policy, row.policy.memoryHighBytes)) return structuredClone(row.policy);
    const candidate = this.#approved(row, seen);
    if (!candidate) return null;
    if (
      candidate.attempt.state === 'applied' &&
      !(await this.#ack(
        candidate.attempt.task,
        seen,
        candidate.policy,
        candidate.policy.memoryHighBytes,
        true,
        this.configuration.memoryHighHelperImageId
      ))
    )
      refuse('DOCKER_RESOURCE_REVISION_HELPER_UNACKNOWLEDGED');
    seen = await this.#refresh(seen);
    if (!isDeepStrictEqual(this.#approved(row, seen), candidate)) refuse();
    // Publication follows every required applied-helper ACK and fresh ledger/current-scope check.
    this.#publishProof(row, candidate, seen, epoch);
    return candidate.policy;
  }

  /** Read-only profile refresh. Actual unadopted high is visible DATA, never a revision ACK. */
  async observeMemoryHigh(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<{
    actualMemoryHighBytes: number | null;
    memoryMaxBytes: number;
    approved: boolean;
    approvalSource: 'original-policy' | 'owner-revision' | null;
    approvedRevision: string | null;
  }> {
    this.#beginRead(row);
    let seen = await this.#live(row, current);
    current();
    if (!seen || !dockerOtherResourceLimitsMatch(seen.resources, row.policy))
      refuse('DOCKER_RESOURCE_REVISION_OTHER_LIMIT_CHANGED');
    const candidate = this.#approved(row, seen);
    if (
      candidate?.attempt.state === 'applied' &&
      !(await this.#ack(
        candidate.attempt.task,
        seen,
        candidate.policy,
        candidate.policy.memoryHighBytes,
        true,
        this.configuration.memoryHighHelperImageId
      ))
    )
      refuse('DOCKER_RESOURCE_REVISION_HELPER_UNACKNOWLEDGED');
    current();
    seen = await this.#refresh(seen, current);
    if (!dockerOtherResourceLimitsMatch(seen.resources, row.policy))
      refuse('DOCKER_RESOURCE_REVISION_OTHER_LIMIT_CHANGED');
    const raw = seen.resources.memoryHigh;
    const actual = raw === 'max' ? null : /^(0|[1-9][0-9]{0,15})$/.test(raw) ? Number(raw) : NaN;
    if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) refuse('DOCKER_RESOURCE_REVISION_READBACK');
    const original = this.#matches(seen, row.policy, row.policy.memoryHighBytes);
    const finalCandidate = original ? undefined : this.#approved(row, seen);
    const approvedRevision =
      candidate && isDeepStrictEqual(candidate, finalCandidate) ? candidate.desired.revision : null;
    this.#fresh(seen);
    current();
    return {
      actualMemoryHighBytes: actual,
      memoryMaxBytes: row.policy.memoryMaxBytes,
      approved: original || approvedRevision !== null,
      approvalSource: original ? 'original-policy' : approvedRevision ? 'owner-revision' : null,
      approvedRevision,
    };
  }
  /** Explicit owner request. Native current facts may be adopted without a helper write.
   * An issued cursor is resumed by observation; never start an already-issued helper again. */
  async reviseMemoryHigh(
    row: DockerEmployeeContinuationRecord,
    revision: string,
    current: () => void
  ): Promise<{
    state: 'observed' | 'applied';
    policy: DockerEmployeeResourcePolicy;
  }> {
    if (!this.revisions || !['provider-issued', 'ready'].includes(row.phase)) refuse();
    const desired = this.#desired(row, revision),
      policy = dockerRevisedPolicy(row.policy, desired),
      baselineImage = this.configuration.helperImageId,
      writeImage = this.configuration.memoryHighHelperImageId;
    let revoked = false;
    const requireCurrent = () => {
      if (revoked) refuse('DOCKER_RESOURCE_REVISION_CHANGED');
      current();
      if (
        this.configuration.helperImageId !== baselineImage ||
        this.configuration.memoryHighHelperImageId !== writeImage
      ) {
        revoked = true;
        refuse('DOCKER_RESOURCE_REVISION_CHANGED');
      }
      if (!isDeepStrictEqual(this.#desired(row, revision), desired)) refuse();
      this.revisions!.requireSettled(row, revision);
    };
    requireCurrent();
    const seen = await this.#live(row, requireCurrent);
    requireCurrent();
    if (!seen?.worker || !dockerOtherResourceLimitsMatch(seen.resources, row.policy))
      refuse('DOCKER_RESOURCE_REVISION_OTHER_LIMIT_CHANGED');
    let attempt = this.revisions.attempt(row, revision);
    if (!attempt && this.#matches(seen, policy, policy.memoryHighBytes)) {
      await this.revisions.publish(
        row,
        desired,
        undefined,
        {
          ...dockerResourceAttemptKey(row, revision),
          state: 'observed',
          identity: this.#identity(seen),
          observationDigest: dockerContinuationDigest(seen),
        },
        requireCurrent
      );
      requireCurrent();
    } else if (!attempt || attempt.state === 'helper') {
      const imageId = await this.#highOnlyImage(requireCurrent);
      requireCurrent();
      const journal: DockerContinuationTaskJournal = {
        read: (_row, role) => {
          if (role !== 'leaf-helper') refuse();
          const value = this.revisions!.attempt(row, revision);
          return value?.state === 'helper' ? value.task : undefined;
        },
        publish: async (_row, before, next, requireTaskCurrent) => {
          requireCurrent();
          requireTaskCurrent();
          const old = this.revisions!.attempt(row, revision);
          if ((old && old.state !== 'helper') || !isDeepStrictEqual(old?.task, before)) refuse();
          await this.revisions!.publish(
            row,
            desired,
            old,
            { ...dockerResourceAttemptKey(row, revision), state: 'helper', task: next },
            requireCurrent
          );
          requireCurrent();
          return row;
        },
      };
      await this.#configureTask(
        row,
        'leaf-helper',
        [
          'configure-memory-high',
          '--box-id',
          this.configuration.boxId,
          '--anchor-id',
          seen.anchor.id,
          '--anchor-pid',
          String(seen.anchor.pid),
          '--anchor-start',
          seen.anchor.startTicks,
          '--worker-id',
          seen.worker.id,
          '--worker-pid',
          String(seen.worker.pid),
          '--worker-start',
          seen.worker.startTicks,
          ...(await this.#members(seen.worker.id)),
          '--leaf-dev',
          seen.worker.dev,
          '--leaf-ino',
          seen.worker.ino,
          '--memory-max',
          String(policy.memoryMaxBytes),
          '--swap-max',
          String(policy.swapMaxBytes),
          '--pids-max',
          String(policy.pidsMax),
          '--memory-high',
          String(policy.memoryHighBytes),
          '--cpu-weight',
          String(policy.cpuWeight),
          '--cpuset-cpus',
          canonicalCpus(policy.allowedCpus),
        ],
        { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
        requireCurrent,
        { id: revision, journal, imageId }
      );
      requireCurrent();
      attempt = this.revisions.attempt(row, revision);
      const actual = await this.#live(row, requireCurrent);
      requireCurrent();
      if (
        !actual ||
        !attempt ||
        attempt.state !== 'helper' ||
        attempt.task.phase !== 'completed' ||
        !isDeepStrictEqual(this.#identity(actual), this.#identity(seen)) ||
        !this.#matches(actual, policy, policy.memoryHighBytes) ||
        !(await this.#ack(attempt.task, actual, policy, policy.memoryHighBytes, true, imageId))
      )
        refuse('DOCKER_RESOURCE_REVISION_READBACK');
      requireCurrent();
      await this.revisions.publish(
        row,
        desired,
        attempt,
        {
          ...dockerResourceAttemptKey(row, revision),
          state: 'applied',
          task: attempt.task,
          identity: this.#identity(actual),
          observationDigest: dockerContinuationDigest(actual),
        },
        requireCurrent
      );
      requireCurrent();
    }
    const actual = await this.read(row);
    requireCurrent();
    const final = this.revisions.attempt(row, revision);
    if (!actual || !isDeepStrictEqual(actual, policy) || !final || final.state === 'helper')
      refuse('DOCKER_RESOURCE_REVISION_READBACK');
    return { state: final.state, policy: actual };
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
    if (!actual || !isDeepStrictEqual(actual, row.policy)) refuse('DOCKER_RESOURCE_WORKER_READBACK');
  }
}
