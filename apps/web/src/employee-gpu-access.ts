/** Profile GPU status and explicit queue intent on the original protected owner channel. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyService } from './company-service.js';
import { NO_OWNER, type OwnerVerifier } from './owner-auth/marks.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ownerFor } from './web/route-helpers.js';
import { ResourceNativeClient } from './resource-native-client.js';
import {
  ResourceOwnerAuthority,
  ResourceOwnerAuthorizationError,
  type RamGpuStatusContext,
  type RamGpuApplyStatusContext,
  type RamGpuRequestContext,
  type RamGpuApplyContext,
} from './resource-owner-authority.js';
import {
  EmployeeGpuId,
  EmployeeGpuApplyData,
  type EmployeeGpuApply,
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
type Selection =
  | { action: 'status' }
  | { action: 'request'; intent: EmployeeGpuIntent }
  | { action: 'apply'; approval: EmployeeGpuApply };
type GpuContext = RamGpuStatusContext | RamGpuApplyStatusContext | RamGpuRequestContext | RamGpuApplyContext;
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
    selection: Selection
  ): Promise<EmployeeGpuStatusValue> {
    const context =
      selection.action === 'request'
        ? this.#authority.captureRamGpuRequest(request, employeeId, selection.intent)
        : selection.action === 'apply'
          ? this.#authority.captureRamGpuApply(request, employeeId, selection.approval)
          : this.#authority.captureRamGpuStatus(request, employeeId, sessionId);
    if (!this.socketPath) throw new GpuAccessError(503, 'GPU host controls are unavailable.');
    if (activeCalls >= 4)
      throw new GpuAccessError(503, 'GPU host controls are busy. Refresh the status before trying again.');
    activeCalls++;
    try {
      const status = await this.#query(this.socketPath, context);
      if (
        context.stage === 'gpu-status' &&
        status.employeeId === context.employeeId &&
        status.current.sessionId === context.sessionId &&
        status.state === 'pending' &&
        status.active.running === false
      )
        return await this.#readiness(this.socketPath, request, context, status);
      return status;
    } catch (error) {
      this.#authority.assertContext(context);
      if (error instanceof ResourceOwnerAuthorizationError) throw error;
      throw new GpuAccessError(503, 'GPU request or status was not confirmed. Refresh status before trying again.');
    } finally {
      activeCalls--;
    }
  }
  async #query(path: string, context: GpuContext): Promise<EmployeeGpuStatusValue> {
    const client = await ResourceNativeClient.openRam(path, this.#authority, context);
    try {
      const { employeeId, stage } = context;
      const fields =
        stage === 'gpu-request' || stage === 'gpu-apply'
          ? { employeeId, approval: context.approval }
          : { employeeId, sessionId: context.sessionId };
      const status = EmployeeGpuStatus.parse(await client.request(stage, fields));
      this.#authority.assertContext(context);
      if ((stage === 'gpu-apply-status') !== (typeof status.canApply === 'boolean'))
        throw new GpuAccessError(503, 'GPU status did not match its native request.');
      return status;
    } finally {
      client.close();
    }
  }
  async #readiness(
    path: string,
    request: FastifyRequest,
    original: RamGpuStatusContext,
    status: EmployeeGpuStatusValue
  ): Promise<EmployeeGpuStatusValue> {
    const context = this.#authority.captureRamGpuApplyStatus(request, original);
    try {
      const fresh = await this.#query(path, context);
      this.#authority.assertContext(original);
      if (
        fresh.employeeId === status.employeeId &&
        fresh.current.sessionId === status.current.sessionId &&
        fresh.current.sessionGeneration === status.current.sessionGeneration
      )
        return fresh;
    } catch (error) {
      if (error instanceof ResourceOwnerAuthorizationError) throw error;
    }
    // Older peers can close the optional read before sending a refusal. The
    // original status remains usable only under its still-current owner.
    this.#authority.assertContext(original);
    return status;
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
  const run = async (request: FastifyRequest, action: Selection['action']) => {
    const id = EmployeeGpuId.parse((request.params as { id: string }).id),
      before = binding(request, id);
    const change = action === 'request' ? EmployeeGpuIntentData.parse(request.body) : undefined;
    const approval = action === 'apply' ? EmployeeGpuApplyData.parse(request.body) : undefined;
    const expected = change?.expected ?? approval;
    if (
      expected &&
      (expected.sessionId !== before.sessionId || expected.sessionGeneration !== before.sessionGeneration)
    )
      throw new GpuAccessError(409, 'This laptop binding changed. Refresh GPU status before requesting a change.');
    const selection: Selection = change
      ? { action: 'request', intent: change }
      : approval
        ? { action: 'apply', approval }
        : { action: 'status' };
    const status = await client.exchange(request, id, before.sessionId, selection);
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
    if (
      approval &&
      (status.state !== 'applied' ||
        status.revision !== approval.revision ||
        status.requested?.revision !== approval.revision ||
        status.requested?.deviceUuid !== approval.deviceUuid ||
        status.applied.known !== true ||
        status.applied.deviceUuid !== approval.deviceUuid ||
        status.active.running !== false)
    )
      throw new GpuAccessError(
        503,
        'Applying the saved GPU policy is unconfirmed. Refresh status before trying again.'
      );
    return { success: true, data: { gpuAccess: status } };
  };
  for (const [method, action, url] of [
    ['GET', 'status', '/api/company/employees/:id/gpu-access'],
    ['POST', 'request', '/api/company/employees/:id/gpu-access'],
    ['POST', 'apply', '/api/company/employees/:id/gpu-access/apply'],
  ] as const)
    app.route({
      method,
      url,
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try {
          return await run(request, action);
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
