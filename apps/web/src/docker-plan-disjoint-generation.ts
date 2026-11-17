/** Denial-only admission for a current native generation beside cold legacy
 * history. It never completes the historical move or grants native effects. */
import { dockerContinuationDigest as digest } from './docker-employee-continuation.js';
import type { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerPlanSourceProof } from './docker-plan-source.js';
import { requireDockerPlanMoveRequesterSource } from './docker-plan-move-requester.js';
import { PlanMoveError, type PlanMoveRecord } from './plan-move.js';

const origin = Symbol('current native generation beside cold legacy history');
const open = (rows: readonly Readonly<PlanMoveRecord>[], employeeId: string) =>
  rows.filter((row) => row.employeeId === employeeId && !['completed', 'failed'].includes(row.phase));
function refuse(): never {
  throw new PlanMoveError('The original move still holds this employee generation', 409);
}
function fingerprints(rows: readonly Readonly<PlanMoveRecord>[]): string {
  return digest([...rows].sort((a, b) => a.id.localeCompare(b.id)));
}
export class DockerPlanDisjointGeneration {
  readonly #rows: string;
  constructor(
    token: symbol,
    readonly employeeId: string,
    readonly owner: string | undefined,
    readonly sessionId: string,
    readonly sessionGeneration: number,
    readonly containerId: string,
    rows: readonly Readonly<PlanMoveRecord>[],
    private readonly current: () => void
  ) {
    if (token !== origin) refuse();
    const held = open(rows, employeeId);
    if (
      !held.length ||
      held.some(
        (row) =>
          row.owner !== owner ||
          row.phase !== 'recovery-required' ||
          row.dockerReplacement ||
          row.resourceIntent ||
          row.resourcePhase ||
          row.resourceOwnerScope ||
          row.purpose ||
          row.recoveryAction ||
          !row.sourceStopRequested ||
          !row.sourceCleanupVerified ||
          !row.newSession ||
          row.oldSession === sessionId ||
          row.newSession === sessionId
      )
    )
      refuse();
    this.#rows = fingerprints(held);
    current();
    Object.freeze(this);
  }
  /** Correlation DATA only: this check never validates native/current authority. */
  requireHistoryData(rows: readonly Readonly<PlanMoveRecord>[], employeeId: string, owner: string | undefined): void {
    if (employeeId !== this.employeeId || owner !== this.owner || fingerprints(open(rows, employeeId)) !== this.#rows)
      refuse();
  }
  require(rows: readonly Readonly<PlanMoveRecord>[], employeeId: string, owner: string | undefined): void {
    this.current();
    DockerPlanDisjointGeneration.prototype.requireHistoryData.call(this, rows, employeeId, owner);
    this.current();
  }
  requireReservation(record: Readonly<PlanMoveRecord>, rows: readonly Readonly<PlanMoveRecord>[]): void {
    DockerPlanDisjointGeneration.prototype.require.call(this, rows, record.employeeId, record.owner);
    const source = record.dockerReplacement?.seed.source.binding;
    if (
      record.oldSession !== this.sessionId ||
      !source ||
      source.sessionId !== this.sessionId ||
      source.sessionGeneration !== this.sessionGeneration ||
      source.containerId !== this.containerId
    )
      refuse();
  }
}
/** Only actual requester and SourceReader class instances can mint admission. */
export function captureDockerPlanDisjointGeneration(
  requester: unknown,
  native: DockerPlanSourceProof,
  row: DockerEmployeeContinuationRecord,
  binding: DockerEmployeeBinding,
  rows: readonly Readonly<PlanMoveRecord>[],
  current: () => void
): DockerPlanDisjointGeneration {
  if (!(native instanceof DockerPlanSourceProof)) refuse();
  const requireCurrent = () => {
    current();
    const scope = requireDockerPlanMoveRequesterSource(requester, row.employeeId, row.owner);
    if (
      scope.sessionId !== binding.sessionId ||
      scope.sessionGeneration !== binding.sessionGeneration ||
      scope.containerId !== binding.containerId
    )
      refuse();
    DockerPlanSourceProof.prototype.require.call(native, row, binding);
    current();
  };
  return new DockerPlanDisjointGeneration(
    origin,
    row.employeeId,
    row.owner,
    binding.sessionId,
    binding.sessionGeneration,
    binding.containerId,
    rows,
    requireCurrent
  );
}
export function requireDockerPlanDisjointGeneration(
  proof: unknown,
  rows: readonly Readonly<PlanMoveRecord>[],
  employeeId: string,
  owner: string | undefined
): DockerPlanDisjointGeneration {
  if (!(proof instanceof DockerPlanDisjointGeneration)) refuse();
  DockerPlanDisjointGeneration.prototype.require.call(proof, rows, employeeId, owner);
  return proof;
}
/** Denial-only caller-map correlation. Only requireReservation admits a journal. */
export function requireDockerPlanDisjointHistoryData(
  proof: unknown,
  rows: readonly Readonly<PlanMoveRecord>[],
  employeeId: string,
  owner: string | undefined
): void {
  if (!(proof instanceof DockerPlanDisjointGeneration)) refuse();
  DockerPlanDisjointGeneration.prototype.requireHistoryData.call(proof, rows, employeeId, owner);
}
/** One complete native/history/owner/source-tuple check at a writer boundary. */
export function requireDockerPlanDisjointReservation(
  proof: unknown,
  record: Readonly<PlanMoveRecord>,
  rows: readonly Readonly<PlanMoveRecord>[]
): void {
  if (!(proof instanceof DockerPlanDisjointGeneration)) refuse();
  DockerPlanDisjointGeneration.prototype.requireReservation.call(proof, record, rows);
}
Object.freeze(DockerPlanDisjointGeneration.prototype);
Object.freeze(DockerPlanDisjointGeneration);
