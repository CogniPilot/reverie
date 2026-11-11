import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {Session, ProviderDispatchUnconfirmedError} from '../src/session.js';
import {spawn as spawnPty} from 'node-pty';
import {sessionProviderLeaseCurrent} from '../src/session-provider-lease.js';
import {prepareWorkspaceHooks, consumeWorkspaceHookPreparation, type WorkspaceHookPreparation} from '../src/workspace-hook-policy.js';
import {resolveWaitSignals, sessionHookOptions, sessionWaits} from '../src/web/session-wait-registry.js';
import {registerHookEventRoutes} from '../src/web/routes/hook-event-routes.js';
import {registerApprovalRoutes} from '../src/web/routes/approval-routes.js';
import {approvalInbox} from '../src/web/approval-inbox.js';
import {registerSessionRoutes} from '../src/web/routes/session-routes.js';
import {installResponseEnvelope} from '../src/web/response-envelope.js';
import {installRouteErrorHandler} from '../src/web/route-error-handler.js';
import {createMockRouteContext} from './mocks/index.js';
import {trustedFixtureOwner} from './helpers/trusted-owner-fixture.js';
import {WebServer} from '../src/web/server.js';
import {CASES_DIR} from '../src/web/route-helpers.js';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {ChatroomStore} from '../src/chatroom-store.js';
import type {AuthUser} from '../src/types.js';
import type {SseStreamManager} from '../src/web/sse-stream-manager.js';
import type {CleanupManager} from '../src/utils/index.js';

// Only process transport is fake: actual start owner, filesystem executor,
// single-use receipt, HTTP routes and wait registry remain real.
const transport = vi.hoisted(() => ({envs: [] as Array<Record<string, string | undefined>>, writes: [] as string[]}));
vi.mock('node-pty', () => ({spawn: vi.fn((_file, _args, options) => {
  transport.envs.push(options.env);
  return {pid: 999_999_997, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn((data: string) => transport.writes.push(data)), resize: vi.fn()};
})}));
vi.mock('../src/utils/claude-cli-resolver.js', async original => ({
  ...await original<typeof import('../src/utils/claude-cli-resolver.js')>(),
  getClaudeBinaryPath: () => process.execPath,
  getClaudeCliVersion: () => 'synthetic',
}));
let workspace: string;
const sessions: Session[] = [];
beforeEach(async () => {workspace = await mkdtemp(join(tmpdir(), 'hook-preparation-')); transport.envs.length = 0; transport.writes.length = 0;});
afterEach(async () => {
  for (const session of sessions.splice(0)) {sessionWaits.cancelAll(session.id); approvalInbox.resolveForSession(session.id, 'session_ended'); await session.stop(false);}
  await rm(workspace, {recursive: true, force: true}); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function start(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const proof = await prepareWorkspaceHooks(workspace, 'install', {scaffold: false, enabled: async () => true});
  const session = new Session({workingDir: workspace, workspaceHookPreparation: proof,
    envOverrides: {REVERIE_HOOK_GENERATION: 'caller-forged'}, ...extra});
  sessions.push(session); await session.startInteractive(); return session;
}
it('prepares configuration without completing waits or serializing private generation', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const session = await start();
  const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION!;
  expect(token).toBeTruthy(); expect(token).not.toBe('caller-forged');
  expect(session.workspaceHookConfiguration).toBe('prepared');
  expect(session.admitHookReport(token)).toBe('current');
  expect(session.admitHookReport('caller-forged')).toBe('refused');
  expect(session.admitHookReport(undefined)).toBe('refused');
  for (const value of [session.toState(), session.getEnvOverridesForPersist(), log.mock.calls])
    expect((JSON.stringify(value) ?? '')).not.toContain(token);
  expect(resolveWaitSignals('stop', {mode: session.mode, ...sessionHookOptions(session)}).error).toBeNull();
  const wait = sessionWaits.waitForSignal(session.id, {until: ['stop'], timeoutMs: 1000});
  let completed = false; void wait.then(() => {completed = true;});
  await new Promise(resolve => setTimeout(resolve, 5)); expect(completed).toBe(false);
  sessionWaits.cancelAll(session.id); await wait;
});
it('issues a private epoch for a freshly prepared worker start without trusting restored state', async () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic-owned-fixture/worker.sock');
  const pending = await controlledMuxStart(); pending.succeed(); await pending.starting;
  const prepared = pending.session, generation = pending.token;
  expect(typeof generation === 'string' && generation.length > 0).toBe(true);
  expect(prepared.runtimeHealthScope).toBe('terminal');
  expect(prepared.admitHookReport(generation)).toBe('current');
  for (const options of [{prepared:false, expected:'refused'}, {viewer:true, expected:'legacy-attachment'}]) {
    const restored = await controlledMuxStart(options); restored.succeed(); await restored.starting;
    expect(restored.session.workspaceHookConfiguration).toBe('unknown');
    expect(restored.session.admitHookReport(generation)).toBe(options.expected);
    expect(restored.token).toBe('');
    expect(resolveWaitSignals('stop', {mode:'claude',...sessionHookOptions(restored.session)}).error).toContain('unknown');
  }
});
it('refuses damaged native-worker restart preparation before touching the current provider epoch', async () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic-owned-fixture/worker.sock');
  const active = await controlledMuxStart(); active.succeed(); await active.starting;
  await writeFile(join(workspace,'.claude/settings.local.json'), '{ damaged fixture settings');
  await expect(active.session.restartCli()).rejects.toMatchObject({name:'WorkspaceHookPreparationError'});
  expect(active.mux.respawnPane).not.toHaveBeenCalled();
  expect(active.session.admitHookReport(active.token)).toBe('current');
  expect(active.session.providerDispatchHeld).toBe(false);
});
it('consumes proof once and refuses serialized lookalikes', async () => {
  const proof = await prepareWorkspaceHooks(workspace, 'install', {scaffold: false, enabled: async () => true});
  expect(Object.isFrozen(proof)).toBe(true);
  expect(Reflect.set(proof, 'workspace', workspace + '-other')).toBe(false);
  expect(Reflect.set(proof, 'configuration', 'prepared')).toBe(false);
  expect(consumeWorkspaceHookPreparation(proof, workspace)).toBe('prepared');
  expect(consumeWorkspaceHookPreparation(proof, workspace)).toBe('unknown');
  expect(consumeWorkspaceHookPreparation(JSON.parse(JSON.stringify(proof)) as WorkspaceHookPreparation, workspace)).toBe('unknown');
  const session = new Session({workingDir: workspace, workspaceHookPreparation: proof}); sessions.push(session);
  await session.startInteractive(); expect(session.workspaceHookConfiguration).toBe('unknown');
});
it('refuses unknown restored and opted-out hook waits but preserves ordinary waits', async () => {
  const restored = new Session({workingDir: workspace}); sessions.push(restored);
  expect(resolveWaitSignals('stop', {mode: 'claude', ...sessionHookOptions(restored)}).error).toContain('unknown');
  expect(resolveWaitSignals('idle,exit', {mode: 'claude', ...sessionHookOptions(restored)}).error).toBeNull();
  const proof = await prepareWorkspaceHooks(workspace, 'install', {scaffold: false, enabled: async () => false});
  const session = new Session({workingDir: workspace, workspaceHookPreparation: proof}); sessions.push(session);
  await session.startInteractive(); expect(session.workspaceHookConfiguration).toBe('opted-out');
  expect(resolveWaitSignals('blocked', {mode: 'claude', ...sessionHookOptions(session)}).error).toContain('opted-out');
});
it('invalidates proof and generation on CLI change, failed restart and stop', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  session.setMode('shell'); session.setMode('claude');
  expect(session.workspaceHookConfiguration).toBe('unknown'); expect(session.admitHookReport(token)).toBe('refused');
  await expect(session.startInteractive()).rejects.toThrow('already has a running process');
  expect(session.workspaceHookConfiguration).toBe('unknown'); await session.stop(false);
  expect(session.admitHookReport(token)).toBe('refused');
});
it.each(['{ incomplete', 'null', '[]'])('preserves damaged settings and refuses before start: %s', async bytes => {
  await mkdir(join(workspace, '.claude')); const path = join(workspace, '.claude/settings.local.json');
  await writeFile(path, bytes);
  await expect(prepareWorkspaceHooks(workspace, 'install', {scaffold: false, enabled: async () => true}))
    .rejects.toMatchObject({name: 'WorkspaceHookPreparationError', outcome: {state: 'unconfirmed'}});
  expect(await readFile(path, 'utf8')).toBe(bytes); expect(transport.envs).toHaveLength(0);
});
it('releases obsolete parked wait and ignores delayed old events after new start over real HTTP routes', async () => {
  const first = await start({id: 'synthetic-hook-session'}); const oldToken = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION!;
  const app = Fastify(); await app.register(cookie); const ctx = createMockRouteContext();
  ctx.sessions.set(first.id, first as never);
  registerSessionRoutes(app, ctx as never, {verifiedOwner: trustedFixtureOwner}); registerHookEventRoutes(app, ctx as never);
  installResponseEnvelope(app); installRouteErrorHandler(app); await app.ready();
  const waitUrl = `/api/sessions/${first.id}/wait?until=stop&fresh=1&timeout=2000`;
  try {
    const obsolete = app.inject({method: 'GET', url: waitUrl});
    await new Promise(resolve => setTimeout(resolve, 10)); first.setMode('shell');
    expect((await obsolete).json().data.wait).toMatchObject({ended: true, aborted: false, signal: null});
    await first.stop(false); const next = await start({id: first.id}); ctx.sessions.set(next.id, next as never);
    const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION!; expect(token).not.toBe(oldToken);
    const pending = app.inject({method: 'GET', url: waitUrl}); let answered = false;
    void pending.then(() => {answered = true;}); await new Promise(resolve => setTimeout(resolve, 10));
    for (const bad of [undefined, 'wrong', oldToken]) {
      await app.inject({method: 'POST', url: '/api/hook-event', headers: bad ? {'x-reverie-hook-generation': bad} : {},
        payload: {event: 'stop', sessionId: next.id}});
      expect(answered).toBe(false);
    }
    await app.inject({method: 'POST', url: '/api/hook-event', headers: {'x-reverie-hook-generation': token},
      payload: {event: 'stop', sessionId: next.id}});
    expect((await pending).json().data.wait).toMatchObject({signal: 'stop', timedOut: false});
  } finally {await app.close();}
});

