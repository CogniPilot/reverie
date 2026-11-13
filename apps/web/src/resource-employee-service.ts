/** Thin owner-authenticated adapter to the actual installed native actor. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { performance } from 'node:perf_hooks';
import { CompanyService } from './company-service.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ResourceOwnerAuthority, ResourceOwnerAuthorizationError } from './resource-owner-authority.js';
import { ResourceNativeClient, ResourceNativeRefusal } from './resource-native-client.js';
import {
  EmployeePolicyEditApproval,
  EmployeePolicyEditResult,
  EmployeeResourceStatus,
  EmployeeMemoryDiagnostics,
  memoryPressureAdvisory,
  type EmployeeMemoryView,
} from './resource-employee-data.js';
import { NativeOwnerId } from './native-owner-data.js';
import { ownerFor } from './web/route-helpers.js';
import type { OwnerVerifier } from './owner-auth/marks.js';
import { SERVICE_HEADER } from './owner-auth/policy.js';

class EmployeePolicyRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const knownPolicyRefusals = new Map([
  ['EMPLOYEE_RESOURCE_REVISION_CHANGED', 'The running resource revision changed. Refresh the running limits.'],
  ['EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE', 'Live RAM and CPU changes are unavailable for this laptop.'],
  ['EMPLOYEE_RESOURCE_POLICY_UNCHANGED', 'The requested RAM and CPU limits are already set.'],
  ['EMPLOYEE_RESOURCE_POLICY_INVALID', 'The requested RAM or CPU limit is outside the supported policy.'],
  [
    'EMPLOYEE_RESOURCE_EDIT_REFUSED',
    'The native controller refused the RAM and CPU change. Refresh the running limits.',
  ],
  ['EMPLOYEE_RESOURCE_ACTIVE_OPERATION', 'A resource operation is already active. Refresh the running limits.'],
  ['RESERVATION_ADMISSION_LOCK_BUSY', 'The resource service is busy. Refresh the running limits.'],
]);

function unconfirmedEdit(): EmployeePolicyRouteError {
  return new EmployeePolicyRouteError(
    503,
    'EMPLOYEE_RESOURCE_EDIT_UNCONFIRMED',
    'The RAM and CPU change was not confirmed. Refresh the running limits before making another change.'
  );
}

function policyRefusal(reason: string): EmployeePolicyRouteError {
  if (reason === 'EMPLOYEE_RESOURCE_RECONCILIATION_REQUIRED')
    return new EmployeePolicyRouteError(
      503,
      reason,
      'The RAM and CPU change requires reconciliation. Refresh the running limits before making another change.'
    );
  const message = knownPolicyRefusals.get(reason);
  return message ? new EmployeePolicyRouteError(409, reason, message) : unconfirmedEdit();
}

export class EmployeeResourcesService {
  readonly #authority: ResourceOwnerAuthority;
  constructor(
    private readonly company: CompanyService,
    auth: OwnerAuthService,
    private readonly socket: string | undefined
  ) {
    if (!(company instanceof CompanyService) || !(auth instanceof OwnerAuthService))
      throw new Error('Employee resources require the actual company and owner services');
    this.#authority = new ResourceOwnerAuthority(auth);
  }
  close(): void {
    this.#authority.close();
  }
  #employee(request: FastifyRequest, employeeId: string) {
    return this.company.view(ownerFor(request)).employees.find((row) => row.id === employeeId);
  }
  #sameSession(request: FastifyRequest, employeeId: string, sessionId: string, generation: number): boolean {
    const current = this.#employee(request, employeeId);
    return current?.sessionId === sessionId && current.sessionGeneration === generation;
  }
  async memoryDiagnostics(request: FastifyRequest, employeeId: string): Promise<EmployeeMemoryView> {
    NativeOwnerId.parse(employeeId);
    const employee = this.#employee(request, employeeId);
    if (!employee || !this.socket || !Number.isSafeInteger(employee.sessionGeneration))
      throw new Error('The original employee binding and native resource service are required');
    const sessionId = NativeOwnerId.parse(employee.sessionId),
      generation = employee.sessionGeneration;
    const context = this.#authority.captureRamMemoryDiagnostics(request, employeeId, sessionId);
    const end = performance.now() + 10_000;
    const assertOriginal = () => {
      // Query expiry is unavailable data, not evidence that the owner logged out.
      // It never opens a fresh fallback window or acknowledges native settlement.
      if (performance.now() >= end || Date.now() >= context.expiresAtEpochMs)
        throw new Error('The original memory observation deadline elapsed');
      this.#authority.assertContext(context);
      if (!this.#sameSession(request, employeeId, sessionId, generation))
        throw new Error('The original employee binding changed during memory observation');
    };
    const base = { version: 1 as const, employeeId, sessionId, sessionGeneration: String(generation) };
    try {
      const client = await ResourceNativeClient.openRam(this.socket, this.#authority, context, end);
      try {
        const value = EmployeeMemoryDiagnostics.parse(
          await client.request('employee-memory-diagnostics', { employeeId, sessionId })
        );
        assertOriginal();
        if (
          value.employeeId !== employeeId ||
          value.sessionId !== sessionId ||
          value.sessionGeneration !== base.sessionGeneration
        )
          throw new Error('Memory observation belongs to a different employee binding');
        return {
          ...base,
          source: 'native-compound',
          resources: value.resources,
          diagnostics: { kind: 'snapshot', value },
          advisory: memoryPressureAdvisory(value, Date.now()),
        };
      } finally {
        client.close();
      }
    } catch {
      // A fresh, separately authenticated READ does not settle or replay the original Q owner.
      assertOriginal();
      const fallback = this.#authority.captureRamStatus(request, employeeId);
      const client = await ResourceNativeClient.openRam(this.socket, this.#authority, fallback, end);
      try {
        const resources = EmployeeResourceStatus.parse(
          await client.request('employee-status', { employeeId, sessionId })
        );
        this.#authority.assertContext(fallback);
        assertOriginal();
        if (resources.employeeId !== employeeId || resources.sessionId !== sessionId)
          throw new Error('The independent status read belongs to a different employee binding');
        return {
          ...base,
          source: 'independent-status-read',
          resources,
          diagnostics: { kind: 'unavailable', reason: 'native-observation-unconfirmed' },
          advisory: memoryPressureAdvisory(null, Date.now()),
        };
      } finally {
        client.close();
      }
    }
  }
  async status(request: FastifyRequest, employeeId: string): Promise<EmployeeResourceStatus> {
    NativeOwnerId.parse(employeeId);
    const context = this.#authority.captureRamStatus(request, employeeId);
    const employee = this.#employee(request, employeeId);
    if (!employee || !this.socket) throw new Error('The current employee and native resource service are required');
    const sessionId = NativeOwnerId.parse(employee.sessionId);
    const client = await ResourceNativeClient.openRam(this.socket, this.#authority, context);
    try {
      const data = EmployeeResourceStatus.parse(await client.request('employee-status', { employeeId, sessionId }));
      this.#authority.assertContext(context);
      if (
        data.employeeId !== employeeId ||
        data.sessionId !== sessionId ||
        !this.#sameSession(request, employeeId, sessionId, employee.sessionGeneration)
      )
        throw new Error('The original employee session changed during resource observation');
      return data;
    } finally {
      client.close();
    }
  }
  async edit(
    request: FastifyRequest,
    employeeId: string,
    approval: EmployeePolicyEditApproval
  ): Promise<EmployeePolicyEditResult> {
    NativeOwnerId.parse(employeeId);
    const context = this.#authority.captureRamEmployeePolicyEdit(request, employeeId, approval);
    const employee = this.#employee(request, employeeId);
    if (!employee || employee.sessionId !== context.approval.sessionId)
      throw new EmployeePolicyRouteError(
        409,
        'EMPLOYEE_RESOURCE_SESSION_CHANGED',
        'This laptop session changed. Refresh the profile before editing its limits.'
      );
    if (!this.socket)
      throw new EmployeePolicyRouteError(
        503,
        'EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE',
        'Live RAM and CPU changes are unavailable.'
      );
    const client = await ResourceNativeClient.openRam(this.socket, this.#authority, context);
    try {
      const result = EmployeePolicyEditResult.parse(
        await client.request('employee-policy-edit', { employeeId, approval: context.approval })
      );
      this.#authority.assertContext(context);
      if (!this.#sameSession(request, employeeId, context.approval.sessionId, employee.sessionGeneration))
        throw new Error('The selected employee session changed during the original edit');
      return result;
    } catch (error) {
      // The native refusal envelope also carries unknown and reconciliation
      // outcomes. Only the closed no-effect catalog becomes a conflict.
      throw error instanceof ResourceNativeRefusal ? policyRefusal(error.reason) : unconfirmedEdit();
    } finally {
      client.close();
    }
  }
}

function isResourceOwner(verifiedOwner: OwnerVerifier, request: FastifyRequest): boolean {
  return (
    verifiedOwner(request) &&
    request.headers.authorization === undefined &&
    request.headers[SERVICE_HEADER] === undefined &&
    request.headers['x-reverie-parent-session'] === undefined &&
    !Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-'))
  );
}

/** A live native observation is required even when the ordinary auth hook is disabled. */
export function registerEmployeeResourceRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  service: EmployeeResourcesService
): void {
  app.get<{ Params: { employeeId: string } }>(
    '/api/company/resources/employees/:employeeId/memory-diagnostics',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isResourceOwner(verifiedOwner, request))
        return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
      if (!NativeOwnerId.safeParse(request.params.employeeId).success)
        return reply.code(400).send({ success: false, error: 'Invalid employee identifier' });
      try {
        return { success: true, data: await service.memoryDiagnostics(request, request.params.employeeId) };
      } catch (error) {
        return reply.code(error instanceof ResourceOwnerAuthorizationError ? 403 : 503).send({
          success: false,
          code: 'EMPLOYEE_RESOURCE_OBSERVATION_UNAVAILABLE',
          error: 'The original employee memory observation is unavailable. Previously shown limits are stale.',
        });
      }
    }
  );
  app.get<{ Params: { employeeId: string } }>(
    '/api/company/resources/employees/:employeeId',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isResourceOwner(verifiedOwner, request))
        return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
      if (!NativeOwnerId.safeParse(request.params.employeeId).success)
        return reply.code(400).send({ success: false, error: 'Invalid employee identifier' });
      try {
        return { success: true, data: await service.status(request, request.params.employeeId) };
      } catch (error) {
        return reply.code(error instanceof ResourceOwnerAuthorizationError ? 403 : 503).send({
          success: false,
          code: 'EMPLOYEE_RESOURCE_OBSERVATION_UNAVAILABLE',
          error: 'The original native employee resource observation is unavailable',
        });
      }
    }
  );
  app.post<{ Params: { employeeId: string } }>(
    '/api/company/resources/employees/:employeeId/policy',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isResourceOwner(verifiedOwner, request))
        return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
      const approval = EmployeePolicyEditApproval.safeParse(request.body);
      if (!NativeOwnerId.safeParse(request.params.employeeId).success || !approval.success)
        return reply.code(400).send({ success: false, error: 'Invalid RAM and CPU settings' });
      try {
        return { success: true, data: await service.edit(request, request.params.employeeId, approval.data) };
      } catch (error) {
        if (error instanceof ResourceOwnerAuthorizationError)
          return reply.code(403).send({ success: false, error: 'Company owner authorization is required' });
        if (error instanceof EmployeePolicyRouteError)
          return reply.code(error.status).send({ success: false, errorCode: error.code, error: error.message });
        return reply.code(503).send({
          success: false,
          errorCode: 'EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE',
          error: 'Live RAM and CPU changes are unavailable.',
        });
      }
    }
  );
}
