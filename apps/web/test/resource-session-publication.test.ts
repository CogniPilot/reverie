/** Real owner, normal Session objects and CompanyStore; no listener/PTY/engine. */
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {Session} from '../src/session.js';
import {expertRuntimeRecipe} from '../src/expert-runtime-recipe.js';
import {OwnerAuthService} from '../src/owner-auth/service.js';
import {OwnerAuthStore} from '../src/owner-auth/store.js';
import {ResourceOwnerAuthority, type ResourceOwnerBinding, type ResourcePreviewContext} from '../src/resource-owner-authority.js';
import {ResourceSessionPublication} from '../src/resource-session-publication.js';
import {workerLaunchCommand} from '../src/worker-execution.js';
import {ResourceSessionReadiness, resourceCanonicalDigest} from '../src/resource-readiness.js';
import {PlanMoveStore} from '../src/plan-move-store.js';
import {composerReadyMark} from '../src/cli-agent.js';
import type {PlanMoveRecord} from '../src/plan-move.js';
import type {SessionPort} from '../src/web/ports/session-port.js';
import type {TerminalMultiplexer} from '../src/mux-interface.js';

let directory: string, app: FastifyInstance, auth: OwnerAuthService, authority: ResourceOwnerAuthority;
let company: CompanyService, store: CompanyStore, source: Session, token: string;
let preview: ResourcePreviewContext, binding: ResourceOwnerBinding, record: PlanMoveRecord;
let sessions: Map<string, Session>, port: SessionPort;
const mux = new Proxy({}, {get: (_target, name) => () => {throw new Error('NATIVE_MUX_FORBIDDEN:' + String(name));}}) as TerminalMultiplexer;
const reference = () => randomUUID();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-session-'));
  auth = new OwnerAuthService({store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'), setupEnabled: true});
  token = await auth.setup('FixtureOwner', 'Quasar!fixture-8-passphrase', 'Quasar!fixture-8-passphrase', '127.0.0.1');
  authority = new ResourceOwnerAuthority(auth);
  source = new Session({id: randomUUID(), workingDir: directory, mode: 'codex', name: 'Worker',
    codexConfig: {model: 'fixture-model', reasoningEffort: 'high'}, envOverrides: {FIXTURE_SETTING: 'preserved'},
    mux, useMux: true});
  vi.spyOn(source, 'stop').mockImplementation(async () => {throw new Error('SOURCE_STOP_FORBIDDEN');});
  sessions = new Map([[source.id, source]]);
  store = new CompanyStore(join(directory, 'company.json')); await store.init();
  company = new CompanyService(store, {getSession: id => sessions.get(id),
    runtimeRecipeOf: id => sessions.has(id) ? expertRuntimeRecipe(sessions.get(id)!) : undefined,
    chatrooms: {rooms: () => [], room: () => undefined, addMember: vi.fn(), replaceSession: vi.fn(async () => {})},
    research: {start: vi.fn(), inspect: vi.fn(), stop: vi.fn()}});
  const employee = await company.hire({name: 'Worker', icon: '🦊', position: 'Engineer', expertise: ['systems'],
    sessionId: source.id, researchEnabled: false});
  await company.setDesiredRunning(source.id, true);
  await company.saveRuntimeRecipe(source.id, expertRuntimeRecipe(source));
  const target = randomUUID(), operationId = randomUUID(), reservationId = randomUUID();
  record = {id: randomUUID(), employeeId: employee.id, name: 'Worker', oldSession: source.id, newSession: target,
    fromAccount: 'same-account', toAccount: 'same-account', purpose: 'runtime-refresh', runtimeDigest: 'd'.repeat(64),
    at: Date.now(), phase: 'creating', resourceIntent: {operationId, reservationId,
      profileVersion: '1', profileDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64)}};
  app = Fastify(); await app.register(cookie);
  app.post('/preview', async req => {preview = authority.capturePreview(req, employee.id); return {};});
  app.post('/apply', async req => {
    const current = authority.capture(req, {employeeId: employee.id, draftId: randomUUID(), operationId, reservationId,
      targetSid: target, ...record.resourceIntent!});
    binding = authority.bind(current); record.resourceOwnerScope = binding.digest; return {};
  });
  for (const url of ['/preview', '/apply']) expect((await app.inject({method: 'POST', url,
    headers: {host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token}})).statusCode).toBe(200);
  port = {sessions, addSession: vi.fn(async session => {sessions.set(session.id, session); return {} as never;}),
    setupSessionListeners: vi.fn(async () => {}), persistSessionStateNow: vi.fn(),
    persistSessionState: vi.fn(), cleanupSession: vi.fn(async () => {throw new Error('CLEANUP_FORBIDDEN');}),
    discardPartiallyBuiltSession: vi.fn(async () => {throw new Error('DISCARD_FORBIDDEN');}),
    reapplyPersistedSessionState: vi.fn(), getSessionStateWithRespawn: vi.fn()};
});
afterEach(async () => {authority?.close(); await app?.close(); vi.restoreAllMocks();
  await rm(directory, {recursive: true, force: true});});