function restartTransport(session: Session) {
  const respawn = vi.fn(async (options: {onProviderDispatch?: () => void}) => {options.onProviderDispatch?.(); return 999_999_996;});
  Object.assign(session, {_useMux: true, _muxSession: {sessionId: session.id, muxName: 'synthetic-pane', pid: 999_999_997},
    _mux: {muxSessionExists: () => true, respawnPane: respawn, clearPaneExit: vi.fn()}});
  return respawn;
}
it('validates again before an actual restart and exports a fresh generation only after dispatch', async () => {
  const session = await start(); const old = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const respawn = restartTransport(session);
  expect(await session.restartCli()).toBe(true);
  expect(respawn).toHaveBeenCalledOnce();
  const options = respawn.mock.calls[0][0] as {envOverrides: Record<string, string>};
  const next = options.envOverrides.REVERIE_HOOK_GENERATION;
  expect(next).toBeTruthy(); expect(next).not.toBe(old);
  expect(session.admitHookReport(old)).toBe('refused');
  expect(session.admitHookReport(next)).toBe('current');
  expect(JSON.stringify(session.toState())).not.toContain(next);
});
it('preparation failure leaves the existing provider and its configuration generation untouched', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const respawn = restartTransport(session);
  const settings = join(workspace, '.claude/settings.local.json');
  await writeFile(settings, '{ damaged before restart');
  await expect(session.restartCli()).rejects.toMatchObject({name: 'WorkspaceHookPreparationError'});
  expect(respawn).not.toHaveBeenCalled(); expect(session.admitHookReport(token)).toBe('current');
  expect(await readFile(settings, 'utf8')).toBe('{ damaged before restart');
});
it('refuses restart when original authority changes during awaited preparation', async () => {
  const session = await start(); const respawn = restartTransport(session);
  let checks = 0;
  expect(await session.restartCli(() => ++checks < 2)).toBe(false);
  expect(checks).toBeGreaterThanOrEqual(2); expect(respawn).not.toHaveBeenCalled();
});

