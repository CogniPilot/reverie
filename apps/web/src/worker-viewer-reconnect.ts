/** Bounded repair of disposable worker viewers; never a provider launch. */
import type { CompanyService } from './company-service.js';
import type { CompanyEmployee } from './company-types.js';
import type { Session } from './session.js';
import { expertRuntimeRecipe } from './expert-runtime-recipe.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ownerFor, parseBody } from './web/route-helpers.js';
import type { RecoveryAuthority, WorkerRecoveryAuthentication } from './worker-recovery-auth.js';
import { RECOVERY_HEADER } from './worker-recovery-auth.js';
import type { PlanViewerReconnectLease } from './plan-move.js';

const BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export type ViewerReconnectResult = 'connected' | 'unavailable' | 'busy' | 'changed';
export interface ViewerReconnectStatus {
  state: 'idle' | 'connecting' | 'connected' | 'blocked';
  reason: string;
  attempts: number;
  retryAfterMs: number;
}
const bindingKey = (e: CompanyEmployee) => JSON.stringify([e.id,e.owner,e.sessionId,e.sessionGeneration,
  e.desiredRunning,e.onVacation,e.bindingMigration,e.runtimeRecipe,e.permissions]);
export interface ViewerReconnectDeps {
  company: CompanyService;
  session(id: string): Session | undefined;
  ready(): boolean;
  /** Fresh, bound native command observation; no provider launch authority. */
  providerHealthy(employee: CompanyEmployee): boolean;
  moveGuard(employeeId: string): Promise<(() => boolean) & Partial<Pick<PlanViewerReconnectLease, 'close' | 'revalidate'>>>;
  pause(id: string): () => void;
  publish(session: Session): void;
  now?(): number;
}

export class WorkerViewerReconnect {
  private flights = new Set<string>();
  private attempts = new Map<string, { key: string; count: number; next: number }>();
  private ticking = false;
  private lastAutomaticEmployeeId?: string;
  private outcomes = new Map<string, { key: string; reason: string; connected: boolean }>();
  constructor(private readonly deps: ViewerReconnectDeps) {}

  delegated(authority: RecoveryAuthority): () => boolean {
    const caller = this.deps.session(authority.sessionId);
    return () => {
      try { authority.assertCurrent(); } catch { return false; }
      const employee = this.deps.company.registeredEmployees().find(e => e.id === authority.employeeId);
      return !!caller && this.deps.session(authority.sessionId) === caller && caller.owner === authority.owner &&
        !!employee && employee.permissions.recoverEmployees === true;
    };
  }

  status(employeeId: string, expected: { sessionId: string; sessionGeneration: number }, owner?: string): ViewerReconnectStatus {
    const d = this.deps, employee = d.company.registeredEmployees().find(e => e.id === employeeId && e.owner === owner);
    const result = (reason: string, state: ViewerReconnectStatus['state'] = 'blocked'): ViewerReconnectStatus => ({ state, reason, attempts: 0, retryAfterMs: 0 });
    if (!employee || employee.sessionId !== expected.sessionId || employee.sessionGeneration !== expected.sessionGeneration) return result('stale-binding');
    if (!d.ready()) return result('server-not-ready');
    if (employee.bindingMigration) return result('binding-migration');
    if (employee.desiredRunning !== true || employee.onVacation) return result('not-running');
    const session = d.session(employee.sessionId), key = bindingKey(employee);
    const previous = this.attempts.get(employeeId), outcome = this.outcomes.get(employeeId);
    if (session?.owner !== owner || !session) return result('viewer-unavailable');
    if (session.runtimeHealth !== 'disconnected') return result(outcome?.key === key && outcome.connected ? 'connected' : 'viewer-not-disconnected',
      outcome?.key === key && outcome.connected ? 'connected' : 'idle');
    const attempts = previous?.key === key ? previous.count : 0;
    const retryAfterMs = previous?.key === key ? Math.max(0, Math.ceil(previous.next - (d.now ?? (() => performance.now()))())) : 0;
    if (this.flights.has(employeeId)) return { state: 'connecting', reason: 'in-progress', attempts, retryAfterMs };
    if (session.workerViewerReconnectBlocker) return { ...result(session.workerViewerReconnectBlocker), attempts, retryAfterMs };
    if (!d.providerHealthy(employee)) return { ...result('native-health-unavailable'), attempts, retryAfterMs };
    return { state: 'blocked', reason: outcome?.key === key ? outcome.reason : 'not-attempted', attempts, retryAfterMs };
  }

