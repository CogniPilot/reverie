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
  constructor(origin: typeof issuer, session: Session, binding: DockerEmployeeBinding, current: () => void) {
    if (origin !== issuer) throw Error('Original Docker provider owner required');
    this.#session = session;
    this.#binding = Object.freeze(structuredClone(binding));
    this.#current = current;
  }
  requireFor(session: Session): void {
    this.#current();
    if (this.#session !== session) throw Error('Original Docker Session changed');
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
  current: () => void
): DockerEmployeeProviderLaunch {
  current();
  if (session.id !== binding.sessionId || session.docker?.containerName !== binding.containerId || session.pid !== null)
    throw Error('Original unopened Docker Session required');
  return new DockerEmployeeProviderLaunch(issuer, session, binding, current);
}