const draft = () => new ResourceSessionPublication(authority, preview, company, port, mux, record.newSession!);

it('uses the real normal Session and Company CAS without stopping or starting either laptop', async () => {
  const approved = structuredClone(company.registeredEmployees()[0]);
  const publication = draft(), result = await publication.publish(binding, record, reference());
  expect(result.session).toBeInstanceOf(Session);
  expect(result.session.pid).toBeFalsy(); expect(result.session.muxName).toBeFalsy();
  expect(expertRuntimeRecipe(result.session)).toEqual(expertRuntimeRecipe(source));
  expect(result.session.getEnvOverridesForPersist()).toEqual(source.getEnvOverridesForPersist());
  expect(source.stop).not.toHaveBeenCalled(); expect(port.cleanupSession).not.toHaveBeenCalled();
  const current = company.registeredEmployees()[0];
  expect(current).toEqual({...approved, sessionId: record.newSession, sessionGeneration: approved.sessionGeneration + 1});
  publication.assertPublished(binding, record);
  expect(() => workerLaunchCommand('fixture-command', directory, record.newSession!, false, result.launch))
    .toThrow(); // The normal CLI join remains unarmed until native STARTING.
  expect(() => JSON.stringify(publication)).toThrow('server-private');
  const reopened = new CompanyStore(join(directory, 'company.json')); await reopened.init();
  expect(reopened.snapshot().employees[0]).toEqual(current);
});
it('refuses source configuration drift since the preview before registering a candidate', async () => {
  const publication = draft(); source.setNice({niceValue: 3});
  await expect(publication.publish(binding, record, reference())).rejects.toThrow('unavailable or changed');
  expect(sessions.size).toBe(1); expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
});
it('preserves a partial candidate and the old binding if logout happens during normal registration', async () => {
  const publication = draft();
  vi.mocked(port.addSession).mockImplementationOnce(async session => {
    sessions.set(session.id, session); auth.logout(token); return {} as never;
  });
  await expect(publication.publish(binding, record, reference())).rejects.toThrow();
  expect(sessions.has(record.newSession!)).toBe(true);
  expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
  expect(source.stop).not.toHaveBeenCalled(); expect(port.cleanupSession).not.toHaveBeenCalled();
  await expect(publication.publish(binding, record, reference())).rejects.toThrow();
  expect(port.addSession).toHaveBeenCalledTimes(1);
});
it('the real company CAS refuses changed owner intent during listener setup', async () => {
  const publication = draft();
  vi.mocked(port.setupSessionListeners).mockImplementationOnce(async () => {
    await store.update(state => {state.employees[0].onVacation = true;});
  });
  await expect(publication.publish(binding, record, reference())).rejects.toThrow('Approved employee binding changed');
  expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
  expect(company.registeredEmployees()[0].onVacation).toBe(true);
  expect(source.stop).not.toHaveBeenCalled();
});
it('refuses a candidate object replacement before the normal company rebind', async () => {
  const publication = draft();
  vi.mocked(port.setupSessionListeners).mockImplementationOnce(async () => {sessions.set(record.newSession!, source);});
  await expect(publication.publish(binding, record, reference())).rejects.toThrow('unavailable or changed');
  expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
});
it('never accepts a copied preview or an already occupied reserved transport', () => {
  expect(() => new ResourceSessionPublication(authority, {...preview}, company, port, mux, record.newSession!)).toThrow();
  sessions.set(record.newSession!, source); expect(draft).toThrow();
});
it('keeps the normal Claude conversation selectors and permission policy without launching', async () => {
  source.setMode('claude');
  await company.saveRuntimeRecipe(source.id, expertRuntimeRecipe(source));
  const publication = draft(), result = await publication.publish(binding, record, reference());
  expect(expertRuntimeRecipe(result.session)).toEqual(expertRuntimeRecipe(source));
  expect(result.session.claudeMode).toBe(source.claudeMode);
  expect(result.session.allowedTools).toBe(source.allowedTools);
  expect(source.stop).not.toHaveBeenCalled();
});

