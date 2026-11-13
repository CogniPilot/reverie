/** One original Office source/configured-grant publication boundary.
 * The private proof is not a native capability or a human login.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CompanyStore } from './company-store.js';
import {
  EmployeeRecoveryApproval,
  EmployeeRecoveryGrantRef,
  EmployeeRecoveryRequest,
  EmployeeRecoverySelectionRequest,
} from './employee-recovery-operation.js';
import { NativeOwnerId, NativeOwnerPrincipal } from './native-owner-data.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { officeServiceEmployee } from './service-auth-config.js';
import { SERVICE_ASSERTION_HEADER } from './service-decision.js';
import { assertServiceAuthorization, type ServiceAuthorization } from './service-authorization.js';
import {
  ServiceGrantAuthentication,
  signServiceAssertion,
  SERVICE_ASSERTION_MAX_LIFETIME_MS,
} from './service-grant-auth.js';
import { WorkerRecoveryAuthentication, RECOVERY_HEADER } from './worker-recovery-auth.js';

const MetadataBody = z
  .object({
    employeeId: NativeOwnerId,
    writerId: NativeOwnerId,
    expectedIncidentId: NativeOwnerId,
    grantRef: EmployeeRecoveryGrantRef,
  })
  .strict();
const Selection = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('employee-recovery-selection'),
      employeeId: NativeOwnerId,
      grantRef: EmployeeRecoveryGrantRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('employee-recovery'),
      employeeId: NativeOwnerId,
      access: z.enum(['effect', 'observe']),
      approval: EmployeeRecoveryApproval,
      grantRef: EmployeeRecoveryGrantRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('mux-metadata-reconcile'),
      employeeId: NativeOwnerId,
      resourceId: z.string().regex(/^mux-metadata:[a-f0-9]{64}$/),
      grantRef: EmployeeRecoveryGrantRef,
    })
    .strict(),
]);
export type OfficeScopedActionSelection = z.infer<typeof Selection>;
export type OfficeScopedActionName =
  | 'reverie.ops.employee.reconcile-owned'
  | 'reverie.ops.employee.stop-provider'
  | 'reverie.ops.employee.close-viewer'
  | 'reverie.ops.mux-metadata.reconcile';
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
function need(value: unknown): asserts value {
  if (!value) throw new Error('Office scoped action authority is unavailable or changed');
}

/** Returned only by the actual source/configuration/grant join below. */
export interface OfficeScopedAction {
  readonly owner: string | undefined;
  readonly source: Readonly<{ employeeId: string; sessionId: string; sessionGeneration: string }>;
  readonly ownerRegistration: Readonly<z.infer<typeof NativeOwnerPrincipal>>;
  readonly service: Readonly<{ principal: string; issuerEpoch: string; grantId: string; grantGeneration: string }>;
  readonly action: OfficeScopedActionName;
  readonly resourceId: string;
  readonly expiresAtEpochMs: number;
  readonly scopeDigest: string;
  assertCurrent(): void;
  /** Genuine grants from another canonical store cannot authorize this domain. */
  assertDomain(store: CompanyStore): void;
}

export class OfficeScopedActionPublisher {
  readonly #epoch = randomUUID();
  readonly #captures = new WeakMap<FastifyRequest, { key: string; flight: Promise<OfficeScopedAction> }>();
  readonly #proofs = new WeakSet<OfficeScopedAction>();
  readonly #services: ServiceAuthorization;
  readonly #recovery: WorkerRecoveryAuthentication;
  readonly #ownerAuth: OwnerAuthService;
  #closed = false;
  constructor(services: ServiceAuthorization, recovery: WorkerRecoveryAuthentication, ownerAuth: OwnerAuthService) {
    assertServiceAuthorization(services);
    need(recovery instanceof WorkerRecoveryAuthentication && ownerAuth instanceof OwnerAuthService);
    this.#services = services;
    this.#recovery = recovery;
    this.#ownerAuth = ownerAuth;
  }

  close(): void {
    this.#closed = true;
  }