  async diagnostics(employeeId: string, expected: { sessionId: string; sessionGeneration: number }, owner?: string): Promise<ViewerReconnectStatus> {
    const status = this.status(employeeId, expected, owner);
    if (status.state !== 'blocked' || ['stale-binding','server-not-ready','binding-migration','not-running','viewer-unavailable'].includes(status.reason)) return status;
    let current: Awaited<ReturnType<ViewerReconnectDeps['moveGuard']>> | undefined;
    try {
      current = await this.deps.moveGuard(employeeId);
      const fresh = this.status(employeeId, expected, owner);
      return !current() && fresh.state === 'blocked' ? { ...fresh, reason: 'move-in-progress' } : fresh;
    } catch { return { ...this.status(employeeId, expected, owner), state: 'blocked', reason: 'admission-unavailable' }; }
    finally { current?.close?.(); }
  }

  async reconnect(employeeId: string, expected: { sessionId: string; sessionGeneration: number },
    owner: string | undefined, automatic = false, authorized: () => boolean = () => true): Promise<ViewerReconnectResult> {
    const d = this.deps, now = d.now ?? (() => performance.now());
    const original = d.company.registeredEmployees().find(e => e.id === employeeId && e.owner === owner);
    if (!authorized() || !d.ready() || !original || original.sessionId !== expected.sessionId ||
      original.sessionGeneration !== expected.sessionGeneration || original.desiredRunning !== true ||
      original.onVacation || original.bindingMigration) return 'changed';
    const session = d.session(original.sessionId);
    if (!session?.workerViewerReconnect || session.owner !== owner || session.runtimeHealth !== 'disconnected')
      return 'unavailable';
    if (!d.providerHealthy(original)) return 'unavailable';
    if (this.flights.has(employeeId)) return 'busy';
    const fingerprint = bindingKey;
    const runtime = JSON.stringify(expertRuntimeRecipe(session));
    const key = fingerprint(original), previous = this.attempts.get(employeeId);
    const outcome = (reason: string, result: ViewerReconnectResult) => {
      if (this.outcomes.size >= 200 && !this.outcomes.has(employeeId)) this.outcomes.delete(this.outcomes.keys().next().value!);
      this.outcomes.set(employeeId, { key, reason, connected: result === 'connected' });
      return result;
    };
    if (automatic && previous?.key === key && now() < previous.next)
      return 'unavailable';
    this.flights.add(employeeId);
    const count = previous?.key === key ? previous.count : 0;
    this.attempts.set(employeeId, { key, count: Math.min(count + 1, 1000),
      next: now() + BACKOFF[Math.min(count, BACKOFF.length - 1)] });
    // Advance before asynchronous admission: a throwing attempt still owns its seat.
    if (automatic) this.lastAutomaticEmployeeId = employeeId;
    let release: (() => void) | undefined;
    let moveCurrent: Awaited<ReturnType<ViewerReconnectDeps['moveGuard']>> | undefined;
    let claim: ReturnType<CompanyService['prepareWake']>;
    try {
      try { moveCurrent = await d.moveGuard(employeeId); }
      catch (error) { outcome('admission-unavailable', 'unavailable'); throw error; }
      const current = () => {
        const employee = d.company.registeredEmployees().find(e => e.id === employeeId);
        return authorized() && d.ready() && !!moveCurrent?.() && !!employee && fingerprint(employee) === key &&
          d.providerHealthy(employee) && d.session(original.sessionId) === session &&
          JSON.stringify(expertRuntimeRecipe(session)) === runtime && (!claim || claim.current());
      };
      if (!current()) return outcome(!authorized() ? 'authority-changed' : !moveCurrent() ? 'move-in-progress' : 'binding-or-health-changed', 'changed');
      claim = d.company.prepareWake(employeeId, original.sessionId);
      if (!claim || !current()) return outcome('lifecycle-in-progress', 'busy');
      release = d.pause(original.sessionId);
      if (!await session.reconnectWorkerViewer(current, moveCurrent.revalidate?.bind(moveCurrent))) return outcome(!authorized() ? 'authority-changed' :
        session.workerViewerReconnectBlocker ?? 'readiness-unconfirmed', current() ? 'unavailable' : 'changed');
      if (!current()) return outcome('binding-or-authority-changed', 'changed');
      d.publish(session);
      this.attempts.delete(employeeId);
      return outcome('connected', 'connected');
    } finally {
      // Releasing this pause never acknowledges/replays durable unknown deliveries.
      release?.(); claim?.finish(); moveCurrent?.close?.(); this.flights.delete(employeeId);
    }
  }

