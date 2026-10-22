import { describe, expect, it } from 'vitest';
import { planMoveLaunch } from '../src/plan-move-launch.js';
import type { PlanAccount } from '../src/plan-accounts.js';
import type { SessionState } from '../src/types.js';
import type { PlanMoveInput } from '../src/plan-move.js';

const saved = {
  id: 'old',
  name: 'Casey',
  workingDir: '/scratch/casey',
  mode: 'codex',
  codexConfig: {
    model: 'old-model',
    reasoningEffort: 'high',
    resumeSessionId: 'account-private-thread',
    dangerouslyBypassApprovals: false,
  },
  subscriptionProfile: { id: 'old-profile', label: 'Old', provider: 'openai' },
} as SessionState;
const account = {
  id: 'destination',
  label: 'Destination',
  provider: 'openai',
  profileId: 'new-profile',
  configDir: '/scratch/new-account',
  isDefault: false,
} as PlanAccount;
const input: PlanMoveInput = {
  id: 'move',
  employeeId: 'casey',
  sessionId: 'old',
  fromAccount: 'source',
  toAccount: 'destination',
  forceBusy: false,
  handoff: 'Use the handoff to resume.',
  model: 'chosen-model',
};

describe('fresh account launch selection', () => {
  it('uses the normal profile selector, preserves effort, and never resumes an account-private Codex thread', () => {
    const launch = planMoveLaunch(saved, account, input);
    expect(launch).toMatchObject({
      employeeId: 'casey',
      mode: 'codex',
      subscriptionProfileId: 'new-profile',
      codexConfig: { model: 'chosen-model', reasoningEffort: 'high', dangerouslyBypassApprovals: false },
    });
    expect(launch.codexConfig?.resumeSessionId).toBeUndefined();
    expect(launch.envOverrides).toBeUndefined();
    expect(saved.codexConfig?.resumeSessionId).toBe('account-private-thread');
    expect(JSON.stringify(launch)).not.toContain('old-profile');
    expect(JSON.stringify(launch)).not.toContain('handoff');
  });

  it('selects non-profile and default accounts without carrying over the previous login environment', () => {
    expect(planMoveLaunch(saved, { ...account, profileId: undefined }, input).envOverrides).toEqual({
      CODEX_HOME: '/scratch/new-account',
    });
    expect(planMoveLaunch(saved, { ...account, profileId: undefined, isDefault: true }, input).envOverrides).toEqual(
      {}
    );
  });

  it('preserves an actual saved model, otherwise leaves destination launch defaults alone, and requires a handoff', () => {
    expect(planMoveLaunch(saved, account, { ...input, model: undefined }).codexConfig?.model).toBe('old-model');
    expect(planMoveLaunch({ ...saved, codexConfig: undefined }, account, { ...input, model: undefined }).codexConfig?.model).toBeUndefined();
    expect(() => planMoveLaunch(saved, account, { ...input, handoff: '  ' })).toThrow('handoff');
  });

  it('moves Codex to Claude using destination defaults without carrying models, effort or account-private threads', () => {
    const launch = planMoveLaunch(saved, { ...account, provider: 'anthropic' }, { ...input, targetMode: 'claude' });
    expect(launch).toMatchObject({ employeeId: 'casey', name: 'Casey', workingDir: '/scratch/casey', mode: 'claude', subscriptionProfileId: 'new-profile' });
    expect(launch.codexConfig).toBeUndefined();
    expect(launch.model).toBeUndefined();
    expect(launch.effort).toBeUndefined();
    expect(launch.resumeSessionId).toBeUndefined();
  });

  it('moves Claude to Codex without carrying Claude model, advisor, effort or login environment', () => {
    const launch = planMoveLaunch({ ...saved, mode: 'claude', model: 'source-claude', effort: 'max', advisorModel: 'source-advisor', resumeSessionId: 'source-thread' }, account, { ...input, targetMode: 'codex' });
    expect(launch).toMatchObject({ mode: 'codex', codexConfig: {}, subscriptionProfileId: 'new-profile' });
    expect(launch.model).toBeUndefined();
    expect(launch.effort).toBeUndefined();
    expect(launch.advisorModel).toBeUndefined();
    expect(launch.resumeSessionId).toBeUndefined();
    expect(launch.envOverrides).toBeUndefined();
  });

  it('rejects a destination whose provider changed after the expert approved its harness', () => {
    expect(() => planMoveLaunch(saved, account, { ...input, targetMode: 'claude' })).toThrow('destination harness changed');
  });

  it.each(['opencode', 'shell', 'custom-loop'])('refuses unsupported %s without touching the old process', (mode) => {
    expect(() => planMoveLaunch({ ...saved, mode } as SessionState, account, input)).toThrow();
  });

  it('refuses remote, container and custom-model accounts and stale source rows', () => {
    for (const change of [{ remote: {} }, { docker: {} }, { customModel: {} }, { id: 'different' }])
      expect(() => planMoveLaunch({ ...saved, ...change } as SessionState, account, input)).toThrow();
  });

  it('keeps a Claude launch model and effort without importing the old resume selector', () => {
    const launch = planMoveLaunch(
      { ...saved, mode: 'claude', model: 'chosen-claude', effort: 'high', resumeSessionId: 'old-thread' },
      { ...account, provider: 'anthropic' },
      { ...input, model: undefined }
    );
    expect(launch).toMatchObject({ mode: 'claude', model: 'chosen-claude', effort: 'high' });
    expect(launch.resumeSessionId).toBeUndefined();
    expect(launch.codexConfig).toBeUndefined();
  });
});