it('HTTP refuses restored hook-only waits and releases only hook-dependent input waits on generation change', async () => {
  const active = await start();
  const restored = new Session({workingDir: workspace, id: 'restored-hook-session'}); sessions.push(restored);
  const app = Fastify(); await app.register(cookie); const ctx = createMockRouteContext();
  ctx.sessions.set(active.id, active as never); ctx.sessions.set(restored.id, restored as never);
  registerSessionRoutes(app, ctx as never, {verifiedOwner: trustedFixtureOwner});
  installResponseEnvelope(app); installRouteErrorHandler(app); await app.ready();
  try {
    const refused = await app.inject({method: 'GET', url: `/api/sessions/${restored.id}/wait?until=stop`});
    expect(refused.statusCode).toBe(400); expect(refused.json().error).toContain('unknown');
    expect((await app.inject({method: 'GET', url: `/api/sessions/${restored.id}/wait?until=exit`})).statusCode).toBe(200);
    const ordinary = app.inject({method: 'GET', url: `/api/sessions/${active.id}/wait?until=idle&fresh=1&timeout=2000`});
    const input = app.inject({method: 'POST', url: `/api/sessions/${active.id}/input`,
      payload: {input: 'synthetic input', wait: 'stop', waitTimeout: 2000}});
    await new Promise(resolve => setTimeout(resolve, 15));
    active.setMode('shell');
    expect((await input).json().data.wait).toMatchObject({ended: true, aborted: false, signal: null});
    expect(sessionWaits.signalWaiterCount(active.id)).toBe(1);
    sessionWaits.notifySignal(active.id, 'idle');
    expect((await ordinary).json().data.wait.signal).toBe('idle');
    expect(active.listenerCount('workspaceHookGenerationChanged')).toBe(0);
  } finally {await app.close();}
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function controlledMuxStart(options: {prepared?: boolean; viewer?: boolean} = {}) {
  const dispatched = deferred<{envOverrides: Record<string, string>}>();
  const settlement = deferred<{muxName: string; sessionId: string; pid: number}>();
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => true, isPaneDead: () => false,
    setAttached: vi.fn(), createSession: vi.fn(async (options) => {options.onProviderDispatch?.(); dispatched.resolve(options); return settlement.promise;}),
    respawnPane: vi.fn(async (options) => {options.onProviderDispatch?.(); return 999_999_995;})};
  const proof = await prepareWorkspaceHooks(workspace, 'install', {scaffold: false, enabled: async () => true});
  const session = new Session({workingDir: workspace, workspaceHookPreparation: options.prepared === false ? undefined : proof,
    workerAttachOnly: options.viewer === true, useMux: true, mux: mux as never});
  sessions.push(session);
  let allowed = true;
  const starting = session.startInteractive(() => allowed);
  const dispatch = await dispatched.promise;
  return {session, mux, starting, token: dispatch.envOverrides.REVERIE_HOOK_GENERATION,
    succeed: () => settlement.resolve({muxName: 'synthetic-current-pane', sessionId: session.id, pid: 999_999_997}),
    fail: () => {allowed = false; settlement.reject(new Error('synthetic launch outcome unconfirmed'));}};
}
async function hookHarness(session: Session, principal?: () => AuthUser) {
  const app = Fastify(); await app.register(cookie);
  if (principal) app.addHook('onRequest', async req => {Object.assign(req, {authUser: principal()});});
  const ctx = createMockRouteContext(); ctx.sessions.set(session.id, session as never);
  const controller = {signalStopHook: vi.fn(), signalIdlePrompt: vi.fn(), signalElicitation: vi.fn()};
  ctx.respawnControllers.set(session.id, controller as never);
  registerSessionRoutes(app, ctx as never, {verifiedOwner: trustedFixtureOwner});
  registerHookEventRoutes(app, ctx as never); registerApprovalRoutes(app, ctx as never); installResponseEnvelope(app); installRouteErrorHandler(app); await app.ready();
  return {app, ctx, controller, post: (token: string | undefined, event = 'stop') => app.inject({method: 'POST', url: '/api/hook-event',
    headers: token ? {'x-reverie-hook-generation': token} : {},
    payload: {event, sessionId: session.id, data: {session_id: 'untrusted-predecessor', transcript_path: '/tmp/synthetic-transcript'}}})};
}
it.each(['success', 'failure', 'stop'] as const)('rejects all predecessor mutations during controlled start and after %s', async outcome => {
  const start = await controlledMuxStart();
  const {app, ctx, controller, post} = await hookHarness(start.session);
  const adopt = vi.spyOn(start.session, 'adoptClaudeSessionId');
  const compaction = vi.spyOn(start.session, 'noteCompaction');
  try {
    expect(start.token).toBeTruthy(); expect(start.session.workspaceHookConfiguration).toBe('unknown');
    expect(start.session.admitHookReport(start.token)).toBe('preparing');
    for (const token of [undefined, 'old-generation', start.token])
      for (const event of ['stop', 'prompt_submitted', 'compact_started', 'permission_prompt']) await post(token, event);
    for (const effect of [adopt, compaction, ctx.persistSessionState, ctx.startTranscriptWatcher, ctx.broadcast,
      controller.signalStopHook, controller.signalElicitation]) expect(effect).not.toHaveBeenCalled();
    if (outcome === 'failure') {
      start.fail(); await expect(start.starting).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
    } else {
      if (outcome === 'stop') await start.session.stop(false);
      start.succeed();
      if (outcome === 'stop') await expect(start.starting).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
      else await start.starting;
    }
    if (outcome !== 'success') {
      expect(start.session.admitHookReport(start.token)).toBe('refused');
      for (const event of ['stop', 'prompt_submitted', 'compact_started', 'permission_prompt']) await post(start.token, event);
      for (const effect of [adopt, compaction, ctx.persistSessionState, ctx.startTranscriptWatcher, ctx.broadcast,
        controller.signalStopHook, controller.signalElicitation]) expect(effect).not.toHaveBeenCalled();
    } else {
      expect(start.session.admitHookReport(start.token)).toBe('current');
      await post(start.token, 'prompt_submitted'); expect(adopt).toHaveBeenCalledOnce();
    }
  } finally {await app.close();}
});
it('unchanged same-provider mux reattachment preserves its prepared token and parked wait', async () => {
  const start = await controlledMuxStart(); start.succeed(); await start.starting;
  const originalLease = start.session.captureApprovalProviderLease();
  const wait = sessionWaits.waitForSignal(start.session.id, {until: ['stop'], timeoutMs: 2000});
  let ended = false; void wait.then(() => {ended = true;});
  Object.assign(start.session, {ptyProcess: null, _pid: null}); // Disconnect only the inert client.
  await start.session.startInteractive();
  expect(start.mux.createSession).toHaveBeenCalledOnce(); expect(start.mux.respawnPane).not.toHaveBeenCalled();
  expect(start.session.admitHookReport(start.token)).toBe('current'); expect(ended).toBe(false);
  expect(sessionProviderLeaseCurrent(originalLease, start.session)).toBe(true);
  const {app, post} = await hookHarness(start.session);
  try {await post(start.token); expect((await wait).signal).toBe('stop');} finally {await app.close();}
});
it('explicit restored attachment retains legacy non-wait reports until invalidated, never definitive wait proof', async () => {
  const session = new Session({workingDir: workspace, muxSession: {muxName: 'synthetic-legacy', sessionId: 'synthetic-legacy'} as never});
  sessions.push(session);
  const {app, post} = await hookHarness(session);
  const adopt = vi.spyOn(session, 'adoptClaudeSessionId');
  try {
    expect(session.admitHookReport(undefined)).toBe('legacy-attachment');
    expect(resolveWaitSignals('stop', {mode: 'claude', ...sessionHookOptions(session)}).error).toContain('unknown');
    await post(undefined, 'prompt_submitted'); expect(adopt).toHaveBeenCalledOnce();
    session.setMode('shell'); session.setMode('claude');
    await post(undefined, 'prompt_submitted'); expect(adopt).toHaveBeenCalledOnce();
    expect(session.admitHookReport(undefined)).toBe('refused');
  } finally {await app.close();}
});
it.each([true, false])('controlled respawn success=%s cannot admit old or unsettled reports', async success => {
  const session = await start(); const old = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const reached = deferred<{envOverrides: Record<string, string>}>();
  const settlement = deferred<number | null>();
  const respawn = restartTransport(session);
  respawn.mockImplementation(async options => {options.onProviderDispatch?.(); reached.resolve(options as never); return settlement.promise as never;});
  const {app, ctx, controller, post} = await hookHarness(session);
  const wait = app.inject({method: 'GET', url: `/api/sessions/${session.id}/wait?until=stop&fresh=1&timeout=2000`});
  await vi.waitFor(() => expect(sessionWaits.signalWaiterCount(session.id)).toBe(1));
  const restarting = session.restartCli(); const options = await reached.promise;
  const token = options.envOverrides.REVERIE_HOOK_GENERATION; expect(token).not.toBe(old);
  expect((await wait).json().data.wait.ended).toBe(true);
  const adopt = vi.spyOn(session, 'adoptClaudeSessionId'); const compaction = vi.spyOn(session, 'noteCompaction');
  try {
    for (const value of [old, token]) for (const event of ['stop', 'prompt_submitted', 'compact_started']) await post(value, event);
    for (const effect of [adopt, compaction, ctx.broadcast, controller.signalStopHook]) expect(effect).not.toHaveBeenCalled();
    settlement.resolve(success ? 999_999_994 : null);
    if (success) expect(await restarting).toBe(true);
    else await expect(restarting).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
    expect(session.admitHookReport(old)).toBe('refused');
    expect(session.admitHookReport(token)).toBe(success ? 'current' : 'refused');
    if (!success) {
      await post(token, 'prompt_submitted'); expect(adopt).not.toHaveBeenCalled();
    }
  } finally {await app.close();}
});

it('an owned preparing/fenced provider cannot answer a legacy inbox item through unknown configuration', async () => {
  const start = await controlledMuxStart();
  const {app} = await hookHarness(start.session);
  const write = vi.spyOn(start.session, 'write');
  const item = approvalInbox.notePrompt({sessionId: start.session.id, sessionName: 'Synthetic', kind: 'permission',
    capture: () => 'Claude needs your permission\n1. Yes\n2. No'});
  try {
    const answer = () => app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    expect((await answer()).statusCode).toBe(409); expect(write).not.toHaveBeenCalled();
    start.fail(); await expect(start.starting).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
    expect((await answer()).statusCode).toBe(409); expect(write).not.toHaveBeenCalled();
  } finally {await app.close();}
});

it.each(['mode', 'restart', 'stop', 'replacement', 'copied'] as const)('approval lease stays held after %s, without rebinding or typing', async change => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const {app, ctx, post} = await hookHarness(session);
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    expect(approvalInbox.providerCurrent(item, session)).toBe(true);
    expect(JSON.stringify(item)).not.toContain(token); expect(item).not.toHaveProperty('providerLease');
    if (change === 'mode') {session.setMode('shell'); session.setMode('claude');}
    if (change === 'restart') {restartTransport(session); expect(await session.restartCli()).toBe(true);}
    if (change === 'stop') await session.stop(false);
    if (change === 'replacement') {
      const next = new Session({id: session.id, workingDir: workspace, muxSession: {sessionId: session.id, muxName: 'replacement'} as never});
      sessions.push(next); ctx.sessions.set(session.id, next as never);
    }
    if (change === 'copied') {approvalInbox.take(item.id); approvalInbox.restore(JSON.parse(JSON.stringify(item)));}
    const listed = (await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals;
    expect(listed).toHaveLength(1); expect(listed[0]).toMatchObject({id: item.id, answerState: 'held'});
    expect(listed[0].heldReason).toContain('current provider');
    const answer = await app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    expect(answer.statusCode).toBe(409); expect(answer.json().error).toContain('not bound');
    expect(transport.writes).toHaveLength(0); expect(approvalInbox.getForSession(session.id)).toBeDefined();
  } finally {await app.close();}
});
it('a current approval reaches exactly one physical key under its original private lease', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const {app, post} = await hookHarness(session);
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    const answer = await app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    expect(answer.statusCode).toBe(200); expect(transport.writes).toEqual(['1']);
  } finally {await app.close();}
});
it('revocation during actual capture cannot bind predecessor consent to a successor epoch', async () => {
  const session = await start(); const originalLease = session.captureApprovalProviderLease();
  const previous = approvalInbox.notePrompt({sessionId: session.id, sessionName: 'Synthetic', kind: 'permission', providerLease: originalLease});
  const refused = approvalInbox.notePrompt({sessionId: session.id, sessionName: 'Synthetic', kind: 'permission', providerLease: originalLease,
    capture: () => {session.setMode('shell'); session.setMode('claude'); return '1. Yes\n2. No';}});
  expect(refused).toBeUndefined(); expect(approvalInbox.getForSession(session.id)).toBe(previous);
  expect(approvalInbox.providerCurrent(previous!, session)).toBe(false);
});
it('revocation while a mux write awaits I/O blocks the physical key and reports no-replay uncertainty', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  restartTransport(session);
  const ready = deferred<void>(), resume = deferred<void>();
  Object.assign((session as unknown as {_mux: object})._mux, {sendInput: async (_id: string, data: string, options: {admitted: () => boolean}) => {
    ready.resolve(); await resume.promise; if (!options.admitted()) return false; transport.writes.push(data); return true;
  }});
  const {app, post} = await hookHarness(session);
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    const answering = app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    await ready.promise; session.setMode('shell'); resume.resolve();
    const answer = await answering; expect(answer.statusCode).toBe(409);
    expect(answer.json().error).toContain('unconfirmed'); expect(answer.json().error.toLowerCase()).toContain('do not replay');
    expect(transport.writes).toHaveLength(0); expect(approvalInbox.getForSession(session.id)).toBeDefined();
  } finally {await app.close();}
});
it('a physical key followed by invalidation is unconfirmed, held, and never replayed', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const client = (session as unknown as {ptyProcess: {write(data: string): void}}).ptyProcess;
  vi.spyOn(client, 'write').mockImplementation(data => {transport.writes.push(data); session.setMode('shell');});
  const {app, post} = await hookHarness(session);
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    const answer = await app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    expect(answer.statusCode).toBe(409); expect(answer.json().error).toContain('unconfirmed');
    expect(answer.json().error).not.toContain('nothing was typed'); expect(answer.json().error.toLowerCase()).toContain('do not replay');
    expect(transport.writes).toEqual(['1']);
    const retry = await app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    expect(retry.statusCode).toBe(409); expect(transport.writes).toEqual(['1']);
  } finally {await app.close();}
});
it('a newly started provider becoming busy does not revoke its settled original restart authority', async () => {
  const session = await start(); Object.assign(session, {_status: 'idle'}); const respawn = restartTransport(session);
  respawn.mockImplementation(async options => {
    expect((options as {admitted: () => boolean}).admitted()).toBe(true);
    options.onProviderDispatch?.();
    Object.assign(session, {_status: 'busy'}); return 999_999_991;
  });
  expect(await session.restartCli(() => true, () => !session.isBusy())).toBe(true);
  const options = respawn.mock.calls[0][0] as {envOverrides: Record<string, string>};
  expect(session.admitHookReport(options.envOverrides.REVERIE_HOOK_GENERATION)).toBe('current');
});
it('work starting during restart preparation refuses dispatch without changing the working provider proof', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const respawn = restartTransport(session); let checks = 0;
  expect(await session.restartCli(() => true, () => ++checks < 2)).toBe(false);
  expect(respawn).not.toHaveBeenCalled(); expect(session.admitHookReport(token)).toBe('current');
});

