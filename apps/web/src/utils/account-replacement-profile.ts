/** Select an implemented protocol from resolved stock provenance, never from caller JSON. */
import { getCli } from '../config/cli-registry/registry.js';
import { STOCK_CLIS } from '../config/cli-registry/stock.js';
import { ACCOUNT_REPLACEMENT_PROFILES, type AccountReplacementProfile } from '../account-replacement-policy.js';

export function accountReplacementProfile(mode: string | undefined): Readonly<AccountReplacementProfile> | undefined {
  if (!mode) return undefined;
  const entry = getCli(mode);
  const shipped = STOCK_CLIS.find((candidate) => candidate.id === mode);
  const name = shipped?.capabilities.accountReplacementProfile;
  if (!entry?.stock || !name || entry.capabilities.accountReplacementProfile !== name) return undefined;
  return ACCOUNT_REPLACEMENT_PROFILES[name];
}
export function accountReplacementForProvider(provider: string): Readonly<AccountReplacementProfile> | undefined {
  for (const profile of Object.values(ACCOUNT_REPLACEMENT_PROFILES)) {
    if (profile.provider === provider && accountReplacementProfile(profile.harness) === profile) return profile;
  }
  return undefined;
}
export function accountReplacementRefusal(mode: string | undefined): string | undefined {
  return STOCK_CLIS.find((entry) => entry.id === mode)?.capabilities.accountReplacementRefusal;
}
