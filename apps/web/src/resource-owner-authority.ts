/** Current human-owner proof for the distinct private resource purpose.
 * No route, broker connection, installation or native grant is created here.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { OwnerAuthService } from './owner-auth/service.js';
import { OWNER_COOKIE, SERVICE_HEADER, sameOrigin } from './owner-auth/policy.js';
import { ownerFor } from './web/route-helpers.js';
import {
  EmployeeGpuIntentData,
  EmployeeGpuApplyData,
  type EmployeeGpuIntent,
  type EmployeeGpuApply,
} from './employee-gpu-data.js';
import { EmployeePolicyEditApproval } from './resource-employee-data.js';
import {
  EmployeeRecoveryApproval,
  EmployeeRecoveryRequest,
  EmployeeRecoverySelectionRequest,
  recoveryDataDigest,
} from './employee-recovery-operation.js';
import { assertServiceAuthorization, type ServiceAuthorization } from './service-authorization.js';
import { OfficeScopedActionPublisher, type OfficeScopedAction } from './office-scoped-action-publisher.js';
import { WorkerRecoveryAuthentication, RECOVERY_HEADER } from './worker-recovery-auth.js';
import { SERVICE_ASSERTION_HEADER } from './service-decision.js';
import { EmployeeRecoveryAttempt } from './employee-recovery-attempt.js';
import type { CompanyService } from './company-service.js';

const PURPOSE = 'resource-replacement-v1';
const RAM_PURPOSE = 'resource-ram-pool-v2';
export const POOL_INSTALLATION_CONSENT_PURPOSE = 'host-pool-installation-consent-v1';
export const FLEET_MAINTENANCE_PURPOSE = 'resource-fleet-maintenance-v1';
type ResourcePurpose =
  | typeof PURPOSE
  | typeof RAM_PURPOSE
  | typeof POOL_INSTALLATION_CONSENT_PURPOSE
  | typeof FLEET_MAINTENANCE_PURPOSE;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const HEX = /^[a-f0-9]{64}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MINT = Symbol('resource-owner-binding');
const bindings = new WeakMap<object, ResourceOwnerContext | RamResourceOwnerContext>();
export class ResourceOwnerAuthorizationError extends Error {}
export class ResourceRecoveryWindowExpiredError extends Error {
  constructor() {
    super('The original recovery observation window elapsed; inspect the retained operation.');
  }
}
function need(value: unknown): asserts value {
  if (!value)
    throw new ResourceOwnerAuthorizationError('Current resource owner authorization is unavailable or changed');
}

/** Produced by the protected host draft before the actual owner Apply. These
 * identifiers are binding references; they are never an authorization token. */
export interface ResourceApproval {
  readonly employeeId: string;
  readonly draftId: string;
  readonly operationId: string;
  readonly reservationId: string;
  readonly targetSid: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly previewDigest: string;
}
export interface RamResourceApproval extends ResourceApproval {
  readonly ramPolicyDigest: string;
}

interface ResourceContext<P extends ResourcePurpose = typeof PURPOSE> {
  readonly purpose: P;
  readonly owner: string | undefined;
  readonly ownerScopeDigest: string;
  readonly expiresAtEpochMs: number;
  assertCurrent(): void;
}
export interface ResourceOwnerContext extends ResourceContext {
  readonly stage: 'apply';
  readonly approval: Readonly<ResourceApproval>;
}
export interface ResourcePreviewContext extends ResourceContext {
  readonly stage: 'preview';
  readonly employeeId: string;
}
export interface RamResourceOwnerContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'apply';
  readonly approval: Readonly<RamResourceApproval>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamResourcePreviewContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'preview';
  readonly employeeId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
/** Read-only employee observation; this stage cannot authorize a draft or Apply. */
export interface RamResourceStatusContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'status';
  readonly employeeId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamMemoryDiagnosticsContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'employee-memory-diagnostics';
  readonly employeeId: string;
  readonly sessionId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamGpuStatusContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'gpu-status';
  readonly employeeId: string;
  readonly sessionId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamGpuApplyStatusContext extends Omit<RamGpuStatusContext, 'stage'> {
  readonly stage: 'gpu-apply-status';
}
export interface RamGpuRequestContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'gpu-request';
  readonly employeeId: string;
  readonly approval: Readonly<EmployeeGpuIntent>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamGpuApplyContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'gpu-apply';
  readonly employeeId: string;
  readonly approval: Readonly<EmployeeGpuApply>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamEmployeePolicyEditContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'employee-policy-edit';
  readonly employeeId: string;
  readonly approval: EmployeePolicyEditApproval;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
interface RamEmployeeRecoveryFields extends ResourceContext<typeof RAM_PURPOSE> {
  readonly employeeId: string;
  readonly approval: EmployeeRecoveryApproval;
  readonly recoveryAuthority: EmployeeRecoveryAuthority;
}
export type RamEmployeeRecoveryContext = RamEmployeeRecoveryFields &
  ({ readonly stage: 'employee-recovery' } | { readonly stage: 'employee-recovery-observe' });
export type EmployeeRecoveryAuthority =
  | { readonly kind: 'human-owner'; readonly principal: Readonly<ResourceOwnerPrincipal> }
  | {
      readonly kind: 'delegated-service';
      /** Delegation issuer correlation, never a human login. */
      readonly ownerRegistration: Readonly<ResourceOwnerPrincipal>;
      readonly service: Readonly<{ principal: string; issuerEpoch: string; grantId: string; grantGeneration: string }>;
      readonly source: Readonly<{ employeeId: string; sessionId: string; sessionGeneration: string }>;
      readonly resourceId: string;
      readonly action: `reverie.ops.employee.${EmployeeRecoveryApproval['action']}`;
    };
/** Current canonical identity DATA, meaningful only with its actual retained
 * context, cookie/session and attested native channel. */
