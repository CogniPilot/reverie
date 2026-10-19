import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '../src/config/instance.js';
import {
  addSubscriptionProfile,
  readSubscriptionProfiles,
  renameSubscriptionProfile,
  selectedSubscription,
  subscriptionBinding,
  subscriptionEnvironment,
  subscriptionModes,
} from '../src/subscription-profiles.js';
import { Session } from '../src/session.js';
import { planCatalogue } from '../src/plan-accounts.js';

beforeEach(async () => {
  await fs.rm(join(getDataDir(), 'subscription-profiles.json'), { force: true });
});

describe('named subscription profiles', () => {
  it('refuses to attribute OpenCode work to another Codex account', async () => {
    const p = await addSubscriptionProfile({ label: 'Mismatch', provider: 'openai' });
    await fs.mkdir(p.configDir, { recursive: true });
    await fs.mkdir(join(p.openCodeDataDir, 'opencode'), { recursive: true });
    await fs.writeFile(join(p.configDir, 'auth.json'), JSON.stringify({ tokens: { account_id: 'first' } }));
    await fs.writeFile(
      join(p.openCodeDataDir, 'opencode/auth.json'),
      JSON.stringify({ openai: { accountId: 'second' } })
    );
    await expect(selectedSubscription(p.id, 'opencode')).rejects.toThrow('different accounts');
  });
  it('keeps existing default logins and serializes concurrent additions without dropping accounts', async () => {
    await Promise.all([
      addSubscriptionProfile({ label: 'Work Claude', provider: 'anthropic' }),
      addSubscriptionProfile({ label: 'Work Codex', provider: 'openai' }),
    ]);
    const profiles = await readSubscriptionProfiles();
    expect(profiles).toHaveLength(4);
    expect(new Set(profiles.map((p) => p.configDir)).size).toBe(4);
    expect(new Set(profiles.map((p) => p.openCodeDataDir)).size).toBe(3);
    expect((await fs.stat(join(getDataDir(), 'subscription-profiles.json'))).mode & 0o777).toBe(0o600);
  });
  it('refuses to replace a corrupt profile file', async () => {
    const path = join(getDataDir(), 'subscription-profiles.json');
    await fs.writeFile(path, '{broken');
    await expect(addSubscriptionProfile({ label: 'Other', provider: 'openai' })).rejects.toThrow('invalid');
    expect(await fs.readFile(path, 'utf8')).toBe('{broken');
  });
  it('binds each native and OpenCode launch to its selected login directory', async () => {
    const first = await addSubscriptionProfile({ label: 'First', provider: 'anthropic' });
    const second = await addSubscriptionProfile({ label: 'Second', provider: 'anthropic' });
    expect(subscriptionEnvironment(first, 'claude')).toEqual({ CLAUDE_CONFIG_DIR: first.configDir });
    expect(subscriptionEnvironment(second, 'claude')).toEqual({ CLAUDE_CONFIG_DIR: second.configDir });
    const codex = await addSubscriptionProfile({ label: 'Codex', provider: 'openai' });
    const openCode = subscriptionEnvironment(codex, 'opencode');
    expect(openCode.XDG_DATA_HOME).toBe(codex.openCodeDataDir);
    expect(openCode.CODEX_HOME).toBe(codex.configDir);
    expect(openCode.OPENCODE_CONFIG_CONTENT).toContain('openai/');
    expect(() => subscriptionEnvironment(first, 'codex')).toThrow('does not support');
    await expect(selectedSubscription('removed', 'claude')).rejects.toThrow('no longer exists');
  });
  it('never binds a Claude subscription to OpenCode', async () => {
    const claude = await addSubscriptionProfile({ label: 'Claude', provider: 'anthropic' });
    expect(subscriptionBinding('opencode', 'anthropic')).toBeNull();
    expect(subscriptionBinding('claude', 'anthropic')).toBe('native');
    expect(subscriptionBinding('opencode', 'openai')).toBe('opencode');
    expect(subscriptionModes('anthropic')).not.toContain('opencode');
    expect(() => subscriptionEnvironment(claude, 'opencode')).toThrow('does not support');
    await expect(selectedSubscription(claude.id, 'opencode')).rejects.toThrow('does not support');
    const session = new Session({
      workingDir: getDataDir(),
      mode: 'opencode',
      subscriptionProfile: { id: claude.id, label: claude.label, provider: 'anthropic' },
    });
    expect(session.getEnvOverridesForPersist()).toBeUndefined();
  });
  it('preserves login directories and labels across session restoration without persisting tokens or config blobs', () => {
    const selection = { id: 'work', label: 'Work', provider: 'openai' as const };
    const session = new Session({
      workingDir: getDataDir(),
      mode: 'opencode',
      subscriptionProfile: selection,
      envOverrides: {
        CODEX_HOME: '/accounts/work',
        XDG_DATA_HOME: '/accounts/work/oc',
        OPENCODE_CONFIG_CONTENT: '{"apiKey":"SECRET"}',
        CODEX_API_KEY: 'SECRET',
      },
    });
    const env = session.getEnvOverridesForPersist();
    expect(env).toEqual({ CODEX_HOME: '/accounts/work', XDG_DATA_HOME: '/accounts/work/oc' });
    expect(JSON.stringify(session.toState())).not.toContain('SECRET');
    expect(session.toState().subscriptionProfile).toEqual(selection);
    const restored = new Session({
      workingDir: getDataDir(),
      mode: 'opencode',
      subscriptionProfile: selection,
      envOverrides: env,
    });
    expect(restored.getEnvOverridesForPersist()).toEqual(env);
    expect(restored.subscriptionProfile).toEqual(selection);
  });
  it('also persists legacy per-session CODEX_HOME without collecting CODEX_* secrets', () => {
    const session = new Session({
      workingDir: getDataDir(),
      mode: 'codex',
      envOverrides: { CODEX_HOME: '/accounts/legacy', CODEX_API_KEY: 'SECRET' },
    });
    expect(session.getEnvOverridesForPersist()).toEqual({ CODEX_HOME: '/accounts/legacy' });
  });
  it('renames by id, changes only the label, and materializes the defaults on first use', async () => {
    const renamed = await renameSubscriptionProfile('openai-default', 'Codex user@example.com');
    expect(renamed?.profile.label).toBe('Codex user@example.com');
    expect(renamed?.from).toBe('Default Codex');
    const profiles = await readSubscriptionProfiles();
    expect(profiles.map((p) => p.id)).toEqual(['anthropic-default', 'openai-default']);
    expect(profiles[0].label).toBe('Default Claude');
    expect(profiles[1]).toEqual({ ...renamed?.profile });
    expect((await fs.stat(join(getDataDir(), 'subscription-profiles.json'))).mode & 0o777).toBe(0o600);
    expect(await renameSubscriptionProfile('missing', 'Nope')).toBeNull();
  });
  it('refuses to rename inside a corrupt profile file', async () => {
    const path = join(getDataDir(), 'subscription-profiles.json');
    await fs.writeFile(path, '{broken');
    await expect(renameSubscriptionProfile('openai-default', 'Codex user@example.com')).rejects.toThrow('invalid');
    expect(await fs.readFile(path, 'utf8')).toBe('{broken');
  });
});

describe('plan labels after a rename', () => {
  it('a rename beats the acct-alias label swap: the owner label wins over the acct directory name', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'plan-alias-'));
    const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    process.env.CODEX_HOME = join(home, '.codex');
    try {
      await fs.mkdir(join(home, '.claude'));
      await fs.mkdir(join(home, '.claude-accounts'));
      await fs.symlink(join(home, '.claude'), join(home, '.claude-accounts', 'secondary'));
      const label = async () => (await planCatalogue(home)).find((a) => a.profileId === 'anthropic-default');
      // Still the built-in label: the acct directory name is shown, as before.
      expect(await label()).toMatchObject({ label: 'secondary', acctName: 'secondary', isDefault: true });
      await renameSubscriptionProfile('anthropic-default', 'Claude Work');
      expect(await label()).toMatchObject({ label: 'Claude Work', acctName: 'secondary', isDefault: true });
    } finally {
      if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.claude;
      if (saved.codex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codex;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
