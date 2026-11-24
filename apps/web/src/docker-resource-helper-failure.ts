/** Why an exited resource writer failed, read from the one line it printed
 * through a closed allow-list. The line is never returned, logged or stored:
 * only one of five class names leaves this module. A class is DATA about a
 * terminated helper; it never authorizes a write or acknowledges a limit. */
import type { DockerTaskFailure } from './docker-continuation-task.js';

/** A helper prints one short line. Anything longer is not one of ours. */
const MAXIMUM_LINE_BYTES = 8192;
/** What every failure line ends with: the control files whose issued value
 * was read back, when there were any, and whether anything was issued. */
const outcome =
  '(?:; confirmed=[a-z]{1,16}(?:\\.[a-z]{1,16}){1,3}(?:,[a-z]{1,16}(?:\\.[a-z]{1,16}){1,3}){0,15})?; effectIssued=(?:true|false)\\n$';
/** A process or thread that ended while the helper read it. An earlier helper
 * prints the kernel's text alone; a later one follows it with the path it
 * read and whose it was. The writable leaf and pool are never such a subject:
 * a control file missing there is not a lost read. */
const lostProcess = new RegExp(
  '^(?:BOXED_RESOURCE_IO: (?:No such process \\(os error 3\\)|No such file or directory \\(os error 2\\))' +
    '(?: at (?:/proc|/sys/fs/cgroup)(?:/[A-Za-z0-9._-]{1,255}){1,15})?' +
    '(?: \\((?:box|(?:anchor|worker|member) [a-f0-9]{64}(?: task [1-9][0-9]{0,9})?)\\))?' +
    '|BOXED_RESOURCE_PID_EXITED)' +
    outcome
);
const deadline = new RegExp('^BOXED_RESOURCE_DEADLINE' + outcome);
/** Any other fixed refusal of the helper: an identity, custody or policy check. */
const refused = new RegExp('^BOXED_(?:RESOURCE|STORAGE)_[A-Z]{1,24}(?:_[A-Z]{1,24}){0,7}' + outcome);

export function classifyDockerResourceHelperFailure(stderr: unknown): DockerTaskFailure {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr) > MAXIMUM_LINE_BYTES) return 'unknown';
  // A lost close is never just the failure printed before it.
  if (stderr.includes('BOXED_RESOURCE_CLOSE_UNCONFIRMED')) return 'close-unconfirmed';
  if (stderr.indexOf('\n') !== stderr.length - 1) return 'unknown';
  if (lostProcess.test(stderr)) return 'lost-process';
  if (deadline.test(stderr)) return 'deadline';
  if (stderr.startsWith('BOXED_RESOURCE_IO')) return 'unknown';
  return refused.test(stderr) ? 'refused' : 'unknown';
}
