/** An unavailable worker broker must never turn into execution in the server. */
import {bindResourceWorkerCommand, type ResourceWorkerLaunch} from './resource-worker-launch.js';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function workerLaunchCommand(command: string, cwd: string, sessionId: string, attachOnly = false,
  resourceLaunch?: ResourceWorkerLaunch): string {
  if (!process.env.REVERIE_WORKER_SOCKET) {
    if (resourceLaunch) throw new Error('Resource replacement requires the configured native worker broker');
    return command;
  }
  const reference = resourceLaunch && bindResourceWorkerCommand(resourceLaunch, command, cwd, sessionId, attachOnly);
  return `exec reverie-worker-exec${attachOnly ? ' --attach-only' : ''}${reference ? ` --resource-ref ${quote(reference)}` : ''} --session-id ${quote(sessionId)} --cwd ${quote(cwd)} --command ${quote(command)}`;
}

export function workerPtyCommand(binary: string, args: string[], cwd: string, sessionId: string): { binary: string; args: string[] } {
  if (!process.env.REVERIE_WORKER_SOCKET) return { binary, args };
  return { binary: 'reverie-worker-exec', args: ['--session-id', sessionId, '--cwd', cwd, '--command', [binary, ...args].map(quote).join(' ')] };
}
