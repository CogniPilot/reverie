import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkControlCoverage, compareControlCoverage } from '../scripts/control-behavior-ratchet.mjs';

const current = () => ({
  version: 2,
  sources: [] as string[],
  gapBudget: 1,
  gaps: [{ declaration: 'legacy control' }],
  mappings: [{ declaration: 'covered control' }],
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('accepts an unchanged registration baseline without claiming behavioral execution', () => {
  expect(compareControlCoverage(current(), current())).toEqual([]);
});

it('rejects a raised allowance even when the gap count stays unchanged', () => {
  expect(compareControlCoverage(current(), { ...current(), gapBudget: 2 })).toEqual([
    'Control gap budget increased: 1 -> 2',
  ]);
});

it('rejects trading a retired gap for a new untested control at the same count', () => {
  expect(compareControlCoverage(current(), { ...current(), gaps: [{ declaration: 'new control' }] })).toEqual([
    'New unqualified control: new control',
  ]);
});

it('rejects downgrading a previously mapped control even with a lower total gap count', () => {
  expect(
    compareControlCoverage(current(), { ...current(), gaps: [{ declaration: 'covered control' }], mappings: [] })
  ).toEqual(['New unqualified control: covered control']);
});

it('permits closing gaps, removing retired controls and adding mapped controls', () => {
  expect(
    compareControlCoverage(current(), {
      version: 2,
      sources: [],
      gapBudget: 0,
      gaps: [],
      mappings: [{ declaration: 'new covered control' }],
    })
  ).toEqual([]);
});

it.each([undefined, null, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1'])(
  'refuses malformed budgets rather than letting comparison coercion disable the gate: %s',
  (gapBudget) => {
    expect(compareControlCoverage(current(), { ...current(), gapBudget })).toEqual([
      'Candidate: invalid control coverage version, sources, budget or declarations',
    ]);
    expect(compareControlCoverage({ ...current(), gapBudget }, current())).toEqual([
      'Baseline: invalid control coverage version, sources, budget or declarations',
    ]);
  }
);

it('rejects duplicate or contradictory mappings and a budget below actual gaps', () => {
  expect(compareControlCoverage(current(), { ...current(), mappings: [{ declaration: 'legacy control' }] })).toEqual([
    'Candidate: invalid or duplicate control declaration',
  ]);
  expect(compareControlCoverage(current(), { ...current(), gapBudget: 0 })).toEqual([
    'Candidate: declared gaps exceed the budget',
  ]);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'apps/web/config'), { recursive: true });
  mkdirSync(join(root, 'apps/web/scripts'), { recursive: true });
  const manifest = join(root, 'apps/web/config/control-behavior-manifest.json');
  const program = join(root, 'apps/web/scripts/control-behavior-ratchet.mts');
  copyFileSync(resolve(import.meta.dirname, '../scripts/control-behavior-ratchet.mts'), program);
  writeFileSync(manifest, JSON.stringify(current()));
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }).trim();
  git(['init', '--quiet']);
  git(['add', '--', 'apps/web/config/control-behavior-manifest.json', 'apps/web/scripts/control-behavior-ratchet.mts']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'baseline']);
  return { root, manifest, program, git, base: git(['rev-parse', 'HEAD']) };
}

it('compares actual Git baseline bytes and makes the real dependency-free CI command fail on a regression', () => {
  const f = fixture();
  expect(checkControlCoverage(f.root, f.base).errors).toEqual([]);
  writeFileSync(f.manifest, JSON.stringify({ ...current(), gapBudget: 2 }));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', f.program, '--base', f.base], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).errors).toEqual(['Control gap budget increased: 1 -> 2']);
  writeFileSync(f.manifest, JSON.stringify({ version: 2, sources: [], gapBudget: 0, gaps: [], mappings: [] }));
  const reduced = spawnSync(process.execPath, ['--experimental-strip-types', f.program, '--base', f.base], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(reduced.status, reduced.stderr).toBe(0);
  expect(JSON.parse(reduced.stdout).errors).toEqual([]);
});

it('fails loudly for a missing baseline, missing candidate or invalid commit reference', () => {
  const f = fixture();
  expect(() => checkControlCoverage(f.root, 'HEAD')).toThrow('full Git commit SHA');
  expect(() => checkControlCoverage(f.root, '0'.repeat(40))).toThrow('full Git commit SHA');
  expect(() => checkControlCoverage(f.root, 'a'.repeat(40))).toThrow();
  rmSync(f.manifest);
  expect(() => checkControlCoverage(f.root, f.base)).toThrow();
});

it('refuses an existing Git commit which has no historical control manifest', () => {
  const f = fixture();
  const git = (args: string[]) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
  git(['rm', '--cached', '--quiet', '--', 'apps/web/config/control-behavior-manifest.json']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'without manifest',
  ]);
  expect(() => checkControlCoverage(f.root, git(['rev-parse', 'HEAD']))).toThrow();
});

