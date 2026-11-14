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
  /** Independent office permission: recovery permission cannot end vacation. */
  requireOffice(): void;
}
export interface DockerContinuationSubject {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly owner: string | undefined;
  readonly sourceDigest: string;
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
    | { kind: 'unknown' };
  readonly credentialDigest: string | null;
}
export interface DockerContinuationEngine {
  image(original: DockerEmployeeOriginal): Promise<DockerEmployeeWorkerImage>;
  observeSource(subject: DockerContinuationSubject, containerId?: string): Promise<DockerSourceObservation>;
  validateCapabilities(original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void>;
  /** Shared aggregate pool has its own retained controller owner; prepare is never a status action. */
  prepareStorage?(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void>;
  observeStorage?(row: DockerEmployeeContinuationRecord): Promise<'ready' | 'unissued' | 'unknown'>;
  preparePool(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null>;
  /** Only the captured original's inspected immutable config/home; no HTTP command/mount/path. */
  createDestination(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null>;
  start(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  configureResources(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  provisionIdentity(row: DockerEmployeeContinuationRecord, token: string, requireCurrent: () => void): Promise<void>;
}
export interface DockerContinuationStore {
  subject(employeeId: string): DockerContinuationSubject | undefined;
  /** Current owner-approved policy; request parameters carry only its expected digest. */
  policy(employeeId: string): DockerEmployeeResourcePolicy;
  record(employeeId: string): DockerEmployeeContinuationRecord | undefined;
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
}
export interface DockerContinuationIdentity {
  issue(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): string;
}
export interface DockerContinuationResult {
  operationId: string;
  phase: DockerEmployeeContinuationPhase;
  state: 'ready' | 'pending' | 'held';
  allowedActions: readonly ('observe' | 'continue')[];
  code?: string;
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
const issued = new Set<DockerEmployeeContinuationPhase>([
  'office-issued',
  'pool-issued',
  'destination-issued',
  'start-issued',
  'resources-issued',
  'identity-issued',
  'provider-issued',
]);
export class DockerEmployeeContinuation {
  readonly #flights = new Map<string, string>();
  readonly #causes = new Map<string, unknown>();
  constructor(
    private readonly store: DockerContinuationStore,
    private readonly engine: DockerContinuationEngine,
    private readonly provider: DockerContinuationProvider,
    private readonly identity: DockerContinuationIdentity
  ) {}
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
  #unissuedHelper(row: DockerEmployeeContinuationRecord): boolean {
    const task = (role: string) => row.tasks?.find((task) => task.role === role);
    if (row.phase === 'resources-issued') return task('leaf-helper')?.phase === 'created';
    if (row.phase === 'identity-issued') return task('identity-helper')?.phase === 'created';
    if (row.phase === 'pool-issued')
      return (
        task('anchor')?.phase === 'created' ||
        (task('anchor')?.phase === 'running' &&
          (task('pool-helper') === undefined || task('pool-helper')?.phase === 'created'))
      );
    return false;
  }
  #result(row: DockerEmployeeContinuationRecord, code?: string): DockerContinuationResult {
    return {
      operationId: row.request.operationId,
      phase: row.phase,
      state: code ? 'held' : row.phase === 'ready' ? 'ready' : 'pending',
      allowedActions: this.#unissuedHelper(row)
        ? ['observe', 'continue']
        : code || row.phase === 'ready' || issued.has(row.phase)
          ? ['observe']
          : ['observe', 'continue'],
      ...(code ? { code } : {}),
    };
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
  async #source(
    subject: DockerContinuationSubject,
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<void> {
    current();
    const observation = await this.engine.observeSource(subject, row.original.containerId);
    current();
    if (
      observation.state !== 'stopped' ||
      !isDeepStrictEqual(DockerEmployeeOriginal.parse(observation.original), row.original)
    )
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    const workerImage = DockerEmployeeWorkerImage.parse(await this.engine.image(row.original));
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
      destination.storageDigest !== row.original.storageDigest ||
      (row.destination && !isDeepStrictEqual(destination, row.destination))
    )
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    if (seen.resources) DockerEmployeeResourcePolicy.parse(seen.resources);
    return seen;
  }
  async selection(employeeId: string, authority: DockerContinuationAuthority) {
    authority.require();
    const subject = this.store.subject(employeeId);
    if (!subject || subject.owner !== authority.owner) refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    const seen = await this.engine.observeSource(subject);
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
    const workerImage = DockerEmployeeWorkerImage.parse(await this.engine.image(seen.original));
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
    if (this.#flights.has(employeeId)) refuse('DOCKER_CONTINUATION_BUSY');
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
        const workerImage = DockerEmployeeWorkerImage.parse(await this.engine.image(original));
        current();
        if (
          workerImage.sourceImageId !== original.imageId ||
          workerImage.imageId !== request.expectedDestinationImageId
        )
          refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
        await this.engine.validateCapabilities(original, policy);
        current();
        row = DockerEmployeeContinuationRecord.parse({
          version: 1,
          purpose: 'docker-employee-continuation-v1',
          employeeId,
          owner: subject.owner,
          request,
          sourceDigest: subject.sourceDigest,
          original,
          workerImage,
          policy,
          credentialId: randomUUID(),
          phase: 'staged',
        });
        await this.store.replace(undefined, row, current);
        current();
      }
      return await this.#advance(subject, row, authority, current, true);
    } finally {
      this.#flights.delete(employeeId);
    }
  }
  async observe(
    employeeId: string,
    operationId: string,
    authority: DockerContinuationAuthority
  ): Promise<DockerContinuationResult> {
    authority.require();
    const row = this.store.record(employeeId),
      subject = this.store.subject(employeeId);
    if (!row || !subject || row.request.operationId !== operationId || row.owner !== authority.owner)
      refuse('DOCKER_CONTINUATION_UNKNOWN_OPERATION');
    const current = () => this.#require(subject, authority, row.policy);
    if (
      row.sourceDigest !== subject.sourceDigest ||
      row.request.sessionId !== subject.sessionId ||
      row.request.sessionGeneration !== subject.sessionGeneration
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    if (this.#flights.has(employeeId)) return this.#result(row);
    this.#flights.set(employeeId, operationId);
    try {
      return await this.#advance(subject, row, authority, current, false);
    } finally {
      this.#flights.delete(employeeId);
    }
  }
  #refresh(row: DockerEmployeeContinuationRecord, current: () => void): DockerEmployeeContinuationRecord {
    current();
    const actual = this.store.record(row.employeeId);
    if (
      !actual ||
      dockerContinuationDigest({ ...actual, tasks: undefined }) !==
        dockerContinuationDigest({ ...row, tasks: undefined })
    )
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    return actual;
  }
  async #advance(
    subject: DockerContinuationSubject,
    initial: DockerEmployeeContinuationRecord,
    authority: DockerContinuationAuthority,
    current: () => void,
    effects: boolean
  ): Promise<DockerContinuationResult> {
    let row = initial;
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
              return this.#result(row, storage === 'unknown' ? 'DOCKER_CONTINUATION_STORAGE_UNCONFIRMED' : undefined);
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
        if (!isDeepStrictEqual(destination.resources, row.policy))
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
          const binding = this.#binding(row);
          await this.store.bind(row, binding, current);
          current();
          row = await this.#phase(row, 'provider-issued', current);
          await this.provider.launch(row, binding, current);
          continue;
        }
        if (row.phase === 'provider-issued' || row.phase === 'ready') {
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
      if (!this.#causes.has(row.request.operationId) && this.#causes.size < 64)
        this.#causes.set(row.request.operationId, cause);
      try {
        row = this.#refresh(row, current);
      } catch {
        /* A stale/refused refresh cannot replace the original actual cause. */
      }
      return this.#result(
        row,
        cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED'
      );
    }
  }
}
