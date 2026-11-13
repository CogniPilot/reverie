import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Initial floors from the complete, isolated web-suite baseline. All source
 * files count, including files no test imports. These are minimums, not targets;
 * raise them as uncovered paths gain behavioral tests. Never auto-update floors.
 * Browser JavaScript and native Rust have separate acceptance gates.
 */
export const webCoverage = {
  provider: 'v8' as const,
  include: ['src/**/*.ts'],
  exclude: [] as string[],
  reporter: ['text-summary', 'json-summary', 'json', 'html'] as const,
  reportOnFailure: true,
  thresholds: {
    statements: 80,
    branches: 75,
    functions: 80,
    lines: 82,
    // Global averages must not hide regressions in these lifecycle authorities.
    'src/state-store.ts': { statements: 80, branches: 69, functions: 88, lines: 81 },
    'src/company-wake.ts': { statements: 90, branches: 88, functions: 90, lines: 90 },
    'src/worker-provider-health.ts': { statements: 96, branches: 95, functions: 100, lines: 97 },
    'src/resource-fleet-native-data.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
};

// Vitest permits an unmatched per-file threshold. Refuse that silent hole when
// an authority is renamed or removed; its policy must move with the source.
for (const file of Object.keys(webCoverage.thresholds).filter((key) => key.startsWith('src/'))) {
  if (!existsSync(resolve(import.meta.dirname, '..', file)))
    throw new Error(`Coverage authority is missing: ${file}; update its policy with the source`);
}
