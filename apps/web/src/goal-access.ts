/**
 * Trusted integration seam for Goals. No header/body can mint authority here.
 * Authentication and private-store custody are mandatory; unfinished adapters deny access.
 */

export type GoalPrincipal =
  | { kind: 'owner'; owner?: string }
  | { kind: 'employee'; owner?: string; employeeId: string; sessionId: string; sessionGeneration: number };

export class GoalAccessError extends Error {
  readonly code = 'GOAL_FORBIDDEN';
  readonly status = 403;
}

/** Server composition owns this port. Never deserialize it, its principal or its grants from an agent request. */
export interface GoalAuthentication {
  authenticate(context: unknown): Promise<GoalPrincipal | undefined>;
  /** Synchronous current credential/revocation check, repeated after store awaits and before atomic commit. */
  assertCurrent(principal: GoalPrincipal, context: unknown): void;
  /** Must prove the canonical file AND parent/lock namespace are outside worker-writable mounts. */
  assertPrivateCustody(file: string): void;
}

export const INACCESSIBLE_GOAL_AUTH: GoalAuthentication = Object.freeze({
  authenticate: async () => undefined,
  assertCurrent: () => {
    throw new GoalAccessError('Goal authentication adapter is unavailable');
  },
  assertPrivateCustody: () => {
    throw new GoalAccessError('Private canonical Goal custody is unproven');
  },
});
