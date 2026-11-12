/** Resolve only shipped protocols from the actual registry; caller stock flags are not provenance. */
import { isDeepStrictEqual } from 'node:util';
import { getCli } from '../config/cli-registry/registry.js';
import type { CliEntry, FullAccessDefaults } from '../config/cli-registry/types.js';
import { STARTUP_ACCOUNT_PROFILES, type StartupAccountProfile } from '../cli-startup-policy.js';
import {resolvedStockProtocol,sameLaunchProtocol} from './resolved-stock-protocol.js';

export function startupAccountProfile(mode: string): Readonly<StartupAccountProfile> | undefined {
  const pair = resolvedStockProtocol(mode),
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
    !sameLaunchProtocol(entry,current)
  )
    return undefined;
  return selected;
}
export function stockFullAccessDefaults(mode: string): Readonly<FullAccessDefaults> | undefined {
  const pair = resolvedStockProtocol(mode),
    defaults = pair?.shipped.capabilities.fullAccessDefaults;
  if (!pair || !defaults || !isDeepStrictEqual(pair.entry.capabilities.fullAccessDefaults, defaults)) return undefined;
  return defaults;
}
