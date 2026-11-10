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
import { EmployeeGpuIntentData, type EmployeeGpuIntent } from './employee-gpu-data.js';

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
export interface RamGpuStatusContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'gpu-status';
  readonly employeeId: string;
  readonly sessionId: string;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
export interface RamGpuRequestContext extends ResourceContext<typeof RAM_PURPOSE> {
  readonly stage: 'gpu-request';
  readonly employeeId: string;
  readonly approval: Readonly<EmployeeGpuIntent>;
  readonly principal: Readonly<ResourceOwnerPrincipal>;
}
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
  | RamGpuStatusContext
  | RamGpuRequestContext;
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
  readonly #poolViews = new WeakSet<object>();
  readonly #consentedPoolViews = new WeakSet<object>();
  readonly #fleetViews = new WeakMap<FleetPreviewContext, FleetViewerContext>();
  readonly #consentedFleetViews = new WeakSet<object>();
  readonly #sessions = new WeakMap<object, { account: OwnerAuthService; token: string }>();
  readonly #channels = new Map<Socket, Map<string, { account: OwnerAuthService; count: number }>>();
  #closed = false;
  constructor(auth: OwnerAuthService) {
    need(auth instanceof OwnerAuthService);
    this.#auth = auth;
  }
  close(): void {
    this.#closed = true;
    for (const socket of this.#channels.keys()) socket.destroy();
    this.#channels.clear();
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
  captureRamGpuStatus(request: FastifyRequest, employeeId: string, sessionId: string): RamGpuStatusContext {
    need(UUID.test(employeeId) && employeeId !== NIL_UUID && UUID.test(sessionId) && sessionId !== NIL_UUID);
    return this.#capture(
      request,
      { stage: 'gpu-status' as const, employeeId, sessionId },
      RAM_PURPOSE,
      Date.now() + 35_000
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
      | { stage: 'gpu-status'; employeeId: string; sessionId: string }
      | { stage: 'gpu-request'; employeeId: string; approval: Readonly<EmployeeGpuIntent> }
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
  ): Readonly<ResourceContext<P> & T> & PrincipalFor<P> {
    const token = request.cookies?.[OWNER_COOKIE];
    need(typeof token === 'string' && token.length > 0 && token.length <= 4096);
    const access = selected.stage === 'status' || selected.stage === 'gpu-status' ? 'employee-status' : 'operation';
    const identity = this.#identity(request, token, purpose, access),
      owner = ownerFor(request);
    if (origin) {
      this.assertContext(origin);
      need(origin.purpose === purpose);
    }
    const issued = Date.now(),
      expires = Math.min(issued + 300_000, originalExpiry ?? issued + 300_000);
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
      expiresAtEpochMs: expires,
      assertCurrent,
      toJSON: () => {
        throw new Error('Resource owner context is server-private');
      },
      [inspect.custom]: () => '[Private resource owner context]',
    }) as Readonly<ResourceContext<P> & T> & PrincipalFor<P>;
    this.#contexts.add(context);
    this.#sessions.set(context, { account: this.#auth.forSession(token), token });
    assertCurrent();
    if (origin) this.#sameSession(origin, context);
    return context;
  }
  assertContext(context: AuthorityContext): void {
    need(this.#contexts.has(context));
    context.assertCurrent();
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
