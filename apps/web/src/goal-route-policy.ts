/** Closed registered Goal actions. This is not an agent/service/prefix allowlist. */
import type { FastifyRequest } from 'fastify';

const actions = {
  'GET /api/goals': 'READ',
  'GET /api/goals/:id': 'READ',
  'POST /api/goals': 'CREATE',
  'POST /api/goals/:id/transitions': 'TRANSITION',
  'POST /api/goals/:id/adopt': 'ADOPT',
  'POST /api/goals/:id/unblock-proofs': 'ATTEST_UNBLOCKER',
  'POST /api/goal-grants': 'ISSUE_GRANT',
  'POST /api/goal-grants/:id/revoke': 'REVOKE_GRANT',
  // Owner-only service grant surface on the same canonical facade and boundary (never in EMPLOYEE_GOAL_ACTIONS and never
  // on the employee broker route set). Grants authorize only their configured service purpose, never a Goal action.
  'POST /api/service-grants': 'ISSUE_SERVICE_GRANT',
  'POST /api/service-grants/:id/revoke': 'REVOKE_SERVICE_GRANT',
  'GET /api/service-grants/setup': 'SERVICE_GRANT_SETUP',
  'POST /api/goal-unblock-proofs/:id/revoke': 'REVOKE_PROOF',
  'GET /api/goal-metadata/:employeeId': 'METADATA_READ',
} as const;
export type GoalAction = (typeof actions)[keyof typeof actions];
export function goalRouteAction(request: Pick<FastifyRequest, 'method' | 'routeOptions'>): GoalAction | undefined {
  const key = `${request.method} ${request.routeOptions?.url}`;
  return Object.hasOwn(actions, key) ? actions[key as keyof typeof actions] : undefined;
}

export const EMPLOYEE_GOAL_ACTIONS: ReadonlySet<GoalAction> = new Set([
  'READ',
  'CREATE',
  'TRANSITION',
  'METADATA_READ',
]);
