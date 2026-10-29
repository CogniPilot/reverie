/** Real account store and own AF_UNIX framing; no broker/engine/provider. */
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {createServer, type Server, type Socket} from 'node:net';
import {chmod, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {OwnerAuthService} from '../src/owner-auth/service.js';
import {OwnerAuthStore} from '../src/owner-auth/store.js';
import {ResourceOwnerAuthority, type ResourceOwnerContext, type ResourcePreviewContext} from '../src/resource-owner-authority.js';
import {ResourceNativeClient, ResourceHistoricalSettlement} from '../src/resource-native-client.js';
import {PlanMoves, type PlanMoveRecord, type PlanMovePort} from '../src/plan-move.js';

let directory: string, path: string, app: FastifyInstance, server: Server, auth: OwnerAuthService;
let authority: ResourceOwnerAuthority, preview: ResourcePreviewContext, apply: ResourceOwnerContext;
let token: string, peers: Set<Socket>, clients: ResourceNativeClient[];
const approval = {employeeId: randomUUID(), draftId: randomUUID(), operationId: randomUUID(), reservationId: randomUUID(),
  targetSid: randomUUID(), profileVersion: '1', profileDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64)};
type Frame = Record<string, unknown>;
let received: Frame[], behavior: (socket: Socket, frame: Frame) => void;
const frame = (value: unknown) => {
  const raw = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(raw.length);
  return Buffer.concat([header, raw]);
};
function check(socket: Socket, operation: Frame, selected = approval) {
  socket.write(frame({kind: 'resource-owner-check', requestId: operation.requestId, nonce: randomUUID(),
    stage: ['draft','completion'].includes(String(operation.verb)) ? 'preview' : 'apply', employeeId: selected.employeeId,
    approval: ['draft','completion'].includes(String(operation.verb)) ? null : selected}));
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-ipc-')); path = join(directory, 'own.sock');
  auth = new OwnerAuthService({store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'), setupEnabled: true});
  token = await auth.setup('FixtureOwner', 'Quasar!fixture-8-passphrase', 'Quasar!fixture-8-passphrase', '127.0.0.1');
  authority = new ResourceOwnerAuthority(auth); app = Fastify(); await app.register(cookie);
  app.post('/capture', async request => {preview = authority.capturePreview(request, approval.employeeId);
    apply = authority.capture(request, approval); return {};});
  expect((await app.inject({method: 'POST', url: '/capture', headers: {host: 'localhost',
    origin: 'http://localhost', cookie: 'reverie_owner=' + token}})).statusCode).toBe(200);
  peers = new Set(); clients = []; received = [];
  behavior = (socket, value) => {
    if (value.kind === 'resource-operation') check(socket, value);
    else socket.write(frame({kind: 'resource-result', requestId: value.requestId,
      value: {state: 'CONTROLLED_SOURCE_RESPONSE', capacityHeld: false}}));
  };
  server = createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    let buffer = Buffer.alloc(0), purpose = false;
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (!purpose) {
        if (buffer.length < 5) return;
        const size = buffer.readUInt32BE(1); if (buffer.length < size + 5) return;
        expect(buffer[0]).toBe('Q'.charCodeAt(0));
        expect(JSON.parse(buffer.subarray(5, size + 5).toString())).toEqual({purpose: 'resource-replacement-v1', version: 1});
        buffer = buffer.subarray(size + 5); purpose = true; socket.write('RESOURCE_READY\n');
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0); if (buffer.length < size + 4) return;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString()) as Frame;
        buffer = buffer.subarray(size + 4); received.push(value); behavior(socket, value);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
});
afterEach(async () => {
  for (const client of clients) client.close(); for (const peer of peers) peer.destroy();
  await new Promise<void>(resolve => server.close(() => resolve())); authority.close(); await app.close();
  await rm(directory, {recursive: true, force: true});
});
async function open(context: ResourceOwnerContext | ResourcePreviewContext = preview) {
  const client = await ResourceNativeClient.open(path, authority, context); clients.push(client); return client;
}

