/** Post-completion local-view retirement only. No DTO, phase, UID or old token
 * constructs this private proof; real source/target native brands are required. */
import { isDeepStrictEqual } from 'node:util';
import type { Session } from './session.js';
import type { SessionDocker, SessionState } from './types/session.js';
import type { PlanMoveRecord } from './plan-move.js';
import { PlanMoveError } from './plan-move.js';
import { DockerPlanMoveJournalState } from './docker-plan-move-data.js';
import { DockerPlanSourceProof } from './docker-plan-source.js';
import { DockerEmployeeProviderView } from './docker-employee-engine.js';
export interface DockerPlanSourceRetirementScope {
  readonly moveId: string;
  readonly employeeId: string;
  readonly owner: string | undefined;
  readonly oldSession: string;
  readonly newSession: string;
  readonly source: Readonly<{
    sessionGeneration: number;
    operationId: string;
    containerId: string;
    imageId: string;
    clientManifestDigest: string;
    planReplacement?: Readonly<{ provider: 'anthropic' | 'openai'; projectionDigest: string }>;
  }>;
  readonly target: Readonly<{ sessionGeneration: number; operationId: string; containerId: string; imageId: string }>;
}
/** Tuple comparison only. This does not grant retirement or runtime authority. */
export function dockerPlanSourceRetirementMatches(
  docker: SessionDocker | undefined,
  scope: Readonly<DockerPlanSourceRetirementScope>
): boolean {
  return (
    !!docker?.continuation &&
    docker.hostId === 'boxed-runtime' &&
    docker.engine === 'docker' &&
    docker.containerName === scope.source.containerId &&
    docker.image === scope.source.imageId &&
    docker.continuation.operationId === scope.source.operationId &&
    docker.continuation.employeeId === scope.employeeId &&
    docker.continuation.sessionGeneration === scope.source.sessionGeneration &&
    docker.continuation.clientManifestDigest === scope.source.clientManifestDigest &&
    isDeepStrictEqual(docker.continuation.planReplacement, scope.source.planReplacement)
  );
}
/** Persisted denial only: a retired source must never be restored as a viewer.
 * This marker never proves a worker stopped or authorizes another operation. */
export function dockerPlanSourceViewRetired(saved: Readonly<SessionState> | null | undefined): boolean {
  return (
    !!saved &&
    typeof saved.nativePlanRetiredBy === 'string' &&
    saved.nativePlanRetiredBy.length > 0 &&
    saved.status === 'stopped' &&
    saved.pid === null &&
    saved.providerDispatchHeld === true &&
    saved.terminalInputHeld === true &&
    saved.docker?.hostId === 'boxed-runtime' &&
    saved.docker.engine === 'docker' &&
    !!saved.docker.continuation
  );
}
const origin = Symbol('native closed source and current published target');
class NativeSourceRetirement {
  readonly #scope: DockerPlanSourceRetirementScope;
  readonly #old: Session | undefined;
  readonly #current: () => void;
  constructor(token: symbol, scope: DockerPlanSourceRetirementScope, old: Session | undefined, current: () => void) {
    if (token !== origin) throw new PlanMoveError('Native source retirement proof required', 409);
    this.#scope = Object.freeze({
      ...scope,
      source: Object.freeze({
        ...scope.source,
        ...(scope.source.planReplacement
          ? { planReplacement: Object.freeze({ ...scope.source.planReplacement }) }
          : {}),
      }),
      target: Object.freeze({ ...scope.target }),
    });
    this.#old = old;
    this.#current = current;
    Object.freeze(this);
  }
  subject(): DockerPlanSourceRetirementScope {
    return this.#scope;
  }
  require(old: Session | undefined): DockerPlanSourceRetirementScope {
    this.#current();
    if (old !== this.#old) throw new PlanMoveError('The original source Session changed', 409);
    return this.#scope;
  }
}
Object.freeze(NativeSourceRetirement.prototype);
/** The server may use this subject to find its current slot. Subject DATA alone
 * never authorizes a mutation; require(proof,currentSlot) must precede each one. */
