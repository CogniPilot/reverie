import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BrowserInputIdentity } from '../../browser-input-identity.js';
import { OWNER_COOKIE } from '../../owner-auth/policy.js';
import { OwnerAuthError, type OwnerAuthService } from '../../owner-auth/service.js';
import { AUTH_COOKIE_NAME, browserAuthSession } from '../middleware/auth.js';
import type { AuthSessionRecord } from '../ports/auth-port.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';

/** Partition pending browser input by actual authentication, without creating an account or grant. */
export function registerInputIdentityRoutes(
  app: FastifyInstance,
  auth: OwnerAuthService,
  basicRequired: boolean
): void {
  const scopes = new WeakMap<AuthSessionRecord, string>();
  const anonymousScope = randomUUID();
  app.get('/api/input-identity', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie, Authorization');
    try {
      if (req.headers['x-reverie-parent-session'] !== undefined || req.headers['x-reverie-service-token'] !== undefined)
        throw new OwnerAuthError('Browser sign-in required', 403);
      const token = req.cookies?.[OWNER_COOKIE];
      let identity: BrowserInputIdentity;
      if (token) identity = auth.inputIdentity(token);
      else {
        const record = browserAuthSession(req);
        if (record) {
          const scopeId = scopes.get(record) ?? randomUUID();
          scopes.set(record, scopeId);
          identity = { version: 1, kind: 'session', scopeId, epoch: 0 };
        } else {
          if (
            basicRequired ||
            auth.policy() === 'enforce' ||
            req.cookies?.[AUTH_COOKIE_NAME] ||
            req.headers.authorization
          )
            throw new OwnerAuthError('Current browser sign-in is unavailable', 403);
          // Explicit unauthenticated compatibility mode. Clients must quarantine restored rows.
          identity = { version: 1, kind: 'anonymous', scopeId: anonymousScope, epoch: 0 };
        }
      }
      return { success: true, data: identity };
    } catch (error) {
      if (!(error instanceof OwnerAuthError)) throw error;
      return reply.code(error.status).send(createErrorResponse(ApiErrorCode.FORBIDDEN, error.message));
    }
  });
}
