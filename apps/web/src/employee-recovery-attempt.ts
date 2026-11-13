/** Original application recovery admission. Only this owner calls the actual
 * canonical writer; neither a callback nor a loaded row can arm dispatch. */
import { CompanyService } from './company-service.js';
import { lstat } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { CompanyStore } from './company-store.js';
import { PlanMoves, type PlanViewerReconnectLease } from './plan-move.js';
import { ResourceOwnerAuthority, type RamEmployeeRecoveryContext } from './resource-owner-authority.js';
import { Session } from './session.js';
import { OriginalStoppedRecovery } from './resource-native-client.js';
import type { CompanyState } from './company-types.js';
import {
  EmployeeRecoveryOperation,
  recoveryDataDigest,
  sameRecoveryOperation,
  type EmployeeRecoveryApproval,
} from './employee-recovery-operation.js';

const MINT = Symbol('original-employee-recovery-attempt');
export class EmployeeRecoveryPreflightError extends Error {
  constructor(
    readonly reason: 'unsupported-provider' | 'no-native-channel',
    cause?: unknown
  ) {
    super(
      reason === 'unsupported-provider'
        ? 'This provider does not support targeted native recovery.'
        : 'The native recovery channel is unavailable.',
      { cause }
    );
  }
}
export interface EmployeeRecoverySubject {
  readonly employeeId: string;
  readonly owner: string | undefined;
  readonly session: Session;
  readonly resourceDigest: string;
  requireTarget(state?: CompanyState): void;
  requireRetained(state?: CompanyState): void;
  require(state?: CompanyState): void;
}

type RecoveryChannel = Readonly<{ path: string; dev: bigint; ino: bigint; mode: bigint; uid: bigint }>;
async function captureRecoveryChannel(
  subject: EmployeeRecoverySubject,
  authority: ResourceOwnerAuthority,
  context: RamEmployeeRecoveryContext,
  channel?: string
): Promise<RecoveryChannel> {
  if (!Session.prototype.employeeRecoverySelectors.call(subject.session).nativeTarget)
    throw new EmployeeRecoveryPreflightError('unsupported-provider');
  if (!channel || !Session.prototype.employeeRecoveryEndpointCompatible.call(subject.session, channel))
    throw new EmployeeRecoveryPreflightError('no-native-channel');
  const entry = await lstat(channel, { bigint: true }).catch((cause) => {
    ResourceOwnerAuthority.prototype.assertRecoveryAuthentication.call(authority, context);
    subject.require();
    throw new EmployeeRecoveryPreflightError('no-native-channel', cause);
  });
  ResourceOwnerAuthority.prototype.assertRecoveryAuthentication.call(authority, context);
  subject.require();
  if (!entry.isSocket() || entry.uid !== BigInt(process.getuid!()) || (entry.mode & 0o077n) !== 0n)
    throw new EmployeeRecoveryPreflightError('no-native-channel');
  return Object.freeze({ path: channel, dev: entry.dev, ino: entry.ino, mode: entry.mode, uid: entry.uid });
}

type Phase = 'staged' | 'armed' | 'observed' | 'held' | 'refused';
function held(): never {
  throw Error('Original employee recovery admission is unavailable; inspect the retained operation');
}

