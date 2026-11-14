import type { DockerCodexWorkspace } from './docker-employee-codex-workspace.js';
/** Private one-attempt builder authority over one actual Session. Persisted
 * Docker metadata can attach a viewer, never initiate a first provider.
 */
import type { Session } from './session.js';
import type { SessionDocker } from './types.js';
import type { DockerEmployeeBinding } from './docker-employee-continuation-data.js';
const issuer = Symbol('Docker employee provider launch');
export class DockerEmployeeProviderLaunch {
  readonly #session: Session;
  readonly #binding: DockerEmployeeBinding;
  readonly #current: () => void;
  #claimed = false;
  #workspace: { kind: 'unobserved' } | { kind: 'held' } | { kind: 'observed'; value: Readonly<DockerCodexWorkspace> } =
    { kind: 'unobserved' };
  readonly #workspaceReader?: (workingDir: string) => Promise<DockerCodexWorkspace>;
  constructor(
    origin: typeof issuer,
    session: Session,
    binding: DockerEmployeeBinding,
    current: () => void,
    workspaceReader?: (workingDir: string) => Promise<DockerCodexWorkspace>
  ) {
    if (origin !== issuer) throw Error('Original Docker provider owner required');
    this.#session = session;
    this.#binding = Object.freeze(structuredClone(binding));
    this.#current = current;
    this.#workspaceReader = workspaceReader;
    Object.freeze(this);
  }
  requireFor(session: Session): void {
    this.#current();
    if (this.#session !== session) throw Error('Original Docker Session changed');
  }
  async prepareCodexWorkspace(session: Session): Promise<Readonly<DockerCodexWorkspace>> {
    this.requireFor(session);
    if (this.#claimed || this.#workspace.kind !== 'unobserved' || !this.#workspaceReader)
      throw Error('Original unopened Docker workspace required');
    const workingDir = session.workingDir;
    this.#workspace = { kind: 'held' };
    const workspace = await this.#workspaceReader(workingDir);
    this.requireFor(session);
    if (session.workingDir !== workingDir) throw Error('Original Docker workspace changed');
    this.#workspace = { kind: 'observed', value: Object.freeze({ ...workspace }) };
    return this.#workspace.value;
  }
  workspaceForCommand(sessionId: string, docker: SessionDocker): Readonly<DockerCodexWorkspace> | undefined {
    this.requireFor(this.#session);
    if (this.#claimed) throw Error('Original Docker provider launch already held');
    if (this.#session.id !== sessionId || docker !== this.#session.docker)
      throw Error('Original unopened Docker workspace required');
    if (this.#workspace.kind === 'held') throw Error('Original Docker workspace observation held');
    return this.#workspace.kind === 'observed' ? this.#workspace.value : undefined;
  }
  claim(sessionId: string, docker: SessionDocker): void {
    this.requireFor(this.#session);
    if (
      this.#claimed ||
      this.#session.id !== sessionId ||
      this.#binding.sessionId !== sessionId ||
      docker.containerName !== this.#binding.containerId ||
      docker.image !== this.#binding.imageId ||
      docker.continuation?.operationId !== this.#binding.operationId
    )
      throw Error('Original Docker provider launch already held');
    this.#claimed = true;
  }
}
export function captureDockerEmployeeProviderLaunch(
  session: Session,
  binding: DockerEmployeeBinding,
  current: () => void,
  workspaceReader?: (workingDir: string) => Promise<DockerCodexWorkspace>
): DockerEmployeeProviderLaunch {
  current();
  if (session.id !== binding.sessionId || session.docker?.containerName !== binding.containerId || session.pid !== null)
    throw Error('Original unopened Docker Session required');
  return new DockerEmployeeProviderLaunch(issuer, session, binding, current, workspaceReader);
}

Object.freeze(DockerEmployeeProviderLaunch.prototype);