export interface ResourceOwnerPrincipal {
  readonly accountId: string;
  readonly personId: string;
  readonly sessionEpoch: number;
}
/** Nomination/offer DATA. Its actual native origin and one-shot B-channel
 * ownership must be checked by the retained native offer consumer. */
export interface PoolInstallationOfferData {
  readonly offerNonce: string;
  readonly requestDigest: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
interface PoolInstallationSelection {
  readonly requestId: string;
  readonly offerNonce: string;
  readonly requestDigest: string;
}
export interface PoolInstallationViewerContext extends ResourceContext<typeof POOL_INSTALLATION_CONSENT_PURPOSE> {
  readonly stage: 'viewer';
  readonly requestId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface PoolInstallationOfferContext
  extends ResourceContext<typeof POOL_INSTALLATION_CONSENT_PURPOSE>, PoolInstallationSelection {
  readonly stage: 'offer';
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface PoolInstallationConsentContext
  extends ResourceContext<typeof POOL_INSTALLATION_CONSENT_PURPOSE>, PoolInstallationSelection {
  readonly stage: 'consent';
  readonly consent: true;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface FleetApproval {
  readonly operationId: string;
  readonly previewId: string;
  readonly cohortDigest: string;
  readonly poolPolicyDigest: string;
  readonly coverageDigest: string;
  readonly revisionDigest: string;
}
export interface FleetViewerContext extends ResourceContext<typeof FLEET_MAINTENANCE_PURPOSE> {
  readonly stage: 'fleet-viewer';
  readonly requestId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface FleetPreviewContext extends ResourceContext<typeof FLEET_MAINTENANCE_PURPOSE> {
  readonly stage: 'fleet-preview';
  readonly requestId: string;
  readonly approval: Readonly<FleetApproval>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface FleetMigrationContext extends ResourceContext<typeof FLEET_MAINTENANCE_PURPOSE> {
  readonly stage: 'fleet-migration';
  readonly requestId: string;
  readonly verb: 'migrate-pool';
  readonly consent: true;
  readonly approval: Readonly<FleetApproval>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
type PrincipalFor<P extends ResourcePurpose> = P extends
  | typeof RAM_PURPOSE
  | typeof POOL_INSTALLATION_CONSENT_PURPOSE
  | typeof FLEET_MAINTENANCE_PURPOSE
  ? { readonly principal: Readonly<ResourceOwnerPrincipal> }
  : object;
/** Website metadata/command correlation DATA. Only the retained owner binding
 * authorizes its use; this is not a native journal, claim or launch permit. */
export interface RamResourceSessionIntent {
  readonly purpose: typeof RAM_PURPOSE;
  readonly owner: string | undefined;
  readonly ownerScopeDigest: string;
  readonly sourceSid: string;
  readonly sourceGeneration: number;
  readonly approval: Readonly<RamResourceApproval>;
}
export type AnyResourceContext =
  | ResourceOwnerContext
  | ResourcePreviewContext
  | RamResourceOwnerContext
  | RamResourcePreviewContext
  | RamResourceStatusContext
  | RamMemoryDiagnosticsContext
  | RamGpuStatusContext
  | RamGpuApplyStatusContext
  | RamGpuRequestContext
  | RamGpuApplyContext
  | RamEmployeePolicyEditContext
  | RamEmployeeRecoveryContext;
type AuthorityContext =
  | AnyResourceContext
  | PoolInstallationViewerContext
  | PoolInstallationOfferContext
  | PoolInstallationConsentContext
  | FleetViewerContext
  | FleetPreviewContext
  | FleetMigrationContext;

/** Process-local authority join. A serialized scope digest never recreates it. */
export class ResourceOwnerBinding {
  readonly #context: ResourceOwnerContext;
  constructor(token: symbol, context: ResourceOwnerContext) {
    need(token === MINT && context.purpose === PURPOSE);
    this.#context = context;
    bindings.set(this, context);
    Object.freeze(this);
  }
  get digest(): string {
    return this.#context.ownerScopeDigest;
  }
  assertCurrent(owner: string | undefined): void {
    need(bindings.get(this) === this.#context && owner === this.#context.owner);
    this.#context.assertCurrent();
  }
  assertOperation(
    owner: string | undefined,
    operation: {
      employeeId: string;
      resourceOwnerScope?: string;
      newSession?: string;
      resourceIntent?: Pick<
        ResourceApproval,
        'operationId' | 'reservationId' | 'profileVersion' | 'profileDigest' | 'previewDigest'
      >;
    }
  ): void {
    this.assertCurrent(owner);
    const approved = this.#context.approval,
      intent = operation.resourceIntent;
    need(
      operation.employeeId === approved.employeeId &&
        operation.resourceOwnerScope === this.digest &&
        intent &&
        intent.operationId === approved.operationId &&
        intent.reservationId === approved.reservationId &&
        intent.profileVersion === approved.profileVersion &&
        intent.profileDigest === approved.profileDigest &&
        intent.previewDigest === approved.previewDigest &&
        (operation.newSession === undefined || operation.newSession === approved.targetSid)
    );
  }
  toJSON(): never {
    throw new Error('Resource owner binding is server-private');
  }
}

export function assertResourceOwnerBinding(binding: ResourceOwnerBinding, owner: string | undefined): string {
  need(binding instanceof ResourceOwnerBinding && bindings.has(binding));
  ResourceOwnerBinding.prototype.assertCurrent.call(binding, owner);
  return binding.digest;
}

export function assertResourceOperation(
  binding: ResourceOwnerBinding,
  owner: string | undefined,
  operation: Parameters<ResourceOwnerBinding['assertOperation']>[1]
): string {
  assertResourceOwnerBinding(binding, owner);
  ResourceOwnerBinding.prototype.assertOperation.call(binding, owner, operation);
  return binding.digest;
}

/** Distinct RAM purpose: never accepted by the legacy eight-field binding. */
export class RamResourceOwnerBinding {
  readonly #context: RamResourceOwnerContext;
  constructor(token: symbol, context: RamResourceOwnerContext) {
    need(token === MINT && context.purpose === RAM_PURPOSE);
    this.#context = context;
    bindings.set(this, context);
    Object.freeze(this);
  }
  get digest(): string {
    return this.#context.ownerScopeDigest;
  }
  assertCurrent(owner: string | undefined): void {
    need(bindings.get(this) === this.#context && owner === this.#context.owner);
    this.#context.assertCurrent();
  }
  /** Pair only the exact retained RAM context; matching serialized approvals
   * or owner names cannot substitute another session/capture. */
  assertContext(context: RamResourceOwnerContext): void {
    need(bindings.get(this) === this.#context && context === this.#context);
    this.assertCurrent(context.owner);
  }
  assertPreview(authority: ResourceOwnerAuthority, preview: RamResourcePreviewContext): void {
    this.assertCurrent(preview.owner);
    need(authority instanceof ResourceOwnerAuthority && preview.purpose === RAM_PURPOSE);
    authority.assertSameSession(preview, this.#context);
  }
  assertOperation(owner: string | undefined, operation: RamResourceSessionIntent): void {
    this.assertCurrent(owner);
    need(
      operation.purpose === RAM_PURPOSE &&
        operation.owner === owner &&
        operation.ownerScopeDigest === this.digest &&
        UUID.test(operation.sourceSid) &&
        Number.isSafeInteger(operation.sourceGeneration) &&
        operation.sourceGeneration >= 0
    );
    const approved = this.#context.approval,
      actual = operation.approval;
    need(Object.keys(actual).sort().join(',') === Object.keys(approved).sort().join(','));
    for (const field of Object.keys(approved) as (keyof RamResourceApproval)[]) need(actual[field] === approved[field]);
    need(operation.sourceSid !== approved.targetSid);
  }
  toJSON(): never {
    throw new Error('RAM resource owner binding is server-private');
  }
}

export function assertRamResourceOperation(
  binding: RamResourceOwnerBinding,
  owner: string | undefined,
  operation: RamResourceSessionIntent
): string {
  need(binding instanceof RamResourceOwnerBinding && bindings.has(binding));
  RamResourceOwnerBinding.prototype.assertOperation.call(binding, owner, operation);
  return binding.digest;
}

export class ResourceOwnerAuthority {
  readonly #auth: OwnerAuthService;
  readonly #epoch = randomBytes(32).toString('hex');
  readonly #contexts = new WeakSet<object>();
  readonly #submittedEmployeePolicies = new WeakSet<RamEmployeePolicyEditContext>();
  readonly #poolViews = new WeakSet<object>();
  readonly #consentedPoolViews = new WeakSet<object>();
  readonly #fleetViews = new WeakMap<FleetPreviewContext, FleetViewerContext>();
  readonly #consentedFleetViews = new WeakSet<object>();
  readonly #sessions = new WeakMap<object, { account: OwnerAuthService; token: string }>();
  readonly #channels = new Map<Socket, Map<string, { account: OwnerAuthService; count: number }>>();
  readonly #serviceContexts = new WeakSet<object>();
  readonly #serviceChannels = new Map<Socket, number>();
  readonly #recoveryAttempts = new WeakMap<RamEmployeeRecoveryContext, EmployeeRecoveryAttempt>();
  readonly #recoveryOfficeProofs = new WeakMap<RamEmployeeRecoveryContext, OfficeScopedAction>();
  readonly #recoveryCompanies = new WeakMap<RamEmployeeRecoveryContext, CompanyService>();
  readonly #recoveryAuthentications = new WeakMap<
    FastifyRequest,
    { key: string; flight: Promise<RamEmployeeRecoveryContext> }
  >();
  #closed = false;
  readonly #officeActions?: OfficeScopedActionPublisher;
  constructor(
    auth: OwnerAuthService,
    private readonly services?: ServiceAuthorization,
    recovery?: WorkerRecoveryAuthentication
  ) {
    need(auth instanceof OwnerAuthService);
    this.#auth = auth;
    if (services && recovery) this.#officeActions = new OfficeScopedActionPublisher(services, recovery, auth);
  }
  close(): void {
    this.#closed = true;
    this.#officeActions?.close();
    for (const socket of this.#channels.keys()) socket.destroy();
    this.#channels.clear();
    for (const socket of this.#serviceChannels.keys()) socket.destroy();
    this.#serviceChannels.clear();
  }
  captureEmployeeRecovery(
    request: FastifyRequest,
    employeeId: string,
    approval: EmployeeRecoveryApproval,
    access: 'effect' | 'observe' = 'effect'
  ): RamEmployeeRecoveryContext {
    need(UUID.test(employeeId));
    const selected = EmployeeRecoveryRequest.parse(request.body);
    need(
      !selected.grantRef &&
        recoveryDataDigest(selected.approval) === recoveryDataDigest(approval) &&
        request.headers[RECOVERY_HEADER] === undefined &&
        request.headers[SERVICE_ASSERTION_HEADER] === undefined
    );
    return this.#capture(
      request,
      {
        stage: access === 'effect' ? ('employee-recovery' as const) : ('employee-recovery-observe' as const),
        employeeId,
        approval: EmployeeRecoveryApproval.parse(approval),
      },
      RAM_PURPOSE
    );
  }
  /** Application read only. This wrapper is never accepted as a native Q context. */
  async captureRecoverySelection(request: FastifyRequest, employeeId: string, company: CompanyService) {
    need(UUID.test(employeeId) && !this.#closed);
    if (request.method === 'GET') {
      need(request.headers[RECOVERY_HEADER] === undefined && request.headers[SERVICE_ASSERTION_HEADER] === undefined);
      const end = Date.now() + 10_000;
      const context = this.#capture(request, { stage: 'status' as const, employeeId }, RAM_PURPOSE, end);
      return Object.freeze({
        owner: context.owner,
        callerSessionId: undefined as string | undefined,
        delegated: false,
        require: () => {
          if (Date.now() >= end) throw new ResourceRecoveryWindowExpiredError();
          this.assertContext(context);
        },
      });
    }
    need(request.method === 'POST' && this.#officeActions);
    const body = EmployeeRecoverySelectionRequest.parse(request.body);
    const publisher = this.#officeActions;
    const proof = await OfficeScopedActionPublisher.prototype.capture
      .call(publisher, request, {
        kind: 'employee-recovery-selection',
        employeeId,
        grantRef: body.grantRef,
      })
      .catch((cause: unknown) => {
        throw new ResourceOwnerAuthorizationError('Current recovery source/grant authorization is required', { cause });
      });
    const require = () => {
      need(!this.#closed);
      if (Date.now() >= proof.expiresAtEpochMs) throw new ResourceRecoveryWindowExpiredError();
      try {
        OfficeScopedActionPublisher.prototype.assertOriginal.call(publisher, proof, company.store);
      } catch (cause) {
        throw new ResourceOwnerAuthorizationError('Current recovery source/grant authorization changed', { cause });
      }
    };
    require();
    return Object.freeze({ owner: proof.owner, callerSessionId: proof.source.sessionId, delegated: true, require });
  }
  /** The service assertion is authenticated HERE by the configured original
   * owner. Callers cannot provide a structural lease or a current() grant.
   * This context can answer ONLY the distinct employee-recovery Q challenge.
   */
  async authenticateEmployeeRecovery(
    request: FastifyRequest,
    employeeId: string,
    input: EmployeeRecoveryApproval,
    access: 'effect' | 'observe' = 'effect'
  ): Promise<RamEmployeeRecoveryContext> {
    const cache = this.#recoveryAuthentications;
    const key = recoveryDataDigest([
      employeeId,
      EmployeeRecoveryApproval.parse(input),
      access,
      request.method,
      request.url,
      EmployeeRecoveryRequest.parse(request.body),
      recoveryDataDigest(
        typeof request.headers[RECOVERY_HEADER] === 'string' ? request.headers[RECOVERY_HEADER] : null
      ),
    ]);
    const original = cache.get(request);
    if (original) {
      need(original.key === key);
      return original.flight;
    }
    const flight = this.#authenticateEmployeeRecovery(request, employeeId, input, access);
    cache.set(request, { key, flight });
    return flight;
  }
  async #authenticateEmployeeRecovery(
    request: FastifyRequest,
    employeeId: string,
    input: EmployeeRecoveryApproval,
    access: 'effect' | 'observe'
  ): Promise<RamEmployeeRecoveryContext> {
    need(UUID.test(employeeId) && !this.#closed);
    const approval = EmployeeRecoveryApproval.parse(input),
      publisher = this.#officeActions;
    need(publisher);
    const selected = EmployeeRecoveryRequest.parse(request.body);
    need(selected.grantRef && recoveryDataDigest(selected.approval) === recoveryDataDigest(approval));
    const proof = await OfficeScopedActionPublisher.prototype.capture.call(publisher, request, {
      kind: 'employee-recovery',
      employeeId,
      access,
      approval,
      grantRef: selected.grantRef,
    });
    // Only immutable correlation DATA is built here. The final context check
    // below is the single fresh verifier after capture's await, before export.
    const action = `reverie.ops.employee.${access === 'observe' ? 'reconcile-owned' : approval.action}` as const;
    need(proof.action === action);
    const recoveryAuthority: EmployeeRecoveryAuthority = Object.freeze({
      kind: 'delegated-service',
      ownerRegistration: proof.ownerRegistration,
      service: proof.service,
      source: proof.source,
      resourceId: proof.resourceId,
      action,
    });
    const owner = proof.owner;
    const ownerScopeDigest = recoveryDataDigest([
      this.#epoch,
      proof.scopeDigest,
      access,
      employeeId,
      approval,
      recoveryAuthority,
    ]);
    const expiresAtEpochMs = proof.expiresAtEpochMs;
    const assertCurrent = () => {
      need(!this.#closed && this.#contexts.has(context));
      const company = this.#recoveryCompanies.get(context);
      try {
        if (company) OfficeScopedActionPublisher.prototype.assertOriginal.call(publisher, proof, company.store);
        else proof.assertCurrent();
      } catch (cause) {
        throw new ResourceOwnerAuthorizationError('Current recovery source/grant authorization changed', { cause });
      }
    };
    const context = Object.freeze({
      purpose: RAM_PURPOSE,
      stage: access === 'effect' ? ('employee-recovery' as const) : ('employee-recovery-observe' as const),
      employeeId,
      approval,
      owner,
      recoveryAuthority,
      ownerScopeDigest,
      expiresAtEpochMs,
      assertCurrent,
      toJSON: () => {
        throw new Error('Resource owner context is server-private');
      },
      [inspect.custom]: () => '[Private employee recovery context]',
    });
    this.#contexts.add(context);
    this.#serviceContexts.add(context);
    this.#recoveryOfficeProofs.set(context, proof);
    assertCurrent();
    return context;
  }
  #identity(
    request: FastifyRequest,
    token: string,
    purpose: ResourcePurpose = PURPOSE,
    access: 'operation' | 'employee-status' = 'operation'
  ): { key: string; principal?: Readonly<ResourceOwnerPrincipal> } {
    need(
      !this.#closed &&
        (access === 'employee-status'
          ? purpose === RAM_PURPOSE && request.method === 'GET'
          : request.method === 'POST' && sameOrigin(request)) &&
        request.cookies?.[OWNER_COOKIE] === token &&
        request.headers.authorization === undefined &&
        request.headers[SERVICE_HEADER] === undefined &&
        request.headers['x-reverie-parent-session'] === undefined &&
        !Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-'))
    );
    // The root service retains shared-office role/id/primary distinctions;
    // a child account's local identity describes only its own credentials.
    const session = this.#auth.session(token),
      identity = this.#auth.identity(token);
    need(
      session &&
        !session.restricted &&
        (session.role === undefined || session.role === 'owner') &&
        identity?.role === 'owner'
    );
    const owner = ownerFor(request);
    need(owner === undefined || owner === identity.username);
    const human = [owner, identity.id, identity.username, identity.role, identity.primary];
    if (purpose !== PURPOSE) {
      // The distinct RAM and global-consent purposes pin canonical account birth and
      // current Office person. This read never enrolls a legacy account, and
      // deliberately has no ordinary-identity/cache fallback.
      const current = this.#auth.registrationIdentity(token);
      need(
        UUID.test(current.accountId) &&
          current.accountId !== NIL_UUID &&
          (current.personId === 'owner' || (UUID.test(current.personId) && current.personId !== NIL_UUID)) &&
          current.personId === identity.id &&
          Number.isSafeInteger(current.sessionEpoch) &&
          current.sessionEpoch >= 0
      );
      const principal = Object.freeze({
        accountId: current.accountId,
        personId: current.personId,
        sessionEpoch: current.sessionEpoch,
      });
      return {
        key: JSON.stringify([...human, principal.accountId, principal.personId, principal.sessionEpoch]),
        principal,
      };
    }
    return { key: JSON.stringify(human) };
  }
  capture(request: FastifyRequest, approved: ResourceApproval): ResourceOwnerContext {
    this.#approval(approved, false);
    return this.#capture(request, { stage: 'apply' as const, approval: Object.freeze({ ...approved }) }, PURPOSE);
  }
  captureRam(request: FastifyRequest, approved: RamResourceApproval): RamResourceOwnerContext {
    this.#approval(approved, true);
    return this.#capture(request, { stage: 'apply' as const, approval: Object.freeze({ ...approved }) }, RAM_PURPOSE);
  }
  #approval(approved: ResourceApproval, ram: boolean): void {
    const keys =
      'draftId,employeeId,operationId,previewDigest,profileDigest,profileVersion,' +
      (ram ? 'ramPolicyDigest,' : '') +
      'reservationId,targetSid';
    need(Object.keys(approved).sort().join(',') === keys);
    for (const key of ['draftId', 'employeeId', 'operationId', 'reservationId', 'targetSid'] as const)
      need(typeof approved[key] === 'string' && UUID.test(approved[key]));
    const version = approved.profileVersion;
    const validVersion = ram
      ? typeof version === 'string' && /^[1-9][0-9]{0,19}$/.test(version) && BigInt(version) <= 18446744073709551615n
      : /^[1-9][0-9]{0,15}$/.test(version) && Number.isSafeInteger(Number(version));
    need(
      new Set([approved.draftId, approved.operationId, approved.reservationId, approved.targetSid]).size === 4 &&
        HEX.test(approved.previewDigest) &&
        HEX.test(approved.profileDigest) &&
        validVersion
    );
    if (ram) need(HEX.test((approved as RamResourceApproval).ramPolicyDigest));
  }
  capturePreview(request: FastifyRequest, employeeId: string): ResourcePreviewContext {
    need(typeof employeeId === 'string' && UUID.test(employeeId));
    return this.#capture(request, { stage: 'preview' as const, employeeId }, PURPOSE);
  }
  captureRamPreview(request: FastifyRequest, employeeId: string): RamResourcePreviewContext {
    need(typeof employeeId === 'string' && UUID.test(employeeId));
    return this.#capture(request, { stage: 'preview' as const, employeeId }, RAM_PURPOSE);
  }
  captureRamStatus(request: FastifyRequest, employeeId: string): RamResourceStatusContext {
    need(typeof employeeId === 'string' && UUID.test(employeeId) && employeeId !== NIL_UUID);
    return this.#capture(request, { stage: 'status' as const, employeeId }, RAM_PURPOSE);
  }
  captureRamMemoryDiagnostics(
    request: FastifyRequest,
    employeeId: string,
    sessionId: string
  ): RamMemoryDiagnosticsContext {
    need(UUID.test(employeeId) && employeeId !== NIL_UUID && UUID.test(sessionId) && sessionId !== NIL_UUID);
    return this.#capture(
      request,
      { stage: 'employee-memory-diagnostics' as const, employeeId, sessionId },
      RAM_PURPOSE,
      Date.now() + 10_000
    );
  }
  captureRamGpuStatus(request: FastifyRequest, employeeId: string, sessionId: string): RamGpuStatusContext {
    need(UUID.test(employeeId) && employeeId !== NIL_UUID && UUID.test(sessionId) && sessionId !== NIL_UUID);
    return this.#capture(
      request,
      { stage: 'gpu-status' as const, employeeId, sessionId },
      RAM_PURPOSE,
      Date.now() + 35_000
    );
  }
  captureRamGpuApplyStatus(request: FastifyRequest, original: RamGpuStatusContext): RamGpuApplyStatusContext {
    this.assertContext(original);
    need(original.stage === 'gpu-status');
    return this.#capture(
      request,
      { stage: 'gpu-apply-status' as const, employeeId: original.employeeId, sessionId: original.sessionId },
      RAM_PURPOSE,
      original.expiresAtEpochMs,
      original
    );
  }
  captureRamGpuRequest(request: FastifyRequest, employeeId: string, value: EmployeeGpuIntent): RamGpuRequestContext {
    need(UUID.test(employeeId) && employeeId !== NIL_UUID);
    const selected = EmployeeGpuIntentData.parse(value);
    const approval = Object.freeze({ ...selected, expected: Object.freeze(selected.expected) });
    return this.#capture(
      request,
      { stage: 'gpu-request' as const, employeeId, approval },
      RAM_PURPOSE,
      Date.now() + 35_000
    );
  }
  captureRamGpuApply(request: FastifyRequest, employeeId: string, value: EmployeeGpuApply): RamGpuApplyContext {
    need(UUID.test(employeeId) && employeeId !== NIL_UUID);
    const approval = Object.freeze(EmployeeGpuApplyData.parse(value));
    return this.#capture(
      request,
      { stage: 'gpu-apply' as const, employeeId, approval },
      RAM_PURPOSE,
      Date.now() + 35_000
    );
  }
  captureRamEmployeePolicyEdit(
    request: FastifyRequest,
    employeeId: string,
    value: EmployeePolicyEditApproval
  ): RamEmployeePolicyEditContext {
    need(UUID.test(employeeId) && employeeId !== NIL_UUID);
    const approval = EmployeePolicyEditApproval.parse(value);
    return this.#capture(request, { stage: 'employee-policy-edit' as const, employeeId, approval }, RAM_PURPOSE);
  }
  consumeEmployeePolicyEdit(context: RamEmployeePolicyEditContext): void {
    this.assertContext(context);
    need(context.stage === 'employee-policy-edit' && !this.#submittedEmployeePolicies.has(context));
    this.#submittedEmployeePolicies.add(context);
  }
  capturePoolInstallationViewer(request: FastifyRequest): PoolInstallationViewerContext {
    return this.#capture(
      request,
      { stage: 'viewer' as const, requestId: randomUUID() },
      POOL_INSTALLATION_CONSENT_PURPOSE
    );
  }
  captureFleetViewer(request: FastifyRequest): FleetViewerContext {
    return this.#capture(
      request,
      { stage: 'fleet-viewer' as const, requestId: randomUUID() },
      FLEET_MAINTENANCE_PURPOSE
    );
  }
  captureFleetPreview(
    request: FastifyRequest,
    viewer: FleetViewerContext,
    approval: FleetApproval,
    expires: number
  ): FleetPreviewContext {
    this.assertContext(viewer);
    need(viewer.purpose === FLEET_MAINTENANCE_PURPOSE && viewer.stage === 'fleet-viewer');
    need(
      Object.keys(approval).sort().join(',') ===
        'cohortDigest,coverageDigest,operationId,poolPolicyDigest,previewId,revisionDigest'
    );
    for (const name of ['operationId', 'previewId'] as const)
      need(UUID.test(approval[name]) && approval[name] !== NIL_UUID);
    for (const name of ['cohortDigest', 'coverageDigest', 'poolPolicyDigest', 'revisionDigest'] as const)
      need(HEX.test(approval[name]));
    need(Number.isSafeInteger(expires) && expires > Date.now());
    const context = this.#capture(
      request,
      {
        stage: 'fleet-preview' as const,
        requestId: viewer.requestId,
        approval: Object.freeze({ ...approval }),
      },
      FLEET_MAINTENANCE_PURPOSE,
      Math.min(expires, viewer.expiresAtEpochMs),
      viewer
    );
    this.#fleetViews.set(context, viewer);
    return context;
  }
  captureFleetMigration(request: FastifyRequest, preview: FleetPreviewContext): FleetMigrationContext {
    const viewer = this.#fleetViews.get(preview);
    need(viewer && !this.#consentedFleetViews.has(preview));
    this.assertContext(preview);
    need(preview.purpose === FLEET_MAINTENANCE_PURPOSE && preview.stage === 'fleet-preview');
    const body = request.body;
    need(body && typeof body === 'object' && !Array.isArray(body));
    need(Object.keys(body).sort().join(',') === 'consent,expectedRevision,previewId,verb');
    const value = body as Record<string, unknown>;
    need(
      value.consent === true &&
        value.verb === 'migrate-pool' &&
        value.previewId === preview.approval.previewId &&
        value.expectedRevision === preview.approval.revisionDigest
    );
    // The preview window gates this one consent. Subsequent challenges use
    // the SAME original viewer deadline and scope, never a fresh five minutes.
    const context = this.#capture(
      request,
      {
        stage: 'fleet-migration' as const,
        verb: 'migrate-pool' as const,
        consent: true as const,
        requestId: preview.requestId,
        approval: preview.approval,
      },
      FLEET_MAINTENANCE_PURPOSE,
      viewer.expiresAtEpochMs,
      viewer
    );
    this.assertSameSession(preview, context);
    this.#consentedFleetViews.add(preview);
    return context;
  }
  assertFleetSession(request: FastifyRequest, context: FleetViewerContext): void {
    need(
      this.#contexts.has(context) && context.purpose === FLEET_MAINTENANCE_PURPOSE && context.stage === 'fleet-viewer'
    );
    this.#assertOriginalSession(request, context);
  }
  capturePoolInstallationOffer(
    request: FastifyRequest,
    nominated: PoolInstallationOfferData,
    viewer?: PoolInstallationViewerContext,
    offerExpiry?: number
  ): PoolInstallationOfferContext {
    need(Object.keys(nominated).sort().join(',') === 'offerNonce,principal,requestDigest');
    need(
      typeof nominated.offerNonce === 'string' &&
        UUID.test(nominated.offerNonce) &&
        nominated.offerNonce !== NIL_UUID &&
        typeof nominated.requestDigest === 'string' &&
        HEX.test(nominated.requestDigest) &&
        nominated.principal &&
        Object.keys(nominated.principal).sort().join(',') === 'accountId,personId,sessionEpoch'
    );
    if (viewer) {
      this.assertContext(viewer);
      need(viewer.purpose === POOL_INSTALLATION_CONSENT_PURPOSE && viewer.stage === 'viewer');
    }
    if (offerExpiry !== undefined) need(Number.isSafeInteger(offerExpiry) && offerExpiry > Date.now());
    const context = this.#capture(
      request,
      {
        stage: 'offer' as const,
        requestId: viewer?.requestId ?? randomUUID(),
        offerNonce: nominated.offerNonce,
        requestDigest: nominated.requestDigest,
      },
      POOL_INSTALLATION_CONSENT_PURPOSE,
      Math.min(viewer?.expiresAtEpochMs ?? Number.MAX_SAFE_INTEGER, offerExpiry ?? Number.MAX_SAFE_INTEGER)
    );
    if (viewer) this.assertSameSession(viewer, context);
    need(
      context.principal.accountId === nominated.principal.accountId &&
        context.principal.personId === nominated.principal.personId &&
        context.principal.sessionEpoch === nominated.principal.sessionEpoch
    );
    this.#poolViews.add(context);
    return context;
  }
  capturePoolInstallationConsent(
    request: FastifyRequest,
    viewed: PoolInstallationOfferContext
  ): PoolInstallationConsentContext {
    need(this.#poolViews.has(viewed) && !this.#consentedPoolViews.has(viewed));
    this.assertContext(viewed);
    need(viewed.purpose === POOL_INSTALLATION_CONSENT_PURPOSE && viewed.stage === 'offer');
    const body = request.body;
    need(body && typeof body === 'object' && !Array.isArray(body));
    need(Object.keys(body).sort().join(',') === 'consent,offerNonce,requestDigest');
    const selected = body as Record<string, unknown>;
    need(
      selected.consent === true &&
        selected.offerNonce === viewed.offerNonce &&
        selected.requestDigest === viewed.requestDigest
    );
    const context = this.#capture(
      request,
      {
        stage: 'consent' as const,
        consent: true as const,
        requestId: viewed.requestId,
        offerNonce: viewed.offerNonce,
        requestDigest: viewed.requestDigest,
      },
      POOL_INSTALLATION_CONSENT_PURPOSE,
      viewed.expiresAtEpochMs
    );
    this.assertSameSession(viewed, context);
    need(
      context.principal.accountId === viewed.principal.accountId &&
        context.principal.personId === viewed.principal.personId &&
        context.principal.sessionEpoch === viewed.principal.sessionEpoch
    );
    // Only the original authenticated session can consume this private view.
    // A guest or another cookie cannot consume it by attempting a POST.
    this.#consentedPoolViews.add(viewed);
    viewed.assertCurrent();
    return context;
  }
  /** Read-only recovery lookup. Does not revive an expired action context or
   * authorize a new connection/consent/effect. */
  assertPoolInstallationSession(request: FastifyRequest, context: PoolInstallationViewerContext): void {
    need(
      this.#contexts.has(context) && context.purpose === POOL_INSTALLATION_CONSENT_PURPOSE && context.stage === 'viewer'
    );
    this.#assertOriginalSession(request, context);
  }
  #assertOriginalSession(request: FastifyRequest, context: PoolInstallationViewerContext | FleetViewerContext): void {
    const source = this.#sessions.get(context),
      token = request.cookies?.[OWNER_COOKIE];
    need(
      source && typeof token === 'string' && token === source.token && this.#auth.forSession(token) === source.account
    );
    const current = this.#identity(request, token, context.purpose).principal;
    need(
      current &&
        current.accountId === context.principal.accountId &&
        current.personId === context.principal.personId &&
        current.sessionEpoch === context.principal.sessionEpoch
    );
  }
  requestOwner(request: FastifyRequest): string | undefined {
    const token = request.cookies?.[OWNER_COOKIE];
    need(typeof token === 'string' && token.length > 0 && token.length <= 4096);
    this.#identity(request, token);
    return ownerFor(request);
  }
  #capture<
    P extends ResourcePurpose,
    T extends
      | { stage: 'apply'; approval: Readonly<ResourceApproval> }
      | { stage: 'preview'; employeeId: string }
      | { stage: 'status'; employeeId: string }
      | { stage: 'employee-memory-diagnostics'; employeeId: string; sessionId: string }
      | { stage: 'gpu-status' | 'gpu-apply-status'; employeeId: string; sessionId: string }
      | { stage: 'gpu-request'; employeeId: string; approval: Readonly<EmployeeGpuIntent> }
      | { stage: 'gpu-apply'; employeeId: string; approval: Readonly<EmployeeGpuApply> }
      | { stage: 'employee-policy-edit'; employeeId: string; approval: EmployeePolicyEditApproval }
      | {
          stage: 'employee-recovery' | 'employee-recovery-observe';
          employeeId: string;
          approval: EmployeeRecoveryApproval;
        }
      | { stage: 'viewer' | 'fleet-viewer'; requestId: string }
      | (PoolInstallationSelection & ({ stage: 'offer' } | { stage: 'consent'; consent: true }))
      | { stage: 'fleet-preview'; requestId: string; approval: Readonly<FleetApproval> }
      | {
          stage: 'fleet-migration';
          requestId: string;
          verb: 'migrate-pool';
          consent: true;
          approval: Readonly<FleetApproval>;
        },
  >(
    request: FastifyRequest,
    selected: T,
    purpose: P,
    originalExpiry?: number,
    origin?: AuthorityContext
  ): Readonly<ResourceContext<P> & T> &
    PrincipalFor<P> &
    (T extends { stage: 'employee-recovery' | 'employee-recovery-observe' }
      ? { readonly recoveryAuthority: EmployeeRecoveryAuthority }
      : object) {
    const token = request.cookies?.[OWNER_COOKIE];
    need(typeof token === 'string' && token.length > 0 && token.length <= 4096);
    const access =
      selected.stage === 'status' ||
      selected.stage === 'employee-memory-diagnostics' ||
      selected.stage === 'gpu-status' ||
      selected.stage === 'gpu-apply-status'
        ? 'employee-status'
        : 'operation';
    const identity = this.#identity(request, token, purpose, access),
      owner = ownerFor(request);
    if (origin) {
      this.assertContext(origin);
      need(origin.purpose === purpose);
    }
    const issued = Date.now(),
      window =
        selected.stage === 'employee-recovery' || selected.stage === 'employee-recovery-observe' ? 10_000 : 300_000,
      expires = Math.min(issued + window, originalExpiry ?? issued + window);
    need(Number.isSafeInteger(issued) && Number.isSafeInteger(expires) && expires > issued);
    const assertCurrent = () => {
      need(
        this.#contexts.has(context) &&
          Date.now() >= issued &&
          Date.now() < expires &&
          this.#identity(request, token, purpose, access).key === identity.key
      );
    };
    const context = Object.freeze({
      purpose,
      owner,
      ownerScopeDigest:
        origin?.ownerScopeDigest ?? digest(this.#epoch + identity.key + randomBytes(32).toString('hex')),
      ...(identity.principal === undefined ? {} : { principal: identity.principal }),
      ...selected,
      ...(selected.stage === 'employee-recovery' || selected.stage === 'employee-recovery-observe'
        ? { recoveryAuthority: Object.freeze({ kind: 'human-owner' as const, principal: identity.principal! }) }
        : {}),
      expiresAtEpochMs: expires,
      assertCurrent,
      toJSON: () => {
        throw new Error('Resource owner context is server-private');
      },
      [inspect.custom]: () => '[Private resource owner context]',
    }) as Readonly<ResourceContext<P> & T> &
      PrincipalFor<P> &
      (T extends { stage: 'employee-recovery' | 'employee-recovery-observe' }
        ? { readonly recoveryAuthority: EmployeeRecoveryAuthority }
        : object);
    this.#contexts.add(context);
    this.#sessions.set(context, { account: this.#auth.forSession(token), token });
    assertCurrent();
    if (origin) this.#sameSession(origin, context);
    return context;
  }
  assertContext(context: AuthorityContext): void {
    need(this.#contexts.has(context));
    if (
      (context.stage === 'employee-recovery' || context.stage === 'employee-recovery-observe') &&
      Date.now() >= context.expiresAtEpochMs
    )
      throw new ResourceRecoveryWindowExpiredError();
    if (context.stage === 'employee-recovery' || context.stage === 'employee-recovery-observe') {
      const attempt = this.#recoveryAttempts.get(context);
      need(attempt);
      // This exact original Attempt performs the SAME current-context check.
      // Repeating context.assertCurrent immediately before it adds no fence.
      EmployeeRecoveryAttempt.prototype.assertContext.call(attempt, this, context);
    } else context.assertCurrent();
  }
  /** Staging auth only: no native dispatch/transport admission is supplied. */
  assertRecoveryAuthentication(context: RamEmployeeRecoveryContext): void {
    need(
      !this.#closed &&
        this.#contexts.has(context) &&
        (context.stage === 'employee-recovery' || context.stage === 'employee-recovery-observe')
    );
    if (Date.now() >= context.expiresAtEpochMs) throw new ResourceRecoveryWindowExpiredError();
    context.assertCurrent();
  }
  assertEmployeeRecoveryDomain(context: RamEmployeeRecoveryContext, company: CompanyService): void {
    need(!this.#closed && this.#contexts.has(context));
    if (context.recoveryAuthority.kind === 'delegated-service') {
      need(this.services && this.#officeActions);
      assertServiceAuthorization(this.services, company.store);
      const proof = this.#recoveryOfficeProofs.get(context);
      need(proof);
      const original = this.#recoveryCompanies.get(context);
      need(!original || original === company);
      // Join this original domain first. The one fresh check below calls the
      // publisher's actual assertOriginal, which checks proof/current/domain
      // together; assertDomain itself already includes full authentication.
      this.#recoveryCompanies.set(context, company);
    }
    this.assertRecoveryAuthentication(context);
  }
  bindEmployeeRecoveryAttempt(context: RamEmployeeRecoveryContext, attempt: EmployeeRecoveryAttempt): void {
    need(this.#contexts.has(context) && !this.#recoveryAttempts.has(context));
    // The actual original Attempt verifies its context, expiry and authority.
    EmployeeRecoveryAttempt.prototype.assertContext.call(attempt, this, context);
    this.#recoveryAttempts.set(context, attempt);
  }
  consumeEmployeeRecovery(context: RamEmployeeRecoveryContext): void {
    need(this.#contexts.has(context));
    const attempt = this.#recoveryAttempts.get(context);
    need(attempt);
    // claimDispatch performs that same fresh original-context check immediately
    // before the one-use dispatch claim, without an intervening callback/await.
    EmployeeRecoveryAttempt.prototype.claimDispatch.call(attempt, this, context);
  }
  assertSameSession(left: AuthorityContext, right: AuthorityContext): void {
    this.assertContext(left);
    this.assertContext(right);
    this.#sameSession(left, right);
  }
  #sameSession(left: ResourceContext<ResourcePurpose>, right: ResourceContext<ResourcePurpose>): void {
    const a = this.#sessions.get(left),
      b = this.#sessions.get(right);
    need(
      a &&
        b &&
        a.account === b.account &&
        a.token === b.token &&
        left.owner === right.owner &&
        left.purpose === right.purpose
    );
  }
  bind(context: ResourceOwnerContext): ResourceOwnerBinding {
    this.assertContext(context);
    need(context.stage === 'apply' && context.purpose === PURPOSE);
    return new ResourceOwnerBinding(MINT, context);
  }
  bindRam(context: RamResourceOwnerContext): RamResourceOwnerBinding {
    this.assertContext(context);
    need(context.stage === 'apply' && context.purpose === RAM_PURPOSE);
    return new RamResourceOwnerBinding(MINT, context);
  }
  track(context: AuthorityContext, socket: Socket): () => void {
    this.assertContext(context);
    need(socket instanceof Socket && !socket.destroyed);
    if (this.#serviceContexts.has(context)) {
      need(context.stage === 'employee-recovery' || context.stage === 'employee-recovery-observe');
      this.#serviceChannels.set(socket, (this.#serviceChannels.get(socket) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (this.#serviceChannels.get(socket) ?? 1) - 1;
        if (left) this.#serviceChannels.set(socket, left);
        else this.#serviceChannels.delete(socket);
      };
    }
    const source = this.#sessions.get(context);
    need(source);
    const channels = this.#channels.get(socket) ?? new Map<string, { account: OwnerAuthService; count: number }>();
    const held = channels.get(source.token) ?? { account: source.account, count: 0 };
    need(held.account === source.account);
    if (held.count++ === 0) source.account.track(source.token, socket);
    channels.set(source.token, held);
    this.#channels.set(socket, channels);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.count === 0) {
        source.account.untrack(source.token, socket);
        channels.delete(source.token);
      }
      if (!channels.size) this.#channels.delete(socket);
    };
  }
}