it('same-SID cross-owner and missing-proof approval APIs never expose predecessor prompts to the successor', async () => {
  const previousMulti = process.env.REVERIE_MULTIUSER; process.env.REVERIE_MULTIUSER = '1';
  const session = await start({owner: 'alice'}); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  let actor: AuthUser = {username: 'alice', role: 'user'};
  const {app, ctx, post} = await hookHarness(session, () => actor);
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    const next = new Session({id: session.id, owner: 'bob', workingDir: workspace, muxSession: {sessionId: session.id, muxName: 'successor'} as never});
    sessions.push(next); ctx.sessions.set(session.id, next as never);
    for (const username of ['alice', 'bob']) {
      actor = {username, role: 'user'};
      expect((await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals).toEqual([]);
      expect((await app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}})).statusCode).toBe(404);
    }
    actor = {username: 'root', role: 'admin'};
    const held = (await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals;
    expect(held).toHaveLength(1); expect(held[0].answerState).toBe('held'); expect(held[0]).not.toHaveProperty('providerLease');
    approvalInbox.take(item.id); approvalInbox.restore(JSON.parse(JSON.stringify(item)));
    actor = {username: 'bob', role: 'user'};
    expect((await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals).toEqual([]);
    actor = {username: 'root', role: 'admin'};
    expect((await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals[0]).toMatchObject({answerState: 'held'});
    expect(transport.writes).toHaveLength(0);
  } finally {await app.close(); if (previousMulti === undefined) delete process.env.REVERIE_MULTIUSER; else process.env.REVERIE_MULTIUSER = previousMulti;}
});
it('actual server SSE callbacks keep predecessor and missing-proof prompt bodies admin-held after SID reuse', async () => {
  const previousMulti = process.env.REVERIE_MULTIUSER; process.env.REVERIE_MULTIUSER = '1';
  const callbacks = {pending: approvalInbox.onPending, updated: approvalInbox.onUpdated, resolved: approvalInbox.onResolved};
  const server = new WebServer(0, false, true) as unknown as {sessions: Map<string, Session>; sse: SseStreamManager; cleanup: CleanupManager; mux: {destroy(): void}};
  const original = new Session({id: 'synthetic-sse-provider', workingDir: workspace, owner: 'alice',
    muxSession: {sessionId: 'synthetic-sse-provider', muxName: 'original'} as never}); sessions.push(original);
  server.sessions.set(original.id, original);
  const client = (username: string, role: 'admin' | 'user') => {
    const frames: string[] = []; const reply = {raw: {write: (frame: string) => {frames.push(frame); return true;}}};
    server.sse.addClient(reply as never, null, false, undefined, {username, role}); return frames;
  };
  const alice = client('alice', 'user'), bob = client('bob', 'user'), admin = client('root', 'admin');
  try {
    const item = approvalInbox.notePrompt({sessionId: original.id, sessionName: 'Synthetic', kind: 'permission',
      message: 'synthetic predecessor private prompt', providerLease: original.captureApprovalProviderLease()})!;
    expect(alice.join('')).toContain('synthetic predecessor private prompt'); expect(bob).toHaveLength(0);
    alice.length = bob.length = admin.length = 0;
    const next = new Session({id: original.id, owner: 'bob', workingDir: workspace}); sessions.push(next); server.sessions.set(next.id, next);
    approvalInbox.onUpdated?.(item);
    expect(alice).toHaveLength(0); expect(bob).toHaveLength(0);
    expect(admin.join('')).toContain('"answerState":"held"'); expect(admin.join('')).not.toContain('providerLease');
    alice.length = bob.length = admin.length = 0;
    approvalInbox.take(item.id); const copied = JSON.parse(JSON.stringify(item)); approvalInbox.restore(copied);
    const prompts = (frames: string[]) => frames.filter(frame => /event: approval:(pending|updated)/.test(frame));
    expect(prompts(alice)).toHaveLength(0); expect(prompts(bob)).toHaveLength(0);
    expect(prompts(admin).join('')).toContain('"answerState":"held"');
  } finally {
    server.cleanup.dispose(); server.mux.destroy();
    approvalInbox.onPending = callbacks.pending; approvalInbox.onUpdated = callbacks.updated; approvalInbox.onResolved = callbacks.resolved;
    if (previousMulti === undefined) delete process.env.REVERIE_MULTIUSER; else process.env.REVERIE_MULTIUSER = previousMulti;
  }
});
it.each(['false', 'throw'] as const)('same-epoch partial %s becomes sticky unconfirmed consent rather than retry authority', async failure => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const {app, post} = await hookHarness(session);
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    const original = JSON.stringify(item);
    const writer = vi.spyOn(session, 'writeViaMux').mockImplementation(async data => {
      transport.writes.push(data);
      if (failure === 'throw') throw new Error('synthetic partial I/O failure');
      return false;
    });
    const answer = () => app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    const first = await answer(); expect(first.statusCode).toBe(422); expect(first.json().error).toContain('unconfirmed');
    expect(first.json().error).not.toContain('no answer was sent'); expect(first.json().error).toContain('Do not replay');
    expect(session.admitHookReport(token)).toBe('current'); expect(approvalInbox.providerCurrent(item, session)).toBe(true);
    expect(approvalInbox.getForSession(session.id)).toBe(item); expect(JSON.stringify(item)).toBe(original);
    const held = (await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals[0];
    expect(held).toMatchObject({id: item.id, answerState: 'held'}); expect(held.heldReason).toContain('unconfirmed');
    expect((await answer()).statusCode).toBe(409); expect(writer).toHaveBeenCalledOnce(); expect(transport.writes).toEqual(['1']);
    await post(token, 'permission_prompt');
    expect(approvalInbox.getForSession(session.id)).toBe(item);
    expect(approvalInbox.answerStatus(item, session).answerState).toBe('held');
    expect((await answer()).statusCode).toBe(409); expect(writer).toHaveBeenCalledOnce();
    await post(token, 'stop'); await post(token, 'permission_prompt');
    const fresh = approvalInbox.getForSession(session.id)!;
    expect(fresh.id).not.toBe(item.id); expect(approvalInbox.answerStatus(fresh, session).answerState).toBe('current');
  } finally {await app.close();}
});
it('an admin cannot reuse predecessor consent after the same Session object changes owner', async () => {
  const session = await start({owner: 'alice'}); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const {app, post} = await hookHarness(session, () => ({username: 'root', role: 'admin'}));
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    session.owner = 'bob';
    expect(approvalInbox.providerCurrent(item, session)).toBe(false);
    expect(approvalInbox.originalOwner(item)).toEqual({owner: 'alice'});
    const response = await app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    expect(response.statusCode).toBe(409); expect(transport.writes).toHaveLength(0);
    expect((await app.inject({method: 'GET', url: '/api/approvals'})).json().data.approvals[0].answerState).toBe('held');
  } finally {await app.close();}
});

