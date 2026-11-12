import { expect, it, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeRefreshDigest, planMoveLaunch } from '../src/plan-move-launch.js';
import type { SessionState } from '../src/types.js';
import type { PlanAccount } from '../src/plan-accounts.js';
import { accountReplacementProfile, accountReplacementForProvider } from '../src/utils/account-replacement-profile.js';
import { getCli, registryFilePath, reloadCliRegistry, loadCliRegistry } from '../src/config/cli-registry/registry.js';
import { PlanMoves, type PlanMovePort } from '../src/plan-move.js';
import type { RuntimeRecipe } from '../src/expert-runtime-recipe.js';
const source = {
  id: 'source',
  name: 'Synthetic employee',
  workingDir: '/scratch/fixture',
  mode: 'codex',
  model: 'sonnet',
  effort: 'high',
  advisorModel: 'opus',
  codexConfig: {
    model: 'code-model',
    reasoningEffort: 'high',
    resumeSessionId: 'private-old-thread',
    dangerouslyBypassApprovals: false,
  },
  subscriptionProfile: { id: 'old', label: 'Old', provider: 'openai' },
} as SessionState;
const account = {
  id: 'account',
  label: 'Synthetic plan',
  provider: 'openai',
  profileId: 'profile',
  configDir: '/scratch/account',
  realDir: '/scratch/real',
  isDefault: false,
} as PlanAccount;
afterEach(() => {
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
});
function registry(clis: Record<string, unknown>) {
  const path = registryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, clis }), { mode: 0o600 });
  reloadCliRegistry();
}
it('preserves the deterministic digest vectors recorded before profile extraction', () => {
  const vectors = [
    runtimeRefreshDigest(source, account),
    runtimeRefreshDigest({ ...source, codexConfig: {} }, account),
    runtimeRefreshDigest(
      { ...source, mode: 'claude', codexConfig: undefined },
      { ...account, provider: 'anthropic' },
      { claudeMode: 'normal', allowedTools: 'Read,Edit', envOverrides: { SAFE: 'value' } }
    ),
  ];
  expect(vectors).toEqual([
    'aa871ee7e26a8e1a1bb8192b5611bcb91f6a44e6ac8e4bf5befd523b7d178521',
    'de51a870a060c097f358829c14f56d9b1692f88aa92d8e191d892d3753361f44',
    'e6d2deed843f81bc2a46e432bf7692a2fd7c47dda9754c1a50d49ade66fa21e5',
  ]);
});

it('resolves both canonical provider protocols while unsupported providers and modes default to absent', () => {
  expect(accountReplacementForProvider('openai')).toBe(accountReplacementProfile('codex'));
  expect(accountReplacementForProvider('anthropic')).toBe(accountReplacementProfile('claude'));
  for (const mode of ['opencode', 'shell', 'unknown']) expect(accountReplacementProfile(mode)).toBeUndefined();
  expect(accountReplacementForProvider('unknown')).toBeUndefined();
  expect(Object.isFrozen(accountReplacementProfile('codex'))).toBe(true);
});

it.each(['copied', 'forged-stock', 'missing-profile'] as const)(
  'refuses a %s custom entry through actual resolved registry provenance',
  (kind) => {
    const clone = structuredClone(getCli('codex')!);
    clone.id = 'renamed-agent' as typeof clone.id;
    clone.stock = kind === 'forged-stock';
    if (kind === 'missing-profile') delete clone.capabilities.accountReplacementProfile;
    registry({ 'renamed-agent': clone });
    expect(getCli('renamed-agent')?.stock).toBe(false);
    expect(accountReplacementProfile('renamed-agent')).toBeUndefined();
    expect(() =>
      planMoveLaunch(Object.assign(structuredClone(source), { mode: 'renamed-agent' }), account, {
        id: 'move',
        employeeId: 'employee',
        sessionId: 'source',
        fromAccount: 'old',
        toAccount: 'account',
        forceBusy: false,
        handoff: 'Fresh handoff',
      })
    ).toThrow('Custom harnesses');
  }
);

