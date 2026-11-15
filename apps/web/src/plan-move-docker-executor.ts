/** Request-scoped adapters retain genuine grants per move. Preview grants can
 * never replace the authority of an operation already in flight. */
import type { PlanMoveRuntime } from './plan-move-runtime.js';
import type { PlanMoveDockerActor } from './plan-move-docker.js';
import { PlanMoveError, type PlanMoveRecord } from './plan-move.js';
import type { DockerPlanMoveRequesterTarget } from './docker-plan-move-requester.js';
export function dockerPlanMoveExecutor(runtime: PlanMoveRuntime, owner?: string): PlanMoveDockerActor | undefined {
  const base = runtime.dockerReplacement;
  if (!base || !runtime.dockerRequester || !base.withRequesterAuthority) return undefined;
  const actors = new Map<string, PlanMoveDockerActor>();
  const selected = (proof: unknown): PlanMoveDockerActor => {
    let actor = base.withRequesterAuthority!(proof);
    if (runtime.dockerDecision !== undefined) {
      if (!actor.withDecisionAuthority)
        throw new PlanMoveError('The cooperative Docker plan actor is unavailable', 503);
      actor = actor.withDecisionAuthority(runtime.dockerDecision);
    }
    return actor;
  };
  const capture = (target: DockerPlanMoveRequesterTarget) => selected(runtime.dockerRequester!(target));
  const actor = (record: Readonly<PlanMoveRecord>) => {
    const value = actors.get(record.id);
    if (!value) throw new PlanMoveError('The original Docker move requester is unavailable', 403);
    return value;
  };
  return Object.freeze({
    snapshot: async (employeeId, requestedOwner, purpose) => {
      if (requestedOwner !== owner) throw new PlanMoveError('Docker plan owner changed', 403);
      const employee = runtime.company.view(owner).employees.find((e) => e.id === employeeId);
      if (!employee) throw new PlanMoveError('Unknown current employee', 404);
      return capture({
        employeeId,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
      }).snapshot(employeeId, owner, purpose);
    },
    reserve: async (input, requestedOwner, requestDigest) => {
      if (requestedOwner !== owner || actors.has(input.id))
        throw new PlanMoveError('Docker plan request already captured or changed', 409);
      const value = capture({
        employeeId: input.employeeId,
        sessionId: input.sessionId,
        sessionGeneration: input.sessionGeneration,
        choice: { moveId: input.id, toAccount: input.toAccount, forceBusy: input.forceBusy },
      });
      actors.set(input.id, value);
      return value.reserve(input, owner, requestDigest);
    },
    current: (record, state) => actor(record).current(record, state),
    idle: (record, journal, signal) => actor(record).idle(record, journal, signal),
    prepare: (record, journal) => actor(record).prepare(record, journal),
    stopSource: (record, journal) => actor(record).stopSource(record, journal),
    start: (record, journal) => actor(record).start(record, journal),
    verify: (record, journal) => actor(record).verify(record, journal),
    finalize: (record, journal) => actor(record).finalize(record, journal),
    inspectForContinuation: async (record, journal) => {
      if (!actors.has(record.id)) {
        if (!runtime.dockerOriginalRequester)
          throw new PlanMoveError('Original Docker recovery authority is unavailable', 503);
        actors.set(record.id, selected(await runtime.dockerOriginalRequester(record.id)));
      }
      return actor(record).inspectForContinuation(record, journal);
    },
    requireContinuation: (proof, state) => base.requireContinuation(proof, state),
  } satisfies PlanMoveDockerActor);
}
