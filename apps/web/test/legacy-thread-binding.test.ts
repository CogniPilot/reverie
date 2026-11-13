import {
  bindInitialLaunchAdmission,
  captureLaunchProtocolAdmission,
  initialLaunchAdmitted,
} from '../src/initial-launch-admission.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { legacySubscriptionThreadKey, legacyThreadBinding } from '../src/legacy-thread-binding.js';
import { nativeThreadProfile } from '../src/utils/native-thread-profile.js';
import { Session } from '../src/session.js';
import { agentSpawn, EXIT, type AgentDeps } from '../src/cli-agent.js';

function registry(clis: Record<string, unknown>) {
  mkdirSync(dirname(registryFilePath()), { recursive: true });
  writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis }), { mode: 0o600 });
  reloadCliRegistry();
}
afterEach(() => {
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
});

it('selects declared legacy codecs independently of native launch authority', () => {
  const custom = structuredClone(getCli('opencode')!);
  custom.id = 'custom-code' as typeof custom.id;
  custom.launch.variants[0].args[0] = { lit: 'another-command' };
  registry({ 'custom-code': custom, codex: { label: 'Owner label' } });
  expect(legacyThreadBinding('custom-code')?.key).toBe('continueSession');
  expect(nativeThreadProfile('custom-code')).toBeUndefined();
  expect(legacyThreadBinding('codex')?.key).toBe('resumeSessionId');
  const session = new Session({
    mode: 'custom-code' as never,
    workingDir: '/tmp',
    openCodeConfig: { model: 'preserved', continueSession: 'ses_old' },
  });
  session.setOpenCodeThread('ses_new');
  expect(session.toState().openCodeConfig).toEqual({ model: 'preserved', continueSession: 'ses_new' });
  expect(legacySubscriptionThreadKey('gemini')).toBe('resumeSessionId');
});

it('preserves exact account-scoped runtime threads with cosmetic and explicit legacy codec changes', () => {
  registry({ opencode: { label: 'Owner title' } });
  const session = new Session({
    mode: 'opencode',
    workingDir: '/tmp',
    openCodeConfig: { continueSession: 'ses_first' },
    subscriptionProfile: { id: 'first', label: 'First', provider: 'openai' },
  });
  const launch = structuredClone(getCli('opencode')!.launch);
  launch.variants[0].args[0] = { lit: 'owner-command' };
  registry({ opencode: { launch } });
  expect(nativeThreadProfile('opencode')).toBeUndefined();
  session.setOpenCodeThread('ses_owner');
  session.configureRuntime({
    mode: 'codex',
    sourceKey: 'subscription:second',
    selection: { id: 'second', label: 'Second', provider: 'openai' },
    env: {},
  });
  expect(session.toState().codexConfig?.resumeSessionId).toBeUndefined();
  session.configureRuntime({
    mode: 'opencode',
    sourceKey: 'subscription:first',
    selection: { id: 'first', label: 'First', provider: 'openai' },
    env: {},
  });
  expect(session.toState().openCodeConfig?.continueSession).toBe('ses_owner');
});

it.each(['alias', 'param', 'fork'] as const)('refuses an incompatible custom forkable codec: %s', (change) => {
  const custom = structuredClone(getCli('opencode')!);
  custom.id = 'custom-code' as typeof custom.id;
  delete custom.launch.threadStateProfile;
  delete custom.capabilities.rebootRestore;
  if (change === 'alias')
    custom.launch.legacyConfigAliases = { ...custom.launch.legacyConfigAliases, resumeId: 'anotherKey' };
  if (change === 'param') custom.launch.params.resumeId = { type: 'bool' };
  if (change === 'fork')
    custom.launch.legacyConfigAliases = { ...custom.launch.legacyConfigAliases, forkSession: 'anotherFork' };
  registry({ 'custom-code': custom });
  expect(getCli('custom-code')).toBeDefined();
  expect(legacyThreadBinding('custom-code')).toBeUndefined();
  const session = new Session({ mode: 'custom-code' as never, workingDir: '/tmp' });
  expect(() => session.setOpenCodeThread('ses_other')).toThrow('OpenCode-compatible');
});

