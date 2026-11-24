/** Server-private Docker replacement port. It is installed only by the qualified
 * boxed runtime; route DATA cannot select its implementation or create a journal.
 * The native actor owns real source closure, context/account custody and launch. */
import type { PlanMoveInput, PlanMoveRecord, PlanMoveSnapshot } from './plan-move.js';
import type { DockerPlanMoveJournalState, DockerPlanMoveSeed } from './docker-plan-move-data.js';

export function canSettleRestoredPlanSource(
  state: Readonly<DockerPlanMoveJournalState>, init: NonNullable<PlanMoveRecord['restoredSource']>
): boolean {
  const stop = state.sourceStop;
  return stop?.phase === 'closed' && !!stop.sourceInit &&
    (init.pid !== stop.sourceInit.pid || init.startTicks !== stop.sourceInit.startTicks) &&
    !state.sourceReader && !state.material && !state.work && !state.paidDispatch &&
    !state.companyPublication && !state.handoff;
}

export interface PlanMoveDockerJournal {
  readonly moveId: string;
  readonly epoch: string;
  readonly publication: 'admitting' | 'published' | 'failed';
  /** Live actor epoch + original request grant, not a cached cursor digest. */
  current(): void;
  read(): Readonly<DockerPlanMoveJournalState>;
  /** Exact original state CAS. No request may provide this private port. */
  publish(before: Readonly<DockerPlanMoveJournalState>, next: Readonly<DockerPlanMoveJournalState>): Promise<void>;
}
export interface PlanMoveDockerJournalStore {
  /** Append only the new reservation under the actual whole-file lock. Active
   * native rows are read there, never overwritten by a stale caller snapshot. */
  reserve(record: Readonly<PlanMoveRecord>, current: () => void, disjoint?: unknown): Promise<Readonly<PlanMoveRecord>>;
  phase(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    status: { phase: PlanMoveRecord['phase']; error?: string },
    current: () => void
  ): Promise<Readonly<PlanMoveRecord>>;
  record(id: string): Promise<Readonly<PlanMoveRecord>>;
  closeRestored?(
    id: string, before: Readonly<DockerPlanMoveJournalState>,
    init: NonNullable<PlanMoveRecord['restoredSource']>, current: () => void
  ): Promise<Readonly<PlanMoveRecord>>;
  abandonAbsent?(
    id: string, before: Readonly<DockerPlanMoveJournalState>,
    abandonment: NonNullable<PlanMoveRecord['dockerAbandonment']>, current: () => void
  ): Promise<Readonly<PlanMoveRecord>>;
  /** The owner's explicit closure of a held move. Journal DATA only: the store
   * derives the recorded containers from the same cursor; no native effect. */
  abandonOwner?(
    id: string, before: Readonly<DockerPlanMoveJournalState>, at: number, current: () => void
  ): Promise<Readonly<PlanMoveRecord>>;
  current(id: string, epoch: string, seedDigest: string): void;
  /** Deny-only original file currency for a completed read. Never dispatch. */
  readCurrent(id: string, epoch: string, seedDigest: string): void;
  publish(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    next: Readonly<DockerPlanMoveJournalState>,
    current: () => void
  ): Promise<Readonly<PlanMoveRecord>>;
  claim(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    epoch: string,
    requireNative: () => void,
    current: () => void
  ): Promise<Readonly<PlanMoveRecord>>;
}
export interface PlanMoveDockerActor {
  /** Request-local admission only, before the runner's first current check.
   * Installed adapters capture the genuine private original requester here;
   * no native inspection, journal claim or effect is authorized by this call. */
  bindOriginalRequester?(record: Readonly<PlanMoveRecord>): Promise<void>;
  verifyRestoredSource?(record: Readonly<PlanMoveRecord>): Promise<{
    init: NonNullable<PlanMoveRecord['restoredSource']>;
    current: () => void;
  }>;
  /** Read-only native admission; opaque private proof, never JSON authority. */
  admitDisjointGeneration?(
    employeeId: string,
    owner: string | undefined,
    rows: readonly Readonly<PlanMoveRecord>[]
  ): Promise<unknown>;
  /** Genuine captured requester/runtime grant, including only this journal's exact planned self transition. */
  current(record: Readonly<PlanMoveRecord>, state: Readonly<DockerPlanMoveJournalState>): void;
  /** Cooperative native provider idle/composer gate; a disposable viewer is not proof. */
  idle(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal, signal: AbortSignal): Promise<void>;
  withRequesterAuthority?(proof: unknown): PlanMoveDockerActor;
  snapshot(employeeId: string, owner: string | undefined, purpose?: 'runtime-refresh'): Promise<PlanMoveSnapshot>;
  /** Reads only. The returned target identity is persisted BEFORE prepare. */
  reserve(
    input: Readonly<PlanMoveInput>,
    owner: string | undefined,
    requestDigest: string
  ): Promise<DockerPlanMoveSeed>;
  /** Target/account/image preflight only; never stop/create/start here. */
  prepare(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void>;
  stopSource(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void>;
  /** Same journal owns every helper, destination and one paid-dispatch intent. */
  start(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void>;
  verify(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<() => void>;
  finalize(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void>;
  /** After the checked completion ACK only. Retires an already exited source
   * viewer; never stops a native worker or revokes the shared issuer. */
  retireSource?(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void>;
  /** Only read actual original effects. The result must carry a private native
   * origin, exact state/epoch and freshness; JSON/phase enums are not proof. */
  inspectForContinuation(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<unknown>;
  requireContinuation(proof: unknown, state: Readonly<DockerPlanMoveJournalState>): void;
  /** Join the genuine cooperative expert proof with the requester's authority. */
  withDecisionAuthority?(proof: unknown): PlanMoveDockerActor;
}
