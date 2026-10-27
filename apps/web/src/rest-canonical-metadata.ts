/** Scalar-only observations of existing stores. No REST/recovery authority or effect adapters. */
import type { CompanyService } from './company-service.js';
import type { GoalState } from './company-types.js';
import type { CompanyStore } from './company-store.js';
import type { SessionManager } from './session-manager.js';
import type { RecoveryAuthoritySources, RecoveryMetadata } from './recovery-authority.js';

export interface RestEmployeeMetadata {
  readonly employeeId: string;
  readonly ownerId: string | null;
  readonly sessionId: string;
  readonly desiredRunning: boolean | null;
  readonly vacation: boolean;
  readonly sleepEnabled: boolean;
  readonly dreamEnabled: boolean;
}
export interface RestSessionMetadata {
  readonly sessionId: string;
  readonly ownerId: string | null;
}
/** UNKNOWN is represented by null, never by a successful default or a derived generation. */
export type RestRecoveryObservation = Readonly<{
  [K in keyof RecoveryMetadata]: (K extends 'goalState' ? GoalState : RecoveryMetadata[K]) | null;
}>;
export interface RestMetadataReport {
  readonly stage: 'REPORT_ONLY';
  readonly adapterStatus: 'UNAVAILABLE';
  readonly authorization: 'UNPROVEN';
  readonly automaticAction: 'NONE';
  readonly code: 'REST_CANONICAL_INCOMPLETE' | 'REST_CANONICAL_UNAVAILABLE';
  readonly metadata: RestRecoveryObservation | null;
  readonly eligibility: Readonly<{ sleepEnabled: boolean; dreamEnabled: boolean }> | null;
}
export const restMetadataId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}(?![\s\S])/.test(value);
export const restMetadataSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/.test(value);

/** Scalar projection over the actual registry, shared by SessionManager and WebServer. */
export function restSessionMetadataFromRegistry(
  registry: ReadonlyMap<string, { readonly id: string; readonly owner?: string }>,
  id: string
): RestSessionMetadata | undefined {
  if (!restMetadataSessionId(id)) return;
  const session = registry.get(id);
  if (!session || session.id !== id || (session.owner !== undefined && !restMetadataId(session.owner))) return;
  const result = Object.freeze({ sessionId: session.id, ownerId: session.owner ?? null });
  if (registry.get(id) !== session || session.id !== id || (session.owner ?? null) !== result.ownerId) return;
  return result;
}

interface RestMetadataSources {
  /** Same CompanyService.store used by ordinary writes, not an alternate state/status store. */
  readonly company: Pick<CompanyService, 'store'>;
  readonly sessions: Pick<SessionManager, 'restSessionMetadata'>;
  /** Existing custody assertion contract; missing or asynchronous proof refuses before reading. */
  readonly custody: { assertPrivateCustody(file: string): void };
}
const unavailable = (): RestMetadataReport =>
  Object.freeze({
    stage: 'REPORT_ONLY',
    adapterStatus: 'UNAVAILABLE',
    authorization: 'UNPROVEN',
    automaticAction: 'NONE',
    code: 'REST_CANONICAL_UNAVAILABLE',
    metadata: null,
    eligibility: null,
  });

