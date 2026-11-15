/** Pure target recipe composition. It neither selects account files nor admits
 * a native/source operation. The actor supplies its captured actual inputs. */
import type { PlanAccount } from './plan-accounts.js';
import type { PlanMoveInput } from './plan-move.js';
import { PlanMoveError } from './plan-move.js';
import { planMoveAccountRecipe, planMoveHarness } from './plan-move-launch.js';
import type { RuntimeRefreshPolicy } from './account-replacement-policy.js';
import { expertRuntimeRecipeData } from './expert-runtime-recipe.js';
import { dockerProviderRuntimeRecipeDigest } from './docker-employee-source-correlation.js';
import type { SessionState } from './types.js';
import { nativeThreadProfile } from './utils/native-thread-profile.js';
export function dockerPlanMoveTargetRecipe(
  source: SessionState,
  account: PlanAccount,
  input: Readonly<PlanMoveInput>,
  target: { sessionId: string; owner: string | undefined; at: number },
  policy: RuntimeRefreshPolicy,
  context: { kind: 'template' } | { kind: 'resolved'; nativeId: string | null }
) {
  const payload = planMoveAccountRecipe(source, account, input, policy),
    mode = planMoveHarness(account),
    workingDir = source.workingDir,
    same = source.mode === mode;
  if (payload.mode !== mode || payload.workingDir !== workingDir)
    throw new PlanMoveError('The selected target renderer changed', 409);
  let nativeId: string | undefined;
  if (context.kind === 'resolved') {
    if (same && !context.nativeId) throw new PlanMoveError('The closed source conversation is unconfirmed', 409);
    if (!same && context.nativeId !== null)
      throw new PlanMoveError('A different provider cannot inherit a native identifier', 409);
    nativeId = context.nativeId ?? undefined;
  } else if (same) nativeId = nativeThreadProfile(source.mode)?.read(source);
  const profile = payload.subscriptionProfileId
    ? { id: account.profile.id, label: account.profile.label, provider: account.provider }
    : undefined;
  const saved: SessionState = {
    id: target.sessionId,
    pid: null,
    status: 'stopped',
    currentTaskId: null,
    createdAt: target.at,
    lastActivityAt: target.at,
    workingDir: workingDir,
    owner: target.owner,
    name: payload.name,
    mode: mode,
    model: payload.model,
    effort: payload.effort,
    advisorModel: payload.advisorModel,
    codexConfig: payload.codexConfig,
    subscriptionProfile: profile,
  };
  if (nativeId) {
    if (mode === 'claude') saved.resumeSessionId = nativeId;
    else if (mode === 'codex') saved.codexConfig = { ...saved.codexConfig, resumeSessionId: nativeId };
  }
  if (mode === 'claude') {
    saved.claudeMode = policy.claudeMode;
    saved.allowedTools = policy.allowedTools;
  }
  const privateState = Object.assign(saved, { __envOverrides: payload.envOverrides });
  const recipe = expertRuntimeRecipeData(privateState, {
    mode: mode,
    workingDir: workingDir,
    subscriptionProfile: profile,
  });
  return Object.freeze({ saved: privateState, recipe, templateDigest: dockerProviderRuntimeRecipeDigest(recipe) });
}