it.each([
  ['claude', 'openai-account-v1'],
  ['codex', 'anthropic-account-v1'],
] as const)(
  'refuses a %s stock entry selecting another protocol without mutating native state',
  async (mode, profile) => {
    registry({ [mode]: { capabilities: { accountReplacementProfile: profile } } });
    expect(getCli(mode)?.stock).toBe(true);
    expect(accountReplacementProfile(mode)).toBeUndefined();
    const port: PlanMovePort = {
      load: async () => [],
      save: vi.fn(async () => {}),
      snapshot: async () => ({
        sessionId: 'source',
        name: 'Synthetic',
        account: 'account',
        working: false,
        mode,
        runtimeDigest: 'a'.repeat(64),
      }),
      idle: async () => {},
      create: vi.fn(async () => 'target'),
      start: vi.fn(async () => {}),
      ready: async () => {},
      beforeStop: async () => {},
      binding: () => 'source',
      exists: () => true,
      rebind: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      audit: vi.fn(async () => {}),
    };
    const moves = new PlanMoves(port);
    await expect(
      moves.begin({
        id: 'move',
        employeeId: 'employee',
        sessionId: 'source',
        fromAccount: 'account',
        toAccount: 'account',
        forceBusy: false,
        handoff: 'Fresh handoff',
        purpose: 'runtime-refresh',
        runtimeDigest: 'a'.repeat(64),
      })
    ).rejects.toThrow('unchanged current plan');
    for (const effect of [port.save, port.create, port.start, port.rebind, port.stop, port.audit])
      expect(effect).not.toHaveBeenCalled();
  }
);

it('rejects unimplemented profile names at registry load with an explicit warning', () => {
  const clone = structuredClone(getCli('codex')!);
  registry({
    'future-agent': {
      ...clone,
      id: 'future-agent',
      capabilities: { ...clone.capabilities, accountReplacementProfile: 'future-protocol' },
    },
  });
  expect(getCli('future-agent')).toBeUndefined();
  expect(loadCliRegistry().warnings.join('\n')).toContain('accountReplacementProfile');
});

it('inherits stock profiles for old overrides while keeping support separate from enabled/permission state', () => {
  registry({ codex: { enabled: false }, claude: { label: 'Local account wrapper' } });
  expect(getCli('codex')?.enabled).toBe(false);
  expect(accountReplacementProfile('codex')?.provider).toBe('openai');
  expect(accountReplacementProfile('claude')?.provider).toBe('anthropic');
});

it.each(['claude', 'codex'] as const)(
  'starts a fresh %s provider conversation while preserving configuration and source data',
  (mode) => {
    const profile = accountReplacementProfile(mode)!;
    const saved = { ...source, mode, resumeSessionId: 'old', runtimeThreads: { [mode]: 'private-thread' } };
    const recipe: RuntimeRecipe = {
      mode,
      workingDir: '/scratch/fixture',
      runtimeThreads: { [mode]: 'private-thread' },
      configs: { codexConfig: { model: 'code-model', resumeSessionId: 'old' } },
    };
    const original = structuredClone({ saved, recipe });
    const fresh = profile.freshState(saved),
      next = profile.freshRecipe(recipe);
    expect(fresh.resumeSessionId).toBeUndefined();
    expect(fresh.runtimeThreads).toBeUndefined();
    expect(next.runtimeThreads).toEqual({});
    if (profile.provider === 'openai') {
      expect(fresh.codexConfig?.resumeSessionId).toBeUndefined();
      expect(next.configs.codexConfig.resumeSessionId).toBeUndefined();
    } else {
      expect(fresh.codexConfig?.resumeSessionId).toBe('private-old-thread');
      expect(next.configs.codexConfig.resumeSessionId).toBe('old');
    }
    expect(fresh.codexConfig?.model).toBe('code-model');
    expect({ saved, recipe }).toEqual(original);
  }
);

it('preserves exact launch policy vectors across same and different providers', () => {
  const base = {
    id: 'move',
    employeeId: 'employee',
    sessionId: 'source',
    fromAccount: 'old',
    toAccount: 'account',
    forceBusy: false,
    handoff: 'Fresh handoff',
    model: 'selected-model',
  };
  const launch = planMoveLaunch(source, account, base);
  expect(launch.codexConfig).toEqual({
    model: 'selected-model',
    reasoningEffort: 'high',
    dangerouslyBypassApprovals: false,
    renderMode: 'hybrid',
  });
  const cross = planMoveLaunch(source, { ...account, provider: 'anthropic' }, base);
  expect(cross.mode).toBe('claude');
  expect(cross.model).toBeUndefined();
  expect(cross.effort).toBeUndefined();
  expect(cross.codexConfig).toBeUndefined();
});

it('retains unknown configuration in the digest without mutating the source', () => {
  const config = { ...source.codexConfig, unknownSetting: 'must-not-silently-disappear' };
  const saved = { ...source, codexConfig: config };
  expect(runtimeRefreshDigest(saved, account)).not.toBe(runtimeRefreshDigest(source, account));
  expect(config.resumeSessionId).toBe('private-old-thread');
  expect(config.unknownSetting).toBe('must-not-silently-disappear');
});
