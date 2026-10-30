import { LIMITED_ROUTES, limitedAsset } from './limited-access.js';
import { isEmbassyProtocolRoute } from '../embassy-public-routes.js';
/**
 * @fileoverview Who may call what, once an owner account exists.
 *
 * Every request is classified by its MATCHED ROUTE PATTERN (`req.routeOptions.url`), never by the
 * raw URL: the router decodes `%61pi`, so a raw-prefix check would let `/%61pi/settings` reach
 * `/api/settings` as if it were a static path. Unmatched requests are classified on the decoded
 * path, and an undecodable path is owner-only.
 * - `public`: sign-in pages and endpoints, static assets, the app shell, capability URLs, and the
 *   hook endpoints that carry their own secret;
 * - `agent`: exactly what the `reverie agent` CLI, the MCP server and the plugins call. The
 *   session-acting ones (input, kill, terminal and output reads) are further limited to the
 *   caller itself, sessions it spawned (descendants), and sessions in rooms it coordinates;
 * - `service`: agent routes plus the few that host services (the runtime watcher, plan-usage) need;
 * - `owner`: everything else; every unclassified `/api` or `/ws` route is owner-only.
 * An agent bound to an employee on the owner-set admin list (`relations.ts` admin) may also call the
 * routes on ADMIN_ROUTES, whatever their class; the route handlers ask `adminGrant(req)`.
 *
 * The caller is the owner (a valid owner session cookie), a service (a service token), an agent
 * (an `X-Reverie-Parent-Session` that resolves; a routing hint, not authentication), or anonymous.
 * An owner-cookie request that changes state, or opens a WebSocket, must come from the console's
 * own origin (the Origin's host equals the Host header): same-site pages on another port or tailnet
 * name cannot ride the cookie.
 *
 * Policy `off` changes nothing. `log` lets everything through and records each would-be refusal
 * (aggregated per route and caller, at most hourly, at most 500 keys). `enforce` refuses: 401 for
 * anonymous callers (a browser page load is sent to the sign-in page, with `next=`), 403 otherwise.
 * A session signed in with a one-time password reaches only the password change.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Socket } from 'node:net';
import { ApiErrorCode, createErrorResponse } from '../types.js';
import type { SessionPort } from '../web/ports/session-port.js';
import { ownerFor, resolveParentSessionId } from '../web/route-helpers.js';
import { claimDelegatedSessionCreate, consumeDelegatedSessionCreate, hasDelegatedSessionCreate, delegatedSessionStartCaller } from './delegated-session-create.js';
import type { OwnerAuthService } from './service.js';
import type { Relations } from './relations.js';
import { goalRouteAction, type GoalAction } from '../goal-route-policy.js';

export const OWNER_COOKIE = 'reverie_owner';
export const DEVICE_COOKIE = 'reverie_owner_device';
export const SERVICE_HEADER = 'x-reverie-service-token';

export type RouteClass = 'public' | 'agent' | 'service' | 'owner';
export type CallerKind = 'owner' | 'restricted-owner' | 'limited' | 'service' | 'agent' | 'invalid' | 'anonymous';
export interface Caller {
  kind: CallerKind;
  /** The agent's own session id, for an agent caller. */
  session?: string;
}

/** Handlers enforce current employee grants; services never become headerless owners. */
const BOARD_DECISION_ROUTES = new Set(['POST /api/board/decisions', 'PATCH /api/board/decisions/:id', 'POST /api/board/decisions/:id/clear', 'PUT /api/board/polls/:roomId/:messageId/note']);
const BOARD_WRITE_ROUTES = new Set([
  'POST /api/board/issues', 'PATCH /api/board/issues/:id', 'POST /api/board/wins',
  'POST /api/board/milestones', 'PATCH /api/board/milestones/:id',
  'POST /api/board/blockers', 'POST /api/board/blockers/:id/clear',
  'PUT /api/board/agents/:memberId', 'PUT /api/board/marks', 'POST /api/board/import',
  ...BOARD_DECISION_ROUTES,
]);

