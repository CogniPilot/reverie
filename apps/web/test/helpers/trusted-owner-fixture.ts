import type { FastifyRequest } from 'fastify';
/** Explicit trusted-browser seam for legacy handler UNIT fixtures without authentication middleware.
 * Real authorization tests must inject ownerVerifier with a real OwnerAuthService instead.
 * This function is test-only, never imported by production source.
 */
export const trustedFixtureOwner = (req: FastifyRequest): boolean =>
  req.headers['x-reverie-parent-session'] === undefined && req.headers['x-reverie-service-token'] === undefined;
