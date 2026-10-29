/** Bounded repair of disposable worker viewers; never a provider launch. */
import type { CompanyService } from './company-service.js';
import type { Session } from './session.js';
import { expertRuntimeRecipe } from './expert-runtime-recipe.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ownerFor, parseBody } from './web/route-helpers.js';

const BACKOFF = [2_000, 5_000, 15_000] as const;
export type ViewerReconnectResult = 'connected' | 'unavailable' | 'busy' | 'changed';
export interface ViewerReconnectDeps {
  company: CompanyService;
  session(id: string): Session | undefined;
  ready(): boolean;
  moveGuard(employeeId: string): Promise<() => boolean>;
  pause(id: string): () => void;
  publish(session: Session): void;
  now?(): number;
}

export class WorkerViewerReconnect {
  private flights = new Set<string>();
  private attempts = new Map<string, { key: string; count: number; next: number }>();
  private ticking = false;
  constructor(private readonly deps: ViewerReconnectDeps) {}

  async reconnect(employeeId: string, expected: { sessionId: string; sessionGeneration: number },
    owner: string | undefined, automatic = false): Promise<ViewerReconnectResult> {
    const d = this.deps, now = d.now ?? Date.now;
    const original = d.company.registeredEmployees().find(e => e.id === employeeId && e.owner === owner);
    if (!d.ready() || !original || original.sessionId !== expected.sessionId ||
      original.sessionGeneration !== expected.sessionGeneration || original.desiredRunning !== true ||
      original.onVacation || original.bindingMigration) return 'changed';
    const session = d.session(original.sessionId);
    if (!session?.workerViewerReconnect || session.owner !== owner || session.runtimeHealth !== 'disconnected')
      return 'unavailable';
    if (this.flights.has(employeeId)) return 'busy';
    const fingerprint = (e: typeof original) => JSON.stringify([e.id,e.owner,e.sessionId,e.sessionGeneration,
      e.desiredRunning,e.onVacation,e.bindingMigration,e.runtimeRecipe,e.permissions]);
    const runtime = JSON.stringify(expertRuntimeRecipe(session));
    const key = fingerprint(original), previous = this.attempts.get(employeeId);
    if (automatic && previous?.key === key && (previous.count >= BACKOFF.length || now() < previous.next))
      return 'unavailable';
    this.flights.add(employeeId);
    const count = previous?.key === key ? previous.count : 0;
    this.attempts.set(employeeId, { key, count: count + 1, next: now() + BACKOFF[Math.min(count, BACKOFF.length - 1)] });
    let release: (() => void) | undefined;
    let claim: ReturnType<CompanyService['prepareWake']>;
    try {
      const moveCurrent = await d.moveGuard(employeeId);
      const current = () => {
        const employee = d.company.registeredEmployees().find(e => e.id === employeeId);
        return d.ready() && moveCurrent() && !!employee && fingerprint(employee) === key &&
          d.session(original.sessionId) === session && JSON.stringify(expertRuntimeRecipe(session)) === runtime && (!claim || claim.current());
      };
      if (!current()) return 'changed';
      claim = d.company.prepareWake(employeeId, original.sessionId);
      if (!claim || !current()) return 'busy';
      release = d.pause(original.sessionId);
      if (!await session.reconnectWorkerViewer(current)) return current() ? 'unavailable' : 'changed';
      if (!current()) return 'changed';
      d.publish(session);
      this.attempts.delete(employeeId);
      return 'connected';
    } finally {
      // Releasing this pause never acknowledges/replays durable unknown deliveries.
      release?.(); claim?.finish(); this.flights.delete(employeeId);
    }
  }

  /** One seat per watcher tick; bounded backoff is shared with the manual path. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.ready()) return;
    this.ticking = true;
    try {
      for (const employee of this.deps.company.registeredEmployees()) {
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
  verifiedOwner: (req: FastifyRequest) => boolean) {
  app.post('/api/company/employees/:id/reconnect', async (req, reply) => {
    if (req.headers['x-reverie-parent-session'] !== undefined || !verifiedOwner(req))
      return reply.code(403).send({ success: false, error: 'Only the verified owner may reconnect this terminal' });
    const expected = parseBody(Reconnect, req.body);
    try {
      const state = await controller.reconnect((req.params as { id: string }).id, expected, ownerFor(req));
      if (state !== 'connected') return reply.code(409).send({ success: false,
        error: state === 'busy' ? 'A reconnect or session action is already in progress' :
          'The viewer connection was not confirmed. Check the current expert status; no replacement was started.' });
      return { success: true, data: { state: 'viewer-connected' } };
    } catch {
      return reply.code(503).send({ success: false, error: 'The viewer connection could not be confirmed. No replacement was started.' });
    }
  });
}
