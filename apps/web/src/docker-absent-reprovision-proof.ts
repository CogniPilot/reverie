/** Private proof that the canonical CompanyStore currently holds one absent
 * laptop retirement. It lets the owning state service remove that session's
 * stale boxed view reference and nothing else. No DTO constructs it. */
import { CompanyService } from './company-service.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { SessionDocker } from './types/session.js';
export interface DockerAbsentSessionScope {
  readonly operationId: string;
  readonly employeeId: string;
  readonly owner: string | undefined;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  /** Container IDs the Engine positively reported absent. */
  readonly absent: readonly string[];
}
/** Tuple comparison only: a boxed view of one positively absent container. */
export function dockerAbsentSessionReference(
  docker: SessionDocker | undefined,
  scope: Readonly<DockerAbsentSessionScope>
): boolean {
  return (
    !!docker?.continuation &&
    docker.hostId === 'boxed-runtime' &&
    docker.engine === 'docker' &&
    docker.owned === false &&
    docker.continuation.employeeId === scope.employeeId &&
    scope.absent.includes(docker.containerName)
  );
}
const origin = Symbol('canonical absent laptop retirement');
class AbsentSessionRetirement {
  readonly #scope: DockerAbsentSessionScope;
  readonly #current: () => void;
  constructor(token: symbol, scope: DockerAbsentSessionScope, current: () => void) {
    if (token !== origin) throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_PROOF_REQUIRED');
    this.#scope = Object.freeze({ ...scope, absent: Object.freeze([...scope.absent]) });
    this.#current = current;
    Object.freeze(this);
  }
  require(): DockerAbsentSessionScope {
    this.#current();
    return this.#scope;
  }
}
Object.freeze(AbsentSessionRetirement.prototype);
export function requireDockerAbsentSessionRetirement(proof: unknown): DockerAbsentSessionScope {
  if (!(proof instanceof AbsentSessionRetirement))
    throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_PROOF_REQUIRED');
  return AbsentSessionRetirement.prototype.require.call(proof);
}
/** Every use re-reads the canonical store: the entry must still await its
 * session step, and the employee must hold no binding or continuation row. */
export function captureDockerAbsentSessionRetirement(
  company: CompanyService,
  operationId: string,
  current: () => void
): unknown {
  if (!(company instanceof CompanyService)) throw Error('Actual company service required');
  const read = (): DockerAbsentSessionScope => {
    current();
    const state = company.store.snapshot(),
      entry = state.retiredDockerEmployeeContinuations?.find((row) => row.operationId === operationId),
      employees = state.employees.filter((row) => row.id === entry?.employeeId),
      employee = employees[0];
    if (
      company.store.publicationUnconfirmed ||
      !entry ||
      entry.session.phase !== 'pending' ||
      entry.source.phase !== 'pending' ||
      employees.length !== 1 ||
      !employee ||
      employee.owner !== entry.owner ||
      employee.sessionId !== entry.sessionId ||
      employee.sessionGeneration !== entry.sessionGeneration ||
      employee.dockerBinding ||
      employee.bindingMigration ||
      state.dockerEmployeeContinuations?.some((row) => row.employeeId === entry.employeeId)
    )
      throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_RETIREMENT_CHANGED');
    return {
      operationId,
      employeeId: entry.employeeId,
      owner: entry.owner,
      sessionId: entry.sessionId,
      sessionGeneration: entry.sessionGeneration,
      absent: entry.absent.containerIds,
    };
  };
  const scope = read();
  return new AbsentSessionRetirement(origin, scope, () => {
    if (JSON.stringify(read()) !== JSON.stringify(scope))
      throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_RETIREMENT_CHANGED');
  });
}
