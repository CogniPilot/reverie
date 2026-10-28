/** Real account/session store; in-process HTTP injection, no listener or host port. */
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Socket} from 'node:net';
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {OwnerAuthStore} from '../src/owner-auth/store.js';
import {OwnerAuthService} from '../src/owner-auth/service.js';
import {ResourceOwnerAuthority, assertResourceOperation, type ResourceOwnerContext} from '../src/resource-owner-authority.js';
import {PlanMoves, type PlanMoveInput} from '../src/plan-move.js';
import {PlanMoveStore} from '../src/plan-move-store.js';
import {resourceWorkerLaunch} from '../src/resource-worker-launch.js';
import {workerLaunchCommand} from '../src/worker-execution.js';

const approval = {employeeId: '10000000-0000-4000-8000-000000000001',
  draftId: '10000000-0000-4000-8000-000000000002',
  operationId: '10000000-0000-4000-8000-000000000003',
  reservationId: '10000000-0000-4000-8000-000000000004',
  targetSid: '10000000-0000-4000-8000-000000000005',
  profileVersion: '1', profileDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64)};
let directory: string, app: FastifyInstance, auth: OwnerAuthService, authority: ResourceOwnerAuthority;
let token: string, captured: ResourceOwnerContext | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-owner-'));
  auth = new OwnerAuthService({store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
    auditFile: join(directory, 'audit.jsonl'), setupEnabled: true});
  const password = 'synthetic-Quasar!8-lantern';
  token = await auth.setup('FixtureOwner', password, password, '127.0.0.1');
  authority = new ResourceOwnerAuthority(auth); captured = undefined;
  app = Fastify(); await app.register(cookie);
  app.post('/apply', async (req, reply) => {
    try { captured = authority.capture(req, approval); return {purpose: captured.purpose}; }
    catch { return reply.code(403).send({error: 'refused'}); }
  });
  app.post('/preview', async (req) => {
    const preview = authority.capturePreview(req, approval.employeeId);
    expect(preview.stage).toBe('preview');
    expect(() => authority.bind(preview as never)).toThrow();
    return {stage: preview.stage};
  });
});
afterEach(async () => {vi.unstubAllEnvs(); authority?.close(); await app?.close(); await rm(directory, {recursive: true, force: true});});
const request = (headers: Record<string, string> = {}) => app.inject({method: 'POST', url: '/apply',
  headers: {host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token, ...headers}});

it('binds the exact protected draft to the real current owner session without exporting cookies', async () => {
  expect((await request()).statusCode).toBe(200);
  expect(captured!.approval).toEqual(approval);
  expect(captured!.purpose).toBe('resource-replacement-v1');
  authority.assertContext(captured!);
  expect(() => JSON.stringify(captured)).toThrow('server-private');
  expect(() => authority.assertContext({...captured!})).toThrow();
});
it('revokes the context immediately when the real owner logs out', async () => {
  await request(); auth.logout(token);
  expect(() => captured!.assertCurrent()).toThrow();
  expect((await request()).statusCode).toBe(403);
});
it('never promotes agent/service/Basic or cross-origin requests even with a real owner cookie', async () => {
  for (const headers of [{origin: 'http://elsewhere.invalid'}, {'x-reverie-parent-session': approval.targetSid},
    {'x-reverie-service-token': 'synthetic-service'}, {authorization: 'Basic synthetic'},
    {'x-reverie-goal-proof': 'synthetic'}]) {
    expect((await request(headers)).statusCode).toBe(403);
  }
  expect(captured).toBeUndefined();
});
it('does not accept owner-shaped JSON or a copied service as an authority producer', async () => {
  expect(() => new ResourceOwnerAuthority({session: () => ({role: 'owner'})} as never)).toThrow();
  expect((await request({cookie: 'reverie_owner=synthetic-not-a-session'})).statusCode).toBe(403);
});
const scopedInput = (scope: string): PlanMoveInput => ({id: 'scope-move', employeeId: approval.employeeId,
  sessionId: 'old-session', fromAccount: 'same-account', toAccount: 'same-account', forceBusy: false,
  handoff: 'Owned fixture handoff', purpose: 'runtime-refresh', runtimeDigest: 'd'.repeat(64),
  resourceOwnerScope: scope, resourceIntent: {operationId: approval.operationId,
    reservationId: approval.reservationId, profileVersion: approval.profileVersion,
    profileDigest: approval.profileDigest, previewDigest: approval.previewDigest}});

