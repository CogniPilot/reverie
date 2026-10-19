/**
 * @fileoverview Plans: subscription accounts paced against their weekly windows.
 *
 * - `GET /api/plans`: every account (Codeman profiles and `acct` accounts) with login
 *   state, 5-hour and weekly usage, the weekly window, elapsed percent, pace, burn rate,
 *   projected end-of-week usage, the sessions on it, the orchestrator mark and a
 *   recommendation (push / steady / ease / stop / login), plus the local GPU.
 * - `POST /api/plans/suggest {provider?}`: the account a new session should use (most
 *   headroom by pace) and how to launch on it, as the same `subscriptionProfileId` and
 *   `envOverrides` the Run menu and `acct spawn` already send to `POST /api/sessions`.
 *
 * - `POST /api/plans/accounts/:id/login`: start signing that account in (account-login.ts);
 *   `POST /api/plans/login-all`: start every signed-out account at once;
 *   `GET /api/plans/logins/:loginId` reads its state, `POST .../code {code}` passes Claude's
 *   authorization code back, `DELETE` cancels it.
 *
 * Admin-only in multi-user mode, like the subscription profiles they build on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { PlanService } from '../../plan-accounts.js';
import { LoginError, type AccountLoginService } from '../../account-login.js';
import { isAdmin, parseBody } from '../route-helpers.js';

/** Who an agent caller is, for the read-only scoping of `GET /api/plans`. */
export interface PlansScope {
  /** The live session this request speaks as (X-Codeman-Parent-Session), undefined when it does not resolve. */
  callerSession(req: FastifyRequest): string | undefined;
  /** Does this session hold plans.view_all (Admin, or Lead of a live room)? It sees every account. */
  canViewAll(sessionId: string): boolean;
}

const SuggestSchema = z.object({ provider: z.enum(['anthropic', 'openai']).optional() }).strict();
const CodeSchema = z.object({ code: z.string().min(1).max(2048) }).strict();

export function registerPlansRoutes(
  app: FastifyInstance,
  plans: PlanService,
  logins?: AccountLoginService,
  scope?: PlansScope
): void {
  const forbid = (reply: FastifyReply) =>
    reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Plans are admin-only'));

  // Read-only and role-scoped, server-side, for the page, `reverie plans` and the MCP tools alike:
  // - no X-Codeman-Parent-Session header: the owner (admin) sees everything;
  // - an agent holding plans.view_all (an Admin, or the Lead of a live room) sees every account;
  // - any other agent sees only the account its own session runs on (and no GPU line).
  // A header that does not resolve to a live session the caller may speak as is refused.
  // Add, remove and sign-in stay admin-only below; no token is ever part of a plan row.
  app.get('/api/plans', async (req, reply) => {
    if (req.headers['x-codeman-parent-session'] === undefined) {
      if (!isAdmin(req)) return forbid(reply);
      return { success: true, data: await plans.plans() };
    }
    const self = scope?.callerSession(req);
    if (!self) {
      return reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'X-Codeman-Parent-Session does not name a live session you may speak as'));
    }
    const all = await plans.plans();
    if (scope?.canViewAll(self)) return { success: true, data: all };
    const { gpu: _gpu, ...rest } = all;
    return { success: true, data: { ...rest, accounts: all.accounts.filter((a) => a.sessions.some((s) => s.id === self)) } };
  });

  app.post('/api/plans/suggest', async (req, reply) => {
    if (!isAdmin(req)) return forbid(reply);
    const body = parseBody(SuggestSchema, req.body ?? {});
    const suggestion = await plans.suggest(body.provider ?? 'anthropic');
    if (!suggestion) {
      return reply
        .code(409)
        .send(createErrorResponse(ApiErrorCode.CONFLICT, 'No signed-in account of that provider has room right now'));
    }
    return { success: true, data: suggestion };
  });

  if (!logins) return;
  // Sign-in is the owner's alone: an agent caller (the parent-session header is present) never starts, reads or ends one.
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/api/plans/accounts/') || req.url.startsWith('/api/plans/login') ) {
      if (req.headers['x-codeman-parent-session'] !== undefined) {
        return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Signing in an account is the owner\'s alone'));
      }
    }
  });
  const loginError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof LoginError) {
      const code =
        err.status === 404
          ? ApiErrorCode.NOT_FOUND
          : err.status === 409
            ? ApiErrorCode.CONFLICT
            : ApiErrorCode.INVALID_INPUT;
      return reply.code(err.status).send(createErrorResponse(code, err.message));
    }
    throw err;
  };

  app.post<{ Params: { id: string } }>('/api/plans/accounts/:id/login', async (req, reply) => {
    if (!isAdmin(req)) return forbid(reply);
    const account = await plans.account(req.params.id);
    if (!account) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such account'));
    try {
      return { success: true, data: await logins.start(account) };
    } catch (err) {
      if (err instanceof LoginError) return loginError(reply, err);
      return reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Could not start the sign-in helper'));
    }
  });

  app.post('/api/plans/login-all', async (req, reply) => {
    if (!isAdmin(req)) return forbid(reply);
    const { accounts, catalogue } = await plans.rows();
    const byId = new Map(catalogue.map((a) => [a.id, a]));
    const started: Array<{ accountId: string; label: string; provider: string; loginId: string; view: unknown }> = [];
    const errors: Array<{ accountId: string; label: string; provider: string; error: string }> = [];
    for (const row of accounts) {
      if (row.signedIn) continue;
      const account = byId.get(row.id);
      if (!account) continue;
      try {
        const view = await logins.start(account);
        started.push({ accountId: account.id, label: account.label, provider: account.provider, loginId: view.id, view });
      } catch (err) {
        errors.push({
          accountId: account.id,
          label: account.label,
          provider: account.provider,
          error: err instanceof LoginError ? err.message : 'Could not start the sign-in helper',
        });
      }
    }
    return { success: true, data: { logins: started, errors } };
  });

  app.get<{ Params: { loginId: string } }>('/api/plans/logins/:loginId', async (req, reply) => {
    if (!isAdmin(req)) return forbid(reply);
    const view = logins.get(req.params.loginId);
    if (!view) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such sign-in'));
    return { success: true, data: view };
  });

  app.post<{ Params: { loginId: string } }>('/api/plans/logins/:loginId/code', async (req, reply) => {
    if (!isAdmin(req)) return forbid(reply);
    const body = parseBody(CodeSchema, req.body ?? {});
    try {
      return { success: true, data: await logins.submitCode(req.params.loginId, body.code) };
    } catch (err) {
      return loginError(reply, err);
    }
  });

  app.delete<{ Params: { loginId: string } }>('/api/plans/logins/:loginId', async (req, reply) => {
    if (!isAdmin(req)) return forbid(reply);
    if (!(await logins.cancel(req.params.loginId))) {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such sign-in'));
    }
    return { success: true, data: logins.get(req.params.loginId) };
  });
}
