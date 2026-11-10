/** Thin owner-authenticated adapter to the actual installed native actor. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CompanyService } from './company-service.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ResourceOwnerAuthority } from './resource-owner-authority.js';
import { ResourceNativeClient } from './resource-native-client.js';
import { EmployeeResourceStatus } from './resource-employee-data.js';
import { NativeOwnerId } from './native-owner-data.js';
import { ownerFor } from './web/route-helpers.js';
import type { OwnerVerifier } from './owner-auth/marks.js';
import { ResourceOwnerAuthorizationError } from './resource-owner-authority.js';
import { SERVICE_HEADER } from './owner-auth/policy.js';

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
  async status(request: FastifyRequest, employeeId: string): Promise<EmployeeResourceStatus> {
    NativeOwnerId.parse(employeeId);
    const context = this.#authority.captureRamStatus(request, employeeId);
    const employee = this.company.view(ownerFor(request)).employees.find((row) => row.id === employeeId);
    if (!employee || !this.socket) throw new Error('The current employee and native resource service are required');
    const sessionId = NativeOwnerId.parse(employee.sessionId);
    const client = await ResourceNativeClient.openRam(this.socket, this.#authority, context);
    try {
      const data = EmployeeResourceStatus.parse(await client.request('employee-status', { employeeId, sessionId }));
      this.#authority.assertContext(context);
      const current = this.company.view(ownerFor(request)).employees.find((row) => row.id === employeeId);
      if (
        data.employeeId !== employeeId ||
        data.sessionId !== sessionId ||
        !current ||
        current.sessionId !== sessionId ||
        current.sessionGeneration !== employee.sessionGeneration
      )
        throw new Error('The original employee session changed during resource observation');
      return data;
    } finally {
      client.close();
    }
  }
}

/** A live native observation is required even when the ordinary auth hook is disabled. */
export function registerEmployeeResourceRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  service: EmployeeResourcesService
): void {
  app.get<{ Params: { employeeId: string } }>(
    '/api/company/resources/employees/:employeeId',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        !verifiedOwner(request) ||
        request.headers.authorization !== undefined ||
        request.headers[SERVICE_HEADER] !== undefined ||
        Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-'))
      )
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
}
