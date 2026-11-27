/** A failed resource writer is classified from the one line it printed,
 * through a closed allow-list. Only a class name leaves the port; the line
 * itself, and anything not on the list, never does. */
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
const { physical } = vi.hoisted(() => ({ physical: { program: '', argv: [] as string[][] } }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
    ) => {
      expect(file).toBe('/bin/docker');
      physical.argv.push([...args]);
      return actual.execFile(process.execPath, ['-e', physical.program], options, callback);
    },
  };
});
import { PackagedDockerEngineCommand } from '../src/docker-engine-command.js';
import { classifyDockerResourceHelperFailure } from '../src/docker-resource-helper-failure.js';
import { DockerTaskFailure } from '../src/docker-continuation-task.js';

const member = 'd'.repeat(64),
  box = 'b'.repeat(64),
  parent = `/sys/fs/cgroup/reverie.slice/reverie-box.slice/reverie-box-${box}.slice`;
const enoent = 'No such file or directory (os error 2)',
  esrch = 'No such process (os error 3)';
/** The line the live system printed twice, from a helper that names no path. */
const observed = `BOXED_RESOURCE_IO: ${enoent}; effectIssued=true\n`;
const located = (text: string, path: string, subject?: string, tail = '; effectIssued=false') =>
  `BOXED_RESOURCE_IO: ${text} at ${path}${subject ? ` (${subject})` : ''}${tail}\n`;

describe('a process or thread that ended while it was read', () => {
  it.each([
    observed,
    observed.replace('true', 'false'),
    `BOXED_RESOURCE_IO: ${esrch}; effectIssued=false\n`,
    located(enoent, '/proc/868200', `member ${member} task 868200`),
    located(enoent, '/proc/868200/stat', `member ${member} task 868200`, '; effectIssued=true'),
    located(esrch, '/proc/868200/cgroup', `worker ${member} task 868200`),
    located(enoent, `${parent}/docker-${member}.scope/cgroup.threads`, 'box'),
    located(enoent, '/proc/868200/stat', `member ${member} task 868200`, '; confirmed=memory.high; effectIssued=true'),
    located(
      enoent,
      '/proc/868200/stat',
      `member ${member} task 868200`,
      '; confirmed=memory.high,cpu.weight; effectIssued=true'
    ),
    'BOXED_RESOURCE_PID_EXITED; effectIssued=false\n',
    'BOXED_RESOURCE_PID_EXITED; confirmed=memory.high; effectIssued=true\n',
  ])('is a lost read: %s', (line) => {
    expect(classifyDockerResourceHelperFailure(line)).toBe('lost-process');
  });
  it('is a deadline when the helper ran out of time', () => {
    expect(classifyDockerResourceHelperFailure('BOXED_RESOURCE_DEADLINE; effectIssued=false\n')).toBe('deadline');
    expect(
      classifyDockerResourceHelperFailure('BOXED_RESOURCE_DEADLINE; confirmed=memory.high; effectIssued=true\n')
    ).toBe('deadline');
  });
});

