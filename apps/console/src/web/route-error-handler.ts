/**
 * @fileoverview Shared Fastify error handler for Codeman's HTTP routes.
 *
 * Route helpers (`findSessionOrFail`, `parseBody` in route-helpers.ts) throw
 * structured errors carrying `{ statusCode, body }`. This handler renders them
 * into the proper HTTP response. It is installed by BOTH the production server
 * and the route test harness so test behavior matches production exactly —
 * without it, thrown errors fall through to Fastify's default handler and the
 * response body is `{statusCode,error,message}` instead of `{success:false,...}`.
 */
import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../types.js';

/**
 * Install the global error handler that renders structured route errors.
 * Errors thrown with a `statusCode`/`body` (see route-helpers.ts) are sent
 * verbatim at that status; anything else becomes a 500 OPERATION_FAILED response.
 */
export function installRouteErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _req, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const body = (error as { body?: unknown }).body;
    if (body) {
      reply.code(statusCode).send(body);
    } else {
      reply.code(statusCode).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(error)));
    }
  });
}
