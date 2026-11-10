/** Profile GPU status and explicit queue intent on the original protected owner channel. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyService } from './company-service.js';
import { NO_OWNER, type OwnerVerifier } from './owner-auth/marks.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ownerFor } from './web/route-helpers.js';
import { ResourceNativeClient } from './resource-native-client.js';
import { ResourceOwnerAuthority, ResourceOwnerAuthorizationError } from './resource-owner-authority.js';
import {
  EmployeeGpuId,
  EmployeeGpuIntentData,
  EmployeeGpuStatus,
  type EmployeeGpuIntent,
  type EmployeeGpuStatusValue,
} from './employee-gpu-data.js';

export { EmployeeGpuStatus, type EmployeeGpuStatusValue } from './employee-gpu-data.js';

class GpuAccessError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
let activeCalls = 0;
export class EmployeeGpuClient {
  readonly #authority: ResourceOwnerAuthority;
  constructor(
    private readonly socketPath: string | undefined,
    auth: OwnerAuthService
  ) {
    this.#authority = new ResourceOwnerAuthority(auth);
  }
  close(): void {
    this.#authority.close();
  }
  async exchange(
    request: FastifyRequest,
    employeeId: string,
    sessionId: string,
    change?: EmployeeGpuIntent
  ): Promise<EmployeeGpuStatusValue> {
    const context = change
      ? this.#authority.captureRamGpuRequest(request, employeeId, change)
      : this.#authority.captureRamGpuStatus(request, employeeId, sessionId);
    if (!this.socketPath) throw new GpuAccessError(503, 'GPU host controls are unavailable.');
    if (activeCalls >= 4)
      throw new GpuAccessError(503, 'GPU host controls are busy. Refresh the status before trying again.');
    activeCalls++;
    let client: ResourceNativeClient | undefined;
    try {
      client = await ResourceNativeClient.openRam(this.socketPath, this.#authority, context);
      const status =
        context.stage === 'gpu-request'
          ? await client.request('gpu-request', { employeeId, approval: context.approval })
          : await client.request('gpu-status', { employeeId, sessionId });
      this.#authority.assertContext(context);
      return EmployeeGpuStatus.parse(status);
    } catch (error) {
      this.#authority.assertContext(context);
      if (error instanceof ResourceOwnerAuthorizationError) throw error;
      throw new GpuAccessError(503, 'GPU request or status was not confirmed. Refresh status before trying again.');
    } finally {
      client?.close();
      activeCalls--;
    }
  }
}

export function registerEmployeeGpuRoutes(
  app: FastifyInstance,
  company: CompanyService,
  client: EmployeeGpuClient,
  verifiedOwner: OwnerVerifier = NO_OWNER
): void {
  const binding = (request: FastifyRequest, id: string) => {
    if (!verifiedOwner(request)) throw new GpuAccessError(403, 'Only the company owner may manage laptop GPU access.');
    const employees = company.view(ownerFor(request)).employees.filter((employee) => employee.id === id);
    if (employees.length !== 1) throw new GpuAccessError(404, 'Unknown company employee.');
    return { sessionId: employees[0].sessionId, sessionGeneration: employees[0].sessionGeneration };
  };
  const run = async (request: FastifyRequest, update: boolean) => {
    const id = EmployeeGpuId.parse((request.params as { id: string }).id),
      before = binding(request, id);
    const change = update ? EmployeeGpuIntentData.parse(request.body) : undefined;
    if (
      change &&
      (change.expected.sessionId !== before.sessionId || change.expected.sessionGeneration !== before.sessionGeneration)
    )
      throw new GpuAccessError(409, 'This laptop binding changed. Refresh GPU status before requesting a change.');
    const status = await client.exchange(request, id, before.sessionId, change);
    const after = binding(request, id);
    if (
      status.employeeId !== id ||
      status.current.sessionId !== after.sessionId ||
      status.current.sessionGeneration !== after.sessionGeneration ||
      before.sessionId !== after.sessionId ||
      before.sessionGeneration !== after.sessionGeneration
    )
      throw new GpuAccessError(
        409,
        'This laptop binding changed. GPU status or request is not confirmed; refresh before trying again.'
      );
    if (
      change &&
      (!status.requested ||
        status.requested.enabled !== change.enabled ||
        status.requested.deviceUuid !== (change.deviceUuid ?? null) ||
        status.current.bindingDigest !== change.expected.bindingDigest ||
        status.revision !== change.expected.revision + 1 ||
        status.requested.revision !== status.revision)
    )
      throw new GpuAccessError(503, 'The GPU request was not confirmed. Refresh status before trying again.');
    return { success: true, data: { gpuAccess: status } };
  };
  for (const method of ['GET', 'POST'] as const)
    app.route({
      method,
      url: '/api/company/employees/:id/gpu-access',
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try {
          return await run(request, method === 'POST');
        } catch (error) {
          const code =
            error instanceof GpuAccessError
              ? error.statusCode
              : error instanceof ResourceOwnerAuthorizationError
                ? 403
                : error instanceof z.ZodError
                  ? 400
                  : 503;
          const message =
            error instanceof GpuAccessError
              ? error.message
              : code === 403
                ? 'Only the current company owner may manage laptop GPU access.'
                : code === 400
                  ? 'Invalid GPU request.'
                  : 'GPU host status is unavailable.';
          return reply.code(code).send({ success: false, error: message });
        }
      },
    });
}
