/** Actual owner/Company/PlanMoves/Session stores and private IPC.
 * The host/kernel boundary is an owned controlled wire fixture, NOT a native
 * receipt or installed-authority proof. No provider or engine is contacted.
 */
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {createServer, type Server, type Socket} from 'node:net';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {chmod, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {ChatroomService} from '../src/chatroom-service.js';
import {PlanService, type PlanAccount} from '../src/plan-accounts.js';
import {PlanMoves, type PlanMovePort, type PlanMoveRecord} from '../src/plan-move.js';
import {PlanMoveStore} from '../src/plan-move-store.js';
import {Session} from '../src/session.js';
import {expertRuntimeRecipe} from '../src/expert-runtime-recipe.js';
import {OwnerAuthStore} from '../src/owner-auth/store.js';
import {OwnerAuthService} from '../src/owner-auth/service.js';
import {ResourceReplacementController, registerResourceReplacementRoutes} from '../src/resource-replacement-controller.js';
import {buildSpawnCommand} from '../src/tmux-manager.js';
import {workerLaunchCommand} from '../src/worker-execution.js';
import type {SessionPort} from '../src/web/ports/session-port.js';
import type {TerminalMultiplexer, CreateSessionOptions, MuxSession} from '../src/mux-interface.js';

let directory: string, path: string, app: FastifyInstance, server: Server, auth: OwnerAuthService, token: string;
let company: CompanyService, companyStore: CompanyStore, chat: ChatroomService, source: Session;
let sessions: Map<string, Session>, moves: PlanMoves, journal: PlanMoveStore, controller: ResourceReplacementController;
let child: ChildProcess, peers: Set<Socket>, verbs: string[], handoffs: string[], candidateCommands: string[];
let eid: string, draft: Record<string, unknown>, reference: string, options: Map<string, MuxSession>;
let rejectAt: string | undefined;
let nativeSettled: boolean;
let occupyCandidate: boolean, composerBodies: Map<string, string>, handoffScreens: string[], handoffMuxCalls: string[];
const codexPane = (body: string) => `› ${body}\n\nGPT-6.1-Sol high · /owned/resource-fixture\n? for shortcuts`;
let restartController: () => Promise<void>;
type Frame = Record<string, unknown>;
const encoded = (value: unknown) => {const raw = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length); return Buffer.concat([header, raw]);};
const headers = () => ({host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token});
const post = (kind: string, payload: unknown, extra = {}) => app.inject({method: 'POST',
  url: '/api/company/resources/' + kind, headers: {...headers(), ...extra}, payload});
