import type { PlanAccount } from './plan-accounts.js';
import { launchFor } from './plan-accounts.js';
import type { SessionState } from './types.js';
import { PlanMoveError, type PlanMoveInput } from './plan-move.js';
import { CreateSessionSchema } from './web/schemas.js';
import { createHash } from 'node:crypto';
import type { RuntimeRefreshPolicy } from './account-replacement-policy.js';
export type { RuntimeRefreshPolicy } from './account-replacement-policy.js';
import { accountReplacementProfile, accountReplacementForProvider, accountReplacementRefusal } from './utils/account-replacement-profile.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

/** Selected launch policy only: live status and provider conversation linkage are deliberately absent. */
export function runtimeRefreshDigest(saved: SessionState, account: PlanAccount, policy: RuntimeRefreshPolicy = {}): string {
  // Use the ordinary schema's effective rendering default, while retaining any
  // unknown source keys so a normal create that would strip them is refused.
  const profile = accountReplacementProfile(saved.mode);
  if (!profile) throw new PlanMoveError('Runtime refresh requires a supported account replacement profile');
  const selected = {
    mode: saved.mode, workingDir: saved.workingDir,
    account: { id: account.id, provider: account.provider, profileId: account.profileId,
      configDir: account.configDir, realDir: account.realDir, isDefault: account.isDefault },
    subscriptionProfile: saved.subscriptionProfile,
    ...profile.selectedPolicy(saved, policy, config => ({ ...config, ...CreateSessionSchema.shape.codexConfig.parse(config ?? {}) })),
    niceConfig: policy.niceConfig, envOverrides: policy.envOverrides ?? {},
  };
  return createHash('sha256').update(canonical(selected)).digest('hex');
}

function replacementForAccount(account: Pick<PlanAccount, 'provider'>) {
  const profile = accountReplacementForProvider(account.provider);
  if (profile) return profile;
  throw new PlanMoveError('Choose a plan with a supported harness');
}
export function planMoveHarness(account: Pick<PlanAccount, 'provider'>): 'codex' | 'claude' {
  return replacementForAccount(account).harness;
}

export function planMoveLaunch(saved: SessionState, account: PlanAccount, input: PlanMoveInput, policy: RuntimeRefreshPolicy = {}) {
  if (saved.id !== input.sessionId) throw new PlanMoveError('The source session changed');
  if (saved.remote || saved.docker || saved.customModel)
    throw new PlanMoveError('Remote, container and custom-model sessions cannot move plans in this version');
  const sourceProfile = accountReplacementProfile(saved.mode);
  if (!sourceProfile)
    throw new PlanMoveError(accountReplacementRefusal(saved.mode) ?? 'Custom harnesses and other session types cannot move plans in this version');
  const targetProfile = replacementForAccount(account);
  const mode = targetProfile.harness;
  if (input.targetMode && input.targetMode !== mode)
    throw new PlanMoveError('The destination harness changed; request a new move');
  const sameHarness = saved.mode === mode;
  if (!input.handoff.trim()) throw new PlanMoveError('A fresh cross-account session requires a handoff');
  if (input.purpose === 'runtime-refresh') {
    const model = sourceProfile.model(saved);
    if (input.fromAccount !== input.toAccount || input.toAccount !== account.id || !sameHarness ||
        (input.model !== undefined && input.model !== model) ||
        input.runtimeDigest !== runtimeRefreshDigest(saved, account, policy))
      throw new PlanMoveError('The selected runtime or account changed before refresh');
  }
  const launch = launchFor(account);
  const refreshProfile = saved.subscriptionProfile?.id ?? launch.subscriptionProfileId;
  const refreshEnv = { ...launch.envOverrides, ...policy.envOverrides };
  // The normal profile selector supplies login-directory references itself.
  // Passing them alongside a profile is intentionally refused by that route.
  if (refreshProfile)
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME']) delete refreshEnv[key];
  // Model names, effort values and native threads belong to their provider.
  // A new provider starts with its defaults and receives the portable handoff.
  return CreateSessionSchema.parse({
    employeeId: input.employeeId,
    name: saved.name,
    workingDir: saved.workingDir,
    mode,
    ...(input.purpose === 'runtime-refresh' ? {
      ...(refreshProfile ? { subscriptionProfileId: refreshProfile } : {}),
      envOverrides: refreshEnv,
    } : launch.subscriptionProfileId
      ? { subscriptionProfileId: launch.subscriptionProfileId }
      : { envOverrides: launch.envOverrides }),
    ...targetProfile.launchConfig(saved, input.model, sameHarness),
  });
}
