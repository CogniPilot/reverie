/** An unavailable worker broker must never turn into execution in the server. */
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function workerLaunchCommand(command: string, cwd: string, sessionId: string): string {
  if (!process.env.REVERIE_WORKER_SOCKET) return command;
  return `exec reverie-worker-exec --session-id ${quote(sessionId)} --cwd ${quote(cwd)} --command ${quote(command)}`;
}

export function workerPtyCommand(binary: string, args: string[], cwd: string, sessionId: string): { binary: string; args: string[] } {
  if (!process.env.REVERIE_WORKER_SOCKET) return { binary, args };
  return { binary: 'reverie-worker-exec', args: ['--session-id', sessionId, '--cwd', cwd, '--command', [binary, ...args].map(quote).join(' ')] };
}
