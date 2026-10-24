import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { workerLaunchCommand } from '../src/worker-execution.js';

afterEach(() => vi.unstubAllEnvs());
describe('isolated worker execution', () => {
  it('keeps native deployments available', () => {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '');
    expect(workerLaunchCommand('claude --version', '/workspace', 'id')).toBe('claude --version');
  });
  it('passes the complete command as data, including shell characters and newlines', () => {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/reverie-workers/broker.sock');
    const command = "printf '%s' \"$PRIVATE\"\nprintf '`false`'";
    const wrapped = workerLaunchCommand(command, '/workspace', 'session');
    // Replace just the fixed executable with an argv printer; the shell must
    // neither execute nor expand any part of the worker command.
    const result = execFileSync('bash', ['-c', wrapped.replace('exec reverie-worker-exec', `exec ${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`)], { encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual(['--session-id', 'session', '--cwd', '/workspace', '--command', command]);
    expect(wrapped).not.toContain('||');
  });
});
it('makes website reconnection attach-only without persisting that policy in normal launches', () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/private.sock');
  expect(workerLaunchCommand('hands', '/workspace', 'id', true)).toContain('--attach-only');
  expect(workerLaunchCommand('hands', '/workspace', 'id')).not.toContain('--attach-only');
});
