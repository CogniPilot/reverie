import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { managedCodexTrust, codexTrustArgument } from '../src/managed-codex-trust.js';
import { codexHookTrustArgument, reverieCodexHookTrust } from '../src/codex-hook-trust.js';
import { Session } from '../src/session.js';
import { TmuxManager, buildSpawnCommand } from '../src/tmux-manager.js';
import * as users from '../src/user-store.js';

let dir: string;
const sessions: Session[] = [];
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'codex-workspace-trust-'));
  vi.stubEnv('REVERIE_CONTAINER', '1');
  vi.spyOn(users, 'canUsernameRunPrivilegedCommands').mockImplementation(async owner => owner !== 'ungranted');
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});
const trust = (extra = {}) => managedCodexTrust({ mode: 'codex', fullAccess: true, workingDir: dir, ...extra });

describe('managed Codex workspace trust', () => {
  it('trusts only the actual workspace of an authorized container launch without writing account files', async () => {
    expect(await trust()).toBe(await fs.realpath(dir));
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it.each([{ mode: 'claude' }, { fullAccess: false }, { fullAccess: undefined }, { owner: 'ungranted' }, { remote: {} }, { docker: {} }, { discovered: true }])('does not add trust for an ineligible runtime: %j', async extra => {
    expect(await trust(extra)).toBeUndefined();
  });
  it('leaves host launches unchanged', async () => {
    vi.stubEnv('REVERIE_CONTAINER', '0');
    expect(await trust()).toBeUndefined();
  });
  it('fails actionably for a missing workspace and rejects relative workspace paths', async () => {
    await expect(trust({ workingDir: join(dir, 'missing') })).rejects.toThrow('workspace is unavailable');
    await expect(trust({ workingDir: 'relative' })).rejects.toThrow('absolute');
  });
  it('renders one safely quoted TOML override even for spaces, quotes, dots, and shell syntax', () => {
    const cwd = '/workspace/a.b/"quoted" \'single\' $HOME `literal`';
    const argument = codexTrustArgument(cwd);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `printf '%s' ${argument}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`);
    expect(() => codexTrustArgument('relative')).toThrow('Invalid');
    expect(() => codexTrustArgument('/workspace/\n')).toThrow('Invalid');
  });
  it('passes launch-only trust through Session create and restart without persisting it or dropping Codex config', async () => {
    const mux = new TmuxManager();
    const create = vi.spyOn(mux, 'createSession');
    const session = new Session({ workingDir: dir, mode: 'codex', useMux: true, mux, codexConfig: { model: 'gpt-5.4', reasoningEffort: 'high' } });
    sessions.push(session);
    await session.startInteractive();
    const cwd = await fs.realpath(dir);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ codexTrustWorkspace: cwd, codexConfig: { model: 'gpt-5.4', reasoningEffort: 'high', dangerouslyBypassApprovals: true } }));
    expect(session.toState()).not.toHaveProperty('codexTrustWorkspace');
    vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
    const respawn = vi.spyOn(mux, 'respawnPane').mockResolvedValue(1234);
    expect(await session.restartCli()).toBe(true);
    const options = respawn.mock.calls[0][0];
    expect(options.codexTrustWorkspace).toBe(cwd);
    expect(buildSpawnCommand(options)).toContain('--config ' + codexTrustArgument(cwd));
    expect(buildSpawnCommand(options)).toContain('--dangerously-bypass-approvals-and-sandbox');
    // Reverie's own hooks, just written, are trusted by hash for this launch only.
    const hookTrust = codexHookTrustArgument(await reverieCodexHookTrust(dir));
    expect(hookTrust).toContain('trusted_hash');
    expect(options.codexHookTrust).toBe(hookTrust);
    expect(buildSpawnCommand(options)).toContain('--config ' + hookTrust);
    expect(session.toState()).not.toHaveProperty('codexHookTrust');
    expect(await fs.readdir(dir)).toEqual(['.codex']);
    expect(await fs.readdir(join(dir, '.codex'))).toEqual(['hooks.json']);
    const hooks = JSON.parse(await fs.readFile(join(dir, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks.hooks.UserPromptSubmit).toBeInstanceOf(Array);
    expect(JSON.stringify(hooks)).not.toContain('trust_level');
  });
  it('preserves an explicit restricted Codex runtime without adding trust or bypass', async () => {
    const mux = new TmuxManager(); const create = vi.spyOn(mux, 'createSession');
    const session = new Session({ workingDir: dir, mode: 'codex', useMux: true, mux, codexConfig: { dangerouslyBypassApprovals: false } });
    sessions.push(session); await session.startInteractive();
    expect(create.mock.calls[0][0].codexTrustWorkspace).toBeUndefined();
    expect(create.mock.calls[0][0].codexHookTrust).toBeUndefined();
    expect(session.codexConfig?.dangerouslyBypassApprovals).toBe(false);
  });
});
