/** Server-private Docker replacement port. It is installed only by the qualified
 * boxed runtime; route DATA cannot select its implementation or create a journal.
 * The native actor owns real source closure, context/account custody and launch. */
import type { PlanMoveInput, PlanMoveRecord, PlanMoveSnapshot } from './plan-move.js';
import type { DockerPlanMoveJournalState, DockerPlanMoveSeed } from './docker-plan-move-data.js';

export interface PlanMoveDockerJournal {
  readonly moveId: string;
  readonly epoch: string;
  /** Live actor epoch + original request grant, not a cached cursor digest. */
  current(): void;
  read(): Readonly<DockerPlanMoveJournalState>;
  /** Exact original state CAS. No request may provide this private port. */
  publish(before: Readonly<DockerPlanMoveJournalState>, next: Readonly<DockerPlanMoveJournalState>): Promise<void>;
}
export interface PlanMoveDockerActor {
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
  /** Only read actual original effects. The result must carry a private native
   * origin, exact state/epoch and freshness; JSON/phase enums are not proof. */
  inspectForContinuation(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<unknown>;
  requireContinuation(proof: unknown, state: Readonly<DockerPlanMoveJournalState>): void;
  /** Join the genuine cooperative expert proof with the requester's authority. */
  withDecisionAuthority?(proof: unknown): PlanMoveDockerActor;
}