describe('anything else', () => {
  it.each([
    'BOXED_RESOURCE_HARD_POLICY_MISMATCH; effectIssued=false\n',
    'BOXED_RESOURCE_PID_CHANGED; effectIssued=false\n',
    'BOXED_RESOURCE_PID_REPLACED; effectIssued=true\n',
    'BOXED_RESOURCE_LEAF_CHANGED; effectIssued=false\n',
    'BOXED_RESOURCE_FOREIGN_PID; effectIssued=false\n',
    'BOXED_RESOURCE_FOREIGN_CHILD; effectIssued=false\n',
    'BOXED_RESOURCE_WRITABLE_IDENTITY; effectIssued=false\n',
    'BOXED_RESOURCE_WRITE_READBACK; effectIssued=true\n',
    'BOXED_RESOURCE_FINAL_POLICY; confirmed=memory.high,cpu.weight; effectIssued=true\n',
    'BOXED_RESOURCE_ROOT_UID_REQUIRED; effectIssued=false\n',
  ])('is a refusal that is never rerun: %s', (line) => {
    expect(classifyDockerResourceHelperFailure(line)).toBe('refused');
  });
  it.each([
    `BOXED_RESOURCE_IO: ${enoent}; BOXED_RESOURCE_CLOSE_UNCONFIRMED: [Os { code: 4, kind: Interrupted }]; effectIssued=true\n`,
    'BOXED_RESOURCE_CLOSE_UNCONFIRMED: [Os { code: 5 }]; effectIssued=true\n',
    `BOXED_RESOURCE_PID_EXITED; BOXED_RESOURCE_CLOSE_UNCONFIRMED: []; effectIssued=false\n`,
    'x\nBOXED_RESOURCE_CLOSE_UNCONFIRMED\ny\n',
  ])('is a lost close whatever preceded it: %s', (line) => {
    expect(classifyDockerResourceHelperFailure(line)).toBe('close-unconfirmed');
  });
  it.each([
    '',
    '\n',
    'Error response from daemon: No such container\n',
    'Killed\n',
    observed.trimEnd(),
    observed + 'extra\n',
    'warning\n' + observed,
    observed.replace('effectIssued=true', 'effectIssued=maybe'),
    observed.replace('; effectIssued=true', ''),
    'BOXED_RESOURCE_IO: Permission denied (os error 13); effectIssued=false\n',
    'BOXED_RESOURCE_IO: Input/output error (os error 5); effectIssued=true\n',
    'BOXED_RESOURCE_IO: Device or resource busy (os error 16); effectIssued=true\n',
    `BOXED_RESOURCE_IO: ${enoent} (os error 2); effectIssued=true\n`,
    // The writable leaf and pool are never the subject of a lost read.
    located(enoent, '/run/reverie-worker-cgroup/memory.high', 'leaf', '; effectIssued=true'),
    located(enoent, '/run/reverie-worker-cgroup', 'leaf'),
    located(enoent, '/run/reverie-box-pool/cpu.weight', 'pool'),
    located(enoent, '/proc/7/stat', 'leaf'),
    located(enoent, '/etc/passwd', `member ${member}`),
    located(enoent, 'proc/7/stat', `member ${member}`),
    located(enoent, '/proc/7 8/stat', `member ${member}`),
    located(enoent, '/proc/7/stat', `member ${member.toUpperCase()}`),
    located(enoent, '/proc/7/stat', `member ${member} task 0`),
    located(enoent, '/proc/7/stat', `owner ${member}`),
    located(enoent, '/proc/7/stat', `member ${member}`, '; confirmed=../../etc; effectIssued=true'),
    located(enoent, '/proc/7/stat', `member ${member}`, '; confirmed=; effectIssued=true'),
    'BOXED_RESOURCE_PID_EXITED at /proc/7/stat; effectIssued=false\n',
    'BOXED_RESOURCE_DEADLINE: later; effectIssued=false\n',
    'BOXED_resource_policy; effectIssued=false\n',
    'BOXED_RESOURCE_; effectIssued=false\n',
    'BOXED_WORKER_CREDENTIAL_MISMATCH; effectIssued=false\n',
    'BOXED_RESOURCE_PLATFORM_UNSUPPORTED\n',
    'A'.repeat(8193) + '\n',
    'BOXED_RESOURCE_POLICY; effectIssued=false\n'.padStart(9000, ' '),
  ])('is unknown: %s', (line) => {
    expect(classifyDockerResourceHelperFailure(line)).toBe('unknown');
  });
  it.each([undefined, null, 7, {}, [observed], Buffer.from(observed)])('is unknown for a non-string %s', (value) => {
    expect(classifyDockerResourceHelperFailure(value)).toBe('unknown');
  });
  it('only ever answers with a journaled class name', () => {
    for (const line of [observed, 'secret token abc\n', 'BOXED_RESOURCE_POLICY; effectIssued=false\n', ''])
      expect(DockerTaskFailure.options).toContain(classifyDockerResourceHelperFailure(line));
  });
});

describe('reading an exited helper through the packaged Engine port', () => {
  const id = 'c'.repeat(64);
  const child = (stderr: string, stdout = '', exit = 0) => {
    physical.argv.length = 0;
    physical.program = `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${exit};`;
  };
  it('reads exactly that container and returns only the class', async () => {
    child(observed);
    const result = await new PackagedDockerEngineCommand().helperFailure(id);
    expect(result).toBe('lost-process');
    expect(physical.argv).toEqual([['--host', 'unix:///run/reverie-engine/docker.sock', 'container', 'logs', id]]);
    expect(JSON.stringify(result)).not.toContain('BOXED');
  });
  it.each([
    ['a refusal', 'BOXED_RESOURCE_HARD_POLICY_MISMATCH; effectIssued=false\n', '', 0, 'refused'],
    ['an Engine error', observed, '', 1, 'unknown'],
    ['a helper that also printed a result', observed, '{"version":1}\n', 0, 'unknown'],
    ['a helper that printed nothing', '', '', 0, 'unknown'],
    ['more output than one line can hold', 'x'.repeat(20000) + '\n', '', 0, 'unknown'],
  ])('answers %s with its class and never throws', async (_name, stderr, stdout, exit, expected) => {
    child(stderr, stdout, exit);
    await expect(new PackagedDockerEngineCommand().helperFailure(id)).resolves.toBe(expected);
  });
  it('refuses anything but a full container ID before running a command', async () => {
    child(observed);
    await expect(new PackagedDockerEngineCommand().helperFailure('--follow')).rejects.toThrow('Fixed resource helper');
    await expect(new PackagedDockerEngineCommand().helperFailure(id.slice(1))).rejects.toThrow('Fixed resource helper');
    expect(physical.argv).toEqual([]);
  });
});
