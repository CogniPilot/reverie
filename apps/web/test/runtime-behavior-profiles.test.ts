import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {Session} from '../src/session.js';
import type {SessionMode, SessionRemote, SessionDocker} from '../src/types.js';
import {getCli, registryFilePath, reloadCliRegistry} from '../src/config/cli-registry/registry.js';
import {CliEntrySchema} from '../src/config/cli-registry/schema.js';
import {prepareWorkspaceSummaryHooks} from '../src/workspace-summary-hooks.js';
import {runtimePolicyFallbackProfile} from '../src/utils/runtime-policy-profile.js';
import {buildProfile, type ProfileSources} from '../src/web/routes/agent-profile-report.js';

let directory: string;
const sessions: Session[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runtime-behavior-'));
  vi.stubEnv('REVERIE_DATA_DIR', join(directory, 'data'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(directory, 'config'));
  reloadCliRegistry();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.unstubAllEnvs(); reloadCliRegistry(); await rm(directory, {recursive: true, force: true});
});
async function registry(clis: Record<string, unknown>) {
  const path = registryFilePath(); await mkdir(dirname(path), {recursive: true});
  await writeFile(path, JSON.stringify({schemaVersion: 1, clis}), {mode: 0o600}); reloadCliRegistry();
}
async function workspace(name: string) {
  const path = join(directory, name); await mkdir(path); return path;
}
async function missing(path: string) {
  await expect(readFile(path)).rejects.toMatchObject({code: 'ENOENT'});
}
function session(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const value = new Session({workingDir: directory, useMux: false, ...extra}); sessions.push(value); return value;
}
const summary = (value: Session) => (value as unknown as {_prepareWorkspaceSummaryHooks(): Promise<void>})._prepareWorkspaceSummaryHooks();