export function dockerPlanSourceRetirementSubject(proof: unknown): DockerPlanSourceRetirementScope {
  if (!(proof instanceof NativeSourceRetirement))
    throw new PlanMoveError('Native source retirement proof required', 409);
  return NativeSourceRetirement.prototype.subject.call(proof);
}
export function requireDockerPlanSourceRetirement(
  proof: unknown,
  old: Session | undefined
): DockerPlanSourceRetirementScope {
  if (!(proof instanceof NativeSourceRetirement))
    throw new PlanMoveError('Native source retirement proof required', 409);
  return NativeSourceRetirement.prototype.require.call(proof, old);
}
export function captureDockerPlanSourceRetirement(
  record: Readonly<PlanMoveRecord>,
  input: Readonly<DockerPlanMoveJournalState>,
  source: DockerPlanSourceProof,
  view: DockerEmployeeProviderView,
  old: Session | undefined,
  target: Session,
  current: () => void
): unknown {
  if (!(source instanceof DockerPlanSourceProof) || !(view instanceof DockerEmployeeProviderView))
    throw new PlanMoveError('Actual native source and target proofs are required', 409);
  const state = DockerPlanMoveJournalState.parse(input),
    seed = state.seed,
    row = state.work,
    destination = row?.destination;
  if (
    record.phase !== 'completed' ||
    record.id !== seed.moveId ||
    record.employeeId !== seed.source.record.employeeId ||
    record.owner !== seed.source.record.owner ||
    record.oldSession !== seed.source.binding.sessionId ||
    record.newSession !== seed.target.sessionId ||
    !state.paidDispatch ||
    state.companyPublication?.phase !== 'published' ||
    state.handoff?.phase !== 'submitted' ||
    row?.phase !== 'ready' ||
    !destination
  )
    throw new PlanMoveError('The published original plan completion is required', 409);
  const descriptor = view.descriptor;
  if (
    target.id !== row.request.sessionId ||
    target.owner !== record.owner ||
    descriptor.employeeId !== record.employeeId ||
    descriptor.sessionId !== target.id ||
    descriptor.sessionGeneration !== row.request.sessionGeneration ||
    descriptor.operationId !== row.request.operationId ||
    descriptor.containerId !== destination.containerId ||
    descriptor.imageId !== destination.imageId ||
    descriptor.clientManifestDigest !== row.workerImage.clientManifestDigest ||
    !isDeepStrictEqual(descriptor.planReplacement, {
      provider: row.planReplacement.account.provider,
      projectionDigest: row.planReplacement.account.projectionDigest,
    }) ||
    (old && (old.id !== record.oldSession || old.owner !== record.owner))
  )
    throw new PlanMoveError('The source or target retirement tuple changed', 409);
  const check = () => {
    current();
    DockerPlanSourceProof.prototype.require.call(source, seed.source.record, seed.source.binding);
    if (
      DockerPlanSourceProof.prototype.observation.call(source, seed.source.record, seed.source.binding).kind !==
      'stopped'
    )
      throw new PlanMoveError('The original source is not physically stopped', 409);
    const docker = target.docker;
    if (!docker) throw new PlanMoveError('The published target view changed', 409);
    DockerEmployeeProviderView.prototype.require.call(view, target.id, docker);
    current();
  };
  check();
  const scope: DockerPlanSourceRetirementScope = {
    moveId: record.id,
    employeeId: record.employeeId,
    owner: record.owner,
    oldSession: record.oldSession,
    newSession: target.id,
    source: {
      sessionGeneration: seed.source.binding.sessionGeneration,
      operationId: seed.source.binding.operationId,
      containerId: seed.source.binding.containerId,
      imageId: seed.source.binding.imageId,
      clientManifestDigest: seed.source.record.workerImage.clientManifestDigest,
      ...(seed.source.record.version === 3
        ? {
            planReplacement: {
              provider: seed.source.record.planReplacement.account.provider,
              projectionDigest: seed.source.record.planReplacement.account.projectionDigest,
            },
          }
        : {}),
    },
    target: {
      sessionGeneration: row.request.sessionGeneration,
      operationId: row.request.operationId,
      containerId: destination.containerId,
      imageId: destination.imageId,
    },
  };
  return new NativeSourceRetirement(origin, scope, old, check);
}
