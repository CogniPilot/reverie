/** Why one `docker exec` of a fixed helper failed, as a closed class. A failed
 * exec used to surface as the bare command line, which says what was run and
 * never why. Only the class, the exit status and the helper's own refusal code
 * are kept: nothing the Engine or the helper printed leaves this module. */
export type DockerExecFailureKind =
  /** The office gave up waiting (its own deadline) and stopped the client. */
  | 'timed-out'
  /** Exit 137: the process was killed inside the container, which for a helper
   * that only reads is the container's memory limit. */
  | 'killed'
  /** The runtime could not start the process for lack of memory. */
  | 'out-of-memory'
  /** The runtime could not start the process: the container's task limit. */
  | 'task-limit'
  /** The runtime refused to start the process for another reason. */
  | 'exec-refused'
  | 'not-running'
  | 'absent'
  | 'engine-unreachable'
  /** The helper ran and refused with one of its own codes. */
  | 'helper-refused'
  /** Any other exit status. */
  | 'failed';
export interface DockerExecFailure {
  readonly kind: DockerExecFailureKind;
  readonly exitCode?: number;
  readonly signal?: string;
  /** `BOXED_…` code of a helper refusal. */
  readonly helper?: string;
  /** How much the client printed on stderr; its text is never kept. */
  readonly stderrBytes: number;
}
/** Read-only reads may be repeated after these; the others are definitive or
 * would only repeat a wait that already ran to its deadline. */
export function dockerExecFailureRetryable(failure: DockerExecFailure): boolean {
  return ['killed', 'out-of-memory', 'task-limit', 'exec-refused', 'failed'].includes(failure.kind);
}
export function classifyDockerExecFailure(error: unknown): DockerExecFailure {
  const value = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    message?: unknown;
  };
  // Node reports a failed child as `Command failed: <command>\n<stderr>`.
  const message = typeof value.message === 'string' ? value.message.slice(0, 65536) : '',
    stderr = message.startsWith('Command failed: ') && message.includes('\n') ? message.slice(message.indexOf('\n') + 1) : '';
  const base = {
    stderrBytes: Buffer.byteLength(stderr),
    ...(Number.isInteger(value.code) ? { exitCode: value.code as number } : {}),
    ...(typeof value.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(value.signal) ? { signal: value.signal } : {}),
  };
  const kind = (): DockerExecFailureKind => {
    if (value.killed === true) return 'timed-out';
    if (typeof value.code === 'string') return 'engine-unreachable';
    if (/Cannot connect to the Docker daemon|error during connect|connection refused/i.test(stderr))
      return 'engine-unreachable';
    if (/No such container/i.test(stderr)) return 'absent';
    if (/is not running|is paused|is restarting/i.test(stderr)) return 'not-running';
    if (/OCI runtime exec failed|runc|unable to start container process/i.test(stderr)) {
      if (/cannot allocate memory|out of memory|memory limit/i.test(stderr)) return 'out-of-memory';
      if (/resource temporarily unavailable|pids|cannot fork|can't fork/i.test(stderr)) return 'task-limit';
      return 'exec-refused';
    }
    if (value.code === 137 || value.signal === 'SIGKILL') return 'killed';
    return 'failed';
  };
  const refusal = /^(BOXED_[A-Z0-9_]{1,64})\b/m.exec(stderr);
  const found = kind();
  return found === 'failed' && refusal ? { ...base, kind: 'helper-refused', helper: refusal[1]! } : { ...base, kind: found };
}
/** `DOCKER_STORAGE_HOLDER_STATUS` + `killed` → `DOCKER_STORAGE_HOLDER_STATUS_KILLED`. */
export function dockerExecFailureCode(prefix: string, failure: DockerExecFailure): string {
  return prefix + '_' + failure.kind.replaceAll('-', '_').toUpperCase();
}
/** One bounded line for the office log. */
export function describeDockerExecFailure(failure: DockerExecFailure): string {
  return [
    'kind=' + failure.kind,
    ...(failure.exitCode === undefined ? [] : ['exit=' + failure.exitCode]),
    ...(failure.signal ? ['signal=' + failure.signal] : []),
    ...(failure.helper ? ['helper=' + failure.helper] : []),
    'stderrBytes=' + failure.stderrBytes,
  ].join(' ');
}
