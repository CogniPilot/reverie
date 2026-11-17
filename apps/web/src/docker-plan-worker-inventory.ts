/** Logical member DATA only. Every CID still needs the native controller's
 * independent current label, PID/birth and kernel-membership qualification. */
import type {
  DockerEmployeeContinuationRecord,
  DockerEmployeePlanReplacementWorkRecord,
} from './docker-employee-continuation-data.js';
import { dockerContinuationDigest as digest } from './docker-employee-continuation.js';
import { PlanMoveStore } from './plan-move-store.js';
function replaces(row: DockerEmployeeContinuationRecord, work: DockerEmployeePlanReplacementWorkRecord): boolean {
  const binding = work.planReplacement.source.binding,
    destination = row.destination;
  if (
    !destination ||
    row.employeeId !== work.employeeId ||
    row.owner !== work.owner ||
    row.request.sessionId !== binding.sessionId ||
    row.request.sessionGeneration !== binding.sessionGeneration ||
    row.request.operationId !== binding.operationId ||
    row.credentialId !== binding.credentialId ||
    destination.containerId !== binding.containerId ||
    destination.imageId !== binding.imageId ||
    digest(destination) !== binding.originalDigest ||
    digest(row.policy) !== binding.policyDigest
  )
    return false;
  const expected = work.planReplacement.source.continuationDigest;
  return (
    digest(row) === expected || (row.phase === 'ready' && digest({ ...row, phase: 'provider-issued' }) === expected)
  );
}
export async function dockerPlanWorkerContainerIds(
  canonical: () => readonly DockerEmployeeContinuationRecord[],
  moves: PlanMoveStore | undefined,
  current: () => void
): Promise<readonly string[]> {
  current();
  if (moves && !(moves instanceof PlanMoveStore)) throw Error('Actual private plan journal required');
  const staged = moves ? await PlanMoveStore.prototype.stagedDockerResourceInventory.call(moves) : [];
  current();
  const rows = canonical().filter((row) => !staged.some((work) => replaces(row, work)));
  const ids = [
    ...new Set([...rows, ...staged].flatMap((row) => (row.destination ? [row.destination.containerId] : []))),
  ];
  current();
  return Object.freeze(ids);
}
