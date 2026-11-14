import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EmployeeSchema, type CompanyEmployee } from '../src/company-types.js';
import type { SessionState } from '../src/types.js';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import {
  dockerEmployeeSourceDigest,
  dockerEmployeeProviderSourceDigest,
  legacyDockerProviderSourceMatches,
} from '../src/docker-employee-source-correlation.js';

function fixture(mode: 'codex' | 'claude' | 'opencode' = 'codex') {
  const employee = EmployeeSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    sessionGeneration: 3,
    name: 'Synthetic worker',
    icon: 'W',
    position: 'Engineer',
    expertise: ['synthetic verification'],
    createdAt: 1,
    runtimeRecipe: { mode, workingDir: '/synthetic/work', runtimeThreads: {}, configs: {} },
  });
  const saved = {
    id: employee.sessionId,
    mode,
    workingDir: '/synthetic/work',
    runtimeThreads: {},
    createdAt: 1,
    status: 'stopped',
    pid: null,
    currentTaskId: null,
    subscriptionProfile: { id: 'synthetic-account', label: 'Synthetic account', provider: 'openai' },
    codexConfig: { model: 'synthetic-model', reasoningEffort: 'high' },
    openCodeConfig: { model: 'synthetic/model', continueSession: 'native-one' },
    resumeSessionId: mode === 'claude' ? 'native-one' : undefined,
    claudeSessionChain: mode === 'claude' ? ['native-one'] : undefined,
  } as SessionState;
  return { employee, saved };
}
afterEach(() => {
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
});

describe('launch selection remains independent from existing-provider observation', () => {
  it.each(['codex', 'claude', 'opencode'] as const)(
    'keeps %s native progress out of the existing recipe while retaining it in launch approval',
    (mode) => {
      const { employee, saved } = fixture(mode);
      const launch = dockerEmployeeSourceDigest(employee, saved);
      const existing = dockerEmployeeProviderSourceDigest(employee, saved);
      saved.runtimeThreads = { [mode]: 'native-two' };
      employee.runtimeRecipe!.runtimeThreads = { [mode]: 'native-two' };
      if (mode === 'codex') saved.codexConfig!.resumeSessionId = 'native-two';
      if (mode === 'claude') {
        saved.resumeSessionId = 'native-two';
        saved.claudeSessionChain = ['native-one', 'native-two'];
      }
      if (mode === 'opencode') {
        saved.openCodeConfig!.continueSession = 'native-two';
        employee.threadId = 'native-two';
      }
      expect(dockerEmployeeSourceDigest(employee, saved)).not.toBe(launch);
      expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(existing);
    }
  );
  const changes: Array<[string, (employee: CompanyEmployee, saved: SessionState) => void]> = [
    [
      'owner',
      (e, s) => {
        e.owner = 'new-owner';
        s.owner = 'new-owner';
      },
    ],
    [
      'employee',
      (e) => {
        e.id = '33333333-3333-4333-8333-333333333333';
      },
    ],
    [
      'session',
      (e, s) => {
        e.sessionId = '33333333-3333-4333-8333-333333333333';
        s.id = e.sessionId;
      },
    ],
    [
      'generation',
      (e) => {
        e.sessionGeneration++;
      },
    ],
    [
      'mode',
      (e, s) => {
        e.runtimeRecipe!.mode = 'claude';
        s.mode = 'claude';
      },
    ],
    [
      'directory',
      (e, s) => {
        e.runtimeRecipe!.workingDir = '/changed';
        s.workingDir = '/changed';
      },
    ],
    [
      'saved account',
      (_e, s) => {
        s.subscriptionProfile!.id = 'new-account';
      },
    ],
    [
      'recipe account',
      (e) => {
        e.runtimeRecipe!.subscriptionProfile = { id: 'new-account', label: 'new', provider: 'openai' };
      },
    ],
    [
      'model',
      (_e, s) => {
        s.codexConfig!.model = 'changed-model';
      },
    ],
    [
      'effort',
      (_e, s) => {
        s.codexConfig!.reasoningEffort = 'low';
      },
    ],
    [
      'approval',
      (_e, s) => {
        s.codexConfig!.dangerouslyBypassApprovals = true;
      },
    ],
    [
      'environment',
      (_e, s) => {
        (s as SessionState & { __envOverrides: Record<string, string> }).__envOverrides = { CODEX_HOME: '/changed' };
      },
    ],
  ];
  it.each(changes)('refuses a %s recipe change as native-thread progress', (_name, change) => {
    const { employee, saved } = fixture();
    const original = dockerEmployeeProviderSourceDigest(employee, saved);
    change(employee, saved);
    expect(dockerEmployeeProviderSourceDigest(employee, saved)).not.toBe(original);
  });
  it('does not mutate caller-owned recipe/configuration while projecting native observations', () => {
    const f = fixture();
    const before = structuredClone(f);
    dockerEmployeeSourceDigest(f.employee, f.saved);
    dockerEmployeeProviderSourceDigest(f.employee, f.saved);
    expect(f).toEqual(before);
  });
  it('keeps unknown or overridden native protocols strict', () => {
    const path = registryFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const launch = structuredClone(getCli('codex')!.launch);
    launch.variants[0].args[0] = { lit: 'different-agent' };
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, clis: { codex: { launch } } }), { mode: 0o600 });
    reloadCliRegistry();
    const { employee, saved } = fixture();
    const original = dockerEmployeeProviderSourceDigest(employee, saved);
    saved.codexConfig!.resumeSessionId = 'new-native';
    expect(dockerEmployeeProviderSourceDigest(employee, saved)).not.toBe(original);
    expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(dockerEmployeeSourceDigest(employee, saved));
  });
  it('can reconstruct a legacy first learned native ID only when every other launch field still matches', () => {
    const { employee, saved } = fixture();
    const original = dockerEmployeeSourceDigest(employee, saved);
    saved.codexConfig!.resumeSessionId = 'first-observed-native';
    expect(legacyDockerProviderSourceMatches(employee, saved, original)).toBe(true);
    saved.codexConfig!.model = 'changed-model';
    expect(legacyDockerProviderSourceMatches(employee, saved, original)).toBe(false);
  });
  it('does not guess a legacy previous native thread after an unproven replacement', () => {
    const { employee, saved } = fixture();
    saved.codexConfig!.resumeSessionId = 'approved-native';
    const original = dockerEmployeeSourceDigest(employee, saved);
    saved.codexConfig!.resumeSessionId = 'different-native';
    expect(legacyDockerProviderSourceMatches(employee, saved, original)).toBe(false);
  });
});

