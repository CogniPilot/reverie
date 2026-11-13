/** Explicit metadata-only reconciliation. Saved observations confer no process authority. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyService } from './company-service.js';
import { EmployeeRecoveryGrantRef } from './employee-recovery-operation.js';
import {
  MuxMetadataPublicationUnconfirmedError,
  MuxMetadataReconciliationRefusedError,
} from './mux-session-metadata-store.js';
import { NativeOwnerId } from './native-owner-data.js';
import { OfficeScopedActionPublisher } from './office-scoped-action-publisher.js';
import type { OwnerVerifier } from './owner-auth/marks.js';
import { sameOrigin } from './owner-auth/policy.js';
import { TmuxManager } from './tmux-manager.js';
import { RECOVERY_HEADER } from './worker-recovery-auth.js';

const Selector = z.object({ writerId: NativeOwnerId, expectedIncidentId: NativeOwnerId }).strict();
const Delegated = Selector.extend({ employeeId: NativeOwnerId, grantRef: EmployeeRecoveryGrantRef }).strict();
const Request = z.union([Selector, Delegated]);
const transportProofs = new WeakSet<object>();
declare module 'fastify' {
  interface FastifyContextConfig {
    muxMetadataTransport?: unknown;
  }
}

/** A genuine registered route selector only. Its handler still authenticates every request. */
export function isMuxMetadataTransport(request: FastifyRequest, _basePath = ''): boolean {
  // WebServer strips its mount prefix before routing and authentication.
  // Only this original registered canonical route may enter its own verifier.
  const proof = request.routeOptions.config.muxMetadataTransport;
  return (
    !!proof &&
    typeof proof === 'object' &&
    transportProofs.has(proof) &&
    request.method === 'POST' &&
    request.url === '/api/mux/metadata/reconcile' &&
    request.routeOptions.url === '/api/mux/metadata/reconcile' &&
    typeof request.headers[RECOVERY_HEADER] === 'string'
  );
}

export class MuxMetadataReconciliationService {
  #closed = false;
  constructor(
    readonly manager: TmuxManager,
    readonly company: CompanyService,
    readonly verifiedOwner: OwnerVerifier,
    readonly publisher?: OfficeScopedActionPublisher
  ) {
    if (!(manager instanceof TmuxManager) || !(company instanceof CompanyService))
      throw Error('Metadata reconciliation requires the original application owners');
  }
  close(): void {
    this.#closed = true;
  }

  async reconcile(request: FastifyRequest) {
    const input = Request.parse(request.body);
    let current: () => boolean;
    if (!('employeeId' in input)) {
      current = () =>
        !this.#closed &&
        request.headers[RECOVERY_HEADER] === undefined &&
        request.headers['x-reverie-parent-session'] === undefined &&
        request.headers['x-reverie-service-token'] === undefined &&
        sameOrigin(request) &&
        this.verifiedOwner(request);
    } else {
      if (!this.publisher) throw Error('Metadata reconciliation authority unavailable');
      const publisher = this.publisher;
      const proof = await publisher.capture(request, {
        kind: 'mux-metadata-reconcile',
        employeeId: input.employeeId,
        resourceId: this.manager.muxMetadataResourceId(),
        grantRef: input.grantRef,
      });
      publisher.assertOriginal(proof, this.company.store);
      const target = this.company
        .registeredEmployees()
        .find((employee) => employee.id === input.employeeId && employee.owner === proof.owner);
      if (!target) throw Error('Metadata reconciliation target unavailable');
      const action = this.company.recoveryAction(target.id, proof.owner, proof.source.sessionId);
      const originalRow = this.manager.getSession(target.sessionId);
      current = () => {
        if (this.#closed) return false;
        try {
          publisher.assertOriginal(proof, this.company.store);
          if (
            proof.action !== 'reverie.ops.mux-metadata.reconcile' ||
            proof.resourceId !== this.manager.muxMetadataResourceId() ||
            !action.current() ||
            !originalRow ||
            this.manager.getSession(target.sessionId) !== originalRow ||
            originalRow.owner !== proof.owner
          )
            return false;
          // A target-scoped grant cannot subset-overwrite the original global file.
          // Empty/mixed/missing-target selections require the verified global human owner.
          const rows = this.manager.getSessions();
          return rows.length > 0 && rows.every((row) => row.owner === proof.owner) && rows.includes(originalRow);
        } catch {
          return false;
        }
      };
    }
    if (!current()) throw Error('Metadata reconciliation authority unavailable');
    return this.manager.reconcileSessionMetadata(input, current);
  }
}

export function registerMuxMetadataReconciliation(
  app: FastifyInstance,
  service: MuxMetadataReconciliationService
): void {
  app.get('/api/mux/metadata/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { success: true, data: { muxMetadataPublication: service.manager.getMuxMetadataPublicationStatus() } };
  });
  const proof = Object.freeze({});
  transportProofs.add(proof);
  app.post('/api/mux/metadata/reconcile', { config: { muxMetadataTransport: proof } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const result = await service.reconcile(request);
      return { success: true, data: { muxMetadataPublication: result } };
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply.code(400).send({ success: false, error: 'Invalid metadata reconciliation selection' });
      if (error instanceof MuxMetadataReconciliationRefusedError)
        return reply.code(409).send({
          success: false,
          code: 'MUX_METADATA_SELECTION_CHANGED',
          error: 'Metadata reconciliation was refused. Refresh status before an explicit retry.',
        });
      if (error instanceof MuxMetadataPublicationUnconfirmedError)
        return reply.code(503).send({
          success: false,
          code: 'MUX_METADATA_UNCONFIRMED',
          error: 'Metadata reconciliation could not be confirmed. Refresh status; do not repeat the old write.',
        });
      return reply.code(403).send({ success: false, error: 'Current metadata reconciliation authority is required' });
    }
  });
}
