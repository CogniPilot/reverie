import { resolve } from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';
import { NON_CI_TEST_GLOBS } from './test-suites';

const root = resolve(import.meta.dirname, '..');
// The Nix check sets this to run test files side by side; unset, files run one at a time as before.
const fileWorkers = Number.parseInt(process.env.NIX_TEST_FILE_WORKERS ?? '', 10) || 1;

/**
 * The default gate — what `npm test` and CI both run.
 *
 * Same as vitest.config.ts but EXCLUDES the suites that cannot pass on an
 * arbitrary machine: browser-driven (Playwright + chromium), visual-regression
 * (per-machine PNG baselines) and wall-clock perf. Those are not unmaintained;
 * they have their own runners (`test:browser`, `test:mobile`, `test:perf`).
 * See config/test-suites.ts for the list and the reason behind each entry.
 *
 * Keep the rest in sync with config/vitest.config.ts.
 */
export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...NON_CI_TEST_GLOBS],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: fileWorkers > 1,
    maxWorkers: fileWorkers,
    testTimeout: 30000,
    teardownTimeout: 60000,
  },
});