it('matches the normal fresh-thread refresh while preserving settings and leaving the old conversation untouched', async () => {
  source = new Session({...source.toState(), mux, useMux: true, resumeSessionId: 'old-provider-thread',
    runtimeThreads: {'subscription:same-account': 'old-provider-thread'},
    codexConfig: {...source.toState().codexConfig, resumeSessionId: 'old-provider-thread'}});
  sessions.set(source.id, source);
  await company.saveRuntimeRecipe(source.id, expertRuntimeRecipe(source));
  const oldState = source.toState(), oldRecipe = expertRuntimeRecipe(source);
  const publication = draft(), result = await publication.publish(binding, record, reference());
  expect(result.session.toState().resumeSessionId).toBeUndefined();
  expect(result.session.toState().codexConfig?.resumeSessionId).toBeUndefined();
  expect(result.session.toState().runtimeThreads).toEqual({});
  expect(result.session.toState().codexConfig?.model).toBe(oldState.codexConfig?.model);
  expect(result.session.toState().codexConfig?.reasoningEffort).toBe(oldState.codexConfig?.reasoningEffort);
  expect(source.toState()).toEqual(oldState);
  expect(company.registeredEmployees()[0].runtimeRecipe).toEqual(expertRuntimeRecipe(result.session));
  expect(expertRuntimeRecipe(source)).toEqual(oldRecipe);
  publication.assertPublished(binding, record);
});

async function readyFixture() {
  const published = await draft().publish(binding, record, reference());
  const candidate = published.session;
  vi.spyOn(candidate, 'pid', 'get').mockReturnValue(321);
  vi.spyOn(candidate, 'muxName', 'get').mockReturnValue('owned-control-pane');
  vi.spyOn(candidate, 'isRunning').mockReturnValue(true);
  const native = {isPaneDead: vi.fn(() => false), getSession: vi.fn(() => ({pid: 654, sessionId: candidate.id,
    muxName: 'owned-control-pane'})),
    capturePaneText: vi.fn(() => composerReadyMark(candidate.mode)!)} as unknown as TerminalMultiplexer;
  const moves = new PlanMoveStore(join(directory, 'plan-moves.json'));
  const readiness = new ResourceSessionReadiness(binding, record, candidate, port, company, moves, native);
  return {candidate, native, moves, readiness};
}

it('uses the normal composer readiness once and the real current move record for verify and finalize', async () => {
  const f = await readyFixture();
  expect(() => f.readiness.assertCurrent()).toThrow();
  await f.readiness.waitUntilReady();
  const verifying: PlanMoveRecord = {...record, sourceStopRequested: true, sourceCleanupVerified: true,
    phase: 'checking', resourcePhase: 'verifying'};
  await f.moves.save([verifying]);
  expect(await f.readiness.proof('verify')).toMatchObject({sessionId: record.newSession, pid: 321, panePid: 654,
    mode: 'codex', muxName: 'owned-control-pane', recordDigest: resourceCanonicalDigest(verifying)});
  // A normal handoff can consume the composer prompt. It does not erase the
  // recorded initial readiness, while current pane/process checks still apply.
  vi.mocked(f.native.capturePaneText!).mockReturnValue('Handoff is being processed');
  vi.spyOn(f.candidate, 'isWorking', 'get').mockReturnValue(true);
  const completed: PlanMoveRecord = {...verifying, phase: 'completed', resourcePhase: 'verified'};
  await f.moves.save([completed]);
  expect(await f.readiness.proof('finalize')).toMatchObject({recordDigest: resourceCanonicalDigest(completed)});
  expect(f.native.capturePaneText).toHaveBeenCalledTimes(1);
});

it('refuses a recycled pane PID, owner vacation and real logout after initial readiness', async () => {
  const f = await readyFixture(); await f.readiness.waitUntilReady();
  vi.mocked(f.native.getSession).mockReturnValueOnce({pid: 322} as never);
  expect(() => f.readiness.assertCurrent()).toThrow();
  await store.update(state => {state.employees[0].onVacation = true;});
  expect(() => f.readiness.assertCurrent()).toThrow();
  await store.update(state => {state.employees[0].onVacation = false;});
  f.readiness.assertCurrent(); auth.logout(token);
  expect(() => f.readiness.assertCurrent()).toThrow();
});

it('a journal phase or approved-reference mismatch never becomes a readiness receipt', async () => {
  const f = await readyFixture(); await f.readiness.waitUntilReady();
  const pending: PlanMoveRecord = {...record, phase: 'starting', resourcePhase: 'prepared', sourceStopRequested: true,
    sourceCleanupVerified: true};
  await f.moves.save([pending]); await expect(f.readiness.proof('verify')).rejects.toThrow();
  await f.moves.save([{...pending, phase: 'checking', resourcePhase: 'verifying',
    resourceIntent: {...record.resourceIntent!, profileDigest: 'f'.repeat(64)}}]);
  await expect(f.readiness.proof('verify')).rejects.toThrow();
  expect(() => JSON.stringify(f.readiness)).toThrow('server-private');
});
