/** Reject new untested controls and increased debt against the actual Git base.
 * This checks registration only; the full inventory and mapped scenarios must pass.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'apps/web/config/control-behavior-manifest.json';
const MAX_BYTES = 2 * 1024 * 1024;
type Snapshot = { budget: number; gaps: Set<string> };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function snapshot(value: unknown, label: string): Snapshot {
  if (
    !record(value) ||
    value.version !== 2 ||
    !Array.isArray(value.sources) ||
    value.sources.some((file) => typeof file !== 'string' || !file.trim()) ||
    new Set(value.sources).size !== value.sources.length ||
    typeof value.gapBudget !== 'number' ||
    !Number.isSafeInteger(value.gapBudget) ||
    value.gapBudget < 0 ||
    !Array.isArray(value.gaps) ||
    !Array.isArray(value.mappings)
  )
    throw Error(label + ': invalid control coverage version, sources, budget or declarations');
  const all = new Set<string>(),
    gaps = new Set<string>();
  for (const [kind, rows] of [
    ['gaps', value.gaps],
    ['mappings', value.mappings],
  ] as const) {
    for (const row of rows) {
      if (
        !record(row) ||
        typeof row.declaration !== 'string' ||
        !row.declaration.trim() ||
        row.declaration.length > 4096 ||
        all.has(row.declaration)
      )
        throw Error(label + ': invalid or duplicate control declaration');
      all.add(row.declaration);
      if (kind === 'gaps') gaps.add(row.declaration);
    }
  }
  if (gaps.size > value.gapBudget) throw Error(label + ': declared gaps exceed the budget');
  return { budget: value.gapBudget, gaps };
}

export function compareControlCoverage(baseline: unknown, candidate: unknown): string[] {
  try {
    const before = snapshot(baseline, 'Baseline'),
      after = snapshot(candidate, 'Candidate');
    const errors: string[] = [];
    if (after.budget > before.budget)
      errors.push('Control gap budget increased: ' + before.budget + ' -> ' + after.budget);
    for (const declaration of [...after.gaps].sort())
      if (!before.gaps.has(declaration)) errors.push('New unqualified control: ' + declaration);
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : 'Invalid control coverage manifest'];
  }
}

function currentManifest(file: string): string {
  if (realpathSync(file) !== file) throw Error('Control manifest aliases are not supported');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let cause: unknown;
  try {
    const before = fstatSync(fd),
      named = lstatSync(file);
    const stamp = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
    if (
      !before.isFile() ||
      before.size > MAX_BYTES ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      stamp(before) !== stamp(named)
    )
      throw Error('A bounded original regular control manifest is required');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (
      length !== before.size ||
      length > MAX_BYTES ||
      stamp(fstatSync(fd)) !== stamp(before) ||
      stamp(lstatSync(file)) !== stamp(before) ||
      realpathSync(file) !== file
    )
      throw Error('Control manifest changed during the read');
    return bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    cause = error;
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch (error) {
      if (cause !== undefined) throw new AggregateError([cause, error], 'Control manifest read and close failed');
      throw error;
    }
  }
}

export function checkControlCoverage(root: string, base: string) {
  if (!/^[a-f0-9]{40}$/i.test(base) || /^0{40}$/.test(base))
    throw Error('A nonzero full Git commit SHA is required for the control coverage baseline');
  const options = { cwd: root, encoding: 'utf8' as const, timeout: 15_000, maxBuffer: MAX_BYTES };
  if (execFileSync('git', ['cat-file', '-t', base], options).trim() !== 'commit')
    throw Error('The control coverage baseline must identify a Git commit');
  const baseline: unknown = JSON.parse(execFileSync('git', ['show', base + ':' + MANIFEST], options));
  const candidate: unknown = JSON.parse(currentManifest(join(root, MANIFEST)));
  return {
    base: base.toLowerCase(),
    errors: compareControlCoverage(baseline, candidate),
    interpretation:
      'Static registration regression only; full inventory validation and mapped scenarios must execute and pass.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--base')
      throw Error('Usage: node --experimental-strip-types control-behavior-ratchet.mts --base <commit-sha>');
    const report = checkControlCoverage(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), process.argv[3]!);
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(
      'Control coverage regression check failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    process.exitCode = 1;
  }
}
