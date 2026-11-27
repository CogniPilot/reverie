/** What a boxed provider left on its terminal when it exited inside its launch
 * window. Diagnostic DATA only: the laptop wrote every byte of it, so it is
 * bounded, stripped of control characters and has obvious secrets removed
 * before anything else reads it. It never authorizes a launch or a retry. */
import { z } from 'zod';

export const PROVIDER_EXIT_MAX_LINES = 12;
export const PROVIDER_EXIT_MAX_LINE_CHARS = 240;
const MAX_REPORT_BYTES = 16 * 1024;
const PREFIX = 'EXITED ';

export interface DockerProviderExit {
  /** Exit status of the provider process; null when a signal ended it. */
  readonly status: number | null;
  /** Number of the signal that ended it, when one did. */
  readonly signal: number | null;
  /** The last lines its terminal showed, oldest first. */
  readonly lines: readonly string[];
}

const report = z
  .object({
    status: z.number().int().min(0).max(255).nullable(),
    signal: z.number().int().min(1).max(128).nullable(),
    lines: z.array(z.string().max(4096)).max(64),
  })
  .strict();

const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|authorization|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)((?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PROVIDER_KEY = /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xai|hf)[-_][A-Za-z0-9_-]{12,}/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const LONG_OPAQUE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g;

/** Remove what is obviously a credential from one line of provider output. */
export function redactProviderOutput(line: string): string {
  return line
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => name + separator + '[redacted]')
    .replace(BEARER, (_match, scheme: string) => scheme + ' [redacted]')
    .replace(URL_USERINFO, (_match, scheme: string) => scheme + '[redacted]@')
    .replace(PROVIDER_KEY, '[redacted]')
    .replace(LONG_OPAQUE, '[redacted]');
}

function printable(line: string): string {
  // eslint-disable-next-line no-control-regex
  const ansi = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
  let text = '';
  // Redaction scans what is left, so the length is bounded before it runs.
  for (const character of line.slice(0, 2000).replace(ansi, '')) {
    const code = character.codePointAt(0)!;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    text += control ? ' ' : character;
  }
  return text.trimEnd();
}

/** Bound and clean terminal lines that came from inside a laptop. */
export function providerExitLines(lines: readonly string[]): string[] {
  return lines
    .map(printable)
    .filter((line) => line.trim() !== '')
    .slice(-PROVIDER_EXIT_MAX_LINES)
    .map((line) => {
      const clean = redactProviderOutput(line);
      return clean.length > PROVIDER_EXIT_MAX_LINE_CHARS
        ? clean.slice(0, PROVIDER_EXIT_MAX_LINE_CHARS - 1) + '…'
        : clean;
    });
}

/** Read the in-laptop presence report of an exited provider. `undefined`
 * means the output is not such a report; a malformed one throws. */
export function parseDockerProviderExit(output: string): DockerProviderExit | undefined {
  if (!output.startsWith(PREFIX)) return undefined;
  if (Buffer.byteLength(output) > MAX_REPORT_BYTES || !output.endsWith('\n'))
    throw Error('Exited Docker provider report refused');
  const value = report.parse(JSON.parse(output.slice(PREFIX.length)));
  if (value.status === null && value.signal === null) throw Error('Exited Docker provider report refused');
  return Object.freeze({
    status: value.status,
    signal: value.signal,
    lines: Object.freeze(providerExitLines(value.lines)),
  });
}

/** One plain sentence for a person: how the provider ended. */
export function describeDockerProviderExit(exit: DockerProviderExit): string {
  const how = exit.signal !== null ? 'was ended by signal ' + exit.signal : 'exited with status ' + exit.status;
  const last = exit.lines.filter((line) => !/^Pane is dead \(/.test(line)).at(-1);
  return 'The agent ' + how + ' right after it started' + (last ? '. Its last line was: ' + last : '.');
}
