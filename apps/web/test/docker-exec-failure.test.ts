/** Classification of a failed `docker exec`, from the error Node reports for a
 * failed child. Every stderr below is synthetic; none is kept by the result. */
import { describe, expect, it } from 'vitest';
import {
  classifyDockerExecFailure,
  describeDockerExecFailure,
  dockerExecFailureCode,
  dockerExecFailureRetryable,
} from '../src/docker-exec-failure.js';
import { dockerRecoveryGuidance } from '../src/docker-recovery-guidance.js';
import { DockerEmployeeContinuationError } from '../src/docker-employee-continuation.js';
import { dockerPlanMoveFailureMessage } from '../src/plan-move-docker-runner.js';

const command =
  '/bin/docker --host unix:///run/reverie-engine/docker.sock exec ' +
  'a'.repeat(64) +
  ' /bin/reverie-docker-resources storage-status --holder-start 123456';
/** What `execFile` rejects with: the command line, then whatever the client printed. */
const failed = (stderr: string, fields: Record<string, unknown> = { code: 1, killed: false, signal: null }) =>
  Object.assign(Error('Command failed: ' + command + '\n' + stderr), { cmd: command, ...fields });

describe('why a docker exec failed', () => {
  it.each([
    ['', { code: 137, killed: false, signal: null }, 'killed'],
    ['', { code: null, killed: true, signal: 'SIGTERM' }, 'timed-out'],
    ['', { code: 'ENOENT' }, 'engine-unreachable'],
    ['Cannot connect to the Docker daemon at unix:///run/reverie-engine/docker.sock.\n', { code: 1 }, 'engine-unreachable'],
    ['Error response from daemon: No such container: ' + 'a'.repeat(64) + '\n', { code: 1 }, 'absent'],
    ['Error response from daemon: container ' + 'a'.repeat(64) + ' is not running\n', { code: 1 }, 'not-running'],
    [
      'OCI runtime exec failed: exec failed: unable to start container process: ' +
        'error executing setns process: cannot allocate memory: unknown\n',
      { code: 126 },
      'out-of-memory',
    ],
    [
      'OCI runtime exec failed: exec failed: unable to start container process: ' +
        'read init-p: connection reset by peer: resource temporarily unavailable: unknown\n',
      { code: 126 },
      'task-limit',
    ],
    ['OCI runtime exec failed: exec failed: something else: unknown\n', { code: 126 }, 'exec-refused'],
    ['BOXED_STORAGE_HOLDER_CHANGED; effectIssued=false\n', { code: 1 }, 'helper-refused'],
    ['something nobody expected\n', { code: 2 }, 'failed'],
    ['', { code: 1 }, 'failed'],
  ])('reads %j with %j as %s', (stderr, fields, kind) => {
    const failure = classifyDockerExecFailure(failed(stderr, { killed: false, signal: null, ...fields }));
    expect(failure.kind).toBe(kind);
    expect(failure.stderrBytes).toBe(Buffer.byteLength(stderr));
    // Nothing printed, and no part of the command line, survives.
    const kept = JSON.stringify(failure) + describeDockerExecFailure(failure);
    for (const secret of ['docker.sock', 'a'.repeat(64), 'storage-status', 'setns', 'nobody expected'])
      expect(kept).not.toContain(secret);
  });
  it('keeps the exit status and a helper refusal code, and nothing for an unrelated value', () => {
    expect(classifyDockerExecFailure(failed('', { code: 137, killed: false, signal: null }))).toEqual({
      kind: 'killed',
      exitCode: 137,
      stderrBytes: 0,
    });
    expect(classifyDockerExecFailure(failed('BOXED_RESOURCE_IO: No such process (os error 3)\n'))).toMatchObject({
      kind: 'helper-refused',
      helper: 'BOXED_RESOURCE_IO',
      exitCode: 1,
    });
    expect(describeDockerExecFailure(classifyDockerExecFailure(failed('', { code: 137 })))).toBe(
      'kind=killed exit=137 stderrBytes=0'
    );
    for (const value of [undefined, null, 'text', 17, {}, Error('plain')])
      expect(classifyDockerExecFailure(value)).toEqual({ kind: 'failed', stderrBytes: 0 });
  });
  it('repeats only what a second read can change', () => {
    const kind = (value: string) => ({ kind: value, stderrBytes: 0 }) as never;
    for (const retried of ['killed', 'out-of-memory', 'task-limit', 'exec-refused', 'failed'])
      expect(dockerExecFailureRetryable(kind(retried))).toBe(true);
    for (const final of ['timed-out', 'engine-unreachable', 'not-running', 'absent', 'helper-refused'])
      expect(dockerExecFailureRetryable(kind(final))).toBe(false);
  });
  it('gives every holder read failure a sentence, and a plan move its exit status', () => {
    for (const kind of [
      'timed-out',
      'killed',
      'out-of-memory',
      'task-limit',
      'exec-refused',
      'not-running',
      'absent',
      'engine-unreachable',
      'helper-refused',
      'failed',
    ] as const) {
      const code = dockerExecFailureCode('DOCKER_STORAGE_HOLDER_STATUS', { kind, stderrBytes: 0 });
      expect(code).toMatch(/^DOCKER_STORAGE_HOLDER_STATUS_[A-Z_]+$/);
      const guidance = dockerRecoveryGuidance(code)!;
      expect(guidance.allowedActions).toEqual(['retry']);
      expect(guidance.message).toContain('The read changes nothing');
    }
    expect(dockerRecoveryGuidance('DOCKER_STORAGE_HOLDER_STATUS_')).toBeUndefined();
    expect(dockerRecoveryGuidance('DOCKER_STORAGE_HOLDER_STATUS_toString')).toBeUndefined();
    const held = new DockerEmployeeContinuationError('DOCKER_STORAGE_HOLDER_STATUS_KILLED', 409, {
      cause: { kind: 'killed', exitCode: 137, stderrBytes: 0 },
    });
    const message = dockerPlanMoveFailureMessage(held);
    expect(message).toContain('16 MiB memory limit');
    expect(message).toContain('continue the move to try again');
    expect(message).toContain('(DOCKER_STORAGE_HOLDER_STATUS_KILLED, exit 137)');
    expect(message).not.toContain('Command failed');
    // What the owner used to read instead.
    expect(dockerPlanMoveFailureMessage(failed(''))).toBe('Command failed: ' + command + '\n');
  });
});