it('failed owned dispatch followed by same-pane attachment stays fenced instead of becoming legacy', async () => {
  const start = await controlledMuxStart();
  vi.mocked(spawnPty).mockImplementationOnce(() => {throw new Error('synthetic viewer attach failed');});
  start.succeed(); await expect(start.starting).rejects.toMatchObject({name: 'ProviderDispatchUnconfirmedError', cause: {message: 'synthetic viewer attach failed'}});
  expect(start.session.admitHookReport(undefined)).toBe('refused'); expect(start.session.admitHookReport(start.token)).toBe('refused');
  await start.session.startInteractive();
  expect(start.mux.createSession).toHaveBeenCalledOnce(); expect(start.mux.respawnPane).not.toHaveBeenCalled();
  expect(start.session.admitHookReport(undefined)).toBe('refused'); expect(start.session.admitHookReport(start.token)).toBe('refused');
  const {app, post} = await hookHarness(start.session); const adopt = vi.spyOn(start.session, 'adoptClaudeSessionId');
  try {await post(undefined, 'prompt_submitted'); await post(start.token, 'prompt_submitted'); expect(adopt).not.toHaveBeenCalled();}
  finally {await app.close();}
});
it.each(['busy', 'authority'] as const)('known pre-effect %s refusal preserves working provider epoch, conversation and parked wait', async reason => {
  const session = await start(); Object.assign(session, {_status: 'idle'});
  const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION; const conversation = session.claudeSessionId;
  const respawn = restartTransport(session); const reached = deferred<{envOverrides: Record<string, string>; admitted(): boolean; onProviderDispatch(): void}>();
  const release = deferred<void>(); let authority = true;
  respawn.mockImplementation(async options => {
    reached.resolve(options as never); await release.promise;
    if (!(options as {admitted(): boolean}).admitted()) return null as never;
    options.onProviderDispatch?.(); return 999_999_989;
  });
  const {app, post} = await hookHarness(session);
  try {
    const waiting = app.inject({method: 'GET', url: `/api/sessions/${session.id}/wait?until=stop&fresh=1&timeout=2000`});
    await vi.waitFor(() => expect(sessionWaits.signalWaiterCount(session.id)).toBe(1));
    const restarting = session.restartCli(() => authority, () => !session.isBusy()); const options = await reached.promise;
    expect(options.envOverrides.REVERIE_HOOK_GENERATION).not.toBe(token);
    expect(session.admitHookReport(token)).toBe('current'); expect(sessionWaits.signalWaiterCount(session.id)).toBe(1);
    if (reason === 'busy') Object.assign(session, {_status: 'busy'}); else authority = false;
    release.resolve(); expect(await restarting).toBe(false);
    expect(session.admitHookReport(token)).toBe('current'); expect(session.claudeSessionId).toBe(conversation);
    expect(() => options.onProviderDispatch()).toThrow('already settled');
    expect(session.admitHookReport(token)).toBe('current');
    await post(token); expect((await waiting).json().data.wait.signal).toBe('stop');
  } finally {await app.close();}
});

