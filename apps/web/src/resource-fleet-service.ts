/** Fleet application boundary. Host installation and effect authority are separate. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CompanyService } from './company-service.js';
import type { OwnerVerifier } from './owner-auth/marks.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ResourceOwnerAuthorizationError } from './resource-owner-authority.js';
import { FleetNativeService, type FleetEmployeeRecovery } from './resource-fleet-native-service.js';
import { FleetRecoveryHistory, FleetRecoveryRequest } from './resource-fleet-recovery.js';
import { FleetOperationStore } from './resource-fleet-operation-store.js';
import { NativeFleetMigrationFailureError } from './resource-fleet-native-client.js';
import {
  NativeFleetPreviewRequest,
  NativeFleetApplyRequest,
  NativeFleetResultRequest,
} from './resource-fleet-native-data.js';
import { sameOrigin, SERVICE_HEADER } from './owner-auth/policy.js';
import { ownerFor } from './web/route-helpers.js';
import {
  FleetApplyRequestSchema,
  FleetPreviewRequestSchema,
  FleetResultRequestSchema,
  type FleetBlocker,
  type FleetStatus,
} from './types/resource-fleet.js';

const HOST_SETUP: FleetBlocker = Object.freeze({
  code: 'FLEET_HOST_SETUP_REQUIRED',
  message: 'Live fleet status and routine resource edits are unavailable in this build.',
  remedy:
    'Shared-pool setup and employee recovery are reported separately. This status query cannot verify running limits.',
});

/** The server cannot infer cgroup enforcement or image identity from employee settings. */
export class FleetResourcesService {
  readonly native?: FleetNativeService;
  constructor(
    private readonly company: CompanyService,
    auth?: OwnerAuthService,
    socket?: string,
    recovery?: FleetEmployeeRecovery,
    recoveryHistoryPath?: string,
    operationHistoryPath?: string
  ) {
    if (auth)
      this.native = new FleetNativeService(
        company,
        auth,
        socket,
        recovery,
        recoveryHistoryPath ? new FleetRecoveryHistory(recoveryHistoryPath) : undefined,
        operationHistoryPath ? new FleetOperationStore(operationHistoryPath) : undefined
      );
  }
  close(): void {
    this.native?.close();
  }

  status(owner: string | undefined): FleetStatus {
    return {
      version: 1,
      revision: null,
      canPreview: false,
      blockers: [HOST_SETUP],
      images: [],
      pool: { desired: null, observed: null },
      employees: this.company.view(owner).employees.map((employee) => ({
        employeeId: employee.id,
        name: employee.name,
        state: employee.onVacation ? 'vacation' : employee.desiredRunning === false ? 'off' : 'unverified',
        reason: 'No live resource observation is available from this server.',
        desired: null,
        observed: null,
        desiredImageId: null,
        observedImageId: null,
      })),
      operations: null,
      unmanagedLaptops: null,
    };
  }
}

/** Installed-host support remains unavailable until its real authenticated adapter exists.
 * Routes still enforce their own owner proof even if the global policy is disabled.
 * No body, token-shaped string, guest or organizational role supplies that proof.
 */
export function registerFleetResourceRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  service: FleetResourcesService
): void {
  const authorize = (request: FastifyRequest): boolean =>
    verifiedOwner(request) &&
    request.headers.authorization === undefined &&
    request.headers[SERVICE_HEADER] === undefined &&
    !Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-')) &&
    (request.method === 'GET' || sameOrigin(request));
  app.get('/api/company/resources/fleet', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!authorize(request))
      return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
    return { success: true, data: service.status(ownerFor(request)) };
  });
  const mutations = [
    ['preview', FleetPreviewRequestSchema],
    ['apply', FleetApplyRequestSchema],
    ['result', FleetResultRequestSchema],
  ] as const;
  for (const [action, schema] of mutations) {
    app.post(`/api/company/resources/fleet/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!authorize(request))
        return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
      const body = schema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ success: false, error: 'Invalid fleet request' });
      // No preview/operation IDs are manufactured when no actual host owns
      // them. In particular, an unavailable result never clears a prior fence.
      return reply
        .code(503)
        .send({ success: false, error: HOST_SETUP.message, code: HOST_SETUP.code, remedy: HOST_SETUP.remedy });
    });
  }
  const native = [
    ['preview', NativeFleetPreviewRequest],
    ['apply', NativeFleetApplyRequest],
    ['result', NativeFleetResultRequest],
    ['reconcile', FleetRecoveryRequest],
  ] as const;
  app.post('/api/company/resources/fleet/native-operations', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!authorize(request))
      return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
    if (!NativeFleetPreviewRequest.safeParse(request.body).success)
      return reply.code(400).send({ success: false, error: 'Invalid fleet history request' });
    if (!service.native)
      return reply.code(503).send({ success: false, error: 'Fleet operation history is unavailable' });
    try {
      return { success: true, data: await service.native.operationHistory(request) };
    } catch (error) {
      return reply.code(error instanceof ResourceOwnerAuthorizationError ? 403 : 503).send({
        success: false,
        error: 'Original fleet operation history is unavailable',
      });
    }
  });
  for (const [action, schema] of native) {
    app.post(`/api/company/resources/fleet/native-${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!authorize(request))
        return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
      if (!schema.safeParse(request.body).success)
        return reply.code(400).send({ success: false, error: 'Invalid native fleet request' });
      if (!service.native)
        return reply.code(503).send({ success: false, code: HOST_SETUP.code, error: HOST_SETUP.message });
      try {
        const data =
          action === 'preview'
            ? await service.native.preview(request)
            : action === 'apply'
              ? await service.native.apply(request)
              : action === 'reconcile'
                ? await service.native.reconcile(request)
                : await service.native.result(request);
        return { success: true, data };
      } catch (error) {
        if (error instanceof ResourceOwnerAuthorizationError)
          return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
        const nativeCode =
          error instanceof NativeFleetMigrationFailureError &&
          error.outcome === 'unconfirmed' &&
          typeof error.code === 'string' &&
          /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
            ? error.code
            : undefined;
        return reply.code(503).send({
          success: false,
          code: nativeCode ?? 'FLEET_NATIVE_OUTCOME_UNCONFIRMED',
          outcome: 'unconfirmed',
          error: 'Original native fleet outcome is unavailable. Inspect the original operation; do not replay it.',
        });
      }
    });
  }
}
