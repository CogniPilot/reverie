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

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../scripts/control-behavior-inventory';
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
 * nix/package.nix, from the copy the Nix build supplies (the web derivation is
 * flattened to apps/web, so the repository file is not there) or else from this
 * checkout. Never a path chosen by the environment.
 */
function nixPackageSource(testDirectory: string): string {
  const packaged = resolve(testDirectory, 'fixtures/nix-package/package.nix');
  const repository = resolve(testDirectory, '../../../nix/package.nix');
  if (existsSync(packaged)) return readFileSync(packaged, 'utf8');
  if (resolve(testDirectory, '../../../apps/web/test') === resolve(testDirectory) && existsSync(repository))
    return readFileSync(repository, 'utf8');
  throw new Error('Trusted nix/package.nix was not supplied');
}

const TEST_FILES = String.raw`((?:test\/[\w./-]+\.test\.ts\s*)+)(\\?)\s*$`;
/** `npm test -- <files>`, optionally after plain `NAME=value` assignments, and nothing else on the line. */
const NPM_TEST = new RegExp(String.raw`^\s*(?:[A-Z][A-Z0-9_]*=[\w./-]*\s+)*npm test -- ` + TEST_FILES, 'u');
const CONTINUATION = new RegExp(String.raw`^\s+` + TEST_FILES, 'u');

/**
 * The test files the console checkPhase runs: the files of each `npm test --`
 * command in it, with their backslash continuations. Anything else that names a
 * test file (a comment, an `echo`, a piped or other derivation's command) runs
 * nothing, so it registers nothing.
 */
function nixCheckedFiles(source: string): string[] {
  const start = source.indexOf("    checkPhase = ''\n");
  const end = source.indexOf('runHook postCheck', start);
  if (start === -1 || end === -1) throw new Error('no console checkPhase in nix/package.nix');
  const out: string[] = [];
  let continued = false;
  for (const line of source.slice(start, end).split('\n')) {
    const match = (continued ? CONTINUATION : NPM_TEST).exec(line);
    if (continued && !match)
      throw new Error(`an npm test command continues into a line that is not test files: ${line.trim()}`);
    if (match) out.push(...match[1]!.trim().split(/\s+/u));
    continued = !!match?.[2];
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
    const checked = nixCheckedFiles(nixPackageSource(resolve(ROOT, 'test')));
    const registered = new Set(checked);
    const unchecked = Object.entries(NIX_UNCHECKED_TESTS);

    expect(
      gate.filter((file) => !registered.has(file) && !(file in NIX_UNCHECKED_TESTS)),
      'a gate file the Nix checks never run is tested by nothing in CI: add it to an `npm test --` line in nix/package.nix, ' +
        'or to NIX_UNCHECKED_TESTS with the reason it cannot run there'
    ).toEqual([]);
    expect(
      checked.filter((file) => !files.has(file)),
      'nix/package.nix names a test file that does not exist'
    ).toEqual([]);
    expect(
      checked.filter((file) => claims(NON_CI_TEST_GLOBS, file)),
      'nix/package.nix names a file `npm test` excludes'
    ).toEqual([]);
    expect(
      checked.filter((file, i) => checked.indexOf(file) !== i),
      'nix/package.nix runs a file twice'
    ).toEqual([]);
    expect(
      unchecked.filter(([file]) => !gate.includes(file) || registered.has(file)).map(([file]) => file),
      'NIX_UNCHECKED_TESTS lists a file that is gone, not in the gate, or registered after all'
    ).toEqual([]);
    expect(
      unchecked.filter(([, reason]) => reason.trim().length < 10).map(([file]) => file),
      'every unchecked file needs a real reason'
    ).toEqual([]);
  });

  it('reads the Nix registration it guards', () => {
    // A parser that found nothing would make the check above demand the impossible, not pass; but a parser that
    // dropped continuation lines would pass a file that only looks registered. Pin both ends of a known command.
    const checked = nixCheckedFiles(nixPackageSource(resolve(ROOT, 'test')));
    expect(checked).toContain('test/fixed-resume-message.test.ts');
    expect(checked).toContain('test/recovery-transaction.test.ts');
    expect(checked).toContain('test/cli-agent-credentials.test.ts');
  });

  it('registers only files an npm test command in the console checkPhase runs', () => {
    const phase = (body: string) =>
      `    checkPhase = ''\n      runHook preCheck\n${body}\n      runHook postCheck\n    '';\n`;
    expect(
      nixCheckedFiles(
        "    buildPhase = ''\n      npm test -- test/z.test.ts\n    '';\n" +
          phase(
            [
              '      npm test -- test/a.test.ts \\',
              '        test/b.test.ts',
              '      NIX_CUSTODY=1 npm test -- test/c.test.ts',
              '      echo npm test -- test/d.test.ts \\',
              '        test/e.test.ts',
              '      # npm test -- test/f.test.ts',
              '      npm test -- test/g.test.ts || true',
              '      npm test -- test/h.test.ts | tee log',
              '      npm test -- $EXTRA test/i.test.ts',
              '      FLAGS="$PWD/x" npm test -- test/j.test.ts',
            ].join('\n')
          ) +
          '      npm test -- test/k.test.ts\n'
      )
    ).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']);
    expect(() => nixCheckedFiles(phase('      npm test -- test/a.test.ts \\\n      echo done'))).toThrow(
      /not test files/
    );
    expect(() => nixCheckedFiles('npm test -- test/a.test.ts\n')).toThrow(/no console checkPhase/);
  });

  it('reads nix/package.nix from the copy the build supplies, else only from this checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'nix-package-layout-'));
    try {
      const flattened = join(root, 'source/test');
      mkdirSync(join(flattened, 'fixtures/nix-package'), { recursive: true });
      expect(() => nixPackageSource(flattened)).toThrow(/not supplied/);
      writeFileSync(join(flattened, 'fixtures/nix-package/package.nix'), 'supplied copy');
      expect(nixPackageSource(flattened)).toBe('supplied copy');
      const checkout = join(root, 'repo/apps/web/test');
      mkdirSync(join(root, 'repo/nix'), { recursive: true });
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(root, 'repo/nix/package.nix'), 'checkout copy');
      expect(nixPackageSource(checkout)).toBe('checkout copy');
      // Three levels up from a test directory that is not apps/web/test is not this repository.
      const elsewhere = join(root, 'repo/other/web/test');
      mkdirSync(elsewhere, { recursive: true });
      expect(() => nixPackageSource(elsewhere)).toThrow(/not supplied/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

/** The curated browser job must actually invoke every browser scenario mapped as covered. */
function browserCheckedFiles(source: string): string[] {
  const start = source.search(/^\s+nix develop --command node apps\/web\/node_modules\/vitest\/vitest\.mjs run \\$/mu);
  if (start === -1) throw new Error('no curated browser invocation in image.yml');
  const lines = source.slice(start).trimStart().split('\n');
  if (lines[1]?.trim() !== '--config apps/web/config/vitest.browser.config.ts \\')
    throw new Error('curated browser runner config changed');
  const files: string[] = [];
  for (const line of lines.slice(2)) {
    if (line.trim() === '2>&1 | tee acceptance/resource-layout.log') return files;
    const match = /^\s+apps\/web\/(test\/[\w./-]+\.test\.ts)\s+\\$/u.exec(line);
    if (!match) throw new Error('unsupported curated browser selection: ' + line.trim());
    files.push(match[1]!);
  }
  throw new Error('curated browser invocation has no checked completion');
}

function ciWorkflowSource(): string {
  const supplied = resolve(ROOT, 'test/fixtures/control-coverage/image.yml');
  if (existsSync(supplied)) return readFileSync(supplied, 'utf8');
  const repository = resolve(ROOT, '../..', '.github/workflows/image.yml');
  if (resolve(ROOT, '../..', 'apps/web') !== ROOT) throw new Error('Trusted image.yml was not supplied');
  return readFileSync(repository, 'utf8');
}

function mappedExecutionGaps(manifest: Manifest, nix: string, workflow: string): string[] {
  const checked = new Set(nixCheckedFiles(nix));
  const browser = new Set(browserCheckedFiles(workflow));
  const mapped = new Set(
    manifest.mappings.flatMap((mapping) =>
      mapping.scenarios.map((id) => {
        const scenario = manifest.scenarios[id];
        if (!scenario) throw new Error('Unknown mapped scenario: ' + id);
        return scenario.test;
      })
    )
  );
  return [...mapped]
    .filter((file) =>
      claims(BROWSER_TEST_GLOBS, file) ? !browser.has(file) : claims(NON_CI_TEST_GLOBS, file) || !checked.has(file)
    )
    .sort();
}

it('executes every mapped control scenario in the mandatory image or browser checks', () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'config/control-behavior-manifest.json'), 'utf8')) as Manifest;
  expect(
    mappedExecutionGaps(manifest, nixPackageSource(resolve(ROOT, 'test')), ciWorkflowSource()),
    'Mapped coverage requires actual CI execution; register the owning suite instead of merely listing a scenario'
  ).toEqual([]);
});