it.each(['null', 'throw'] as const)('holds uncertain dispatched provider without a second launch (%s)', async outcome => {
  const session = await start(); const originalPid = session.pid;
  const respawn = restartTransport(session);
  respawn.mockImplementation(async options => {
    options.onProviderDispatch?.();
    if (outcome === 'throw') throw new Error('synthetic partial command');
    return null as never;
  });
  await expect(session.restartCli()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(session.providerDispatchHeld).toBe(true); expect(session.pid).toBe(originalPid);
  const saved = JSON.parse(JSON.stringify(session.toState())); expect(saved.providerDispatchHeld).toBe(true);
  expect(await session.writeViaMux('do not send\r')).toBe(false);
  await expect(session.restartCli()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(respawn).toHaveBeenCalledOnce();
  const mode = session.mode;
  expect(() => session.configureRuntime({mode: 'shell', sourceKey: 'local', env: {}})).toThrow(ProviderDispatchUnconfirmedError);
  expect(session.mode).toBe(mode);
  // Public DTO values are deny-only and cannot clear an existing private hold.
  Object.assign(saved, {providerDispatchHeld: false});
  await WebServer.prototype.reapplyPersistedSessionState.call({} as WebServer, session, saved, 'before-spawn');
  expect(session.providerDispatchHeld).toBe(true);
  const restored = new Session({workingDir: workspace, providerDispatchHeld: true}); sessions.push(restored);
  expect(restored.providerDispatchHeld).toBe(true);
  expect(await restored.writeViaMux('do not send\r')).toBe(false);
});

it('concurrent duplicate hook cannot recreate consent while the first physical answer awaits', async () => {
  const session = await start(); const token = transport.envs.at(-1)!.REVERIE_HOOK_GENERATION;
  const {app, post} = await hookHarness(session);
  const attempted = deferred<void>(), complete = deferred<boolean>();
  try {
    await post(token, 'permission_prompt'); const item = approvalInbox.getForSession(session.id)!;
    const writer = vi.spyOn(session, 'writeViaMux').mockImplementation(async data => {
      transport.writes.push(data); attempted.resolve(); return complete.promise;
    });
    const answer = () => app.inject({method: 'POST', url: `/api/approvals/${encodeURIComponent(item.id)}/answer`, payload: {action: 'approve'}});
    const first = answer(); void first.then(() => {}); await attempted.promise;
    expect(approvalInbox.getForSession(session.id)).toBeUndefined();
    await post(token, 'permission_prompt'); expect(approvalInbox.getForSession(session.id)).toBeUndefined();
    expect((await answer()).statusCode).toBe(404);
    complete.resolve(false); expect((await first).statusCode).toBe(422);
    expect(approvalInbox.getForSession(session.id)).toBe(item);
    await post(token, 'permission_prompt'); expect(approvalInbox.getForSession(session.id)).toBe(item);
    expect((await answer()).statusCode).toBe(409); expect(writer).toHaveBeenCalledOnce();
    vi.spyOn(Date, 'now').mockReturnValue(item.createdAt + 24 * 60 * 60 * 1000);
    expect(approvalInbox.listPending()).toContain(item);
  } finally {complete.resolve(false); await app.close();}
});

it.each(['create', 'quick-start'] as const)('HTTP %s retains the exact uncertain Session without cleanup or another launch', async route => {
  const app = Fastify(); await app.register(cookie); const ctx = createMockRouteContext({agentSkillEnabled: false});
  const created: Session[] = [];
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => true, isPaneDead: () => false,
    setAttached: vi.fn(), clearPaneExit: vi.fn(), setHistoryLimit: vi.fn(),
    createSession: vi.fn(async (options: {sessionId: string; onProviderDispatch?: () => void}) => {
      options.onProviderDispatch?.();
      return {sessionId: options.sessionId, muxName: 'synthetic-retained-pane', pid: 999_999_993};
    })};
  Object.assign(ctx, {mux});
  ctx.setupSessionListeners.mockImplementation(async value => {
    const session = value as unknown as Session; created.push(session); sessions.push(session);
    session.on('error', () => {});
    // Ordinary create does not launch itself. Its listener boundary is forced
    // through the same real owned start solely to exercise its error catch.
    if (route === 'create') await session.startInteractive();
  });
  vi.mocked(spawnPty).mockImplementationOnce(() => {throw new Error('synthetic attachment failure after provider dispatch');});
  registerSessionRoutes(app, ctx as never, {verifiedOwner: trustedFixtureOwner});
  installResponseEnvelope(app); installRouteErrorHandler(app); await app.ready();
  const caseName = 'synthetic-held-' + route;
  try {
    const response = await app.inject({method: 'POST', url: route === 'create' ? '/api/sessions' : '/api/quick-start',
      payload: route === 'create' ? {workingDir: workspace, mode: 'claude'} : {caseName, mode: 'claude'}});
    expect(response.statusCode, response.body).toBe(409);
    const held = created[0]; expect(held).toBeInstanceOf(Session);
    expect(response.json()).toMatchObject({recoveryRequired: true, sessionId: held.id, replacementClaim: 'not-applicable'});
    expect(response.json().reconciliation).toContain('not implemented');
    expect(ctx.sessions.get(held.id)).toBe(held); expect(held.providerDispatchHeld).toBe(true);
    expect((held as unknown as {_muxSession: {pid: number}})._muxSession).toMatchObject({pid: 999_999_993});
    expect(ctx.cleanupSession).not.toHaveBeenCalled(); expect(mux.createSession).toHaveBeenCalledOnce();
    expect(ctx.persistSessionStateNow).toHaveBeenCalledWith(held);
    const input = await app.inject({method: 'POST', url: `/api/sessions/${held.id}/input`, payload: {input: 'do not send'}});
    expect(input.statusCode).toBe(409); expect(input.json().error).toContain('unconfirmed');
    const spawns = vi.mocked(spawnPty).mock.calls.length;
    const run = await app.inject({method: 'POST', url: `/api/sessions/${held.id}/run`, payload: {prompt: 'do not launch'}});
    expect(run.statusCode).toBe(409); expect(run.json().error).toContain('unconfirmed');
    await expect(held.runPrompt('do not launch')).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
    expect(vi.mocked(spawnPty)).toHaveBeenCalledTimes(spawns);
    expect(ctx.broadcast.mock.calls.some(([event]) => event === 'session:running')).toBe(false);
    await expect(held.restartCli()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
    expect(mux.createSession).toHaveBeenCalledOnce();
  } finally {await app.close(); if (route === 'quick-start') await rm(join(CASES_DIR, caseName), {recursive: true, force: true});}
});

it('restored uncertain legacy metadata cannot admit reports or consent but still permits read-only attachment', async () => {
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => true, isPaneDead: () => false,
    setAttached: vi.fn(), createSession: vi.fn(), respawnPane: vi.fn()};
  const session = new Session({workingDir: workspace, providerDispatchHeld: true, useMux: true, mux: mux as never,
    muxSession: {sessionId: 'synthetic-held-restore', muxName: 'synthetic-existing-pane', pid: 999_999_990} as never});
  sessions.push(session);
  expect(session.admitHookReport(undefined)).toBe('refused'); expect(session.captureApprovalProviderLease()).toBeUndefined();
  const {app, ctx, post} = await hookHarness(session);
  const adopt = vi.spyOn(session, 'adoptClaudeSessionId');
  try {
    await post(undefined, 'permission_prompt'); await post(undefined, 'prompt_submitted');
    expect(approvalInbox.getForSession(session.id)).toBeUndefined(); expect(adopt).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    await session.startInteractive();
    expect(session.providerDispatchHeld).toBe(true); expect(session.pid).toBe(999_999_997);
    expect(mux.createSession).not.toHaveBeenCalled(); expect(mux.respawnPane).not.toHaveBeenCalled();
    expect(session.admitHookReport(undefined)).toBe('refused'); expect(session.captureApprovalProviderLease()).toBeUndefined();
  } finally {await app.close();}
});
it.each(['create', 'quick-start'] as const)('EID-bound HTTP %s retains the original replacement claim after unknown launch', async route => {
  const app = Fastify(); await app.register(cookie); const ctx = createMockRouteContext({agentSkillEnabled: false});
  const store = new CompanyStore(join(workspace, 'synthetic-company.json')); await store.init();
  const rooms = new ChatroomStore();
  const company = new CompanyService(store, {getSession: id => ctx.sessions.get(id), chatrooms: {
    rooms: () => rooms.list(), room: id => rooms.get(id),
    addMember: (id, sid, options) => rooms.addMember(id, sid, options).member},
    research: {start: vi.fn(), inspect: vi.fn(), stop: vi.fn()}} as never);
  const employee = await company.hire({name: 'Synthetic Engineer', icon: '🔬', position: 'Engineer', expertise: ['testing'],
    sessionId: 'test-session-1', researchEnabled: false} as never);
  await company.setDesiredRunning('test-session-1', false);
  const complete = vi.spyOn(company, 'completeSpawn');
  const reached = deferred<void>(), finish = deferred<void>();
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => true, isPaneDead: () => false,
    setAttached: vi.fn(), clearPaneExit: vi.fn(), setHistoryLimit: vi.fn(),
    createSession: vi.fn(async (options: {sessionId: string; onProviderDispatch?: () => void}) => {
      options.onProviderDispatch?.(); reached.resolve(); await finish.promise;
      return {sessionId: options.sessionId, muxName: 'synthetic-employee-pane', pid: 999_999_989};})};
  Object.assign(ctx, {mux});
  const created: Session[] = [];
  ctx.setupSessionListeners.mockImplementation(async value => {
    const session = value as unknown as Session; created.push(session); sessions.push(session);
    if (route === 'create') await session.startInteractive();
  });
  vi.mocked(spawnPty).mockImplementationOnce(() => {throw new Error('synthetic attach failure after launch');});
  registerSessionRoutes(app, ctx as never, {company, verifiedOwner: trustedFixtureOwner});
  installResponseEnvelope(app); installRouteErrorHandler(app); await app.ready();
  const caseName = 'synthetic-employee-held-' + route;
  const request = () => app.inject({method: 'POST', url: route === 'create' ? '/api/sessions' : '/api/quick-start',
    payload: {employeeId: employee.id, mode: 'claude', ...(route === 'create' ? {workingDir: workspace} : {caseName})}});
  try {
    const pending = request(); void pending.then(() => {}); await reached.promise;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000);
    const during = await request(); expect(during.statusCode).toBe(409);
    expect(during.json().error).toContain('already being replaced');
    expect(mux.createSession).toHaveBeenCalledOnce(); expect(ctx.cleanupSession).not.toHaveBeenCalled();
    finish.resolve(); const first = await pending; expect(first.statusCode, first.body).toBe(409);
    const held = created[0]; expect(first.json()).toMatchObject({recoveryRequired: true, replacementClaim: 'held', employeeId: employee.id,
      sessionId: held.id, replacesSessionId: 'test-session-1'});
    const binding = store.snapshot().employees.find(row => row.id === employee.id)!;
    expect(binding.sessionId).toBe('test-session-1'); expect(held.providerDispatchHeld).toBe(true);
    const second = await request(); expect(second.statusCode).toBe(409); expect(second.json().error).toContain('already being replaced');
    expect(store.snapshot().employees.find(row => row.id === employee.id)).toEqual(binding);
    expect(complete).not.toHaveBeenCalled(); expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.sessions.get(held.id)).toBe(held); expect(mux.createSession).toHaveBeenCalledOnce(); expect(created).toHaveLength(1);
  } finally {finish.resolve(); await app.close(); if (route === 'quick-start') await rm(join(CASES_DIR, caseName), {recursive: true, force: true});}
});

