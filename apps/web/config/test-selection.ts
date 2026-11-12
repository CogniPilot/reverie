/** Fail before test setup when an explicit test filename would be silently ignored. */
import { readdirSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

export interface TestSelection {
  root: string;
  suite: string;
  include: readonly string[];
  exclude?: readonly string[];
}

/** Exact filenames are intentional selections; ordinary substring/name filters remain Vitest's. */
export function validateExplicitTestSelection(
  selection: TestSelection,
  files: readonly string[],
  argv: readonly string[],
  cwd: string
): void {
  const skippedValues = new Set(['-t', '--testNamePattern', '--exclude', '-c', '--config', '--reporter', '--outputFile']);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (skippedValues.has(argument)) { index++; continue; }
    if (argument.startsWith('-') || !/\.test\.[cm]?[jt]sx?$/.test(argument)) continue;
    if (/[*?\[\]{}]/.test(argument))
      throw new Error(`Cannot verify explicit wildcard test selection ${argument}; use exact filenames or the full ${selection.suite} suite`);
    const normalized = argument.replaceAll('\\', sep);
    const hasPath = isAbsolute(normalized) || normalized.includes(sep);
    const path = relative(selection.root, resolve(cwd, normalized)).split(sep).join('/');
    const matching = files.filter(file => hasPath ? file === path : posix.basename(file) === argument);
    if (!matching.length) throw new Error(`Explicit test file does not exist under this test root: ${argument}`);
    const admitted = matching.some(file => selection.include.some(glob => posix.matchesGlob(file, glob)) &&
      !(selection.exclude ?? []).some(glob => posix.matchesGlob(file, glob)));
    if (!admitted) throw new Error(`Explicit test file is excluded from the ${selection.suite} runner: ${argument}; use its owning runner`);
  }
}

function testFiles(root: string, directory = 'test'): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = posix.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(root, file);
    return entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

export function assertExplicitTestSelection(selection: TestSelection): void {
  const argv = process.argv.slice(2);
  if (!argv.some(argument => /\.test\.[cm]?[jt]sx?$/.test(argument))) return;
  validateExplicitTestSelection(selection, testFiles(selection.root), argv, process.cwd());
}
