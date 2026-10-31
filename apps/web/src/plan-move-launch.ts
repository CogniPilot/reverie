import type { PlanAccount } from './plan-accounts.js';
import { launchFor } from './plan-accounts.js';
import type { SessionState } from './types.js';
import { PlanMoveError, type PlanMoveInput } from './plan-move.js';
import { CreateSessionSchema } from './web/schemas.js';
import { createHash } from 'node:crypto';
import type { ClaudeMode, CodexConfig, NiceConfig } from './types.js';

export interface RuntimeRefreshPolicy {
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  niceConfig?: NiceConfig;
  envOverrides?: Record<string, string>;
}

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
  const codexConfig: CodexConfig = saved.mode === 'codex' ? { ...saved.codexConfig,
    ...CreateSessionSchema.shape.codexConfig.parse(saved.codexConfig ?? {}) } : {};
  delete codexConfig.resumeSessionId;
  const selected = {
    mode: saved.mode, workingDir: saved.workingDir,
    account: { id: account.id, provider: account.provider, profileId: account.profileId,
      configDir: account.configDir, realDir: account.realDir, isDefault: account.isDefault },
    subscriptionProfile: saved.subscriptionProfile,
    ...(saved.mode === 'codex' ? { codexConfig } : {
      model: saved.model, effort: saved.effort, advisorModel: saved.advisorModel,
      claudeMode: policy.claudeMode, allowedTools: policy.allowedTools,
    }),
    niceConfig: policy.niceConfig, envOverrides: policy.envOverrides ?? {},
  };
  return createHash('sha256').update(canonical(selected)).digest('hex');
}

export function planMoveHarness(account: Pick<PlanAccount, 'provider'>): 'codex' | 'claude' {
  if (account.provider === 'openai') return 'codex';
  if (account.provider === 'anthropic') return 'claude';
  throw new PlanMoveError('Choose a plan with a supported harness');
}

export function planMoveLaunch(saved: SessionState, account: PlanAccount, input: PlanMoveInput, policy: RuntimeRefreshPolicy = {}) {
  if (saved.id !== input.sessionId) throw new PlanMoveError('The source session changed');
  if (saved.remote || saved.docker || saved.customModel)
    throw new PlanMoveError('Remote, container and custom-model sessions cannot move plans in this version');
  if (saved.mode === 'opencode')
    throw new PlanMoveError('OpenCode thread moves require a launch-then-stop adapter and are not supported yet');
  if (saved.mode !== 'claude' && saved.mode !== 'codex')
    throw new PlanMoveError('Custom harnesses and other session types cannot move plans in this version');
  const mode = planMoveHarness(account);
  if (input.targetMode && input.targetMode !== mode)
    throw new PlanMoveError('The destination harness changed; request a new move');
  const sameHarness = saved.mode === mode;
  if (!input.handoff.trim()) throw new PlanMoveError('A fresh cross-account session requires a handoff');
  if (input.purpose === 'runtime-refresh') {
    const model = saved.mode === 'codex' ? saved.codexConfig?.model : saved.model;
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
  const config = sameHarness && saved.codexConfig ? { ...saved.codexConfig } : {};
  delete config.resumeSessionId;
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
    ...(mode === 'codex'
      ? { codexConfig: { ...config, ...(sameHarness && input.model ? { model: input.model } : {}) } }
      : sameHarness ? {
        // Delegation compares the exact JSON request; absent policy must not add
        // own undefined properties that JSON serialization will discard.
        ...((input.model ?? saved.model) === undefined ? {} : { model: input.model ?? saved.model }),
        ...(saved.effort === undefined ? {} : { effort: saved.effort }),
        ...(saved.advisorModel === undefined ? {} : { advisorModel: saved.advisorModel }),
      } : {}),
  });
}
