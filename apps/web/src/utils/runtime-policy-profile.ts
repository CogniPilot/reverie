/** Recognize the runtime's shipped local fallback codec, solely for its read-only report. */
import { resolvedStockEntry } from './resolved-stock-protocol.js';
import type { RuntimePolicyFallbackProfileName } from '../config/cli-registry/profiles.js';

export function runtimePolicyFallbackProfile(mode: unknown): RuntimePolicyFallbackProfileName | undefined {
  if (typeof mode !== 'string') return undefined;
  const pair = resolvedStockEntry(mode), profile = pair?.shipped.capabilities.runtimePolicyFallback;
  return pair && profile && pair.entry.capabilities.runtimePolicyFallback === profile ? profile : undefined;
}
