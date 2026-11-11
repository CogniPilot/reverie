/** Hiring presentation/input protocols; these grant no permission to start a runtime. */
import { getCli } from '../config/cli-registry/registry.js';
import type { CliEntry } from '../config/cli-registry/types.js';
import { EFFORT_LEVELS } from '../types/session.js';
import { resolvedStockProtocol } from './resolved-stock-protocol.js';

export function hireEffortInput(mode: string): { values: readonly string[]; field?: string } {
  const entry = getCli(mode);
  if (entry?.launch.effortInput) {
    const measured = resolvedStockProtocol(mode);
    if (!measured || measured.entry.launch.effortInput !== measured.shipped.launch.effortInput) return { values: [] };
    return { values: EFFORT_LEVELS };
  }
  for (const name of ['reasoningEffort', 'thinking', 'effort']) {
    const param = entry?.launch.params[name];
    if (param?.type === 'enum') return { values: param.values, field: name };
  }
  return { values: [] };
}

/** Call only after enabled-agent and local-model compatibility filtering. */
export function preferredLocalModelHarness(entries: readonly CliEntry[]): CliEntry | undefined {
  return (
    entries.find((entry) => entry.capabilities.localModelPreference === 'preferred') ??
    entries.find((entry) => !entry.stock) ??
    entries[0]
  );
}
