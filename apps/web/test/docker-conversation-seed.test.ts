/** Real owned case-file IO and inert session metadata; no engine/provider calls. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs, { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../src/session.js';
import type { DockerCase, SessionDocker, SessionMode } from '../src/types.js';
import * as registry from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { dockerLaunchConversationSeed } from '../src/utils/docker-conversation-seed.js';
import { resolvedStockEntry, resolvedStockProtocol } from '../src/utils/resolved-stock-protocol.js';
import { persistDockerLaunchConversation } from '../src/web/routes/session-routes.js';
import { dockerCasesPath, readDockerCases, writeDockerCases, toSessionDocker } from '../src/docker-hosts.js';
import * as dockerHosts from '../src/docker-hosts.js';
import { buildDockerLaunchCommand } from '../src/tmux-manager.js';

const SID = '00000001-0001-4000-8000-000000000001';
const CURRENT = '00000002-0002-4000-8000-000000000002';
let directory: string;
let docker: SessionDocker;
const sessions: Session[] = [];
const originalGetCli = registry.getCli;
const original = {
  name: 'owned-case',
  type: 'docker',
  hostId: 'synthetic',
  container: 'owned-container',
  hostWorkspacePath: '/synthetic/owned',
  lastClaudeSessionId: 'preserved-old-seed',
} satisfies DockerCase;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'docker-seed-'));
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  registry.reloadCliRegistry();
  docker = toSessionDocker({ id: 'synthetic', label: 'Synthetic', image: 'synthetic:never-run' }, original);
  vi.spyOn(dockerHosts, 'checkDockerAvailable').mockRejectedValue(new Error('No engine access in this fixture'));
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  expect(dockerHosts.checkDockerAvailable).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  registry.reloadCliRegistry();
  await rm(directory, { recursive: true, force: true });
});
function session(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const current = new Session({ id: SID, workingDir: directory, mode: 'claude', useMux: false, docker, ...extra });
  sessions.push(current);
  return current;
}
async function saveRegistry(clis: Record<string, unknown>) {
  const path = registry.registryFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, clis }), { mode: 0o600 });
  registry.reloadCliRegistry();
}
it('persists the known conversation in the original container-keyed field without changing other cases', async () => {
  const other = { ...original, name: 'other-case', container: 'other-container', lastClaudeSessionId: 'other-seed' };
  await writeDockerCases(directory, [original, other]);
  const current = session();
  current.adoptClaudeSessionId(CURRENT);
  await persistDockerLaunchConversation(current, directory);
  expect(await readDockerCases(directory)).toEqual([{ ...original, lastClaudeSessionId: CURRENT }, other]);
});
it('preserves the logical-ID fallback without promoting archived aliases or requiring a first-hand flag', async () => {
  await writeDockerCases(directory, [original]);
  const current = session();
  expect(current.claudeSessionIdIsFirstHand).toBe(false);
  await persistDockerLaunchConversation(current, directory);
  expect((await readDockerCases(directory))[0].lastClaudeSessionId).toBe(SID);
  expect(
    dockerLaunchConversationSeed({
      id: SID,
      mode: 'claude',
      docker,
      claudeSessionId: null,
      claudeSessionIdPending: false,
    })
  ).toEqual({ containerName: 'owned-container', conversationId: SID });
});
it('leaves original bytes untouched while selection is pending, then follows the existing adoption state', async () => {
  await writeDockerCases(directory, [original]);
  const path = dockerCasesPath(directory),
    before = await readFile(path);
  const current = session({ claudeSessionIdPending: true, resumeSessionId: CURRENT });
  expect(current.claudeSessionIdPending).toBe(true);
  expect(current.claudeSessionId).toBeNull();
  const written = vi.spyOn(fs, 'writeFile');
  await persistDockerLaunchConversation(current, directory);
  expect(written).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(before);
  current.adoptClaudeSessionId(CURRENT, { firstHand: true });
  await persistDockerLaunchConversation(current, directory);
  expect(written).toHaveBeenCalledOnce();
  expect((await readDockerCases(directory))[0].lastClaudeSessionId).toBe(CURRENT);
});
it.each(['no-docker', 'codex', 'opencode', 'unknown-agent'] as const)(
  'does not write the Claude case seed for %s',
  async (mode) => {
    await writeDockerCases(directory, [original]);
    const path = dockerCasesPath(directory),
      before = await readFile(path);
    const current =
      mode === 'no-docker'
        ? session({ docker: undefined })
        : session({ mode: mode as SessionMode, resumeSessionId: CURRENT });
    await persistDockerLaunchConversation(current, directory);
    expect(await readFile(path)).toEqual(before);
  }
);
it('denies a copied custom declaration through actual forced registry provenance', async () => {
  const clone = structuredClone(registry.getCli('claude')!);
  await saveRegistry({ 'custom-agent': { ...clone, id: 'custom-agent', stock: true } });
  expect(registry.getCli('custom-agent')!.stock).toBe(false);
  expect(resolvedStockEntry('custom-agent')).toBeUndefined();
  await writeDockerCases(directory, [original]);
  const path = dockerCasesPath(directory),
    before = await readFile(path);
  await persistDockerLaunchConversation(session({ mode: 'custom-agent' as SessionMode }), directory);
  expect(await readFile(path)).toEqual(before);
});
it('preserves legacy launch/env and cosmetic overrides without weakening stricter protocol consumers', async () => {
  const launch = structuredClone(registry.getCli('claude')!.launch);
  delete launch.resumeSelection;
  launch.variants = [{ id: 'owner-legacy', args: [{ lit: 'owner-command' }] }];
  await saveRegistry({ claude: { label: 'Owner display', launch, env: { exports: [] } } });
  expect(registry.getCli('claude')!.launch.resumeSelection).toBeUndefined();
  expect(resolvedStockEntry('claude')).toBeDefined();
  expect(resolvedStockProtocol('claude')).toBeUndefined();
  await writeDockerCases(directory, [original]);
  const current = session({ resumeSessionId: CURRENT });
  expect(current.claudeSessionIdPending).toBe(false);
  await persistDockerLaunchConversation(current, directory);
  expect((await readDockerCases(directory))[0].lastClaudeSessionId).toBe(CURRENT);
});
it('requires a valid canonical declaration even when the stock flag or another codec is claimed', () => {
  const entry = structuredClone(originalGetCli('codex')!);
  entry.launch.dockerCaseSeed = 'session-id-resume-v1';
  vi.spyOn(registry, 'getCli').mockImplementation((mode) => (mode === entry.id ? entry : originalGetCli(mode)));
  expect(
    dockerLaunchConversationSeed({
      id: SID,
      mode: 'codex',
      docker,
      claudeSessionId: CURRENT,
      claudeSessionIdPending: false,
    })
  ).toBeUndefined();
  expect(
    CliEntrySchema.safeParse({
      ...originalGetCli('claude')!,
      launch: { ...originalGetCli('claude')!.launch, dockerCaseSeed: 'unknown-codec' },
    }).success
  ).toBe(false);
});
it('retains the original missing-case and unchanged-case no-write behavior', async () => {
  const current = session();
  await persistDockerLaunchConversation(current, directory);
  await expect(stat(dockerCasesPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeDockerCases(directory, [{ ...original, lastClaudeSessionId: SID }]);
  const before = await stat(dockerCasesPath(directory));
  const written = vi.spyOn(fs, 'writeFile');
  await persistDockerLaunchConversation(current, directory);
  expect(written).not.toHaveBeenCalled();
  const after = await stat(dockerCasesPath(directory));
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino).toBe(before.ino);
});
it('pairs the stored seed with actual fixed Docker --resume and --session-id command vectors', async () => {
  await writeDockerCases(directory, [original]);
  const current = session();
  current.adoptClaudeSessionId(CURRENT);
  await persistDockerLaunchConversation(current, directory);
  const stored = (await readDockerCases(directory))[0].lastClaudeSessionId;
  const render = (custom = false) =>
    buildDockerLaunchCommand({
      mode: 'claude',
      docker: custom ? { ...docker, commands: { claude: 'exec owner-command' } } : docker,
      sessionId: SID,
      resumeSessionId: stored,
      execEnv: {},
      execEnvNames: [],
      createContext: {
        docker,
        sessionId: SID,
        instance: 'synthetic',
        userArgs: [],
        credentialMounts: [],
        extraMounts: [],
        envCreate: {},
        addHostGateway: false,
        gatewayAlias: 'synthetic.invalid',
      },
    });
  const command = render();
  expect(command).toContain(`--resume ${CURRENT}`);
  expect(command).toContain(`--session-id ${SID}`);
  expect(command.indexOf(`--resume ${CURRENT}`)).toBeLessThan(command.indexOf(`--resume ${SID}`));
  const custom = render(true);
  expect(custom).toContain(`owner-command --resume ${CURRENT}`);
  expect(custom).toContain(`owner-command --session-id ${SID}`);
});
