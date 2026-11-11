import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { workerLaunchCommand, workerPtyCommand } from '../src/worker-execution.js';

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

it('selects the private viewer only in the attach child, including quoted socket and command data', () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/original.sock');
  const viewer = "/run/viewer '$(printf unsafe)' `false`.sock";
  vi.stubEnv('REVERIE_WORKER_VIEWER_SOCKET', viewer);
  const command = "printf '%s' \"$PRIVATE\"\n$(printf not-run)", cwd = "/workspace/a'b";
  const wrapped = workerLaunchCommand(command, cwd, 'session', true);
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const printer = `${quote(process.execPath)} -e ${quote('console.log(JSON.stringify({socket:process.env.REVERIE_WORKER_SOCKET,args:process.argv.slice(1)}))')} --`;
  const output = execFileSync('bash', ['-c', wrapped.replace('reverie-worker-exec', printer)], { encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({ socket: viewer, args: ['--attach-only', '--session-id', 'session', '--cwd', cwd, '--command', command] });
  expect(process.env.REVERIE_WORKER_SOCKET).toBe('/run/original.sock');
  expect(workerLaunchCommand(command, cwd, 'session')).toMatch(/^exec reverie-worker-exec --session-id/);
  expect(workerLaunchCommand(command, cwd, 'session')).not.toContain('REVERIE_WORKER_SOCKET=');
  expect(workerPtyCommand('cli', ['--model', 'selected'], cwd, 'session')).toEqual({binary: 'reverie-worker-exec', args: ['--session-id', 'session', '--cwd', cwd, '--command', "'cli' '--model' 'selected'"]});
});

it.each(['', undefined])('preserves the existing attach command when viewer configuration is %s', viewer => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/original.sock');
  vi.stubEnv('REVERIE_WORKER_VIEWER_SOCKET', viewer);
  expect(workerLaunchCommand('cli', '/workspace', 'session', true)).toBe("exec reverie-worker-exec --attach-only --session-id 'session' --cwd '/workspace' --command 'cli'");
});

it.each(['relative.sock', '/run/a\nsock', '/' + 'a'.repeat(107), '/' + 'λ'.repeat(54)])('refuses an invalid configured viewer endpoint before launching: %s', viewer => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/original.sock');
  vi.stubEnv('REVERIE_WORKER_VIEWER_SOCKET', viewer);
  expect(() => workerLaunchCommand('cli', '/workspace', 'session', true)).toThrow('absolute Unix socket path');
  expect(workerLaunchCommand('cli', '/workspace', 'session')).toMatch(/^exec reverie-worker-exec --session-id/);
});

it('does not turn viewer-only configuration into local execution when the worker broker is absent', () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '');
  vi.stubEnv('REVERIE_WORKER_VIEWER_SOCKET', '/run/viewer.sock');
  expect(() => workerLaunchCommand('cli', '/workspace', 'session', true)).toThrow('configured native worker broker');
  expect(workerLaunchCommand('cli', '/workspace', 'session')).toBe('cli');
});