export class EmployeeRecoveryAttempt {
  readonly #company: CompanyService;
  readonly #authority: ResourceOwnerAuthority;
  readonly #context: RamEmployeeRecoveryContext;
  readonly #subject: EmployeeRecoverySubject;
  readonly #parent: EmployeeRecoveryAttempt | undefined;
  #component: EmployeeRecoveryAttempt | undefined;
  #componentInitial = false;
  #channel: RecoveryChannel | undefined;
  #origin: 'admitted' | 'loaded-observe' = 'admitted';
  #lease: PlanViewerReconnectLease | undefined;
  #phase: Phase = 'staged';
  #issued = false;
  #publication: 'unacknowledged' | 'acknowledged' = 'unacknowledged';
  #row: EmployeeRecoveryOperation | undefined;
  #planned: EmployeeRecoveryOperation | undefined;
  #observationPublication: { before: EmployeeRecoveryOperation; attempted: EmployeeRecoveryOperation } | undefined;
  #stoppedProof: OriginalStoppedRecovery | undefined;
  #stoppedProjection:
    | { stage: 'intent' | 'terminal'; before: EmployeeRecoveryOperation; attempted: EmployeeRecoveryOperation }
    | undefined;
  #stoppedIntentKnown = false;
  #stoppedTerminalKnown = false;
  #stoppedAt: number | undefined;
  #stoppedInProgress = false;
  constructor(
    token: symbol,
    company: CompanyService,
    authority: ResourceOwnerAuthority,
    context: RamEmployeeRecoveryContext,
    subject: EmployeeRecoverySubject,
    parent?: EmployeeRecoveryAttempt
  ) {
    if (token !== MINT) held();
    this.#company = company;
    this.#authority = authority;
    this.#context = context;
    this.#subject = subject;
    this.#parent = parent;
  }
  static async capture(
    company: CompanyService,
    plans: PlanMoves,
    authority: ResourceOwnerAuthority,
    context: RamEmployeeRecoveryContext,
    parent?: EmployeeRecoveryAttempt,
    channel?: string
  ): Promise<EmployeeRecoveryAttempt> {
    if (
      !(company instanceof CompanyService) ||
      !(plans instanceof PlanMoves) ||
      !(authority instanceof ResourceOwnerAuthority)
    )
      held();
    ResourceOwnerAuthority.prototype.assertEmployeeRecoveryDomain.call(authority, context, company);
    const subject = (
      parent && parent.#root().#origin === 'loaded-observe'
        ? CompanyService.prototype.captureLoadedEmployeeRecoverySubject
        : CompanyService.prototype.captureEmployeeRecoverySubject
    ).call(
      company,
      context.employeeId,
      context.owner,
      context.approval,
      context.recoveryAuthority.kind === 'delegated-service' ? context.recoveryAuthority.source.sessionId : undefined
    );
    const observe = context.stage === 'employee-recovery-observe';
    let originalChannel = parent ? parent.#root().#channel : undefined;
    if (!parent) originalChannel = await captureRecoveryChannel(subject, authority, context, channel);
    let component = false;
    if (parent) {
      if (!observe && parent.#publication !== 'acknowledged') held();
      const previous = parent.#context.approval,
        selected = context.approval;
      component =
        selected.parentOperationId === previous.operationId &&
        selected.action === 'close-viewer' &&
        previous.action === 'stop-provider' &&
        previous.parentOperationId === null &&
        selected.sessionId === previous.sessionId &&
        selected.sessionGeneration === previous.sessionGeneration &&
        selected.originalAttemptId === previous.originalAttemptId;
      if (
        parent.#company !== company ||
        !parent.#root().#row ||
        parent.#phase === 'staged' ||
        parent.#phase === 'refused' ||
        parent.#subject.session !== subject.session ||
        parent.#subject.resourceDigest !== subject.resourceDigest ||
        (!component && recoveryDataDigest(previous) !== recoveryDataDigest(selected)) ||
        (component && (observe || parent.#component || parent.#root().#row?.component))
      )
        held();
      parent.#subject.requireRetained();
    } else if (observe) held();
    const attempt = new EmployeeRecoveryAttempt(MINT, company, authority, context, subject, parent);
    attempt.#componentInitial = component;
    attempt.#channel = originalChannel;
    if (!parent) CompanyService.prototype.claimEmployeeRecovery.call(company, attempt);
    try {
      attempt.#lease = await PlanMoves.prototype.employeeRecoveryGuard.call(
        plans,
        context.employeeId,
        context.owner,
        observe ? 'observe' : 'effect'
      );
      if (component && parent) {
        if (parent.#component || parent.#root().#row?.component) held();
        parent.#component = attempt;
      }
      attempt.#assertBase();
      if (!component && parent) {
        attempt.#row = parent.#root().#row;
        attempt.#publication = parent.#publication;
        attempt.#phase = 'armed';
        attempt.assertCurrent();
      }
      return attempt;
    } catch (error) {
      attempt.#phase = 'refused';
      attempt.#lease?.close();
      if (component && parent && parent.#component === attempt) parent.#component = undefined;
      if (!parent) CompanyService.prototype.releaseUnissuedEmployeeRecovery.call(company, attempt);
      throw error;
    }
  }
  /** A loaded row can select only an authenticated original-native observation.
   * It never supplies a pre-effect writer acknowledgement or effect admission. */
  static async captureRetainedObservation(
    company: CompanyService,
    plans: PlanMoves,
    authority: ResourceOwnerAuthority,
    context: RamEmployeeRecoveryContext,
    input: EmployeeRecoveryOperation,
    channel: string | undefined
  ): Promise<EmployeeRecoveryAttempt> {
    if (
      !(company instanceof CompanyService) ||
      !(plans instanceof PlanMoves) ||
      !(authority instanceof ResourceOwnerAuthority) ||
      context.stage !== 'employee-recovery-observe'
    )
      held();
    ResourceOwnerAuthority.prototype.assertEmployeeRecoveryDomain.call(authority, context, company);
    const row = EmployeeRecoveryOperation.parse(input);
    if (
      row.application?.supersededByIntent !== undefined ||
      row.employeeId !== context.employeeId ||
      row.owner !== context.owner ||
      recoveryDataDigest(row.approval) !== recoveryDataDigest(context.approval)
    )
      held();
    const subject = CompanyService.prototype.captureLoadedEmployeeRecoverySubject.call(
      company,
      context.employeeId,
      context.owner,
      context.approval,
      context.recoveryAuthority.kind === 'delegated-service' ? context.recoveryAuthority.source.sessionId : undefined
    );
    if (subject.resourceDigest !== row.resourceDigest) held();
    const originalChannel = await captureRecoveryChannel(subject, authority, context, channel);
    const attempt = new EmployeeRecoveryAttempt(MINT, company, authority, context, subject);
    attempt.#origin = 'loaded-observe';
    attempt.#channel = originalChannel;
    attempt.#row = row;
    attempt.#phase = 'armed';
    try {
      attempt.#lease = await PlanMoves.prototype.employeeRecoveryGuard.call(
        plans,
        context.employeeId,
        context.owner,
        'observe'
      );
      attempt.assertLoadedObservation(company, row);
      // No fallible work follows acquisition. If any earlier observation fails,
      // no application claim has been created or needs to be reconstructed.
      CompanyService.prototype.claimRetainedEmployeeRecoveryObservation.call(company, attempt, row);
      return attempt;
    } catch (error) {
      attempt.#phase = 'refused';
      attempt.#lease?.close();
      throw error;
    }
  }
  assertLoadedObservation(company: CompanyService, row: EmployeeRecoveryOperation): void {
    this.assertCompany(company);
    if (
      this.#origin !== 'loaded-observe' ||
      this.#context.stage !== 'employee-recovery-observe' ||
      this.#phase !== 'armed' ||
      !this.#row ||
      !sameRecoveryOperation(this.#row, row)
    )
      held();
    ResourceOwnerAuthority.prototype.assertRecoveryAuthentication.call(this.#authority, this.#context);
    this.#subject.require();
    this.#assertChannel();
    if (!this.#lease?.()) held();
    const rows = company.store
      .snapshot()
      .employeeRecoveryOperations?.filter(
        (value) => value.employeeId === this.employeeId && value.approval.operationId === row.approval.operationId
      );
    if (
      rows?.length !== 1 ||
      !rows[0] ||
      !sameRecoveryOperation(rows[0], row) ||
      company.store
        .snapshot()
        .employeeRecoveryOperations?.some(
          (value) =>
            value.employeeId === this.employeeId &&
            value.approval.operationId !== row.approval.operationId &&
            value.application?.state !== 'completed-stopped'
        )
    )
      held();
  }

  get employeeId(): string {
    return this.#subject.employeeId;
  }
  get owner(): string | undefined {
    return this.#subject.owner;
  }
  get session(): Session {
    return this.#subject.session;
  }
  get row(): EmployeeRecoveryOperation | undefined {
    const row = this.#root().#row;
    return row ? structuredClone(row) : undefined;
  }
  #root(): EmployeeRecoveryAttempt {
    return this.#parent ? this.#parent.#root() : this;
  }
  #componentOwner(): EmployeeRecoveryAttempt | undefined {
    return this.#componentInitial ? this : this.#parent ? this.#parent.#componentOwner() : undefined;
  }
  assertCompany(company: CompanyService): void {
    if (this.#company !== company) held();
  }
  assertRetainedSelection(company: CompanyService, row: EmployeeRecoveryOperation): void {
    this.assertCompany(company);
    const root = this.#root();
    CompanyService.prototype.assertEmployeeRecoveryClaim.call(company, root);
    root.#subject.requireRetained();
    root.#assertChannel();
    const observationRead = CompanyStore.prototype.matchesRetainedEmployeeRecoveryObservation.call(
      company.store,
      root,
      company.store.snapshot()
    );
    if (!root.#row || (!sameRecoveryOperation(root.#row, row) && !observationRead)) held();
  }
  continuationAcknowledged(): boolean {
    return this.#publication === 'acknowledged';
  }
  assertSession(session: Session): void {
    if (this.#subject.session !== session) held();
  }
  assertUnusedLaunchRetirement(session: Session): void {
    this.assertSession(session);
    this.assertCurrent();
    if (this.#root().#origin === 'loaded-observe') held();
    if (
      this.#phase !== 'armed' ||
      (this.#context.stage !== 'employee-recovery-observe' && this.#context.approval.action !== 'reconcile-owned')
    )
      held();
  }
  assertUnissuedRefusal(): void {
    if (this.#phase !== 'refused' || this.#row || this.#issued) held();
  }
  observationMetadataOwner(store: CompanyStore): Readonly<{ owner: EmployeeRecoveryAttempt; readOnly: boolean }> {
    if (store !== this.#company.store) held();
    return { owner: this.#root(), readOnly: this.#context.stage === 'employee-recovery-observe' };
  }
  observationPublication(
    store: CompanyStore
  ): Readonly<{ before: EmployeeRecoveryOperation; attempted: EmployeeRecoveryOperation }> {
    if (store !== this.#company.store || this.#phase !== 'armed' || !this.#issued || !this.#observationPublication)
      held();
    return structuredClone(this.#observationPublication);
  }
  publicationRow(store: CompanyStore): EmployeeRecoveryOperation {
    if (store !== this.#company.store || this.#phase !== 'staged' || !this.#planned || this.#row || this.#issued)
      held();
    return structuredClone(this.#planned);
  }
  existingPublicationRow(store: CompanyStore): EmployeeRecoveryOperation | undefined {
    if (store !== this.#company.store) held();
    const root = this.#root();
    return this.#componentInitial && root.#row ? structuredClone(root.#row) : undefined;
  }
  assertContext(authority: ResourceOwnerAuthority, context: RamEmployeeRecoveryContext): void {
    if (this.#authority !== authority || this.#context !== context || this.#phase === 'staged') held();
    this.assertCurrent();
  }
  #assertChannel(): void {
    const channel = this.#channel;
    if (!channel) held();
    const observed = lstatSync(channel.path, { bigint: true });
    if (
      !observed.isSocket() ||
      observed.dev !== channel.dev ||
      observed.ino !== channel.ino ||
      observed.uid !== channel.uid ||
      observed.mode !== channel.mode
    )
      held();
  }
  #assertBase(state?: CompanyState): void {
    ResourceOwnerAuthority.prototype.assertRecoveryAuthentication.call(this.#authority, this.#context);
    this.#assertBinding(state);
  }
  /** Denial-only referent/row checks; this method cannot authenticate or publish. */
  #assertBinding(state?: CompanyState): void {
    this.#assertChannel();
    if (this.#parent) this.#parent.#subject.requireRetained(state);
    this.#subject.require(state);
    if (!this.#lease?.()) held();
    CompanyService.prototype.assertEmployeeRecoveryClaim.call(this.#company, this.#root());
    if (this.#context.approval.parentOperationId !== null) {
      const original = this.#componentOwner();
      if (!original || this.#root().#component !== original) held();
    }
  }
  #assertCurrentData(state?: CompanyState): void {
    this.#assertBinding(state);
    const currentState = state ?? this.#company.store.snapshot();
    const observationRead = CompanyStore.prototype.matchesEmployeeRecoveryObservation.call(
      this.#company.store,
      this,
      currentState
    );
    if (this.#phase !== 'staged') {
      const expected = this.#root().#row;
      const rows = currentState.employeeRecoveryOperations;
      const row = rows?.find((value) => value.approval.operationId === this.#root().#context.approval.operationId);
      if (
        !expected ||
        !row ||
        row.employeeId !== expected.employeeId ||
        row.owner !== expected.owner ||
        row.requestDigest !== expected.requestDigest ||
        row.resourceDigest !== expected.resourceDigest ||
        row.actorScopeDigest !== expected.actorScopeDigest ||
        (!sameRecoveryOperation(row, expected) &&
          !observationRead &&
          !(
            this.#stoppedProjection &&
            this.#context.stage === 'employee-recovery-observe' &&
            (sameRecoveryOperation(row, this.#stoppedProjection.before) ||
              sameRecoveryOperation(row, this.#stoppedProjection.attempted))
          )) ||
        (this.#context.approval.parentOperationId !== null &&
          recoveryDataDigest(row.component?.approval) !== recoveryDataDigest(this.#context.approval))
      )
        held();
    }
  }
  assertCurrent(state?: CompanyState): void {
    if (this.#phase === 'held' || this.#phase === 'refused') held();
    try {
      ResourceOwnerAuthority.prototype.assertRecoveryAuthentication.call(this.#authority, this.#context);
      this.#assertCurrentData(state);
    } catch (error) {
      if (this.#phase !== 'staged') this.#phase = 'held';
      throw error;
    }
  }
  /** Only the fixed stopped mutator calls this immediately after the writer
   * authenticated its queued entry. No await or reentrant callback intervenes. */
  assertStoppedPublicationBinding(store: CompanyStore, state: CompanyState): void {
    this.stoppedMetadataOwner(store);
    if (this.#phase === 'held' || this.#phase === 'refused') held();
    try {
      this.#assertCurrentData(state);
    } catch (error) {
      this.#phase = 'held';
      throw error;
    }
  }
  async reserve(): Promise<void> {
    if (this.#phase !== 'staged' || (this.#parent && !this.#componentInitial) || this.#row) held();
    const context = this.#context;
    const root = this.#root();
    const row = EmployeeRecoveryOperation.parse(
      this.#componentInitial
        ? {
            ...root.#row,
            component: {
              approval: context.approval,
              actorScopeDigest: context.ownerScopeDigest,
              createdAt: Date.now(),
              sequence: 0,
              phase: 'issued',
            },
          }
        : {
            version: 1,
            employeeId: context.employeeId,
            owner: context.owner,
            approval: context.approval,
            resourceDigest: this.#subject.resourceDigest,
            actorScopeDigest: context.ownerScopeDigest,
            requestDigest: recoveryDataDigest([context.employeeId, context.approval]),
            createdAt: Date.now(),
            sequence: 0,
            phase: 'issued',
          }
    );
    this.#planned = row;
    const outcome = await CompanyStore.prototype.publishEmployeeRecovery.call(this.#company.store, this);
    if (outcome.state === 'not-issued') {
      this.#phase = 'refused';
      this.#lease?.close();
      if (this.#componentInitial) {
        if (this.#parent && this.#parent.#component === this) this.#parent.#component = undefined;
      } else CompanyService.prototype.releaseUnissuedEmployeeRecovery.call(this.#company, this);
      throw outcome.cause;
    }
    if (outcome.state === 'unconfirmed') {
      this.#row = row;
      root.#row = row;
      this.#phase = 'held';
      throw outcome.receipt;
    }
    // The structural outcome is NOT the receipt; only this exact Store's
    // private acknowledgement from its completed actual writer can arm us.
    this.#row = undefined;
    CompanyStore.prototype.consumeEmployeeRecoveryAcknowledgement.call(this.#company.store, this);
    this.#publication = 'acknowledged';
    this.#row = row;
    root.#row = row;
    this.#planned = undefined;
    this.#phase = 'armed';
    this.assertCurrent();
  }
  /** Actual native response owner only. DATA and history cannot enter this path. */
  beginStoppedSettlement(proof: OriginalStoppedRecovery): void {
    if (
      this.#context.stage !== 'employee-recovery-observe' ||
      this.#context.approval.action !== 'stop-provider' ||
      this.#context.approval.parentOperationId !== null ||
      this.#stoppedProof
    )
      held();
    OriginalStoppedRecovery.prototype.claimFor.call(proof, this);
    this.#stoppedProof = proof;
    this.#root().#stoppedInProgress = true;
    Session.prototype.captureStoppedEmployeeRetirement.call(this.session, this);
  }
  stoppedMetadataOwner(store?: CompanyStore): EmployeeRecoveryAttempt {
    if (store && store !== this.#company.store) held();
    if (
      !this.#stoppedProof ||
      this.#context.stage !== 'employee-recovery-observe' ||
      this.#context.approval.action !== 'stop-provider' ||
      this.#context.approval.parentOperationId !== null
    )
      held();
    OriginalStoppedRecovery.prototype.assertOriginalFor.call(this.#stoppedProof, this);
    return this.#root();
  }
  stoppedApproval(): EmployeeRecoveryApproval {
    this.stoppedMetadataOwner();
    return this.#context.approval;
  }
  stoppedPublication(store: CompanyStore, stage: 'intent' | 'terminal') {
    const root = this.stoppedMetadataOwner(store),
      before = root.#row;
    if (!before || this.#stoppedProjection) held();
    if (
      stage === 'terminal' &&
      (!root.#stoppedIntentKnown || !Session.prototype.stoppedEmployeeRetirementKnown.call(this.session, this))
    )
      held();
    root.#stoppedAt ??= before.application?.stoppedAt ?? Date.now();
    const attempted = EmployeeRecoveryOperation.parse({
      ...before,
      version: 2,
      phase: 'observed',
      observationDigest:
        before.observationDigest ?? recoveryDataDigest(['complete-original-Q-frame', this.#context.approval]),
      sequence: before.sequence + 1,
      application: {
        version: 1,
        state: stage === 'intent' ? 'stopped-intent' : 'completed-stopped',
        stoppedAt: root.#stoppedAt,
      },
    });
    this.#stoppedProjection = { stage, before, attempted };
    return structuredClone(this.#stoppedProjection);
  }
  assertStoppedPublication(store: CompanyStore, state?: CompanyState): void {
    if (store !== this.#company.store) held();
    this.stoppedMetadataOwner(store);
    this.assertCurrent(state);
  }
  async publishStopped(stage: 'intent' | 'terminal'): Promise<void> {
    const root = this.stoppedMetadataOwner();
    if (stage === 'intent' && root.#stoppedIntentKnown) {
      this.assertCurrent();
      return;
    }
    const outcome = await CompanyStore.prototype.publishStoppedEmployeeRecovery.call(this.#company.store, this, stage);
    if (outcome.state !== 'committed') throw outcome.state === 'not-issued' ? outcome.cause : outcome.receipt;
    CompanyStore.prototype.consumeStoppedEmployeeAcknowledgement.call(this.#company.store, this, stage);
    const projection = this.#stoppedProjection;
    if (!projection || projection.stage !== stage) held();
    root.#row = projection.attempted;
    this.#row = projection.attempted;
    this.#stoppedProjection = undefined;
    if (stage === 'intent') root.#stoppedIntentKnown = true;
    else root.#stoppedTerminalKnown = true;
    this.assertCurrent();
  }
  stoppedPublicationDigest(store: CompanyStore, stage: 'intent' | 'terminal'): string {
    if (store !== this.#company.store || this.#stoppedProjection?.stage !== stage) held();
    return recoveryDataDigest(this.#stoppedProjection.attempted);
  }
  originalRecoveryOwner(): EmployeeRecoveryAttempt {
    return this.#root();
  }
  releasedStoppedFor(company: CompanyService): boolean {
    this.assertCompany(company);
    return (
      this.#root().#stoppedTerminalKnown && Session.prototype.stoppedEmployeeRecoveryReleased.call(this.session, this)
    );
  }
  stoppedInProgress(): boolean {
    return this.#root().#stoppedInProgress;
  }
  loadedObservationOnly(): boolean {
    return this.#root().#origin === 'loaded-observe';
  }
  completedStoppedFor(company: CompanyService): boolean {
    this.assertCompany(company);
    return this.#root().#stoppedTerminalKnown;
  }
  async settleStopped(proof: OriginalStoppedRecovery): Promise<void> {
    this.beginStoppedSettlement(proof);
    await this.publishStopped('intent');
    await Session.prototype.retireStoppedEmployeeLaunch.call(this.session, this);
    // Invalidation starts with the fresh post-await authority check itself.
    Session.prototype.invalidateStoppedEmployeeEpoch.call(this.session, this);
    await this.publishStopped('terminal');
    CompanyService.prototype.releaseStoppedEmployeeRecovery.call(this.#company, this);
  }
  assertOriginalObservation(authority: ResourceOwnerAuthority, context: RamEmployeeRecoveryContext): void {
    this.assertContext(authority, context);
    if (context.stage !== 'employee-recovery-observe' || !this.#issued) held();
  }
  claimDispatch(authority: ResourceOwnerAuthority, context: RamEmployeeRecoveryContext): void {
    this.assertContext(authority, context);
    if (
      this.#phase !== 'armed' ||
      this.#issued ||
      (this.#root().#origin === 'loaded-observe' && context.stage !== 'employee-recovery-observe')
    )
      held();
    this.#issued = true;
  }
  async retainObservation(value: unknown): Promise<void> {
    if (this.#phase !== 'armed') held();
    this.assertCurrent();
    const owner = this.#root();
    if (!this.#issued || !owner.#row) held();
    const row = owner.#row,
      observed = EmployeeRecoveryOperation.parse(
        this.#context.approval.parentOperationId !== null
          ? {
              ...row,
              sequence: row.sequence + 1,
              component: {
                ...row.component,
                phase: 'observed',
                sequence: (row.component?.sequence ?? 0) + 1,
                observationDigest: recoveryDataDigest(value),
              },
            }
          : {
              ...row,
              phase: 'observed',
              sequence: row.sequence + 1,
              observationDigest: recoveryDataDigest(value),
            }
      );
    this.#observationPublication = { before: row, attempted: observed };
    const outcome = await CompanyStore.prototype.publishEmployeeRecoveryObservation.call(this.#company.store, this);
    this.#observationPublication = undefined;
    if (outcome.state !== 'committed') {
      this.#phase = 'held';
      throw outcome.state === 'not-issued' ? outcome.cause : outcome.receipt;
    }
    this.#row = observed;
    owner.#row = observed;
    owner.#phase = 'observed';
    this.#phase = 'observed';
    this.assertCurrent();
  }
  hold(): void {
    this.#phase = 'held';
    this.#lease?.close();
  }
  closeContinuation(): void {
    if (!this.#parent) held();
    this.hold();
  }
  toJSON(): never {
    throw Error('Employee recovery admission is server-private');
  }
}