function sourceFixture(html = false) {
  const f = fixture(),
    file = 'src/web/public/example.' + (html ? 'html' : 'js');
  const absolute = join(f.root, 'apps/web', file);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, html ? '<script>button("Legacy", action);</script>' : 'button("Legacy", action);');
  f.git(['add', '--', 'apps/web/' + file]);
  f.git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'existing source',
  ]);
  const base = f.git(['rev-parse', 'HEAD']);
  const declaration = file + (html ? '#inline-1' : '') + '::module::inline::button:Legacy';
  return { ...f, base, file, absolute, declaration };
}

it.each([false, true])('rejects newly declared gaps even in unchanged historical source (HTML inline=%s)', (html) => {
  const f = sourceFixture(html);
  writeFileSync(
    f.manifest,
    JSON.stringify({
      ...current(),
      sources: [f.file],
      gapBudget: 2,
      gaps: [...current().gaps, { declaration: f.declaration }],
    })
  );
  expect(checkControlCoverage(f.root, f.base).errors).toEqual([
    'Control gap budget increased: 1 -> 2',
    'New unqualified control: ' + f.declaration,
  ]);
});

it('rejects renaming a mapped identity into an untested gap', () => {
  const f = sourceFixture();
  const old = f.file + '::module::old-binding::button:Legacy';
  writeFileSync(f.manifest, JSON.stringify({ ...current(), sources: [f.file], mappings: [{ declaration: old }] }));
  f.git(['add', '--', 'apps/web/config/control-behavior-manifest.json']);
  f.git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'historical mapping',
  ]);
  const base = f.git(['rev-parse', 'HEAD']);
  writeFileSync(
    f.manifest,
    JSON.stringify({
      ...current(),
      sources: [f.file],
      mappings: [],
      gapBudget: 2,
      gaps: [...current().gaps, { declaration: f.declaration }],
    })
  );
  expect(checkControlCoverage(f.root, base).errors).toContain('New unqualified control: ' + f.declaration);
});

it('requires an explicit source list instead of treating missing scope as empty', () => {
  const f = fixture();
  writeFileSync(f.manifest, JSON.stringify({ version: 2, gapBudget: 0, gaps: [], mappings: [] }));
  expect(checkControlCoverage(f.root, f.base).errors).toEqual([
    'Candidate: invalid control coverage version, sources, budget or declarations',
  ]);
});

function repositorySource(relative: string, packaged: string): string {
  const supplied = resolve(import.meta.dirname, packaged);
  if (existsSync(supplied)) return readFileSync(supplied, 'utf8');
  const root = resolve(import.meta.dirname, '../../..');
  if (resolve(root, 'apps/web/test') !== resolve(import.meta.dirname))
    throw Error('Trusted repository control-coverage input was not supplied');
  return readFileSync(join(root, relative), 'utf8');
}

it('registers the ratchet before image builds and keeps its owning test in the flattened Nix gate', () => {
  const workflow = repositorySource('.github/workflows/image.yml', 'fixtures/control-coverage/image.yml');
  const command = 'node --experimental-strip-types apps/web/scripts/control-behavior-ratchet.mts --base "$BASE_SHA"';
  expect(workflow).toContain(command);
  expect(workflow.indexOf(command)).toBeLessThan(workflow.indexOf('nix flake check --print-build-logs'));
  expect(workflow).toContain("if: github.event_name == 'pull_request' || github.event_name == 'push'");
  expect(repositorySource('nix/package.nix', 'fixtures/nix-package/package.nix')).toContain(
    'test/control-behavior-ratchet.test.ts'
  );
});
