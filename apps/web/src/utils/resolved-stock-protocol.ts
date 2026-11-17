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
interface ProtocolMemo {
  readonly entry: CliEntry;
  readonly shipped: CliEntry;
  readonly matches: boolean;
}
const protocols = new WeakMap<CliEntry, ProtocolMemo>();
function frozenProtocolCopy(entry: CliEntry): CliEntry {
  const copy = structuredClone(entry);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
/** Launch/environment protocol equality remains mandatory for its existing consumers.
 * Reuse validation DATA only while BOTH complete raw definitions remain equal to
 * their private frozen copies. Registry reloads, in-place changes and functions
 * cannot turn an identifier or a serialized projection into protocol authority. */
export function resolvedStockProtocol(mode: string): { entry: CliEntry; shipped: CliEntry } | undefined {
  const entry = getCli(mode),
    shipped = STOCK_CLIS.find((candidate) => candidate.id === mode);
  const memo = entry && protocols.get(entry);
  if (entry && shipped && memo && isDeepStrictEqual(entry, memo.entry) && isDeepStrictEqual(shipped, memo.shipped))
    return memo.matches ? { entry, shipped } : undefined;
  const pair = resolvedStockEntry(mode);
  if (!pair) return undefined;
  const matches = sameLaunchProtocol(pair.entry, pair.shipped);
  try {
    protocols.set(pair.entry, {
      entry: frozenProtocolCopy(pair.entry),
      shipped: frozenProtocolCopy(pair.shipped),
      matches,
    });
  } catch {
    // A definition that cannot be copied still receives the original full validation.
    // Never use JSON/toJSON to manufacture a cache key for it.
  }
  return matches ? pair : undefined;
}
