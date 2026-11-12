import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateExplicitTestSelection } from '../config/test-selection.js';

const root = resolve(import.meta.dirname, '..');
const files = ['test/unit.test.ts', 'test/other/unit.test.ts', 'test/page.browser.test.ts', 'test/mobile/touch.test.ts'];
const ci = { root, suite: 'default CI', include: ['test/**/*.test.ts'], exclude: ['test/*.browser.test.ts', 'test/mobile/**'] };

it.each(['test/missing.test.ts', 'missing.test.ts', 'test/workspace-hook-policy.test.ts'])(
  'rejects missing explicit file %s even when another selected file exists', argument => {
    expect(() => validateExplicitTestSelection(ci, files, ['run', 'test/unit.test.ts', argument], root)).toThrow('does not exist');
  }
);

it.each(['test/page.browser.test.ts', 'test/mobile/touch.test.ts'])(
  'refuses an excluded file %s instead of silently running only the other selection', argument => {
    expect(() => validateExplicitTestSelection(ci, files, ['test/unit.test.ts', argument], root)).toThrow('owning runner');
  }
);

it('accepts exact relative, basename, absolute and repository-qualified selections', () => {
  for (const argument of ['test/unit.test.ts', 'unit.test.ts', join(root, 'test/unit.test.ts')])
    expect(() => validateExplicitTestSelection(ci, files, [argument], root)).not.toThrow();
  const cwd = dirname(root);
  expect(() => validateExplicitTestSelection(ci, files, [relative(cwd, join(root, 'test/unit.test.ts'))], cwd)).not.toThrow();
});

it('uses each runner’s actual include/exclude boundary', () => {
  const browser = { root, suite: 'browser', include: ['test/*.browser.test.ts'] };
  expect(() => validateExplicitTestSelection(browser, files, ['test/page.browser.test.ts'], root)).not.toThrow();
  expect(() => validateExplicitTestSelection(browser, files, ['test/unit.test.ts'], root)).toThrow('browser runner');
  expect(() => validateExplicitTestSelection({ root, suite: 'mobile', include: ['test/mobile/**/*.test.ts'] }, files,
    ['test/mobile/touch.test.ts'], root)).not.toThrow();
});

it('leaves ordinary name filters to Vitest and never interprets option values as selected files', () => {
  expect(() => validateExplicitTestSelection(ci, files, ['session', '-t', 'missing.test.ts', '--exclude', 'missing.test.ts',
    '--config', 'missing.config.test.ts', '--testNamePattern=missing.test.ts', 'test/unit.test.ts'], root)).not.toThrow();
});

it('refuses outside-root and unverifiable wildcard filenames', () => {
  expect(() => validateExplicitTestSelection(ci, files, ['../foreign.test.ts'], root)).toThrow('does not exist');
  expect(() => validateExplicitTestSelection(ci, files, ['test/*.test.ts'], root)).toThrow('exact filenames');
});

it.each([
  { config: 'config/vitest.ci.config.ts', args: ['test/test-suite-partition.test.ts', 'test/definitely-missing-selection.test.ts'], error: 'Explicit test file does not exist' },
  { config: 'config/vitest.browser.config.ts', args: ['test/test-suite-partition.test.ts'], error: 'excluded from the browser runner' },
])('fails the actual $config loader before test setup', ({ config, args, error }) => {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_COLOR: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(error);
  expect(result.stdout).not.toMatch(/RUN\s+v\d/);
});
