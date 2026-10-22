import type { PlanAccount } from './plan-accounts.js';
import { launchFor } from './plan-accounts.js';
import type { SessionState } from './types.js';
import { PlanMoveError, type PlanMoveInput } from './plan-move.js';
import { CreateSessionSchema } from './web/schemas.js';

export function planMoveLaunch(saved: SessionState, account: PlanAccount, input: PlanMoveInput) {
  if (saved.id !== input.sessionId) throw new PlanMoveError('The source session changed');
  if (saved.remote || saved.docker || saved.customModel)
    throw new PlanMoveError('Remote, container and custom-model sessions cannot move plans in this version');
  if (saved.mode === 'opencode')
    throw new PlanMoveError('OpenCode thread moves require a launch-then-stop adapter and are not supported yet');
  if (saved.mode !== 'claude' && saved.mode !== 'codex')
    throw new PlanMoveError('Custom harnesses and other session types cannot move plans in this version');
  const provider = saved.mode === 'codex' ? 'openai' : 'anthropic';
  if (account.provider !== provider) throw new PlanMoveError('Choose a plan for the same provider');
  if (!input.handoff.trim()) throw new PlanMoveError('A fresh cross-account session requires a handoff');
  const launch = launchFor(account);
  const config = saved.codexConfig ? { ...saved.codexConfig } : {};
  delete config.resumeSessionId;
  return CreateSessionSchema.parse({
    employeeId: input.employeeId,
    name: saved.name,
    workingDir: saved.workingDir,
    mode: saved.mode,
    ...(launch.subscriptionProfileId
      ? { subscriptionProfileId: launch.subscriptionProfileId }
      : { envOverrides: launch.envOverrides }),
    ...(saved.mode === 'codex'
      ? { codexConfig: { ...config, ...(input.model ? { model: input.model } : {}) } }
      : { model: input.model ?? saved.model, effort: saved.effort, advisorModel: saved.advisorModel }),
  });
}