it('rejects absent mapped browser and default suites, including commented-out browser selections', () => {
  const phase = "    checkPhase = ''\n      npm test -- test/default.test.ts\n      runHook postCheck\n    '';\n";
  const workflow = [
    '          nix develop --command node apps/web/node_modules/vitest/vitest.mjs run \\',
    '            --config apps/web/config/vitest.browser.config.ts \\',
    '            apps/web/test/employee-resource-controls.browser.test.ts \\',
    '          2>&1 | tee acceptance/resource-layout.log',
  ].join('\n');
  const manifest = {
    scenarios: {
      browser: { test: 'test/employee-resource-controls.browser.test.ts' },
      default: { test: 'test/default.test.ts' },
    },
    mappings: [{ scenarios: ['browser', 'default'] }],
  } as unknown as Manifest;
  expect(mappedExecutionGaps(manifest, phase, workflow)).toEqual([]);
  expect(mappedExecutionGaps(manifest, phase.replace('test/default.test.ts', 'test/other.test.ts'), workflow)).toEqual([
    'test/default.test.ts',
  ]);
  expect(
    mappedExecutionGaps(
      manifest,
      phase,
      workflow.replace(
        'apps/web/test/employee-resource-controls.browser.test.ts',
        'apps/web/test/office-server.browser.test.ts'
      )
    )
  ).toEqual(['test/employee-resource-controls.browser.test.ts']);
  expect(() =>
    browserCheckedFiles(
      workflow.replace(
        '            apps/web/test/employee-resource-controls.browser.test.ts',
        '            # apps/web/test/employee-resource-controls.browser.test.ts'
      )
    )
  ).toThrow(/unsupported curated browser selection/);
  expect(() =>
    browserCheckedFiles(
      workflow.replace(
        '--config apps/web/config/vitest.browser.config.ts',
        '--config apps/web/config/vitest.ci.config.ts'
      )
    )
  ).toThrow(/runner config changed/);
});