// Exact routine routes only. Handlers retain explicit grants, author/room checks and
// post-only mutations; bot/grant management stays owner-only. Service tokens must
// not enter a handler's no-agent-header owner branch.
const ROUTINE_ROUTES = new Set([
  'GET /api/cron/jobs',
  'GET /api/cron/jobs/:id',
  'GET /api/cron/jobs/:id/runs',
  'GET /api/cron/runs',
  'POST /api/cron/jobs',
  'PUT /api/cron/jobs/:id',
  'DELETE /api/cron/jobs/:id',
  'PUT /api/cron/jobs/:id/enabled',
  'POST /api/cron/jobs/:id/run',
]);

const AGENT_ROUTES = new Set([
  ...ROUTINE_ROUTES,
  'POST /api/system/restart-website', // the host broker checks the explicit maintenance session grant
  'GET /api/sessions',
  'GET /api/sessions/:id',
  'DELETE /api/sessions/:id',
  'GET /api/sessions/:id/terminal',
  'GET /api/sessions/:id/last-response',
  'GET /api/sessions/:id/wait',
  'GET /api/sessions/:id/wait-output',
  'POST /api/sessions/:id/input',
  'POST /api/quick-start',
  'GET /api/session-lifecycle',
  'GET /api/company',
  'GET /api/handbook',
  'GET /api/handbook/:slug',
  'GET /api/chat-plugins', // shared enablement is readable; only the verified owner may change it
  'POST /api/company/employees/:id/wake', // route checks the explicit owner-granted recovery capability
  'GET /api/plans', // read-only; the route scopes by role (coordinators all accounts, other agents their own)
  // Private one-time approval credentials plus the exact current employee binding are checked by these handlers.
  'POST /api/plans/requests/:id/approve',
  'POST /api/plans/requests/:id/reject',
  'POST /api/plans/agent-requests/pending', // exact resolved agent session, self-only records
  'POST /api/plans/agent-requests', // handler checks exact employee and explicit plan permission
  'POST /api/plans/agent-requests/:id/status',
  'POST /api/plans/agent-requests/:id/cancel',
  'POST /api/plans/agent-requests/:id/reauthorize',
  'POST /api/company/self',
  'POST /api/company/self/avatar',
  'DELETE /api/company/self/avatar',
  // Experts: reading is open; hire and retire decide owner/delegate themselves (expert-routes.ts).
  'GET /api/experts',
  'GET /api/experts/:id',
  'POST /api/experts/:id/hire',
  'POST /api/experts/:id/retire',
  // The board: every agent's `reverie board` reads and moves cards.
  'GET /api/board',
  'GET /api/board/issues',
  'GET /api/publication/credentials',
  'GET /api/publication/credentials/status',
  'POST /api/publication/credentials/:id/material',
  'GET /api/agent/context',
  'POST /api/agent/context/receipt',
  'POST /api/agent/journal/save',
  'GET /api/agent/journal/recall',
  'GET /api/agent/journal/map',
  'GET /api/agent/journal/source',
  'GET /api/agent/journal/receipt/:turnId',
  ...BOARD_WRITE_ROUTES,
]);
/**
 * What an owner-set admin agent may call besides the agent routes. A whitelist: anything that sets
 * who someone is or what they may do stays owner-only, i.e. company settings (the CTO), employee edits
 * (the position the CTO/COO recovery reads), hiring, retiring, another employee's memories or thread,
 * ending a session, plans, settings, sign-in, the CLI registry and the mode switch.
 */