it('uses the actual current owner context for a distinct preview proof without a capacity hold', async () => {
  const client = await open();
  await expect(client.request('draft', {employeeId: approval.employeeId, idempotencyKey: randomUUID()}))
    .resolves.toEqual({state: 'CONTROLLED_SOURCE_RESPONSE', capacityHeld: false});
  expect(received.map(value => value.kind)).toEqual(['resource-operation', 'resource-owner-current']);
  expect(received[1]).toMatchObject({purpose: 'resource-replacement-v1', stage: 'preview', owner: null, approval: null,
    ownerScopeDigest: preview.ownerScopeDigest});
  expect(JSON.stringify(received)).not.toContain(token);
});
it('binds all exact approved references on an Apply proof', async () => {
  const client = await open(apply); await client.request('claim', {approval});
  expect(received[1].approval).toEqual(approval); expect(received[1].ownerScopeDigest).toBe(apply.ownerScopeDigest);
});
it('closes rather than proving another same-owner operation', async () => {
  behavior = (socket, value) => {if (value.kind === 'resource-operation') check(socket, value,
    {...approval, operationId: randomUUID()});};
  const client = await open(apply);
  await expect(client.request('claim', {approval})).rejects.toThrow();
  expect(received).toHaveLength(1);
  await expect(client.request('claim', {approval})).rejects.toThrow(); // no reconnect/retry
});
it('real logout destroys the tracked private socket before any owner proof is returned', async () => {
  behavior = (_socket, value) => {if (value.kind === 'resource-operation') auth.logout(token);};
  const client = await open(apply); await expect(client.request('claim', {approval})).rejects.toThrow();
  expect(received).toHaveLength(1);
});
it('refuses a serialized context and unsafe socket before connection', async () => {
  await expect(ResourceNativeClient.open(path, authority, {...preview})).rejects.toThrow();
  await chmod(path, 0o666); await expect(ResourceNativeClient.open(path, authority, preview)).rejects.toThrow();
  expect(peers.size).toBe(0);
});
it('cannot turn a preview into Apply or start a Session from an unsolicited launch event', async () => {
  const client = await open(); await expect(client.request('claim', {approval})).rejects.toThrow();
  behavior = (socket, value) => {if (value.kind === 'resource-operation') socket.write(frame({kind: 'resource-launch-ready',
    requestId: value.requestId, reference: randomUUID()}));};
  await expect(client.request('draft', {employeeId: approval.employeeId, idempotencyKey: randomUUID()})).rejects.toThrow();
  expect(received.every(value => value.kind === 'resource-operation')).toBe(true);
});

function completedRecord(): PlanMoveRecord {
  return {id: approval.operationId, employeeId: approval.employeeId, name: 'Fixture', oldSession: randomUUID(),
    newSession: approval.targetSid, fromAccount: 'same', toAccount: 'same', phase: 'completed', at: 1,
    purpose: 'runtime-refresh', runtimeDigest: 'c'.repeat(64), requestDigest: 'd'.repeat(64),
    sourceStopRequested: true, sourceCleanupVerified: true, resourceOwnerScope: 'e'.repeat(64),
    resourcePhase: 'verified', resourceIntent: {operationId: approval.operationId,
      reservationId: approval.reservationId, profileVersion: approval.profileVersion,
      profileDigest: approval.profileDigest, previewDigest: approval.previewDigest}};
}
function completionBehavior(failAfter = Infinity) {
  let count = 0;
  behavior = (socket, value) => {
    if (value.kind === 'resource-operation') {expect(value.verb).toBe('completion'); check(socket,value);}
    else if (++count > failAfter) socket.write(frame({kind: 'resource-refused', requestId: value.requestId,
      reason: 'HISTORICAL_NATIVE_FACTS_UNKNOWN'}));
    else socket.write(frame({kind: 'resource-result', requestId: value.requestId, value: {
      state: 'HISTORICAL_NATIVE_SETTLEMENT_CONFIRMED', operationId: approval.operationId,
      reservationId: approval.reservationId, employeeId: approval.employeeId, targetSid: approval.targetSid,
      profileVersion: approval.profileVersion, profileDigest: approval.profileDigest, previewDigest: approval.previewDigest,
      settlementDigest: 'f'.repeat(64), currentBindingDigest: 'a'.repeat(64), readOnly: true}}));
  };
}

it('reconciles completed restart metadata using two fresh read-only host inspections and no old handle', async () => {
  completionBehavior(); const original = completedRecord(), saves: PlanMoveRecord[][] = [];
  const moves = new PlanMoves({load: async () => [original], save: async rows => {saves.push(structuredClone(rows));}} as PlanMovePort);
  const cold = (await moves.get(original.id))!; expect(cold.phase).toBe('recovery-required');
  const client = await open(), proof = await client.historicalCompletion(cold);
  const result = await moves.reconcileResourceCompletion(cold.id,proof);
  expect(result).toMatchObject({phase: 'completed', resourceIntent: original.resourceIntent});
  expect(received.filter(row => row.kind === 'resource-operation').map(row => row.verb)).toEqual(['completion','completion']);
  expect(saves).toHaveLength(1);
  const restarted = new PlanMoves({load: async () => saves[0], save: async () => {}} as PlanMovePort);
  expect((await restarted.get(original.id))?.phase).toBe('recovery-required'); // Every process reobserves.
  client.close(); expect(() => proof.assertRecord(result)).toThrow();
});