/** Trusted in-process report consumer in the canonical assembly; no API, scheduler or effect authority. */
export class CanonicalRestMetadataReader {
  private readonly sources?: Readonly<RestMetadataSources>;
  constructor(sources?: RestMetadataSources) {
    if (sources) this.sources = Object.freeze({ ...sources });
  }
  private custody(store: CompanyStore): void {
    const result: unknown = this.sources!.custody.assertPrivateCustody(store.file);
    if (result !== undefined) {
      if (result && typeof (result as PromiseLike<unknown>).then === 'function')
        void Promise.resolve(result).catch(() => undefined);
      throw new Error('REST custody unavailable');
    }
  }
  observe(ownerId: string | undefined, employeeId: string): RestMetadataReport {
    try {
      if (!this.sources || !restMetadataId(employeeId) || (ownerId !== undefined && !restMetadataId(ownerId)))
        return unavailable();
      const { company, sessions } = this.sources;
      const store = company.store;
      this.custody(store);
      const employee = store.restEmployeeMetadata(ownerId, employeeId);
      if (!employee) return unavailable();
      const session = sessions.restSessionMetadata(employee.sessionId);
      if (!session || session.ownerId !== employee.ownerId) return unavailable();
      // No await, snapshot, filesystem read or runtime probe. Recheck scalar sources and custody;
      // this does NOT prove cross-process freshness or an atomic multi-store read transaction.
      this.custody(store);
      if (company.store !== store) return unavailable();
      const fresh = store.restEmployeeMetadata(ownerId, employeeId);
      const currentSession = sessions.restSessionMetadata(employee.sessionId);
      if (
        !fresh ||
        !currentSession ||
        currentSession.ownerId !== session.ownerId ||
        currentSession.sessionId !== session.sessionId ||
        fresh.employeeId !== employee.employeeId ||
        fresh.ownerId !== employee.ownerId ||
        fresh.sessionId !== employee.sessionId ||
        fresh.desiredRunning !== employee.desiredRunning ||
        fresh.vacation !== employee.vacation ||
        fresh.sleepEnabled !== employee.sleepEnabled ||
        fresh.dreamEnabled !== employee.dreamEnabled
      )
        return unavailable();
      const goal = store.restGoalMetadata(ownerId, employeeId, fresh.sessionId);
      this.custody(store);
      if (company.store !== store) return unavailable();
      const finalGoal = store.restGoalMetadata(ownerId, employeeId, fresh.sessionId);
      const finalEmployee = store.restEmployeeMetadata(ownerId, employeeId);
      const finalSession = sessions.restSessionMetadata(fresh.sessionId);
      if (
        JSON.stringify(finalGoal) !== JSON.stringify(goal) ||
        JSON.stringify(finalEmployee) !== JSON.stringify(fresh) ||
        JSON.stringify(finalSession) !== JSON.stringify(currentSession)
      )
        return unavailable();
      // Goal fields come from the same accepted writer. Session generation, revision and
      // complete activity are still unproven; a Goal record cannot attest runtime activity.
      // Eligibility flags never imply sleeping=false, a schedule, or a memory/promotion grant.
      const metadata: RestRecoveryObservation = Object.freeze({
        employeeId: fresh.employeeId,
        goalId: goal?.goalId ?? null,
        goalGeneration: goal?.goalGeneration ?? null,
        sessionId: fresh.sessionId,
        sessionGeneration: null,
        transitionSequence: goal?.transitionSequence ?? null,
        ownerId: fresh.ownerId,
        revision: null,
        goalState: goal?.goalState ?? null,
        desiredRunning: fresh.desiredRunning,
        vacation: fresh.vacation,
        sleeping: null,
        pendingInput: null,
        dialog: null,
        activeJobs: null,
        activeTurn: null,
        toolWait: null,
      });
      return Object.freeze({
        stage: 'REPORT_ONLY',
        adapterStatus: 'UNAVAILABLE',
        authorization: 'UNPROVEN',
        automaticAction: 'NONE',
        code: 'REST_CANONICAL_INCOMPLETE',
        metadata,
        eligibility: Object.freeze({ sleepEnabled: fresh.sleepEnabled, dreamEnabled: fresh.dreamEnabled }),
      });
    } catch {
      return unavailable();
    }
  }
  /** Exact accepted recovery-r2 read seam. Incomplete observations cannot become a permit.
   * Deliberately no asserted cast, generation allocator, default revision or fabricated ACTIVE state.
   */
  readonly recoveryRead: RecoveryAuthoritySources['read'] = (_ownerId, _employeeId) => null;
}