  /** One seat per watcher tick; bounded backoff is shared with the manual path. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.ready()) return;
    this.ticking = true;
    try {
      const employees = this.deps.company.registeredEmployees();
      const previousIndex = employees.findIndex(employee => employee.id === this.lastAutomaticEmployeeId);
      for (let offset = 1; offset <= employees.length; offset++) {
        const employee = employees[(previousIndex + offset) % employees.length];
        const session = this.deps.session(employee.sessionId);
        if (session?.runtimeHealth !== 'disconnected') { this.attempts.delete(employee.id); continue; }
        const previous = this.attempts.get(employee.id);
        // reconnect owns fingerprint-aware eligibility. A refused/ineligible row
        // must not starve later seats or retain an old binding's exhausted budget.
        const result = await this.reconnect(employee.id, employee, employee.owner, true);
        if (result === 'connected' || this.attempts.get(employee.id) !== previous) break;
      }
    } finally { this.ticking = false; }
  }
}

const Reconnect = z.object({ sessionId: z.string().uuid(), sessionGeneration: z.number().int().min(1) }).strict();
export function registerWorkerViewerReconnect(app: FastifyInstance, controller: WorkerViewerReconnect,
  verifiedOwner: (req: FastifyRequest) => boolean, recoveryAuth?: WorkerRecoveryAuthentication) {
  for (const action of ['', '/status']) app.post('/api/company/employees/:id/reconnect' + action, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    let authorized: () => boolean;
    if (req.headers['x-reverie-parent-session'] === undefined && req.headers[RECOVERY_HEADER] === undefined &&
      req.headers['x-reverie-service-token'] === undefined && verifiedOwner(req)) authorized = () => verifiedOwner(req);
    else {
      try {
        const authority = await recoveryAuth?.authenticate(req);
        if (!authority || authority.owner !== ownerFor(req)) throw Error('Recovery proof unavailable');
        authorized = controller.delegated(authority);
      } catch { return reply.code(403).send({ success: false, error: 'Authenticated owner-delegated recovery is required' }); }
    }
    if (!authorized()) return reply.code(403).send({ success: false, error: 'Recovery authority is unavailable or revoked' });
    const expected = parseBody(Reconnect, req.body);
    const id = (req.params as { id: string }).id;
    try {
      if (action) {
        const reconnect = await controller.diagnostics(id, expected, ownerFor(req));
        if (!authorized()) return reply.code(403).send({ success: false, error: 'Recovery authority changed during inspection' });
        return { success: true, data: { reconnect } };
      }
      const state = await controller.reconnect(id, expected, ownerFor(req), false, authorized);
      if (!authorized()) return reply.code(403).send({ success: false, error: 'Recovery authority changed during repair' });
      const reconnect = controller.status(id, expected, ownerFor(req));
      if (state !== 'connected') return reply.code(409).send({ success: false, reconnect,
        error: state === 'busy' ? 'A reconnect or session action is already in progress' :
          'The viewer connection was not confirmed. Check the current expert status; no replacement was started.' });
      return { success: true, data: { state: 'viewer-connected', reconnect } };
    } catch {
      return reply.code(503).send({ success: false, error: 'The viewer connection could not be confirmed. No replacement was started.' });
    }
  });
}
