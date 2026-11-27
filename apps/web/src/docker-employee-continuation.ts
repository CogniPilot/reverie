/** Single decision owner for an explicitly approved boxed continuation.
 * The old laptop stays stopped. A new Docker-owned destination reuses its actual
 * private home and image, not its host parent. Loaded rows are deny-only until
 * fresh authority and observations of the same originals permit the next phase.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  DockerEmployeeBinding,
  DockerEmployeeContinuationRecord,
  DockerEmployeeContinuationRequest,
  DockerEmployeeOriginal,
  DockerEmployeeResourcePolicy,
  DockerEmployeePool,
  DockerEmployeeWorkerImage,
  type DockerEmployeeContinuationPhase,
} from './docker-employee-continuation-data.js';
import { dockerFailedWriterHold } from './docker-continuation-task.js';
import { dockerRecoveryGuidance, type DockerRecoveryAction } from './docker-recovery-guidance.js';
import type { DockerProviderExit } from './docker-provider-exit.js';
export function dockerContinuationDigest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]])
            )
          : item
      )
    )
    .digest('hex');
}
export class DockerEmployeeContinuationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    options?: ErrorOptions
  ) {
    super(code, options);
  }
}
export interface DockerContinuationAuthority {
  readonly owner: string | undefined;
  require(): void;
  /**
   * Called once by a rebuild, after its own checks and immediately before it stops the first laptop. A caller that
   * confirmed the discard on a proof about the laptop's agent proves it here for the last time, by throwing when it
   * no longer holds: nothing has been stopped yet. What the laptop does after this call is the stop itself.
   */
  discarding?(): void;
  /** Independent office permission: recovery permission cannot end vacation. */
  requireOffice(): void;
}
export interface DockerContinuationSubject {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly owner: string | undefined;
  readonly sourceDigest: string;
  readonly providerSourceDigest: string;
  readonly onVacation: boolean;
  readonly desiredRunning: boolean | undefined;
}
export interface DockerSourceObservation {
  readonly original: DockerEmployeeOriginal;
  readonly state: 'stopped' | 'running';
}
export interface DockerContainerObservation extends DockerSourceObservation {
  readonly resources: DockerEmployeeResourcePolicy | null;
  readonly provider:
    | { kind: 'absent' }
    | { kind: 'running'; operationId: string; sessionId: string }
    /** Its pane is retained dead: the provider process ended and left this evidence. */
    | { kind: 'exited'; exit: DockerProviderExit }
    | { kind: 'unknown' };
  readonly credentialDigest: string | null;
  /** Whether the laptop was created with the shared local model socket
   * directory. Absent when the reader did not look. */
  readonly modelSocketMounted?: boolean;
}
/** Why a launch would fail, found before the one launch attempt is spent. */
export interface DockerProviderPreflightRefusal {
  readonly code: string;
  readonly message: string;
}
export interface DockerContinuationEngine {
  image(original: DockerEmployeeOriginal): Promise<DockerEmployeeWorkerImage>;
  preparedIdentityImage?(row: DockerEmployeeContinuationRecord, current: () => void): Promise<DockerEmployeeWorkerImage>;
  /** Re-earn the frozen published image. A newer launch selection must not
   * turn existing-provider reads into admission of that newer image. */
  existingImage?(row: DockerEmployeeContinuationRecord, current: () => void): Promise<DockerEmployeeWorkerImage>;
  /** Private v3 read qualification from the actual prior boxed generation. */
  imageForPlanReplacement?(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<DockerEmployeeWorkerImage>;
  observeSource(subject: DockerContinuationSubject, containerId?: string, expected?: DockerEmployeeOriginal): Promise<DockerSourceObservation>;
  /** v3 source closure reads the retained OLD placement, not the target subject.
   * The owning Engine must validate its genuine boxed source and no-restart state. */
  observePlanReplacementSource?(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<DockerSourceObservation>;
  validateCapabilities(original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void>;
  /** Shared aggregate pool has its own retained controller owner; prepare is never a status action. */
  assertPreparationCurrent?(row: DockerEmployeeContinuationRecord): void;
  prepareStorage?(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void>;
  observeStorage?(
    row: DockerEmployeeContinuationRecord
  ): Promise<'ready' | 'unissued' | 'unknown' | 'ephemeral-unissued'>;
  preparePool(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null>;
  /** Only the captured original's inspected immutable config/home; no HTTP command/mount/path. */
  createDestination(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null>;
  /** Genuine read-owned native revision proof; never a request policy override. */
  existingResourcePolicyCurrent?(
    row: DockerEmployeeContinuationRecord,
    actual: DockerEmployeeResourcePolicy | null
  ): boolean;
  start(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  configureResources(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  /** Records a started resource writer that is proved terminal and failed. One
   * journal publication and reads; never a CREATE, START or kernel write. */
  settleResourceWriter?(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  /** The same for this operation's own pool writer, before the pool is read. */
  settlePoolWriter?(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  /** Re-applies the already approved limits of one published, running laptop
   * in place. Never a stop, start, launch or policy change. */
  repairResources?(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  provisionIdentity(row: DockerEmployeeContinuationRecord, token: string, requireCurrent: () => void): Promise<void>;
}
export interface DockerContinuationStore {
  subject(employeeId: string): DockerContinuationSubject | undefined;
  existingSubject(employeeId: string, row: DockerEmployeeContinuationRecord): DockerContinuationSubject | undefined;
  /** Current owner-approved policy; request parameters carry only its expected digest. */
  policy(employeeId: string): DockerEmployeeResourcePolicy;
  record(employeeId: string): DockerEmployeeContinuationRecord | undefined;
  /** The never-started laptop source of the employee's newest rebuild, while no laptop set-up has gone past it. */
  unusedSource?(employeeId: string): { readonly containerId: string } | undefined;
  replace(
    before: DockerEmployeeContinuationRecord | undefined,
    next: DockerEmployeeContinuationRecord,
    requireCurrent: () => void
  ): Promise<void>;
  enterOffice(subject: DockerContinuationSubject, requireCurrent: () => void): Promise<void>;
  bind(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    requireCurrent: () => void
  ): Promise<void>;
}
export interface DockerContinuationProvider {
  /** Canonical saved Session recipe, same full SID/provider thread; uncertainty never repeats this call. */
  launch(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    requireCurrent: () => void
  ): Promise<void>;
  /** Read-only check of what the saved recipe needs in order to start, made
   * before the launch is recorded as issued. A refusal changes nothing and the
   * same step may be continued once its cause is repaired. */
  preflight?(
    row: DockerEmployeeContinuationRecord,
    facts: { readonly modelSocketMounted: boolean | undefined },
    requireCurrent: () => void
  ): Promise<DockerProviderPreflightRefusal | undefined>;
}
export interface DockerContinuationIdentity {
  issue(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): string;
}
export interface DockerContinuationResult {
  operationId: string;
  phase: DockerEmployeeContinuationPhase;
  state: 'ready' | 'pending' | 'held';
  /** `continue` and `retry` both name this same request sent again. `repair`
   * re-applies this laptop's approved limits in place; `repair-pool` does the
   * same for the pool that every laptop shares. */
  allowedActions: readonly ('observe' | 'continue' | 'repair' | 'repair-pool' | DockerRecoveryAction)[];
  code?: string;
  /** One plain sentence for the codes that have one. DATA only; never part of a decision. */
  message?: string;
  /** How a provider that exited right after its launch ended, with its last
   * terminal lines. Bounded, redacted diagnostic DATA. */
  providerExit?: DockerProviderExit;
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
/** Holds of a published laptop that the shared pool's in-place repair settles. */
const POOL_REPAIRABLE: ReadonlySet<string> = new Set([
  'DOCKER_CONTINUATION_POOL_UNCONFIRMED',
  'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED',
]);
/** Holds of a published laptop that re-applying its own limits settles. */
const LEAF_REPAIRABLE: ReadonlySet<string> = new Set([
  'DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED',
  'DOCKER_RESOURCE_LEAF_ACK_MISSING',
]);
const REPAIR_SENTENCE = {
  'repair-pool':
    'The resource pool that every laptop shares no longer shows its approved limits, or nothing on record confirms ' +
    'them. The laptop is running and is not touched. Put the approved limits back: GET ' +
    '/api/company/employees/:id/docker-pool/status, then POST /api/company/employees/:id/docker-pool/repair.',
  repair:
    'This laptop no longer shows its approved resource limits, or nothing on record confirms them. It is running ' +
    'and is not touched. Put its approved limits back: POST /api/company/employees/:id/docker-continuation/repair.',
} as const;
const issued = new Set<DockerEmployeeContinuationPhase>([
  'office-issued',
  'pool-issued',
  'destination-issued',
  'start-issued',
  'resources-issued',
  'identity-issued',
  'provider-issued',
]);
export interface DockerContinuationFailure {
  readonly employeeId: string;
  readonly operationId: string;
  readonly phase: DockerEmployeeContinuationPhase;
  readonly causes: readonly {
    readonly errorType: string;
    readonly errno?: string;
    readonly locations: readonly { readonly module: string; readonly line: number; readonly column: number }[];
  }[];
}
/** Diagnostic DATA only: never include messages, commands, environment, paths or
 * credentials. Parse the stack tail because command failures can have huge messages. */
export function dockerContinuationFailureCauses(cause: unknown): DockerContinuationFailure['causes'] {
  const names = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'AggregateError',
    'ProviderDispatchUnconfirmedError',
    'MuxMutationRefusedError',
  ]);
  const codes = new Set([
    'E2BIG',
    'ETIMEDOUT',
    'ENOENT',
    'EACCES',
    'EPERM',
    'ENOTDIR',
    'EISDIR',
    'EIO',
    'ENOSPC',
    'ENOMEM',
    'EPIPE',
    'ECONNREFUSED',
    'ECONNRESET',
    'ERR_DLOPEN_FAILED',
  ]);
  const modules = new Set([
    'docker-employee-continuation',
    'docker-employee-engine',
    'docker-engine-command',
    'docker-employee-runtime',
    'docker-employee-session-provider',
    'docker-employee-store',
    'tmux-manager',
    'session',
    'server',
    'provider-launch-publication',
    'initial-launch-admission',
    'workspace-hooks',
    'workspace-hook-generation',
  ]);
  const seen = new Set<object>();
  const result: Array<DockerContinuationFailure['causes'][number]> = [];
  let next = cause;
  for (let depth = 0; depth < 3; depth++) {
    if (!next || typeof next !== 'object' || seen.has(next)) break;
    seen.add(next);
    try {
      const value = next as Record<string, unknown>;
      const errorType = typeof value.name === 'string' && names.has(value.name) ? value.name : 'OtherError';
      const errno = typeof value.code === 'string' && codes.has(value.code) ? value.code : undefined;
      const stack = typeof value.stack === 'string' ? value.stack.slice(-16384) : '';
      const locations: Array<{ module: string; line: number; column: number }> = [];
      for (const line of stack.split('\n').slice(-32)) {
        const match = /(?:^|\/)([A-Za-z0-9-]+)\.(?:js|ts):(\d{1,7}):(\d{1,7})\)?$/.exec(line);
        if (match && modules.has(match[1]!) && locations.length < 6)
          locations.push(Object.freeze({ module: match[1]!, line: Number(match[2]), column: Number(match[3]) }));
      }
      result.push(Object.freeze({ errorType, ...(errno ? { errno } : {}), locations: Object.freeze(locations) }));
      next = value.cause;
    } catch {
      result.push(Object.freeze({ errorType: 'UninspectableError', locations: Object.freeze([]) }));
      break;
    }
  }
  return Object.freeze(result);
}
export class DockerEmployeeContinuation {
  readonly #flights = new Map<string, string>();
  readonly #causes = new Map<string, unknown>();
  readonly #exits = new Map<string, DockerProviderExit>();
  constructor(
    private readonly store: DockerContinuationStore,
    private readonly engine: DockerContinuationEngine,
    private readonly provider: DockerContinuationProvider,
    private readonly identity: DockerContinuationIdentity,
    private readonly onFailure?: (failure: DockerContinuationFailure) => void,
    /**
     * Another operation of this employee's laptop that this service must not run beside: a rebuild or reprovision
     * in flight (`DockerAbsentReprovision.flightActive`). Between the stop of the old laptop and the retirement of
     * its record, a set-up step would act on a record whose laptop is being discarded. Denial DATA only.
     */
    private readonly otherOperation: (employeeId: string) => boolean = () => false
  ) {}
  /** Denial DATA for other owners of the same employee; never an admission. */
  flightActive(employeeId: string): boolean {
    return this.#flights.has(employeeId);
  }
  #require(
    subject: DockerContinuationSubject,
    authority: DockerContinuationAuthority,
    policy: DockerEmployeeResourcePolicy
  ): void {
    authority.require();
    const current = this.store.subject(subject.employeeId);
    if (
      !current ||
      current.employeeId !== subject.employeeId ||
      current.owner !== authority.owner ||
      current.owner !== subject.owner ||
      current.sessionId !== subject.sessionId ||
      current.sessionGeneration !== subject.sessionGeneration ||
      current.sourceDigest !== subject.sourceDigest
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    if (!isDeepStrictEqual(this.store.policy(subject.employeeId), policy)) refuse('DOCKER_CONTINUATION_POLICY_CHANGED');
  }
  #binding(row: DockerEmployeeContinuationRecord): DockerEmployeeBinding {
    if (!row.destination) refuse('DOCKER_CONTINUATION_DESTINATION_UNCONFIRMED');
    return DockerEmployeeBinding.parse({
      version: 1,
      operationId: row.request.operationId,
      credentialId: row.credentialId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
      containerId: row.destination.containerId,
      imageId: row.destination.imageId,
      originalDigest: dockerContinuationDigest(row.destination),
      policyDigest: dockerContinuationDigest(row.policy),
    });
  }
  #requireExisting(
    subject: DockerContinuationSubject,
    row: DockerEmployeeContinuationRecord,
    authority: DockerContinuationAuthority,
    policy: DockerEmployeeResourcePolicy
  ): void {
    authority.require();
    const actualRow = this.store.record(subject.employeeId);
    if (
      !actualRow ||
      (actualRow.phase !== row.phase && !(row.phase === 'provider-issued' && actualRow.phase === 'ready')) ||
      !isDeepStrictEqual({ ...actualRow, phase: row.phase }, row)
    )
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    const current = this.store.existingSubject(subject.employeeId, actualRow);
    if (
      !current ||
      current.employeeId !== subject.employeeId ||
      current.owner !== authority.owner ||
      current.owner !== subject.owner ||
      current.sessionId !== subject.sessionId ||
      current.sessionGeneration !== subject.sessionGeneration ||
      current.providerSourceDigest !== subject.providerSourceDigest
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    if (!isDeepStrictEqual(this.store.policy(subject.employeeId), policy)) refuse('DOCKER_CONTINUATION_POLICY_CHANGED');
  }
  /** The hold of a leaf writer that failed terminally, when that is where the operation stands. */
  #failedWriter(row: DockerEmployeeContinuationRecord): string | undefined {
    const leaf = row.tasks?.find((task) => task.role === 'leaf-helper');
    return row.phase === 'resources-issued' && leaf?.phase === 'failed' ? dockerFailedWriterHold(leaf) : undefined;
  }
  /** What a continued request can do about this operation's own pool writer:
   * `settle` one that started and is not recorded finished, `rerun` one that
   * is recorded failed and may be followed by another attempt. */
  #poolWriter(row: DockerEmployeeContinuationRecord): 'settle' | 'rerun' | undefined {
    const pool = row.tasks?.find((task) => task.role === 'pool-helper');
    if (row.phase !== 'pool-issued' || !pool) return undefined;
    if (pool.phase === 'start-issued' || pool.phase === 'running') return 'settle';
    return pool.phase === 'failed' && dockerFailedWriterHold(pool) === 'DOCKER_RESOURCE_HELPER_RETRY_PENDING'
      ? 'rerun'
      : undefined;
  }
  /** How a held, published laptop can be put right without stopping it. */
  #repairOffer(row: DockerEmployeeContinuationRecord, code: string | undefined): 'repair' | 'repair-pool' | undefined {
    if (row.version === 3 || !['provider-issued', 'ready'].includes(row.phase) || !code) return undefined;
    if (POOL_REPAIRABLE.has(code)) return 'repair-pool';
    return LEAF_REPAIRABLE.has(code) && this.engine.repairResources ? 'repair' : undefined;
  }
  #unissuedHelper(row: DockerEmployeeContinuationRecord): boolean {
    const task = (role: string) => row.tasks?.find((task) => task.role === role);
    if (row.phase === 'resources-issued')
      // A writer that failed on a lost read is terminal: its next attempt is
      // as unissued as a writer that was created and never started.
      return (
        task('leaf-helper')?.phase === 'created' || this.#failedWriter(row) === 'DOCKER_RESOURCE_HELPER_RETRY_PENDING'
      );
    if (row.phase === 'identity-issued') return task('identity-helper')?.phase === 'created';
    if (row.phase === 'pool-issued')
      return (
        task('anchor')?.phase === 'created' ||
        (task('anchor')?.phase === 'running' &&
          (task('pool-helper') === undefined ||
            task('pool-helper')?.phase === 'created' ||
            // A started writer is first settled, and a failed one followed by
            // its next attempt. Both only ever happen for a continued request.
            this.#poolWriter(row) !== undefined))
      );
    return false;
  }
  #result(
    row: DockerEmployeeContinuationRecord,
    held?: string,
    detail: { readonly message?: string; readonly repairable?: boolean } = {}
  ): DockerContinuationResult {
    // A terminally failed resource writer says more than the read that found
    // no enforcement: name it, with a sentence and what can be done next.
    const failed = held === 'DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED' ? this.#failedWriter(row) : undefined,
      code = failed ?? held,
      guidance =
        code?.startsWith('DOCKER_RESOURCE_HELPER_') || code === 'DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE'
          ? dockerRecoveryGuidance(code)
          : undefined;
    // The last exit seen for this operation stays attached to its hold after
    // the laptop's bounded copy of that evidence is gone.
    const exit = code === 'DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED' ? this.#exits.get(row.request.operationId) : undefined;
    const repair = this.#repairOffer(row, code);
    const allowed: DockerContinuationResult['allowedActions'] =
      row.version === 3
        ? ['observe']
        : code === 'DOCKER_EPHEMERAL_PREPARATION_REQUIRED' || detail.repairable || this.#unissuedHelper(row)
          ? ['observe', 'continue']
          : repair
            ? ['observe', repair]
            : code || row.phase === 'ready' || issued.has(row.phase)
              ? ['observe']
              : ['observe', 'continue'];
    return {
      operationId: row.request.operationId,
      phase: row.phase,
      state: code ? 'held' : row.phase === 'ready' ? 'ready' : 'pending',
      allowedActions:
        guidance && row.version !== 3
          ? [
              'observe',
              ...(guidance.allowedActions.includes('retry') ? (['continue'] as const) : []),
              ...guidance.allowedActions,
            ]
          : allowed,
      ...(code ? { code } : {}),
      ...(guidance
        ? { message: guidance.message }
        : detail.message
          ? { message: detail.message }
          : repair
            ? { message: REPAIR_SENTENCE[repair] }
            : {}),
      ...(exit ? { providerExit: exit } : {}),
    };
  }
  #providerExit(row: DockerEmployeeContinuationRecord, provider: DockerContainerObservation['provider']): void {
    const operationId = row.request.operationId;
    if (provider.kind === 'running') this.#exits.delete(operationId);
    if (provider.kind !== 'exited') return;
    this.#exits.delete(operationId);
    if (this.#exits.size >= 64) this.#exits.delete(this.#exits.keys().next().value!);
    this.#exits.set(operationId, provider.exit);
  }
  async #phase(
    row: DockerEmployeeContinuationRecord,
    phase: DockerEmployeeContinuationPhase,
    current: () => void,
    data: Partial<Pick<DockerEmployeeContinuationRecord, 'pool' | 'destination'>> = {}
  ): Promise<DockerEmployeeContinuationRecord> {
    current();
    const next = DockerEmployeeContinuationRecord.parse({ ...row, ...data, phase });
    await this.store.replace(row, next, current);
    current();
    return next;
  }
  #legacyImage(original: DockerEmployeeOriginal, retained: DockerEmployeeContinuationRecord | undefined, current: () => void) {
    if (retained && retained.version !== 3 && ['identity-ready', 'identity-issued'].includes(retained.phase) &&
        this.engine.preparedIdentityImage) {
      if (!isDeepStrictEqual(original, retained.original)) refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
      return this.engine.preparedIdentityImage(retained, current);
    }
    return this.engine.image(original);
  }
  /** A laptop source that a rebuild made is created from the laptop image of that day and is never started until
   * its set-up begins. An office that has since been given another laptop image cannot build on it: the image pair
   * is refused, rightly, because the old image is not an ancestor of the new one (or is no longer accepted at all).
   * That refusal names an image and no way out, and the laptop stayed unusable for as long as nobody guessed the
   * remedy. When the refused source is exactly that unused source, the refusal says so. Nothing is relaxed: the
   * laptop is still not built, and the code names the one step that helps, which replaces a container that never
   * ran. Every other refusal of the image pair is passed on unchanged. */
  #outdatedSource(
    employeeId: string,
    seen: { original: DockerEmployeeOriginal; state: 'running' | 'stopped' },
    error: unknown
  ): never {
    if (
      error instanceof DockerEmployeeContinuationError &&
      ['DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED', 'DOCKER_CONTINUATION_SOURCE_IMAGE_UNSUPPORTED'].includes(error.code) &&
      seen.state === 'stopped' &&
      this.store.unusedSource?.(employeeId)?.containerId === seen.original.containerId
    )
      throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED', 409, { cause: error });
    throw error;
  }
  async #source(
    subject: DockerContinuationSubject,
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<void> {
    current();
    // Published v1/v2 reads qualify the immutable current destination. The
    // historical source is correlation, not a required surviving container.
    if (row.version !== 3 && ['provider-issued', 'ready'].includes(row.phase) && this.engine.existingImage) {
      const image = DockerEmployeeWorkerImage.parse(await this.engine.existingImage(row, current));
      current();
      if (!isDeepStrictEqual(image, row.workerImage)) refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
      return;
    }
    if (row.version === 3 && !this.engine.observePlanReplacementSource)
      refuse('DOCKER_PLAN_REPLACEMENT_OBSERVER_UNAVAILABLE');
    const observation =
      row.version === 3
        ? await this.engine.observePlanReplacementSource!(row, current)
        : await this.engine.observeSource(subject, row.original.containerId, row.original);
    current();
    if (
      observation.state !== 'stopped' ||
      !isDeepStrictEqual(DockerEmployeeOriginal.parse(observation.original), row.original)
    )
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    const published = ['provider-issued', 'ready'].includes(row.phase);
    if (row.version === 3 && !this.engine.existingImage && !this.engine.imageForPlanReplacement)
      refuse('DOCKER_PLAN_REPLACEMENT_IMAGE_UNAVAILABLE');
    const workerImage = DockerEmployeeWorkerImage.parse(
      published && this.engine.existingImage
        ? await this.engine.existingImage(row, current)
        : row.version === 3
          ? await this.engine.imageForPlanReplacement!(row, current)
          : await this.#legacyImage(row.original, row, current)
    );
    current();
    if (!isDeepStrictEqual(workerImage, row.workerImage)) refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
  }
  async #pool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<DockerEmployeePool | null> {
    current();
    const raw = await this.engine.observePool(row);
    current();
    const pool = raw ? DockerEmployeePool.parse(raw) : null;
    if (
      pool &&
      (pool.policyDigest !== dockerContinuationDigest(row.policy.pool) ||
        (row.pool && !isDeepStrictEqual(pool, row.pool)))
    )
      refuse('DOCKER_CONTINUATION_POOL_CHANGED');
    return pool;
  }
  async #destination(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<DockerContainerObservation | null> {
    current();
    const seen = await this.engine.observeDestination(row);
    current();
    if (!seen) return null;
    const destination = DockerEmployeeOriginal.parse(seen.original);
    if (
      destination.containerId === row.original.containerId ||
      destination.imageId !== row.workerImage.imageId ||
      destination.employeeId !== row.employeeId ||
      destination.sessionId !== row.request.sessionId ||
      !isDeepStrictEqual(destination.home, row.original.home) ||
      (row.version !== 3 && destination.storageDigest !== row.original.storageDigest) ||
      (row.destination && !isDeepStrictEqual(destination, row.destination))
    )
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    if (seen.resources) DockerEmployeeResourcePolicy.parse(seen.resources);
    return seen;
  }
  async selection(employeeId: string, authority: DockerContinuationAuthority) {
    authority.require();
    const retained = this.store.record(employeeId);
    if (retained && retained.version !== 3 && ['provider-issued', 'ready'].includes(retained.phase)) {
      const subject = this.store.existingSubject(employeeId, retained);
      if (!subject || subject.owner !== authority.owner || retained.owner !== authority.owner)
        refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
      const current = () => this.#requireExisting(subject, retained, authority, retained.policy);
      current();
      const operation = await this.observe(employeeId, retained.request.operationId, authority);
      current();
      return {
        destinationImageId: retained.workerImage.imageId,
        sessionId: subject.sessionId,
        sessionGeneration: subject.sessionGeneration,
        sourceDigest: subject.sourceDigest,
        containerId: retained.original.containerId,
        imageId: retained.original.imageId,
        // Historical ORIGINAL state was not observed by this provider read.
        state: 'unknown' as const,
        operationId: retained.request.operationId,
        originalRequest: retained.request,
        operation,
      };
    }
    const subject = this.store.subject(employeeId);
    if (!subject || subject.owner !== authority.owner) refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    const legacy = retained?.version === 3 ? undefined : retained?.original;
    const seen = await this.engine.observeSource(subject, legacy?.containerId, legacy);
    authority.require();
    const current = this.store.subject(employeeId);
    if (
      !current ||
      current.sessionId !== subject.sessionId ||
      current.sessionGeneration !== subject.sessionGeneration ||
      current.sourceDigest !== subject.sourceDigest ||
      seen.original.employeeId !== employeeId ||
      seen.original.sessionId !== subject.sessionId
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    const workerImage = DockerEmployeeWorkerImage.parse(
      await this.#legacyImage(seen.original, retained, () => authority.require()).catch((error: unknown) =>
        this.#outdatedSource(employeeId, seen, error)
      )
    );
    authority.require();
    return {
      destinationImageId: workerImage.imageId,
      sessionId: subject.sessionId,
      sessionGeneration: subject.sessionGeneration,
      sourceDigest: subject.sourceDigest,
      containerId: seen.original.containerId,
      imageId: seen.original.imageId,
      state: seen.state,
      operationId: this.store.record(employeeId)?.request.operationId ?? null,
      originalRequest: this.store.record(employeeId)?.request ?? null,
      operation: this.store.record(employeeId)
        ? await this.observe(employeeId, this.store.record(employeeId)!.request.operationId, authority)
        : null,
    };
  }
  async begin(
    employeeId: string,
    unchecked: unknown,
    authority: DockerContinuationAuthority
  ): Promise<DockerContinuationResult> {
    const request = DockerEmployeeContinuationRequest.parse(unchecked);
    authority.require();
    if (this.store.record(employeeId)?.version === 3) refuse('DOCKER_PLAN_REPLACEMENT_PRIVATE_OWNER_REQUIRED');
    const subject = this.store.subject(employeeId);
    if (
      !subject ||
      subject.owner !== authority.owner ||
      subject.sessionId !== request.sessionId ||
      subject.sessionGeneration !== request.sessionGeneration
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    const policy = DockerEmployeeResourcePolicy.parse(this.store.policy(employeeId));
    if (dockerContinuationDigest(policy) !== request.expectedPolicyDigest) refuse('DOCKER_CONTINUATION_POLICY_CHANGED');
    const current = () => this.#require(subject, authority, policy);
    current();
    if (request.enterOffice) authority.requireOffice();
    else if (subject.onVacation || subject.desiredRunning === false) refuse('DOCKER_CONTINUATION_OFFICE_REQUIRED');
    if (this.#flights.has(employeeId) || this.otherOperation(employeeId)) refuse('DOCKER_CONTINUATION_BUSY');
    this.#flights.set(employeeId, request.operationId);
    try {
      let row = this.store.record(employeeId);
      if (row) {
        if (
          !isDeepStrictEqual(row.request, request) ||
          row.sourceDigest !== subject.sourceDigest ||
          row.owner !== subject.owner
        )
          refuse('DOCKER_CONTINUATION_ORIGINAL_HELD');
      } else {
        const seen = await this.engine.observeSource(subject, request.containerId);
        current();
        const original = DockerEmployeeOriginal.parse(seen.original);
        if (
          seen.state !== 'stopped' ||
          original.containerId !== request.containerId ||
          original.imageId !== request.imageId ||
          original.employeeId !== employeeId ||
          original.sessionId !== subject.sessionId
        )
          refuse('DOCKER_CONTINUATION_STOPPED_ORIGINAL_REQUIRED');
        const workerImage = DockerEmployeeWorkerImage.parse(
          await this.engine.image(original).catch((error: unknown) => this.#outdatedSource(employeeId, seen, error))
        );
        current();
        if (
          workerImage.sourceImageId !== original.imageId ||
          workerImage.imageId !== request.expectedDestinationImageId
        )
          refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
        await this.engine.validateCapabilities(original, policy);
        current();
        row = DockerEmployeeContinuationRecord.parse({
          version: 2,
          purpose: 'docker-employee-continuation-v2',
          employeeId,
          owner: subject.owner,
          request,
          sourceDigest: subject.sourceDigest,
          providerSourceDigest: subject.providerSourceDigest,
          original,
          workerImage,
          policy,
          credentialId: randomUUID(),
          phase: 'staged',
        });
        await this.store.replace(undefined, row, current);
        current();
      }
      return await this.#advance(subject, row, authority, current, 'advance');
    } finally {
      this.#flights.delete(employeeId);
    }
  }
  /** Re-applies the already approved limits of one published laptop in place
   * and reads it again. The laptop keeps running, nothing about its launch,
   * binding or policy is touched, and the shared pool is not written here. */
  async repair(
    employeeId: string,
    operationId: string,
    authority: DockerContinuationAuthority
  ): Promise<DockerContinuationResult> {
    return this.#existing(employeeId, operationId, authority, 'repair');
  }
  async observe(
    employeeId: string,
    operationId: string,
    authority: DockerContinuationAuthority
  ): Promise<DockerContinuationResult> {
    return this.#existing(employeeId, operationId, authority, 'observe');
  }
  async #existing(
    employeeId: string,
    operationId: string,
    authority: DockerContinuationAuthority,
    mode: 'observe' | 'repair'
  ): Promise<DockerContinuationResult> {
    authority.require();
    const row = this.store.record(employeeId),
      existing = row && ['provider-issued', 'ready'].includes(row.phase),
      subject = row && existing ? this.store.existingSubject(employeeId, row) : this.store.subject(employeeId);
    if (!row || row.request.operationId !== operationId || row.owner !== authority.owner)
      refuse('DOCKER_CONTINUATION_UNKNOWN_OPERATION');
    if (!subject) refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    const current = existing
      ? () => this.#requireExisting(subject, row, authority, row.policy)
      : () => this.#require(subject, authority, row.policy);
    if (
      (!existing && row.sourceDigest !== subject.sourceDigest) ||
      row.request.sessionId !== subject.sessionId ||
      row.request.sessionGeneration !== subject.sessionGeneration
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    if (mode === 'repair' && (!existing || row.version === 3 || !this.engine.repairResources))
      refuse('DOCKER_RESOURCE_REPAIR_SCOPE_UNSUPPORTED');
    if (this.#flights.has(employeeId)) {
      if (mode === 'repair') refuse('DOCKER_CONTINUATION_BUSY');
      return this.#result(row);
    }
    if (this.otherOperation(employeeId)) refuse('DOCKER_CONTINUATION_BUSY');
    this.#flights.set(employeeId, operationId);
    try {
      return await this.#advance(subject, row, authority, current, mode);
    } finally {
      this.#flights.delete(employeeId);
    }
  }
  #refresh(row: DockerEmployeeContinuationRecord, current: () => void): DockerEmployeeContinuationRecord {
    current();
    const actual = this.store.record(row.employeeId);
    if (
      !actual ||
      dockerContinuationDigest({ ...actual, tasks: undefined, ephemeralRestoration: undefined }) !==
        dockerContinuationDigest({ ...row, tasks: undefined, ephemeralRestoration: undefined })
    )
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    return actual;
  }
  async #advance(
    subject: DockerContinuationSubject,
    initial: DockerEmployeeContinuationRecord,
    authority: DockerContinuationAuthority,
    requireCurrent: () => void,
    mode: 'observe' | 'advance' | 'repair'
  ): Promise<DockerContinuationResult> {
    // `advance` issues the next step of a laptop set-up. `repair` issues
    // nothing of a set-up: it only re-applies approved limits to a laptop
    // that is already published. `observe` issues nothing at all.
    const effects = mode === 'advance';
    let row = initial,
      repaired = false;
    const current = () => {
      requireCurrent();
      this.engine.assertPreparationCurrent?.(row);
    };
    try {
      for (let steps = 0; steps < 24; steps++) {
        current();
        row = this.#refresh(row, current);
        await this.#source(subject, row, current);
        const employee = this.store.subject(subject.employeeId)!;
        if (row.phase === 'staged') {
          if (!effects) return this.#result(row);
          if (row.request.enterOffice) {
            authority.requireOffice();
            row = await this.#phase(row, 'office-issued', current);
            await this.store.enterOffice(subject, () => {
              current();
              authority.requireOffice();
            });
          } else row = await this.#phase(row, 'office-ready', current);
          continue;
        }
        if (row.phase === 'office-issued') {
          if (employee.onVacation || employee.desiredRunning !== true)
            return this.#result(row, 'DOCKER_CONTINUATION_OFFICE_UNCONFIRMED');
          row = await this.#phase(row, 'office-ready', current);
          continue;
        }
        if (employee.onVacation || employee.desiredRunning !== true)
          return this.#result(row, 'DOCKER_CONTINUATION_OFFICE_CHANGED');
        if (this.engine.observeStorage) {
          let storage = await this.engine.observeStorage(row);
          current();
          if (storage !== 'ready') {
            if (!effects)
              return this.#result(
                row,
                storage === 'ephemeral-unissued'
                  ? 'DOCKER_EPHEMERAL_PREPARATION_REQUIRED'
                  : storage === 'unknown'
                    ? 'DOCKER_CONTINUATION_STORAGE_UNCONFIRMED'
                    : undefined
              );
            await this.engine.prepareStorage!(row, current);
            row = this.#refresh(row, current);
            storage = await this.engine.observeStorage(row);
            current();
            if (storage !== 'ready') return this.#result(row, 'DOCKER_CONTINUATION_STORAGE_UNCONFIRMED');
          }
        }
        if (row.phase === 'office-ready') {
          if (!effects) return this.#result(row);
          row = await this.#phase(row, 'pool-issued', current);
          await this.engine.preparePool(row, current);
          continue;
        }
        // A started pool writer of this operation that exited with an error is
        // recorded as failed first: it acknowledged nothing, and the read
        // below would otherwise wait on it for good.
        if (
          effects &&
          initial.phase === 'pool-issued' &&
          row.phase === 'pool-issued' &&
          this.engine.settlePoolWriter &&
          this.#poolWriter(row) === 'settle'
        ) {
          await this.engine.settlePoolWriter(row, current);
          row = this.#refresh(row, current);
        }
        let pool = await this.#pool(row, current);
        if (!pool && effects && initial.phase === 'pool-issued' && this.#unissuedHelper(row)) {
          await this.engine.preparePool(row, current);
          row = this.#refresh(row, current);
          pool = await this.#pool(row, current);
        }
        if (!pool) return this.#result(row, 'DOCKER_CONTINUATION_POOL_UNCONFIRMED');
        if (row.phase === 'pool-issued') {
          row = await this.#phase(row, 'pool-ready', current, { pool });
          continue;
        }
        if (!row.pool) refuse('DOCKER_CONTINUATION_POOL_UNCONFIRMED');
        if (row.phase === 'pool-ready') {
          if (!effects) return this.#result(row);
          row = await this.#phase(row, 'destination-issued', current);
          await this.engine.createDestination(row, current);
          continue;
        }
        // A started resource writer that exited with an error is recorded as
        // failed first. The read below would find it unacknowledged for good.
        if (
          effects &&
          initial.phase === 'resources-issued' &&
          row.phase === 'resources-issued' &&
          this.engine.settleResourceWriter &&
          ['start-issued', 'running'].includes(row.tasks?.find((task) => task.role === 'leaf-helper')?.phase ?? '')
        ) {
          await this.engine.settleResourceWriter(row, current);
          row = this.#refresh(row, current);
        }
        // The one effect of a repair: this published laptop's own approved
        // limits, written again in place once the shared pool is confirmed.
        if (
          mode === 'repair' &&
          !repaired &&
          row.version !== 3 &&
          ['provider-issued', 'ready'].includes(row.phase) &&
          this.engine.repairResources
        ) {
          repaired = true;
          await this.engine.repairResources(row, current);
          current();
        }
        let destination = await this.#destination(row, current);
        if (
          destination &&
          !destination.resources &&
          effects &&
          initial.phase === 'resources-issued' &&
          this.#unissuedHelper(row)
        ) {
          await this.engine.configureResources(row, current);
          row = this.#refresh(row, current);
          destination = await this.#destination(row, current);
        }
        if (!destination) return this.#result(row, 'DOCKER_CONTINUATION_DESTINATION_UNCONFIRMED');
        if (row.phase === 'destination-issued') {
          if (destination.state !== 'stopped' || destination.provider.kind !== 'absent')
            return this.#result(row, 'DOCKER_CONTINUATION_DESTINATION_NOT_STOPPED');
          row = await this.#phase(row, 'destination-ready', current, { destination: destination.original });
          continue;
        }
        if (!row.destination) refuse('DOCKER_CONTINUATION_DESTINATION_UNCONFIRMED');
        if (row.phase === 'destination-ready') {
          if (!effects) return this.#result(row);
          if (destination.state !== 'stopped' || destination.provider.kind !== 'absent')
            return this.#result(row, 'DOCKER_CONTINUATION_DESTINATION_NOT_STOPPED');
          row = await this.#phase(row, 'start-issued', current);
          await this.engine.start(row, current);
          continue;
        }
        if (row.phase === 'start-issued') {
          if (destination.state !== 'running') return this.#result(row, 'DOCKER_CONTINUATION_START_UNCONFIRMED');
          row = await this.#phase(row, 'container-running', current);
          continue;
        }
        if (destination.state !== 'running') return this.#result(row, 'DOCKER_CONTINUATION_CONTAINER_STOPPED');
        if (row.phase === 'container-running') {
          if (!effects) return this.#result(row);
          if (destination.provider.kind !== 'absent') return this.#result(row, 'DOCKER_CONTINUATION_FOREIGN_PROVIDER');
          row = await this.#phase(row, 'resources-issued', current);
          await this.engine.configureResources(row, current);
          continue;
        }
        if (
          !isDeepStrictEqual(destination.resources, row.policy) &&
          !(
            row.version !== 3 &&
            ['provider-issued', 'ready'].includes(row.phase) &&
            this.engine.existingResourcePolicyCurrent?.(row, destination.resources)
          )
        )
          return this.#result(row, 'DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED');
        if (row.phase === 'resources-issued') {
          row = await this.#phase(row, 'resources-ready', current);
          continue;
        }
        if (row.phase === 'resources-ready') {
          if (!effects) return this.#result(row);
          if (destination.provider.kind !== 'absent') return this.#result(row, 'DOCKER_CONTINUATION_FOREIGN_PROVIDER');
          const token = this.identity.issue(row, current);
          current();
          row = await this.#phase(row, 'identity-issued', current);
          await this.engine.provisionIdentity(row, token, current);
          continue;
        }
        if (row.phase === 'identity-issued') {
          const token = this.identity.issue(row, current);
          if (effects && initial.phase === 'identity-issued' && this.#unissuedHelper(row)) {
            await this.engine.provisionIdentity(row, token, current);
            row = this.#refresh(row, current);
            continue;
          }
          if (destination.credentialDigest !== createHash('sha256').update(token).digest('hex'))
            return this.#result(row, 'DOCKER_CONTINUATION_IDENTITY_UNCONFIRMED');
          row = await this.#phase(row, 'identity-ready', current);
          continue;
        }
        if (row.phase === 'identity-ready') {
          if (!effects) return this.#result(row);
          if (destination.provider.kind !== 'absent') return this.#result(row, 'DOCKER_CONTINUATION_FOREIGN_PROVIDER');
          // The launch below is recorded as issued before it runs and is never
          // repeated. Anything that can be known to fail it is refused here,
          // while this step can still be continued.
          const refusal = await this.provider.preflight?.(
            row,
            { modelSocketMounted: destination.modelSocketMounted },
            current
          );
          current();
          if (refusal) return this.#result(row, refusal.code, { message: refusal.message, repairable: true });
          const binding = this.#binding(row);
          await this.store.bind(row, binding, current);
          current();
          row = await this.#phase(row, 'provider-issued', current);
          await this.provider.launch(row, binding, current);
          continue;
        }
        if (row.phase === 'provider-issued' || row.phase === 'ready') {
          this.#providerExit(row, destination.provider);
          if (
            destination.provider.kind !== 'running' ||
            destination.provider.operationId !== row.request.operationId ||
            destination.provider.sessionId !== row.request.sessionId
          )
            return this.#result(row, 'DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED');
          if (row.phase !== 'ready') row = await this.#phase(row, 'ready', current);
          return this.#result(row);
        }
      }
      return this.#result(row);
    } catch (cause) {
      if (!this.#causes.has(row.request.operationId) && this.#causes.size < 64) {
        this.#causes.set(row.request.operationId, cause);
        try {
          this.onFailure?.(
            Object.freeze({
              employeeId: row.employeeId,
              operationId: row.request.operationId,
              phase: row.phase,
              causes: dockerContinuationFailureCauses(cause),
            })
          );
        } catch {
          /* Reporting cannot change the retained failure or authorize a retry. */
        }
      }
      try {
        row = this.#refresh(row, current);
      } catch {
        /* A stale/refused refresh cannot replace the original actual cause. */
      }
      // A pass that may issue no Engine effect only reads the laptop (and records what it saw), so an unnamed failure
      // there is a failed read, such as a late or unparsable Engine answer on a busy box, never an effect whose
      // outcome is unknown. The next read decides again.
      return this.#result(
        row,
        cause instanceof DockerEmployeeContinuationError
          ? cause.code
          : mode !== 'observe'
            ? 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED'
            : 'DOCKER_CONTINUATION_UNCONFIRMED'
      );
    }
  }
}
