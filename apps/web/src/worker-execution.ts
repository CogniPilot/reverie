import type { ProviderLaunchPublication } from './provider-launch-publication.js';
/** An unavailable worker broker must never turn into execution in the server. */
import {bindResourceWorkerCommand, type ResourceWorkerLaunch} from './resource-worker-launch.js';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const validViewerSocket = (socket: string) => socket.startsWith('/') && !/[\0\r\n]/.test(socket) && Buffer.byteLength(socket) < 108;
function viewerSocket(socket: string): string {
  if (!validViewerSocket(socket))
    throw new Error('The configured worker viewer socket must be an absolute Unix socket path');
  return socket;
}
const viewerExecutable = (socket: string) => `exec env REVERIE_WORKER_SOCKET=${quote(socket)} reverie-worker-exec`;
const VIEWER_ENDPOINT = Symbol('trusted-viewer-endpoint');

/** Missing original routing custody is a refusal before viewer dispatch. */
export class WorkerViewerEndpointCustodyError extends Error {
  constructor(readonly reason: 'viewer-endpoint-custody-unavailable' | 'viewer-endpoint-configuration-invalid' = 'viewer-endpoint-custody-unavailable') {
    super(reason === 'viewer-endpoint-configuration-invalid'
      ? 'The configured viewer endpoint is invalid. No viewer or provider was started.'
      : 'The original viewer endpoint is unavailable. No viewer or provider was started.');
    this.name = 'WorkerViewerEndpointCustodyError';
  }
}

/** Fixed policy refusal; no endpoint, provider state or caller-selected detail. */
export class WorkerViewerProviderLaunchError extends Error {
  constructor() {
    super('Attach-only worker sessions cannot launch or restart a provider. Use terminal viewer recovery.');
    this.name = 'WorkerViewerProviderLaunchError';
  }
}

/** Trusted service configuration selected for one product launch. This private
 * routing continuation proves neither socket liveness nor provider readiness.
 * It is intentionally absent from persisted sessions and public requests.
 */
export class WorkerViewerEndpoint {
  readonly #selection: Readonly<{state:'selected'; socket:string} | {state:'invalid-configuration'}>;
  readonly #sessionId: string;
  private constructor(token: symbol, socket: string, sessionId: string) {
    if (token !== VIEWER_ENDPOINT) throw new WorkerViewerEndpointCustodyError();
    this.#selection = Object.freeze(validViewerSocket(socket) ? {state:'selected',socket} : {state:'invalid-configuration'});
    this.#sessionId = sessionId;
    Object.freeze(this);
  }
  static capture(sessionId: string): WorkerViewerEndpoint | undefined {
    const broker = process.env.REVERIE_WORKER_SOCKET;
    if (!broker) return;
    return new WorkerViewerEndpoint(VIEWER_ENDPOINT, process.env.REVERIE_WORKER_VIEWER_SOCKET || broker, sessionId);
  }
  #socket(sessionId: string): string {
    if (sessionId !== this.#sessionId) throw new WorkerViewerEndpointCustodyError();
    if (this.#selection.state === 'invalid-configuration')
      throw new WorkerViewerEndpointCustodyError('viewer-endpoint-configuration-invalid');
    return this.#selection.socket;
  }
  assertAvailable(sessionId: string): void {
    this.#socket(sessionId);
  }
  command(command: string, cwd: string, sessionId: string): string {
    return `${viewerExecutable(this.#socket(sessionId))} --attach-only --session-id ${quote(sessionId)} --cwd ${quote(cwd)} --command ${quote(command)}`;
  }
}

export function workerLaunchCommand(command: string, cwd: string, sessionId: string, attachOnly = false,
  resourceLaunch?: ResourceWorkerLaunch, publication?: ProviderLaunchPublication): string {
  const tracked = publication?.nativeSelection();
  if (tracked && (attachOnly || resourceLaunch)) throw new Error('Ordinary launch intent cannot select protected/viewer execution');
  if (!process.env.REVERIE_WORKER_SOCKET) {
    if (resourceLaunch) throw new Error('Resource replacement requires the configured native worker broker');
    if (attachOnly && process.env.REVERIE_WORKER_VIEWER_SOCKET)
      throw new Error('Viewer reconnection requires the configured native worker broker');
    if (attachOnly) throw new WorkerViewerEndpointCustodyError();
    return command;
  }
  const reference = resourceLaunch && bindResourceWorkerCommand(resourceLaunch, command, cwd, sessionId, attachOnly);
  const viewer = attachOnly && process.env.REVERIE_WORKER_VIEWER_SOCKET;
  // Existing tmux servers retain their original environment. Select only this
  // attach-only child's endpoint explicitly; normal launches and control stay on the broker.
  const executable = tracked ? viewerExecutable(tracked.socket) : viewer ? viewerExecutable(viewerSocket(viewer)) : 'exec reverie-worker-exec';
  return `${executable}${tracked ? ` --attempt-id ${quote(tracked.attemptId)}` : ''}${attachOnly ? ' --attach-only' : ''}${reference ? ` --resource-ref ${quote(reference)}` : ''} --session-id ${quote(sessionId)} --cwd ${quote(cwd)} --command ${quote(command)}`;
}

export function workerPtyCommand(binary: string, args: string[], cwd: string, sessionId: string,
  publication?: ProviderLaunchPublication): { binary: string; args: string[]; env?: Record<string, string> } {
  const tracked = publication?.nativeSelection();
  if (!process.env.REVERIE_WORKER_SOCKET) return { binary, args };
  return { binary: 'reverie-worker-exec', args: [...(tracked ? ['--attempt-id', tracked.attemptId] : []),
    '--session-id', sessionId, '--cwd', cwd, '--command', [binary, ...args].map(quote).join(' ')],
    ...(tracked ? { env: { REVERIE_WORKER_SOCKET: tracked.socket } } : {}) };
}