export const ADMIN_ROUTES = new Set([
  'GET /api/status',
  'POST /api/sessions',
  'POST /api/sessions/:id/interactive', // scoped like the session routes: itself and its descendants
  'PUT /api/company/employees/:id/session', // the CTO/COO recovery; the route keeps its own checks
  'POST /api/company/employees/:id/restore',
  'POST /api/company/employees/:id/invite',
  'POST /api/company/temporary/prune',
  'DELETE /api/company/temporary/:sessionId',
]);
/** Agent routes that act on another session: scoped by `relations.ts` (related, upward, keeper). */
export const SESSION_SCOPED_ROUTES = new Set([
  'DELETE /api/sessions/:id',
  'GET /api/sessions/:id/terminal',
  'GET /api/sessions/:id/last-response',
  'GET /api/sessions/:id/wait',
  'GET /api/sessions/:id/wait-output',
  'POST /api/sessions/:id/input',
  'POST /api/sessions/:id/interactive',
]);
const INPUT_ROUTE = 'POST /api/sessions/:id/input';
/** Routes whose body may name the new session's parent (`parentSessionId`). */
const PARENT_BODY_ROUTES = new Set(['POST /api/quick-start', 'POST /api/sessions']);
const SERVICE_ROUTES = new Set(['PUT /api/company/employees/:id/session', 'GET /api/subscription-profiles/usage']);
const PUBLIC_ROUTES = new Set([
  'GET /api/owner/status',
  'POST /api/owner/setup',
  'POST /api/owner/login',
  'POST /api/owner/login/second-factor',
  'POST /api/owner/logout',
  'POST /api/hook-event',
  'POST /api/status-telemetry',
  // Authenticated only by its service assertion header (service-decision.ts); a bare 403 without one.
  'POST /api/service-decisions',
]);
/** What a session signed in with a one-time password may still reach. */
const RESTRICTED_ROUTES = new Set(['GET /api/owner/status', 'POST /api/owner/password', 'POST /api/owner/logout']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The decoded, slash-collapsed path of an unmatched request, or undefined when it cannot be decoded. */
export function decodedPath(url: string): string | undefined {
  try {
    return decodeURIComponent(url.split('?')[0]).replace(/\/{2,}/g, '/');
  } catch {
    return undefined;
  }
}

const isPrivatePath = (path: string) => {
  const lower = path.toLowerCase();
  return lower === '/api' || lower.startsWith('/api/') || lower === '/ws' || lower.startsWith('/ws/');
};

/** The class of a request: by its matched route pattern, or (unmatched) by its decoded path. */
/** The stable status-page route (status-page-routes.ts registers it). */
export const STATUS_PAGE_ROUTE = '/status/:name';

export function classify(method: string, route: string | undefined, rawUrl: string): RouteClass {
  if (route !== undefined) {
    const key = `${method} ${route}`;
    if (isEmbassyProtocolRoute(method, route)) return 'public';
    if (PUBLIC_ROUTES.has(key)) return 'public';
    if (route === '/owner' || route.startsWith('/owner/')) return 'public';
    if (route.startsWith('/api/chatrooms')) return 'agent'; // those routes make their own owner/agent decisions
    if (AGENT_ROUTES.has(key)) return 'agent';
    if (SERVICE_ROUTES.has(key)) return 'service';
    if (isPrivatePath(route)) return 'owner';
    // A status page mints an html-view capability (status-page-routes.ts): owner-only, like the APIs.
    if (route === STATUS_PAGE_ROUTE) return 'owner';
    return 'public'; // the app shell, static assets, capability and QR paths
  }
  const path = decodedPath(rawUrl);
  if (path === undefined || isPrivatePath(path) || path.includes('/../') || path.endsWith('/..')) return 'owner';
  return 'public';
}

export function allowed(routeClass: RouteClass, caller: CallerKind): boolean {
  if (routeClass === 'public') return true;
  if (caller === 'owner') return true;
  if (routeClass === 'agent') return caller === 'agent' || caller === 'service';
  if (routeClass === 'service') return caller === 'service';
  return false;
}

/** A browser loading the app: without an owner session in enforce mode it is sent to sign in. */
export function isAppPage(req: FastifyRequest, route: string | undefined): boolean {
  if (req.method !== 'GET') return false;
  // A status page is a bookmark (status-page-routes.ts): a signed-out browser goes to login and back, not a 401.
  if (route === '/' || route === '/index.html' || route === STATUS_PAGE_ROUTE) return true;
  if (route !== undefined) return false;
  const path = decodedPath(req.url ?? '') ?? '';
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html') && !isPrivatePath(path) && !path.startsWith('/owner');
}

/** The Origin's host equals the Host header: the request comes from the console's own pages. */
export function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || !host) return false;
  try {
    // Parse the Host with the Origin's scheme, so default ports (:80, :443) normalize the same way.
    const from = new URL(origin);
    return from.host === new URL(`${from.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

export interface PolicyDeps {
  /** Only exact registered Goal routes defer to this purpose-auth/custody/action gate after raw-body verification.
   * Absence denies them even when ordinary owner policy is off/log. Never a generic agent allowlist. */
  goalRequest?: (request: FastifyRequest, action: GoalAction) => Promise<void>;
  service: OwnerAuthService;
  ctx: SessionPort;
  /** Capability-authenticated paths the existing auth middleware lets through (webview, html-view, QR). */
  isCapabilityRequest: (req: FastifyRequest) => boolean;
  /** Which agent session may act on which (see `relations.ts`). */
  relations: Relations;
  basePath?: string;
  now?: () => number;
}

export function callerOf(req: FastifyRequest, deps: Pick<PolicyDeps, 'service' | 'ctx'>): Caller {
  const session = deps.service.session(req.cookies?.[OWNER_COOKIE]);
  if (session) return { kind: session.role === 'limited' ? 'limited' : session.restricted ? 'restricted-owner' : 'owner' };
  const token = req.headers[SERVICE_HEADER];
  if (typeof token === 'string' && deps.service.service(token)) return { kind: 'service' };
  if (req.headers['x-reverie-parent-session'] !== undefined) {
    const id = resolveParentSessionId(deps.ctx, req, undefined, ownerFor(req)) ?? delegatedSessionStartCaller(req);
    return id ? { kind: 'agent', session: id } : { kind: 'invalid' };
  }
  return { kind: 'anonymous' };
}

const MAX_LOG_KEYS = 500;

// The admin agent each granted request was let through for (set by the policy hook, read by handlers).
const adminGrants = new WeakMap<FastifyRequest, string>();
/** The admin agent's session when the policy let this request through on the admin list. */
export function adminGrant(req: FastifyRequest): string | undefined {
  return adminGrants.get(req);
}

export function registerOwnerPolicy(app: FastifyInstance, deps: PolicyDeps): void {
  const logged = new Map<string, { at: number; count: number }>();
  const now = () => (deps.now ?? Date.now)();

  // Repeated events are audited at most hourly per key, with a count.
  const auditHourly = (event: string, key: string, detail: Record<string, unknown>) => {
    key = event + ' ' + key;
    const entry = logged.get(key) ?? { at: 0, count: 0 };
    if (!logged.has(key) && logged.size >= MAX_LOG_KEYS) return; // bounded: a flood of junk cannot grow it
    entry.count++;
    if (now() - entry.at >= 60 * 60 * 1000) {
      void deps.service.audit(event, { ...detail, count: entry.count });
      entry.at = now();
      entry.count = 0;
    }
    logged.set(key, entry);
  };

  const callers = new WeakMap<FastifyRequest, Caller>();

  // A new session's parent: an agent may name only itself or one of its own descendants. Anything
  // else would let it spawn a child "under" any session and reach it through the upward rule. The
  // body is parsed only after onRequest, so this check runs as a preHandler; a refused value is
  // dropped (the caller's own header then names the parent), not an error.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const goalAction = goalRouteAction(req);
    if (goalAction) {
      try {
        if (!deps.goalRequest) throw new Error('Goal integration unavailable');
        await deps.goalRequest(req, goalAction);
      } catch {
        return reply
          .code(403)
          .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Goal integration is unavailable or refused'));
      }
      return;
    }
    if (consumeDelegatedSessionCreate(req) === false)
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'The delegated session authorization changed or the session request did not match'));
    const policy = deps.service.policy();
    const caller = callers.get(req);
    if (policy === 'off' || caller?.kind !== 'agent') return;
    const key = `${req.method} ${req.routeOptions?.url}`;
    const body = req.body as { parentSessionId?: unknown } | undefined;
    const declared = body && typeof body === 'object' ? body.parentSessionId : undefined;
    if (!PARENT_BODY_ROUTES.has(key) || declared === undefined || declared === null || declared === '') return;
    if (typeof declared === 'string' && deps.relations.related(caller.session!, declared)) return;
    const detail = { caller: caller.session, route: key, declared: String(declared).slice(0, 100) };
    if (policy === 'log')
      return auditHourly('policy_would_deny', `agent parent_declared ${key}`, { ...detail, reason: 'parent_declared' });
    delete body!.parentSessionId;
    auditHourly('parent_ignored', `${caller.session} ${key}`, detail);
  });

  // Read the policy once at startup, so a missing account file is reported now, not at the first request.
  deps.service.policy();

  // Long-lived owner connections are re-checked every minute (expiry, a CLI epoch bump).
  const sweep = setInterval(() => deps.service.closeEnded(), 60_000);
  sweep.unref?.();
  app.addHook('onClose', async () => clearInterval(sweep));

  const refuse = (reply: FastifyReply, status: 401 | 403, message: string, code = ApiErrorCode.FORBIDDEN) =>
    reply.code(status).send(createErrorResponse(status === 401 ? ApiErrorCode.UNAUTHORIZED : code, message));

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Limited accounts remain limited even when an operator changes the owner policy to off/log.
    const signedIn = deps.service.session(req.cookies?.[OWNER_COOKIE]);
    if (signedIn?.role === 'limited') {
      const route = req.routeOptions?.url, path = decodedPath(req.url ?? '');
      const key = `${req.method} ${route}`;
      if (req.headers['x-reverie-parent-session'] !== undefined || req.headers[SERVICE_HEADER] !== undefined)
        return refuse(reply, 403, 'A human login cannot act as an agent or service');
      if ((!SAFE_METHODS.has(req.method) || req.headers.upgrade) && !sameOrigin(req))
        return refuse(reply, 403, 'Requests must come from this console');
      if (path === '/' || path === '/index.html') return reply.redirect(`${deps.basePath ?? ''}${signedIn.restricted ? '/owner/account' : '/office'}`);
      if (signedIn.restricted && !RESTRICTED_ROUTES.has(key) && !['/owner/account', '/owner/owner.js'].includes(path ?? ''))
        return refuse(reply, 403, 'Change the one-time password first', ApiErrorCode.PASSWORD_CHANGE_REQUIRED);
      if (LIMITED_ROUTES.has(key) || (path && limitedAsset(req.method, path))) return;
      return refuse(reply, 403, 'This login has limited channel access');
    }
    // Keep the current Limited-account boundary ahead of Goal's purpose-specific gate.
    // Exact Goal routes still require raw-body/provenance verification and the preHandler below.
    if (goalRouteAction(req)) return;
    const policy = deps.service.policy();
    if (policy === 'off' && !hasDelegatedSessionCreate()) return;
    const route = req.routeOptions?.url;
    const rawUrl = req.url ?? '';
    const routeClass = deps.isCapabilityRequest(req) ? 'public' : classify(req.method, route, rawUrl);
    const caller = callerOf(req, deps);
    callers.set(req, caller);
    const delegatedHire = caller.kind === 'agent' && claimDelegatedSessionCreate(req, caller.session);
    if (policy === 'off') return;
    const key = route !== undefined ? `${req.method} ${route}` : `UNMATCHED ${req.method}`;
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const deny = (status: 401 | 403, message: string, reason: string, code?: ApiErrorCode) => {
      if (policy === 'log')
        return auditHourly('policy_would_deny', `${caller.kind} ${reason} ${key}`, {
          caller: caller.kind,
          reason,
          route: key,
        });
      return refuse(reply, status, message, code);
    };

    if (caller.kind === 'owner' || caller.kind === 'restricted-owner') {
      if ((!SAFE_METHODS.has(req.method) || upgrade) && !sameOrigin(req)) {
        return deny(403, 'Owner requests must come from this console', 'cross_origin');
      }
      const token = req.cookies?.[OWNER_COOKIE];
      if (token && (upgrade || String(req.headers.accept ?? '').includes('text/event-stream'))) {
        deps.service.track(token, req.raw.socket as Socket);
      }
    }

    if (caller.kind === 'restricted-owner') {
      if (isAppPage(req, route)) {
        if (policy === 'enforce') return reply.redirect(`${deps.basePath ?? ''}/owner/account`);
        return;
      }
      if (routeClass === 'public') return;
      if (RESTRICTED_ROUTES.has(key)) return;
      return deny(403, 'Change the one-time password first', 'restricted', ApiErrorCode.PASSWORD_CHANGE_REQUIRED);
    }
    if (isAppPage(req, route) && caller.kind !== 'owner') {
      if (policy === 'enforce') {
        const next = encodeURIComponent(rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl : '/');
        return reply.redirect(
          `${deps.basePath ?? ''}/owner/${deps.service.setupAvailable() ? 'setup' : 'login'}?next=${next}`
        );
      }
      return;
    }
    if (caller.kind === 'service' && BOARD_WRITE_ROUTES.has(key)) {
      return deny(403, 'Only the verified owner or a permitted employee may update the board', 'decision_service');
    }
    const admin = caller.kind === 'agent' && ADMIN_ROUTES.has(key) && deps.relations.admin(caller.session!);
    if (admin) {
      adminGrants.set(req, caller.session!);
      auditHourly('admin_action', `${caller.session} ${key}`, { caller: caller.session, route: key });
    }
    if (ROUTINE_ROUTES.has(key) && caller.kind === 'service') {
      return deny(403, 'Service tokens cannot act as routine authors', 'routine_service');
    }
    if (!admin && !delegatedHire && !allowed(routeClass, caller.kind)) {
      if (caller.kind === 'anonymous') return deny(401, 'Sign in as the owner', 'anonymous');
      return deny(403, 'Only the owner may do this', 'owner_only');
    }
    if (caller.kind === 'agent' && SESSION_SCOPED_ROUTES.has(key)) {
      const target = (req.params as { id?: string } | undefined)?.id;
      const self = caller.session!;
      // A stopped session's persisted record counts too: ending it retires its restore record.
      if (target && target !== self && deps.relations.known(target)) {
        // Full control only over itself and its recorded descendants; everything else is input only.
        const input = key === INPUT_ROUTE;
        const grant = deps.relations.related(self, target)
          ? 'related'
          : !input
            ? undefined
            : deps.relations.coordinated(self, target)
              ? 'coordinated'
              : deps.relations.keeper(self)
                ? 'keeper'
                : deps.relations.upward(self, target)
                  ? 'upward'
                  : undefined;
        if (!grant) {
          return deny(
            403,
            input
              ? 'An agent may send input only to itself, sessions it spawned, its parent or coordinator, or members the owner placed in a room it coordinates'
              : 'An agent may read or end only itself and sessions it spawned',
            'not_related'
          );
        }
        if (grant === 'keeper' || grant === 'upward') {
          auditHourly(grant + '_action', `${self} ${key} ${target}`, { caller: self, route: key, target });
        }
      }
    }
  });
}
