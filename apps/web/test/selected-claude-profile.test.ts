import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareSelectedClaudeProfile } from '../src/selected-claude-profile.js';
import * as profiles from '../src/subscription-profiles.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';

let dir: string;
let other: string;
const sessions: Session[] = [];
const selection = { id: 'selected', label: 'Selected Claude', provider: 'anthropic' as const };
const workspace = '/workspace/exact selected project';
const prepare = (extra = {}) => prepareSelectedClaudeProfile({ selection, mode: 'claude', configDir: dir, workingDir: workspace, claudeMode: 'normal', ...extra });
const read = async (name = '.claude.json') => JSON.parse(await fs.readFile(join(dir, name), 'utf8'));
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'selected-claude-'));
  other = await fs.mkdtemp(join(tmpdir(), 'other-claude-'));
  vi.spyOn(profiles, 'readSubscriptionProfiles').mockResolvedValue([
    { ...selection, configDir: dir, openCodeDataDir: join(dir, 'opencode') },
    { id: 'other', label: 'Other', provider: 'anthropic', configDir: other, openCodeDataDir: join(other, 'opencode') },
  ]);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(other, { recursive: true, force: true });
});

describe('selected Claude account preparation', () => {
  it('prepares only the selected profile and exact workspace, with private files and no credential access', async () => {
    const credentials = '{"private":"credential-sentinel"}';
    await fs.writeFile(join(dir, '.credentials.json'), credentials);
    const opened = vi.spyOn(fs, 'open');
    await prepare();
    expect(await read()).toEqual({ hasCompletedOnboarding: true, theme: 'dark', projects: { [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 } } });
    expect((await fs.stat(join(dir, '.claude.json'))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(join(dir, '.credentials.json'), 'utf8')).toBe(credentials);
    expect(opened.mock.calls.every(([path]) => !String(path).includes('.credentials.json'))).toBe(true);
    expect(await fs.readdir(other)).toEqual([]);
    expect(await fs.readdir(dir)).not.toContain('settings.json');
  });
  it('preserves existing preferences, unknown metadata, and explicit false choices', async () => {
    const original = { theme: 'light', hasCompletedOnboarding: false, unknown: { preserved: true }, oauthAccount: { accountUuid: 'synthetic' }, projects: { '/other': { hasTrustDialogAccepted: false }, [workspace]: { hasTrustDialogAccepted: false, hasCompletedProjectOnboarding: false, projectOnboardingSeenCount: 9, extra: 'keep' } } };
    await fs.writeFile(join(dir, '.claude.json'), JSON.stringify(original));
    await fs.writeFile(join(dir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: false, permissions: { defaultMode: 'default' }, other: 123 }));
    await prepare({ claudeMode: 'dangerously-skip-permissions' });
    expect(await read()).toEqual(original);
    expect(await read('settings.json')).toEqual({ skipDangerousModePermissionPrompt: false, permissions: { defaultMode: 'default' }, other: 123 });
  });
  it('acknowledges bypass only when the resolved launch already uses that mode', async () => {
    await fs.writeFile(join(dir, 'settings.json'), '{"other":123}');
    await prepare({ claudeMode: 'normal' });
    expect(await read('settings.json')).toEqual({ other: 123 });
    await prepare({ claudeMode: 'auto' });
    expect(await read('settings.json')).toEqual({ other: 123 });
    await prepare({ claudeMode: 'dangerously-skip-permissions' });
    expect(await read('settings.json')).toEqual({ other: 123, skipDangerousModePermissionPrompt: true });
    expect((await fs.stat(join(dir, 'settings.json'))).mode & 0o777).toBe(0o600);
  });
  it.each([
    { selection: undefined }, { selection: { ...selection, provider: 'openai' } }, { mode: 'opencode' },
    { remote: {} }, { docker: {} }, { customModel: {} }, { configDir: undefined },
  ])('leaves unrelated runtime paths untouched: %j', async extra => {
    await prepare(extra);
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it('rejects a mismatched or removed selected account before changing either profile', async () => {
    await expect(prepare({ configDir: other })).rejects.toThrow('does not match');
    await expect(prepare({ selection: { ...selection, id: 'removed' } })).rejects.toThrow('does not match');
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await fs.readdir(other)).toEqual([]);
  });
  it.each([['.claude.json', '{'], ['settings.json', '[]'], ['.claude.json', '{"projects":[]}']])('fails actionably without overwriting malformed %s', async (file, content) => {
    await fs.writeFile(join(dir, file), content);
    await expect(prepare({ claudeMode: 'dangerously-skip-permissions' })).rejects.toThrow(/malformed/);
    expect(await fs.readFile(join(dir, file), 'utf8')).toBe(content);
    expect(await fs.readdir(dir)).toEqual([file]);
  });
  it('refuses config symlinks and preserves the target', async () => {
    await fs.writeFile(join(other, 'target.json'), '{"keep":true}');
    await fs.symlink(join(other, 'target.json'), join(dir, '.claude.json'));
    await expect(prepare()).rejects.toThrow('unreadable or malformed');
    expect(await fs.readFile(join(other, 'target.json'), 'utf8')).toBe('{"keep":true}');
  });
  it('serializes concurrent launches sharing an account without losing either workspace', async () => {
    await Promise.all([prepare(), prepare({ workingDir: '/workspace/another project' })]);
    expect(Object.keys((await read()).projects)).toEqual([workspace, '/workspace/another project']);
    const stamp = (await fs.stat(join(dir, '.claude.json'))).mtimeMs;
    await prepare();
    expect((await fs.stat(join(dir, '.claude.json'))).mtimeMs).toBe(stamp);
  });
  it('prepares before real Session launch and restart without changing permission mode', async () => {
    const mux = new TmuxManager();
    const create = vi.spyOn(mux, 'createSession').mockImplementation(async () => {
      expect((await read()).hasCompletedOnboarding).toBe(true);
      return { sessionId: 'selected-session', muxName: 'reverie-selected', pid: 1234 } as never;
    });
    const session = new Session({ workingDir: dir, mode: 'claude', claudeMode: 'normal', useMux: true, mux,
      subscriptionProfile: selection, envOverrides: { CLAUDE_CONFIG_DIR: dir } });
    sessions.push(session);
    await session.startInteractive();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ claudeMode: 'normal' }));
    await fs.rm(join(dir, '.claude.json'));
    vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
    const respawn = vi.spyOn(mux, 'respawnPane').mockImplementation(async () => {
      expect((await read()).projects[dir].hasTrustDialogAccepted).toBe(true);
      return 5678;
    });
    expect(await session.restartCli()).toBe(true);
    expect(respawn).toHaveBeenCalledWith(expect.objectContaining({ claudeMode: 'normal' }));
    expect(await fs.readdir(dir)).not.toContain('settings.json');
  });
});
