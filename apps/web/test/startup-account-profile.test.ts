import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import {
  startupAccountProfile,
  startupAccountProfileForEntry,
  stockFullAccessDefaults,
} from '../src/utils/startup-account-profile.js';
import { fullAccessConfigDefaults } from '../src/cli-startup-policy.js';
import { withFullAccessDefault, fullAccessFlags } from '../src/full-access-default.js';
import { managedCodexTrust } from '../src/managed-codex-trust.js';
import { prepareSelectedClaudeProfile } from '../src/selected-claude-profile.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import * as users from '../src/user-store.js';
import * as subscriptions from '../src/subscription-profiles.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'startup-account-'));
  vi.stubEnv('REVERIE_CONTAINER', '1');
  vi.spyOn(users, 'canUsernameRunPrivilegedCommands').mockResolvedValue(true);
});
afterEach(async () => {
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
function registry(clis: Record<string, unknown>) {
  const path = registryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, clis }), { mode: 0o600 });
  reloadCliRegistry();
}
it('owns independent frozen selected-account and workspace trust codecs without granting runtime authority', () => {
  const account = startupAccountProfile('claude')!,
    trust = startupAccountProfile('codex')!;
  expect(account.name).toBe('anthropic-local-account-v1');
  expect(trust.name).toBe('openai-local-account-v1');
  expect(Object.isFrozen(account)).toBe(true);
  expect(Object.isFrozen(account.selectedAccount)).toBe(true);
  expect(account.workspaceTrustArgument).toBeUndefined();
  expect(trust.selectedAccount).toBeUndefined();
  const original = {
    theme: 'light',
    hasCompletedOnboarding: false,
    unknown: { keep: true },
    projects: { '/workspace': { hasTrustDialogAccepted: false } },
  };
  const settings = { skipDangerousModePermissionPrompt: false };
  const next = account.selectedAccount!.prepare(original, settings, '/workspace', 'dangerously-skip-permissions');
  expect(next.config).toEqual({
    ...original,
    projects: {
      '/workspace': {
        hasTrustDialogAccepted: false,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 1,
      },
    },
  });
  expect(next.settings).toEqual(settings);
  expect(original.projects['/workspace']).toEqual({ hasTrustDialogAccepted: false });
  expect(account.bypassFlags!('normal')).toEqual([]);
  expect(account.bypassFlags!('dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions']);
  expect(trust.workspaceTrustArgument!('/workspace/a.b')).toBe(
    '\'projects={"/workspace/a.b"={trust_level="trusted"}}\''
  );
});
it.each(['claude', 'codex'] as const)(
  'denies a copied/forged-stock %s custom codec before filesystem and owner effects',
  async (mode) => {
    const clone = structuredClone(getCli(mode)!);
    clone.id = 'custom-agent' as typeof clone.id;
    clone.stock = true;
    registry({ 'custom-agent': clone });
    expect(getCli('custom-agent')!.stock).toBe(false);
    expect(startupAccountProfile('custom-agent')).toBeUndefined();
    expect(startupAccountProfileForEntry({ ...clone, stock: true })).toBeUndefined();
    const reads = vi
      .spyOn(subscriptions, 'readSubscriptionProfiles')
      .mockRejectedValue(new Error('must not inspect accounts'));
    await prepareSelectedClaudeProfile({
      mode: 'custom-agent',
      selection: { id: 'fixture', label: 'Synthetic', provider: 'anthropic' },
      configDir: directory,
      workingDir: directory,
      claudeMode: 'normal',
    });
    expect(
      await managedCodexTrust({ mode: 'custom-agent', fullAccess: true, workingDir: '/missing-fixture' })
    ).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    expect(users.canUsernameRunPrivilegedCommands).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  }
);
it.each(['claude', 'codex'] as const)(
  'denies %s stock profile substitution and changed launch/environment protocols',
  (mode) => {
    const original = structuredClone(getCli(mode)!);
    registry({
      [mode]: {
        capabilities: {
          startupAccountProfile: mode === 'claude' ? 'openai-local-account-v1' : 'anthropic-local-account-v1',
        },
      },
    });
    expect(startupAccountProfile(mode)).toBeUndefined();
    registry({ [mode]: { env: { exports: [] } } });
    expect(startupAccountProfile(mode)).toBeUndefined();
    const launch = structuredClone(original.launch);
    launch.variants[0].args[0] = { lit: 'different-agent' };
    registry({ [mode]: { launch } });
    expect(startupAccountProfile(mode)).toBeUndefined();
  }
);
it('permits cosmetic overrides but refuses direct forged builder protocol metadata before adding trust', () => {
  registry({ codex: { label: 'Owner display label' } });
  const entry = getCli('codex')!;
  expect(startupAccountProfile('codex')?.name).toBe('openai-local-account-v1');
  const options = { mode: 'codex', sessionId: 'synthetic', codexTrustWorkspace: '/workspace' };
  expect(buildSpawnCommandFromRegistry(entry, options)).toContain('trust_level');
  const wrong = {
    ...entry,
    capabilities: { ...entry.capabilities, startupAccountProfile: 'anthropic-local-account-v1' as const },
  };
  expect(startupAccountProfileForEntry(wrong)).toBeUndefined();
  expect(buildSpawnCommandFromRegistry(wrong, options)).not.toContain('trust_level');
  const changed = structuredClone(entry);
  changed.launch.variants[0].args[0] = { lit: 'different-agent' };
  expect(startupAccountProfileForEntry(changed)).toBeUndefined();
  expect(buildSpawnCommandFromRegistry(changed, options)).not.toContain('trust_level');
  expect(fullAccessFlags('codex')).toContain('--dangerously-bypass-approvals-and-sandbox');
});
it('keeps copied custom generic privileged parameters supported without selecting stock account code', async () => {
  const clone = structuredClone(getCli('codex')!);
  clone.id = 'custom-agent' as typeof clone.id;
  registry({ 'custom-agent': clone });
  expect(startupAccountProfile('custom-agent')).toBeUndefined();
  expect(await withFullAccessDefault('custom-agent', undefined, undefined)).toEqual({
    dangerouslyBypassApprovals: true,
  });
});
it('uses exact shipped declarative defaults, preserving explicit config and embedded owner permission', async () => {
  const policy = stockFullAccessDefaults('opencode')!;
  expect(fullAccessConfigDefaults(policy, undefined)).toEqual({ autoAllowTools: true });
  for (const config of [
    { autoAllowTools: false },
    { configContent: '{"permission":false}' },
    { configContent: '{"permission":{"bash":"ask"}}' },
  ])
    expect(fullAccessConfigDefaults(policy, config)).toEqual({});
  expect(fullAccessConfigDefaults(stockFullAccessDefaults('deepseek'), undefined)).toEqual({
    permissionMode: 'danger-full-access',
  });
  const clone = structuredClone(getCli('opencode')!);
  clone.id = 'custom-agent' as typeof clone.id;
  registry({ 'custom-agent': clone });
  expect(stockFullAccessDefaults('custom-agent')).toBeUndefined();
  expect(await withFullAccessDefault('custom-agent', undefined, undefined)).toBeUndefined();
  registry({ opencode: { capabilities: { fullAccessDefaults: { values: { autoAllowTools: false } } } } });
  expect(stockFullAccessDefaults('opencode')).toBeUndefined();
  expect(await withFullAccessDefault('opencode', undefined, undefined)).toBeUndefined();
});
it('validates closed profile names, bounded default data and config-target semantics at registry load', () => {
  const original = structuredClone(getCli('codex')!);
  for (const policy of [
    { values: {} },
    { values: { constructor: true } },
    { values: { autoAllowTools: 'x'.repeat(121) } },
    { values: { autoAllowTools: true }, unexpected: true },
  ]) {
    const candidate = structuredClone(original);
    Object.assign(candidate.capabilities, { fullAccessDefaults: policy });
    expect(CliEntrySchema.safeParse(candidate).success).toBe(false);
  }
  const unknown = structuredClone(original);
  Object.assign(unknown.capabilities, { startupAccountProfile: 'unimplemented-protocol' });
  expect(CliEntrySchema.safeParse(unknown).success).toBe(false);
  const global = structuredClone(getCli('claude')!);
  Object.assign(global.capabilities, { fullAccessDefaults: { values: { autoAllowTools: true } } });
  expect(CliEntrySchema.safeParse(global).success).toBe(false);
});
