import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
/**
 * @fileoverview `GET /api/agents/:id/profile`: one agent session's read-only profile for the
 * profile panel: backend, model, effort, usage counters, company and room bindings, runtime
 * supervision and the owner-selected persona. The console builds it from its own state
 * (agent-profile-report.ts); the runtime supervision section and the persona are read only when
 * the server environment names the runtime policy (REVERIE_RUNTIME_POLICY).
 *
 * Read-only: nothing is changed, and backend switching is listed as unavailable until owner
 * authentication exists. Configuration is environment-only, never a settings key, so no API call
 * can choose what this route reads. Single-user only: the report reads the console as its owner.
 * Ownership of the session itself goes through `findSessionOrFail`, like every session-scoped
 * route; an agent caller may read only its own profile, without direct-message rooms.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import type { SessionPort } from '../ports/session-port.js';
import { findSessionOrFail, ownerFor, resolveParentSessionId } from '../route-helpers.js';
import { envValue } from '../../config/reverie-env.js';
import { buildProfile, transcriptProjectsDir, type ProfileSources, type ProfileView } from './agent-profile-report.js';

export type { ProfileSources, ProfileView } from './agent-profile-report.js';

/** The environment part of the report's sources: the transcript directory and the optional runtime policy. */
export function profileEnvSources(
  env: NodeJS.ProcessEnv = process.env
): Pick<ProfileSources, 'transcriptProjectsDir' | 'runtimePolicy'> {
  return {
    transcriptProjectsDir: transcriptProjectsDir(env),
    runtimePolicy: envValue(env, 'RUNTIME_POLICY') || undefined,
  };
}

export function registerAgentProfileRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  sources: ProfileSources,
  verifiedOwner: OwnerVerifier = NO_OWNER
): void {
  app.get('/api/agents/:id/profile', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    if (isMultiUserMode()) {
      return reply
        .code(501)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Agent profiles are available in single-user mode only')
        );
    }
    // The owner (no parent-session header) reads any profile. An agent reads only its own, without
    // its direct-message rooms; any other header, resolvable or not, is refused.
    const owner = verifiedOwner(req);
    if (
      !owner &&
      (req.headers['x-reverie-service-token'] !== undefined ||
        resolveParentSessionId(ctx, req, undefined, ownerFor(req)) !== session.id)
    ) {
      return reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'An agent may read only its own profile'));
    }
    const view: ProfileView = { includeDms: owner };
    try {
      return { success: true, data: buildProfile(sources, session.id, ctx.getSessionStateWithRespawn(session), view) };
    } catch (error) {
      return reply
        .code(502)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, error instanceof Error ? error.message : String(error))
        );
    }
  });
}