it('positive initial adapter result without physical dispatch proof is held and never treated as prepared', async () => {
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => true, isPaneDead: () => false,
    setAttached: vi.fn(), createSession: vi.fn(async (options: {sessionId: string}) =>
      ({sessionId: options.sessionId, muxName: 'synthetic-unproved-pane', pid: 999_999_988})), respawnPane: vi.fn()};
  const proof = await prepareWorkspaceHooks(workspace, 'install', {scaffold: false, enabled: async () => true});
  const session = new Session({workingDir: workspace, workspaceHookPreparation: proof, useMux: true, mux: mux as never});
  sessions.push(session);
  await expect(session.startInteractive()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(session.providerDispatchHeld).toBe(true); expect(session.workspaceHookConfiguration).toBe('unknown');
  expect(session.admitHookReport(undefined)).toBe('refused'); expect(session.captureApprovalProviderLease()).toBeUndefined();
  expect(await session.writeViaMux('do not send\r')).toBe(false);
  expect(mux.createSession).toHaveBeenCalledOnce(); expect(mux.respawnPane).not.toHaveBeenCalled();
});

it('held owned remote recovery never issues a respawn command', async () => {
  const respawn = vi.fn();
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => true, respawnPane: respawn};
  const session = new Session({workingDir: workspace, providerDispatchHeld: true, useMux: true, mux: mux as never,
    remote: {hostId: 'synthetic-remote', label: 'Synthetic remote', host: '192.0.2.1', owned: true},
    muxSession: {sessionId: 'synthetic-remote-session', muxName: 'synthetic-remote-pane', pid: 999_999_987} as never});
  sessions.push(session);
  expect(await session.reattachRemote()).toBe(false); expect(respawn).not.toHaveBeenCalled();
  expect(session.providerDispatchHeld).toBe(true); expect(session.captureApprovalProviderLease()).toBeUndefined();
});