it('writes the shipped summary project hooks from a local Session and preserves owner opt-out', async () => {
  const path = await workspace('local'); await summary(session({mode: 'codex', workingDir: path}));
  expect(Object.keys(JSON.parse(await readFile(join(path, '.codex/hooks.json'), 'utf8')).hooks).sort())
    .toEqual(['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
  await mkdir(join(directory, 'data'), {recursive: true});
  await writeFile(join(directory, 'data/settings.json'), JSON.stringify({workspaceHooksEnabled: false}));
  const optedOut = await workspace('opted-out'); await summary(session({mode: 'codex', workingDir: optedOut}));
  await missing(join(optedOut, '.codex/hooks.json'));
});
it('never authors host summary hooks for remote or Docker Sessions', async () => {
  const remote: SessionRemote = {hostId: 'synthetic-host', label: 'Remote fixture', host: 'fixture.invalid', username: 'fixture', remotePath: '/owned'};
  const docker: SessionDocker = {hostId: 'synthetic-host', label: 'Docker fixture', engine: 'docker', image: 'fixture-image',
    containerName: 'fixture-container', hostWorkspacePath: directory, containerWorkdir: '/owned', network: 'none',
    mountCredentials: false, hooksEnabled: true, resumeOnStart: false};
  for (const [name, options] of [['remote', {remote}], ['docker', {docker}]] as const) {
    const path = await workspace(name); await summary(session({mode: 'codex', workingDir: path, ...options}));
    await missing(join(path, '.codex/hooks.json'));
  }
});
it('keeps cosmetic and valid legacy launch overrides independent of the summary writer and fallback codec', async () => {
  const launch = structuredClone(getCli('codex')!.launch);
  launch.variants.push({...structuredClone(launch.variants[0]), id: 'legacy-fallback'});
  const fallbackLaunch = structuredClone(getCli('opencode')!.launch);
  fallbackLaunch.variants.push({...structuredClone(fallbackLaunch.variants[0]), id: 'legacy-fallback'});
  await registry({codex: {label: 'Display only', launch}, opencode: {label: 'Local display', launch: fallbackLaunch}});
  expect(getCli('codex')!.launch).toEqual(launch); expect(getCli('opencode')!.launch).toEqual(fallbackLaunch);
  const path = await workspace('legacy'); await prepareWorkspaceSummaryHooks('codex', path);
  expect(JSON.parse(await readFile(join(path, '.codex/hooks.json'), 'utf8')).hooks.SessionStart).toBeTruthy();
  expect(runtimePolicyFallbackProfile('opencode')).toBe('opencode-local-v1');
});
it('refuses custom stock impersonation and declarations copied onto another stock runtime', async () => {
  const clone = structuredClone(getCli('codex')!), fallback = structuredClone(getCli('opencode')!);
  await registry({'custom-summary': {...clone, id: 'custom-summary', stock: true}, 'custom-fallback': {...fallback, id: 'custom-fallback', stock: true},
    gemini: {capabilities: {workspaceSummaryHooks: 'codex-project-v1', runtimePolicyFallback: 'opencode-local-v1', transcript: 'claude-jsonl'}}});
  for (const mode of ['custom-summary', 'custom-fallback', 'gemini', 'unknown-agent']) {
    const path = await workspace(mode); await prepareWorkspaceSummaryHooks(mode, path); await missing(join(path, '.codex/hooks.json'));
    expect(runtimePolicyFallbackProfile(mode)).toBeUndefined();
  }
  expect(getCli('custom-summary')!.stock).toBe(false); expect(getCli('custom-fallback')!.stock).toBe(false);
});
it('validates each closed code profile independently at the actual schema boundary', () => {
  const original = getCli('codex')!;
  for (const capabilities of [{workspaceSummaryHooks: 'unimplemented'}, {runtimePolicyFallback: 'unimplemented'}])
    expect(CliEntrySchema.safeParse({...original, capabilities: {...original.capabilities, ...capabilities}}).success).toBe(false);
});

const conversation = '0123abcd-0000-4000-8000-00000000abcd';
async function transcript() {
  const projects = join(directory, 'config/projects'), file = join(projects, 'owned', `${conversation}.jsonl`);
  await mkdir(dirname(file), {recursive: true}); await writeFile(file, JSON.stringify({effort: 'max', timestamp: 'synthetic-time'}));
  return {projects, file};
}
it('selects actual Claude-JSONL transcripts without weakening first-hand, local, exact-ID or uniqueness evidence', async () => {
  const clone = structuredClone(getCli('claude')!); await registry({'custom-jsonl': {...clone, id: 'custom-jsonl'}});
  const {file, projects} = await transcript();
  const current = session({mode: 'custom-jsonl' as SessionMode}); current.adoptClaudeSessionId(conversation, {firstHand: true});
  expect(await current.claudeTranscript()).toBe(file);
  const guessed = session({mode: 'custom-jsonl' as SessionMode}); guessed.adoptClaudeSessionId(conversation);
  expect(await guessed.claudeTranscript()).toBeUndefined();
  const foreign = session({mode: 'codex'}); foreign.adoptClaudeSessionId(conversation, {firstHand: true});
  expect(await foreign.claudeTranscript()).toBeUndefined();
  const remote = session({remote: {hostId: 'fixture', label: 'Remote', host: 'fixture.invalid', username: 'fixture', remotePath: '/owned'}});
  remote.adoptClaudeSessionId(conversation, {firstHand: true}); expect(await remote.claudeTranscript()).toBeUndefined();
  current.adoptClaudeSessionId('not-a-native-uuid', {firstHand: true}); expect(await current.claudeTranscript()).toBeUndefined();
  current.adoptClaudeSessionId(conversation, {firstHand: true});
  await mkdir(join(projects, 'duplicate')); await writeFile(join(projects, 'duplicate', `${conversation}.jsonl`), '{}');
  expect(await current.claudeTranscript()).toBeUndefined();
});
it('reports effort from the declared JSONL reader and keeps runtime switching denied for the actual shipped fallback', async () => {
  const clone = structuredClone(getCli('claude')!); await registry({'custom-jsonl': {...clone, id: 'custom-jsonl'}});
  const {projects} = await transcript();
  const sources: ProfileSources = {employees: () => [], rooms: () => [], transcriptProjectsDir: projects};
  const state = {id: 'synthetic-session', mode: 'custom-jsonl', claudeSessionId: conversation};
  expect(buildProfile(sources, state.id, state, {includeDms: false}).effort).toMatchObject({observed: {level: 'max', at: 'synthetic-time'}});
  expect(buildProfile(sources, state.id, {...state, mode: 'codex'}, {includeDms: false}).effort).toMatchObject({observed: null});
  const policy = join(directory, 'policy.json'); sources.runtimePolicy = policy;
  const writePolicy = async (mode: string) => writeFile(policy, JSON.stringify({state_file: 'runtime-state.json', fallback: 'local', backends: {local: {mode, enabled: true}}}));
  await writePolicy('opencode');
  expect(buildProfile(sources, state.id, state, {includeDms: false}).runtime).toMatchObject({switch: {available: false}});
  const fallback = structuredClone(getCli('opencode')!); await registry({'custom-fallback': {...fallback, id: 'custom-fallback', stock: true}});
  await writePolicy('custom-fallback'); expect(() => buildProfile(sources, state.id, state, {includeDms: false})).toThrow('local OpenCode adapter');
});
