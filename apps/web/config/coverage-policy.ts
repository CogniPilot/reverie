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
    // Docker plan authorities are independently gated: the global average cannot
    // conceal lost intent, requester, installation or original-writer regressions.
    // Initial floors use the complete hosted report and targeted Work fault tests.
    'src/docker-plan-move-work.ts': { statements: 90, branches: 90, functions: 80, lines: 90 },
    'src/docker-plan-move-requester.ts': { statements: 85, branches: 85, functions: 95, lines: 90 },
    'src/plan-move-store.ts': { statements: 90, branches: 85, functions: 95, lines: 90 },
    'src/docker-plan-installer.ts': { statements: 80, branches: 70, functions: 90, lines: 85 },
    'src/docker-plan-source-holder.ts': { statements: 85, branches: 80, functions: 95, lines: 90 },
    'src/docker-plan-local-client.ts': { statements: 85, branches: 80, functions: 95, lines: 90 },
    'src/docker-plan-move-data.ts': { statements: 90, branches: 90, functions: 95, lines: 90 },
    'src/docker-plan-source-retirement.ts': { statements: 80, branches: 85, functions: 85, lines: 85 },
    // Original viewer process/socket authority must retain its own fault coverage.
    'src/docker-viewer-pane.ts': { statements: 90, branches: 90, functions: 100, lines: 95 },
    'src/docker-viewer-process.ts': { statements: 85, branches: 80, functions: 90, lines: 90 },
  },
};

// Vitest permits an unmatched per-file threshold. Refuse that silent hole when
// an authority is renamed or removed; its policy must move with the source.
for (const file of Object.keys(webCoverage.thresholds).filter((key) => key.startsWith('src/'))) {
  if (!existsSync(resolve(import.meta.dirname, '..', file)))
    throw new Error(`Coverage authority is missing: ${file}; update its policy with the source`);
}
