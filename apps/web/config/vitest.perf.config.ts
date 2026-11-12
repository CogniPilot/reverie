import { assertExplicitTestSelection } from './test-selection';
import { resolve } from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';
import { PERF_TEST_GLOBS } from './test-suites';

const root = resolve(import.meta.dirname, '..');
const selection = { root, suite: 'performance', include: PERF_TEST_GLOBS, exclude: configDefaults.exclude };
assertExplicitTestSelection(selection);

/**
 * The wall-clock benchmarks `npm test` skips — `npm run test:perf`.
 *
 * These assert on durations, so run them on an otherwise idle machine: a loaded
 * runner fails them for reasons that have nothing to do with the diff under
 * test, which is exactly why they are not part of the default gate.
 */
export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: selection.include,
    exclude: selection.exclude,
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    teardownTimeout: 60000,
  },
});
