/**
 * @fileoverview The authorization-decision transport for host services (OPS executor, prune, resume, REST): one POST
 * carrying a service assertion header and a strict target body. The assertion is the only credential; without a valid
 * assertion for a configured purpose the answer is a bare 403. A decision authorizes nothing by itself: the caller asks
 * again with a fresh assertion immediately before its effect and requires the same policyGeneration.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CompanyService } from './company-service.js';
import { servicePurposeScope } from './company-types.js';
import { GoalAccessError, type GoalAuthentication } from './goal-access.js';
import { GoalLifecycleError, type GoalLifecycle } from './goal-lifecycle.js';
import { GoalNonceStore, type GoalNonceStoreOptions } from './goal-nonce-store.js';
import { serviceIssuers, serviceNonces, type LoadedServiceAuth } from './service-auth-config.js';
import {
  ServiceGrantAuthentication,
  canonicalServiceGrantSource,
  type ServiceEmployeeBinding,
  type ServiceGrantPorts,
} from './service-grant-auth.js';

export const SERVICE_ASSERTION_HEADER = 'x-reverie-service-assertion';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const DecisionRequestSchema = z
  .object({ action: z.string().regex(/^[a-z][a-z0-9.-]{0,95}$/), employeeId: id.optional(), resourceId: id.optional() })
  .strict();

export interface ServiceDecision {
  readonly decision: 'allowed' | 'denied';
  readonly reason: 'none' | 'unauthorized';
  readonly grantRef: { readonly grantId: string; readonly policyGeneration: string };
  readonly epoch: string;
  readonly actor?: { readonly employeeId: string; readonly sessionId: string; readonly sessionGeneration: number };
}
export interface ServiceDecisionDeps {
  readonly loaded: LoadedServiceAuth;
  readonly auth: ServiceGrantAuthentication;
  readonly binding: ServiceGrantPorts['binding'];
}

export class ServiceDecisions {
  constructor(private readonly deps?: ServiceDecisionDeps) {}

  /** null means unavailable or not authenticated: the route answers 403 and the caller refuses. */
  async decide(assertion: unknown, body: unknown): Promise<ServiceDecision | null> {
    try {
      const d = this.deps;
      if (!d || typeof assertion !== 'string') return null;
      const parsed = DecisionRequestSchema.safeParse(body);
      if (!parsed.success) return null;
      const { action, employeeId, resourceId } = parsed.data;
      const purpose = d.loaded.purposeFor(action);
      const scope = purpose === undefined ? undefined : servicePurposeScope(d.loaded.purposes, purpose);
      if (!purpose || !scope) return null;
      if (
        (scope !== 'resources') !== (employeeId !== undefined) ||
        (scope !== 'employees') !== (resourceId !== undefined)
      )
        return null;
      const lease = await d.auth.authenticate({ assertion }, purpose);
      if (!lease) return null;
      const allowed =
        scope === 'employees+resources'
          ? lease.currentFor(employeeId!, resourceId!)
          : lease.current(scope === 'employees' ? employeeId! : resourceId!);
      let actor: ServiceDecision['actor'];
      if (employeeId !== undefined) {
        const current: ServiceEmployeeBinding | undefined = d.binding(employeeId);
        if (current)
          actor = Object.freeze({
            employeeId: current.employeeId,
            sessionId: current.sessionId,
            sessionGeneration: current.sessionGeneration,
          });
      }
      return Object.freeze({
        decision: allowed ? 'allowed' : 'denied',
        reason: allowed ? 'none' : 'unauthorized',
        grantRef: Object.freeze({ grantId: lease.grantId, policyGeneration: lease.generation }),
        epoch: lease.epoch,
        ...(actor ? { actor } : {}),
      });
    } catch {
      return null;
    }
  }
}

/** Registered unconditionally; without configured decisions every request is a bare 403. */
export function registerServiceDecisionRoute(
  app: FastifyInstance,
  decisions: ServiceDecisions = new ServiceDecisions()
): void {
  app.post('/api/service-decisions', async (req, reply) => {
    const decision = await decisions.decide(req.headers[SERVICE_ASSERTION_HEADER], req.body);
    if (!decision) {
      reply.code(403);
      return { success: false, errorCode: 'SERVICE_FORBIDDEN', error: 'Service decision unavailable' };
    }
    return decision;
  });
}

/** Owner-only service grant routes, independent of Goal features: the ordinary owner policy (owner cookie, same origin)
 * plus the lifecycle's own owner re-authentication and local custody. Without a configured lifecycle every call is 403. */
