import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionState } from '../src/types.js';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { THREAD_STATE_BINDINGS } from '../src/config/cli-registry/profiles.js';
import {
  nativeThreadProfile,
  rebootResumeTarget,
  rebootRestoreLaunchConfig,
} from '../src/utils/native-thread-profile.js';
import {
  nativeCodexThread,
  nativeOpenCodeThread,
  planRebootRestore,
  resolveResumeConversationId,
} from '../src/reboot-restore.js';

// Persisted legacy/custom records can exceed the old public SessionMode union.
const state = (extra: Omit<Partial<SessionState>, 'mode'> & { mode?: string } = {}): SessionState =>
  ({
    id: 'logical-record-id',
    mode: 'claude',
    workingDir: '/synthetic/owned',
    pid: 1234,
    status: 'busy',
    createdAt: 1,
    currentTaskId: null,
    ...extra,
  }) as SessionState;
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
it('keeps conversation chain precedence and constructor config vectors literal', () => {
  const saved = state({
    resumeSessionId: 'original-conversation',
    claudeSessionChain: ['original-conversation', 'latest-conversation'],
    codexConfig: { model: 'preserved-other-mode' },
  });
  expect(resolveResumeConversationId(saved)).toBe('latest-conversation');
  expect(rebootResumeTarget(saved)).toBe('latest-conversation');
  expect(rebootRestoreLaunchConfig(saved, 'planned-conversation')).toEqual({
    resumeSessionId: 'planned-conversation',
    codexConfig: { model: 'preserved-other-mode' },
  });
  expect(rebootResumeTarget(state({ resumeSessionId: 'resumed-conversation' }))).toBe('resumed-conversation');
  expect(rebootResumeTarget(state())).toBe('logical-record-id');
  expect(Object.isFrozen(THREAD_STATE_BINDINGS)).toBe(true);
  expect(Object.isFrozen(THREAD_STATE_BINDINGS['nested-resume-v1'])).toBe(true);
  expect(Object.isFrozen(nativeThreadProfile('codex'))).toBe(true);
});
it('preserves native nested resume precedence and never substitutes the logical record id', () => {
  const saved = state({
    mode: 'codex',
    resumeSessionId: 'legacy-native',
    codexConfig: { model: 'model', resumeSessionId: 'native-thread' },
  });
  expect(nativeCodexThread(saved)).toBe('native-thread');
  expect(rebootResumeTarget(saved)).toBe('native-thread');
  expect(rebootRestoreLaunchConfig(saved, 'forged-logical-target')).toEqual({
    resumeSessionId: undefined,
    codexConfig: { model: 'model', resumeSessionId: 'native-thread' },
  });
  expect(nativeCodexThread(state({ mode: 'codex', resumeSessionId: 'legacy-native' }))).toBe('legacy-native');
  for (const saved of [
    state({ mode: 'codex' }),
    state({ mode: 'codex', resumeSessionId: 'legacy-native', codexConfig: { resumeSessionId: '   ' } }),
  ]) {
    expect(nativeCodexThread(saved)).toBeUndefined();
    expect(rebootResumeTarget(saved)).toBe('');
    expect(rebootRestoreLaunchConfig(saved, 'logical-record-id')).toEqual({
      resumeSessionId: undefined,
      codexConfig: { ...saved.codexConfig, resumeSessionId: undefined },
    });
  }
});
it('requires a nonforking native continuation and keeps its original public config separate', () => {
  const saved = state({
    mode: 'opencode',
    resumeSessionId: 'not-an-opencode-thread',
    openCodeConfig: { model: 'local/model', continueSession: 'native-session' },
    codexConfig: { model: 'other-mode' },
  });
  expect(nativeOpenCodeThread(saved)).toBe('native-session');
  expect(nativeCodexThread(saved)).toBeUndefined();
  expect(rebootRestoreLaunchConfig(saved, 'native-session')).toEqual({
    resumeSessionId: undefined,
    codexConfig: { model: 'other-mode' },
  });
  for (const openCodeConfig of [{ continueSession: 'native-session', forkSession: true }, {}]) {
    const unsupported = state({ mode: 'opencode', resumeSessionId: 'foreign-logical-id', openCodeConfig });
    expect(nativeOpenCodeThread(unsupported)).toBeUndefined();
    expect(rebootResumeTarget(unsupported)).toBeUndefined();
    expect(() => rebootRestoreLaunchConfig(unsupported, 'foreign-logical-id')).toThrow('supported reboot');
  }
  expect(
    nativeOpenCodeThread(state({ mode: 'claude', openCodeConfig: { continueSession: 'foreign' } }))
  ).toBeUndefined();
});
it('preserves the explicit persistent agent record policy without claiming a native thread', () => {
  const saved = state({ mode: 'hands', claudeSessionChain: ['legacy-record-target'] });
  expect(getCli('hands')!.capabilities.transcript).toBe('none');
  expect(nativeThreadProfile('hands')).toBeUndefined();
  expect(rebootResumeTarget(saved)).toBe('legacy-record-target');
  expect(planRebootRestore([saved.id], { [saved.id]: saved }, () => true).restore).toHaveLength(1);
});
it('does not infer restoration from transcript or unrelated account capabilities', () => {
  registry({
    gemini: { capabilities: { transcript: 'claude-jsonl' } },
    codex: {
      capabilities: {
        startupAccountProfile: 'anthropic-local-account-v1',
        accountReplacementProfile: 'anthropic-account-v1',
        transcript: 'none',
      },
    },
  });
  expect(rebootResumeTarget(state({ mode: 'gemini' }))).toBeUndefined();
  const saved = state({ mode: 'codex', codexConfig: { resumeSessionId: 'native' } });
  expect(nativeCodexThread(saved)).toBe('native');
  expect(rebootResumeTarget(saved)).toBe('native');
});
it.each(['claude', 'codex', 'opencode', 'hands'] as const)(
  'denies a copied %s custom/forged stock protocol before workspace or construction effects',
  (mode) => {
    const clone = structuredClone(getCli(mode)!);
    clone.id = 'custom-agent' as typeof clone.id;
    clone.stock = true;
    registry({ 'custom-agent': clone });
    const saved = state({
        mode: 'custom-agent',
        codexConfig: { resumeSessionId: 'native' },
        openCodeConfig: { continueSession: 'native' },
      }),
      exists = vi.fn(() => true);
    expect(getCli('custom-agent')!.stock).toBe(false);
    expect(nativeThreadProfile('custom-agent')).toBeUndefined();
    expect(planRebootRestore([saved.id], { [saved.id]: saved }, exists).skipped).toEqual([
      { sessionId: saved.id, reason: 'unsupported-mode' },
    ]);
    expect(exists).not.toHaveBeenCalled();
    expect(() => rebootRestoreLaunchConfig(saved, 'native')).toThrow('supported reboot');
  }
);
it('separates native reading from reboot permission and revalidates policy at reconstruction', () => {
  const saved = state({ mode: 'codex', codexConfig: { resumeSessionId: 'native' } });
  expect(rebootResumeTarget(saved)).toBe('native');
  registry({ codex: { capabilities: { rebootRestore: 'native-required' } } });
  expect(nativeCodexThread(saved)).toBe('native');
  expect(rebootResumeTarget(saved)).toBeUndefined();
  expect(() => rebootRestoreLaunchConfig(saved, 'native')).toThrow('supported reboot');
});
it('preserves cosmetic overrides while denying changed native launch protocols', () => {
  registry({ codex: { label: 'Display label' } });
  expect(nativeThreadProfile('codex')?.kind).toBe('nested-resume');
  const launch = structuredClone(getCli('codex')!.launch);
  launch.variants[0].args[0] = { lit: 'different-agent' };
  registry({ codex: { launch } });
  expect(nativeThreadProfile('codex')).toBeUndefined();
  expect(rebootResumeTarget(state({ mode: 'codex', codexConfig: { resumeSessionId: 'native' } }))).toBeUndefined();
});
it('rejects unimplemented, unbound and substituted thread contracts at schema load', () => {
  const original = getCli('codex')!;
  for (const change of [
    { threadStateProfile: 'unimplemented' },
    { threadStateProfile: 'forkable-continue-v1' },
    { legacyConfigAliases: { ...original.launch.legacyConfigAliases, resumeId: 'anotherField' } },
    { params: { ...original.launch.params, resumeId: { type: 'bool' } } },
  ])
    expect(CliEntrySchema.safeParse({ ...original, launch: { ...original.launch, ...change } }).success).toBe(false);
  expect(
    CliEntrySchema.safeParse({ ...original, launch: { ...original.launch, threadStateProfile: undefined } }).success
  ).toBe(false);
});