async function until<T>(action: () => Promise<T>, complete: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 12_000;
  while (true) {const result = await action(); if (complete(result)) return result;
    if (Date.now() >= end) throw new Error('Owned source transaction did not settle');
    await new Promise(resolve => setTimeout(resolve, 25));}
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-flow-')); path = join(directory, 'own.sock');
  auth = new OwnerAuthService({store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'owner-audit.jsonl'), setupEnabled: true});
  token = await auth.setup('FixtureOwner', 'Quasar!fixture-8-passphrase', 'Quasar!fixture-8-passphrase', '127.0.0.1');
  sessions = new Map(); options = new Map(); peers = new Set(); verbs = []; handoffs = []; candidateCommands = [];
  rejectAt = undefined; nativeSettled = false;
  occupyCandidate = false; composerBodies = new Map(); handoffScreens = []; handoffMuxCalls = [];
  // Harmless OWN child supplies a real start identity for the existing normal
  // process-survivor checks. Only this exact fixture child is ever terminated.
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  await once(child, 'spawn');
  const mux = new Proxy({backend: 'tmux',
    getSession: (id: string) => options.get(id),
    isPaneDead: (name: string) => ![...options.values()].some(row => row.muxName === name),
    createSession: async (value: CreateSessionOptions) => {
      expect(verbs).toContain('source-stop');
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      // These are the actual shared spawn/worker command builders. The fixture
      // records their result, and executes neither that command nor a CLI.
      const command = buildSpawnCommand(value);
      candidateCommands.push(workerLaunchCommand(command, value.workingDir, value.sessionId, false, value.workerResourceLaunch));
      const row = {sessionId: value.sessionId, muxName: 'fixture-' + value.sessionId.slice(0,8), pid: 654,
        createdAt: Date.now(), workingDir: value.workingDir, mode: value.mode, attached: false};
      options.set(value.sessionId, row); return row;
    },
    capturePaneText: (name: string) => {
      const row = [...options.values()].find(row => row.muxName === name);
      const body = row && composerBodies.has(row.sessionId) ? composerBodies.get(row.sessionId)! :
        (name.startsWith('fixture-') && occupyCandidate ? 'existing owner draft' : '');
      return codexPane(body);
    },
    sendInput: async (id: string, text: string, writeOptions?: {requireEmptyComposer?: boolean}) => {
      handoffMuxCalls.push(id); expect(writeOptions?.requireEmptyComposer).toBe(true);
      expect(composerBodies.get(id) ?? (occupyCandidate ? 'existing owner draft' : '')).toBe('');
      handoffs.push(text); composerBodies.set(id, text.replace(/\r/g, ''));
      handoffScreens.push(codexPane(composerBodies.get(id)!));
      // sendInput models the actual mux's text/Enter transaction; the returned
      // rendered pane now confirms the owned handoff left the composer.
      await Promise.resolve(); composerBodies.set(id, ''); handoffScreens.push(codexPane(''));
      return true;
    },
    killSession: async (id: string) => {options.delete(id); return true;},
    setAttached: () => {}, getPaneCurrentCommand: () => 'codex', getSessionName: () => 'owned-pane',
  }, {get(target, name) {if (name in target) return target[name as keyof typeof target];
    return () => {throw new Error('UNDECLARED_NATIVE_MUX_PORT:' + String(name));};}}) as unknown as TerminalMultiplexer;
  source = new Session({id: randomUUID(), name: 'Worker', mode: 'codex', workingDir: directory,
    mux, useMux: true, codexConfig: {model: 'fixture-model', reasoningEffort: 'high', renderMode: 'hybrid'}});
  vi.spyOn(source, 'pid', 'get').mockImplementation(() => child.exitCode === null && child.signalCode === null ? child.pid! : null);
  vi.spyOn(source, 'muxName', 'get').mockReturnValue('source-pane');
  sessions.set(source.id, source);
  options.set(source.id, {sessionId: source.id, muxName: 'source-pane', pid: child.pid!, createdAt: 1,
    workingDir: directory, mode: 'codex', attached: false});
  chat = new ChatroomService({file: join(directory, 'chat.json'), getSession: id => sessions.get(id), broadcast: () => {}});
  await chat.init(); chat.delivery.stop();
  companyStore = new CompanyStore(join(directory, 'company.json')); await companyStore.init();
  company = new CompanyService(companyStore, {getSession: id => sessions.get(id),
    runtimeRecipeOf: id => sessions.has(id) ? expertRuntimeRecipe(sessions.get(id)!) : undefined,
    chatrooms: chat, research: {start: vi.fn(), inspect: vi.fn(), stop: vi.fn()}});
  const employee = await company.hire({name: 'Worker', icon: 'W', position: 'Engineer', expertise: ['systems'],
    sessionId: source.id, researchEnabled: false}); eid = employee.id;
  await company.setDesiredRunning(source.id, true); await company.saveRuntimeRecipe(source.id, expertRuntimeRecipe(source));
  const plans = new PlanService({reader: {read: async () => {throw new Error('PROVIDER_FORBIDDEN');}},
    home: directory, historyFile: join(directory, 'usage.json'), sessions: () => sessions.values(), coordinatorIds: () => []});
  const account = {id: 'same', provider: 'openai', label: 'Same', configDir: join(directory, 'login'),
    realDir: join(directory, 'login'), isDefault: true, profile: {id: 'same', label: 'Same', provider: 'openai',
      configDir: join(directory, 'login')}} as PlanAccount;
  vi.spyOn(plans, 'allocations').mockImplementation(async () => ({accounts: [{id: 'same',
    sessionIds: [...sessions.keys()]}]}) as never);
  vi.spyOn(plans, 'account').mockResolvedValue(account);
  journal = new PlanMoveStore(join(directory, 'plan-moves.json'));
  moves = new PlanMoves({load: () => journal.load(), save: rows => journal.save(rows)} as PlanMovePort);
  const port = {sessions, addSession: async (session: Session) => {sessions.set(session.id, session); return {} as never;},
    setupSessionListeners: async () => {}, persistSessionStateNow: () => {}, persistSessionState: () => {},
    cleanupSession: async (id: string) => {expect(id).toBe(source.id); expect(verbs).toContain('source-stop');
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true); sessions.delete(id); options.delete(id);},
    discardPartiallyBuiltSession: async () => {throw new Error('GENERIC_ROLLBACK_FORBIDDEN');},
    reapplyPersistedSessionState: async () => {}, getSessionStateWithRespawn: () => {}} as SessionPort;
  draft = {draftId: randomUUID(), operationId: randomUUID(), reservationId: randomUUID(), targetSid: randomUUID(),
    profileVersion: '1', profileDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64),
    resources: {budgetMode: 'admission', memoryMiB: 3072, pidsLimit: 128, cpus: 0, poolMemoryMiB: 8192, poolTasksMax: 512},
    sourceMemoryMiB: 2048, capacityHeld: false, nativeEffects: false}; reference = randomUUID();
  const approve = () => Object.fromEntries(['employeeId','draftId','operationId','reservationId','targetSid',
    'profileVersion','profileDigest','previewDigest'].map(key => [key, key === 'employeeId' ? eid : draft[key]]));
  server = createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    let buffer = Buffer.alloc(0), purpose = false, pending: Frame;
    const reply = (value: unknown) => socket.write(encoded({kind: 'resource-result', requestId: pending.requestId, value}));
    const dispatch = async () => {
      const verb = String(pending.verb); verbs.push(verb);
      if (rejectAt === verb) {socket.write(encoded({kind: 'resource-refused', requestId: pending.requestId,
        reason: 'OWNED_SOURCE_FAULT'})); return;}
      if (verb === 'completion') {
        expect(pending.employeeId).toBe(eid); expect(pending.operationId).toBe(draft.operationId);
        const record = await journal.resourceRecord(String(draft.operationId));
        if (!nativeSettled || record.resourcePhase !== 'verified') {
          socket.write(encoded({kind: 'resource-refused', requestId: pending.requestId, reason: 'NONTERMINAL_NATIVE_OPERATION'}));
          return;
        }
        reply({state: 'HISTORICAL_NATIVE_SETTLEMENT_CONFIRMED', operationId: draft.operationId,
          reservationId: draft.reservationId, employeeId: eid, targetSid: draft.targetSid,
          profileVersion: draft.profileVersion, profileDigest: draft.profileDigest, previewDigest: draft.previewDigest,
          settlementDigest: 'd'.repeat(64), currentBindingDigest: 'e'.repeat(64), readOnly: true});
      }
      else if (verb === 'draft') {expect(pending.memoryMiB).toBe(3072); reply(draft);}
      else if (verb === 'claim') {expect(pending.approval).toEqual(approve());
        reply({reference, sessionId: draft.targetSid, state: 'PREPARING', publicationIntentDigest: 'c'.repeat(64)});}
      else if (verb === 'publication') {expect(company.registeredEmployees()[0].sessionId).toBe(draft.targetSid);
        reply({state: 'PUBLISHED_METADATA_ONLY', verified: false, retryAllowed: false});}
      else if (verb === 'prepare') {expect((await journal.resourceRecord(String(draft.operationId))).resourcePhase).toBe('preparing');
        reply({state: 'PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED', operationId: draft.operationId,
          reservationId: draft.reservationId, profileDigest: draft.profileDigest});}
      else if (verb === 'source-stop') {
        expect((await journal.resourceRecord(String(draft.operationId))).sourceStopRequested).toBe(true);
        const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
        reply({state: 'SOURCE_RELEASED_TARGET_NOT_CREATED', operationId: draft.operationId,
          capacityRetained: true, retryAllowed: false, verified: false});
      } else if (verb === 'start') {
        expect((await journal.resourceRecord(String(draft.operationId))).sourceCleanupVerified).toBe(true);
        socket.write(encoded({kind: 'resource-launch-ready', requestId: pending.requestId, reference}));
        await until(async () => sessions.get(String(draft.targetSid))?.pid, value => !!value);
        reply({state: 'STARTED_READINESS_NOT_VERIFIED', operationId: draft.operationId,
          reservationId: draft.reservationId, capacityRetained: true});
      } else if (verb === 'verify' || verb === 'finalize') {
        socket.write(encoded({kind: 'resource-readiness-check', requestId: pending.requestId, nonce: randomUUID(),
          stage: verb, sessionId: draft.targetSid, operationId: draft.operationId, profileDigest: draft.profileDigest}));
      } else throw new Error('Unexpected fixture verb');
    };
    socket.on('data', bytes => {buffer = Buffer.concat([buffer, bytes]);
      if (!purpose) {if (buffer.length < 5 || buffer.length < buffer.readUInt32BE(1) + 5) return;
        expect(buffer[0]).toBe(81); expect(JSON.parse(buffer.subarray(5,5+buffer.readUInt32BE(1)).toString()))
          .toEqual({purpose: 'resource-replacement-v1', version: 1});
        buffer = buffer.subarray(5 + buffer.readUInt32BE(1)); purpose = true; socket.write('RESOURCE_READY\n');}
      while (buffer.length >= 4) {const n = buffer.readUInt32BE(0); if (buffer.length < n + 4) break;
        const value = JSON.parse(buffer.subarray(4,n+4).toString()) as Frame; buffer = buffer.subarray(n+4);
        if (value.kind === 'resource-operation') {pending = value;
          socket.write(encoded({kind: 'resource-owner-check', requestId: value.requestId, nonce: randomUUID(),
            stage: ['draft','completion'].includes(String(value.verb)) ? 'preview' : 'apply', employeeId: eid,
            approval: ['draft','completion'].includes(String(value.verb)) ? null : approve()}));
        } else if (value.kind === 'resource-owner-current') {expect(value.owner).toBeNull();
          void dispatch().catch(error => {socket.destroy(error);});
        } else if (value.kind === 'resource-readiness-current') {
          expect((value.proof as Frame).panePid).toBe(654);
          expect((value.proof as Frame).pid).not.toBe(654);
          if (pending.verb === 'finalize') nativeSettled = true;
          reply(pending.verb === 'verify' ? {state: 'VERIFY_RECORDED_CAPACITY_RETAINED', operationId: draft.operationId,
            reservationId: draft.reservationId, capacityRetained: true} :
            {state: 'COMPLETED_NATIVE_SETTLED', operationId: draft.operationId, capacityRetained: false, retryAllowed: false});
        } else throw new Error('Unexpected fixture frame');
      }
    }); socket.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  vi.stubEnv('REVERIE_WORKER_SOCKET', path);
  app = Fastify(); await app.register(cookie);
  controller = new ResourceReplacementController(app, auth, company, plans, chat, moves, journal, port, mux, path);
  registerResourceReplacementRoutes(app, controller);
  restartController = async () => {
    controller.close(); await app.close();
    moves = new PlanMoves({load: () => journal.load(), save: rows => journal.save(rows)} as PlanMovePort);
    app = Fastify(); await app.register(cookie);
    controller = new ResourceReplacementController(app, auth, company, plans, chat, moves, journal, port, mux, path);
    registerResourceReplacementRoutes(app,controller);
  };
});
afterEach(async () => {
  controller?.close(); for (const peer of peers ?? []) peer.destroy();
  for (const session of sessions?.values() ?? []) if (session !== source) await session.stop();
  if (child?.exitCode === null && child.signalCode === null) {const exit = once(child,'exit'); child.kill(); await exit;}
  await new Promise<void>(resolve => server?.close(() => resolve())); await chat?.stop(); await app?.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, {recursive: true, force: true});
});

