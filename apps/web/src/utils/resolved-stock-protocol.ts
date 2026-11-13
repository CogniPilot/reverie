/** Shared registry provenance, independent of the feature a caller intends to use. */
import { isDeepStrictEqual } from 'node:util';
import { getCli } from '../config/cli-registry/registry.js';
import { CliEntrySchema } from '../config/cli-registry/schema.js';
import { STOCK_CLIS } from '../config/cli-registry/stock.js';
import type { CliEntry } from '../config/cli-registry/types.js';

function protocol(entry: CliEntry): unknown {
  const parsed = CliEntrySchema.safeParse(entry);
  if (!parsed.success) return undefined;
  // Normalize optional undefined fields only after schema validation has removed
  // any possibility of caller toJSON methods laundering another protocol.
  return JSON.parse(JSON.stringify({ launch: parsed.data.launch, env: parsed.data.env })) as unknown;
}
export function sameLaunchProtocol(first: CliEntry, second: CliEntry): boolean {
  const left = protocol(first),
    right = protocol(second);
  return !!left && !!right && isDeepStrictEqual(left, right);
}
/** Actual registry provenance only; a feature must separately validate its own declaration. */
export function resolvedStockEntry(mode: string): { entry: CliEntry; shipped: CliEntry } | undefined {
  const entry = getCli(mode),
    shipped = STOCK_CLIS.find((candidate) => candidate.id === mode);
  if (!entry?.stock || !shipped || !CliEntrySchema.safeParse(entry).success) return undefined;
  return { entry, shipped };
}
/** Launch/environment protocol equality remains mandatory for its existing consumers. */
export function resolvedStockProtocol(mode: string): { entry: CliEntry; shipped: CliEntry } | undefined {
  const pair = resolvedStockEntry(mode);
  return pair && sameLaunchProtocol(pair.entry, pair.shipped) ? pair : undefined;
}
