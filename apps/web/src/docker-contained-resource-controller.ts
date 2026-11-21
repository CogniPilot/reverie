import { dockerResourceProbeReadRace } from './docker-engine-command.js';
import { dockerOriginalAttemptKey } from './docker-resource-revisions.js';
import {
  requireDockerOriginalResourceWriterProof,
  requireDockerOriginalResourcePrestartProof,
} from './docker-resource-original-writer.js';
/** Docker-only orchestration of the fixed Rust resource helper. Canonical task
 * cursors precede create/start; a failed reply never authorizes a second effect. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DockerResourceObservation as observation,
  type DockerResourceObservation as Observation,
  DockerPoolObservationRecord,
  DockerPoolRestoreAcknowledgement,
} from './docker-pool-observation-data.js';
import { DockerEmployeePoolPolicy, DockerEmployeeResourcePolicy } from './docker-employee-continuation-data.js';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type {
  DockerEmployeeContinuationRecord,
  DockerEmployeeOriginal,
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
  DockerResourceClosedWriter,
  type DockerResourceDesiredRevision,
  type DockerResourceAttempt,
} from './docker-resource-revisions.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import {
  dockerResourceHelperConfiguration,
  inspectDockerResourceContainer,
  requireDockerResourceHelperConfiguration,
  requireDockerMemoryHighHelperImage,
  requireDockerPoolRestoreHelperImage,
} from './docker-resource-helper-inspection.js';
import { DockerOriginalResourceWriterReader } from './docker-resource-original-writer.js';
import { parseDockerLeafWriterArguments } from './docker-resource-leaf-census.js';

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
  /** Separate immutable restore capability; never replaces the original anchor pin. */
  readonly poolRestoreHelperImageId?: string;
  /** Canonical selected bindings AND retained destinations. These IDs are DATA;
   * Engine/current kernel observations must independently validate every one. */
  selectedWorkerContainerIds(): readonly string[] | Promise<readonly string[]>;
  /** Original issued pool helpers from the canonical operation journal, for
   * later employees sharing the same actually acknowledged pool. */
  retainedPoolConfigurationTasks?(): readonly DockerContinuationTask[];
  requireColdPoolIdle?(): void;
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
        this.#attempt.state === 'closed-writer' ||
        this.#attempt.state === 'unstarted-retired' ||
        this.#attempt.state === 'original-closed' ||
        this.#attempt.state === 'original-retired' ||
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
  if (!(proof instanceof DockerEffectiveResourceProof)) refuse('DOCKER_RESOURCE_REVISION_PROOF_REQUIRED');
  DockerEffectiveResourceProof.prototype.require.call(proof as DockerEffectiveResourceProof, row, actual);
}
export class DockerContainedResources implements DockerContainedResourceController {
  readonly #parent: string;
  readonly #slice: string;
  /** A policy returned by one native read owns its proof. A later read cannot
   * replace it, and a JSON/structural copy cannot retrieve that authority. */
  readonly #proofs = new WeakMap<DockerEmployeeResourcePolicy, DockerEffectiveResourceProof>();
  readonly #epochs = new Map<string, symbol>();
  readonly #readFacts = new Map<string, string>();
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
      (configuration.poolRestoreHelperImageId !== undefined &&
        !/^sha256:[a-f0-9]{64}$/.test(configuration.poolRestoreHelperImageId)) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(configuration.deployment)
    )
      throw Error('Fixed contained resource configuration required');
    this.#slice = `reverie-box-${configuration.boxId}.slice`;
    this.#parent = `/reverie.slice/reverie-box.slice/${this.#slice}`;
  }
  originalWriterReader(): DockerOriginalResourceWriterReader {
    return new DockerOriginalResourceWriterReader(this.command);
  }
  async #inspect(id: string, command: DockerEngineCommand = this.command): Promise<Record<string, unknown>> {
    return inspectDockerResourceContainer(command, id);
  }
  async #init(id: string, command: DockerEngineCommand = this.command): Promise<Init | null> {
    const raw = await this.#inspect(id, command);
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
    const ticks = startTicks(await command.run(['exec', id, '/bin/cat', '/proc/1/stat']));
    const after = await this.#inspect(id, command);
    if (!isDeepStrictEqual(raw.State, after.State)) refuse('DOCKER_RESOURCE_INIT_CHANGED');
    return { id, pid: state.Pid, startTicks: ticks };
  }
  async #members(
    worker?: string,
    command: DockerEngineCommand = this.command,
    bindings?: Record<string, unknown>[],
    deadline?: number
  ): Promise<string[]> {
    if (deadline !== undefined) {
      const remaining = Math.floor(deadline - performance.now());
      if (!Number.isFinite(remaining) || remaining <= 0) refuse('DOCKER_RESOURCE_PROBE_DEADLINE');
    }
    const selected = this.configuration.selectedWorkerContainerIds();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let values: readonly string[];
    try {
      if (deadline === undefined) values = await selected;
      else {
        values = await Promise.race([
          Promise.resolve(selected),
          new Promise<never>((_resolve, reject) => {
            const remaining = Math.floor(deadline - performance.now());
            timer = setTimeout(
              () => reject(new DockerEmployeeContinuationError('DOCKER_RESOURCE_PROBE_DEADLINE')),
              Number.isFinite(remaining) ? Math.max(0, remaining) : 0
            );
          }),
        ]);
        const settledAt = performance.now();
        if (!Number.isFinite(settledAt) || settledAt >= deadline) refuse('DOCKER_RESOURCE_PROBE_DEADLINE');
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const ids = [...values];
    if (ids.length > 64 || new Set(ids).size !== ids.length) refuse('DOCKER_RESOURCE_MEMBERS_UNKNOWN');
    const args: string[] = [];
    for (const id of ids.sort()) {
      cid.parse(id);
      if (id === worker) continue;
      const raw = await this.#inspect(id, command);
      const config = z.object({ Labels: z.record(z.string(), z.string()) }).parse(raw.Config);
      const host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
      if (config.Labels['reverie.boxed.instance'] !== this.configuration.deployment || host.PidMode === 'host')
        refuse('DOCKER_RESOURCE_MEMBER_BINDING_CHANGED');
      const init = await this.#init(id, command);
      bindings?.push({
        Id: raw.Id,
        Image: raw.Image,
        Config: raw.Config,
        HostConfig: raw.HostConfig,
        State: raw.State,
      });
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
    return dockerResourceHelperConfiguration(this.configuration.boxId, role, name, args, writable, imageId);
  }
  async #fixed(id: string, desired: Config): Promise<Record<string, unknown>> {
    const raw = await this.#inspect(id);
    requireDockerResourceHelperConfiguration(raw, desired);
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
  async #probe(anchor: Init, worker?: Init, attempts = 3): Promise<Observation> {
    const end = performance.now() + 30000;
    const remaining = () => {
      const value = Math.floor(end - performance.now());
      if (!Number.isFinite(value) || value <= 0) refuse('DOCKER_RESOURCE_PROBE_DEADLINE');
      return Math.min(30000, value);
    };
    const command: DockerEngineCommand = {
      run: (args, input) => {
        const inspect = args.length === 3 && args[0] === 'container' && args[1] === 'inspect';
        const init = args.length === 4 && args[0] === 'exec' && args[2] === '/bin/cat' && args[3] === '/proc/1/stat';
        const probe =
          args[0] === 'exec' &&
          args[2] === '/bin/reverie-docker-resources' &&
          ['probe-pool', 'probe-worker'].includes(args[3] ?? '');
        if (input !== undefined || (!inspect && !init && !probe)) refuse('DOCKER_RESOURCE_PROBE_READ_REQUIRED');
        return this.command.run(args, undefined, remaining());
      },
      create: async () => refuse('DOCKER_RESOURCE_PROBE_READ_REQUIRED'),
    };
    const scope = async () => {
      const rawAnchor = await this.#inspect(anchor.id, command);
      const state = z.object({ Running: z.literal(true), Pid: z.literal(anchor.pid) }).parse(rawAnchor.State);
      void state;
      const rawWorker = worker ? await this.#inspect(worker.id, command) : undefined;
      if (worker && !isDeepStrictEqual(await this.#init(worker.id, command), worker))
        refuse('DOCKER_RESOURCE_OBSERVATION_CHANGED');
      const bindings: Record<string, unknown>[] = [];
      const members = await this.#members(worker?.id, command, bindings, end);
      return {
        anchor: {
          Id: rawAnchor.Id,
          Image: rawAnchor.Image,
          Config: rawAnchor.Config,
          HostConfig: rawAnchor.HostConfig,
          State: rawAnchor.State,
        },
        worker: rawWorker
          ? {
              Id: rawWorker.Id,
              Image: rawWorker.Image,
              Config: rawWorker.Config,
              HostConfig: rawWorker.HostConfig,
              State: rawWorker.State,
            }
          : null,
        members,
        bindings,
      };
    };
    const initial = await scope();
    let result!: Observation,
      started = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt && !isDeepStrictEqual(await scope(), initial)) refuse('DOCKER_RESOURCE_OBSERVATION_CHANGED');
      const args = [
        worker ? 'probe-worker' : 'probe-pool',
        '--box-id',
        this.configuration.boxId,
        '--anchor-id',
        anchor.id,
        '--anchor-pid',
        String(anchor.pid),
        ...(anchor.startTicks ? ['--anchor-start', anchor.startTicks] : []),
        ...initial.members,
      ];
      if (worker)
        args.push('--worker-id', worker.id, '--worker-pid', String(worker.pid), '--worker-start', worker.startTicks);
      const argv = ['exec', anchor.id, '/bin/reverie-docker-resources', ...args];
      started = performance.now();
      try {
        result = observation.parse(JSON.parse(await command.run(argv)));
        break;
      } catch (error) {
        if (attempt === attempts - 1 || !dockerResourceProbeReadRace(error, argv)) throw error;
      }
    }
    remaining();
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
    const restore = !worker && task.imageId === this.configuration.poolRestoreHelperImageId;
    if (
      !('containerId' in task) ||
      !['start-issued', 'running', 'completed'].includes(task.phase) ||
      task.role !== (worker ? 'leaf-helper' : 'pool-helper') ||
      task.imageId !==
        (revisionImage ?? (restore ? this.configuration.poolRestoreHelperImageId : this.configuration.helperImageId))
    )
      return false;
    const raw = await this.#inspect(task.containerId);
    const args = z.object({ Cmd: z.array(z.string()).min(1).max(512) }).parse(raw.Config).Cmd;
    if (
      args[0] !==
      (revisionImage
        ? 'configure-memory-high'
        : worker
          ? 'configure-high'
          : restore
            ? 'restore-pool'
            : 'configure-pool')
    )
      return false;
    if (restore) {
      await requireDockerPoolRestoreHelperImage(this.command, task.imageId, () => {});
    }
    const writable = {
      path: worker ? fresh.worker!.path : this.#parent,
      target: worker ? '/run/reverie-worker-cgroup' : '/run/reverie-box-pool',
    };
    const config = this.#configuration(
      task.role,
      task.name,
      args,
      writable,
      revisionImage ?? (restore ? task.imageId : undefined)
    );
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
    const output: unknown = JSON.parse(await this.command.run(['container', 'logs', task.containerId]));
    const acknowledged = restore ? DockerPoolRestoreAcknowledgement.parse(output) : observation.parse(output);
    if (
      restore &&
      !isDeepStrictEqual(
        args,
        this.#restoreArguments(
          fresh,
          policy,
          (acknowledged as z.infer<typeof DockerPoolRestoreAcknowledgement>).members
        )
      )
    )
      return false;
    const result = restore
      ? (acknowledged as z.infer<typeof DockerPoolRestoreAcknowledgement>).observation
      : (acknowledged as Observation);
    if (task.phase === 'completed' && task.resultDigest !== dockerContinuationDigest(acknowledged)) return false;
    return (
      result.boxId === fresh.boxId &&
      isDeepStrictEqual(result.parent, fresh.parent) &&
      isDeepStrictEqual(result.anchor, fresh.anchor) &&
      isDeepStrictEqual(result.worker, worker ? fresh.worker : null) &&
      this.#matches(result, policy, high)
    );
  }
  async #poolWriterState(task: DockerContinuationTask): Promise<'closed' | 'removed' | 'unconfirmed'> {
    if (task.phase === 'create-issued' || task.phase === 'created') return 'closed';
    const restore = task.imageId === this.configuration.poolRestoreHelperImageId;
    if (
      task.role !== 'pool-helper' ||
      (!restore && task.imageId !== this.configuration.helperImageId) ||
      !('containerId' in task)
    )
      return 'unconfirmed';
    if (task.phase === 'completed') {
      // An absent completed writer cannot supply an ACK. Use an unscoped
      // exact-ID census so a changed label cannot hide a still-present writer.
      const selected = (
        await this.command.run([
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          'id=' + task.containerId,
          '--format',
          '{{.ID}}',
        ])
      ).trim();
      if (!selected) return 'removed';
      if (selected !== task.containerId) return 'unconfirmed';
    }
    const raw = await this.#inspect(task.containerId);
    const args = z.array(z.string()).min(1).max(512).parse(z.record(z.string(), z.unknown()).parse(raw.Config).Cmd);
    if (args[0] !== (restore ? 'restore-pool' : 'configure-pool')) return 'unconfirmed';
    if (restore) await requireDockerPoolRestoreHelperImage(this.command, task.imageId, () => {});
    const expected = this.#configuration(
      'pool-helper',
      task.name,
      args,
      {
        path: this.#parent,
        target: '/run/reverie-box-pool',
      },
      restore ? task.imageId : undefined
    );
    if (dockerContinuationDigest(expected) !== task.configurationDigest) return 'unconfirmed';
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
    const closed =
      state.Status === 'exited' &&
      !state.Running &&
      !state.Paused &&
      !state.Restarting &&
      !state.Dead &&
      state.ExitCode >= 0 &&
      state.ExitCode <= 255 &&
      (state.Error ?? '') === '';
    return closed ? 'closed' : 'unconfirmed';
  }
  async #poolWritersClosed(except?: DockerContinuationTask): Promise<DockerContinuationTask[]> {
    const prior = this.configuration.retainedPoolConfigurationTasks?.() ?? [];
    if (prior.length > 128) refuse('DOCKER_RESOURCE_POOL_OWNERS_UNKNOWN');
    const retained: DockerContinuationTask[] = [];
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
      const state = await this.#poolWriterState(task);
      if (state === 'unconfirmed') refuse('DOCKER_RESOURCE_POOL_WRITER_UNCONFIRMED');
      if (state === 'closed') retained.push(task);
    }
    return retained;
  }
  async #poolAck(row: DockerEmployeeContinuationRecord, fresh: Observation): Promise<void> {
    const own = this.journal.read(row, 'pool-helper');
    // A delayed earlier configure must not race this fresh probe. Its persisted
    // START fence remains unknown until the ORIGINAL fixed container is terminal.
    const prior = await this.#poolWritersClosed();
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
  #restoreArguments(
    seen: Observation,
    policy: DockerEmployeeResourcePolicy['pool'],
    members: NonNullable<Observation['worker']>[]
  ): string[] {
    return [
      'restore-pool',
      ...this.#poolArguments(seen, policy).slice(1),
      ...members.flatMap((member) => ['--member', `${member.id}:${member.pid}:${member.startTicks}`]),
    ];
  }
  async #poolCensus(role: 'anchor' | 'pool-helper' | 'leaf-helper'): Promise<string[]> {
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
    const history: DockerContinuationTask[] = [];
    for (const candidate of ids) {
      const raw = await this.#inspect(candidate);
      current();
      const label = z.record(z.string(), z.string()).parse(z.record(z.string(), z.unknown()).parse(raw.Config).Labels);
      const taskName = z
        .string()
        .regex(/^reverie-boxed-pool-helper-[a-f0-9]{64}$/)
        .parse(label['reverie.box.resource.name']);
      const restore = raw.Image === this.configuration.poolRestoreHelperImageId;
      const imageId = restore ? this.configuration.poolRestoreHelperImageId! : this.configuration.helperImageId;
      if (raw.Image !== imageId) refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
      if (restore) await requireDockerPoolRestoreHelperImage(this.command, imageId, current);
      // The terminal ACK records the complete scope at the ORIGINAL write.
      // Current membership is independently earned by the fresh Rust probe;
      // leaving or replacing a worker cannot rewrite this historical receipt.
      const output: unknown = JSON.parse(await this.command.run(['container', 'logs', candidate]));
      const historical = restore ? DockerPoolRestoreAcknowledgement.parse(output) : undefined;
      const acknowledged = historical?.observation ?? observation.parse(output);
      if (
        acknowledged.boxId !== fresh.boxId ||
        acknowledged.parent.path !== fresh.parent.path ||
        acknowledged.anchor.id !== fresh.anchor.id ||
        acknowledged.worker !== null
      ) refuse('DOCKER_POOL_ORIGINAL_ACK_CHANGED');
      const sameEpoch =
        isDeepStrictEqual(acknowledged.parent, fresh.parent) && isDeepStrictEqual(acknowledged.anchor, fresh.anchor);
      current();
      const epoch = sameEpoch ? fresh : acknowledged;
      const args = restore
        ? this.#restoreArguments(epoch, policy, historical!.members)
        : this.#poolArguments(epoch, policy);
      current();
      const expected = this.#configuration(
        'pool-helper',
        taskName,
        args,
        {
          path: this.#parent,
          target: '/run/reverie-box-pool',
        },
        imageId
      );
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
      const task = DockerContinuationTask.parse({
        role: 'pool-helper',
        name: taskName,
        imageId,
        configurationDigest: dockerContinuationDigest(expected),
        phase: 'completed',
        containerId: candidate,
        resultDigest: dockerContinuationDigest(historical ?? acknowledged),
      });
      if (!(await this.#ack(task, epoch, policy, null, false))) refuse('DOCKER_POOL_ORIGINAL_ACK_CHANGED');
      current();
      if (sameEpoch) {
        matches.push(task);
      } else {
        // A retained, closed helper from an earlier epoch is part of the
        // writer census. It cannot acknowledge the current resource limits.
        this.#requireHistoricalPoolWriter(task);
        history.push(task);
      }
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
    for (const task of history) {
      this.#requireHistoricalPoolWriter(task);
      if ((await this.#poolWriterState(task)) !== 'closed') refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
      current();
    }
    if (
      !isDeepStrictEqual(await this.#poolCensus('pool-helper'), ids) ||
      !isDeepStrictEqual(await this.#poolCensus('anchor'), anchors)
    )
      refuse('DOCKER_POOL_CENSUS_UNCONFIRMED');
    current();
    // Only a closed writer with an ACK for the current epoch can supply the
    // observation. Picking one does not attribute the pool to an old operation.
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
      version: chosen.imageId === this.configuration.poolRestoreHelperImageId ? 2 : 1,
      ...(chosen.imageId === this.configuration.poolRestoreHelperImageId
        ? { poolRestoreHelperImageId: chosen.imageId }
        : {}),
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
  #requireHistoricalPoolWriter(task: DockerContinuationTask): void {
    const digest = dockerContinuationDigest(task);
    const retained = this.configuration.retainedPoolConfigurationTasks?.() ?? [];
    if (!retained.some((reference) => dockerContinuationDigest(reference) === digest))
      refuse('DOCKER_POOL_ORIGINAL_ACK_CHANGED');
  }
  /** Plan permission does not authorize a shared pool writer. Adopt only the
   * actual fixed already-running anchor and an already-enforced pool with its
   * original terminal ACK. No CREATE/START/configure is reachable here. */
  async prepareRetainedPool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const admitted = current;
    current = () => { admitted(); this.configuration.requireColdPoolIdle?.(); };
    current();
    const name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32),
      config = this.#configuration('anchor', name, ['anchor']),
      base = {
        role: 'anchor' as const,
        name,
        imageId: this.configuration.helperImageId,
        configurationDigest: dockerContinuationDigest(config),
      };
    let task = this.journal.read(row, 'anchor');
    if (!task) {
      await this.journal.publish(row, undefined, { ...base, phase: 'create-issued' }, current);
      current();
      task = this.journal.read(row, 'anchor');
    }
    if (
      !task ||
      task.name !== name ||
      task.imageId !== base.imageId ||
      task.configurationDigest !== base.configurationDigest
    )
      refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    if (task.phase === 'create-issued') {
      const ids = (
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
      const id = cid.parse(ids);
      await this.#fixed(id, config);
      current();
      const init = await this.#init(id);
      current();
      if (!init) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
      await this.journal.publish(row, task, { ...base, phase: 'created', containerId: id }, current);
      current();
      task = this.journal.read(row, 'anchor');
    }
    if (!task || !('containerId' in task)) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const raw = await this.#fixed(task.containerId, config);
    current();
    if ((raw.State as { Running?: unknown }).Running !== true) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const anchor = await this.#init(task.containerId);
    current();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const seen = await this.#probe(anchor);
    current();
    if (!this.#matches(seen, row.policy.pool, null)) refuse('DOCKER_PLAN_SHARED_POOL_POLICY_CHANGED');
    await this.#poolAck(row, seen);
    current();
    if (task.phase === 'created' || task.phase === 'start-issued') {
      await this.journal.publish(
        row,
        task,
        {
          ...base,
          phase: 'running',
          containerId: task.containerId,
          initPid: anchor.pid,
          initStartTicks: seen.anchor.startTicks,
        },
        current
      );
      current();
    } else if (
      task.phase !== 'running' ||
      task.initPid !== anchor.pid ||
      task.initStartTicks !== seen.anchor.startTicks
    )
      refuse('DOCKER_RESOURCE_ANCHOR_REPLACED');
    const after = await this.#anchor(row);
    current();
    if (!after || after.id !== anchor.id || after.pid !== anchor.pid || after.startTicks !== seen.anchor.startTicks)
      refuse('DOCKER_RESOURCE_ANCHOR_REPLACED');
  }
  async preparePool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const admitted = current;
    current = () => { admitted(); this.configuration.requireColdPoolIdle?.(); };
    current();
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
  /** Preview the exact externally stopped anchor and the current empty worker
   * selection. Only the owner workflow can persist and consume this scope. */
  async coldPoolScope(row: DockerEmployeeContinuationRecord, current: () => void) {
    current();
    const original = row.tasks?.find(task => task.role === 'anchor');
    const name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32);
    const configuration = this.#configuration('anchor', name, ['anchor']);
    if (!row.pool || original?.phase !== 'running' || original.containerId !== row.pool.containerId ||
        original.configurationDigest !== dockerContinuationDigest(configuration) ||
        row.pool.cgroupParent !== this.#slice || row.pool.policyDigest !== dockerContinuationDigest(row.policy.pool))
      refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const id = original.containerId;
    const state = await this.#stoppedPoolAnchor(id, configuration, current);
    const members = await this.#coldPoolMembers(current);
    const helpers = await this.#poolCensus('pool-helper');
    current();
    const retained = await this.#poolWritersClosed();
    current();
    if (helpers.some(helper => !retained.some(task => task.phase === 'completed' && task.containerId === helper)))
      refuse('DOCKER_POOL_COLD_WRITER_UNCONFIRMED');
    if (dockerContinuationDigest(await this.#stoppedPoolAnchor(id, configuration, current)) !== dockerContinuationDigest(state) ||
        !isDeepStrictEqual(await this.#poolCensus('pool-helper'), helpers))
      refuse('DOCKER_POOL_COLD_SOURCE_CHANGED');
    current();
    return { id, state, configuration, members, digest: dockerContinuationDigest({
      original, state, members, helpers, policy: row.policy.pool,
    }) };
  }
  async #stoppedPoolAnchor(id: string, configuration: Config, current: () => void) {
    const anchors = await this.#poolCensus('anchor');
    current();
    if (anchors.length !== 1 || anchors[0] !== id) refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const raw = await this.#fixed(id, configuration);
    current();
    return z.object({
      Status: z.literal('exited'), Running: z.literal(false), Restarting: z.literal(false),
      Paused: z.literal(false), Dead: z.literal(false), Pid: z.literal(0),
      OOMKilled: z.literal(false), Error: z.literal(''),
      StartedAt: z.string().datetime(), FinishedAt: z.string().datetime(),
    }).passthrough().parse(raw.State);
  }
  async #coldPoolMembers(current: () => void): Promise<string> {
    const bindings: Record<string, unknown>[] = [];
    const active = await this.#members(undefined, this.command, bindings);
    current();
    if (active.length) refuse('DOCKER_POOL_COLD_WORKERS_RUNNING');
    return dockerContinuationDigest(bindings);
  }
  /** The caller's exclusive durable attempt precedes the anchor START. The
   * normal helper cursors independently precede helper CREATE and START. */
  async recoverColdPool(
    row: DockerEmployeeContinuationRecord,
    attempt: { id: string; nativeDigest: string },
    journal: DockerContinuationTaskJournal,
    current: () => void,
  ): Promise<DockerPoolReconciliationReceipt> {
    const source = await this.coldPoolScope(row, current);
    if (attempt.nativeDigest !== source.digest) refuse('DOCKER_POOL_COLD_SOURCE_CHANGED');
    current();
    await this.command.run(['container', 'start', source.id]);
    current();
    const started = await this.#fixed(source.id, source.configuration);
    current();
    if (!z.object({ Running: z.literal(true), StartedAt: z.string().datetime() })
      .refine(state => Date.parse(state.StartedAt) > Date.parse(source.state.StartedAt)).safeParse(started.State).success)
      refuse('DOCKER_POOL_COLD_START_UNCONFIRMED');
    const init = await this.#init(source.id);
    current();
    if (!init || await this.#coldPoolMembers(current) !== source.members)
      refuse('DOCKER_POOL_COLD_SOURCE_CHANGED');
    const seen = await this.#probe(init);
    current();
    await this.#configureTask(row, 'pool-helper', this.#poolArguments(seen, row.policy.pool), {
      path: this.#parent, target: '/run/reverie-box-pool',
    }, current, { id: attempt.id, journal, imageId: this.configuration.helperImageId });
    current();
    return this.capturePoolObservation(row.policy.pool, current);
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
    this.#readFacts.delete(row.request.operationId);
    this.#epochs.set(row.request.operationId, epoch);
    if (this.#epochs.size > 128) {
      const oldest = this.#epochs.keys().next().value!;
      this.#epochs.delete(oldest);
      this.#readFacts.delete(oldest);
    }
    return epoch;
  }
  #readEpoch(row: DockerEmployeeContinuationRecord): symbol {
    return this.#epochs.get(row.request.operationId) ?? this.#beginRead(row);
  }
  #recordRead(row: DockerEmployeeContinuationRecord, seen: Observation, policy: DockerEmployeeResourcePolicy): symbol {
    const key = row.request.operationId;
    const facts = dockerContinuationDigest({ identity: this.#identity(seen), policy });
    const previous = this.#readFacts.get(key);
    let epoch = this.#readEpoch(row);
    if (previous !== undefined && previous !== facts) epoch = this.#beginRead(row);
    this.#readFacts.set(key, facts);
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
  async #refresh(seen: Observation, current: () => void = () => {}, attempts = 3): Promise<Observation> {
    if (!seen.worker) refuse('DOCKER_RESOURCE_WORKER_READBACK');
    current();
    const latest = await this.#probe(
      { id: seen.anchor.id, pid: seen.anchor.pid, startTicks: seen.anchor.startTicks },
      { id: seen.worker.id, pid: seen.worker.pid, startTicks: seen.worker.startTicks },
      attempts
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
    await this.#qualifiedHighImage(selected, current);
    return selected;
  }
  async #qualifiedHighImage(selected: string, current: () => void): Promise<void> {
    return requireDockerMemoryHighHelperImage(this.command, selected, current);
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
    if (row.version !== 3 && ['provider-issued', 'ready'].includes(row.phase) && issued.phase === 'completed') {
      const ids = await this.#poolCensus('leaf-helper');
      current();
      if (!ids.includes(issued.containerId)) return this.#replacementLeafObservation(row, issued, seen, ids, current);
    }
    if (!(await this.#ack(issued, seen, row.policy, row.policy.memoryHighBytes, true)))
      refuse('DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED');
    current();
    return this.#refresh(seen, current);
  }
  async #closedLeafWriters(ids: readonly string[], current: () => void) {
    const result: { id: string; name: string; args: string[]; scopeArguments: string[]; imageId: string }[] = [];
    for (const id of ids) {
      const raw = await this.#inspect(id);
      current();
      const config = z
        .object({ Cmd: z.array(z.string().max(4096)).min(1).max(512), Labels: z.record(z.string(), z.string()) })
        .parse(raw.Config);
      const name = z
        .string()
        .regex(/^reverie-boxed-leaf-helper-[a-f0-9]{64}$/)
        .parse(config.Labels['reverie.box.resource.name']);
      const parsed = parseDockerLeafWriterArguments(config.Cmd, this.configuration.boxId);
      if (parsed.cpus) cpus(parsed.cpus);
      const imageId =
        parsed.mode === 'configure-high'
          ? this.configuration.helperImageId
          : this.configuration.memoryHighHelperImageId;
      if (!imageId) refuse('DOCKER_RESOURCE_LEAF_WRITER_UNCONFIRMED');
      if (parsed.mode === 'configure-memory-high') await this.#qualifiedHighImage(imageId, current);
      current();
      await this.#fixed(
        id,
        this.#configuration(
          'leaf-helper',
          name,
          config.Cmd,
          {
            path: this.#parent + '/docker-' + parsed.workerId + '.scope',
            target: '/run/reverie-worker-cgroup',
          },
          imageId
        )
      );
      current();
      const state = z
        .object({
          Status: z.literal('exited'),
          Running: z.literal(false),
          Paused: z.literal(false),
          Restarting: z.literal(false),
          Dead: z.literal(false),
          Pid: z.literal(0),
          ExitCode: z.number().int().min(0).max(255),
          Error: z.string().optional(),
        })
        .parse(raw.State);
      if ((state.Error ?? '') !== '') refuse('DOCKER_RESOURCE_LEAF_WRITER_UNCONFIRMED');
      result.push({ id, name, args: config.Cmd, scopeArguments: parsed.scopeArguments, imageId });
    }
    return result;
  }
  #leafArguments(seen: Observation, policy: DockerEmployeeResourcePolicy, members: readonly string[]): string[] {
    if (!seen.worker || policy.memoryHighBytes === null) refuse('DOCKER_RESOURCE_FINITE_HIGH_REQUIRED');
    return [
      'configure-high',
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
      ...members,
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
    ];
  }
  /** Fresh terminal ACK discovery only. The old completed cursor is never rewritten. */
  async #replacementLeafObservation(
    row: DockerEmployeeContinuationRecord,
    original: DockerContinuationTask,
    seen: Observation,
    ids: string[],
    current: () => void
  ): Promise<Observation> {
    const scope = dockerResourceScope(row),
      originalDigest = dockerContinuationDigest(original);
    const check = () => {
      current();
      const retained = this.journal.read(row, 'leaf-helper');
      if (
        dockerResourceScope(row) !== scope ||
        row.version === 3 ||
        !['provider-issued', 'ready'].includes(row.phase) ||
        !retained ||
        dockerContinuationDigest(retained) !== originalDigest
      )
        refuse('DOCKER_RESOURCE_LEAF_OBSERVATION_CHANGED');
    };
    check();
    const pool = await this.capturePoolObservation(row.policy.pool, check);
    pool.require();
    const writers = await this.#closedLeafWriters(ids, check);
    const members = await this.#members(seen.worker?.id);
    check();
    // A terminal helper proves its original membership. Current complete
    // membership is earned by fresh native probes, not that historical list.
    const expected = this.#leafArguments(seen, row.policy, []),
      matches: DockerContinuationTask[] = [];
    for (const writer of writers) {
      if (writer.imageId !== this.configuration.helperImageId || !isDeepStrictEqual(writer.scopeArguments, expected))
        continue;
      const ack = observation.parse(JSON.parse(await this.command.run(['container', 'logs', writer.id])));
      check();
      const task = DockerContinuationTask.parse({
        role: 'leaf-helper',
        name: writer.name,
        imageId: writer.imageId,
        configurationDigest: dockerContinuationDigest(
          this.#configuration('leaf-helper', writer.name, writer.args, {
            path: seen.worker!.path,
            target: '/run/reverie-worker-cgroup',
          })
        ),
        phase: 'completed',
        containerId: writer.id,
        resultDigest: dockerContinuationDigest(ack),
      });
      if (!(await this.#ack(task, seen, row.policy, row.policy.memoryHighBytes, true)))
        refuse('DOCKER_RESOURCE_LEAF_ACK_CHANGED');
      check();
      matches.push(task);
    }
    if (!matches.length) refuse('DOCKER_RESOURCE_LEAF_ACK_MISSING');
    const after = await this.#poolCensus('leaf-helper');
    check();
    if (!isDeepStrictEqual(after, ids) || !isDeepStrictEqual(await this.#closedLeafWriters(after, check), writers))
      refuse('DOCKER_RESOURCE_LEAF_CENSUS_CHANGED');
    (await this.capturePoolObservation(row.policy.pool, check)).require();
    if (!isDeepStrictEqual(await this.#members(seen.worker?.id), members)) refuse('DOCKER_RESOURCE_MEMBERS_CHANGED');
    check();
    const fresh = await this.#refresh(seen, check);
    // The ACK proves the historical policy. A later approved high-only revision
    // is resolved by #read/#approved, never by rewriting that historical ACK.
    if (!dockerOtherResourceLimitsMatch(fresh.resources, row.policy)) refuse('DOCKER_RESOURCE_WORKER_READBACK');
    for (const task of matches) {
      if (!(await this.#ack(task, fresh, row.policy, row.policy.memoryHighBytes, true)))
        refuse('DOCKER_RESOURCE_LEAF_ACK_CHANGED');
      check();
    }
    const confirmed = await this.#refresh(fresh, check);
    if (!dockerOtherResourceLimitsMatch(confirmed.resources, row.policy)) refuse('DOCKER_RESOURCE_WORKER_READBACK');
    check();
    return confirmed;
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
  /** Canonical issued-image history is read authority only; it never selects a new writer.
   * Double terminal/config observations bracket a fresh same-leaf kernel observation. */
  #writerConfiguration(
    row: DockerEmployeeContinuationRecord,
    desired: DockerResourceDesiredRevision,
    task: DockerContinuationTask,
    seen: Observation,
    raw: Record<string, unknown>
  ): Config {
    if (!seen.worker) refuse();
    const name =
      'reverie-boxed-leaf-helper-' +
      dockerContinuationDigest([this.configuration.boxId, 'leaf-helper', row.request.operationId, desired.revision]);
    if (task.name !== name) refuse();
    const args = z.object({ Cmd: z.array(z.string()).min(1).max(512) }).parse(raw.Config).Cmd;
    const plain: string[] = [],
      members = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '--member') {
        plain.push(args[index]!);
        continue;
      }
      const value = args[++index];
      if (
        !value ||
        !/^[a-f0-9]{64}:[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(value) ||
        members.size >= 64 ||
        members.has(value.split(':')[0]!)
      )
        refuse();
      members.add(value.split(':')[0]!);
    }
    const policy = dockerRevisedPolicy(row.policy, desired);
    const expected = [
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
    ];
    if (!isDeepStrictEqual(plain, expected)) refuse('DOCKER_RESOURCE_REVISION_WRITER_CHANGED');
    const config = this.#configuration(
      'leaf-helper',
      name,
      args,
      { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
      task.imageId
    );
    if (dockerContinuationDigest(config) !== task.configurationDigest) refuse();
    return config;
  }
  async #closedWriter(
    row: DockerEmployeeContinuationRecord,
    desired: DockerResourceDesiredRevision,
    task: DockerContinuationTask,
    seen: Observation,
    current: () => void
  ): Promise<{ closure: DockerResourceClosedWriter; seen: Observation }> {
    current();
    if (
      task.role !== 'leaf-helper' ||
      !('containerId' in task) ||
      !['start-issued', 'running', 'completed'].includes(task.phase) ||
      !seen.worker
    )
      refuse('DOCKER_RESOURCE_REVISION_WRITER_UNCONFIRMED');
    await this.#qualifiedHighImage(task.imageId, current);
    current();
    const raw = await this.#inspect(task.containerId);
    current();
    const config = this.#writerConfiguration(row, desired, task, seen, raw);
    const terminal = (value: Record<string, unknown>) => {
      const state = z
        .object({
          Status: z.literal('exited'),
          Running: z.literal(false),
          Pid: z.literal(0),
          Paused: z.literal(false),
          Restarting: z.literal(false),
          Dead: z.literal(false),
          ExitCode: z.number().int().min(0).max(255),
        })
        .parse(value.State);
      return { digest: dockerContinuationDigest(value.State), exitCode: state.ExitCode };
    };
    const first = terminal(await this.#fixed(task.containerId, config));
    current();
    const latest = await this.#refresh(seen, current);
    const second = terminal(await this.#fixed(task.containerId, config));
    current();
    if (!isDeepStrictEqual(first, second)) refuse('DOCKER_RESOURCE_REVISION_WRITER_CHANGED');
    this.#fresh(latest);
    return {
      seen: latest,
      closure: DockerResourceClosedWriter.parse({
        version: 1,
        purpose: 'reverie-memory-writer-closed-v1',
        authority: 'canonical-issued-high-only-image-v1',
        containerId: task.containerId,
        imageId: task.imageId,
        configurationDigest: task.configurationDigest,
        terminalStateDigest: second.digest,
        exitCode: second.exitCode,
        identity: this.#identity(latest),
        originalOutcome: 'unknown',
      }),
    };
  }

  async #unstartedWriter(
    row: DockerEmployeeContinuationRecord,
    desired: DockerResourceDesiredRevision,
    task: DockerContinuationTask,
    seen: Observation,
    current: () => void
  ): Promise<Observation> {
    if (task.role !== 'leaf-helper' || !['create-issued', 'created'].includes(task.phase)) refuse();
    if (
      task.name !==
      'reverie-boxed-leaf-helper-' +
        dockerContinuationDigest([this.configuration.boxId, 'leaf-helper', row.request.operationId, desired.revision])
    )
      refuse();
    const snapshot = async () => {
      current();
      const raw = (
        await this.command.run([
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          'label=reverie.box.resource.name=' + task.name,
          '--format',
          '{{.ID}}',
        ])
      ).trim();
      current();
      const ids = raw ? raw.split('\n') : [];
      if (ids.length > 1) refuse('DOCKER_RESOURCE_REVISION_WRITER_CHANGED');
      if (!ids.length) return; // Observation only. The canonical CAS, not absence, fences future app dispatch.
      const id = cid.parse(ids[0]);
      if ('containerId' in task && task.containerId !== id) refuse();
      const inspected = await this.#inspect(id);
      current();
      const config = this.#writerConfiguration(row, desired, task, seen, inspected);
      const fixed = await this.#fixed(id, config);
      current();
      z.object({
        Status: z.literal('created'),
        Running: z.literal(false),
        Pid: z.literal(0),
        Paused: z.literal(false),
        Restarting: z.literal(false),
        Dead: z.literal(false),
      }).parse(fixed.State);
    };
    await snapshot();
    seen = await this.#refresh(seen, current);
    await snapshot();
    this.#fresh(seen);
    current();
    return seen;
  }
  async continueMemoryHigh(row: DockerEmployeeContinuationRecord, revision: string, current: () => void) {
    current();
    const attempt = this.revisions?.attempt(row, revision);
    if (attempt?.state !== 'helper' || !['create-issued', 'created'].includes(attempt.task.phase))
      refuse('DOCKER_RESOURCE_REVISION_CONTINUATION_NOT_ALLOWED');
    return this.reviseMemoryHigh(row, revision, current);
  }
  async abandonMemoryHigh(row: DockerEmployeeContinuationRecord, revision: string, current: () => void) {
    this.#beginRead(row);
    const desired = this.#desired(row, revision),
      attempt = this.revisions?.attempt(row, revision);
    if (!this.revisions || attempt?.state !== 'helper' || !['create-issued', 'created'].includes(attempt.task.phase))
      refuse('DOCKER_RESOURCE_REVISION_RETIREMENT_NOT_ALLOWED');
    const stable = () => {
      current();
      if (!isDeepStrictEqual(this.#desired(row, revision), desired)) refuse();
    };
    let seen = await this.#live(row, stable);
    if (!seen) refuse();
    seen = await this.#unstartedWriter(row, desired, attempt.task, seen, stable);
    await this.revisions.publish(
      row,
      desired,
      attempt,
      {
        ...dockerResourceAttemptKey(row, revision),
        state: 'unstarted-retired',
        task: attempt.task,
        retirement: {
          version: 1,
          purpose: 'reverie-memory-unstarted-intent-retired-v1',
          authority: 'canonical-prestart-cas-v1',
          taskDigest: dockerContinuationDigest(attempt.task),
          originalOutcome: 'unknown',
        },
      },
      stable
    );
    stable();
    return {
      state: 'unstarted-retired' as const,
      intentRetired: true as const,
      originalOutcome: 'unknown' as const,
      enforcement: 'not-observed' as const,
      allowedActions: ['reconcile', 'new-revision'],
    };
  }
  async #reconcileRetired(
    row: DockerEmployeeContinuationRecord,
    desired: DockerResourceDesiredRevision,
    original: Extract<DockerResourceAttempt, { state: 'unstarted-retired' | 'observed-after-retirement' }>,
    current: () => void
  ) {
    const stable = () => {
      current();
      if (!isDeepStrictEqual(this.#desired(row, desired.revision), desired)) refuse();
    };
    let seen = await this.#live(row, stable);
    if (!seen || !this.revisions) refuse();
    seen = await this.#closedHistory(row, seen, stable);
    const policy = dockerRevisedPolicy(row.policy, desired);
    let attempt = this.revisions.attempt(row, desired.revision);
    if (!isDeepStrictEqual(attempt, original)) refuse();
    if (attempt?.state === 'unstarted-retired' && this.#matches(seen, policy, policy.memoryHighBytes)) {
      await this.revisions.publish(
        row,
        desired,
        attempt,
        {
          ...dockerResourceAttemptKey(row, desired.revision),
          state: 'observed-after-retirement',
          task: attempt.task,
          retirement: attempt.retirement,
          identity: this.#identity(seen),
          observationDigest: dockerContinuationDigest(seen),
        },
        stable
      );
      stable();
      attempt = this.revisions.attempt(row, desired.revision);
    }
    this.#fresh(seen);
    stable();
    const actual = seen.resources.memoryHigh === 'max' ? null : Number(seen.resources.memoryHigh);
    if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) refuse();
    const common = {
      intentRetired: true as const,
      originalOutcome: 'unknown' as const,
      actualMemoryHighBytes: actual,
      desiredMemoryHighBytes: desired.memoryHighBytes,
    };
    if (attempt?.state === 'observed-after-retirement') {
      if (!this.#matches(seen, policy, policy.memoryHighBytes)) refuse();
      return {
        ...common,
        state: 'observed' as const,
        policy,
        enforcement: 'fresh-native-readback' as const,
        allowedActions: [],
      };
    }
    return {
      ...common,
      state: 'unstarted-retired' as const,
      enforcement: 'not-observed' as const,
      allowedActions: ['reconcile', 'new-revision'],
    };
  }
  async #closedHistory(
    row: DockerEmployeeContinuationRecord,
    seen: Observation,
    current: () => void,
    exceptRevision?: string
  ): Promise<Observation> {
    for (const { desired, attempt } of this.revisions?.history(row) ?? []) {
      if (attempt.revision === exceptRevision) continue;
      if (attempt.state === 'helper') refuse('DOCKER_RESOURCE_REVISION_ORIGINAL_ATTEMPT_PENDING');
      if (!('task' in attempt)) continue;
      if (attempt.state === 'original-closed') {
        const proof = await this.originalWriterReader().capture(
          dockerOriginalAttemptKey(attempt),
          attempt.task,
          current
        );
        requireDockerOriginalResourceWriterProof(proof, dockerOriginalAttemptKey(attempt), attempt.task);
        continue;
      }
      if (attempt.state === 'original-retired') {
        const proof = await this.originalWriterReader().inspectUnstarted(
          dockerOriginalAttemptKey(attempt),
          attempt.task,
          current
        );
        requireDockerOriginalResourcePrestartProof(proof, dockerOriginalAttemptKey(attempt), attempt.task);
        continue;
      }
      if ('retirement' in attempt) {
        if (attempt.retirement.taskDigest !== dockerContinuationDigest(attempt.task)) refuse();
        seen = await this.#unstartedWriter(row, desired, attempt.task, seen, current);
        continue;
      }
      const closed = await this.#closedWriter(row, desired, attempt.task, seen, current);
      seen = closed.seen;
      if ('closure' in attempt && !isDeepStrictEqual(closed.closure, attempt.closure)) refuse();
    }
    return seen;
  }
  /** Only metadata is published. A past unconfirmed START is never called again or marked acknowledged. */
  async reconcileMemoryHigh(row: DockerEmployeeContinuationRecord, revision: string, current: () => void) {
    this.#beginRead(row);
    if (!this.revisions || !['provider-issued', 'ready'].includes(row.phase)) refuse();
    const desired = this.#desired(row, revision),
      policy = dockerRevisedPolicy(row.policy, desired);
    const stable = () => {
      current();
      if (!isDeepStrictEqual(this.#desired(row, revision), desired)) refuse();
    };
    stable();
    let attempt = this.revisions.attempt(row, revision);
    if (!attempt || !('task' in attempt)) refuse('DOCKER_RESOURCE_REVISION_WRITER_UNCONFIRMED');
    if (attempt.state === 'original-closed' || attempt.state === 'original-retired')
      refuse('DOCKER_RESOURCE_REVISION_NEW_REVISION_REQUIRED');
    if ('retirement' in attempt) return this.#reconcileRetired(row, desired, attempt, stable);
    let seen = await this.#live(row, stable);
    if (!seen) refuse();
    const closed = await this.#closedWriter(row, desired, attempt.task, seen, stable);
    seen = closed.seen;
    if (attempt.state === 'helper') {
      const next: DockerResourceAttempt = {
        ...dockerResourceAttemptKey(row, revision),
        state: 'closed-writer',
        task: attempt.task,
        closure: closed.closure,
      };
      await this.revisions.publish(row, desired, attempt, next, stable);
      stable();
      attempt = this.revisions.attempt(row, revision)!;
    } else if ('closure' in attempt) {
      if (!isDeepStrictEqual(closed.closure, attempt.closure)) refuse();
    } else refuse('DOCKER_RESOURCE_REVISION_ALREADY_ACKNOWLEDGED');
    seen = await this.#closedHistory(row, seen, stable);
    const actual = seen.resources.memoryHigh === 'max' ? null : Number(seen.resources.memoryHigh);
    if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) refuse();
    if (attempt.state === 'closed-writer' && this.#matches(seen, policy, policy.memoryHighBytes)) {
      await this.revisions.publish(
        row,
        desired,
        attempt,
        {
          ...dockerResourceAttemptKey(row, revision),
          state: 'observed-after-closure',
          task: attempt.task,
          closure: attempt.closure,
          identity: this.#identity(seen),
          observationDigest: dockerContinuationDigest(seen),
        },
        stable
      );
      stable();
      attempt = this.revisions.attempt(row, revision)!;
    }
    this.#fresh(seen);
    stable();
    const common = {
      writerClosed: true as const,
      originalOutcome: 'unknown' as const,
      actualMemoryHighBytes: actual,
      desiredMemoryHighBytes: desired.memoryHighBytes,
    };
    if (attempt.state === 'observed-after-closure') {
      if (!this.#matches(seen, policy, policy.memoryHighBytes)) refuse();
      return {
        ...common,
        state: 'observed' as const,
        policy,
        enforcement: 'fresh-native-readback' as const,
        allowedActions: [],
      };
    }
    return {
      ...common,
      state: 'closed-writer' as const,
      enforcement: 'not-observed' as const,
      allowedActions: ['reconcile', 'new-revision'],
    };
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
        attempt.state === 'closed-writer' ||
        attempt.state === 'unstarted-retired' ||
        attempt.state === 'original-closed' ||
        attempt.state === 'original-retired' ||
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
    this.#proofs.set(candidate.policy, proof);
  }
  existingPolicy(
    row: DockerEmployeeContinuationRecord,
    actual: DockerEmployeeResourcePolicy
  ): DockerEffectiveResourceProof {
    const proof = this.#proofs.get(actual);
    requireDockerEffectiveResourceProof(proof, row, actual);
    return proof!;
  }
  /** For attaching to an existing pane only. Re-earn the current kernel
   * limits without replacing any historical anchor or writer receipt. */
  async readExistingAfterHostRestart(
    row: DockerEmployeeContinuationRecord,
    approvedPolicy: DockerEmployeeResourcePolicy,
    current: () => void
  ): Promise<DockerEmployeeResourcePolicy> {
    current();
    const policy = DockerEmployeeResourcePolicy.parse(approvedPolicy),
      original = dockerContinuationDigest(row),
      pool = row.pool,
      task = this.journal.read(row, 'anchor'),
      name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32),
      config = this.#configuration('anchor', name, ['anchor']);
    if (
      !row.destination ||
      !['provider-issued', 'ready'].includes(row.phase) ||
      !isDeepStrictEqual({ ...policy, memoryHighBytes: row.policy.memoryHighBytes }, row.policy) ||
      !pool ||
      pool.cgroupParent !== this.#slice ||
      pool.policyDigest !== dockerContinuationDigest(policy.pool) ||
      !task ||
      task.phase !== 'running' ||
      task.containerId !== pool.containerId ||
      task.name !== name ||
      task.imageId !== this.configuration.helperImageId ||
      task.configurationDigest !== dockerContinuationDigest(config)
    )
      refuse('DOCKER_RESOURCE_REATTACH_SCOPE_CHANGED');
    const anchorTask = dockerContinuationDigest(task);
    const check = () => {
      current();
      if (
        dockerContinuationDigest(row) !== original ||
        !isDeepStrictEqual(policy, approvedPolicy) ||
        dockerContinuationDigest(this.journal.read(row, 'anchor') ?? null) !== anchorTask ||
        !isDeepStrictEqual(config, this.#configuration('anchor', name, ['anchor']))
      )
        refuse('DOCKER_RESOURCE_REATTACH_SCOPE_CHANGED');
    };
    check();
    const anchorState = await this.#fixed(task.containerId, config),
      anchor = await this.#init(task.containerId);
    check();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    // Running providers can exit short-lived threads during a census. Repeat
    // only confirmed read races within the existing per-probe deadline.
    const attempts = 8;
    const parent = await this.#probe(anchor, undefined, attempts);
    check();
    const worker = await this.#worker(row);
    check();
    const observedAnchor = { ...anchor, startTicks: parent.anchor.startTicks },
      leaf = await this.#probe(observedAnchor, worker, attempts);
    check();
    // Bookend the same placement with overlapping read-only pool and leaf
    // observations so waiting for one probe need not expire the other.
    for (let read = 0; ; read++) {
      const [after, finalLeaf] = await Promise.all([
        this.#probe(observedAnchor, undefined, attempts),
        this.#refresh(leaf, check, attempts),
      ]);
      const finalAnchorState = await this.#fixed(task.containerId, config);
      check();
      if (
        !isDeepStrictEqual(anchorState.State, finalAnchorState.State) ||
        !isDeepStrictEqual(parent, after) ||
        !isDeepStrictEqual(after.parent, finalLeaf.parent) ||
        !isDeepStrictEqual(after.anchor, finalLeaf.anchor) ||
        !this.#matches(after, policy.pool, null) ||
        !this.#matches(finalLeaf, policy, policy.memoryHighBytes)
      )
        refuse('DOCKER_RESOURCE_REATTACH_POLICY_UNCONFIRMED');
      try {
        this.#fresh(after);
        this.#fresh(finalLeaf);
        return policy;
      } catch (error) {
        if (read > 0 || !(error instanceof DockerEmployeeContinuationError) ||
            error.code !== 'DOCKER_RESOURCE_REVISION_OBSERVATION_EXPIRED') throw error;
        check();
      }
    }
  }
  async read(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeResourcePolicy | null> {
    try {
      this.#readEpoch(row);
      let seen = await this.#live(row);
      if (!seen) {
        this.#beginRead(row);
        return null;
      }
      if (this.#matches(seen, row.policy, row.policy.memoryHighBytes)) {
        this.#recordRead(row, seen, row.policy);
        return structuredClone(row.policy);
      }
      const candidate = this.#approved(row, seen);
      if (!candidate) {
        this.#beginRead(row);
        return null;
      }
      seen = await this.#closedHistory(row, seen, () => {});
      if (
        candidate.attempt.state === 'applied' &&
        !(await this.#ack(
          candidate.attempt.task,
          seen,
          candidate.policy,
          candidate.policy.memoryHighBytes,
          true,
          candidate.attempt.task.imageId
        ))
      )
        refuse('DOCKER_RESOURCE_REVISION_HELPER_UNACKNOWLEDGED');
      seen = await this.#refresh(seen);
      if (!isDeepStrictEqual(this.#approved(row, seen), candidate)) refuse();
      // Publication follows every required applied-helper ACK and fresh ledger/current-scope check.
      const epoch = this.#recordRead(row, seen, candidate.policy);
      this.#publishProof(row, candidate, seen, epoch);
      return candidate.policy;
    } catch (error) {
      this.#beginRead(row);
      throw error;
    }
  }

  /** Read-only profile refresh. Actual unadopted high is visible DATA, never a revision ACK. */
  async observeMemoryHigh(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<{
    actualMemoryHighBytes: number | null;
    memoryMaxBytes: number;
    actualLimits: Omit<DockerEmployeeResourcePolicy, 'pool'> & { cpuQuota: 'unlimited' };
    approved: boolean;
    approvalSource: 'original-policy' | 'owner-revision' | null;
    approvedRevision: string | null;
  }> {
    try {
      this.#readEpoch(row);
      let seen = await this.#live(row, current);
      current();
      if (!seen || !dockerOtherResourceLimitsMatch(seen.resources, row.policy))
        refuse('DOCKER_RESOURCE_REVISION_OTHER_LIMIT_CHANGED');
      const candidate = this.#approved(row, seen);
      if (candidate) seen = await this.#closedHistory(row, seen, current);
      if (
        candidate?.attempt.state === 'applied' &&
        !(await this.#ack(
          candidate.attempt.task,
          seen,
          candidate.policy,
          candidate.policy.memoryHighBytes,
          true,
          candidate.attempt.task.imageId
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
      if (original) this.#recordRead(row, seen, row.policy);
      else if (approvedRevision && finalCandidate) this.#recordRead(row, seen, finalCandidate.policy);
      else this.#beginRead(row);
      return {
        actualMemoryHighBytes: actual,
        memoryMaxBytes: row.policy.memoryMaxBytes,
        // Every non-high value just matched the fresh native leaf observation.
        // The immutable launch policy alone never supplies a readback.
        actualLimits: {
          memoryHighBytes: actual,
          memoryMaxBytes: row.policy.memoryMaxBytes,
          swapMaxBytes: row.policy.swapMaxBytes,
          pidsMax: row.policy.pidsMax,
          cpuWeight: row.policy.cpuWeight,
          allowedCpus: [...row.policy.allowedCpus],
          cpuQuota: 'unlimited',
        },
        approved: original || approvedRevision !== null,
        approvalSource: original ? 'original-policy' : approvedRevision ? 'owner-revision' : null,
        approvedRevision,
      };
    } catch (error) {
      this.#beginRead(row);
      throw error;
    }
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
    let seen = await this.#live(row, requireCurrent);
    requireCurrent();
    if (!seen?.worker || !dockerOtherResourceLimitsMatch(seen.resources, row.policy))
      refuse('DOCKER_RESOURCE_REVISION_OTHER_LIMIT_CHANGED');
    seen = await this.#closedHistory(row, seen, requireCurrent, revision);
    if (!seen.worker) refuse();
    let attempt = this.revisions.attempt(row, revision);
    if (
      attempt?.state === 'closed-writer' ||
      attempt?.state === 'unstarted-retired' ||
      attempt?.state === 'original-closed' ||
      attempt?.state === 'original-retired'
    )
      refuse('DOCKER_RESOURCE_REVISION_NEW_REVISION_REQUIRED');
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
    if (
      !actual ||
      !isDeepStrictEqual(actual, policy) ||
      !final ||
      final.state === 'helper' ||
      final.state === 'closed-writer' ||
      final.state === 'unstarted-retired' ||
      final.state === 'original-closed' ||
      final.state === 'original-retired'
    )
      refuse('DOCKER_RESOURCE_REVISION_READBACK');
    return {
      state:
        final.state === 'observed-after-closure' || final.state === 'observed-after-retirement'
          ? ('observed' as const)
          : final.state,
      policy: actual,
    };
  }
  /** Read-only native settlement of original helper cursors before a new
   * actor epoch. No CREATE/START/write command is reachable here. */
  async settleObservedHelpers(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    current();
    let anchor = await this.#anchor(row);
    current();
    const task = this.journal.read(row, 'anchor');
    if (task && ['start-issued', 'created'].includes(task.phase) && anchor && 'containerId' in task) {
      await this.journal.publish(
        row,
        task,
        {
          role: task.role,
          name: task.name,
          imageId: task.imageId,
          configurationDigest: task.configurationDigest,
          phase: 'running',
          containerId: task.containerId,
          initPid: anchor.pid,
          initStartTicks: anchor.startTicks,
        },
        current
      );
      current();
    }
    for (const role of ['pool-helper', 'leaf-helper'] as const) {
      const original = this.journal.read(row, role);
      if (!original || !['start-issued', 'running'].includes(original.phase)) continue;
      anchor = await this.#anchor(row);
      current();
      if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
      const worker = role === 'leaf-helper' ? await this.#worker(row) : undefined;
      current();
      const seen = await this.#probe(anchor, worker);
      current();
      if (role === 'pool-helper') await this.#poolWritersClosed(original);
      current();
      const high = role === 'leaf-helper' ? row.policy.memoryHighBytes : null,
        policy = role === 'leaf-helper' ? row.policy : row.policy.pool;
      if (!('containerId' in original) || !(await this.#ack(original, seen, policy, high, role === 'leaf-helper')))
        refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
      current();
      const ack = observation.parse(JSON.parse(await this.command.run(['container', 'logs', original.containerId])));
      current();
      if (
        ack.boxId !== seen.boxId ||
        !isDeepStrictEqual(ack.parent, seen.parent) ||
        !isDeepStrictEqual(ack.anchor, seen.anchor) ||
        !isDeepStrictEqual(ack.worker, role === 'leaf-helper' ? seen.worker : null) ||
        !this.#matches(ack, policy, high)
      )
        refuse('DOCKER_RESOURCE_HELPER_RESULT_CHANGED');
      if (!(await this.#ack(original, seen, policy, high, role === 'leaf-helper')))
        refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
      current();
      await this.journal.publish(
        row,
        original,
        {
          role: original.role,
          name: original.name,
          imageId: original.imageId,
          configurationDigest: original.configurationDigest,
          phase: 'completed',
          containerId: original.containerId,
          resultDigest: dockerContinuationDigest(ack),
        },
        current
      );
      current();
    }
  }
  async configure(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const admitted = current;
    current = () => { admitted(); this.configuration.requireColdPoolIdle?.(); };
    current();
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
    await this.#configureTask(
      row,
      'leaf-helper',
      this.#leafArguments(seen, row.policy, await this.#members(worker.id)),
      { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
      current
    );
    const actual = await this.read(row);
    current();
    if (!actual || !isDeepStrictEqual(actual, row.policy)) refuse('DOCKER_RESOURCE_WORKER_READBACK');
  }
}
