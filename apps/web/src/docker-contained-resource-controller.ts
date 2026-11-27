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
  DockerSingleAttemptTask,
  DockerTaskFailure,
  DOCKER_TASK_ATTEMPT_LIMIT,
  dockerFailedWriterHold,
  dockerTaskAttempt,
  dockerTaskIdentity,
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
  requireDockerLeafWriterHelperImage,
} from './docker-resource-helper-inspection.js';
import { DockerOriginalResourceWriterReader } from './docker-resource-original-writer.js';
import { parseDockerLeafWriterArguments } from './docker-resource-leaf-census.js';
import { formatKernelCpuList } from './docker-cpu-reservation-data.js';
import type {
  DockerResourceRepairAttempt,
  DockerResourceRepairJournal,
  DockerResourceRepairTarget,
} from './docker-resource-repair-journal.js';

const cid = z.string().regex(/^[a-f0-9]{64}$/);
/** Leaf writers one request may issue before it holds and asks to be repeated. */
export const DOCKER_LEAF_ATTEMPTS_PER_REQUEST = 3;
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
  /** Separately pinned image for NEW `configure-high` leaf writers only. It never
   * replaces the anchor, probe, storage or pool pin, and a writer that is already
   * journaled is read under the image it was issued with. */
  readonly leafWriterHelperImageId?: string;
  /** Canonical selected bindings AND retained destinations. These IDs are DATA;
   * Engine/current kernel observations must independently validate every one. */
  selectedWorkerContainerIds(): readonly string[] | Promise<readonly string[]>;
  /** Original issued pool helpers from the canonical operation journal, for
   * later employees sharing the same actually acknowledged pool. */
  retainedPoolConfigurationTasks?(): readonly DockerContinuationTask[];
  requireColdPoolIdle?(): void;
  /** Exact kernel cpu.max values of group CPU ceilings the owner approved.
   * DATA only: a POOL observation may show one of them beside "no quota".
   * A worker leaf never has a quota, and nothing here issues a write. */
  approvedPoolCpuMax?(): readonly string[];
  /** Durable cursors for re-applying approved limits in place. Without one,
   * nothing is ever written to a pool that has members or to a published leaf. */
  readonly repairs?: DockerResourceRepairJournal;
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
/** What the container engine itself said when it refused a command: the lines its client printed after the
 * command line, as one clipped line of printable text. It names a container of this office and nothing private. */
