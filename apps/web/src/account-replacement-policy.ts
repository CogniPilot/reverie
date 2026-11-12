/** Pure account-replacement codecs. These describe a protocol; they grant no runtime authority. */
import type { ClaudeMode, CodexConfig, NiceConfig, SessionState } from './types.js';
import type { RuntimeRecipe } from './expert-runtime-recipe.js';
import type { AccountReplacementProfileName } from './config/cli-registry/profiles.js';

export interface RuntimeRefreshPolicy {
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  niceConfig?: NiceConfig;
  envOverrides?: Record<string, string>;
}
type NormalizeConfig = (config: CodexConfig | undefined) => CodexConfig;
type LaunchConfig = Pick<SessionState, 'codexConfig' | 'model' | 'effort' | 'advisorModel'>;
export interface AccountReplacementProfile {
  readonly name: AccountReplacementProfileName;
  readonly harness: 'claude' | 'codex';
  readonly provider: 'anthropic' | 'openai';
  model(saved: SessionState): string | undefined;
  selectedPolicy(
    saved: SessionState,
    policy: RuntimeRefreshPolicy,
    normalize: NormalizeConfig
  ): Record<string, unknown>;
  launchConfig(saved: SessionState, model: string | undefined, sameHarness: boolean): LaunchConfig;
  freshState<T extends SessionState>(saved: T): T;
  freshRecipe<T extends RuntimeRecipe>(recipe: T): T;
  composerReadyFallback(text: string, strictComposer: (screen: string) => boolean): boolean;
}
function freshState<T extends SessionState>(saved: T): T {
  const next = structuredClone(saved);
  delete next.resumeSessionId;
  delete next.runtimeThreads;
  delete next.claudeSessionChain;
  delete next.claudeSessionIdPending;
  return next;
}
function freshRecipe<T extends RuntimeRecipe>(recipe: T): T {
  return { ...structuredClone(recipe), runtimeThreads: {} };
}
export const ACCOUNT_REPLACEMENT_PROFILES: Readonly<
  Record<AccountReplacementProfileName, Readonly<AccountReplacementProfile>>
> = Object.freeze({
  'anthropic-account-v1': Object.freeze({
    name: 'anthropic-account-v1',
    harness: 'claude',
    provider: 'anthropic',
    model: (saved: SessionState) => saved.model,
    selectedPolicy: (saved: SessionState, policy: RuntimeRefreshPolicy) => ({
      model: saved.model,
      effort: saved.effort,
      advisorModel: saved.advisorModel,
      claudeMode: policy.claudeMode,
      allowedTools: policy.allowedTools,
    }),
    launchConfig: (saved: SessionState, model: string | undefined, same: boolean) =>
      same
        ? {
            ...((model ?? saved.model) === undefined ? {} : { model: model ?? saved.model }),
            ...(saved.effort === undefined ? {} : { effort: saved.effort }),
            ...(saved.advisorModel === undefined ? {} : { advisorModel: saved.advisorModel }),
          }
        : {},
    freshState,
    freshRecipe,
    composerReadyFallback: (text: string, strictComposer: (screen: string) => boolean) => strictComposer(text),
  }),
  'openai-account-v1': Object.freeze({
    name: 'openai-account-v1',
    harness: 'codex',
    provider: 'openai',
    model: (saved: SessionState) => saved.codexConfig?.model,
    selectedPolicy: (saved: SessionState, _policy: RuntimeRefreshPolicy, normalize: NormalizeConfig) => {
      const config = normalize(structuredClone(saved.codexConfig));
      delete config.resumeSessionId;
      return { codexConfig: config };
    },
    launchConfig: (saved: SessionState, model: string | undefined, same: boolean) => {
      const config = same && saved.codexConfig ? { ...saved.codexConfig } : {};
      delete config.resumeSessionId;
      return { codexConfig: { ...config, ...(same && model ? { model } : {}) } };
    },
    freshState: <T extends SessionState>(saved: T): T => {
      const next = freshState(saved);
      if (next.codexConfig) delete next.codexConfig.resumeSessionId;
      return next;
    },
    freshRecipe: <T extends RuntimeRecipe>(recipe: T): T => {
      const next = freshRecipe(recipe);
      if (next.configs.codexConfig) delete next.configs.codexConfig.resumeSessionId;
      return next;
    },
    composerReadyFallback: () => false,
  }),
});
