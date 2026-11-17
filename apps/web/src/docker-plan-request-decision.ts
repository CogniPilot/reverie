/** The control keeps approval credentials private. Only a genuinely authenticated,
 * exact current boxed expert with an explicit plan grant may consume its own
 * request credential; neither a parent header nor serialized DATA grants this. */
import type { FastifyRequest } from 'fastify';
import { CompanyService } from './company-service.js';
import { dockerWorkerIdentityOf, DockerWorkerRequestIdentity } from './docker-worker-identity.js';
import { PlanRequestCapabilities, PlanRequestId } from './plan-request-capability.js';
import { PlanMoveRequests } from './plan-request.js';
import { PlanMoveError } from './plan-move.js';

export interface DockerPlanDecisionScope {
  readonly requestId: string;
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly owner: string | undefined;
  readonly containerId: string;
}
const origin = Symbol('actual boxed plan decision');
export class DockerPlanRequestDecision {
  readonly #scope: DockerPlanDecisionScope;
  readonly #requestId: string;
  readonly #sessionId: string;
  readonly #nonce: string;
  readonly #current: () => void;
  constructor(token: symbol, scope: DockerPlanDecisionScope, nonce: string, current: () => void) {
    if (token !== origin) throw new PlanMoveError('Current boxed plan decision required', 403);
    this.#scope = Object.freeze({ ...scope });
    this.#requestId = scope.requestId;
    this.#sessionId = scope.sessionId;
    this.#nonce = nonce;
    this.#current = current;
    Object.freeze(this);
  }
  scope(): DockerPlanDecisionScope {
    this.#current();
    return { ...this.#scope };
  }
  require(requestId: string, sessionId: string): string {
    this.#current();
    if (requestId !== this.#requestId || sessionId !== this.#sessionId)
      throw new PlanMoveError('The boxed approval target changed', 403);
    return this.#nonce;
  }
}
Object.freeze(DockerPlanRequestDecision.prototype);
export function requireDockerPlanRequestDecision(proof: unknown, requestId: string, sessionId: string): string {
  if (!(proof instanceof DockerPlanRequestDecision))
    throw new PlanMoveError('Current boxed plan decision required', 403);
  return DockerPlanRequestDecision.prototype.require.call(proof, requestId, sessionId);
}
/** Private actor handoff: genuine initial decision evidence, never a replacement
 * for the actor's live permission/journal/native checks after planned rebinding. */
export function requireDockerPlanDecisionScope(proof: unknown): DockerPlanDecisionScope {
  if (!(proof instanceof DockerPlanRequestDecision))
    throw new PlanMoveError('Current boxed plan decision required', 403);
  return DockerPlanRequestDecision.prototype.scope.call(proof);
}
export async function captureDockerPlanRequestDecision(
  request: FastifyRequest,
  requestId: string,
  company: CompanyService,
  requests: PlanMoveRequests,
  capabilities: PlanRequestCapabilities,
  runtimeCurrent: () => void
): Promise<DockerPlanRequestDecision | undefined> {
  const identity = dockerWorkerIdentityOf(request);
  if (!identity) return undefined;
  if (
    !(company instanceof CompanyService) ||
    !(requests instanceof PlanMoveRequests) ||
    !(capabilities instanceof PlanRequestCapabilities)
  )
    throw new PlanMoveError('Actual boxed plan services required', 403);
  PlanRequestId.parse(requestId);
  const started = performance.now();
  let revoked = false;
  const current = () => {
    if (revoked) throw new PlanMoveError('The boxed plan decision changed', 403);
    try {
      runtimeCurrent();
      DockerWorkerRequestIdentity.prototype.require.call(identity);
      const elapsed = performance.now() - started;
      const employees = company.registeredEmployees().filter((employee) => employee.id === identity.employeeId);
      const employee = employees[0];
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > 30_000 ||
        employees.length !== 1 ||
        !employee ||
        employee.owner !== identity.owner ||
        employee.sessionId !== identity.sessionId ||
        employee.sessionGeneration !== identity.sessionGeneration ||
        employee.onVacation ||
        employee.desiredRunning !== true ||
        employee.bindingMigration ||
        !(employee.permissions.moveOwnPlan || employee.permissions.managePlans) ||
        request.headers['x-reverie-parent-session'] !== identity.sessionId
      )
        throw new PlanMoveError('Your exact current plan permission is required', 403);
    } catch (error) {
      revoked = true;
      throw error;
    }
  };
  current();
  const record = await requests.get(requestId, identity.owner).catch((error) => {
    if (error instanceof PlanMoveError) throw error;
    throw new PlanMoveError('The pending approval could not be checked', 409);
  });
  current();
  if (
    record.employeeId !== identity.employeeId ||
    record.sessionId !== identity.sessionId ||
    record.phase !== 'pending'
  )
    throw new PlanMoveError('The approval is outside your exact pending request', 403);
  const credential = await capabilities.read(identity.sessionId, requestId).catch(() => {
    throw new PlanMoveError('The private boxed approval credential is unavailable', 403);
  });
  current();
  return new DockerPlanRequestDecision(
    origin,
    {
      requestId,
      employeeId: identity.employeeId,
      sessionId: identity.sessionId,
      sessionGeneration: identity.sessionGeneration,
      owner: identity.owner,
      containerId: identity.containerId,
    },
    credential.nonce,
    current
  );
}
