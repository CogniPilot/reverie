/**
 * @fileoverview The test runners must PARTITION the repo: every test file
 * reachable by exactly one command, no file reachable by none.
 *
 * `npm test` deliberately skips three suites (browser, mobile, perf) because
 * they cannot pass on an arbitrary machine. The failure mode that creates is
 * silent: exclude a file from the gate, forget to add it to a runner, and it is
 * now tested by nothing — with every command still green, because vitest treats
 * "no files matched" as success. That is not hypothetical; the exclusion list
 * lived as literals in one config for its whole life, and nothing pointed the
 * other way.
 *
 * So the globs live in config/test-suites.ts, every config derives from them,
 * and this file checks the arithmetic actually works out on the files on disk.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_TEST_GLOBS,
  MOBILE_TEST_GLOBS,
  NIX_UNCHECKED_TESTS,
  NON_CI_TEST_GLOBS,
  PERF_TEST_GLOBS,
} from '../config/test-suites';

const ROOT = resolve(import.meta.dirname, '..');

/** Every `*.test.ts` under test/, repo-relative, POSIX separators. */
function allTestFiles(dir = 'test'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...allTestFiles(rel));
    else if (entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out.sort();
}

/**
 * Matches the three glob shapes test-suites.ts actually uses, and THROWS on
 * anything else rather than quietly returning false — a glob this cannot read
 * would otherwise make the partition below pass by mis-classifying it.
 */
function matches(glob: string, file: string): boolean {
  if (glob.endsWith('/**')) return file.startsWith(glob.slice(0, -2));
  if (!glob.includes('*')) return file === glob;
  const star = glob.indexOf('*');
  if (glob.indexOf('*', star + 1) !== -1) throw new Error(`unsupported glob (2+ wildcards): ${glob}`);
  const [head, tail] = [glob.slice(0, star), glob.slice(star + 1)];
  if (tail.includes('/')) throw new Error(`unsupported glob (wildcard before a slash): ${glob}`);
  return file.startsWith(head) && file.endsWith(tail) && !file.slice(head.length).includes('/');
}

const claims = (globs: string[], file: string) => globs.some((g) => matches(g, file));

/**
 * The test files the Nix console checks run: every path on an `npm test --`
 * line of nix/package.nix, including its backslash continuations. A path
 * mentioned anywhere else in that file (a comment, say) runs nothing.
 */
function nixCheckedFiles(): string[] {
  const out: string[] = [];
  let continued = false;
  for (const line of readFileSync(resolve(ROOT, '../../nix/package.nix'), 'utf8').split('\n')) {
    const command = continued || /\bnpm test -- /u.test(line);
    if (command) out.push(...(line.replace(/#.*/u, '').match(/\btest\/[\w./-]+\.test\.ts\b/gu) ?? []));
    continued = command && line.trimEnd().endsWith('\\');
  }
  return out;
}

describe('test suite partition', () => {
  it('routes every test file to exactly one runner', () => {
    const runners = {
      'test:browser': BROWSER_TEST_GLOBS,
      'test:mobile': MOBILE_TEST_GLOBS,
      'test:perf': PERF_TEST_GLOBS,
    };

    const orphaned: string[] = [];
    const contested: string[] = [];
    for (const file of allTestFiles()) {
      const owners = Object.entries(runners)
        .filter(([, globs]) => claims(globs, file))
        .map(([name]) => name);
      // Not in any excluded suite == owned by the gate, which is correct and
      // the common case. Only >1 excluded owner is a bug.
      if (owners.length > 1) contested.push(`${file} -> ${owners.join(' + ')}`);
      // An excluded file with no runner is the silent hole this file exists for.
      if (owners.length === 0 && claims(NON_CI_TEST_GLOBS, file)) orphaned.push(file);
    }

    expect(contested, 'a file claimed by two runners runs twice, or not at all').toEqual([]);
    expect(orphaned, 'excluded from `npm test` but no runner picks it up — this file is tested by NOTHING').toEqual([]);
  });

  it('keeps NON_CI_TEST_GLOBS the union of the three excluded suites', () => {
    // The gate excludes NON_CI_TEST_GLOBS; the runners include the three arrays.
    // If the union drifts, the gate skips something no runner covers.
    expect([...NON_CI_TEST_GLOBS].sort()).toEqual(
      [...MOBILE_TEST_GLOBS, ...PERF_TEST_GLOBS, ...BROWSER_TEST_GLOBS].sort()
    );
  });

  it('names only globs the matcher above can actually read', () => {
    // matches() throws on shapes it would otherwise silently mis-classify.
    for (const glob of NON_CI_TEST_GLOBS) expect(() => matches(glob, 'test/x.test.ts')).not.toThrow();
  });

  it('runs every gate file in the Nix console checks, or names why it cannot', () => {
    const files = new Set(allTestFiles());
    const gate = [...files].filter((file) => !claims(NON_CI_TEST_GLOBS, file));
    const checked = nixCheckedFiles();
    const registered = new Set(checked);
    const unchecked = Object.entries(NIX_UNCHECKED_TESTS);

    expect(gate.filter((file) => !registered.has(file) && !(file in NIX_UNCHECKED_TESTS)),
      'a gate file the Nix checks never run is tested by nothing in CI: add it to an `npm test --` line in nix/package.nix, '
        + 'or to NIX_UNCHECKED_TESTS with the reason it cannot run there').toEqual([]);
    expect(checked.filter((file) => !files.has(file)), 'nix/package.nix names a test file that does not exist').toEqual([]);
    expect(checked.filter((file) => claims(NON_CI_TEST_GLOBS, file)), 'nix/package.nix names a file `npm test` excludes').toEqual([]);
    expect(checked.filter((file, i) => checked.indexOf(file) !== i), 'nix/package.nix runs a file twice').toEqual([]);
    expect(unchecked.filter(([file]) => !gate.includes(file) || registered.has(file)).map(([file]) => file),
      'NIX_UNCHECKED_TESTS lists a file that is gone, not in the gate, or registered after all').toEqual([]);
    expect(unchecked.filter(([, reason]) => reason.trim().length < 10).map(([file]) => file), 'every unchecked file needs a real reason')
      .toEqual([]);
  });

  it('reads the Nix registration it guards', () => {
    // A parser that found nothing would make the check above demand the impossible, not pass; but a parser that
    // dropped continuation lines would pass a file that only looks registered. Pin both ends of a known command.
    const checked = nixCheckedFiles();
    expect(checked).toContain('test/fixed-resume-message.test.ts');
    expect(checked).toContain('test/recovery-transaction.test.ts');
    expect(checked).toContain('test/cli-agent-credentials.test.ts');
  });

  it('points every excluded glob at files that exist', () => {
    // A stale entry (file renamed or deleted) makes its runner silently empty.
    const files = allTestFiles();
    for (const glob of NON_CI_TEST_GLOBS) {
      expect(
        files.some((f) => matches(glob, f)),
        `${glob} matches no test file`
      ).toBe(true);
    }
  });
});