it('registers a real current-owner preview with visible limits and no executing claim', async () => {
  const response = await post('preview', {employeeId: eid, memoryMiB: 3072});
  expect(response.statusCode).toBe(200); expect(response.json().data).toMatchObject({...draft, sourceSid: source.id});
  expect(verbs).toEqual(['draft']); expect(sessions.size).toBe(1);
  expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
});
it('rejects owner-shaped input, another origin, and a stale session before a host request', async () => {
  for (const extra of [{origin: 'http://other.invalid'}, {'x-reverie-parent-session': source.id},
    {authorization: 'Basic fixture'}, {cookie: ''}]) {
    expect((await post('preview', {employeeId: eid, memoryMiB: 3072}, extra)).statusCode).toBe(403);
  }
  expect(verbs).toEqual([]);
});
it('closes an opened Apply channel on pre-claim source drift and does not retry it', async () => {
  const preview = (await post('preview', {employeeId: eid, memoryMiB: 3072})).json().data;
  source.setNice({niceValue: 3});
  const response = await post('apply', {previewId: preview.draftId, handoff: 'Resume the preserved work.'});
  expect(response.statusCode).toBe(503);
  await until(async () => peers.size, size => size === 0);
  expect(verbs).toEqual(['draft']);
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Same request'})).statusCode).toBe(503);
});
it('runs normal metadata, explicit source stop, Session readiness, handoff and protected finalization before returning completed', async () => {
  const preview = (await post('preview', {employeeId: eid, memoryMiB: 3072})).json().data;
  const applied = await post('apply', {previewId: preview.draftId, handoff: 'Resume the preserved work and inspect its checkpoint.'});
  expect(applied.statusCode).toBe(200);
  const record = await until(async () => (await post('result', {operationId: draft.operationId})).json().data as PlanMoveRecord,
    value => ['completed','recovery-required'].includes(value?.phase));
  expect(record.phase, record.error).toBe('completed');
  expect(verbs).toEqual(['draft','claim','publication','prepare','source-stop','start','verify','finalize']);
  expect(handoffs).toEqual(['Resume the preserved work and inspect its checkpoint.\r']);
  expect(handoffScreens).toEqual([codexPane('Resume the preserved work and inspect its checkpoint.'), codexPane('')]);
  expect(candidateCommands).toHaveLength(1); expect(candidateCommands[0]).toContain('--resource-ref');
  expect((await journal.resourceRecord(String(draft.operationId))).resourcePhase).toBe('verified');
  expect(company.registeredEmployees()[0].sessionId).toBe(draft.targetSid);
}, 20_000);

