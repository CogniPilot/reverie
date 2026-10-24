import type { FastifyRequest } from 'fastify';
import type { AuthPort } from './ports/auth-port.js';
import type { OwnerAuthService } from '../owner-auth/service.js';
import { OWNER_COOKIE, sameOrigin } from '../owner-auth/policy.js';
import { AUTH_COOKIE_NAME } from './middleware/auth.js';
import { ownerFor } from './route-helpers.js';
import { isMultiUserMode } from '../config/multiuser.js';

export function authenticatedPlanMover(
  request: FastifyRequest,
  sessions: Pick<NonNullable<AuthPort['authSessions']>, 'get'> | null,
  ownerAuth?: Pick<OwnerAuthService, 'session'>
): boolean {
  if (request.headers['x-reverie-parent-session'] !== undefined || !sameOrigin(request)) return false;
  const ownerSession = ownerAuth?.session(request.cookies?.[OWNER_COOKIE]);
  // A human channel login cannot inherit a stale Basic-auth admin cookie.
  if (ownerSession?.role === 'limited') return false;
  if (ownerSession && !ownerSession.restricted && !isMultiUserMode()) return true;
  const token = request.cookies?.[AUTH_COOKIE_NAME];
  const record = token ? sessions?.get(token) : undefined;
  return !!record && record.role !== 'user' && !record.mustChangePassword && record.username === ownerFor(request);
}
