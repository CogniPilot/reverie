import { describe, expect, it } from 'vitest';
import { dockerPlanMaterial, dockerPlanPayload, dockerPlanAuthDigest } from '../src/docker-plan-material.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { Session } from '../src/session.js';
import { expertRuntimeRecipe, expertRuntimeRecipeData } from '../src/expert-runtime-recipe.js';
import { dockerPlanMoveTargetRecipe } from '../src/docker-plan-move-recipe.js';
import { planMoveLaunch } from '../src/plan-move-launch.js';
import type { PlanAccount } from '../src/plan-accounts.js';
import type { PlanMoveInput } from '../src/plan-move.js';
import type { SessionDocker, SessionState } from '../src/types.js';
const sourceId = '10000000-0000-4000-8000-000000000001',
  targetId = '20000000-0000-4000-8000-000000000002',
  native = '30000000-0000-4000-8000-000000000003';
function docker(plan = false): SessionDocker {
  return {
    hostId: 'boxed-runtime',
    label: 'fixture',
    engine: 'docker',
    image: 'sha256:' + 'a'.repeat(64),
    containerName: 'b'.repeat(64),
    hostWorkspacePath: '/',
    containerWorkdir: '/workspace',
    network: 'none',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      operationId: '40000000-0000-4000-8000-000000000004',
      employeeId: '50000000-0000-4000-8000-000000000005',
      sessionGeneration: 2,
      clientManifestDigest: 'c'.repeat(64),
      apiUrl: 'http://reverie:3000',
      ...(plan ? { planReplacement: { provider: 'anthropic' as const, projectionDigest: 'd'.repeat(64) } } : {}),
    },
  };
}
const account: PlanAccount = {
  id: 'account-b',
  label: 'B',
  provider: 'anthropic',
  configDir: '/control/b',
  realDir: '/control/b',
  profileId: 'account-b',
  isDefault: false,
  profile: {
    id: 'account-b',
    label: 'B',
    provider: 'anthropic',
    configDir: '/control/b',
    openCodeDataDir: '/control/data',
  },
};
const input: PlanMoveInput = {
  id: 'move-b',
  employeeId: '50000000-0000-4000-8000-000000000005',
  sessionId: sourceId,
  fromAccount: 'account-a',
  toAccount: 'account-b',
  forceBusy: false,
  handoff: 'Continue the original work.',
};
const source: SessionState = {
  id: sourceId,
  pid: null,
  status: 'stopped',
  currentTaskId: null,
  createdAt: 1,
  lastActivityAt: 1,
  workingDir: '/workspace',
  mode: 'claude',
  name: 'Synthetic',
  model: 'sonnet',
  effort: 'high',
  docker: docker(),
};
describe('immutable Docker target recipe DATA', () => {
  it('keeps generic Docker launch refusal while the shared pure renderer preserves selected account/model and resolved history', () => {
    expect(() => planMoveLaunch(source, account, input)).toThrow('cannot move plans');
    const result = dockerPlanMoveTargetRecipe(
      source,
      account,
      input,
      { sessionId: targetId, owner: undefined, at: 2 },
      { claudeMode: 'normal', allowedTools: 'Read,Edit' },
      { kind: 'resolved', nativeId: native }
    );
    expect(result.saved).toMatchObject({
      id: targetId,
      resumeSessionId: native,
      model: 'sonnet',
      effort: 'high',
      claudeMode: 'normal',
      allowedTools: 'Read,Edit',
      subscriptionProfile: { id: 'account-b' },
    });
    expect(result.saved).not.toHaveProperty('docker');
    expect(result.saved).not.toHaveProperty('remote');
    expect(result.recipe).toEqual(
      expertRuntimeRecipeData(result.saved, {
        mode: 'claude',
        workingDir: '/workspace',
        subscriptionProfile: { id: 'account-b', label: 'B', provider: 'anthropic' },
      })
    );
  });
  it('compares native-independent template only, while retaining exact resolved native ID in the launch data', () => {
    const a = dockerPlanMoveTargetRecipe(
        source,
        account,
        input,
        { sessionId: targetId, owner: undefined, at: 2 },
        {},
        { kind: 'template' }
      ),
      b = dockerPlanMoveTargetRecipe(
        source,
        account,
        input,
        { sessionId: targetId, owner: undefined, at: 3 },
        {},
        { kind: 'resolved', nativeId: native }
      );
    expect(a.templateDigest).toBe(b.templateDigest);
    expect(b.saved.resumeSessionId).toBe(native);
    expect(() =>
      dockerPlanMoveTargetRecipe(
        source,
        account,
        input,
        { sessionId: targetId, owner: undefined, at: 2 },
        {},
        { kind: 'resolved', nativeId: null }
      )
    ).toThrow();
  });
  it('uses fresh provider-native configuration for a different provider instead of carrying Claude selectors', () => {
    const codex: PlanAccount = { ...account, provider: 'openai', profile: { ...account.profile, provider: 'openai' } };
    const result = dockerPlanMoveTargetRecipe(
      source,
      codex,
      { ...input, targetMode: 'codex' },
      { sessionId: targetId, owner: undefined, at: 2 },
      {},
      { kind: 'resolved', nativeId: null }
    );
    expect(result.saved.mode).toBe('codex');
    expect(result.saved.resumeSessionId).toBeUndefined();
    expect(result.saved.model).toBeUndefined();
    expect(() =>
      dockerPlanMoveTargetRecipe(
        source,
        codex,
        input,
        { sessionId: targetId, owner: undefined, at: 2 },
        {},
        { kind: 'resolved', nativeId: native }
      )
    ).toThrow();
  });
});
describe('managed generation permission persistence', () => {
  it.each(['normal', 'allowedTools'] as const)(
    'persists explicit %s policy only on v3 target and preserves public/legacy serialization',
    (mode) => {
      const config = {
        id: targetId,
        workingDir: '/workspace',
        mode: 'claude' as const,
        claudeMode: mode,
        allowedTools: 'Read,Edit',
      };
      const legacy = new Session({ ...config, docker: docker(false) }),
        managed = new Session({ ...config, docker: docker(true) });
      expect(legacy.toPersistedState()).not.toHaveProperty('claudeMode');
      expect(legacy.toPersistedState()).not.toHaveProperty('allowedTools');
      expect(managed.toState()).not.toHaveProperty('claudeMode');
      expect(managed.toPersistedState()).toMatchObject({ claudeMode: mode, allowedTools: 'Read,Edit' });
      const restored = new Session({ ...managed.toPersistedState(), docker: docker(true) });
      expect(restored.providerRecipeState()).toMatchObject({ claudeMode: mode, allowedTools: 'Read,Edit' });
    }
  );
  it('keeps pure shared recipe output identical to the actual Session producer', () => {
    const s = new Session({
      id: sourceId,
      workingDir: '/workspace',
      mode: 'codex',
      codexConfig: { model: 'gpt-5', reasoningEffort: 'high' },
      subscriptionProfile: { id: 'account-b', label: 'B', provider: 'openai' },
    });
    expect(expertRuntimeRecipe(s)).toEqual(
      expertRuntimeRecipeData(s.toState(), {
        mode: s.mode,
        workingDir: s.workingDir,
        subscriptionProfile: s.subscriptionProfile,
      })
    );
  });
});