it('retains native recovery without typing over a candidate owner draft or reaching verify/finalize', async () => {
  occupyCandidate = true;
  const preview = (await post('preview', {employeeId: eid, memoryMiB: 3072})).json().data;
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Preserve this approved handoff.'})).statusCode).toBe(200);
  const record = await until(async () => (await post('result', {operationId: draft.operationId})).json().data as PlanMoveRecord,
    value => value?.phase === 'recovery-required');
  expect(record.error).toContain('Recovery instruction could not be typed');
  expect(handoffMuxCalls).toEqual([]); expect(handoffs).toEqual([]); expect(handoffScreens).toEqual([]);
  // Result lookup may make the existing read-only historical-completion query;
  // nonterminal native state refuses it and must never add lifecycle effects.
  expect(verbs.filter(verb => verb !== 'completion')).toEqual(['draft','claim','publication','prepare','source-stop','start']);
  expect(nativeSettled).toBe(false); expect(sessions.has(String(draft.targetSid))).toBe(true);
  expect(company.registeredEmployees()[0].sessionId).toBe(draft.targetSid);
  const before = [...verbs];
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Retry'})).statusCode).toBe(503);
  expect(verbs).toEqual(before);
}, 20_000);

it.each(['verify','finalize'])('a host %s refusal retains durable recovery and never uses generic candidate cleanup', async fault => {
  rejectAt = fault;
  const preview = (await post('preview', {employeeId: eid, memoryMiB: 3072})).json().data;
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Resume the preserved work.'})).statusCode).toBe(200);
  const record = await until(async () => (await post('result', {operationId: draft.operationId})).json().data as PlanMoveRecord,
    value => value?.phase === 'recovery-required');
  expect(record.sourceStopRequested).toBe(true); expect(record.sourceCleanupVerified).toBe(true);
  expect(record.resourceIntent?.profileDigest).toBe(draft.profileDigest);
  expect(sessions.has(String(draft.targetSid))).toBe(true);
  expect(company.registeredEmployees()[0].sessionId).toBe(draft.targetSid);
  expect(verbs.filter(value => value === 'source-stop')).toHaveLength(1);
  expect(verbs.filter(value => value === fault)).toHaveLength(1);
  if (fault === 'verify') expect(verbs).not.toContain('finalize');
  const before = [...verbs];
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Retry'})).statusCode).toBe(503);
  expect(verbs).toEqual(before);
  // Cold normal journal lookup retains the operation, never an executing
  // Runtime/NativeClient or a route that replays a prior handle.
  const cold = new PlanMoves({load: () => journal.load(), save: rows => journal.save(rows)} as PlanMovePort);
  expect((await cold.get(String(draft.operationId)))?.phase).toBe('recovery-required');
  expect(verbs).toEqual(before);
}, 20_000);