it('keeps recovery on a refused second inspection and refuses serialized or mismatched proof', async () => {
  completionBehavior(1); const original = completedRecord(), saves: PlanMoveRecord[][] = [];
  const moves = new PlanMoves({load: async () => [original], save: async rows => {saves.push(structuredClone(rows));}} as PlanMovePort);
  const cold = (await moves.get(original.id))!;
  await expect(moves.reconcileResourceCompletion(cold.id, {} as ResourceHistoricalSettlement)).rejects.toThrow();
  const client = await open(), proof = await client.historicalCompletion(cold);
  expect(() => proof.assertRecord({...cold, newSession: randomUUID()})).toThrow();
  await expect(moves.reconcileResourceCompletion(cold.id,proof)).rejects.toThrow();
  expect((await moves.get(cold.id))?.phase).toBe('recovery-required');
  expect(saves.at(-1)?.[0].phase).toBe('recovery-required');
});

it('logout during reconciliation save retains recovery and ordinary non-resource restart stays terminal', async () => {
  completionBehavior(); const original = completedRecord();
  const moves = new PlanMoves({load: async () => [original], save: async () => {auth.logout(token);}} as PlanMovePort);
  const cold = (await moves.get(original.id))!, client = await open(), proof = await client.historicalCompletion(cold);
  await expect(moves.reconcileResourceCompletion(cold.id,proof)).rejects.toThrow();
  expect((await moves.get(cold.id))?.phase).toBe('recovery-required');
  const normal = {...original}; delete normal.resourceIntent; delete normal.resourceOwnerScope; delete normal.resourcePhase;
  const ordinary = new PlanMoves({load: async () => [normal], save: async () => {}} as PlanMovePort);
  expect((await ordinary.get(normal.id))?.phase).toBe('completed');
});

it('accepts the actual Python integral CPU response without losing a valid preview', async () => {
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const {dirname} = await import('node:path');
  const {goalFixtureRepository} = await import('./goal-source-fixture.js');
  const source = join(goalFixtureRepository(dirname(fileURLToPath(import.meta.url))), 'python');
  let operation: Frame;
  behavior = (socket, value) => {
    if (value.kind === 'resource-operation') { operation = value; check(socket, value); }
    else {
      const script = [
        'import sys,json,uuid;from unittest.mock import patch;sys.path.insert(0,sys.argv[1])',
        'from reverie import worker_resource_actor as A',
        'from reverie.worker_resources import validate_resources',
        'request=json.loads(sys.argv[2])',
        "resources={'budgetMode':'admission','memoryMiB':2048,'pidsLimit':512,'cpus':1.0,'poolMemoryMiB':8192,'poolTasksMax':4096}",
        'validate_resources(resources)',
        'class DraftOwner:',
        ' def draft(self,*args,**kwargs):',
        "  return {'draftId':str(uuid.uuid4()),'operationId':str(uuid.uuid4()),'reservationId':str(uuid.uuid4()),'targetSid':str(uuid.uuid4()),'profileVersion':'1','profileDigest':'a'*64,'previewDigest':'b'*64,'resources':resources,'sourceMemoryMiB':1024,'capacityHeld':False,'nativeEffects':False}",
        'connection=A._Connection.__new__(A._Connection);connection.owner=DraftOwner()',
        "with patch.object(A._OwnerOperation,'assert_current'),patch.object(A._OwnerOperation,'assert_live'):",
        ' result=connection.dispatch(request)',
        "sys.stdout.buffer.write(A.encoded({'kind':'resource-result','requestId':request['requestId'],'value':result}))",
      ].join('\n');
      const raw = execFileSync('python3', ['-I', '-B', '-c', script, source, JSON.stringify(operation!)],
        {timeout: 5000, maxBuffer: 65536, env: {PATH: process.env.PATH, HOME: directory}});
      const header = Buffer.alloc(4); header.writeUInt32BE(raw.length); socket.write(Buffer.concat([header, raw]));
    }
  };
  const client = await open();
  await expect(client.request('draft', {employeeId: approval.employeeId, idempotencyKey: randomUUID(), memoryMiB: 2048}))
    .resolves.toMatchObject({resources: {cpus: 1}, capacityHeld: false, nativeEffects: false});
});