describe('fixed native material and wire input', () => {
  it('encodes the exact Rust struct field order, explicit null context and material-only projection', () => {
    const context = { source: { kind: 'none' as const }, roles: [], conversation: null },
      selected = {
        operationId: sourceId,
        sessionId: targetId,
        provider: 'anthropic' as const,
        accountId: 'account-b',
        context,
      },
      auth = '{"synthetic":"B"}',
      token = 'synthetic.' + 'a'.repeat(64),
      material = dockerPlanMaterial(selected, dockerPlanAuthDigest(auth));
    const payload = dockerPlanPayload(selected, 'b'.repeat(64), auth, token);
    expect(Object.keys(JSON.parse(payload))).toEqual([
      'version',
      'purpose',
      'operationId',
      'sessionId',
      'containerId',
      'provider',
      'accountId',
      'auth',
      'identity',
      'context',
    ]);
    expect(JSON.parse(payload).context).toEqual(context);
    expect(material.projectionDigest).toBe(dockerContinuationDigest(material.material));
    expect(material.contextInputDigest).toBe(dockerContinuationDigest(context));
    const other = JSON.parse(dockerPlanPayload(selected, 'c'.repeat(64), auth, 'replacement.' + 'd'.repeat(64)));
    expect(other.containerId).not.toBe(JSON.parse(payload).containerId);
    expect(material.material).not.toHaveProperty('identity');
    expect(material.material).not.toHaveProperty('containerId');
  });
  it('rejects a provider-mismatched or escaping context and malformed bound token before native input', () => {
    const selected = {
      operationId: sourceId,
      sessionId: targetId,
      provider: 'anthropic' as const,
      accountId: 'account-b',
      context: {
        source: { kind: 'home' as const, relative: ['..'], dev: '1', ino: '2' },
        roles: ['claude-projects' as const],
        conversation: null,
      },
    };
    expect(() => dockerPlanMaterial(selected, 'a'.repeat(64))).toThrow();
    expect(() =>
      dockerPlanPayload(
        { ...selected, context: { source: { kind: 'none' }, roles: [], conversation: null } },
        'b'.repeat(64),
        '{}',
        'invalid-token'
      )
    ).toThrow();
  });
});