it('a real logout invalidates a preview and a later login cannot reuse the old executing context', async () => {
  const preview = (await post('preview', {employeeId: eid, memoryMiB: 3072})).json().data;
  auth.logout(token);
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Resume'})).statusCode).toBe(403);
  expect(verbs).toEqual(['draft']); expect(sessions.size).toBe(1);
});

it('a fresh registered result route reconciles settled restart metadata without another claim, stop or start', async () => {
  const preview = (await post('preview', {employeeId: eid, memoryMiB: 3072})).json().data;
  expect((await post('apply', {previewId: preview.draftId, handoff: 'Preserve this explicit handoff.'})).statusCode).toBe(200);
  await until(async () => (await post('result', {operationId: draft.operationId})).json().data as PlanMoveRecord,
    value => value?.phase === 'completed');
  const before = [...verbs], intent = (await journal.resourceRecord(String(draft.operationId))).resourceIntent;
  await restartController();
  expect((await moves.get(String(draft.operationId)))?.phase).toBe('recovery-required');
  const result = await post('result', {operationId: draft.operationId});
  expect(result.statusCode).toBe(200); expect(result.json().data).toMatchObject({phase: 'completed', resourceIntent: intent});
  expect(verbs.slice(before.length)).toEqual(['completion','completion']);
  expect(verbs.filter(verb => verb === 'claim')).toHaveLength(1);
  expect(verbs.filter(verb => verb === 'source-stop')).toHaveLength(1);
  expect(verbs.filter(verb => verb === 'start')).toHaveLength(1);
  expect(handoffs).toEqual(['Preserve this explicit handoff.\r']);
},20_000);