it.each((['interactive', 'shell', 'restart', 'run'] as const).flatMap(action => [true, false].map(exists => ({action, exists}))))('restored held $action entry preserves original metadata (mux exists=$exists)', async ({action, exists}) => {
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: () => exists, isPaneDead: () => true,
    setAttached: vi.fn(), createSession: vi.fn(), respawnPane: vi.fn()};
  const session = new Session({workingDir: workspace, providerDispatchHeld: true, useMux: true, mux: mux as never,
    muxSession: {sessionId: 'synthetic-denied-' + action, muxName: 'synthetic-denied-pane', pid: 999_999_986} as never});
  sessions.push(session); const count = vi.mocked(spawnPty).mock.calls.length;
  const result = action === 'interactive' ? session.startInteractive() : action === 'shell' ? session.startShell()
    : action === 'restart' ? session.restartCli() : session.runPrompt('do not launch');
  await expect(result).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(mux.createSession).not.toHaveBeenCalled(); expect(mux.respawnPane).not.toHaveBeenCalled();
  expect(vi.mocked(spawnPty)).toHaveBeenCalledTimes(count); expect(session.providerDispatchHeld).toBe(true);
  expect((session as unknown as {_muxSession: {pid: number}})._muxSession).toMatchObject({pid: 999_999_986});
});

it('held attachment preserves the original subject when consecutive mux observations disagree', async () => {
  let observations = 0;
  const mux = {isAvailable: () => true, backend: 'tmux', muxSessionExists: vi.fn(() => ++observations === 1),
    isPaneDead: () => false, setAttached: vi.fn(), createSession: vi.fn(), respawnPane: vi.fn()};
  const original = {sessionId: 'synthetic-changing-observation', muxName: 'synthetic-original-pane', pid: 999_999_984};
  const session = new Session({workingDir: workspace, providerDispatchHeld: true, useMux: true, mux: mux as never, muxSession: original as never});
  sessions.push(session);
  await expect(session.startInteractive()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(mux.muxSessionExists).toHaveBeenCalledTimes(2);
  expect((session as unknown as {_muxSession: object})._muxSession).toBe(original);
  expect(mux.createSession).not.toHaveBeenCalled(); expect(mux.respawnPane).not.toHaveBeenCalled();
});