function engineWords(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const said = message
    .split('\n')
    .slice(1)
    .join(' ')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return said ? said.slice(0, 300) : 'the container engine gave no reason';
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
const canonicalCpus = formatKernelCpuList;
/** Pure DATA comparison only. A boolean never supplies a native resource or owner proof. */
export function dockerOtherResourceLimitsMatch(
  r: Observation['resources'],
  policy: DockerEmployeeResourcePolicy['pool'],
  approvedCpuMax: readonly string[] = []
): boolean {
  return (
    r.memoryMax === String(policy.memoryMaxBytes) &&
    r.swapMax === String(policy.swapMaxBytes) &&
    r.pidsMax === String(policy.pidsMax) &&
    r.cpuWeight === String(policy.cpuWeight) &&
    (/^max [1-9][0-9]*$/.test(r.cpuMax) || approvedCpuMax.includes(r.cpuMax)) &&
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
/** What a refusal to write a laptop's memory limits below what it holds carries (`DOCKER_RESOURCE_REPAIR_MEMORY_IN_USE`). */
export interface DockerHeldMemory {
  readonly heldBytes: number;
  readonly memoryHighBytes: number | null;
  readonly memoryMaxBytes: number;
}
/** The lines of a cgroup's `memory.stat` that reclaim cannot give back without swap. */
const HELD_MEMORY_FIELDS = [
  'anon',
  'shmem',
  'kernel_stack',
  'pagetables',
  'sec_pagetables',
  'percpu',
  'sock',
  'vmalloc',
  'slab_unreclaimable',
];
/**
 * The memory a cgroup holds that reclaim cannot give back, from its `memory.stat`: the sum of `HELD_MEMORY_FIELDS`
 * that the kernel reports. Undefined for text that is not such a file, or that lacks `anon`.
 */
export function heldMemoryBytes(stat: string): number | undefined {
  if (stat.length > 16384) return undefined;
  const values = new Map<string, number>();
  for (const line of stat.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([a-z_]{1,64}) (0|[1-9][0-9]{0,19})$/.exec(line.trim());
    if (!match) return undefined;
    values.set(match[1]!, Number(match[2]));
  }
  if (!values.has('anon')) return undefined;
  let total = 0;
  for (const field of HELD_MEMORY_FIELDS) total += values.get(field) ?? 0;
  return Number.isSafeInteger(total) ? total : undefined;
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
  #poolWrites: Promise<unknown> = Promise.resolve();
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
      (configuration.leafWriterHelperImageId !== undefined &&
        !/^sha256:[a-f0-9]{64}$/.test(configuration.leafWriterHelperImageId)) ||
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
      let raw: Record<string, unknown>;
      try {
        raw = await this.#inspect(id, command);
      } catch (error) {
        // A laptop on record that cannot be inspected is unknown, and stops this read, unless the Engine
        // positively reports that no container of exactly this ID exists. Such a laptop was removed while it was
        // stopped, as its rebuild will record. It runs nothing, exactly like one that is stopped, and it is kept
        // in the bindings so that the set of laptops read is still compared whole.
        if (await this.#listedById(id, command)) throw error;
        bindings?.push({ Id: id, absent: true });
        continue;
      }
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
  /** Whether the Engine lists a container of exactly this ID, in any state. Unscoped, so that a changed label
   * cannot hide one that is still there. */
  async #listedById(id: string, command: DockerEngineCommand = this.command): Promise<boolean> {
    const listed = (
      await command.run(['container', 'ls', '--all', '--no-trunc', '--filter', 'id=' + id, '--format', '{{.ID}}'])
    ).trim();
    if (listed !== '' && listed !== id) refuse('DOCKER_RESOURCE_MEMBERS_UNKNOWN');
    return listed === id;
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
    journal: DockerContinuationTaskJournal = this.journal,
    attempt = 1
  ): Promise<DockerContinuationTask> {
    let task = journal.read(row, role);
    const base = {
      role,
      name,
      imageId: String(config.Image),
      configurationDigest: dockerContinuationDigest(config),
      ...(attempt > 1 ? { attempt } : {}),
    };
    // A terminal failure is followed only by the intent of the attempt after it.
    const fresh = task === undefined || (task.phase === 'failed' && attempt === dockerTaskAttempt(task) + 1);
    if (!task || fresh) {
      current();
      await journal.publish(row, task, { ...base, phase: 'create-issued' }, current);
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
  async #probe(anchor: Init, worker?: Init, attempts = 8): Promise<Observation> {
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
        // The exact-ID census that tells a removed laptop from an unreadable one. A read.
        const census =
          args.length === 8 &&
          args.slice(0, 5).join(' ') === 'container ls --all --no-trunc --filter' &&
          /^id=[a-f0-9]{64}$/.test(args[5] ?? '') &&
          args.slice(6).join(' ') === '--format {{.ID}}';
        if (input !== undefined || (!inspect && !init && !probe && !census))
          refuse('DOCKER_RESOURCE_PROBE_READ_REQUIRED');
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
  /** Well-formed owner-approved pool ceilings; anything else approves nothing. */
  #approvedPoolCpuMax(): readonly string[] {
    return (this.configuration.approvedPoolCpuMax?.() ?? [])
      .slice(0, 16)
      .filter((value) => /^[1-9][0-9]{0,15} [1-9][0-9]{0,8}$/.test(value));
  }
  #matches(seen: Observation, policy: DockerEmployeeResourcePolicy['pool'], high: number | null): boolean {
    return (
      // Only the pool parent may carry the approved group ceiling.
      dockerOtherResourceLimitsMatch(seen.resources, policy, seen.worker === null ? this.#approvedPoolCpuMax() : []) &&
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
    // A leaf writer is read under the image it was issued with, when that is
    // the baseline pin or the separately pinned leaf writer image.
    const leaf = worker && !revisionImage && this.#leafWriterImages().includes(task.imageId);
    if (
      !('containerId' in task) ||
      !['start-issued', 'running', 'completed'].includes(task.phase) ||
      task.role !== (worker ? 'leaf-helper' : 'pool-helper') ||
      (!leaf &&
        task.imageId !==
          (revisionImage ?? (restore ? this.configuration.poolRestoreHelperImageId : this.configuration.helperImageId)))
    )
      return false;
    const raw = await this.#inspect(task.containerId);
    const args = z.object({ Cmd: z.array(z.string()).min(1).max(512) }).parse(raw.Config).Cmd;
    // A leaf's approved limits are written by `configure-high` when the laptop
    // is set up and re-applied in place by `restore-high`.
    const commands = revisionImage
      ? ['configure-memory-high']
      : worker
        ? ['configure-high', 'restore-high']
        : [restore ? 'restore-pool' : 'configure-pool'];
    if (!commands.includes(args[0]!)) return false;
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
      revisionImage ?? (restore || leaf ? task.imageId : undefined)
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
    // Recorded finished: with an acknowledgement, or as a proven terminal failure.
    const ended = task.phase === 'completed' || task.phase === 'failed';
    if (task.role !== 'pool-helper' || !('containerId' in task)) return 'unconfirmed';
    // A finished writer the Engine positively reports absent can no longer
    // write, whichever helper image generation created it. Checked first so a
    // later manifest's helper image selection cannot hold a removed writer.
    if (!ended && !restore && task.imageId !== this.configuration.helperImageId) return 'unconfirmed';
    if (ended) {
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
    // A writer that is recorded finished is proved closed under the image its
    // own journaled configuration names, so that a later selection of another
    // helper image cannot turn an exited writer into an unknown one. Such a
    // writer still acknowledges nothing: only #ack reads an acknowledgement,
    // and only under the images this office is configured with.
    const raw = await this.#inspect(task.containerId);
    const args = z.array(z.string()).min(1).max(512).parse(z.record(z.string(), z.unknown()).parse(raw.Config).Cmd);
    const commands = ended ? ['restore-pool', 'configure-pool'] : [restore ? 'restore-pool' : 'configure-pool'];
    if (!commands.includes(args[0]!)) return 'unconfirmed';
    if (restore) await requireDockerPoolRestoreHelperImage(this.command, task.imageId, () => {});
    const expected = this.#configuration(
      'pool-helper',
      task.name,
      args,
      {
        path: this.#parent,
        target: '/run/reverie-box-pool',
      },
      task.imageId
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
  /** Every pool writer cursor on record: laptop operations, published
   * observations and the office's own repairs. DATA for native proof only. */
  #retainedPoolTasks(): DockerContinuationTask[] {
    const tasks = [
      ...(this.configuration.retainedPoolConfigurationTasks?.() ?? []),
      ...(this.configuration.repairs?.poolTasks() ?? []),
    ];
    return [...new Map(tasks.map((task) => [dockerContinuationDigest(task), task])).values()];
  }
  async #poolWritersClosed(except?: DockerContinuationTask): Promise<DockerContinuationTask[]> {
    const prior = this.#retainedPoolTasks();
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
  /** Whether a closed earlier writer still acknowledges this exact observation. */
  async #poolAcknowledged(fresh: Observation, policy: DockerEmployeeResourcePolicy['pool']): Promise<boolean> {
    for (const task of await this.#poolWritersClosed()) if (await this.#ack(task, fresh, policy, null, false)) return true;
    return false;
  }
  /** Whether a surviving acknowledgement covers this exact observation. An
   * own writer that may have written, or that finished and is still present,
   * must supply it itself. One that never started, is proved terminal and
   * failed, or is positively absent acknowledges nothing and is no unknown
   * write, so another closed writer's acknowledgement may be adopted. */
  async #poolAcknowledgedFor(row: DockerEmployeeContinuationRecord, fresh: Observation): Promise<boolean> {
    const own = this.journal.read(row, 'pool-helper');
    // A delayed earlier configure must not race this fresh probe. Its persisted
    // START fence remains unknown until the ORIGINAL fixed container is terminal.
    const prior = await this.#poolWritersClosed();
    if (own && ['start-issued', 'running'].includes(own.phase)) {
      if (await this.#ack(own, fresh, row.policy.pool, null, false)) return true;
      if (!(await this.#failedPoolWriter(own, () => {}))) return false;
    } else if (own?.phase === 'completed' && (await this.#poolWriterState(own)) !== 'removed')
      return this.#ack(own, fresh, row.policy.pool, null, false);
    for (const task of prior) if (await this.#ack(task, fresh, row.policy.pool, null, false)) return true;
    return false;
  }
  async #poolAck(row: DockerEmployeeContinuationRecord, fresh: Observation): Promise<void> {
    if (!(await this.#poolAcknowledgedFor(row, fresh))) refuse('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
  }
  async validate(_original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void> {
    if (policy.memoryHighBytes === null || !Number.isSafeInteger(policy.memoryMaxBytes + policy.swapMaxBytes))
      refuse('DOCKER_RESOURCE_FINITE_HIGH_REQUIRED');
    const rows = z
      .array(z.object({ Id: z.string() }))
      .length(1)
      .parse(JSON.parse(await this.command.run(['image', 'inspect', this.configuration.helperImageId])));
    if (rows[0]!.Id !== this.configuration.helperImageId) refuse('DOCKER_RESOURCE_HELPER_IMAGE_CHANGED');
    // A selected leaf writer image that the Engine cannot supply is refused
    // here, before anything of the operation is issued.
    await this.#leafWriterImage(() => {});
  }
  /** Images a `configure-high` leaf writer of this box may have been issued with. */
  #leafWriterImages(): string[] {
    const selected = this.configuration.leafWriterHelperImageId;
    return selected && selected !== this.configuration.helperImageId
      ? [this.configuration.helperImageId, selected]
      : [this.configuration.helperImageId];
  }
  /** The image a NEW leaf writer is issued with. No fallback to the baseline pin. */
  async #leafWriterImage(current: () => void): Promise<string> {
    const selected = this.configuration.leafWriterHelperImageId;
    if (!selected || selected === this.configuration.helperImageId) return this.configuration.helperImageId;
    await requireDockerLeafWriterHelperImage(this.command, selected, current);
    return selected;
  }
  /** The fixed name of one writer of this box and operation. The first attempt
   * keeps the name every earlier office gave it; each later one has its own. */
  #taskName(
    row: DockerEmployeeContinuationRecord,
    role: 'pool-helper' | 'leaf-helper',
    revision?: string,
    attempt = 1
  ): string {
    return `reverie-boxed-${role}-${dockerContinuationDigest([this.configuration.boxId, role, row.request.operationId, ...(revision ? [revision] : []), ...(attempt > 1 ? [{ attempt }] : [])])}`;
  }
  async #configureTask(
    row: DockerEmployeeContinuationRecord,
    role: 'pool-helper' | 'leaf-helper',
    args: string[],
    writable: { path: string; target: string },
    current: () => void,
    revision?: { id: string; journal: DockerContinuationTaskJournal; imageId: string },
    leaf?: { attempt: number; imageId: string; name?: string }
  ): Promise<void> {
    const journal = revision?.journal ?? this.journal,
      attempt = leaf?.attempt ?? 1;
    const name = leaf?.name ?? this.#taskName(row, role, revision?.id, attempt);
    const config = this.#configuration(role, name, args, writable, revision?.imageId ?? leaf?.imageId);
    await this.#runWriter(row, role, name, config, current, journal, attempt);
  }
  /** Creates (or finds), starts and waits for one fixed writer under its own
   * journal cursor, and records its acknowledgement. A task that is already
   * issued is continued as itself: its CREATE and START are never repeated. */
  async #runWriter(
    row: DockerEmployeeContinuationRecord,
    role: 'pool-helper' | 'leaf-helper',
    name: string,
    config: Config,
    current: () => void,
    journal: DockerContinuationTaskJournal,
    attempt: number
  ): Promise<void> {
    let task = await this.#created(row, role, name, config, current, journal, attempt);
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
    const output: unknown = JSON.parse(await this.command.run(['container', 'logs', task.containerId]));
    // The restore helper prints the pool observation together with the members it bound.
    const seen =
      (config.Cmd as readonly string[])[0] === 'restore-pool'
        ? DockerPoolRestoreAcknowledgement.parse(output)
        : observation.parse(output);
    current();
    if (('observation' in seen ? seen.observation : seen).boxId !== this.configuration.boxId)
      refuse('DOCKER_RESOURCE_HELPER_RESULT_CHANGED');
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
  /** Proves that the journaled leaf writer of this operation is terminal and
   * failed: the exact fixed container, exited with a nonzero status, not
   * running, PID 0, not paused, restarting or dead, and unchanged across two
   * inspections around a fresh read of the same leaf. Undefined when the
   * container does not show exactly that. Reads only. */
  async #failedLeafWriter(
    task: DockerContinuationTask,
    seen: Observation,
    current: () => void
  ): Promise<{ seen: Observation; exitCode: number; scopeArguments: string[]; failed: boolean } | undefined> {
    current();
    if (
      task.role !== 'leaf-helper' ||
      !('containerId' in task) ||
      !['start-issued', 'running', 'failed'].includes(task.phase) ||
      !seen.worker ||
      !this.#leafWriterImages().includes(task.imageId)
    )
      return undefined;
    const raw = await this.#inspect(task.containerId);
    current();
    const args = z.object({ Cmd: z.array(z.string().max(4096)).min(1).max(512) }).parse(raw.Config).Cmd;
    const parsed = parseDockerLeafWriterArguments(args, this.configuration.boxId);
    if (parsed.mode !== 'configure-high' || parsed.workerId !== seen.worker.id) return undefined;
    const config = this.#configuration(
      'leaf-helper',
      task.name,
      args,
      { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
      task.imageId
    );
    if (dockerContinuationDigest(config) !== task.configurationDigest) return undefined;
    const terminal = () => this.#failedTerminal(task.containerId, config, current);
    const first = await terminal();
    if (!first) return undefined;
    const latest = await this.#refresh(seen, current);
    const second = await terminal();
    if (!second || !isDeepStrictEqual(first, second)) return undefined;
    this.#fresh(latest);
    return { seen: latest, exitCode: second.exitCode, scopeArguments: parsed.scopeArguments, failed: second.failed };
  }
  /** Records that this operation's started leaf writer is terminal and failed,
   * with the class of what it printed. One journal publication and reads; no
   * CREATE, START or kernel write. A writer that is still running, exited with
   * success or cannot be proved is left exactly as it is. */
  async #settleFailedLeaf(
    row: DockerEmployeeContinuationRecord,
    seen: Observation,
    current: () => void
  ): Promise<Observation> {
    const task = this.journal.read(row, 'leaf-helper');
    if (!task || !('containerId' in task) || !['start-issued', 'running'].includes(task.phase)) return seen;
    const closed = await this.#failedLeafWriter(task, seen, current);
    if (!closed) return seen;
    await this.#recordFailedWriter(row, this.journal, task, closed, current);
    return closed.seen;
  }
  /** Every leaf writer container of this box that targets one worker, each
   * proved terminal under its own fixed configuration. A writer that is
   * created, running or unreadable refuses: no rerun beside a live writer. */
  async #workerLeafWriters(workerId: string, current: () => void): Promise<string[]> {
    const result: string[] = [];
    try {
      for (const id of await this.#poolCensus('leaf-helper')) {
        current();
        const raw = await this.#inspect(id);
        current();
        const args = z.object({ Cmd: z.array(z.string().max(4096)).min(1).max(512) }).parse(raw.Config).Cmd;
        if (parseDockerLeafWriterArguments(args, this.configuration.boxId).workerId !== workerId) continue;
        await this.#closedLeafWriters([id], current);
        result.push(dockerContinuationDigest({ id, state: raw.State }));
      }
    } catch (error) {
      if (error instanceof z.ZodError) refuse('DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED');
      throw error;
    }
    return result;
  }
  /** One inspection of a fixed writer container that shows it exited with a
   * nonzero status and can do nothing more. Undefined for any other state. */
  async #failedTerminal(id: string, config: Config, current: () => void) {
    const value = await this.#fixed(id, config);
    current();
    const state = z
      .object({
        Status: z.literal('exited'),
        Running: z.literal(false),
        Pid: z.literal(0),
        Paused: z.literal(false),
        Restarting: z.literal(false),
        Dead: z.literal(false),
        ExitCode: z.number().int().min(1).max(255),
        OOMKilled: z.boolean().optional(),
        Error: z.string().optional(),
      })
      .safeParse(value.State);
    return state.success
      ? {
          digest: dockerContinuationDigest(value.State),
          exitCode: state.data.ExitCode,
          // Only a helper that ran to its own exit printed a reason.
          failed: state.data.ExitCode === 1 && state.data.OOMKilled !== true && (state.data.Error ?? '') === '',
        }
      : undefined;
  }
  /** One inspection of a fixed writer container that shows it was created and
   * never started: it has run nothing and written nothing. Undefined for any
   * other state. */
  async #neverStarted(id: string, config: Config, current: () => void) {
    const value = await this.#fixed(id, config);
    current();
    const state = z
      .object({
        Status: z.literal('created'),
        Running: z.literal(false),
        Pid: z.literal(0),
        Paused: z.literal(false),
        Restarting: z.literal(false),
        Dead: z.literal(false),
      })
      .safeParse(value.State);
    return state.success ? { digest: dockerContinuationDigest(value.State) } : undefined;
  }
  /** One inspection of a fixed writer container that shows it ran and has
   * ended, with whatever status: it can write nothing more. Undefined for any
   * other state. It says nothing about what the writer acknowledged. */
  async #endedTerminal(id: string, config: Config, current: () => void) {
    const value = await this.#fixed(id, config);
    current();
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
      .safeParse(value.State);
    return state.success ? { digest: dockerContinuationDigest(value.State) } : undefined;
  }
  /** The fixed configuration a pool writer of this box was created with,
   * rebuilt from its own command under the image it is recorded with. */
  #poolWriterConfiguration(name: string, imageId: string, raw: Record<string, unknown>): Config | undefined {
    const args = z.object({ Cmd: z.array(z.string().max(4096)).min(1).max(512) }).safeParse(raw.Config);
    if (!args.success || !['configure-pool', 'restore-pool'].includes(args.data.Cmd[0]!)) return undefined;
    return this.#configuration(
      'pool-helper',
      name,
      args.data.Cmd,
      { path: this.#parent, target: '/run/reverie-box-pool' },
      imageId
    );
  }
  /** Proves that a started pool writer is terminal and failed: the exact
   * fixed container of its journaled configuration, exited with a nonzero
   * status, not running, PID 0, and unchanged across two inspections. Such a
   * writer acknowledged nothing and can write nothing more. Reads only. */
  async #failedPoolWriter(
    task: DockerContinuationTask,
    current: () => void
  ): Promise<{ exitCode: number; failed: boolean } | undefined> {
    current();
    if (
      task.role !== 'pool-helper' ||
      !('containerId' in task) ||
      !['start-issued', 'running', 'failed'].includes(task.phase)
    )
      return undefined;
    const raw = await this.#inspect(task.containerId);
    current();
    const config = this.#poolWriterConfiguration(task.name, task.imageId, raw);
    if (!config || dockerContinuationDigest(config) !== task.configurationDigest) return undefined;
    const first = await this.#failedTerminal(task.containerId, config, current);
    const second = first && (await this.#failedTerminal(task.containerId, config, current));
    return first && second && isDeepStrictEqual(first, second)
      ? { exitCode: second.exitCode, failed: second.failed }
      : undefined;
  }
  /** Records that a started writer is terminal and failed, with the class of
   * what it printed. One journal publication and reads; no CREATE, START or
   * kernel write. Anything that cannot be proved is left exactly as it is. */
  async #recordFailedWriter(
    row: DockerEmployeeContinuationRecord,
    journal: DockerContinuationTaskJournal,
    task: DockerContinuationTask,
    closed: { exitCode: number; failed: boolean },
    current: () => void
  ): Promise<void> {
    if (!('containerId' in task)) return;
    const read = closed.failed
      ? await (this.command.helperFailure?.(task.containerId) ?? Promise.resolve(undefined)).catch(() => undefined)
      : undefined;
    current();
    await journal.publish(
      row,
      task,
      {
        ...dockerTaskIdentity(task),
        phase: 'failed',
        containerId: task.containerId,
        exitCode: closed.exitCode,
        failure: DockerTaskFailure.catch('unknown').parse(read ?? 'unknown'),
      },
      current
    );
    current();
  }
  /** The pool writer of this operation, once it is proved terminal and failed. */
  async #settleFailedPool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const task = this.journal.read(row, 'pool-helper');
    if (!task || !['start-issued', 'running'].includes(task.phase)) return;
    const closed = await this.#failedPoolWriter(task, current);
    if (closed) await this.#recordFailedWriter(row, this.journal, task, closed, current);
  }
  /** Which leaf writer attempt may run now: the issued one, as itself, or the
   * one after a terminal failure. A rerun needs all of: a failure class that
   * was a lost read or a deadline; attempts left for this request and for the
   * operation; the same phase and policy with no later soft-memory revision;
   * the failed writer proved terminal twice around a fresh read of the same
   * leaf; and no other leaf writer of this worker left unterminated. Its
   * scope is collected fresh by the caller. Nothing is loosened to pass. */
  async #leafAttempt(
    row: DockerEmployeeContinuationRecord,
    seen: Observation,
    issued: number,
    current: () => void
  ): Promise<{ attempt: number; imageId: string; name?: string; seen: Observation; fresh: boolean }> {
    seen = await this.#settleFailedLeaf(row, seen, current);
    const task = this.journal.read(row, 'leaf-helper');
    if (!task) return { attempt: 1, imageId: await this.#leafWriterImage(current), seen, fresh: true };
    if (task.phase !== 'failed') {
      // An issued task is resumed as itself. Its name must still be this
      // box's and operation's own: that of its attempt, or, once it is
      // acknowledged and no longer carries an index, of any attempt.
      const attempts =
        task.phase === 'completed'
          ? Array.from({ length: DOCKER_TASK_ATTEMPT_LIMIT }, (_unused, index) => index + 1)
          : [dockerTaskAttempt(task)];
      if (
        !this.#leafWriterImages().includes(task.imageId) ||
        !attempts.some((attempt) => task.name === this.#taskName(row, 'leaf-helper', undefined, attempt))
      )
        refuse('DOCKER_RESOURCE_ORIGINAL_TASK_CHANGED');
      return { attempt: dockerTaskAttempt(task), imageId: task.imageId, name: task.name, seen, fresh: false };
    }
    const hold = dockerFailedWriterHold(task);
    if (hold !== 'DOCKER_RESOURCE_HELPER_RETRY_PENDING') refuse(hold);
    if (issued >= DOCKER_LEAF_ATTEMPTS_PER_REQUEST) refuse('DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED');
    if (row.phase !== 'resources-issued' || (this.revisions?.history(row).length ?? 0) > 0 || !seen.worker)
      refuse('DOCKER_RESOURCE_HELPER_RETRY_SCOPE_CHANGED');
    const before = await this.#workerLeafWriters(seen.worker.id, current);
    const closed = await this.#failedLeafWriter(task, seen, current);
    if (!closed || closed.exitCode !== task.exitCode) refuse('DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED');
    // The failed writer was issued for this same anchor, worker, leaf and policy.
    if (!isDeepStrictEqual(closed.scopeArguments, this.#leafArguments(closed.seen, row.policy, [])))
      refuse('DOCKER_RESOURCE_HELPER_RETRY_SCOPE_CHANGED');
    if (!isDeepStrictEqual(await this.#workerLeafWriters(seen.worker.id, current), before))
      refuse('DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED');
    const imageId = await this.#leafWriterImage(current);
    if (!isDeepStrictEqual(this.journal.read(row, 'leaf-helper'), task))
      refuse('DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED');
    return { attempt: dockerTaskAttempt(task) + 1, imageId, seen: closed.seen, fresh: true };
  }
  /** Read-only except for one journal publication: records a proven terminal
   * failure of this operation's started pool or leaf writer so that its phase
   * owner may issue the attempt after it. Never a CREATE, START or kernel write. */
  async settleFailedWriter(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    current();
    await this.#settleFailedPool(row, current);
    current();
    const task = this.journal.read(row, 'leaf-helper');
    if (!task || !['start-issued', 'running'].includes(task.phase)) return;
    const anchor = await this.#anchor(row);
    current();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const worker = await this.#worker(row);
    current();
    await this.#settleFailedLeaf(row, await this.#probe(anchor, worker), current);
    current();
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
  /** The one fixed, running anchor of this box, found by census. Read-only. */
  async #runningPoolAnchor(current: () => void) {
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
    return { anchors, id, name, configuration, init };
  }
  /** What the kernel enforces on the pool's CPU time right now, and how many
   * CPUs the pool may run on. A fresh native read; it approves nothing. */
  async observePoolCpu(current: () => void): Promise<{ cpuMax: string; cpus: number }> {
    current();
    const { init } = await this.#runningPoolAnchor(current);
    const seen = await this.#probe(init);
    current();
    return { cpuMax: seen.resources.cpuMax, cpus: cpus(seen.resources.cpusetCpusEffective).length };
  }
  /** Re-earn an ORIGINAL actual native ACK. No create/start/configure path. */
  async capturePoolObservation(
    input: DockerEmployeeResourcePolicy['pool'],
    current: () => void
  ): Promise<DockerPoolReconciliationReceipt> {
    const policy = DockerEmployeePoolPolicy.parse(input);
    current();
    const { anchors, id, name, configuration, init } = await this.#runningPoolAnchor(current);
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
    const closed: Array<() => Promise<void>> = [];
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
      if (
        raw.Image !== imageId ||
        z
          .object({ Status: z.literal('exited'), ExitCode: z.number().int().min(1).max(255) })
          .safeParse(raw.State).success ||
        z.object({ Status: z.literal('created'), Running: z.literal(false) }).safeParse(raw.State).success
      ) {
        // A writer of another helper image generation, one that exited with an
        // error, or one that was created and never started printed no
        // acknowledgement this office reads. It is admitted as a closed writer
        // only: never as an acknowledgement, never as unknown.
        closed.push(await this.#closedPoolWriter(candidate, taskName, raw, current));
        current();
        continue;
      }
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
    for (const stillClosed of closed) {
      await stillClosed();
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
    const retained = this.#retainedPoolTasks();
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
  /** Proves one pool writer container closed without reading an
   * acknowledgement from it, and returns the same proof to be made again. A
   * writer that is recorded finished is proved under its own journaled
   * configuration. One that is on no record, as the failed attempt of an
   * operation that has since issued the next one is, must be of a configured
   * image, fixed, and either exited with an error or never started. A writer
   * that was created and never started is what an operation leaves when the
   * office or the host stops between its CREATE and its START: it has written
   * nothing, and it acknowledges nothing. */
  async #closedPoolWriter(
    id: string,
    name: string,
    raw: Record<string, unknown>,
    current: () => void
  ): Promise<() => Promise<void>> {
    const recorded = this.#retainedPoolTasks().find(
      (task) =>
        (task.phase === 'completed' || task.phase === 'failed') && task.containerId === id && task.name === name
    );
    if (recorded) {
      const proof = async () => {
        if ((await this.#poolWriterState(recorded)) !== 'closed') refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
      };
      await proof();
      return proof;
    }
    const image = z.string().parse(raw.Image);
    const config = [this.configuration.helperImageId, this.configuration.poolRestoreHelperImageId].includes(image)
      ? this.#poolWriterConfiguration(name, image, raw)
      : undefined;
    if (!config) refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
    const read = async () =>
      (await this.#failedTerminal(id, config, current)) ?? (await this.#neverStarted(id, config, current));
    const first = await read();
    if (!first) refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
    return async () => {
      if (!isDeepStrictEqual(await read(), first)) refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
    };
  }
  #requireHistoricalPoolWriter(task: DockerContinuationTask): void {
    const digest = dockerContinuationDigest(task);
    const retained = this.#retainedPoolTasks();
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
    await this.#exclusiveWriter(() => this.#preparePool(row, anchor, current, admitted));
  }
  /** One pool writer or in-place repair at a time in this office process.
   * Every other writer on record is proved terminal natively before a writer
   * is created or started. */
  #exclusiveWriter<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#poolWrites.then(run, run);
    this.#poolWrites = next.catch(() => undefined);
    return next;
  }
  async #preparePool(
    row: DockerEmployeeContinuationRecord,
    anchor: Init,
    current: () => void,
    admitted: () => void
  ): Promise<void> {
    // A started own writer that is proved terminal and failed is recorded as
    // exactly that first. Nothing below treats it as an acknowledgement.
    await this.#settleFailedPool(row, current);
    current();
    const seen = await this.#probe(anchor);
    current();
    const p = row.policy.pool;
    // Limits that already match still need a surviving acknowledgement. When
    // every earlier writer is terminal or positively absent and none can
    // supply one, the same approved limits are written again below and that
    // writer earns a fresh acknowledgement.
    if (this.#matches(seen, p, null) && (await this.#poolAcknowledgedFor(row, seen))) {
      current();
      return;
    }
    const own = this.journal.read(row, 'pool-helper');
    const members = await this.#members();
    current();
    // The operation's own `configure-pool` initializes an EMPTY pool only, and
    // only while its cursor can still take an attempt. A pool that has members,
    // or an operation whose own writer is spent, is restored through the
    // office's repair journal with the restore helper.
    const attempt = members.length ? undefined : this.#ownPoolAttempt(row, own);
    if (attempt) {
      await this.#poolWritersClosed(own);
      current();
      await this.#configureTask(
        row,
        'pool-helper',
        this.#poolArguments(seen, p),
        { path: this.#parent, target: '/run/reverie-box-pool' },
        current,
        undefined,
        attempt
      );
    } else await this.#repairPool(row, anchor, admitted);
    const actual = await this.#probe(anchor);
    current();
    if (!this.#matches(actual, p, null)) refuse('DOCKER_RESOURCE_POOL_READBACK');
    await this.#poolAck(row, actual);
    current();
  }
  /** The attempt this operation's own pool writer may run now: its first, an
   * issued one as itself, or the one after a terminal failure. Undefined when
   * its cursor is spent: an acknowledged writer is never issued again. */
  #ownPoolAttempt(
    row: DockerEmployeeContinuationRecord,
    own: DockerContinuationTask | undefined
  ): { attempt: number; imageId: string; name?: string } | undefined {
    const imageId = this.configuration.helperImageId;
    if (!own) return { attempt: 1, imageId };
    if (own.phase === 'completed') return undefined;
    if (own.phase !== 'failed') {
      if (
        own.imageId !== imageId ||
        own.name !== this.#taskName(row, 'pool-helper', undefined, dockerTaskAttempt(own))
      )
        refuse('DOCKER_RESOURCE_ORIGINAL_TASK_CHANGED');
      return { attempt: dockerTaskAttempt(own), imageId, name: own.name };
    }
    const hold = dockerFailedWriterHold(own);
    if (hold !== 'DOCKER_RESOURCE_HELPER_RETRY_PENDING') refuse(hold);
    return { attempt: dockerTaskAttempt(own) + 1, imageId };
  }
  /** The fixed configuration of an issued repair writer, rebuilt from the
   * command of its own container and required to be the journaled one. */
  #repairConfiguration(task: DockerContinuationTask, raw: Record<string, unknown>): Config {
    let config: Config | undefined;
    if (task.role === 'pool-helper') config = this.#poolWriterConfiguration(task.name, task.imageId, raw);
    else {
      const args = z.object({ Cmd: z.array(z.string().max(4096)).min(1).max(512) }).parse(raw.Config).Cmd;
      const parsed = parseDockerLeafWriterArguments(args, this.configuration.boxId);
      if (parsed.mode === 'restore-high')
        config = this.#configuration(
          'leaf-helper',
          task.name,
          args,
          { path: `${this.#parent}/docker-${parsed.workerId}.scope`, target: '/run/reverie-worker-cgroup' },
          task.imageId
        );
    }
    if (!config || dockerContinuationDigest(config) !== task.configurationDigest)
      refuse('DOCKER_RESOURCE_ORIGINAL_TASK_CHANGED');
    return config;
  }
  /** Records a repair writer that is proved terminal and failed. Returns
   * whether its cursor now says so. Reads and one journal publication. */
  async #settleFailedRepair(
    row: DockerEmployeeContinuationRecord,
    role: 'pool-helper' | 'leaf-helper',
    journal: DockerContinuationTaskJournal,
    current: () => void
  ): Promise<boolean> {
    const task = journal.read(row, role);
    if (!task || !('containerId' in task) || !['start-issued', 'running'].includes(task.phase)) return false;
    const config = this.#repairConfiguration(task, await this.#inspect(task.containerId));
    current();
    const first = await this.#failedTerminal(task.containerId, config, current);
    const second = first && (await this.#failedTerminal(task.containerId, config, current));
    if (!first || !second || !isDeepStrictEqual(first, second)) return false;
    await this.#recordFailedWriter(row, journal, task, second, current);
    return journal.read(row, role)?.phase === 'failed';
  }
  /** Observes an issued repair attempt as itself until its cursor records how
   * it ended. Its CREATE and START are never repeated, and a writer that was
   * created and never started is started with the arguments it was created
   * with: the helper re-proves every one of them before it writes. A writer
   * that was recorded as about to be created and that the Engine positively
   * does not list was never created: its attempt is closed, never resumed. */
  async #resumeRepair(
    row: DockerEmployeeContinuationRecord,
    role: 'pool-helper' | 'leaf-helper',
    attempt: DockerResourceRepairAttempt,
    current: () => void
  ): Promise<void> {
    const journal = attempt.journal;
    const task = journal.read(row, role);
    if (!task || task.phase === 'completed' || task.phase === 'failed') return;
    let id = 'containerId' in task ? task.containerId : undefined;
    if (!id) {
      const listed = (
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
      if (!listed) {
        // Only a journaled `created` container is ever started, so a container
        // that was never recorded as created can never write for this attempt.
        attempt.abandon(current);
        return;
      }
      id = cid.parse(listed);
    }
    const config = this.#repairConfiguration(task, await this.#inspect(id));
    current();
    if (role === 'pool-helper') await this.#poolWritersClosed(task);
    current();
    try {
      await this.#runWriter(row, role, task.name, config, current, journal, 1);
    } catch (error) {
      if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_RESOURCE_HELPER_FAILED')
        throw error;
      if (!(await this.#settleFailedRepair(row, role, journal, current))) throw error;
    }
  }
  /** One repair attempt for `target`: an attempt that is already issued is
   * observed as itself and nothing new is issued in that call. Returns
   * whether a new attempt ran to its acknowledgement. */
  async #repairAttempt(
    target: DockerResourceRepairTarget,
    row: DockerEmployeeContinuationRecord,
    current: () => void,
    issue: (attempt: DockerResourceRepairAttempt) => Promise<void>
  ): Promise<boolean> {
    const repairs = this.configuration.repairs;
    if (!repairs) refuse('DOCKER_RESOURCE_REPAIR_UNAVAILABLE');
    const role = target.kind === 'pool' ? 'pool-helper' : 'leaf-helper';
    return repairs.attempt(target, current, async (attempt) => {
      if (!attempt.fresh) {
        await this.#resumeRepair(row, role, attempt, current);
        return false;
      }
      try {
        await issue(attempt);
      } catch (error) {
        // A writer that exited with an error is recorded as failed at once, so
        // that the request after this one may issue a new attempt.
        if (error instanceof DockerEmployeeContinuationError && error.code === 'DOCKER_RESOURCE_HELPER_FAILED')
          await this.#settleFailedRepair(row, role, attempt.journal, current).catch(() => false);
        throw error;
      }
      return true;
    });
  }
  /** Writes the approved pool limits once through the repair journal:
   * `restore-pool` with every live member bound by its birth for a pool that
   * has members, `configure-pool` for an empty one. */
  async #issuePoolRepair(
    row: DockerEmployeeContinuationRecord,
    anchor: Init,
    attempt: DockerResourceRepairAttempt,
    current: () => void
  ): Promise<void> {
    const policy = row.policy.pool;
    const members = await this.#members();
    current();
    const seen = await this.#probe(anchor);
    current();
    await this.#poolWritersClosed();
    current();
    let imageId = this.configuration.helperImageId,
      args = this.#poolArguments(seen, policy);
    if (members.length) {
      // `configure-pool` refuses a pool that has members. Without a pinned
      // restore helper nothing is issued against one.
      const selected = this.configuration.poolRestoreHelperImageId;
      if (!selected) refuse('DOCKER_POOL_RESTORE_HELPER_REQUIRED');
      await requireDockerPoolRestoreHelperImage(this.command, selected, current);
      imageId = selected;
      args = ['restore-pool', ...args.slice(1), ...members];
    }
    // The members named to the helper are those of the probe above. The
    // helper binds each one to its process birth again before and after it writes.
    if (!isDeepStrictEqual(await this.#members(), members)) refuse('DOCKER_RESOURCE_MEMBERS_CHANGED');
    current();
    await this.#configureTask(row, 'pool-helper', args, { path: this.#parent, target: '/run/reverie-box-pool' }, current, {
      id: attempt.id,
      journal: attempt.journal,
      imageId,
    });
  }
  /** Re-applies the already approved pool limits when the kernel no longer
   * shows them, or shows them with no surviving acknowledgement. The policy is
   * the one this record was approved with; nothing here can change it. */
  async #repairPool(
    row: DockerEmployeeContinuationRecord,
    anchor: Init,
    current: () => void
  ): Promise<'unchanged' | 'restored'> {
    const policy = row.policy.pool;
    for (let pass = 0; ; pass++) {
      const seen = await this.#probe(anchor);
      current();
      if (this.#matches(seen, policy, null) && (await this.#poolAcknowledged(seen, policy))) {
        if (pass) await this.#removeSupersededRepairs({ kind: 'pool' }, current);
        return pass ? 'restored' : 'unchanged';
      }
      current();
      // An earlier attempt is settled as itself first; then one new attempt.
      if (pass > 1) refuse('DOCKER_RESOURCE_POOL_READBACK');
      const issued = await this.#repairAttempt({ kind: 'pool' }, row, current, (attempt) =>
        this.#issuePoolRepair(row, anchor, attempt, current)
      );
      current();
      if (issued) pass = 1;
    }
  }
  /** The owner's or the supervisor's in-place repair of the shared pool, for
   * the already recorded running anchor. No worker is stopped or recreated. */
  async repairPool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<'unchanged' | 'restored'> {
    current();
    const anchor = await this.#anchor(row);
    current();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    return this.#exclusiveWriter(() => this.#repairPool(row, anchor, current));
  }
  /** Re-applies one published laptop's own approved limits in place, when the
   * kernel no longer shows them or no acknowledgement of them survives. The
   * laptop keeps running; the shared pool must already be confirmed. */
  async repairLeaf(row: DockerEmployeeContinuationRecord, current: () => void): Promise<'unchanged' | 'restored'> {
    current();
    // A record that a plan move made is repaired like any other. That it is no longer the move's own is the
    // caller's to prove (`DockerLaptopLimitUpkeep`); the set-up service's own repair still refuses such a record.
    if (
      !['provider-issued', 'ready'].includes(row.phase) ||
      !row.destination ||
      this.journal.read(row, 'leaf-helper')?.phase !== 'completed'
    )
      refuse('DOCKER_RESOURCE_REPAIR_SCOPE_UNSUPPORTED');
    // An owner's soft-memory revision has its own ledger, writer and approval.
    if ((this.revisions?.history(row).length ?? 0) > 0) refuse('DOCKER_RESOURCE_REPAIR_REVISION_PRESENT');
    const workerId = row.destination.containerId;
    // One repair at a time: a read of every leaf writer of the box never runs beside this office's own writer.
    return this.#exclusiveWriter(() => this.#repairLeaf(row, workerId, current));
  }
  async #repairLeaf(
    row: DockerEmployeeContinuationRecord,
    workerId: string,
    current: () => void
  ): Promise<'unchanged' | 'restored'> {
    const approved = async () => {
      try {
        const actual = await this.read(row);
        return !!actual && isDeepStrictEqual(actual, row.policy);
      } catch (error) {
        // No acknowledgement of this leaf survives: exactly what a repair earns again.
        if (error instanceof DockerEmployeeContinuationError && error.code === 'DOCKER_RESOURCE_LEAF_ACK_MISSING')
          return false;
        throw error;
      }
    };
    for (let pass = 0; ; pass++) {
      if (await approved()) {
        if (pass) await this.#removeSupersededRepairs({ kind: 'leaf', workerId }, current);
        return pass ? 'restored' : 'unchanged';
      }
      current();
      if (pass > 1) refuse('DOCKER_RESOURCE_WORKER_READBACK');
      const issued = await this.#repairAttempt({ kind: 'leaf', workerId }, row, current, (attempt) =>
        this.#issueLeafRepair(row, attempt, current)
      );
      current();
      if (issued) pass = 1;
    }
  }
  async #issueLeafRepair(
    row: DockerEmployeeContinuationRecord,
    attempt: DockerResourceRepairAttempt,
    current: () => void
  ): Promise<void> {
    const anchor = await this.#anchor(row);
    current();
    if (!anchor) refuse('DOCKER_RESOURCE_ANCHOR_UNCONFIRMED');
    const worker = await this.#worker(row);
    current();
    const seen = await this.#probe(anchor, worker);
    current();
    if (!seen.worker) refuse('DOCKER_RESOURCE_WORKER_READBACK');
    await this.#memoryFits(worker.id, row.policy);
    current();
    // No other writer of this laptop's leaf is left unterminated.
    await this.#workerLeafWriters(seen.worker.id, current);
    const imageId = await this.#leafWriterImage(current);
    await this.#configureTask(
      row,
      'leaf-helper',
      this.#leafArguments(seen, row.policy, await this.#members(worker.id), 'restore-high'),
      { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
      current,
      { id: attempt.id, journal: attempt.journal, imageId }
    );
  }
  /**
   * A repair writes the laptop's approved `memory.high` and `memory.max` into a laptop that is running, with an
   * agent at work in it. Above `memory.high` the kernel throttles the laptop and reclaims hard; above `memory.max`
   * it reclaims at once and, failing that, kills a process of the laptop for memory. What reclaim cannot give back
   * is the memory the laptop holds that is not page cache: anonymous memory, shared memory (with no swap, it stays
   * where it is) and the kernel's own memory that cannot be reclaimed, read from the laptop's own `memory.stat`
   * inside it (`heldMemoryBytes`). Page cache is left out on purpose: a laptop that ran without its limit for a
   * while holds cache above it, and reclaim gives that back without harm. The repair refuses, writing nothing and
   * opening no attempt, while what is held is above either limit, or cannot be read; the next look asks again,
   * and the laptop goes on under the shared pool's limit meanwhile. The refusal carries the numbers.
   */
  async #memoryFits(workerId: string, policy: DockerEmployeeResourcePolicy): Promise<void> {
    let raw: string;
    try {
      raw = await this.command.run(['exec', workerId, '/bin/cat', '/sys/fs/cgroup/memory.stat']);
    } catch {
      return refuse('DOCKER_RESOURCE_REPAIR_MEMORY_UNREAD');
    }
    const heldBytes = heldMemoryBytes(raw);
    if (heldBytes === undefined) refuse('DOCKER_RESOURCE_REPAIR_MEMORY_UNREAD');
    const limits = [policy.memoryHighBytes, policy.memoryMaxBytes].filter((value): value is number => value !== null);
    if (heldBytes! > Math.min(...limits))
      throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REPAIR_MEMORY_IN_USE', 409, {
        cause: {
          heldBytes,
          memoryHighBytes: policy.memoryHighBytes,
          memoryMaxBytes: policy.memoryMaxBytes,
        } satisfies DockerHeldMemory,
      });
  }
  /** Once a repair's writer is acknowledged and read back, every earlier
   * repair writer of the same target that is recorded finished is superseded:
   * the newest acknowledgement stays, and so does any writer the company
   * record names. The Engine port re-reads each container's name, image,
   * labels and exited state before it removes it, never by force. Without this
   * a host that reloads often would fill the helper census. A removal that
   * fails is left for the next repair and never fails this one. */
  async #removeSupersededRepairs(target: DockerResourceRepairTarget, current: () => void): Promise<void> {
    const repairs = this.configuration.repairs,
      remove = this.command.removeSupersededHelper?.bind(this.command);
    if (!repairs || !remove) return;
    try {
      const role = target.kind === 'pool' ? 'pool-helper' : 'leaf-helper';
      const finished = repairs.finished(target),
        newest = finished.filter((task) => task.phase === 'completed').at(-1);
      if (!newest) return;
      const present = new Set(await this.#poolCensus(role));
      current();
      const recorded = new Set(
        (this.configuration.retainedPoolConfigurationTasks?.() ?? []).flatMap((task) =>
          'containerId' in task ? [task.containerId] : []
        )
      );
      for (const task of finished) {
        if (task.containerId === newest.containerId || recorded.has(task.containerId) || !present.has(task.containerId))
          continue;
        await remove(
          task.containerId,
          {
            name: '/' + task.name,
            imageId: task.imageId,
            labels: {
              'org.reverie.purpose': 'boxed-resource-helper-v1',
              'reverie.box.resource.box': this.configuration.boxId,
              'reverie.box.resource.role': role,
              'reverie.box.resource.name': task.name,
            },
          },
          current
        ).catch(() => undefined);
      }
    } catch {
      /* Housekeeping only: the repair above is already acknowledged. */
    }
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
    for (const helper of helpers) {
      if (retained.some(task => (task.phase === 'completed' || task.phase === 'failed') && task.containerId === helper))
        continue;
      // Not recorded as finished. A host that stops in the middle of an operation leaves such writers: one that
      // was created and never started, one that was stopped with the host, and one that ended before the office
      // could record it. Each is admitted when it is proved unable to write anything more to a pool whose anchor
      // is stopped: of a configured image, fixed, and either never started or ended. Nothing is read from it.
      await this.#coldClosedHelper(helper, current).catch((cause: unknown) => {
        throw new DockerEmployeeContinuationError('DOCKER_POOL_COLD_WRITER_UNCONFIRMED', 409, { cause });
      });
    }
    if (dockerContinuationDigest(await this.#stoppedPoolAnchor(id, configuration, current)) !== dockerContinuationDigest(state) ||
        !isDeepStrictEqual(await this.#poolCensus('pool-helper'), helpers))
      refuse('DOCKER_POOL_COLD_SOURCE_CHANGED');
    current();
    return { id, state, configuration, members, digest: dockerContinuationDigest({
      original, state, members, helpers, policy: row.policy.pool,
    }) };
  }
  /** A pool writer that no record names as finished, proved unable to write
   * anything more: of a configured image, fixed, and either never started or
   * ended with any status, the same across two inspections. */
  async #coldClosedHelper(id: string, current: () => void): Promise<void> {
    const raw = await this.#inspect(id);
    current();
    const labels = z.record(z.string(), z.string()).parse(z.record(z.string(), z.unknown()).parse(raw.Config).Labels);
    const name = z
      .string()
      .regex(/^reverie-boxed-pool-helper-[a-f0-9]{64}$/)
      .parse(labels['reverie.box.resource.name']);
    const image = z.string().parse(raw.Image);
    const config = [this.configuration.helperImageId, this.configuration.poolRestoreHelperImageId].includes(image)
      ? this.#poolWriterConfiguration(name, image, raw)
      : undefined;
    if (!config) refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
    const read = async () =>
      (await this.#endedTerminal(id, config, current)) ?? (await this.#neverStarted(id, config, current));
    const first = await read();
    if (!first || !isDeepStrictEqual(await read(), first)) refuse('DOCKER_POOL_WRITER_UNCONFIRMED');
  }
  /**
   * Removes the anchor of this box's pool while the Engine reports it dead. A
   * dead container is one the Engine failed to remove or stop; it can be
   * neither started nor used again, so the pool cannot be recovered while it
   * stands, and a laptop set-up cannot create a new anchor under its name.
   *
   * Everything is proved first, and nothing is removed by force:
   * - `row` is a laptop record that names this very container as the pool's
   *   anchor, under the configuration and policy the record was made with.
   * - It is the one anchor of the box by census, and its fixed configuration
   *   is exactly the anchor configuration of this box.
   * - The Engine reports it dead, not running, with no process.
   * - No laptop of the box runs: none on record, and no container with the
   *   box's laptop label that is running, paused or restarting.
   * - Every pool writer is accounted for and can write nothing more.
   * - The caller's `current` holds the cold-recovery journal idle: no
   *   recovery that was issued for this anchor is unfinished.
   * The Engine port then reads the container once more and removes it. The
   * Engine may refuse to remove a dead container; its own words are returned,
   * and nothing else was changed.
   */
  async removeDeadPoolAnchor(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<{ removed: true } | { removed: false; engine: string }> {
    current();
    const remove = this.command.removeDeadPoolAnchor?.bind(this.command);
    if (!remove) refuse('DOCKER_POOL_DEAD_ANCHOR_REMOVAL_UNAVAILABLE');
    const original = row.tasks?.find(task => task.role === 'anchor');
    const name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32);
    const configuration = this.#configuration('anchor', name, ['anchor']);
    if (!row.pool || original?.phase !== 'running' || original.containerId !== row.pool.containerId ||
        original.configurationDigest !== dockerContinuationDigest(configuration) ||
        row.pool.cgroupParent !== this.#slice || row.pool.policyDigest !== dockerContinuationDigest(row.policy.pool))
      refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const id = original.containerId;
    const anchors = await this.#poolCensus('anchor');
    current();
    if (anchors.length !== 1 || anchors[0] !== id) refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const dead = async () => {
      const raw = await this.#fixed(id, configuration);
      current();
      return z.object({
        Running: z.literal(false), Paused: z.literal(false), Restarting: z.literal(false), Pid: z.literal(0),
      }).passthrough().refine(state => state.Dead === true || state.Status === 'dead').safeParse(raw.State).success;
    };
    if (!(await dead())) refuse('DOCKER_POOL_DEAD_ANCHOR_NOT_DEAD');
    await this.#coldPoolMembers(current);
    const retained = await this.#poolWritersClosed();
    current();
    for (const helper of await this.#poolCensus('pool-helper')) {
      if (retained.some(task => (task.phase === 'completed' || task.phase === 'failed') && task.containerId === helper))
        continue;
      await this.#coldClosedHelper(helper, current).catch((cause: unknown) => {
        throw new DockerEmployeeContinuationError('DOCKER_POOL_COLD_WRITER_UNCONFIRMED', 409, { cause });
      });
    }
    if (!(await dead())) refuse('DOCKER_POOL_DEAD_ANCHOR_NOT_DEAD');
    try {
      await remove(id, { name: '/' + name, imageId: this.configuration.helperImageId, boxId: this.configuration.boxId }, current);
    } catch (error) {
      current();
      if (error instanceof DockerEmployeeContinuationError) throw error;
      return { removed: false, engine: engineWords(error) };
    }
    current();
    if ((await this.#poolCensus('anchor')).includes(id))
      return { removed: false, engine: 'the container engine still lists the container' };
    return { removed: true };
  }
  /** The one fixed anchor of this box, stopped. An anchor that ended by any
   * exit status, that was killed for memory, or whose last start failed is
   * stopped all the same and can be started. One the Engine reports dead
   * cannot be started by anyone, and that is said with its own code; any
   * other state is not a stopped anchor. */
  async #stoppedPoolAnchor(id: string, configuration: Config, current: () => void) {
    const anchors = await this.#poolCensus('anchor');
    current();
    if (anchors.length !== 1 || anchors[0] !== id) refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const raw = await this.#fixed(id, configuration);
    current();
    const state = z.object({ Status: z.string(), Dead: z.boolean() }).passthrough().safeParse(raw.State);
    if (state.success && (state.data.Dead || state.data.Status === 'dead')) refuse('DOCKER_POOL_COLD_ANCHOR_DEAD');
    const stopped = z.object({
      Status: z.literal('exited'), Running: z.literal(false), Restarting: z.literal(false),
      Paused: z.literal(false), Dead: z.literal(false), Pid: z.literal(0),
      OOMKilled: z.boolean(), Error: z.string().max(4096),
      StartedAt: z.string().datetime(), FinishedAt: z.string().datetime(),
    }).passthrough().safeParse(raw.State);
    if (!stopped.success) refuse('DOCKER_POOL_COLD_ANCHOR_NOT_STOPPED');
    return stopped.data;
  }
  /** No laptop of this box runs. Every laptop on record is read; one the
   * Engine positively reports absent runs nothing. Then the Engine is asked
   * for every container that carries this box's laptop label and is running,
   * paused or restarting, recorded or not: the pool is never recovered cold
   * beside one. */
  async #coldPoolMembers(current: () => void): Promise<string> {
    const bindings: Record<string, unknown>[] = [];
    const active = await this.#members(undefined, this.command, bindings);
    current();
    if (active.length) refuse('DOCKER_POOL_COLD_WORKERS_RUNNING');
    const labelled = (
      await this.command.run([
        'container', 'ls', '--all', '--no-trunc',
        '--filter', 'label=reverie.boxed.box=' + this.configuration.boxId,
        '--filter', 'status=running', '--filter', 'status=paused', '--filter', 'status=restarting',
        '--format', '{{.ID}}',
      ])
    ).trim();
    current();
    if (labelled !== '') refuse('DOCKER_POOL_COLD_WORKERS_RUNNING');
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
    return this.#configureColdPool(row, init, attempt.id, journal, current);
  }
  /** The attempt's one pool writer under its own cursor, then the fresh observation that acknowledges it. */
  async #configureColdPool(
    row: DockerEmployeeContinuationRecord,
    init: Init,
    attemptId: string,
    journal: DockerContinuationTaskJournal,
    current: () => void
  ): Promise<DockerPoolReconciliationReceipt> {
    const seen = await this.#probe(init);
    current();
    await this.#configureTask(row, 'pool-helper', this.#poolArguments(seen, row.policy.pool), {
      path: this.#parent, target: '/run/reverie-box-pool',
    }, current, { id: attemptId, journal, imageId: this.configuration.helperImageId });
    current();
    return this.capturePoolObservation(row.policy.pool, current);
  }
  /** Observes the helper of an unfinished cold attempt as itself until its
   * cursor records how it ended, exactly as an issued repair attempt is
   * observed: its CREATE and START are never repeated, a helper that was
   * created and never started is started with the arguments it was created
   * with (it re-proves every one of them before it writes), and one that
   * exited with an error is recorded as failed. A helper that cannot be proved
   * to have ended throws, and the attempt stays held. */
  async #settleColdWriter(
    row: DockerEmployeeContinuationRecord,
    journal: DockerContinuationTaskJournal,
    current: () => void
  ): Promise<void> {
    const task = journal.read(row, 'pool-helper');
    if (!task || task.phase === 'completed' || task.phase === 'failed') return;
    let id = 'containerId' in task ? task.containerId : undefined;
    if (!id) {
      const listed = (
        await this.command.run([
          'container', 'ls', '--all', '--no-trunc', '--filter', 'label=reverie.box.resource.name=' + task.name,
          '--format', '{{.ID}}',
        ])
      ).trim();
      current();
      // Only a journaled `created` container is ever started, so one that was
      // never recorded as created can never write for this attempt.
      if (!listed) return;
      id = cid.parse(listed);
    }
    const config = this.#repairConfiguration(task, await this.#inspect(id));
    current();
    await this.#poolWritersClosed(task);
    current();
    try {
      await this.#runWriter(row, 'pool-helper', task.name, config, current, journal, 1);
    } catch (error) {
      if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_RESOURCE_HELPER_FAILED')
        throw error;
      if (!(await this.#settleFailedRepair(row, 'pool-helper', journal, current))) throw error;
    }
  }
  /** Finishes the one unfinished cold attempt as itself. Nothing it already
   * issued is issued again.
   *
   * - No helper on its cursor and the anchor still stopped: when every native
   *   fact is exactly what the attempt was issued for (`issuedFor`), its anchor
   *   START never took effect and it runs now, as itself. When the facts
   *   differ, or a laptop runs, it did nothing that lasts.
   * - No helper on its cursor and the anchor running: the START took effect.
   *   Its helper was never issued and is issued now, once.
   * - A helper on its cursor: that helper is observed as itself to its end.
   *
   * Returns the fresh pool observation when the pool is confirmed. Returns
   * null when the attempt confirmed nothing and can write nothing more: it has
   * no helper, or its helper is terminal or was never created. Anything that
   * cannot be proved throws, and the attempt stays held. */
  async resumeColdPool(
    row: DockerEmployeeContinuationRecord,
    attempt: { id: string; issuedFor(nativeDigest: string): boolean },
    journal: DockerContinuationTaskJournal,
    current: () => void
  ): Promise<DockerPoolReconciliationReceipt | null> {
    current();
    const original = row.tasks?.find(task => task.role === 'anchor');
    const name = 'reverie-boxed-anchor-' + this.configuration.boxId.slice(0, 32);
    const configuration = this.#configuration('anchor', name, ['anchor']);
    if (!row.pool || original?.phase !== 'running' || original.containerId !== row.pool.containerId ||
        original.configurationDigest !== dockerContinuationDigest(configuration))
      refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const id = original.containerId;
    const anchors = await this.#poolCensus('anchor');
    current();
    if (anchors.length !== 1 || anchors[0] !== id) refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const running = async () => {
      const raw = await this.#fixed(id, configuration);
      current();
      return (raw.State as { Running?: unknown }).Running === true;
    };
    if (!journal.read(row, 'pool-helper')) {
      // A laptop runs: nothing is recovered cold beside it, and this attempt has no writer.
      const beside = (error: unknown): null => {
        current();
        if (error instanceof DockerEmployeeContinuationError && error.code === 'DOCKER_POOL_COLD_WORKERS_RUNNING')
          return null;
        throw error;
      };
      if (await running()) {
        const init = await this.#init(id);
        current();
        if (!init) refuse('DOCKER_POOL_COLD_START_UNCONFIRMED');
        try {
          await this.#coldPoolMembers(current);
        } catch (error) {
          return beside(error);
        }
        return this.#configureColdPool(row, init, attempt.id, journal, current);
      }
      let source: Awaited<ReturnType<DockerContainedResources['coldPoolScope']>>;
      try {
        source = await this.coldPoolScope(row, current);
      } catch (error) {
        return beside(error);
      }
      if (!attempt.issuedFor(source.digest)) return null;
      return this.recoverColdPool(row, { id: attempt.id, nativeDigest: source.digest }, journal, current);
    }
    await this.#settleColdWriter(row, journal, current);
    current();
    if (journal.read(row, 'pool-helper')?.phase !== 'completed' || !(await running())) return null;
    try {
      return await this.capturePoolObservation(row.policy.pool, current);
    } catch (error) {
      current();
      // The helper acknowledged and has ended. What it acknowledged no longer
      // covers the pool as it is now, so the attempt confirms nothing.
      if (error instanceof DockerEmployeeContinuationError) return null;
      throw error;
    }
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
  async #refresh(seen: Observation, current: () => void = () => {}, attempts = 8): Promise<Observation> {
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
    // A terminally failed writer acknowledged nothing: no enforcement is known.
    if (!issued || issued.phase === 'create-issued' || issued.phase === 'created' || issued.phase === 'failed')
      return null;
    if (['provider-issued', 'ready'].includes(row.phase) && issued.phase === 'completed') {
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
    const result: {
      id: string;
      name: string;
      args: string[];
      scopeArguments: string[];
      imageId: string;
      exitCode: number;
    }[] = [];
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
        parsed.mode !== 'configure-memory-high'
          ? // Either pin a configure-high or restore-high writer may carry; the fixed
            // configuration check below still requires that exact image.
            (this.#leafWriterImages().find((image) => image === raw.Image) ?? this.configuration.helperImageId)
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
      result.push({
        id,
        name,
        args: config.Cmd,
        scopeArguments: parsed.scopeArguments,
        imageId,
        exitCode: state.ExitCode,
      });
    }
    return result;
  }
  #leafArguments(
    seen: Observation,
    policy: DockerEmployeeResourcePolicy,
    members: readonly string[],
    command: 'configure-high' | 'restore-high' = 'configure-high'
  ): string[] {
    if (!seen.worker || policy.memoryHighBytes === null) refuse('DOCKER_RESOURCE_FINITE_HIGH_REQUIRED');
    return [
      command,
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
    // Either command writes this same approved policy to this same leaf.
    const expected = this.#leafArguments(seen, row.policy, []).slice(1),
      matches: DockerContinuationTask[] = [];
    for (const writer of writers) {
      if (
        !this.#leafWriterImages().includes(writer.imageId) ||
        !['configure-high', 'restore-high'].includes(writer.scopeArguments[0]!) ||
        !isDeepStrictEqual(writer.scopeArguments.slice(1), expected) ||
        // A writer that exited with an error acknowledged nothing.
        writer.exitCode !== 0
      )
        continue;
      const ack = observation.parse(JSON.parse(await this.command.run(['container', 'logs', writer.id])));
      check();
      const task = DockerContinuationTask.parse({
        role: 'leaf-helper',
        name: writer.name,
        imageId: writer.imageId,
        configurationDigest: dockerContinuationDigest(
          this.#configuration(
            'leaf-helper',
            writer.name,
            writer.args,
            { path: seen.worker!.path, target: '/run/reverie-worker-cgroup' },
            writer.imageId
          )
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
            // The revision ledger holds single-attempt tasks only; its writer is never rerun.
            { ...dockerResourceAttemptKey(row, revision), state: 'helper', task: DockerSingleAttemptTask.parse(next) },
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
      if (!('containerId' in original) || !(await this.#ack(original, seen, policy, high, role === 'leaf-helper'))) {
        // A writer proved terminal and failed is recorded as exactly that. Its
        // phase owner then reruns it or holds it; nothing is acknowledged.
        if (role === 'leaf-helper') await this.#settleFailedLeaf(row, seen, current);
        else await this.#settleFailedPool(row, current);
        if (this.journal.read(row, role)?.phase === 'failed') continue;
        refuse('DOCKER_RESOURCE_TASK_UNCONFIRMED');
      }
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
    // A writer that failed because a process ended while it was read is rerun
    // here, each time from a freshly collected scope and under its own journal
    // intent, at most three times for one request. Any other outcome holds.
    for (let issued = 0, unsettled = false; ; ) {
      const probed = await this.#probe(anchor, worker);
      current();
      const next = await this.#leafAttempt(row, probed, issued, current),
        seen = next.seen;
      current();
      // The writer just waited for failed, and that could not be proved terminal.
      if (unsettled && !next.fresh) refuse('DOCKER_RESOURCE_HELPER_FAILED');
      if (!seen.worker) refuse('DOCKER_RESOURCE_WORKER_READBACK');
      if (next.fresh) issued++;
      try {
        await this.#configureTask(
          row,
          'leaf-helper',
          this.#leafArguments(seen, row.policy, await this.#members(worker.id)),
          { path: seen.worker.path, target: '/run/reverie-worker-cgroup' },
          current,
          undefined,
          next
        );
        break;
      } catch (error) {
        if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_RESOURCE_HELPER_FAILED')
          throw error;
        current();
        unsettled = true;
      }
    }
    const actual = await this.read(row);
    current();
    if (!actual || !isDeepStrictEqual(actual, row.policy)) refuse('DOCKER_RESOURCE_WORKER_READBACK');
  }
}
