/**
 * @fileoverview Owner marks on chat messages: which user messages a cookie-verified owner wrote.
 *
 * A user message (`from.kind === 'user'`) may carry `from.mark`:
 * - `owner_typed`: posted by a request with a valid, unrestricted owner session cookie and no
 *   `X-Reverie-Parent-Session` header;
 * - `owner_spoken`: the same, for speech (a spoken message or a voice-turn transcript).
 *
 * The mark is set only here, server-side, whatever the enforcement policy (`off` included: the
 * session cookie is checked against the owner-auth service either way). A request without a valid
 * cookie, the "no header means the user" case, gets no mark: absence is not trust. Bot, system,
 * agent and external messages never carry one (the chatroom store drops it). Host-side memory
 * reflection reads the mark from chatrooms.json to decide which episodes the owner vouched for.
 */
import type { FastifyRequest } from 'fastify';
import { callerOf, type PolicyDeps } from './policy.js';

export type OwnerMark = 'owner_typed' | 'owner_spoken';
export const OWNER_MARKS: readonly OwnerMark[] = ['owner_typed', 'owner_spoken'];

/** True only for a request a full owner made from the console itself (not an agent, not restricted). */
export type OwnerVerifier = (req: FastifyRequest) => boolean;

/** Nobody is verified: the default where no owner-auth service is wired in. */
export const NO_OWNER: OwnerVerifier = () => false;

export function ownerVerifier(deps: Pick<PolicyDeps, 'service' | 'ctx'>): OwnerVerifier {
  return (req) => req.headers['x-reverie-parent-session'] === undefined && callerOf(req, deps).kind === 'owner';
}

/** The mark for a user message this request posts, or undefined. */
export function ownerMark(req: FastifyRequest, verify: OwnerVerifier, spoken: boolean): OwnerMark | undefined {
  if (!verify(req)) return undefined;
  return spoken ? 'owner_spoken' : 'owner_typed';
}

export function isOwnerMark(value: unknown): value is OwnerMark {
  return typeof value === 'string' && (OWNER_MARKS as readonly string[]).includes(value);
}
