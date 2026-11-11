import { assertExplicitTestSelection } from '../../config/test-selection';
import { resolve } from 'node:path';
import { defineConfig, configDefaults } from 'vitest/config';

const root = resolve(import.meta.dirname, '../..');
const selection = { root, suite: 'mobile', include: ['test/mobile/**/*.test.ts'], exclude: configDefaults.exclude };
assertExplicitTestSelection(selection);

export default defineConfig({
  test: {
    root,
    globals: true,
    environment: 'node',
    include: selection.include,
    exclude: selection.exclude,
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    teardownTimeout: 60_000,
  },
});