export function registerServiceGrantRoutes(app: FastifyInstance, grants?: GoalLifecycle): void {
  const run = async (reply: FastifyReply, operation: (g: GoalLifecycle) => Promise<unknown>) => {
    if (!grants) {
      reply.code(403);
      return { success: false, errorCode: 'SERVICE_FORBIDDEN', error: 'Service grants unavailable' };
    }
    try {
      return { success: true, data: await operation(grants) };
    } catch (error) {
      if (!(error instanceof GoalLifecycleError || error instanceof GoalAccessError)) throw error;
      reply.code(error.status);
      return { success: false, errorCode: error.code, error: error.message };
    }
  };
  app.post('/api/service-grants', (req, reply) => run(reply, (g) => g.issueServiceGrant(req.body, req)));
  app.post<{ Params: { id: string } }>('/api/service-grants/:id/revoke', (req, reply) =>
    run(reply, (g) => g.revokeServiceGrant(req.params.id, req))
  );
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Owner-only setup page: one row and button per configured setupGrants entry, with current employee ids (exact id or
 * exact unique display name of an active employee) and the principal's configured epoch filled in. Rows that do not
 * resolve show why and have no button. Clicking POSTs the shown body to /api/service-grants; nothing is auto-issued. */
export function registerServiceGrantSetupPage(
  app: FastifyInstance,
  setup?: {
    loaded: LoadedServiceAuth;
    company: Pick<CompanyService, 'store'>;
    owner: GoalAuthentication;
    now?: () => number;
  }
): void {
  app.get('/api/service-grants/setup', async (req, reply) => {
    const principal = setup ? await setup.owner.authenticate(req).catch(() => undefined) : undefined;
    if (!setup || !principal || principal.kind !== 'owner') {
      reply.code(403);
      return { success: false, errorCode: 'SERVICE_FORBIDDEN', error: 'Owner setup page unavailable' };
    }
    const state = setup.company.store.snapshot();
    const now = (setup.now ?? Date.now)();
    const active = state.employees.filter(
      (e) => e.owner === principal.owner && !e.bindingMigration && !e.onVacation && e.desiredRunning !== false
    );
    const rows = setup.loaded.config.setupGrants.map((row, index) => {
      const epoch = setup.loaded.config.principals.find((p) => p.principal === row.principal)?.epoch;
      const problems: string[] = [];
      if (!epoch) problems.push(`principal ${row.principal} is not configured`);
      if (!setup.loaded.purposes[row.purpose]) problems.push(`purpose ${row.purpose} is not configured`);
      const ids = row.employees.map((ref) => {
        const byId = active.filter((e) => e.id === ref);
        const byName = active.filter((e) => e.name === ref);
        const match = byId.length === 1 ? byId : byName;
        if (match.length !== 1) problems.push(`employee "${ref}" does not resolve to exactly one active employee`);
        return match.length === 1 ? { id: match[0]!.id, label: match[0]!.name ?? match[0]!.id } : undefined;
      });
      const body = {
        purpose: row.purpose,
        principal: row.principal,
        epoch: epoch ?? '',
        ...(row.employees.length ? { employeeIds: ids.map((e) => e?.id ?? '') } : {}),
        ...(row.resources.length ? { resources: row.resources } : {}),
        expiresAt: now + row.expiresInHours * 3600_000,
      };
      const who = ids.map((e, i) =>
        e ? `${escape(e.label)} (${escape(e.id)})` : `<b>${escape(row.employees[i]!)}?</b>`
      );
      return `<tr><td>${escape(row.purpose)}</td><td>${escape(row.principal)} / ${escape(epoch ?? '?')}</td><td>${
        who.join(', ') || '-'
      }</td><td>${escape(row.resources.join(', ') || '-')}</td><td>${row.expiresInHours} h</td><td>${
        problems.length
          ? escape(problems.join('; '))
          : `<button data-row="${index}" data-body="${escape(JSON.stringify(body))}">Issue</button> <span id="r${index}"></span>`
      }</td></tr>`;
    });
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service grants</title><style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #8884;padding:6px;text-align:left;vertical-align:top}button{padding:4px 12px}</style></head><body>
<h1>Service grants: owner setup</h1><p>Each button issues exactly the grant shown. Nothing is issued until you click. Revoke
with POST /api/service-grants/&lt;id&gt;/revoke.</p><table><tr><th>Purpose</th><th>Principal / epoch</th><th>Employees</th>
<th>Resources</th><th>Expires</th><th></th></tr>${rows.join('')}</table>
<script>document.querySelectorAll('button[data-body]').forEach(function(b){b.addEventListener('click',function(){
b.disabled=true;var out=document.getElementById('r'+b.dataset.row);fetch(location.pathname.replace(/\/setup$/,''),{method:'POST',
credentials:'same-origin',headers:{'content-type':'application/json'},body:b.dataset.body}).then(function(r){return r.json()})
.then(function(j){out.textContent=j.success?('issued '+j.data.id):('refused: '+(j.error||'?'));if(!j.success)b.disabled=false})
.catch(function(){out.textContent='failed';b.disabled=false})})})</script></body></html>`;
  });
}

/** Launcher-time assembly (r2d): ONE loaded config; the canonical grant reads use the Goal private bootstrap's projected
 * custody, and service nonces use the Goal private bootstrap's projected nonce store (whole-scope custody re-proved by the
 * backend before every storage operation) under the "service:" issuer namespace. No separate ledger, no local mode checks
 * standing in for custody. Without that provisioning the caller passes nothing and every decision is unavailable. */
export function createServiceDecisions(
  loaded: LoadedServiceAuth,
  options: {
    readonly company: Pick<CompanyService, 'store'>;
    readonly custody: Pick<GoalAuthentication, 'assertPrivateCustody'>;
    readonly nonce: GoalNonceStoreOptions;
    readonly now?: () => number;
  }
): ServiceDecisions {
  const source = canonicalServiceGrantSource({ company: options.company, custody: options.custody });
  const auth = new ServiceGrantAuthentication(
    {
      issuer: serviceIssuers(loaded),
      ...source,
      nonces: serviceNonces(new GoalNonceStore(options.nonce)),
      ...(options.now ? { now: options.now } : {}),
    },
    loaded.purposes
  );
  return new ServiceDecisions({ loaded, auth, binding: source.binding });
}
