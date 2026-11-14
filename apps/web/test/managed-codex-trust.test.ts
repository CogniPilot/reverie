import { StateStore } from '../src/state-store.js';
import { captureDockerEmployeeProviderLaunch } from '../src/docker-employee-provider-launch.js';
import { bindInitialLaunchAdmission } from '../src/initial-launch-admission.js';
import { DOCKER_CODEX_WORKSPACE_PROGRAM } from '../src/docker-employee-codex-workspace.js';
import { generateCodexTurnSummaryHooks } from '../src/hooks-config.js';
import { buildDockerLaunchCommand } from '../src/tmux-manager.js';
import type { SessionDocker } from '../src/types.js';
import { acknowledgeMuxFixture } from './helpers/acknowledged-mux-fixture.js';
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
  vi.spyOn(users, 'canUsernameRunPrivilegedCommands').mockImplementation(async (owner) => owner !== 'ungranted');
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});
const trust = (extra = {}) => managedCodexTrust({ mode: 'codex', fullAccess: true, workingDir: dir, ...extra });

describe('managed Codex workspace trust', () => {
  it('trusts only the actual workspace of an authorized container launch without writing account files', async () => {
    expect(await trust()).toBe(await fs.realpath(dir));
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it.each([
    { mode: 'claude' },
    { fullAccess: false },
    { fullAccess: undefined },
    { owner: 'ungranted' },
    { remote: {} },
    { docker: {} },
    { discovered: true },
  ])('does not add trust for an ineligible runtime: %j', async (extra) => {
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
    const session = new Session({
      workingDir: dir,
      mode: 'codex',
      useMux: true,
      mux,
      codexConfig: { model: 'gpt-5.4', reasoningEffort: 'high' },
    });
    sessions.push(session);
    await session.startInteractive();
    const cwd = await fs.realpath(dir);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        codexTrustWorkspace: cwd,
        codexConfig: { model: 'gpt-5.4', reasoningEffort: 'high', dangerouslyBypassApprovals: true },
      })
    );
    expect(session.toState()).not.toHaveProperty('codexTrustWorkspace');
    vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
    const respawn = vi.spyOn(mux, 'respawnPane').mockImplementation(async (options) => {
      await acknowledgeMuxFixture(options);
      return 1234;
    });
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
    const mux = new TmuxManager();
    const create = vi.spyOn(mux, 'createSession');
    const session = new Session({
      workingDir: dir,
      mode: 'codex',
      useMux: true,
      mux,
      codexConfig: { dangerouslyBypassApprovals: false },
    });
    sessions.push(session);
    await session.startInteractive();
    expect(create.mock.calls[0][0].codexTrustWorkspace).toBeUndefined();
    expect(create.mock.calls[0][0].codexHookTrust).toBeUndefined();
    expect(session.codexConfig?.dangerouslyBypassApprovals).toBe(false);
  });
});

