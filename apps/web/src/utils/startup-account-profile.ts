/** Resolve only shipped protocols from the actual registry; caller stock flags are not provenance. */
import { isDeepStrictEqual } from 'node:util';
import { getCli } from '../config/cli-registry/registry.js';
import { CliEntrySchema } from '../config/cli-registry/schema.js';
import { STOCK_CLIS } from '../config/cli-registry/stock.js';
import type { CliEntry, FullAccessDefaults } from '../config/cli-registry/types.js';
import { STARTUP_ACCOUNT_PROFILES, type StartupAccountProfile } from '../cli-startup-policy.js';

function protocol(entry: CliEntry): unknown {
  const parsed = CliEntrySchema.safeParse(entry);
  if (!parsed.success) return undefined;
  // Optional undefined fields have identical wire semantics. Parsing first prevents
  // caller methods/prototypes from laundering a different launch through toJSON.
  return JSON.parse(JSON.stringify({ launch: parsed.data.launch, env: parsed.data.env })) as unknown;
}
function resolvedStock(mode: string): { entry: CliEntry; shipped: CliEntry } | undefined {
  const entry = getCli(mode),
    shipped = STOCK_CLIS.find((candidate) => candidate.id === mode);
  if (!entry?.stock || !shipped) return undefined;
  const actual = protocol(entry),
    canonical = protocol(shipped);
  if (!actual || !canonical || !isDeepStrictEqual(actual, canonical)) return undefined;
  return { entry, shipped };
}
export function startupAccountProfile(mode: string): Readonly<StartupAccountProfile> | undefined {
  const pair = resolvedStock(mode),
    name = pair?.shipped.capabilities.startupAccountProfile;
  if (!pair || !name || pair.entry.capabilities.startupAccountProfile !== name) return undefined;
  return STARTUP_ACCOUNT_PROFILES[name];
}
export function startupAccountProfileForEntry(entry: CliEntry): Readonly<StartupAccountProfile> | undefined {
  const selected = startupAccountProfile(entry.id);
  const current = getCli(entry.id);
  if (
    !selected ||
    !entry.stock ||
    !current ||
    entry.capabilities.startupAccountProfile !== selected.name ||
    !isDeepStrictEqual(protocol(entry), protocol(current))
  )
    return undefined;
  return selected;
}
export function stockFullAccessDefaults(mode: string): Readonly<FullAccessDefaults> | undefined {
  const pair = resolvedStock(mode),
    defaults = pair?.shipped.capabilities.fullAccessDefaults;
  if (!pair || !defaults || !isDeepStrictEqual(pair.entry.capabilities.fullAccessDefaults, defaults)) return undefined;
  return defaults;
}