it('a serialized scope digest alone cannot admit a single-user resource transaction', async () => {
  await request();
  const load = vi.fn(async () => []);
  const moves = new PlanMoves({load} as never);
  await expect(moves.begin(scopedInput(captured!.ownerScopeDigest))).rejects.toThrow('private owner context');
  expect(load).not.toHaveBeenCalled();
});
it('keeps undefined data ownership while requiring the live registered owner binding', async () => {
  await request();
  const binding = authority.bind(captured!);
  const snapshot = vi.fn(async (_employee: string, owner: string | undefined) => {
    expect(owner).toBeUndefined(); throw new Error('controlled readonly snapshot boundary');
  });
  const port = {load: async () => [], snapshot, prepareResources: vi.fn(), verifyResources: vi.fn(), completeResources: vi.fn()};
  await expect(new PlanMoves(port as never).begin(scopedInput(binding.digest), undefined, port as never, binding))
    .rejects.toThrow('controlled readonly snapshot boundary');
  expect(snapshot).toHaveBeenCalledTimes(1);
  auth.logout(token);
  await expect(new PlanMoves(port as never).begin(scopedInput(binding.digest), undefined, port as never, binding))
    .rejects.toThrow('private owner context');
  expect(snapshot).toHaveBeenCalledTimes(1);
});
it('retained serialized resource records still become recovery-required after restart', async () => {
  await request();
  const disk = new PlanMoveStore(join(directory, 'plan-moves.json'));
  await disk.save([{id: 'scope-move', employeeId: approval.employeeId, name: 'Worker', oldSession: 'old-session',
    fromAccount: 'same-account', toAccount: 'same-account', purpose: 'runtime-refresh', runtimeDigest: 'd'.repeat(64),
    phase: 'waiting', at: Date.now(), resourceIntent: scopedInput(captured!.ownerScopeDigest).resourceIntent,
    resourceOwnerScope: captured!.ownerScopeDigest}]);
  const port = {load: () => disk.load()};
  const moves = new PlanMoves(port as never);
  expect((await moves.get('scope-move'))?.phase).toBe('recovery-required');
});
it('the same current owner scope cannot authorize different employee/operation/profile/target references', async () => {
  await request();
  const binding = authority.bind(captured!);
  const original = {...scopedInput(binding.digest), newSession: approval.targetSid};
  expect(assertResourceOperation(binding, undefined, original)).toBe(binding.digest);
  for (const field of ['operationId', 'reservationId', 'profileVersion', 'profileDigest', 'previewDigest'] as const) {
    const value = field === 'profileVersion' ? '2' : field.endsWith('Id')
      ? '20000000-0000-4000-8000-000000000099' : 'e'.repeat(64);
    expect(() => assertResourceOperation(binding, undefined, {...original,
      resourceIntent: {...original.resourceIntent!, [field]: value}})).toThrow();
  }
  for (const change of [{employeeId: '20000000-0000-4000-8000-000000000099'},
    {newSession: '20000000-0000-4000-8000-000000000099'}, {resourceOwnerScope: 'e'.repeat(64)}])
    expect(() => assertResourceOperation(binding, undefined, {...original, ...change})).toThrow();
});
it('preview authenticates the owner but cannot become an executing Apply binding', async () => {
  const response = await app.inject({method: 'POST', url: '/preview', headers: {host: 'localhost',
    origin: 'http://localhost', cookie: 'reverie_owner='+token}});
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({stage: 'preview'});
});
it('tracks real logout through nested private operations and removes stale close listeners', async () => {
  await request(); const socket = new Socket();
  const first = authority.track(captured!, socket), second = authority.track(captured!, socket);
  first(); expect(socket.destroyed).toBe(false);
  auth.logout(token); expect(socket.destroyed).toBe(true);
  second(); second();
});
it('untracks only after the last completed native operation and does not accumulate handlers', async () => {
  await request(); const socket = new Socket();
  try {
    for (let i=0; i<20; i++) { const release = authority.track(captured!, socket); release(); }
    expect(socket.listenerCount('close')).toBe(0);
    auth.logout(token); expect(socket.destroyed).toBe(false);
  } finally {socket.destroy();}
});
it('joins the exact normally generated CLI command once and never falls back to host execution', async () => {
  await request(); const binding = authority.bind(captured!);
  const record = {id: 'scope-move', employeeId: approval.employeeId, name: 'Worker', oldSession: 'old-session',
    newSession: approval.targetSid, fromAccount: 'same-account', toAccount: 'same-account',
    purpose: 'runtime-refresh' as const, runtimeDigest: 'd'.repeat(64), phase: 'starting' as const, at: Date.now(),
    resourceIntent: scopedInput(binding.digest).resourceIntent, resourceOwnerScope: binding.digest};
  const reference = '10000000-0000-4000-8000-000000000099';
  const join = resourceWorkerLaunch(binding, record, reference);
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/private-source-fixture.sock');
  expect(() => workerLaunchCommand('normal cli', '/workspace', approval.targetSid, false, join)).toThrow();
  join.arm(reference);
  const command = 'normal cli --model selected';
  expect(workerLaunchCommand(command, '/workspace', approval.targetSid, false, join)).toContain('--resource-ref');
  const hash = createHash('sha256').update(JSON.stringify([approval.targetSid, '/workspace', command])).digest('hex');
  join.assertCommand(hash, approval.targetSid, '/workspace');
  expect(() => join.assertCommand('e'.repeat(64), approval.targetSid, '/workspace')).toThrow();
  expect(() => workerLaunchCommand(command, '/workspace', approval.targetSid, false, join)).toThrow();
  expect(() => workerLaunchCommand(command, '/workspace', approval.targetSid, false, {...join} as never)).toThrow();
  const other = resourceWorkerLaunch(binding, record, '10000000-0000-4000-8000-000000000098');
  vi.stubEnv('REVERIE_WORKER_SOCKET', '');
  expect(() => workerLaunchCommand(command, '/workspace', approval.targetSid, false, other)).toThrow('native worker');
  auth.logout(token); expect(() => join.assertCommand(hash, approval.targetSid, '/workspace')).toThrow();
});