  /** Checking an original proof cannot mint one from structural DATA. */
  assertOriginal(proof: OfficeScopedAction, store: CompanyStore): void {
    need(this.#proofs.has(proof));
    proof.assertDomain(store);
  }

  capture(request: FastifyRequest, input: OfficeScopedActionSelection): Promise<OfficeScopedAction> {
    const selected = Selection.parse(input);
    const key = digest([
      selected,
      request.method,
      request.url,
      request.body,
      typeof request.headers[RECOVERY_HEADER] === 'string' ? request.headers[RECOVERY_HEADER] : null,
    ]);
    const original = this.#captures.get(request);
    if (original) {
      need(original.key === key);
      return original.flight;
    }
    const flight = this.#capture(request, selected);
    this.#captures.set(request, { key, flight });
    return flight;
  }
  async #capture(request: FastifyRequest, selected: OfficeScopedActionSelection): Promise<OfficeScopedAction> {
    need(!this.#closed && request.method === 'POST');
    const services = this.#services;
    assertServiceAuthorization(services);
    need(
      request.headers[RECOVERY_HEADER] !== undefined &&
        request.headers.authorization === undefined &&
        request.headers['x-reverie-parent-session'] === undefined &&
        request.headers[SERVICE_ASSERTION_HEADER] === undefined
    );
    let action: OfficeScopedActionName, resourceId: string;
    if (selected.kind === 'employee-recovery') {
      const body = EmployeeRecoveryRequest.parse(request.body);
      need(digest(body.approval) === digest(selected.approval) && digest(body.grantRef) === digest(selected.grantRef));
      const suffix = `/api/company/employees/${selected.employeeId}/recovery${selected.access === 'observe' ? '/observe' : ''}`;
      need(request.url === suffix);
      action = `reverie.ops.employee.${selected.access === 'observe' ? 'reconcile-owned' : selected.approval.action}`;
      resourceId = 'employee-' + selected.employeeId;
    } else if (selected.kind === 'employee-recovery-selection') {
      const body = EmployeeRecoverySelectionRequest.parse(request.body);
      need(
        request.url === `/api/company/employees/${selected.employeeId}/recovery-selection` &&
          digest(body.grantRef) === digest(selected.grantRef)
      );
      action = 'reverie.ops.employee.reconcile-owned';
      resourceId = 'employee-' + selected.employeeId;
    } else {
      const body = MetadataBody.parse(request.body);
      need(
        request.url === '/api/mux/metadata/reconcile' &&
          body.employeeId === selected.employeeId &&
          digest(body.grantRef) === digest(selected.grantRef)
      );
      action = 'reverie.ops.mux-metadata.reconcile';
      resourceId = selected.resourceId; // Fixed by the retained writer, never a request path.
    }
    const purpose = services.loaded.purposeFor(action);
    need(purpose && services.loaded.purposes[purpose] === 'employees+resources');
    const source = await WorkerRecoveryAuthentication.prototype.authenticate.call(this.#recovery, request);
    const sourceCurrent = () => {
      source.assertCurrent();
      const original = services.source.binding(source.employeeId);
      need(
        original &&
          original.owner === source.owner &&
          original.sessionId === source.sessionId &&
          original.sessionGeneration === source.sessionGeneration
      );
    };
    sourceCurrent();
    const ownerRegistration = NativeOwnerPrincipal.parse(this.#ownerAuth.registeredResourceOwner(source.owner));
    need(
      Number.isSafeInteger(ownerRegistration.sessionEpoch) &&
        ownerRegistration.sessionEpoch > 0 &&
        Number.isSafeInteger(source.sessionGeneration) &&
        source.sessionGeneration > 0
    );
    const grants = services.source
      .grantsFor(purpose)
      .filter(
        (grant) =>
          grant.id === selected.grantRef.grantId &&
          grant.owner === source.owner &&
          grant.resources.includes(resourceId) &&
          officeServiceEmployee(services.loaded, grant.principal) === source.employeeId
      );
    need(grants.length === 1);
    const grant = grants[0]!,
      issuer = services.issuer(grant.principal),
      now = services.now();
    need(issuer && issuer.epoch === grant.epoch);
    const assertion = signServiceAssertion(issuer.key, {
      purpose,
      principal: grant.principal,
      epoch: issuer.epoch,
      ownerId: grant.owner ?? '',
      grantId: grant.id,
      issuedAt: now,
      expiresAt: Math.min(grant.expiresAt, now + SERVICE_ASSERTION_MAX_LIFETIME_MS),
      nonce: randomBytes(16).toString('hex'),
    });
    const lease =
      selected.kind === 'employee-recovery-selection'
        ? await ServiceGrantAuthentication.prototype.authenticateRecoverySelection.call(
            services.auth,
            { assertion },
            purpose
          )
        : selected.kind === 'employee-recovery'
          ? await ServiceGrantAuthentication.prototype.authenticateRecovery.call(
              services.auth,
              { assertion },
              purpose,
              selected.approval,
              selected.access
            )
          : await ServiceGrantAuthentication.prototype.authenticate.call(services.auth, { assertion }, purpose);
    need(
      lease && lease.grantId === selected.grantRef.grantId && lease.generation === selected.grantRef.policyGeneration
    );
    const owner = lease.ownerId === '' ? undefined : lease.ownerId;
    need(owner === source.owner && officeServiceEmployee(services.loaded, lease.principal) === source.employeeId);
    const expiresAtEpochMs = ServiceGrantAuthentication.prototype.leaseDeadline.call(services.auth, lease);
    const sourceData = Object.freeze({
      employeeId: source.employeeId,
      sessionId: source.sessionId,
      sessionGeneration: String(source.sessionGeneration),
    });
    const service = Object.freeze({
      principal: lease.principal,
      issuerEpoch: lease.epoch,
      grantId: lease.grantId,
      grantGeneration: lease.generation,
    });
    let revoked = false;
    const assertCurrent = () => {
      need(!revoked);
      try {
        need(!this.#closed);
        assertServiceAuthorization(services);
        sourceCurrent();
        need(services.loaded.purposeFor(action) === purpose);
        need(officeServiceEmployee(services.loaded, lease.principal) === source.employeeId);
        need(digest(this.#ownerAuth.registeredResourceOwner(owner)) === digest(ownerRegistration));
        need(lease.currentFor(selected.employeeId, resourceId));
        sourceCurrent();
      } catch (error) {
        revoked = true;
        throw error;
      }
    };
    const proof = Object.freeze({
      owner,
      source: sourceData,
      ownerRegistration,
      service,
      action,
      resourceId,
      expiresAtEpochMs,
      scopeDigest: digest([
        this.#epoch,
        services.loaded.digest,
        purpose,
        selected,
        owner ?? null,
        sourceData,
        ownerRegistration,
        service,
      ]),
      assertCurrent,
      assertDomain: (store: CompanyStore) => {
        assertCurrent();
        assertServiceAuthorization(services, store);
      },
      toJSON: () => {
        throw new Error('Office scoped action proof is server-private');
      },
      [inspect.custom]: () => '[Private Office scoped action proof]',
    });
    this.#proofs.add(proof);
    assertCurrent();
    return proof;
  }
}