it.each(['compatible', 'resume-alias', 'effort-alias', 'bypass-alias', 'narrow-effort', 'narrow-resume'] as const)(
  'validates actual headless CLI legacy launch parameters before HTTP: %s',
  async (change) => {
    const custom = structuredClone(getCli('codex')!);
    custom.id = 'custom-codex' as typeof custom.id;
    delete custom.launch.threadStateProfile;
    delete custom.capabilities.rebootRestore;
    if (change === 'resume-alias')
      custom.launch.legacyConfigAliases = { ...custom.launch.legacyConfigAliases, resumeId: 'otherResume' };
    if (change === 'effort-alias')
      custom.launch.legacyConfigAliases = { ...custom.launch.legacyConfigAliases, reasoningEffort: 'otherEffort' };
    if (change === 'bypass-alias')
      custom.launch.legacyConfigAliases = { ...custom.launch.legacyConfigAliases, bypassApprovals: 'otherBypass' };
    if (change === 'narrow-resume') custom.launch.params.resumeId = { type: 'token', pattern: 'uuid' };
    if (change === 'narrow-effort') custom.launch.params.reasoningEffort = { type: 'enum', values: ['low'] };
    registry({ 'custom-codex': custom });
    expect(getCli('custom-codex')).toBeDefined();
    const calls: unknown[] = [];
    const deps: AgentDeps = {
      ctx: { selfId: 'original-actor', apiUrl: 'http://127.0.0.1:1' },
      json: false,
      io: { out: () => {}, err: () => {} },
      request: async (_ctx, request) => {
        calls.push(request);
        return { status: 200, text: '', json: { success: true, data: { sessionId: 'new-synthetic-session' } } };
      },
    };
    const result = await agentSpawn(deps, {
      mode: 'custom-codex',
      caseName: 'owned',
      ready: false,
      timeoutMs: 1000,
      reasoningEffort: 'high',
      bypassApprovals: true,
      resumeSessionId: 'native-thread',
    });
    expect(result).toBe(change === 'compatible' ? EXIT.ok : EXIT.error);
    expect(calls).toHaveLength(change === 'compatible' ? 1 : 0);
    if (change === 'compatible')
      expect(calls[0]).toMatchObject({
        body: {
          codexConfig: { reasoningEffort: 'high', dangerouslyBypassApprovals: true, resumeSessionId: 'native-thread' },
        },
      });
  }
);

it('latches an observed launch or environment change while allowing cosmetic reloads', () => {
  const original = structuredClone(getCli('codex')!);
  const current = captureLaunchProtocolAdmission('codex');
  registry({ codex: { label: 'Cosmetic only' } });
  expect(current()).toBe(true);
  const launch = structuredClone(original.launch);
  launch.variants[0].args.push({ lit: '--changed-protocol' });
  registry({ codex: { launch } });
  expect(current()).toBe(false);
  registry({ codex: { launch: original.launch } });
  expect(current()).toBe(false);
  const next = captureLaunchProtocolAdmission('codex');
  registry({
    codex: {
      env: { ...original.env, exports: [...original.env.exports, { name: 'CODEC_GUARD_TEST', value: 'changed' }] },
    },
  });
  expect(next()).toBe(false);
  registry({ codex: {} });
  expect(next()).toBe(false);
});

it.each(['owner', 'mode'] as const)(
  'binds initial continuation once to the actual original Session %s without ABA revival',
  (field) => {
    const session = new Session({ mode: 'codex', workingDir: '/tmp', owner: 'original-owner' });
    const admitted = captureLaunchProtocolAdmission('codex');
    bindInitialLaunchAdmission(session, admitted);
    expect(initialLaunchAdmitted(session)).toBe(true);
    if (field === 'owner') session.owner = 'another-owner';
    else session.setMode('opencode');
    expect(initialLaunchAdmitted(session)).toBe(false);
    if (field === 'owner') session.owner = 'original-owner';
    else {
      expect(() => session.setMode('codex')).toThrow('Initial launch protocol changed');
      // Even an out-of-band restoration of the original bytes cannot revive the observed old intent.
      Object.assign(session, { _mode: 'codex' });
    }
    expect(initialLaunchAdmitted(session)).toBe(false);
    expect(() => bindInitialLaunchAdmission(session, () => true)).toThrow('already bound');
  }
);