describe('private Docker employee Codex trust', () => {
  const sid = '20000000-0000-4000-8000-000000000002',
    oid = '30000000-0000-4000-8000-000000000003';
  const dockerFor = (workingDir: string): SessionDocker => ({
    hostId: 'boxed-runtime',
    label: 'fixture',
    engine: 'docker',
    image: 'sha256:' + 'c'.repeat(64),
    containerName: 'd'.repeat(64),
    hostWorkspacePath: '/',
    containerWorkdir: workingDir,
    network: 'bridge',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      operationId: oid,
      employeeId: '10000000-0000-4000-8000-000000000001',
      sessionGeneration: 1,
      clientManifestDigest: '4'.repeat(64),
      apiUrl: 'http://synthetic.invalid',
    },
  });
  const binding = {
    version: 1 as const,
    operationId: oid,
    credentialId: '40000000-0000-4000-8000-000000000004',
    sessionId: sid,
    sessionGeneration: 1,
    containerId: 'd'.repeat(64),
    imageId: 'sha256:' + 'c'.repeat(64),
    originalDigest: '1'.repeat(64),
    policyDigest: '2'.repeat(64),
  };
  it('actual Session first launch passes worker-read trust only as inline flags and retains native cwd proof', async () => {
    const worker = join(dir, 'worker');
    await fs.mkdir(worker);
    await fs.mkdir(join(worker, '.codex'));
    await fs.writeFile(join(worker, '.codex/hooks.json'), JSON.stringify(generateCodexTurnSummaryHooks()));
    const docker = dockerFor(worker),
      mux = new TmuxManager(),
      create = vi.spyOn(mux, 'createSession');
    const session = new Session({
      id: sid,
      workingDir: worker,
      mode: 'codex',
      useMux: true,
      mux,
      docker,
      codexConfig: { model: 'gpt-5.4', dangerouslyBypassApprovals: true },
      publicationStore: new StateStore(join(dir, 'state.json')),
    });
    sessions.push(session);
    bindInitialLaunchAdmission(session, () => true);
    const reader = vi.fn(async (workingDir) => {
      const child = spawnSync(
        process.execPath,
        ['--input-type=commonjs', '-e', DOCKER_CODEX_WORKSPACE_PROGRAM, '--', 'observe', workingDir, worker],
        { encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH } }
      );
      expect(child.status).toBe(0);
      return JSON.parse(child.stdout);
    });
    const owner = captureDockerEmployeeProviderLaunch(session, binding, () => {}, reader);
    session.bindDockerContinuationLaunch(owner);
    await session.startInteractive();
    expect(reader).toHaveBeenCalledExactlyOnceWith(worker);
    const options = create.mock.calls[0]![0];
    expect(options.codexTrustWorkspace).toBe(worker);
    expect(options.codexHookTrust).toContain('trusted_hash');
    const canonical = buildSpawnCommand(options);
    expect(canonical).toContain('--config ' + codexTrustArgument(worker));
    expect(canonical).toContain('--config ' + options.codexHookTrust);
    expect(session.toPersistedState()).not.toHaveProperty('codexTrustWorkspace');
    expect(session.toPersistedState()).not.toHaveProperty('codexHookTrust');
    const command = buildDockerLaunchCommand({
      mode: 'codex',
      docker: session.docker!,
      sessionId: sid,
      createContext: {} as never,
      execEnv: {},
      execEnvNames: [],
      canonicalCommand: canonical,
      continuationLaunch: owner,
    });
    expect(command).toContain('Managed Docker workspace changed');
    expect(command).toContain('NODE_OPTIONS=');
    expect((await fs.readdir(dir)).filter((p) => p !== 'state.json' && !p.startsWith('state.json.'))).toEqual([
      'worker',
    ]);
    expect(await fs.readdir(worker)).toEqual(['.codex']);
    expect(() =>
      buildDockerLaunchCommand({
        mode: 'codex',
        docker: session.docker!,
        sessionId: sid,
        createContext: {} as never,
        execEnv: {},
        execEnvNames: [],
        canonicalCommand: canonical,
        continuationLaunch: owner,
      })
    ).toThrow();
  });
  it.each(['restricted', 'ungranted', 'revoked', 'plain-docker'])(
    'never earns Docker workspace trust for %s',
    async (kind) => {
      const mux = new TmuxManager(),
        create = vi.spyOn(mux, 'createSession'),
        docker = dockerFor(dir);
      const session = new Session({
        id: sid,
        workingDir: dir,
        mode: 'codex',
        useMux: true,
        mux,
        docker,
        owner: kind === 'ungranted' ? 'ungranted' : undefined,
        codexConfig: { dangerouslyBypassApprovals: kind !== 'restricted' },
        publicationStore: new StateStore(join(dir, 'state.json')),
      });
      sessions.push(session);
      bindInitialLaunchAdmission(session, () => true);
      const reader = vi.fn(async () => ({ realPath: dir, dev: '1', ino: '2', hooksText: null }));
      if (kind !== 'plain-docker')
        session.bindDockerContinuationLaunch(
          captureDockerEmployeeProviderLaunch(
            session,
            binding,
            () => {
              if (kind === 'revoked' && reader.mock.calls.length) throw Error('revoked');
            },
            reader
          )
        );
      if (kind === 'revoked') await expect(session.startInteractive()).rejects.toThrow('revoked');
      else if (kind === 'plain-docker') {
        await expect(session.startInteractive()).rejects.toThrow(
          'Original acknowledged provider launch owner required'
        );
        expect(create.mock.calls[0]![0].codexTrustWorkspace).toBeUndefined();
      } else {
        await session.startInteractive();
        expect(create.mock.calls[0]![0].codexTrustWorkspace).toBeUndefined();
      }
      if (kind !== 'revoked') expect(reader).not.toHaveBeenCalled();
    }
  );
});
