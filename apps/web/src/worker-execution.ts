/** An unavailable worker broker must never turn into execution in the server. */
import {bindResourceWorkerCommand, type ResourceWorkerLaunch} from './resource-worker-launch.js';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function workerLaunchCommand(command: string, cwd: string, sessionId: string, attachOnly = false,
  resourceLaunch?: ResourceWorkerLaunch): string {
  if (!process.env.REVERIE_WORKER_SOCKET) {
    if (resourceLaunch) throw new Error('Resource replacement requires the configured native worker broker');
    if (attachOnly && process.env.REVERIE_WORKER_VIEWER_SOCKET)
      throw new Error('Viewer reconnection requires the configured native worker broker');
    return command;
  }
  const reference = resourceLaunch && bindResourceWorkerCommand(resourceLaunch, command, cwd, sessionId, attachOnly);
  const viewer = attachOnly && process.env.REVERIE_WORKER_VIEWER_SOCKET;
  if (viewer && (!viewer.startsWith('/') || viewer.includes('\0') || viewer.includes('\r') || viewer.includes('\n') || Buffer.byteLength(viewer) >= 108))
    throw new Error('The configured worker viewer socket must be an absolute Unix socket path');
  // Existing tmux servers retain their original environment. Select only this
  // attach-only child's endpoint explicitly; normal launches and control stay on the broker.
  const executable = viewer ? `exec env REVERIE_WORKER_SOCKET=${quote(viewer)} reverie-worker-exec` : 'exec reverie-worker-exec';
  return `${executable}${attachOnly ? ' --attach-only' : ''}${reference ? ` --resource-ref ${quote(reference)}` : ''} --session-id ${quote(sessionId)} --cwd ${quote(cwd)} --command ${quote(command)}`;
}

export function workerPtyCommand(binary: string, args: string[], cwd: string, sessionId: string): { binary: string; args: string[] } {
  if (!process.env.REVERIE_WORKER_SOCKET) return { binary, args };
  return { binary: 'reverie-worker-exec', args: ['--session-id', sessionId, '--cwd', cwd, '--command', [binary, ...args].map(quote).join(' ')] };
}
