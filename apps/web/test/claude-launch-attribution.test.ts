/** Owned metadata, inert mux and real API/auth controls; no provider/account access. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { CLAUDE_METADATA_SELECTOR } from '../src/utils/claude-launch.js';
import { registerSessionRoutes, persistDockerLaunchConversation } from '../src/web/routes/session-routes.js';
import { registerHookEventRoutes } from '../src/web/routes/hook-event-routes.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../src/config/hook-secret.js';
import { getDataDir } from '../src/config/instance.js';
import { readDockerCases, writeDockerCases } from '../src/docker-hosts.js';
import { mergeUnifiedSessions } from '../src/services/unified-session-service.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import * as registry from '../src/config/cli-registry/registry.js';
import * as remoteHosts from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
const originalGetCli = registry.getCli;
const SID = '00000008-0008-4000-8000-000000000008';
const TAIL = '00000009-0009-4000-8000-000000000009';
const SEED = '00000010-0010-4000-8000-000000000010';
const AUTH = 'Basic ' + Buffer.from('admin:owned-hook-fixture').toString('base64');
let app: FastifyInstance, ctx: ReturnType<typeof createMockRouteContext>, config: string, cwd: string;
let sessions: Session[];
let authState: ReturnType<typeof registerAuthMiddleware>;
function mux(dead = true, onRespawn?: () => Promise<void>) {
  return { isAvailable: () => true, muxSessionExists: () => true, isPaneDead: () => dead,
    setAttached: () => {}, killSession: () => true,
    respawnPane: vi.fn(async () => { await onRespawn?.(); return 4242; }),
    createSession: vi.fn(async () => ({ muxName: 'owned-fixture', sessionId: SID })),
  } as unknown as TerminalMultiplexer;
}
function session(dead = true, extra = {}, onRespawn?: () => Promise<void>) {
  const s = new Session({ id: SID, workingDir: cwd, mode: 'claude', useMux: true, mux: mux(dead, onRespawn),
    muxSession: { muxName: 'owned-fixture', sessionId: SID } as MuxSession,
    envOverrides: { CLAUDE_CONFIG_DIR: config }, resumeSessionId: SEED, claudeSessionChain: [TAIL], ...extra });
  sessions.push(s); ctx.sessions.clear(); ctx.sessions.set(SID, s as never); return s;
}
function transcript(id: string, text: string) {
  const p = join(config, 'projects', '-owned-fixture'); mkdirSync(p, { recursive: true });
  const path = join(p, id + '.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  return path;
}
async function hook(id = SEED, secret?: string) {
  return app.inject({ method: 'POST', url: '/api/hook-event',
    headers: secret === undefined ? {} : { [HOOK_SECRET_HEADER]: secret },
    payload: { event: 'prompt_submitted', sessionId: SID, data: { session_id: id, hook_event_name: 'UserPromptSubmit' } } });
}
beforeEach(async () => {
  process.env.REVERIE_PASSWORD = 'owned-hook-fixture'; process.env.REVERIE_USERNAME = 'admin';
  config = join(homedir(), '.claude'); cwd = join(homedir(), 'owned-work'); mkdirSync(cwd, { recursive: true });
  vi.spyOn(remoteHosts, 'probeRemoteCliVersion').mockResolvedValue('owned-fixture-version');
  sessions = []; ctx = createMockRouteContext(); app = Fastify(); await app.register(fastifyCookie);
  authState = registerAuthMiddleware(app, false);
  registerSessionRoutes(app, ctx, { verifiedOwner: trustedFixtureOwner }); registerHookEventRoutes(app, ctx);
  await app.ready();
});
afterEach(async () => {
  for (const s of sessions) await s.stop();
  await app.close(); for (const value of Object.values(authState)) value?.dispose();
  delete process.env.REVERIE_PASSWORD; delete process.env.REVERIE_USERNAME; vi.restoreAllMocks();
});
describe('actual runtime selection remains unknown until its existing authenticated hook', () => {
  it('does not attribute missing tail or existing SID when the actual selector chooses the seed', async () => {
    transcript(SEED, 'selected fixture seed'); transcript(SID, 'unselected fixture SID');
    const selected = execFileSync('python3', ['-I', '-c',
      "import sys,json;ns={'__name__':'owned_fixture'};exec(sys.argv[1],ns);print(ns['_select_bounded'](sys.argv[2],json.loads(sys.argv[3])))",
      CLAUDE_METADATA_SELECTOR, config, JSON.stringify([TAIL, SEED, SID])], { encoding: 'utf8', timeout: 5000 }).trim();
    expect(selected).toBe(SEED);
    const s = session(); await s.startInteractive();
    expect(s.claudeSessionIdPending).toBe(true); expect(s.claudeSessionId).toBeNull();
    expect(s.toLightDetailedState()).toMatchObject({ claudeSessionId: null, claudeSessionIdPending: true });
    expect(s.toState().claudeSessionChain).toEqual([TAIL]); // archival evidence is preserved
    s.adoptClaudeSessionId(SID); expect(s.claudeSessionId).toBeNull(); // no history guess
    expect((await hook(SEED)).statusCode).toBe(401); expect(s.claudeSessionId).toBeNull();
    expect((await hook(SEED, getHookSecret())).statusCode).toBe(200);
    expect(s.claudeSessionId).toBe(SEED); expect(s.claudeSessionIdPending).toBe(false);
    expect(s.claudeSessionIdIsFirstHand).toBe(true); expect(s.claudeSessionChain).toEqual([TAIL, SEED]);
    expect(ctx.persistSessionState).toHaveBeenCalledWith(s);
  });
  it('withholds last-response and transcript-title writes until the hook resolves selection', async () => {
    const self = transcript(SID, 'unselected fixture SID'); transcript(SEED, 'selected fixture seed');
    const s = session(); await s.startInteractive();
    const before = readFileSync(self, 'utf8');
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/last-response?context=full`, headers: { authorization: AUTH } });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ text: '', messages: [], claudeSessionIdPending: true });
    const rename = await app.inject({ method: 'PUT', url: `/api/sessions/${SID}/name`, headers: { authorization: AUTH }, payload: { name: 'Owned new name' } });
    expect(rename.statusCode).toBe(200); expect(readFileSync(self, 'utf8')).toBe(before);
    await hook(SEED, getHookSecret());
    const actual = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/last-response`, headers: { authorization: AUTH } });
    expect(actual.statusCode).toBe(200); expect(actual.json().text).toBe('selected fixture seed');
    const confirmedRename = await app.inject({ method: 'PUT', url: `/api/sessions/${SID}/name`, headers: { authorization: AUTH }, payload: { name: 'Owned confirmed name' } });
    expect(confirmedRename.statusCode).toBe(200);
    expect(readFileSync(join(config, 'projects', '-owned-fixture', SEED + '.jsonl'), 'utf8')).toContain('Owned confirmed name');
    expect(readFileSync(self, 'utf8')).toBe(before);
  });
  it('does not persist a guessed Docker launch seed; the actual hook updates the existing case', async () => {
    const dir = getDataDir();
    await writeDockerCases(dir, [{ name: 'owned-fixture', container: 'owned-container', lastClaudeSessionId: 'owned-previous-case-seed' } as never]);
    const s = session(true, { docker: { containerName: 'owned-container', hostWorkspacePath: cwd, workspacePath: cwd, hooksEnabled: false } });
    await s.startInteractive(); await persistDockerLaunchConversation(s, dir);
    expect((await readDockerCases(dir))[0].lastClaudeSessionId).toBe('owned-previous-case-seed');
    await hook(SEED, getHookSecret());
    // The existing hook route intentionally persists the case asynchronously.
    await vi.waitFor(async () => expect((await readDockerCases(dir))[0].lastClaudeSessionId).toBe(SEED));
  });
  it('new or vanished mux sessions also withhold candidate attribution', async () => {
    for (const vanished of [false, true]) {
      const m = mux();
      if (vanished) m.muxSessionExists = () => false;
      const s = session(true, { mux: m, ...(vanished ? {} : { muxSession: undefined }) });
      await s.startInteractive(); expect(s.claudeSessionId).toBeNull(); expect(s.claudeSessionIdPending).toBe(true);
      await s.stop();
    }
  });
  it('does not record pending resume intent as a newly observed account thread', async () => {
    const s = session(); await s.startInteractive();
    const undo = s.configureRuntime({ mode: 'codex', sourceKey: 'owned-new', env: {} });
    expect(s.toState().runtimeThreads?.['claude:subscription:']).toBeUndefined();
    expect(s.claudeSessionIdPending).toBe(false);
    undo(); expect(s.claudeSessionIdPending).toBe(true); expect(s.claudeSessionId).toBeNull();
  });
  it('preserves actual hook adoption that arrives during the launch await', async () => {
    const s = session(true, {}, async () => { expect((await hook(SEED, getHookSecret())).statusCode).toBe(200); });
    await s.startInteractive(); expect(s.claudeSessionId).toBe(SEED); expect(s.claudeSessionIdPending).toBe(false);
  });
  it('preserves the trusted current conversation on live attach', async () => {
    const s = session(false); s.adoptClaudeSessionId(TAIL, { firstHand: true });
    await s.startInteractive(); expect(s.claudeSessionId).toBe(TAIL); expect(s.claudeSessionIdIsFirstHand).toBe(true);
    expect(s.claudeSessionIdPending).toBe(false);
  });
  it('carries unknown selection through persistence and an ordinary live attachment', async () => {
    const s = session(); await s.startInteractive(); const saved = s.toState(); await s.stop();
    const restored = session(false, { ...saved, mux: mux(false) });
    expect(restored.claudeSessionId).toBeNull(); await restored.startInteractive();
    expect(restored.claudeSessionId).toBeNull(); expect(restored.claudeSessionIdPending).toBe(true);
  });
  it('marks an explicit same-pane restart unknown before invoking the mux', async () => {
    let s: Session;
    s = session(false, {}, async () => { expect(s.claudeSessionId).toBeNull(); expect(s.claudeSessionIdPending).toBe(true); });
    s.adoptClaudeSessionId(TAIL, { firstHand: true }); await s.startInteractive();
    expect(await s.restartCli()).toBe(true); expect(s.claudeSessionIdIsFirstHand).toBe(false); expect(s.claudeSessionIdPending).toBe(true);
  });
  it('keeps non-Claude and explicitly legacy custom profile behavior', async () => {
    const other = session(true, { mode: 'codex', codexConfig: { resumeSessionId: SEED } });
    await other.startInteractive(); expect(other.claudeSessionIdPending).toBe(false); expect(other.claudeSessionId).toBe(TAIL); // preexisting restored-chain semantics, no selector
    vi.spyOn(registry, 'getCli').mockImplementation((id) => {
      const entry = originalGetCli(id); return entry?.launch.resumeSelection ? { ...entry, launch: { ...entry.launch, resumeSelection: undefined } } : entry;
    });
    transcript(TAIL, 'legacy fixture'); const legacy = session(); await legacy.startInteractive();
    expect(legacy.claudeSessionIdPending).toBe(false); expect(legacy.claudeSessionId).toBe(TAIL);
  });
  it('does not turn archived aliases or same-directory history into a pending current conversation', () => {
    const inputs = { persisted: [{ id: SID, name: 'owned', workingDir: cwd, claudeSessionId: SEED }],
      live: [{ id: SID, name: 'owned', workingDir: cwd, claudeSessionIdPending: true }],
      history: [TAIL, SEED, SID].map((id) => ({ sessionId: id, workingDir: cwd, firstPrompt: 'archived fixture', lastPrompt: 'old fixture', lastModified: '2026-01-01T00:00:00Z' })) };
    const pending = mergeUnifiedSessions(inputs); const current = pending.find((r) => r.sessionId === SID)!;
    expect(current.claudeSessionId).toBeUndefined(); expect(current.claudeSessionIdPending).toBe(true);
    expect(current.firstPrompt).toBeUndefined(); expect(current.lastPrompt).toBeUndefined();
    expect(pending.some((r) => r.sessionId === SEED)).toBe(true); // real archive retained separately
    const resolved = mergeUnifiedSessions({ ...inputs,
      persisted: [{ ...inputs.persisted[0], claudeSessionIdPending: true }],
      live: [{ id: SID, name: 'owned', workingDir: cwd, claudeSessionId: SEED }] });
    expect(resolved.find((r) => r.sessionId === SID)?.claudeSessionId).toBe(SEED);
    expect(resolved.some((r) => r.sessionId === SEED)).toBe(false);
  });
});


describe('SSH transport lifecycle preserves remote attribution', () => {
  const CURRENT = '00000014-0014-4014-8014-000000000014';
  function remote(owned: boolean) {
    return { hostId: 'owned-host', label: 'Owned fixture', host: 'fixture.invalid', username: 'fixture',
      remotePath: '/workspace', owned, remoteSessionName: 'owned-existing-remote' };
  }
  for (const owned of [false, true]) {
    for (const action of ['reattachRemote', 'restartCli', 'startInteractive'] as const) {
      it(`preserves first-hand current ID across ${action} (owned=${owned})`, async () => {
        const s = session(action === 'startInteractive', { remote: remote(owned) });
        s.adoptClaudeSessionId(CURRENT, { firstHand: true });
        const result = await s[action]();
        if (action !== 'startInteractive') expect(result).toBe(true);
        expect(s.claudeSessionId).toBe(CURRENT); expect(s.claudeSessionIdIsFirstHand).toBe(true);
        expect(s.claudeSessionIdPending).toBe(false); expect(s.claudeSessionChain).toEqual([TAIL, CURRENT]);
      });
    }
    it(`preserves CURRENT instead of SEED when the local SSH mux vanished (owned=${owned})`, async () => {
      const m = mux(); m.muxSessionExists = () => false;
      const s = session(true, { remote: remote(owned), mux: m });
      s.adoptClaudeSessionId(CURRENT, { firstHand: true });
      await s.startInteractive(); expect(m.createSession).toHaveBeenCalledOnce();
      expect(s.claudeSessionId).toBe(CURRENT); expect(s.claudeSessionId).not.toBe(SEED);
      expect(s.claudeSessionIdIsFirstHand).toBe(true); expect(s.claudeSessionIdPending).toBe(false);
    });
    it(`does not restore a local-launch pending flag onto SSH transport (owned=${owned})`, async () => {
      const s = session(false, { remote: remote(owned), claudeSessionIdPending: true });
      expect(s.claudeSessionIdPending).toBe(false); expect(s.claudeSessionId).toBe(TAIL);
      await s.startInteractive(); expect(s.claudeSessionId).toBe(TAIL); expect(s.claudeSessionIdPending).toBe(false);
    });
  }
  it('keeps fresh owned remote attach-or-create and its provisional intent, without a new refusal', async () => {
    const r = remote(true); const m = mux();
    const s = session(false, { remote: r, mux: m, muxSession: undefined, claudeSessionChain: [] });
    await s.startInteractive(); expect(m.createSession).toHaveBeenCalledOnce();
    expect(s.claudeSessionId).toBe(SEED); expect(s.claudeSessionIdIsFirstHand).toBe(false);
    expect(s.claudeSessionIdPending).toBe(false); // existing intent, NOT actual remote selected-ID proof
    const command = buildRemoteLaunchCommand({ mode: 'claude', remote: r, sessionId: SID,
      resumeSessionId: SEED, claudeResumeCandidates: [TAIL, SEED, SID] });
    expect(command).toContain('new-session -A'); expect(command).toContain('_select_bounded');
    expect(command).toContain(SEED); // real remote creation still uses the actual-namespace selector
  });
});
