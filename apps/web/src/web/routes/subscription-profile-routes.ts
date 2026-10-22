/** Account profile selection and read-only quota lookup. Admin-owned in multi-user mode. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canUsernameRunPrivilegedCommands } from '../../user-store.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import {
  addSubscriptionProfile,
  readSubscriptionProfiles,
  removeSubscriptionProfile,
  DuplicateLabelError,
  renameSubscriptionProfile,
  selectedSubscription,
  subscriptionModes,
  type SubscriptionSelection,
} from '../../subscription-profiles.js';
import { SubscriptionUsageReader } from '../../subscription-usage.js';
import type { SessionMode } from '../../types.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getAuthUser, isAdmin, ownerFor, parseBody } from '../route-helpers.js';
import { appendAdminAudit } from '../admin-audit.js';
import { SubscriptionProfileCreateSchema, SubscriptionProfileRenameSchema } from '../schemas.js';
import { setLatestAccountPlanUsage } from '../plan-usage-latest.js';

const launches = new WeakMap<FastifyRequest, { selection?: SubscriptionSelection; env: Record<string, string> }>();
export function subscriptionLaunch(req: FastifyRequest): {
  selection?: SubscriptionSelection;
  env: Record<string, string>;
} {
  return launches.get(req) ?? { env: {} };
}

/** Names of the sessions running on an account profile (a Plans row's sessions), for the remove check. */
export type SessionsOnProfile = (profileId: string) => Promise<string[]>;

export function registerSubscriptionProfileRoutes(
  app: FastifyInstance,
  reader: SubscriptionUsageReader,
  sessionsOn: SessionsOnProfile
): void {
  const authorize = (req: FastifyRequest): boolean => !isMultiUserMode() || isAdmin(req);
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' || !['/api/sessions', '/api/quick-start'].includes(req.routeOptions.url ?? '')) return;
    const body = req.body as
      | {
          subscriptionProfileId?: unknown;
          mode?: SessionMode;
          customModel?: unknown;
          envOverrides?: Record<string, unknown>;
          remote?: unknown;
        }
      | undefined;
    if (body?.subscriptionProfileId === undefined) return;
    if (!(await canUsernameRunPrivilegedCommands(ownerFor(req))))
      return reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Account selection requires account-profile access'));
    const parsed = z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .safeParse(body.subscriptionProfileId);
    if (!parsed.success)
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid account profile ID'));
    const id = parsed.data;
    if (
      body.customModel ||
      body.remote ||
      ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME'].some((k) => k in (body.envOverrides ?? {}))
    )
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            'Account profiles cannot be combined with custom endpoints, remote sessions, or login-directory overrides'
          )
        );
    try {
      launches.set(req, await selectedSubscription(id, body.mode ?? 'claude'));
    } catch (error) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, (error as Error).message));
    }
  });

  app.get('/api/subscription-profiles', async (req, reply) => {
    if (!authorize(req))
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Account profiles are admin-only'));
    const profiles = await readSubscriptionProfiles();
    return { success: true, data: { profiles: profiles.map((p) => ({ ...p, modes: subscriptionModes(p.provider) })) } };
  });
  app.post('/api/subscription-profiles', async (req, reply) => {
    if (!authorize(req))
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Account profiles are admin-only'));
    const body = parseBody(SubscriptionProfileCreateSchema, req.body);
    try {
      const profile = await addSubscriptionProfile(body);
      return { success: true, data: { profile } };
    } catch (error) {
      if (error instanceof DuplicateLabelError)
        return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, error.message));
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, (error as Error).message));
    }
  });
  // Owner-only: relabelling changes what every plan view shows, so it stays behind the account-profile gate
  // (admin in multi-user mode) and takes a label and nothing else. An agent caller is refused: the
  // parent-session header counts as present with any value, so a malformed id cannot fall back to the owner.
  app.patch<{ Params: { id: string } }>('/api/subscription-profiles/:id', async (req, reply) => {
    if (req.headers['x-reverie-parent-session'] !== undefined)
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the owner renames accounts'));
    if (!authorize(req))
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Account profiles are owner-only'));
    const body = parseBody(SubscriptionProfileRenameSchema, req.body);
    let renamed;
    try {
      renamed = await renameSubscriptionProfile(req.params.id, body.label);
    } catch (err) {
      if (err instanceof DuplicateLabelError)
        return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, err.message));
      throw err;
    }
    if (!renamed) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such account profile'));
    await appendAdminAudit({
      admin: getAuthUser(req).username,
      action: 'profile_rename',
      target: renamed.profile.id,
      ip: req.ip,
      detail: { from: renamed.from, to: renamed.profile.label },
    });
    return { success: true, data: { profile: renamed.profile } };
  });
  // Owner-only like rename. Unlists the account (its login directory is never touched) and is refused while
  // a session runs on it, so no running agent loses its account underneath it.
  app.delete<{ Params: { id: string } }>('/api/subscription-profiles/:id', async (req, reply) => {
    if (req.headers['x-reverie-parent-session'] !== undefined)
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the owner removes accounts'));
    if (!authorize(req))
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Account profiles are owner-only'));
    const id = req.params.id;
    const running = await sessionsOn(id);
    if (running.length)
      return reply
        .code(409)
        .send(
          createErrorResponse(
            ApiErrorCode.CONFLICT,
            `Employees or sessions use this account (${running.slice(0, 5).join(', ')}); stop or move them first`
          )
        );
    let removed;
    try {
      removed = await removeSubscriptionProfile(id);
    } catch (error) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'Could not remove the account; nothing was changed'));
    }
    if (!removed) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such account profile'));
    await appendAdminAudit({
      admin: getAuthUser(req).username,
      action: 'profile_remove',
      target: removed.id,
      ip: req.ip,
      detail: { label: removed.label, provider: removed.provider },
    });
    return { success: true, data: { removed: { id: removed.id, label: removed.label, provider: removed.provider } } };
  });
  app.get('/api/subscription-profiles/usage', async (req, reply) => {
    if (!authorize(req))
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Subscription usage is admin-only'));
    const profiles = await readSubscriptionProfiles();
    const accounts = [];
    // Bound app-server processes and provider requests even with many saved accounts.
    for (const profile of profiles) {
      const reading = await reader.read(profile);
      accounts.push(reading);
      setLatestAccountPlanUsage(reading);
    }
    return { success: true, data: { accounts } };
  });
}