it.each(['codex', 'opencode'] as const)('keeps a first native-only %s configuration block observational', (mode) => {
  const { employee, saved } = fixture(mode);
  delete saved.codexConfig;
  delete saved.openCodeConfig;
  const original = dockerEmployeeProviderSourceDigest(employee, saved);
  if (mode === 'codex') {
    saved.codexConfig = { resumeSessionId: 'first-native' };
    employee.runtimeRecipe!.configs.codexConfig = { resumeSessionId: 'first-native' };
  } else {
    saved.openCodeConfig = { continueSession: 'first-native' };
    employee.runtimeRecipe!.configs.openCodeConfig = { continueSession: 'first-native' };
  }
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(original);
});

it('does not reinterpret a legacy generic native alias as a first learned thread', () => {
  const { employee, saved } = fixture();
  saved.resumeSessionId = 'approved-native';
  const original = dockerEmployeeSourceDigest(employee, saved);
  saved.codexConfig!.resumeSessionId = 'different-native';
  expect(legacyDockerProviderSourceMatches(employee, saved, original)).toBe(false);
  const exact = dockerEmployeeSourceDigest(employee, saved);
  expect(legacyDockerProviderSourceMatches(employee, saved, exact)).toBe(true);
});

it('compares the selected stock Claude permission default without changing legacy launch approval', () => {
  const { employee, saved } = fixture('claude');
  const launch = dockerEmployeeSourceDigest(employee, saved);
  const existing = dockerEmployeeProviderSourceDigest(employee, saved);
  Object.assign(saved, { claudeMode: 'dangerously-skip-permissions' });
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(existing);
  expect(dockerEmployeeSourceDigest(employee, saved)).not.toBe(launch);
  Object.assign(saved, { claudeMode: 'normal' });
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).not.toBe(existing);
});
it('keeps actual Claude tool selections in existing-provider facts', () => {
  const { employee, saved } = fixture('claude');
  Object.assign(saved, { claudeMode: 'allowedTools' });
  Object.assign(saved, { allowedTools: 'Read' });
  const existing = dockerEmployeeProviderSourceDigest(employee, saved);
  Object.assign(saved, { allowedTools: 'Write' });
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).not.toBe(existing);
});

it('does not normalize a changed Claude launch protocol as the shipped default', () => {
  const launch = structuredClone(getCli('claude')!.launch);
  const permission = launch.params.claudeMode;
  if (permission?.type !== 'enum') throw Error('Expected stock permission parameter');
  permission.default = 'normal';
  const path = registryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, clis: { claude: { launch } } }), { mode: 0o600 });
  reloadCliRegistry();
  const { employee, saved } = fixture('claude');
  const existing = dockerEmployeeProviderSourceDigest(employee, saved);
  Object.assign(saved, { claudeMode: 'normal' });
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).not.toBe(existing);
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(dockerEmployeeSourceDigest(employee, saved));
});

it.each(['codex', 'opencode'] as const)('keeps inactive Claude flags observational for locked %s only', (mode) => {
  const { employee, saved } = fixture(mode);
  const launch = dockerEmployeeSourceDigest(employee, saved);
  const existing = dockerEmployeeProviderSourceDigest(employee, saved);
  Object.assign(saved, { claudeMode: 'allowedTools', allowedTools: 'Read' });
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(existing);
  expect(dockerEmployeeSourceDigest(employee, saved)).not.toBe(launch);
});
it('retains inactive-looking flags for an overridden non-Claude protocol', () => {
  const launch = structuredClone(getCli('codex')!.launch);
  launch.variants[0].args[0] = { lit: 'different-agent' };
  const path = registryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, clis: { codex: { launch } } }), { mode: 0o600 });
  reloadCliRegistry();
  const { employee, saved } = fixture('codex');
  const original = dockerEmployeeProviderSourceDigest(employee, saved);
  Object.assign(saved, { claudeMode: 'normal', allowedTools: 'Read' });
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).not.toBe(original);
  expect(dockerEmployeeProviderSourceDigest(employee, saved)).toBe(dockerEmployeeSourceDigest(employee, saved));
});
