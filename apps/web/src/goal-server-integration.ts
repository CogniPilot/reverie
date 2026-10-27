/** Trusted server composition only. No configuration/keys/custody are derived from requests or environment. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { OwnerAuthService } from './owner-auth/service.js';
import { OWNER_COOKIE, SERVICE_HEADER } from './owner-auth/policy.js';
import { GoalAccessError, INACCESSIBLE_GOAL_AUTH, type GoalAuthentication, type GoalPrincipal } from './goal-access.js';
import { ownerGoalAuthentication } from './goal-owner-auth.js';
import { EMPLOYEE_GOAL_ACTIONS, goalRouteAction, type GoalAction } from './goal-route-policy.js';

/** Host/server-owned ports. Supplying an object is not proof that these adapters are accepted or implemented. */
export interface GoalServerPorts {
  /** Purpose-authenticated employee adapter, e.g. the separately reviewed broker assertion boundary.
   * Its existing assertPrivateCustody port also gates owner requests. Unavailable ports must throw/refuse. */
  readonly employee: GoalAuthentication;
  /** Install the matching private request provenance boundary before routes are prepared.
   * It must permit proof-free owner-cookie requests to reach the independent owner adapter. */
  registerEmployeeBoundary(app: FastifyInstance): void;
  /** Explicit per-action permission and synchronous revocation check; never title/Basic/service inference.
   * Called again at the core commit boundary. No unspecified action has implicit owner permission here. */
  assertAction(action: GoalAction, principal: GoalPrincipal, request: FastifyRequest): void;
}

function refuse(): never {
  throw new GoalAccessError('Goal integration is unavailable or refused');
}
function requestOf(context: unknown): FastifyRequest {
  const request = context as FastifyRequest | undefined;
  if (!request?.headers || !goalRouteAction(request)) refuse();
  // No service credential, even alongside an owner cookie or valid employee proof, may enter this purpose.
  if (request.headers[SERVICE_HEADER] !== undefined) refuse();
  return request;
}
function synchronous(value: unknown): void {
  // A mistakenly async assertion must not silently turn a synchronous commit check into permission.
  if (value !== undefined) {
    if (value && typeof (value as PromiseLike<unknown>).then === 'function')
      void Promise.resolve(value).catch(() => undefined);
    refuse();
  }
}
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return refuse();
  }
}

export function createGoalServerBoundary(
  service: Pick<OwnerAuthService, 'session'>,
  canonicalFile: string,
  ports?: GoalServerPorts
) {
  const employee = ports?.employee ?? INACCESSIBLE_GOAL_AUTH;
  const owner = ownerGoalAuthentication(service, employee);
  const branch = (request: FastifyRequest): GoalAuthentication => {
    if (request.cookies?.[OWNER_COOKIE] !== undefined) {
      if (
        request.headers.authorization !== undefined ||
        request.headers['x-reverie-parent-session'] !== undefined ||
        Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-'))
      )
        refuse();
      return owner;
    }
    return employee;
  };
  const authorize = (principal: GoalPrincipal, context: unknown) => {
    const request = requestOf(context),
      action = goalRouteAction(request)!;
    if (!ports || (principal.kind === 'employee' && !EMPLOYEE_GOAL_ACTIONS.has(action))) refuse();
    synchronous(ports.assertAction(action, principal, request));
  };
  const authentication: GoalAuthentication = {
    authenticate: async (context) => {
      try {
        const request = requestOf(context),
          adapter = branch(request);
        authentication.assertPrivateCustody(canonicalFile);
        const principal = await adapter.authenticate(request);
        if (!principal || (adapter === employee && principal.kind !== 'employee')) refuse();
        authentication.assertPrivateCustody(canonicalFile);
        authorize(principal, request);
        return principal;
      } catch {
        return refuse();
      }
    },
    assertCurrent: (principal, context) =>
      checked(() => {
        const request = requestOf(context),
          adapter = branch(request);
        if ((adapter === owner) !== (principal.kind === 'owner')) refuse();
        synchronous(adapter.assertCurrent(principal, request));
        authorize(principal, request);
      }),
    assertPrivateCustody: (file) =>
      checked(() => {
        if (file !== canonicalFile) refuse();
        synchronous(employee.assertPrivateCustody(file));
      }),
  };
  return {
    authentication,
    register(app: FastifyInstance): void {
      if (ports) synchronous(ports.registerEmployeeBoundary(app));
    },
    async authorizeRequest(request: FastifyRequest, action: GoalAction): Promise<void> {
      if (goalRouteAction(request) !== action) refuse();
      const principal = await authentication.authenticate(request);
      if (!principal) refuse();
      authentication.assertCurrent(principal, request);
    },
  };
}
