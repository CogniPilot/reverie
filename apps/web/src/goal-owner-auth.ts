import type { FastifyRequest } from 'fastify';
import type { OwnerAuthService } from './owner-auth/service.js';
import { OWNER_COOKIE, sameOrigin } from './owner-auth/policy.js';
import { ownerFor } from './web/route-helpers.js';
import { GoalAccessError, INACCESSIBLE_GOAL_AUTH, type GoalAuthentication } from './goal-access.js';

/**
 * Owner-cookie integration only. Employee/host-fixed identity adapters remain unimplemented and default-inaccessible.
 * Custody is an explicit deployment port, not inferred from uid/mode or a caller boolean.
 */
export function ownerGoalAuthentication(
  service: Pick<OwnerAuthService, 'session'>,
  custody: Pick<GoalAuthentication, 'assertPrivateCustody'> = INACCESSIBLE_GOAL_AUTH
): GoalAuthentication {
  const valid = (context: unknown): context is FastifyRequest => {
    const req = context as FastifyRequest | undefined;
    if (!req?.headers || req.headers['x-reverie-parent-session'] !== undefined) return false;
    const session = service.session(req.cookies?.[OWNER_COOKIE]);
    return (
      !!session &&
      !session.restricted &&
      (session.role === undefined || session.role === 'owner') &&
      (['GET', 'HEAD'].includes(req.method) || sameOrigin(req))
    );
  };
  return {
    authenticate: async (context) => (valid(context) ? { kind: 'owner', owner: ownerFor(context) } : undefined),
    assertCurrent: (principal, context) => {
      if (!valid(context) || principal.kind !== 'owner' || principal.owner !== ownerFor(context))
        throw new GoalAccessError('Owner credential is absent, restricted, revoked or cross-origin');
    },
    assertPrivateCustody: (file) => custody.assertPrivateCustody(file),
  };
}
