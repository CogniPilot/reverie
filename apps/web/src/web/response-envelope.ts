/**
 * Uniform response envelope (stable HTTP contract — docs/api-reference.md):
 * wrap bare JSON payloads as { success:true, data } and map { success:false }
 * error envelopes to a conventional HTTP status (instead of 200). Skips
 * non-JSON responses (buffers/streams) and non-/api routes.
 *
 * One hook for the server and for tests that record its exact responses.
 */
import type { FastifyInstance } from 'fastify';
import { isEmbassyProtocolRoute } from '../embassy-public-routes.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../types/api.js';

export function installResponseEnvelope(app: FastifyInstance, basePath: string): void {
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    // Federation speaks its own bare wire contract, including non-2xx errors.
    // Exempt exact registered protocol routes only; owner APIs retain the console envelope.
    const route = req.routeOptions?.url;
    const canonicalRoute = basePath && route?.startsWith(basePath + '/') ? route.slice(basePath.length) : route;
    if (isEmbassyProtocolRoute(req.method, canonicalRoute)) return done(null, payload);
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
}
