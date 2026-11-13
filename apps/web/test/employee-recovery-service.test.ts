/** Real application/account/Session stores and controlled native AF_UNIX port.
 * This is application custody/framing acceptance, not native effect evidence. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createServer, type Server, type Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import * as syncFs from 'node:fs';
import { rename as asyncRename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ResourceOwnerAuthority } from '../src/resource-owner-authority.js';
import { ResourceNativeClient, OriginalStoppedRecovery } from '../src/resource-native-client.js';
import { EmployeeRecoveryAttempt } from '../src/employee-recovery-attempt.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { PlanMoves, type PlanMoveInput, type PlanMoveRecord } from '../src/plan-move.js';
import { planMoveExecutor } from '../src/plan-move-runtime.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { Session, ProviderDispatchUnconfirmedError } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { expertRuntimeRecipe } from '../src/expert-runtime-recipe.js';
import { PROVIDER_LAUNCH_DISK_KEY, type ProviderLaunchExecution } from '../src/provider-launch-publication.js';
import { EmployeeRecoveryService, registerEmployeeRecoveryRoutes } from '../src/employee-recovery-service.js';
import {
  EmployeeRecoveryApproval,
  EmployeeRecoveryRequest,
  EmployeeRecoverySelection,
} from '../src/employee-recovery-operation.js';

let root: string, store: CompanyStore, company: CompanyService, session: Session, auth: OwnerAuthService, token: string;
let app: FastifyInstance, service: EmployeeRecoveryService, server: Server, employeeId: string;
let connected: number,
  mode: 'reply' | 'lost' | 'foreign' | 'paused' | 'legacy-stopped' | 'diagnostic',
  peers: Set<Socket>,
  messages: Record<string, unknown>[];
let atReply: Promise<void>, replyEntered: () => void, releaseReply: (() => void) | undefined;
let plans: PlanMoves;
let stoppedFrame:
  | 'none'
  | 'normal-close'
  | 'wrong-nonce'
  | 'wrong-scope'
  | 'wrong-request'
  | 'child'
  | 'truncated'
  | 'revoked-after-close'
  | 'binding-after-close';
let terminalReplyClosed: Promise<void> | undefined;
let registry: Map<string, Session>;
let publicationStore: StateStore;
let releaseFixtureWrites: Array<() => void> = [];
const physical = vi.hoisted(() => ({
  spawn: vi.fn(),
  exit: undefined as ((event: { exitCode: number }) => void) | undefined,
}));
vi.mock('node-pty', () => ({ spawn: physical.spawn }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const approval = () =>
  EmployeeRecoveryApproval.parse({
    operationId: randomUUID(),
    sessionId: session.id,
    sessionGeneration: '1',
    originalAttemptId: null,
    parentOperationId: null,
    action: 'stop-provider',
  });
const frame = (value: unknown) => {
  const data = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
};
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'recovery-api-'));
  vi.stubEnv('REVERIE_WORKER_SOCKET', join(root, 'native.sock'));
  releaseFixtureWrites = [];
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(root, 'auth.json')),
    auditFile: join(root, 'audit'),
    setupEnabled: true,
  });
  token = await auth.setup(
    'fixture-owner',
    'Synthetic-recovery-fixture-42!',
    'Synthetic-recovery-fixture-42!',
    '127.0.0.1'
  );
  publicationStore = new StateStore(join(root, 'state.json'));
  physical.spawn.mockReset().mockImplementation(() => ({
    pid: 999999998,
    onData: vi.fn(),
    onExit: (callback: (event: { exitCode: number }) => void) => {
      physical.exit = callback;
      return { dispose() {} };
    },
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  }));
  physical.exit = undefined;
  store = new CompanyStore(join(root, 'company.json'));
  await store.init();
  session = new Session({ id: randomUUID(), workingDir: root, mode: 'claude', useMux: false, publicationStore });
  company = freshCompany();
  await company.hire({
    name: 'Fixture',
    icon: 'F',
    position: 'Engineer',
    expertise: ['fixtures'],
    sessionId: session.id,
  });
  employeeId = company.view(undefined).employees[0]!.id;
  connected = 0;
  mode = 'reply';
  stoppedFrame = 'none';
  terminalReplyClosed = undefined;
  peers = new Set();
  messages = [];
  atReply = new Promise<void>((resolve) => {
    replyEntered = resolve;
  });
  releaseReply = undefined;
  server = createServer((socket) => {
    connected++;
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    let bytes = Buffer.alloc(0),
      ready = false,
      operation: Record<string, unknown>;
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!ready) {
        if (bytes.length < 5) return;
        const size = bytes.readUInt32BE(1);
        if (bytes.length < size + 5) return;
        expect(bytes[0]).toBe('Q'.charCodeAt(0));
        expect(JSON.parse(bytes.subarray(5, 5 + size).toString())).toEqual({
          purpose: 'resource-ram-pool-v2',
          version: 2,
        });
        bytes = bytes.subarray(5 + size);
        ready = true;
        socket.write('RESOURCE_READY\n');
      }
      while (bytes.length >= 4) {
        const size = bytes.readUInt32BE(0);
        if (bytes.length < size + 4) return;
        const value = JSON.parse(bytes.subarray(4, 4 + size).toString()) as Record<string, unknown>;
        bytes = bytes.subarray(size + 4);
        messages.push(value);
        if (value.kind === 'resource-operation') {
          operation = value;
          const persisted = JSON.parse(requireFile());
          const approved = EmployeeRecoveryApproval.parse(value.approval);
          if (approved.parentOperationId === null)
            expect(persisted.employeeRecoveryOperations[0].approval).toEqual(approved);
          else {
            expect(persisted.employeeRecoveryOperations).toHaveLength(1);
            expect(persisted.employeeRecoveryOperations[0].approval.operationId).toBe(approved.parentOperationId);
            expect(persisted.employeeRecoveryOperations[0].component.approval).toEqual(approved);
          }
          socket.write(
            frame({
              kind: 'resource-owner-check',
              requestId: value.requestId,
              nonce: randomUUID(),
              stage: value.verb,
              employeeId,
              approval: value.approval,
            })
          );
        } else {
          expect(value.kind).toBe('resource-owner-current');
          expect(value).not.toHaveProperty('principal');
          expect(value.recoveryAuthority).toMatchObject({ kind: 'human-owner' });
          if (mode === 'lost') socket.destroy();
          else {
            const respond = () => {
              const valueResult = {
                version: 1,
                purpose: 'employee-recovery-v1',
                employeeId: mode === 'foreign' ? randomUUID() : employeeId,
                approval: operation.approval,
                outcome:
                  mode === 'diagnostic'
                    ? 'unconfirmed'
                    : mode === 'legacy-stopped'
                      ? 'provider-stopped'
                      : EmployeeRecoveryApproval.parse(operation.approval).action === 'close-viewer'
                        ? 'viewer-close-pending'
                        : EmployeeRecoveryApproval.parse(operation.approval).action === 'reconcile-owned'
                          ? 'original-handler-pending'
                          : 'provider-stop-pending',
                newDispatch:
                  EmployeeRecoveryApproval.parse(operation.approval).action === 'reconcile-owned'
                    ? 'not-attempted'
                    : 'attempted',
                earlierEffects: 'unproved',
                ...(mode === 'diagnostic'
                  ? {
                      diagnostics: {
                        primaryCode: 'WORKER_RECOVERY_PROVIDER_UNCONFIRMED',
                        secondaryCode: 'WORKER_REPORT_CLOSE_UNKNOWN',
                      },
                    }
                  : {}),
              };
              if (stoppedFrame !== 'none' && operation.verb === 'employee-recovery-observe') {
                valueResult.outcome = 'provider-stopped';
                const closed = {
                  kind: 'resource-stopped-original',
                  version: 1,
                  purpose: 'employee-recovery-stopped-original-v1',
                  requestId: stoppedFrame === 'wrong-request' ? randomUUID() : operation.requestId,
                  ownerNonce: stoppedFrame === 'wrong-nonce' ? randomUUID() : value.nonce,
                  ownerScopeDigest: stoppedFrame === 'wrong-scope' ? '0'.repeat(64) : value.ownerScopeDigest,
                  employeeId,
                  approval:
                    stoppedFrame === 'child'
                      ? {
                          ...EmployeeRecoveryApproval.parse(operation.approval),
                          operationId: randomUUID(),
                          parentOperationId: EmployeeRecoveryApproval.parse(operation.approval).operationId,
                          action: 'close-viewer',
                        }
                      : operation.approval,
                  value: valueResult,
                };
                terminalReplyClosed = new Promise<void>((done) => socket.once('close', () => done()));
                const encoded = frame(closed);
                socket.end(stoppedFrame === 'truncated' ? encoded.subarray(0, encoded.length - 1) : encoded);
              } else
                socket.write(frame({ kind: 'resource-result', requestId: operation.requestId, value: valueResult }));
            };
            if (mode === 'paused') {
              releaseReply = respond;
              replyEntered();
            } else respond();
          }
        }
      }
    });
  });
  const socket = join(root, 'native.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  const planStore = new PlanMoveStore(join(root, 'moves.json'));
  plans = new PlanMoves({
    load: () => planStore.load(),
    save: (rows: PlanMoveRecord[]) => planStore.save(rows),
  } as never);
  service = new EmployeeRecoveryService(company, auth, socket, plans);
  await openRecoveryApp();
});
function freshCompany(stopSession?: (id: string) => Promise<void>): CompanyService {
  const sessions = (registry = new Map([[session.id, session]])),
    rooms = new ChatroomStore();
  return new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    chatrooms: {
      rooms: () => rooms.list(),
      room: (id) => rooms.get(id),
      addMember: (id, s, opts) => rooms.addMember(id, s, opts).member,
      setStatus: (id, s, status) => rooms.setStatus(id, s, status),
    },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    ...(stopSession ? { stopSession } : {}),
  });
}
async function openRecoveryApp(): Promise<void> {
  if (app) await app.close();
  app = Fastify();
  await app.register(cookie);
  registerEmployeeRecoveryRoutes(app, service);
}
function requireFile(): string {
  return readFileSync(store.file, 'utf8');
}
import { readFileSync } from 'node:fs';
afterEach(async () => {
  for (const release of releaseFixtureWrites) release();
  if (!publicationStore.statePublicationHeld) await publicationStore.saveNowAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
  service.close();
  for (const peer of peers) peer.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const send = (selected = approval()) =>
  app.inject({
    method: 'POST',
    url: '/api/company/employees/' + employeeId + '/recovery',
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
    payload: { approval: selected },
  });
const inspect = (selected: ReturnType<typeof approval>) =>
  app.inject({
    method: 'POST',
    url: '/api/company/employees/' + employeeId + '/recovery/observe',
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
    payload: { approval: selected },
  });

it('commits original resource/op denial before Q and retains it without granting launch/input or public data', async () => {
  const launch = vi.spyOn(session, 'startInteractive'),
    input = vi.spyOn(session, 'sendInput'),
    stop = vi.spyOn(session, 'stop');
  const selected = approval(),
    before = company.view(undefined).employees[0];
  expect((await send(selected)).statusCode).toBe(200);
  expect(connected).toBe(1);
  expect(messages).toHaveLength(2);
  expect(company.view(undefined).employees[0]).toEqual(before);
  expect(company.view(undefined)).not.toHaveProperty('employeeRecoveryOperations');
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect((await send(selected)).statusCode).toBe(200);
  expect(connected).toBe(2);
  expect(
    messages.filter((message) => message.kind === 'resource-operation').map((message) => message.approval)
  ).toEqual([selected, selected]);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect((await send()).statusCode).toBe(409);
  expect(connected).toBe(2);
  expect(launch).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});
it('renews only the same original Q under fresh effect authority and cannot reconstruct an owner from loaded rows', async () => {
  mode = 'lost';
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(503);
  expect((await send(selected)).statusCode).toBe(503);
  expect(connected).toBe(2);
  expect(
    messages.filter((message) => message.kind === 'resource-operation').map((message) => message.approval)
  ).toEqual([selected, selected]);
  service.close();
  store = new CompanyStore(store.file);
  await store.init();
  session = new Session({ id: session.id, workingDir: root, mode: 'claude', useMux: false });
  company = freshCompany();
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  expect((await send(selected)).statusCode).toBe(409);
  expect((await send()).statusCode).toBe(409);
  expect(connected).toBe(2);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
});
it('rechecks a new repeat caller after joining the original pending reply without replay or revoking the original actor', async () => {
  mode = 'paused';
  const selected = approval(),
    first = Promise.resolve(send(selected));
  await atReply;
  const login = await auth.login('fixture-owner', 'Synthetic-recovery-fixture-42!', '127.0.0.1'),
    secondToken = login.session!;
  let secondContext: ReturnType<ResourceOwnerAuthority['captureEmployeeRecovery']> | undefined,
    assertions = 0,
    joined!: () => void;
  const atJoin = new Promise<void>((resolve) => {
    joined = resolve;
  });
  const capture = ResourceOwnerAuthority.prototype.captureEmployeeRecovery;
  vi.spyOn(ResourceOwnerAuthority.prototype, 'captureEmployeeRecovery').mockImplementation(function (
    this: ResourceOwnerAuthority,
    ...args
  ) {
    const context = capture.apply(this, args);
    if (args[0].cookies?.reverie_owner === secondToken) secondContext = context;
    return context;
  });
  const assert = ResourceOwnerAuthority.prototype.assertRecoveryAuthentication;
  vi.spyOn(ResourceOwnerAuthority.prototype, 'assertRecoveryAuthentication').mockImplementation(function (
    this: ResourceOwnerAuthority,
    context
  ) {
    assert.call(this, context);
    if (context === secondContext && ++assertions === 2) joined();
  });
  const second = Promise.resolve(
    app.inject({
      method: 'POST',
      url: '/api/company/employees/' + employeeId + '/recovery',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + secondToken },
      payload: { approval: selected },
    })
  );
  await atJoin;
  await new Promise<void>((resolve) => setImmediate(resolve));
  auth.logout(secondToken);
  releaseReply!();
  const [original, repeat] = await Promise.all([first, second]);
  expect(original.statusCode).toBe(200);
  expect(repeat.statusCode).toBe(403);
  expect(connected).toBe(1);
  expect(messages.filter((message) => message.kind === 'resource-operation')).toHaveLength(1);
});
it('rejects a foreign native result on the genuine Q exchange while retaining the original denial and all provider holds', async () => {
  mode = 'foreign';
  const selected = approval(),
    launch = vi.spyOn(session, 'startInteractive'),
    input = vi.spyOn(session, 'sendInput');
  expect((await send(selected)).statusCode).toBe(503);
  expect(store.snapshot().employeeRecoveryOperations?.[0]?.phase).toBe('issued');
  expect((await send()).statusCode).toBe(409);
  expect(connected).toBe(1);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(launch).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
});
it('rechecks the whole original canonical operation before a fresh observation, including phase/observation changes', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  await store.update((state) => {
    state.employeeRecoveryOperations![0]!.observationDigest = '0'.repeat(64);
  });
  expect((await inspect(selected)).statusCode).toBe(503);
  expect(connected).toBe(1);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
});
it('fresh owner authorization can inspect the retained original after original actor revocation without replaying stop', async () => {
  mode = 'lost';
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(503);
  auth.logout(token);
  expect((await inspect(selected)).statusCode).toBe(403);
  expect(connected).toBe(1);
  const signedIn = await auth.login('fixture-owner', 'Synthetic-recovery-fixture-42!', '127.0.0.1');
  token = signedIn.session!;
  mode = 'reply';
  expect((await inspect(selected)).statusCode).toBe(200);
  expect(messages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
  expect(
    messages.filter((message) => message.kind === 'resource-operation').map((message) => message.approval)
  ).toEqual([selected, selected]);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect((await send()).statusCode).toBe(409);
  expect(connected).toBe(2);
});

it('expires only the original ten-second Q then allows a fresh owner read and explicit same-operation action without a new reservation', async () => {
  mode = 'paused';
  const selected = approval(),
    first = Promise.resolve(send(selected));
  await atReply;
  const current = messages.find((message) => message.kind === 'resource-owner-current')!;
  expect(Number(current.expiresAtEpochMs) - Date.now()).toBeLessThanOrEqual(10_000);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_001);
  releaseReply!();
  expect((await first).statusCode).toBe(503);
  const login = await auth.login('fixture-owner', 'Synthetic-recovery-fixture-42!', '127.0.0.1');
  token = login.session!;
  mode = 'reply';
  expect((await inspect(selected)).statusCode).toBe(200);
  expect((await send(selected)).statusCode).toBe(200);
  expect(messages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
    'employee-recovery',
  ]);
  expect(
    messages.filter((message) => message.kind === 'resource-operation').map((message) => message.approval)
  ).toEqual([selected, selected, selected]);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect((await send()).statusCode).toBe(409);
});
it('rechecks actual owner after waiting for the canonical writer before any denial or Q dispatch', async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  const writer = store.update(
    () => undefined,
    () => {},
    async () => {
      entered();
      await blocked;
    }
  );
  await started;
  let queued!: () => void;
  const reached = new Promise<void>((resolve) => (queued = resolve));
  const original = CompanyStore.prototype.publishEmployeeRecovery;
  vi.spyOn(CompanyStore.prototype, 'publishEmployeeRecovery').mockImplementation(function (
    this: CompanyStore,
    ...args
  ) {
    queued();
    return original.apply(this, args);
  });
  const selected = approval(),
    pending = send(selected);
  releaseFixtureWrites.push(release);
  await reached;
  auth.logout(token);
  release();
  await writer;
  expect((await pending).statusCode).toBe(403);
  expect(connected).toBe(0);
  expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
  token = (await auth.login('fixture-owner', 'Synthetic-recovery-fixture-42!', '127.0.0.1')).session!;
  expect((await send(selected)).statusCode).toBe(200);
  expect(store.snapshot().employeeRecoveryOperations![0]!.approval).toEqual(selected);
});

it('retains actual rename-then-error admission as unknown without opening native Q or refunding the row', async () => {
  const rename = fs.rename.bind(fs),
    cause = new Error('fixture-original-rename-ack-lost');
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to) === store.file) throw cause;
  });
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(503);
  expect(connected).toBe(0);
  const raw = JSON.parse(requireFile());
  expect(raw.employeeRecoveryOperations[0].approval).toEqual(selected);
  expect((await send(selected)).statusCode).toBe(503); // No genuine writer acknowledgement can arm continuation.
  expect((await send()).statusCode).toBe(409);
  expect(connected).toBe(0);
  expect(JSON.parse(requireFile()).employeeRecoveryOperations).toHaveLength(1);
});

it.each(['same', 'aba'] as const)(
  'fresh authorization retains the exact original resource after %s owner metadata assignment between requests',
  async (change) => {
    mode = 'lost';
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(503);
    const owner = session.owner;
    session.owner = change === 'same' ? owner : 'fixture-other-owner';
    session.owner = owner;
    mode = 'reply';
    expect((await inspect(selected)).statusCode).toBe(200);
    expect((await send(selected)).statusCode).toBe(200);
    expect(connected).toBe(3);
    expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  }
);

it('staged/counterfeit admission and a noop lock cannot mint the actual Store acknowledgement', async () => {
  const authority = new ResourceOwnerAuthority(auth);
  const before = requireFile();
  app.post('/hostile', async (req) => {
    const selected = EmployeeRecoveryRequest.parse(req.body).approval;
    const context = authority.captureEmployeeRecovery(req, employeeId, selected);
    const attempt = await EmployeeRecoveryAttempt.capture(
      company,
      plans,
      authority,
      context,
      undefined,
      join(root, 'native.sock')
    );
    expect(() => authority.bindEmployeeRecoveryAttempt(context, attempt)).toThrow();
    expect(() => new EmployeeRecoveryAttempt(Symbol('forged'), company, authority, context, {} as never)).toThrow();
    expect(() => company.claimEmployeeRecovery(Object.create(EmployeeRecoveryAttempt.prototype))).toThrow();
    expect(() =>
      store.consumeEmployeeRecoveryAcknowledgement(Object.create(EmployeeRecoveryAttempt.prototype))
    ).toThrow();
    const privatePort = store as unknown as { locked: () => Promise<undefined> };
    const skipped = vi.spyOn(privatePort, 'locked').mockResolvedValue(undefined);
    try {
      await expect(attempt.reserve()).rejects.toThrow('did not acknowledge');
    } finally {
      skipped.mockRestore();
    }
    expect(() => authority.bindEmployeeRecoveryAttempt(context, attempt)).toThrow();
    expect(requireFile()).toBe(before);
    expect(connected).toBe(0);
    return { refused: true };
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/hostile',
        headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
        payload: { approval: approval() },
      })
    ).json()
  ).toEqual({ refused: true });
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
  expect((await send()).statusCode).toBe(200);
  expect(connected).toBe(1);
  authority.close();
});

it('actual move locking before bindingMigration publication refuses recovery without Q or a durable row', async () => {
  let entered!: () => void, release!: () => void;
  const atSnapshot = new Promise<void>((resolve) => (entered = resolve)),
    wait = new Promise<void>((resolve) => (release = resolve));
  const moveStore = new PlanMoveStore(join(root, 'paused-moves.json'));
  const create = vi.fn(),
    start = vi.fn(),
    stop = vi.fn();
  plans = new PlanMoves({
    load: () => moveStore.load(),
    save: (rows: PlanMoveRecord[]) => moveStore.save(rows),
    snapshot: async () => {
      entered();
      await wait;
      throw Error('fixture-read-only-snapshot-ended');
    },
    create,
    start,
    stop,
  } as never);
  service.close();
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  const input: PlanMoveInput = {
    id: 'paused-original-move',
    employeeId,
    sessionId: session.id,
    fromAccount: 'old',
    toAccount: 'new',
    forceBusy: false,
    handoff: 'Fixture only',
  };
  const moving = plans.begin(input);
  const settled = moving.catch((error) => error);
  await atSnapshot;
  expect(company.view(undefined).employees[0]!.bindingMigration).toBeUndefined();
  expect((await send()).statusCode).toBe(503);
  expect(connected).toBe(0);
  expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
  release();
  expect(String(await settled)).toContain('fixture-read-only-snapshot-ended');
  expect(create).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});

it('a held recovery denies actual move snapshot, wake, runtime restart and replacement admission before effects', async () => {
  mode = 'lost';
  expect((await send()).statusCode).toBe(503);
  const allocations = vi.fn(),
    cleanup = vi.fn(),
    request = vi.fn();
  const executor = planMoveExecutor({
    company,
    plans: { allocations, account: vi.fn() },
    chat: { rooms: () => [], post: vi.fn(), auditEntry: vi.fn() },
    sessions: new Map([[session.id, session]]),
    mux: { getSession: () => undefined, isPaneDead: () => false },
    cleanup,
    authorized: () => auth.session(token) !== undefined,
    request,
  } as never);
  await expect(executor.snapshot(employeeId, undefined)).rejects.toThrow('recovery operation');
  expect(company.prepareWake(employeeId, session.id)).toBeUndefined();
  await expect(company.claimWake(employeeId, session.id, Date.now())).resolves.toBe(false);
  expect(() => company.prepareRuntimeRestart(session.id, undefined)).toThrow('recovery operation');
  expect(() => company.prepareSpawn({ employeeId })).toThrow('recovery operation');
  await expect(session.runPrompt('fixture-only')).rejects.toThrow('Employee recovery');
  await expect(session.startInteractive()).rejects.toThrow('Employee recovery');
  await expect(session.startShell()).rejects.toThrow('Employee recovery');
  expect(allocations).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(connected).toBe(1);
});

it('fresh authority cannot transfer an original recovery to a newly staged genuine launch publication', async () => {
  mode = 'lost';
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(503);
  publicationStore.stageProviderLaunch(session, {
    transport: 'local-pty',
    current: () => true,
    snapshot: () => session.toPersistedState(),
  });
  mode = 'reply';
  expect((await inspect(selected)).statusCode).toBe(409);
  expect((await send(selected)).statusCode).toBe(409);
  expect(connected).toBe(1);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
});

it.each(['none', 'local-original'] as const)(
  'reconcile retires only an actual acknowledged never-claimed app intent with %s older provider',
  async (older) => {
    if (older === 'local-original') {
      vi.stubEnv('REVERIE_WORKER_SOCKET', '');
      session = new Session({ id: session.id, mode: 'claude', workingDir: root, useMux: false, publicationStore });
      registry.set(session.id, session);
    }
    session.setMode('shell');
    if (older === 'local-original') await session.startShell();
    const before =
      older === 'none'
        ? undefined
        : JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id];
    let current = true;
    const pending = publicationStore.stageProviderLaunch(session, {
      transport: 'native-ordinary',
      brokerSocket: '/synthetic/never-dispatched',
      current: () => current,
      snapshot: () => session.toPersistedState(),
    });
    const execution: ProviderLaunchExecution = {
      kind: 'pty',
      sessionId: session.id,
      owner: session.owner ?? null,
      mode: session.mode,
      command: 'fixed-unused',
      cwd: root,
      environment: {},
    };
    await pending.prepare(session, execution);
    expect(pending.acknowledgedNeverClaimed(session)).toBe(true);
    current = false;
    const selected = approval();
    if (older === 'local-original') {
      expect((await send(selected)).statusCode).toBe(409);
      expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
      expect(messages).toHaveLength(0);
      expect(pending.acknowledgedNeverClaimed(session)).toBe(true);
      physical.exit?.({ exitCode: 0 });
      return;
    }
    expect((await send(selected)).statusCode).toBe(200);
    expect(
      JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id].attemptId
    ).toBe(pending.retainedDenial(session).attemptId);
    expect((await inspect(selected)).statusCode).toBe(200);
    const after = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id];
    expect(after).toEqual(before);
    expect(pending.acknowledgedNeverClaimed(session)).toBe(false);
    expect(() => pending.claim()).toThrow();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
    expect(messages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
    ]);
    expect(physical.spawn).toHaveBeenCalledTimes(older === 'none' ? 0 : 1);
    physical.exit?.({ exitCode: 0 });
  }
);

it('unknown unused-intent publication remains held while a fresh native observation stays available without a new effect', async () => {
  const pending = publicationStore.stageProviderLaunch(session, {
    transport: 'native-ordinary',
    brokerSocket: '/synthetic/unused',
    current: () => true,
    snapshot: () => session.toPersistedState(),
  });
  await pending.prepare(session, {
    kind: 'pty',
    sessionId: session.id,
    owner: session.owner ?? null,
    mode: session.mode,
    command: 'unused-fixed',
    cwd: root,
    environment: {},
  });
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  const actualRename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  let injected = false;
  vi.mocked(syncFs.renameSync).mockImplementation((from, to) => {
    actualRename(from, to);
    if (String(to) === join(root, 'state.json') && !injected) {
      injected = true;
      throw Error('PRIVATE_UNKNOWN_RETIREMENT_CAUSE');
    }
  });
  const observed = await inspect(selected);
  expect(observed.statusCode).toBe(200);
  expect(observed.json().data.application).toEqual({ state: 'recovery-required', intentRetirement: 'unconfirmed' });
  expect(observed.body).not.toContain('PRIVATE_UNKNOWN_RETIREMENT_CAUSE');
  expect(publicationStore.statePublicationHeld).toBe(true);
  expect(pending.acknowledgedNeverClaimed(session)).toBe(true);
  expect((await inspect(selected)).statusCode).toBe(200);
  expect(messages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
    'employee-recovery-observe',
  ]);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
});

it('revocation while genuine unused-retirement waits behind the actual state writer prevents that write and native read', async () => {
  const pending = publicationStore.stageProviderLaunch(session, {
    transport: 'native-ordinary',
    brokerSocket: '/synthetic/unused',
    current: () => true,
    snapshot: () => session.toPersistedState(),
  });
  await pending.prepare(session, {
    kind: 'pty',
    sessionId: session.id,
    owner: session.owner ?? null,
    mode: session.mode,
    command: 'unused-fixed',
    cwd: root,
    environment: {},
  });
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  let reached!: () => void, release!: () => void, queued!: () => void;
  const atRename = new Promise<void>((resolve) => (reached = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve)),
    atRetirement = new Promise<void>((resolve) => (queued = resolve));
  releaseFixtureWrites.push(() => release());
  const rename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
  vi.mocked(asyncRename).mockImplementation(async (from, to) => {
    if (String(to) === join(root, 'state.json')) {
      reached();
      await gate;
    }
    return rename(from, to);
  });
  const retirement = publicationStore.retireUnusedProviderLaunch.bind(publicationStore);
  vi.spyOn(publicationStore, 'retireUnusedProviderLaunch').mockImplementation((...args) => {
    queued();
    return retirement(...args);
  });
  publicationStore.setSession(session.id, { ...session.toPersistedState(), name: 'Queued public observation' });
  const saving = publicationStore.saveNowAsync();
  await atRename;
  const observing = Promise.resolve(inspect(selected));
  await atRetirement;
  auth.logout(token);
  release();
  await saving;
  expect((await observing).statusCode).toBe(403);
  expect(pending.acknowledgedNeverClaimed(session)).toBe(true);
  expect(publicationStore.statePublicationHeld).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id]).toEqual(
    pending.retainedDenial(session)
  );
  expect(messages.filter((message) => message.kind === 'resource-operation')).toHaveLength(1);
  expect(physical.spawn).not.toHaveBeenCalled();
  publicationStore.saveNow();
});

it('acknowledges one immutable viewer component inside its actual retained stop parent before Q, never a second resource row', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  const parent = store.snapshot().employeeRecoveryOperations![0]!;
  const child = EmployeeRecoveryApproval.parse({
    ...selected,
    operationId: randomUUID(),
    parentOperationId: selected.operationId,
    action: 'close-viewer',
  });
  expect((await send(child)).statusCode).toBe(200);
  const retained = store.snapshot().employeeRecoveryOperations!;
  expect(retained).toHaveLength(1);
  expect(retained[0]!.approval).toEqual(selected);
  expect(retained[0]!.actorScopeDigest).toBe(parent.actorScopeDigest);
  expect(retained[0]!.component?.approval).toEqual(child);
  expect((await send(child)).statusCode).toBe(200);
  expect((await inspect(child)).statusCode).toBe(200);
  expect((await send({ ...child, operationId: randomUUID() })).statusCode).toBe(409);
  expect((await send({ ...child, operationId: randomUUID(), parentOperationId: randomUUID() })).statusCode).toBe(409);
  expect(
    messages.filter((message) => message.kind === 'resource-operation').map((message) => message.approval)
  ).toEqual([selected, child, child, child]);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('a child with unknown original Q cannot be replaced by a new ID or retarget the parent stop', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  const child = EmployeeRecoveryApproval.parse({
    ...selected,
    operationId: randomUUID(),
    parentOperationId: selected.operationId,
    action: 'close-viewer',
  });
  mode = 'lost';
  expect((await send(child)).statusCode).toBe(503);
  mode = 'reply';
  expect((await send({ ...child, operationId: randomUUID() })).statusCode).toBe(409);
  expect((await inspect(child)).statusCode).toBe(200);
  expect(store.snapshot().employeeRecoveryOperations![0]!.approval).toEqual(selected);
  expect(store.snapshot().employeeRecoveryOperations![0]!.component?.approval).toEqual(child);
  expect(messages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)).toEqual([
    'employee-recovery',
    'employee-recovery',
    'employee-recovery-observe',
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
});

const selectRecovery = () =>
  app.inject({
    method: 'GET',
    url: '/api/company/employees/' + employeeId + '/recovery-selection',
    headers: { host: 'localhost', cookie: 'reverie_owner=' + token },
  });
it('selection returns only current read-only binding and exact retained approvals, without reservation or Q', async () => {
  const initial = await selectRecovery();
  expect(initial.statusCode, initial.body).toBe(200);
  const data = EmployeeRecoverySelection.parse(initial.json().data);
  expect(data).toMatchObject({
    employeeId,
    sessionId: session.id,
    sessionGeneration: '1',
    readOnly: true,
    recovery: { kind: 'none' },
    provider: { source: 'unavailable', originalAttemptId: null, providerExecution: 'unproved' },
    availability: { stopProvider: { state: 'available', reason: null } },
  });
  expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
  expect(messages).toHaveLength(0);
  mode = 'lost';
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(503);
  const retained = await selectRecovery();
  expect(retained.statusCode, retained.body).toBe(200);
  expect(EmployeeRecoverySelection.parse(retained.json().data)).toMatchObject({
    recovery: {
      kind: 'retained',
      approval: selected,
      componentApproval: null,
      application: { state: 'recovery-required' },
    },
    availability: {
      stopProvider: { state: 'available' },
      reconcileOwned: { state: 'unavailable', reason: 'existing-recovery' },
    },
  });
  expect(retained.body).not.toContain('actorScopeDigest');
  expect(messages.filter((message) => message.kind === 'resource-operation')).toHaveLength(1);
});
it('selection labels the genuine private claim preparation window without minting another operation', async () => {
  let entered!: () => void, release!: () => void;
  const joined = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  releaseFixtureWrites.push(() => release());
  const guard = PlanMoves.prototype.employeeRecoveryGuard;
  vi.spyOn(PlanMoves.prototype, 'employeeRecoveryGuard').mockImplementationOnce(async function (
    this: PlanMoves,
    ...args
  ) {
    entered();
    await gate;
    return guard.apply(this, args);
  });
  const sending = Promise.resolve(send());
  await joined;
  const selected = await selectRecovery();
  expect(selected.statusCode, selected.body).toBe(200);
  const data = EmployeeRecoverySelection.parse(selected.json().data);
  expect(data.recovery).toEqual({ kind: 'preparing' });
  expect(Object.values(data.availability).every((value) => value.state === 'unavailable')).toBe(true);
  expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
  expect(messages).toHaveLength(0);
  release();
  expect((await sending).statusCode).toBe(200);
});

it.each(['local', 'remote', 'docker', 'missing-channel'] as const)(
  'refuses unsupported %s before the Company reservation and every native query',
  async (kind) => {
    if (kind === 'missing-channel') await fs.unlink(join(root, 'native.sock'));
    else {
      if (kind === 'local') vi.stubEnv('REVERIE_WORKER_SOCKET', '');
      const options: Partial<ConstructorParameters<typeof Session>[0]> =
        kind === 'remote'
          ? {
              remote: {
                hostId: 'fixture',
                label: 'Synthetic remote',
                host: 'invalid.example',
                username: 'fixture',
                remotePath: '/fixture',
              },
            }
          : kind === 'docker'
            ? {
                docker: {
                  hostId: 'fixture',
                  label: 'Synthetic docker',
                  engine: 'docker',
                  image: 'synthetic',
                  containerName: 'fixture',
                  hostWorkspacePath: root,
                  containerWorkdir: '/fixture',
                  network: 'none',
                  mountCredentials: false,
                  hooksEnabled: false,
                  resumeOnStart: false,
                },
              }
            : {};
      session = new Session({
        id: session.id,
        workingDir: root,
        mode: 'claude',
        useMux: false,
        publicationStore,
        ...options,
      });
      registry.set(session.id, session);
    }
    const result = await send();
    expect(result.statusCode, result.body).toBe(kind === 'missing-channel' ? 503 : 409);
    expect(result.json()).toMatchObject({
      success: false,
      reason: kind === 'missing-channel' ? 'no-native-channel' : 'unsupported-provider',
    });
    expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(messages).toHaveLength(0);
    expect(connected).toBe(0);
    expect(physical.spawn).not.toHaveBeenCalled();
  }
);

it('discovers the actual last native dispatch while a newer preparation is refused by its original fence', async () => {
  session.setMode('shell');
  await expect(session.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(physical.spawn).toHaveBeenCalledOnce();
  const original = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[
    session.id
  ];
  const first = EmployeeRecoverySelection.parse((await selectRecovery()).json().data);
  expect(first.provider).toEqual({
    source: 'retained-native-dispatch',
    originalAttemptId: original.attemptId,
    providerExecution: 'unproved',
  });
  const pending = publicationStore.stageProviderLaunch(session, {
    transport: 'native-ordinary',
    brokerSocket: join(root, 'native.sock'),
    current: () => true,
    snapshot: () => session.toPersistedState(),
  });
  await expect(
    pending.prepare(session, {
      kind: 'pty',
      sessionId: session.id,
      owner: session.owner ?? null,
      mode: session.mode,
      cwd: root,
      command: 'fixed-not-dispatched',
      environment: {},
    })
  ).rejects.toThrow('An earlier provider launch intent remains unresolved');
  const second = EmployeeRecoverySelection.parse((await selectRecovery()).json().data);
  expect(second.provider).toEqual(first.provider);
  expect(second.unusedIntent).toBe('unconfirmed');
  expect(pending.acknowledgedNeverClaimed(session)).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id]).toEqual(
    original
  );
  expect(physical.spawn).toHaveBeenCalledOnce();
  expect(messages).toHaveLength(0);
  expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
});

it('refuses a changed configured endpoint before reservation or Q while preserving original selectors', async () => {
  session.setMode('shell');
  await expect(session.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  const row = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id];
  const wrong = createServer();
  let wrongConnections = 0;
  wrong.on('connection', (socket) => {
    wrongConnections++;
    socket.destroy();
  });
  const wrongPath = join(root, 'b.sock');
  await new Promise<void>((resolve) => wrong.listen(wrongPath, resolve));
  await fs.chmod(wrongPath, 0o600);
  try {
    service.close();
    service = new EmployeeRecoveryService(company, auth, wrongPath, plans);
    await openRecoveryApp();
    const selected = await selectRecovery();
    expect(selected.statusCode, selected.body).toBe(200);
    const data = EmployeeRecoverySelection.parse(selected.json().data);
    expect(data.provider.originalAttemptId).toBe(row.attemptId);
    expect(data.availability.stopProvider).toEqual({ state: 'unavailable', reason: 'no-native-channel' });
    expect(selected.body).not.toContain(wrongPath);
    expect((await send({ ...approval(), originalAttemptId: row.attemptId })).statusCode).toBe(503);
    expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(connected).toBe(0);
    expect(wrongConnections).toBe(0);
    expect(messages).toHaveLength(0);
    expect(physical.spawn).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>((resolve) => wrong.close(() => resolve()));
  }
});

async function otherRecoveryEmployee() {
  const other = new Session({ id: randomUUID(), workingDir: root, mode: 'claude', useMux: false, publicationStore });
  registry.set(other.id, other);
  await company.hire({
    name: 'Other fixture',
    icon: 'O',
    position: 'Engineer',
    expertise: ['fixtures'],
    sessionId: other.id,
  });
  const employee = store.snapshot().employees.find((row) => row.sessionId === other.id)!;
  return { session: other, employee };
}
function sendFor(target: string, selected: ReturnType<typeof approval>) {
  return app.inject({
    method: 'POST',
    url: '/api/company/employees/' + target + '/recovery',
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
    payload: { approval: selected },
  });
}
it('keeps the first original inspectable when two genuine targets overlap before capture with the same operation id', async () => {
  const other = await otherRecoveryEmployee(),
    selected = approval();
  let firstCaptured!: () => void, secondCaptured!: () => void, releaseFirst!: () => void, releaseSecond!: () => void;
  const atFirst = new Promise<void>((done) => {
    firstCaptured = done;
  });
  const atSecond = new Promise<void>((done) => {
    secondCaptured = done;
  });
  const firstGate = new Promise<void>((done) => {
    releaseFirst = done;
  });
  const secondGate = new Promise<void>((done) => {
    releaseSecond = done;
  });
  releaseFixtureWrites.push(releaseFirst, releaseSecond);
  const capture = EmployeeRecoveryAttempt.capture;
  let secondCaptureCount = 0;
  vi.spyOn(EmployeeRecoveryAttempt, 'capture').mockImplementation(async (...args) => {
    const original = await capture.apply(EmployeeRecoveryAttempt, args);
    if (args[3].employeeId === employeeId) {
      firstCaptured();
      await firstGate;
    } else {
      secondCaptureCount++;
      secondCaptured();
      await secondGate;
    }
    return original;
  });
  mode = 'paused';
  const first = Promise.resolve(send(selected));
  await atFirst;
  const collision = Promise.resolve(sendFor(other.employee.id, { ...selected, sessionId: other.session.id }));
  await Promise.race([atSecond, collision]);
  releaseFirst();
  await atReply;
  releaseSecond();
  const refused = await collision;
  mode = 'reply';
  releaseReply!();
  const accepted = await first;
  const selection = await app.inject({
    method: 'GET',
    url: '/api/company/employees/' + employeeId + '/recovery-selection',
    headers: { host: 'localhost', cookie: 'reverie_owner=' + token },
  });
  const observed = await inspect(selected);
  expect(accepted.statusCode).toBe(200);
  expect(selection.json().data.recovery.kind).toBe('retained');
  expect(observed.statusCode).toBe(200);
  expect(refused.statusCode).toBe(409);
  expect(secondCaptureCount).toBe(0);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect(company.employeeRecoveryAvailable(other.employee.id, undefined)).toBe(true);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([
    selected,
    selected,
  ]);
  expect(other.session.pid).toBeNull();
});

it.each([
  { kind: 'employeeId', aliasOwner: undefined },
  { kind: 'employeeId', aliasOwner: 'another-owner' },
  { kind: 'sessionId', aliasOwner: undefined },
  { kind: 'sessionId', aliasOwner: 'another-owner' },
] as const)(
  'refuses global $kind ambiguity owned by $aliasOwner before publication or Q',
  async ({ kind, aliasOwner }) => {
    await store.update((state) => {
      const original = state.employees[0]!;
      state.employees.push({
        ...structuredClone(original),
        owner: aliasOwner,
        id: kind === 'employeeId' ? original.id : randomUUID(),
        sessionId: kind === 'sessionId' ? original.sessionId : randomUUID(),
      });
    });
    const before = store.snapshot(),
      selected = approval();
    const refused = await send(selected);
    expect(refused.statusCode).not.toBe(200);
    expect(connected).toBe(0);
    expect(store.snapshot()).toEqual(before);
    expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(session.pid).toBeNull();
  }
);
it.each(['employeeId', 'sessionId'] as const)(
  'rechecks global target $kind uniqueness after the original move-guard await',
  async (kind) => {
    const guard = plans.employeeRecoveryGuard.bind(plans);
    vi.spyOn(PlanMoves.prototype, 'employeeRecoveryGuard').mockImplementation(async (...args) => {
      const originalLease = await guard(...args);
      await store.update((state) => {
        const original = state.employees[0]!;
        state.employees.push({
          ...structuredClone(original),
          owner: 'another-owner',
          id: kind === 'employeeId' ? original.id : randomUUID(),
          sessionId: kind === 'sessionId' ? original.sessionId : randomUUID(),
        });
      });
      return originalLease;
    });
    expect((await send(approval())).statusCode).not.toBe(200);
    expect(connected).toBe(0);
    expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(session.pid).toBeNull();
  }
);

it('reserves a viewer-child id before capture so another genuine target cannot take its slot', async () => {
  const other = await otherRecoveryEmployee(),
    parent = approval();
  expect((await send(parent)).statusCode).toBe(200);
  const child = EmployeeRecoveryApproval.parse({
    ...parent,
    operationId: randomUUID(),
    parentOperationId: parent.operationId,
    action: 'close-viewer',
  });
  let entered!: () => void,
    release!: () => void,
    otherCaptures = 0;
  const atCapture = new Promise<void>((done) => {
    entered = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  releaseFixtureWrites.push(release);
  const capture = EmployeeRecoveryAttempt.capture;
  vi.spyOn(EmployeeRecoveryAttempt, 'capture').mockImplementation(async (...args) => {
    const original = await capture.apply(EmployeeRecoveryAttempt, args);
    if (args[3].employeeId === other.employee.id) otherCaptures++;
    if (args[3].approval.operationId === child.operationId && args[3].employeeId === employeeId) {
      entered();
      await gate;
    }
    return original;
  });
  const first = Promise.resolve(send(child));
  await atCapture;
  const refused = await sendFor(other.employee.id, {
    ...child,
    sessionId: other.session.id,
    parentOperationId: null,
    action: 'stop-provider',
  });
  expect(refused.statusCode).toBe(409);
  expect(otherCaptures).toBe(0);
  release();
  expect((await first).statusCode).toBe(200);
  expect((await inspect(child)).statusCode).toBe(200);
  const rows = store.snapshot().employeeRecoveryOperations!;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.component!.approval).toEqual(child);
  expect(company.employeeRecoveryAvailable(other.employee.id, undefined)).toBe(true);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([
    parent,
    child,
    child,
  ]);
});
it.each([false, true])(
  'closes safely while an actual %s child capture is staged without publishing or issuing Q',
  async (child) => {
    const parent = approval();
    if (child) expect((await send(parent)).statusCode).toBe(200);
    const selected = child
      ? EmployeeRecoveryApproval.parse({
          ...parent,
          operationId: randomUUID(),
          parentOperationId: parent.operationId,
          action: 'close-viewer',
        })
      : parent;
    let entered!: () => void, release!: () => void;
    const atCapture = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    releaseFixtureWrites.push(release);
    const capture = EmployeeRecoveryAttempt.capture;
    vi.spyOn(EmployeeRecoveryAttempt, 'capture').mockImplementation(async (...args) => {
      const original = await capture.apply(EmployeeRecoveryAttempt, args);
      entered();
      await gate;
      return original;
    });
    const pending = Promise.resolve(send(selected));
    await atCapture;
    expect(() => service.close()).not.toThrow();
    release();
    expect((await pending).statusCode).not.toBe(200);
    const rows = store.snapshot().employeeRecoveryOperations;
    if (child) {
      expect(rows).toHaveLength(1);
      expect(rows![0]!.component).toBeUndefined();
    } else expect(rows).toBeUndefined();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(!child);
    expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(child ? 1 : 0);
    expect(session.pid).toBeNull();
    expect(() => service.close()).not.toThrow();
  }
);

async function fixtureOfficeIntent(onVacation: boolean) {
  await store.update((state) => {
    const employee = state.employees.find((row) => row.id === employeeId)!;
    employee.onVacation = onVacation;
    employee.desiredRunning = !onVacation;
  });
  // Complete the real canonical parser/writer normalization before taking
  // the byte baseline; the unrelated queued writer may legitimately do this.
  await store.update(() => undefined);
}
it('refuses explicit Enter before changing an employee retained by an actual recovery parent', async () => {
  await fixtureOfficeIntent(true);
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  const before = requireFile();
  await expect(company.setVacation(employeeId, undefined, false)).rejects.toMatchObject({ status: 409 });
  expect(requireFile()).toBe(before);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([selected]);
  expect(session.pid).toBeNull();
});
it.each(['queued', 'before-commit'] as const)(
  'refuses Enter when recovery claims the original after Enter passed preflight at %s',
  async (boundary) => {
    await fixtureOfficeIntent(true);
    const before = requireFile();
    let reached!: () => void, release!: () => void, reservationReached!: () => void, releaseReservation!: () => void;
    const atBoundary = new Promise<void>((done) => {
      reached = done;
    });
    const boundaryGate = new Promise<void>((done) => {
      release = done;
    });
    const atReservation = new Promise<void>((done) => {
      reservationReached = done;
    });
    const reservationGate = new Promise<void>((done) => {
      releaseReservation = done;
    });
    releaseFixtureWrites.push(release, releaseReservation);
    let writer: Promise<unknown> | undefined;
    if (boundary === 'queued') {
      writer = store.update(
        () => undefined,
        () => {},
        async () => {
          reached();
          await boundaryGate;
        }
      );
      await atBoundary;
    } else {
      const update = store.update.bind(store);
      vi.spyOn(store, 'update').mockImplementationOnce((mutate, validate, beforeSave) =>
        update(mutate, validate, async (result) => {
          await beforeSave?.(result);
          reached();
          await boundaryGate;
        })
      );
    }
    const publish = CompanyStore.prototype.publishEmployeeRecovery;
    vi.spyOn(CompanyStore.prototype, 'publishEmployeeRecovery').mockImplementation(async function (
      this: CompanyStore,
      ...args
    ) {
      reservationReached();
      await reservationGate;
      return publish.apply(this, args);
    });
    const entering = company.setVacation(employeeId, undefined, false).then(
      (value) => ({ kind: 'committed' as const, value }),
      (error) => ({ kind: 'refused' as const, error })
    );
    if (boundary === 'before-commit')
      await Promise.race([
        atBoundary,
        entering.then(() => {
          throw Error('The original Enter writer did not reach its pre-publication boundary');
        }),
      ]);
    const selected = approval(),
      recovering = Promise.resolve(send(selected));
    await Promise.race([
      atReservation,
      recovering.then(() => {
        throw Error('The original recovery did not reach its reservation boundary');
      }),
    ]);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    release();
    await writer;
    const outcome = await entering,
      beforeRecoveryPublication = requireFile(),
      openedBeforePublication = connected,
      rowsBeforePublication = store.snapshot().employeeRecoveryOperations;
    releaseReservation();
    const recovered = await recovering;
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.error).toMatchObject({ status: 409 });
    expect(beforeRecoveryPublication).toBe(before);
    expect(openedBeforePublication).toBe(0);
    expect(rowsBeforePublication).toBeUndefined();
    expect(recovered.statusCode).toBe(200);
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([selected]);
    expect(store.snapshot().employees.find((row) => row.id === employeeId)).toMatchObject({
      onVacation: true,
      desiredRunning: false,
    });
    expect(session.pid).toBeNull();
  }
);
it('keeps healthy explicit Enter on the actual unique canonical binding available', async () => {
  await fixtureOfficeIntent(true);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
  const entered = await company.setVacation(employeeId, undefined, false);
  expect(entered).toMatchObject({ id: employeeId, sessionId: session.id, onVacation: false, desiredRunning: true });
  expect(JSON.parse(requireFile()).employees[0]).toMatchObject({
    id: employeeId,
    sessionId: session.id,
    onVacation: false,
    desiredRunning: true,
  });
  expect(connected).toBe(0);
  expect(session.pid).toBeNull();
});
it('keeps OFF intent durable while retaining genuine native-stop-unavailable refusal and the original recovery', async () => {
  const unavailable = Error('Synthetic native lifecycle is unavailable');
  const stop = vi.fn(async (id: string) => {
    expect(id).toBe(session.id);
    throw unavailable;
  });
  service.close();
  company = freshCompany(stop);
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  const recovery = store.snapshot().employeeRecoveryOperations;
  await expect(company.setVacation(employeeId, undefined, true)).rejects.toBe(unavailable);
  expect(stop).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(JSON.parse(requireFile()).employees[0]).toMatchObject({ onVacation: true, desiredRunning: false });
  expect(store.snapshot().employeeRecoveryOperations).toEqual(recovery);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([selected]);
  expect(session.pid).toBeNull();
});

it('denies an old captured input lease while the actual recovery claim retains its Session', async () => {
  const oldInput = session.captureInputAdmission();
  expect(oldInput()).toBe(true);
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(oldInput()).toBe(false);
  expect(session.captureInputAdmission()()).toBe(false);
  expect(session.canAcceptChatInput()).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
  expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
});

it('restarts into a loaded observation-only recovery and cannot turn that observer into another effect', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  service.close();
  store = new CompanyStore(store.file);
  await store.init();
  session = new Session({ id: session.id, workingDir: root, mode: 'claude', useMux: false, publicationStore });
  company = freshCompany();
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  const before = requireFile();
  const selection = await app.inject({
    method: 'GET',
    url: '/api/company/employees/' + employeeId + '/recovery-selection',
    headers: { host: 'localhost', cookie: 'reverie_owner=' + token },
  });
  expect(selection.json().data.availability.observeOriginal.state).toBe('available');
  expect(selection.json().data.availability.stopProvider.state).toBe('unavailable');
  expect((await send(selected)).statusCode).toBe(409);
  const observed = await inspect(selected);
  expect(observed.statusCode).toBe(200);
  expect(observed.json().data.application.state).toBe('recovery-required');
  expect(requireFile()).toBe(before);
  expect((await send(selected)).statusCode).toBe(409);
  expect(session.captureInputAdmission()()).toBe(false);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('observes a restarted canonical native launch denial without recovering its effect admission', async () => {
  const pending = publicationStore.stageProviderLaunch(session, {
    transport: 'native-ordinary',
    brokerSocket: join(root, 'native.sock'),
    current: () => true,
    snapshot: () => session.toPersistedState(),
  });
  await pending.prepare(session, {
    kind: 'pty',
    sessionId: session.id,
    owner: session.owner ?? null,
    mode: session.mode,
    command: 'fixed-never-dispatched',
    cwd: root,
    environment: {},
  });
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  service.close();
  store = new CompanyStore(store.file);
  await store.init();
  publicationStore = new StateStore(join(root, 'state.json'));
  session = new Session({ id: session.id, workingDir: root, mode: 'claude', useMux: false, publicationStore });
  company = freshCompany();
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  const before = requireFile(),
    mainBefore = readFileSync(join(root, 'state.json'), 'utf8');
  expect(publicationStore.providerLaunchHeldFor(session)).toBe(true);
  const selection = await app.inject({
    method: 'GET',
    url: '/api/company/employees/' + employeeId + '/recovery-selection',
    headers: { host: 'localhost', cookie: 'reverie_owner=' + token },
  });
  expect(selection.statusCode).toBe(200);
  expect(selection.json().data.availability.observeOriginal.state).toBe('available');
  expect((await inspect(selected)).statusCode).toBe(200);
  expect((await inspect(selected)).statusCode).toBe(200);
  expect((await send(selected)).statusCode).toBe(409);
  expect(requireFile()).toBe(before);
  expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(mainBefore);
  expect(publicationStore.providerLaunchHeldFor(session)).toBe(true);
  expect(session.captureInputAdmission()()).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
    'employee-recovery-observe',
  ]);
});

it.each(['before', 'after'] as const)(
  'keeps fresh original observation available after the actual observation writer loses its %s-rename acknowledgement',
  async (boundary) => {
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    let injected = false,
      originalBytes: string | undefined,
      attemptedBytes: string | undefined;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === store.file && !injected) {
        const candidate = await fs.readFile(from, 'utf8');
        if (JSON.parse(candidate).employeeRecoveryOperations?.[0]?.phase === 'observed') {
          originalBytes = requireFile();
          attemptedBytes = candidate;
          injected = true;
          if (boundary === 'before') throw Error('PRIVATE_OBSERVATION_ACK_LOST');
          await actualRename(from, to);
          throw Error('PRIVATE_OBSERVATION_ACK_LOST');
        }
      }
      await actualRename(from, to);
    });
    const selected = approval();
    const first = await send(selected);
    expect(injected).toBe(true);
    expect(first.statusCode).toBe(503);
    expect(first.body).not.toContain('PRIVATE_OBSERVATION_ACK_LOST');
    expect(store.publicationUnconfirmed).toBe(true);
    expect(JSON.parse(originalBytes!).employeeRecoveryOperations[0].phase).toBe('issued');
    expect(JSON.parse(attemptedBytes!).employeeRecoveryOperations[0].phase).toBe('observed');
    const saved = requireFile();
    expect(saved).toBe(boundary === 'before' ? originalBytes : attemptedBytes);
    rename.mockRestore();
    expect((await send(selected)).statusCode).not.toBe(200);
    expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
    const selection = await selectRecovery();
    expect(selection.statusCode).toBe(200);
    expect(selection.json().data.availability.observeOriginal.state).toBe('available');
    const observed = await inspect(selected);
    expect(observed.statusCode).toBe(200);
    expect(observed.json().data.application.state).toBe('recovery-required');
    expect(requireFile()).toBe(saved);
    expect(store.publicationUnconfirmed).toBe(true);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    expect(session.captureInputAdmission()()).toBe(false);
    expect(physical.spawn).not.toHaveBeenCalled();
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
    ]);
    const newer = JSON.parse(saved);
    newer.employees[0].name = 'Unrelated newer canonical data';
    await fs.writeFile(store.file, JSON.stringify(newer));
    expect((await inspect(selected)).statusCode).toBe(503);
    expect(JSON.parse(requireFile()).employees[0].name).toBe('Unrelated newer canonical data');
    expect(store.publicationUnconfirmed).toBe(true);
    expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(2);
  }
);

it('does not offer another retained-viewer effect while its actual observation writer is held', async () => {
  const parent = approval();
  expect((await send(parent)).statusCode).toBe(200);
  const child = EmployeeRecoveryApproval.parse({
    ...parent,
    operationId: randomUUID(),
    parentOperationId: parent.operationId,
    action: 'close-viewer',
  });
  const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
  let injected = false;
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await actualRename(from, to);
    if (
      String(to) === store.file &&
      !injected &&
      JSON.parse(requireFile()).employeeRecoveryOperations?.[0]?.component?.phase === 'observed'
    ) {
      injected = true;
      throw Error('PRIVATE_CHILD_OBSERVATION_ACK_LOST');
    }
  });
  const attempted = await send(child);
  expect(attempted.statusCode).toBe(503);
  expect(injected).toBe(true);
  expect(store.publicationUnconfirmed).toBe(true);
  rename.mockRestore();
  const before = requireFile();
  const selected = await selectRecovery();
  expect(selected.statusCode).toBe(200);
  expect(selected.json().data.recovery.componentApproval).toEqual(child);
  expect(requireFile()).toBe(before);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([
    parent,
    child,
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
  expect(selected.json().data.availability.closeRetainedViewer.state).toBe('unavailable');
  expect(selected.json().data.availability.observeOriginal.state).toBe('available');
  expect((await send(child)).statusCode).not.toBe(200);
  expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(2);
  expect(store.publicationUnconfirmed).toBe(true);
  expect(session.captureInputAdmission()()).toBe(false);
});
it('settles only the same original completed parent into stopped application state without waking it', async () => {
  await store.update((state) => {
    state.employees[0]!.desiredRunning = true;
  });
  const oldInput = session.captureInputAdmission(),
    selected = approval();
  expect(oldInput()).toBe(true);
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  const completed = await inspect(selected);
  expect(completed.statusCode).toBe(200);
  expect(physical.spawn).not.toHaveBeenCalled();
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
  expect(completed.json().data.application.state).toBe('completed-stopped');
  expect(store.snapshot().employees[0]!.desiredRunning).toBe(false);
  expect(store.snapshot().employeeRecoveryOperations![0]!.application?.state).toBe('completed-stopped');
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
  expect(oldInput()).toBe(false);
  await company.setVacation(employeeId, undefined, false);
  expect(store.snapshot().employees[0]!.desiredRunning).toBe(true);
  expect(oldInput()).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it.each([false, true])('retires only the actual issued native intent (mismatched proof: %s)', async (mismatch) => {
  await store.update((state) => {
    state.employees[0]!.desiredRunning = true;
  });
  session.setMode('shell');
  const staged = vi.spyOn(publicationStore, 'stageProviderLaunch');
  await expect(session.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(physical.spawn).toHaveBeenCalledOnce();
  const publication = staged.mock.results.find((row) => row.type === 'return')!.value;
  const original = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[
    session.id
  ];
  expect(original.transport).toBe('native-ordinary');
  const selected = EmployeeRecoveryApproval.parse({
    ...approval(),
    originalAttemptId: mismatch ? randomUUID() : original.attemptId,
  });
  expect((await send(selected)).statusCode).toBe(200);
  physical.exit?.({ exitCode: 0 });
  const companyBefore = requireFile(),
    mainBefore = readFileSync(join(root, 'state.json'), 'utf8');
  stoppedFrame = 'normal-close';
  const completed = await inspect(selected);
  if (mismatch) {
    expect(completed.statusCode).toBe(503);
    expect(requireFile()).toBe(companyBefore);
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(mainBefore);
    expect(store.snapshot().employees[0]!.desiredRunning).toBe(true);
    expect(session.providerDispatchHeld).toBe(true);
  } else {
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().data.application).toEqual({
      state: 'completed-stopped',
      intentRetirement: 'issued-native-retired',
    });
    expect(
      JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id]
    ).toBeUndefined();
    expect(publicationStore.getSessions()[session.id]!.providerDispatchHeld).not.toBe(true);
    expect(session.providerDispatchHeld).toBe(false);
    expect(() => publication.claim()).toThrow();
    publication.settle(true);
    expect(() => publication.claim()).toThrow();
  }
  expect(physical.spawn).toHaveBeenCalledOnce();
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.approval)).toEqual([
    selected,
    selected,
  ]);
});
it.each([
  ['stopped-intent', 'before'],
  ['stopped-intent', 'after'],
  ['completed-stopped', 'before'],
  ['completed-stopped', 'after'],
] as const)(
  'repairs only its own %s publication after an actual %s-rename fault and a fresh parent proof',
  async (stage, boundary) => {
    await store.update((state) => {
      state.employees[0]!.desiredRunning = true;
    });
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    let injected = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === store.file && !injected) {
        const candidate = JSON.parse(await fs.readFile(from, 'utf8'));
        if (candidate.employeeRecoveryOperations?.[0]?.application?.state === stage) {
          injected = true;
          if (boundary === 'before') throw Error('PRIVATE_STOPPED_RENAME_ACK_LOST');
          await actualRename(from, to);
          throw Error('PRIVATE_STOPPED_RENAME_ACK_LOST');
        }
      }
      await actualRename(from, to);
    });
    const uncertain = await inspect(selected);
    expect(injected).toBe(true);
    expect(uncertain.statusCode).toBe(503);
    expect(uncertain.body).not.toContain('PRIVATE_STOPPED_RENAME_ACK_LOST');
    expect(store.publicationUnconfirmed).toBe(true);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    const beforeEnter = requireFile();
    await expect(company.setVacation(employeeId, undefined, false)).rejects.toMatchObject({ status: 409 });
    expect(requireFile()).toBe(beforeEnter);
    rename.mockRestore();
    const selection = await selectRecovery();
    expect(selection.statusCode).toBe(200);
    expect(selection.json().data.availability.observeOriginal.state).toBe('available');
    expect((await send(selected)).statusCode).toBe(409);
    const complete = await inspect(selected);
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json().data.application.state).toBe('completed-stopped');
    expect(store.publicationUnconfirmed).toBe(false);
    expect(store.snapshot().employees[0]!.desiredRunning).toBe(false);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(physical.spawn).not.toHaveBeenCalled();
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
      'employee-recovery-observe',
    ]);
  }
);
it.each(['before', 'after'] as const)(
  'reconciles its original main retirement after an actual %s-rename fault without replaying stop',
  async (boundary) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const actualRename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
    let injected = false;
    vi.mocked(syncFs.renameSync).mockImplementation((from, to) => {
      if (String(to) === join(root, 'state.json') && !injected) {
        injected = true;
        if (boundary === 'before') throw Error('PRIVATE_MAIN_STOPPED_ACK_LOST');
        actualRename(from, to);
        throw Error('PRIVATE_MAIN_STOPPED_ACK_LOST');
      }
      actualRename(from, to);
    });
    const uncertain = await inspect(selected);
    expect(injected).toBe(true);
    expect(uncertain.statusCode).toBe(503);
    expect(publicationStore.statePublicationHeld).toBe(true);
    expect(store.snapshot().employees[0]!.desiredRunning).toBe(false);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    vi.mocked(syncFs.renameSync).mockImplementation(actualRename);
    const complete = await inspect(selected);
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json().data.application.state).toBe('completed-stopped');
    expect(publicationStore.statePublicationHeld).toBe(false);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(physical.spawn).not.toHaveBeenCalled();
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
      'employee-recovery-observe',
    ]);
  }
);
it.each([
  ['stopped-intent', 'temp-sync'],
  ['stopped-intent', 'directory-sync'],
  ['completed-stopped', 'directory-sync'],
  ['stopped-intent', 'directory-close'],
  ['completed-stopped', 'directory-close'],
] as const)(
  'joins actual %s %s failure with fresh stop evidence and never retries the consumed handle',
  async (stage, boundary) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const open = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    let selectedWrite = false,
      injected = false,
      closeCalls = 0;
    const opened = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args),
        name = String(args[0]);
      if (name.startsWith(store.file + '.') && name.endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...values) => {
          await write(...values);
          if (
            typeof values[0] === 'string' &&
            JSON.parse(values[0]).employeeRecoveryOperations?.[0]?.application?.state === stage
          )
            selectedWrite = true;
        });
        if (boundary === 'temp-sync') {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementation(async () => {
            await sync();
            if (selectedWrite && !injected) {
              injected = true;
              throw Error('PRIVATE_STOPPED_TEMP_SYNC_ACK_LOST');
            }
          });
        }
      }
      if (name === root && selectedWrite && !injected) {
        if (boundary === 'directory-sync') {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementation(async () => {
            await sync();
            injected = true;
            throw Error('PRIVATE_STOPPED_DIR_SYNC_ACK_LOST');
          });
        }
        if (boundary === 'directory-close') {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            closeCalls++;
            await close();
            injected = true;
            throw Error('PRIVATE_STOPPED_DIR_CLOSE_ACK_LOST');
          });
        }
      }
      return handle;
    });
    const held = await inspect(selected);
    expect(injected).toBe(true);
    expect(held.statusCode).toBe(503);
    expect(held.body).not.toContain('PRIVATE_STOPPED_');
    expect(store.publicationUnconfirmed).toBe(boundary !== 'temp-sync');
    if (boundary === 'directory-close') expect(closeCalls).toBe(1);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    opened.mockRestore();
    const repaired = await inspect(selected);
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect(repaired.json().data.application.state).toBe('completed-stopped');
    expect(store.publicationUnconfirmed).toBe(false);
    if (boundary === 'directory-close') expect(closeCalls).toBe(1);
    expect(physical.spawn).not.toHaveBeenCalled();
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
      'employee-recovery-observe',
    ]);
  }
);
it.each(['temp-sync', 'directory-sync', 'directory-close'] as const)(
  'reconciles original main %s acknowledgement loss without retrying a closed FD',
  async (boundary) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let renamed = false,
      injected = false,
      afterFaultCloses = 0,
      window = true;
    vi.mocked(syncFs.renameSync).mockImplementation((from, to) => {
      actual.renameSync(from, to);
      if (String(to) === join(root, 'state.json')) renamed = true;
    });
    vi.mocked(syncFs.fsyncSync).mockImplementation((fd) => {
      const target = actual.readlinkSync('/proc/self/fd/' + fd);
      actual.fsyncSync(fd);
      const chosen =
        boundary === 'temp-sync'
          ? !renamed && target.startsWith(join(root, 'state.json') + '.')
          : boundary === 'directory-sync' && renamed && target === root;
      if (chosen && !injected) {
        injected = true;
        throw Error('PRIVATE_STOPPED_MAIN_SYNC_ACK_LOST');
      }
    });
    const closed = vi.spyOn(syncFs, 'closeSync').mockImplementation((fd) => {
      if (injected && window) afterFaultCloses++;
      const directory = actual.fstatSync(fd).isDirectory();
      actual.closeSync(fd);
      if (boundary === 'directory-close' && renamed && directory && !injected) {
        injected = true;
        throw Error('PRIVATE_STOPPED_MAIN_CLOSE_ACK_LOST');
      }
    });
    const held = await inspect(selected);
    window = false;
    expect(injected).toBe(true);
    expect(held.statusCode).toBe(503);
    expect(held.body).not.toContain('PRIVATE_STOPPED_');
    expect(publicationStore.statePublicationHeld).toBe(boundary !== 'temp-sync');
    if (boundary === 'directory-close') expect(afterFaultCloses).toBe(0);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    closed.mockRestore();
    vi.mocked(syncFs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(syncFs.fsyncSync).mockImplementation(actual.fsyncSync);
    const repaired = await inspect(selected);
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect(repaired.json().data.application.state).toBe('completed-stopped');
    expect(publicationStore.statePublicationHeld).toBe(false);
    expect(physical.spawn).not.toHaveBeenCalled();
  }
);
async function reconstructRecoveryApplication(): Promise<void> {
  const id = session.id;
  service.close();
  store = new CompanyStore(store.file);
  await store.init();
  publicationStore = new StateStore(join(root, 'state.json'));
  const saved = publicationStore.getSession(id)!;
  session = new Session({
    id,
    mode: saved.mode,
    workingDir: saved.workingDir,
    owner: saved.owner,
    useMux: false,
    publicationStore,
    providerDispatchHeld: saved.providerDispatchHeld,
    terminalInputHeld: saved.terminalInputHeld,
  });
  company = freshCompany();
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(root, 'auth.json')),
    auditFile: join(root, 'audit'),
    setupEnabled: true,
  });
  const login = await auth.login('fixture-owner', 'Synthetic-recovery-fixture-42!', '127.0.0.1');
  expect(login.session).toBeTypeOf('string');
  token = login.session!;
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
}
it('reconstructs observation owners from real terminal files only after fresh authentication and native evidence', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  expect((await inspect(selected)).json().data.application.state).toBe('completed-stopped');
  await reconstructRecoveryApplication();
  const before = messages.length;
  expect((await send(selected)).statusCode).toBe(409);
  expect(messages.length).toBe(before);
  const read = await selectRecovery();
  expect(read.statusCode).toBe(200);
  expect(read.json().data.recovery.application.state).toBe('recovery-required');
  const completed = await inspect(selected);
  expect(completed.statusCode, completed.body).toBe(200);
  expect(completed.json().data.application.state).toBe('completed-stopped');
  expect(store.snapshot().employees[0]!.desiredRunning).toBe(false);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
    'employee-recovery-observe',
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('does not let an old loaded terminal proof reverse a new explicit Enter intent before its fresh launch', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  expect((await inspect(selected)).json().data.application.state).toBe('completed-stopped');
  await reconstructRecoveryApplication();
  await company.setVacation(employeeId, undefined, false);
  const before = requireFile(),
    count = messages.filter((row) => row.kind === 'resource-operation').length;
  const old = await inspect(selected);
  expect(old.statusCode).not.toBe(200);
  expect(requireFile()).toBe(before);
  expect(store.snapshot().employees[0]!.desiredRunning).toBe(true);
  expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(count);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('does not revive an old terminal original after explicit OFF Enter OFF intent ABA', async () => {
  const unavailable = Error('Synthetic native stop unavailable');
  service.close();
  company = freshCompany(async () => {
    throw unavailable;
  });
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  expect((await inspect(selected)).json().data.application.state).toBe('completed-stopped');
  await expect(company.setVacation(employeeId, undefined, true)).rejects.toBe(unavailable);
  await company.setVacation(employeeId, undefined, false);
  const superseded = store.snapshot().employeeRecoveryOperations![0]!.application!.supersededByIntent;
  expect(superseded).toBeTypeOf('string');
  await expect(company.setVacation(employeeId, undefined, true)).rejects.toBe(unavailable);
  expect(store.snapshot().employeeRecoveryOperations![0]!.application!.supersededByIntent).toBe(superseded);
  await reconstructRecoveryApplication();
  const before = requireFile(),
    operations = messages.filter((row) => row.kind === 'resource-operation').length;
  expect((await inspect(selected)).statusCode).not.toBe(200);
  expect(requireFile()).toBe(before);
  expect(store.snapshot().employees[0]!).toMatchObject({ desiredRunning: false, onVacation: true });
  expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(operations);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('permanently refuses the original runtime callback after stop and a new explicit Enter', async () => {
  const oldCurrent = () => true,
    recipe = expertRuntimeRecipe(session);
  await company.saveRuntimeRecipe(session.id, recipe, oldCurrent);
  await company.setDesiredRunning(session.id, true, oldCurrent);
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  expect((await inspect(selected)).json().data.application.state).toBe('completed-stopped');
  await company.setVacation(employeeId, undefined, false);
  await company.setDesiredRunning(session.id, false);
  const before = requireFile();
  await expect(
    company.saveRuntimeRecipe(session.id, { ...recipe, model: 'stale-original' }, oldCurrent)
  ).rejects.toMatchObject({ status: 409 });
  await expect(company.setDesiredRunning(session.id, true, oldCurrent)).rejects.toMatchObject({ status: 409 });
  expect(requireFile()).toBe(before);
  expect(store.snapshot().employees[0]!).toMatchObject({
    desiredRunning: false,
    runtimeRecipe: JSON.parse(JSON.stringify(recipe)),
  });
  const freshCurrent = () => true;
  await company.saveRuntimeRecipe(session.id, { ...recipe, model: 'new-explicit-intent' }, freshCurrent);
  await company.setDesiredRunning(session.id, true, freshCurrent);
  const newer = requireFile();
  await expect(company.setDesiredRunning(session.id, true, oldCurrent)).rejects.toMatchObject({ status: 409 });
  expect(requireFile()).toBe(newer);
  expect(store.snapshot().employees[0]!.runtimeRecipe!.model).toBe('new-explicit-intent');
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('keeps a legacy flat stopped observation non-authorizing for application completion', async () => {
  mode = 'legacy-stopped';
  const selected = approval();
  expect((await send(selected)).json().data.application.state).toBe('recovery-required');
  expect((await inspect(selected)).json().data.application.state).toBe('recovery-required');
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(store.snapshot().employeeRecoveryOperations![0]!.phase).toBe('observed');
  expect(session.captureInputAdmission()()).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it.each([
  'normal-close',
  'wrong-nonce',
  'wrong-scope',
  'wrong-request',
  'child',
  'truncated',
  'revoked-after-close',
  'binding-after-close',
] as const)(
  'joins the actual observe response owner with %s framing without treating the DTO as completion',
  async (framing) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = framing;
    let received: OriginalStoppedRecovery | undefined;
    let returnedAttempt: EmployeeRecoveryAttempt | undefined;
    const originalClaim = OriginalStoppedRecovery.prototype.claimFor;
    const claims = vi.spyOn(OriginalStoppedRecovery.prototype, 'claimFor').mockImplementation(function (
      this: OriginalStoppedRecovery,
      attempt
    ) {
      originalClaim.call(this, attempt);
      expect(() => originalClaim.call(this, attempt)).toThrow();
    });
    const observe = ResourceNativeClient.prototype.observeEmployeeRecoveryOriginal;
    vi.spyOn(ResourceNativeClient.prototype, 'observeEmployeeRecoveryOriginal').mockImplementation(async function (
      this: ResourceNativeClient,
      attempt
    ) {
      const closed = vi.spyOn(this, 'close');
      const value = await observe.call(this, attempt);
      returnedAttempt = attempt;
      received = value.stopped;
      if (received) {
        await terminalReplyClosed;
        await new Promise<void>((done) => setImmediate(done));
        expect(closed).toHaveBeenCalled();
        received.assertFor(attempt);
        expect(() => JSON.stringify(received)).toThrow('server-private');
        const forged = Object.create(OriginalStoppedRecovery.prototype);
        expect(() => forged.claimFor(attempt)).toThrow();
        if (framing === 'revoked-after-close') auth.logout(token);
        if (framing === 'binding-after-close') session.owner = 'successor-owner';
      }
      return value;
    });
    const answer = await inspect(selected);
    expect(answer.statusCode).toBe(
      framing === 'normal-close'
        ? 200
        : framing === 'revoked-after-close'
          ? 403
          : framing === 'binding-after-close'
            ? 409
            : 503
    );
    if (framing === 'normal-close') {
      expect(received).toBeInstanceOf(OriginalStoppedRecovery);
      // The actual consumer claims once. This physical port is synthetic;
      // application settlement acceptance is not Rust producer qualification.
      expect(claims.mock.contexts.filter((owner) => owner === received)).toHaveLength(1);
      expect(answer.json().data.application.state).toBe('completed-stopped');
    } else if (framing === 'revoked-after-close' || framing === 'binding-after-close') {
      expect(received).toBeInstanceOf(OriginalStoppedRecovery);
      // Challenge the private claim AFTER the actual consumer sees the loss;
      // a test-only pre-claim must not poison its Attempt phase first.
      expect(() => received!.claimFor(returnedAttempt!)).toThrow();
    } else expect(received).toBeUndefined();
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(framing === 'normal-close');
    expect(physical.spawn).not.toHaveBeenCalled();
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
    ]);
  }
);
it.each([
  ['temp', 'owner'],
  ['directory', 'owner'],
  ['temp', 'target'],
  ['directory', 'target'],
] as const)(
  'refuses stopped settlement after actual %s sync observes changed %s custody',
  async (boundary, changed) => {
    await store.update((state) => {
      state.employees[0]!.desiredRunning = true;
    });
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    publicationStore.setSession(session.id, session.toPersistedState());
    await publicationStore.saveNowAsync();
    const originalBytes = requireFile(),
      mainBefore = readFileSync(join(root, 'state.json'), 'utf8');
    stoppedFrame = 'normal-close';
    let entered!: () => void,
      release!: () => void,
      chosen = false,
      written = false;
    const reached = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    releaseFixtureWrites.push(release);
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args),
        name = String(args[0]);
      const temp = name.startsWith(store.file + '.') && name.endsWith('.tmp');
      if (temp) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...values) => {
          await write(...values);
          if (
            typeof values[0] === 'string' &&
            JSON.parse(values[0]).employeeRecoveryOperations?.[0]?.application?.state === 'stopped-intent'
          )
            written = true;
        });
      }
      if ((boundary === 'temp' && temp) || (boundary === 'directory' && name === root)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          if (written && !chosen) {
            chosen = true;
            entered();
            await blocked;
          }
        });
      }
      return handle;
    });
    const response = Promise.resolve(inspect(selected));
    await Promise.race([
      reached,
      response.then(() => {
        throw Error('The actual settlement finished before the FileHandle barrier');
      }),
    ]);
    if (changed === 'owner') auth.logout(token);
    else
      registry.set(
        session.id,
        new Session({ id: session.id, mode: session.mode, workingDir: root, useMux: false, publicationStore })
      );
    release();
    const refused = await response;
    expect(refused.statusCode).not.toBe(200);
    expect(chosen).toBe(true);
    expect(store.snapshot().employees[0]!.desiredRunning).toBe(boundary === 'temp');
    expect(requireFile() === originalBytes).toBe(boundary === 'temp');
    expect(store.publicationUnconfirmed).toBe(boundary === 'directory');
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(mainBefore);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
    ]);
    expect(physical.spawn).not.toHaveBeenCalled();
    open.mockRestore();
    if (changed === 'owner') {
      token = (await auth.login('fixture-owner', 'Synthetic-recovery-fixture-42!', '127.0.0.1')).session!;
      const resumed = await inspect(selected);
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json().data.application.state).toBe('completed-stopped');
    }
  }
);
it.each(['foreign-disk', 'current-observation'] as const)(
  'never replays old main bytes over %s while reconciling its own actual lost ACK',
  async (change) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
    let injected = false;
    vi.mocked(syncFs.renameSync).mockImplementation((from, to) => {
      actual(from, to);
      if (String(to) === join(root, 'state.json') && !injected) {
        injected = true;
        throw Error('Synthetic original main ACK loss');
      }
    });
    expect((await inspect(selected)).statusCode).toBe(503);
    expect(injected).toBe(true);
    expect(publicationStore.statePublicationHeld).toBe(true);
    vi.mocked(syncFs.renameSync).mockImplementation(actual);
    let current: Session | undefined, foreign: string | undefined;
    if (change === 'foreign-disk') {
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
      state.config = { ...state.config, fixtureForeignRevision: 'unrelated-canonical-data' };
      foreign = JSON.stringify(state);
      await fs.writeFile(join(root, 'state.json'), foreign);
    } else {
      current = new Session({ mode: 'shell', workingDir: root, useMux: false, publicationStore });
      publicationStore.setSession(current.id, current.toPersistedState());
    }
    const resumed = await inspect(selected);
    if (change === 'foreign-disk') {
      expect(resumed.statusCode).toBe(503);
      expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(foreign);
      expect(publicationStore.statePublicationHeld).toBe(true);
      expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
    } else {
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json().data.application.state).toBe('completed-stopped');
      expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[current!.id]).toMatchObject({
        id: current!.id,
        mode: 'shell',
      });
      expect(publicationStore.statePublicationHeld).toBe(false);
    }
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
      'employee-recovery-observe',
    ]);
    expect(physical.spawn).not.toHaveBeenCalled();
  }
);
it.each([false, true])(
  'reconstructs completion in a different Node process after terminal ACK loss: %s',
  async (lostAck) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    let injected = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (lostAck && String(to) === store.file && !injected) {
        const candidate = JSON.parse(await fs.readFile(from, 'utf8'));
        if (candidate.employeeRecoveryOperations?.[0]?.application?.state === 'completed-stopped') {
          await actualRename(from, to);
          injected = true;
          throw Error('Synthetic terminal ACK lost before Node restart');
        }
      }
      await actualRename(from, to);
    });
    const settled = await inspect(selected);
    expect(settled.statusCode).toBe(lostAck ? 503 : 200);
    expect(injected).toBe(lostAck);
    expect(JSON.parse(requireFile()).employeeRecoveryOperations[0].application.state).toBe('completed-stopped');
    rename.mockRestore();
    service.close();
    await app.close();
    const child = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/employee-recovery-restart.mts', import.meta.url)),
        root,
        employeeId,
        session.id,
        JSON.stringify(selected),
      ],
      { timeout: 15000, maxBuffer: 64 * 1024, cwd: fileURLToPath(new URL('..', import.meta.url)) }
    ).catch((error: Error & { stdout?: string; stderr?: string }) => {
      console.error('Actual restart child output:', error.stdout, error.stderr);
      throw error;
    });
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(result.pid).not.toBe(process.pid);
    expect(result).toMatchObject({
      loadedDenied: true,
      freshOwner: true,
      freshOriginalObserve: true,
      completedStopped: true,
      noProvider: true,
    });
    expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
      'employee-recovery',
      'employee-recovery-observe',
      'employee-recovery-observe',
    ]);
    expect(physical.spawn).not.toHaveBeenCalled();
  }
);
it('does not unlink an unowned exclusive-temp collision or release recovery on that refusal', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  const now = Date.now(),
    clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const collision = join(root, 'state.json') + '.' + process.pid + '.' + now + '.recovery-stopped.tmp';
  await fs.writeFile(collision, 'private-original-sentinel', { mode: 0o600, flag: 'wx' });
  const refused = await inspect(selected);
  expect(refused.statusCode).toBe(503);
  expect(readFileSync(collision, 'utf8')).toBe('private-original-sentinel');
  expect(publicationStore.statePublicationHeld).toBe(false);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  clock.mockRestore();
  await fs.unlink(collision);
  const resumed = await inspect(selected);
  expect(resumed.statusCode, resumed.body).toBe(200);
  expect(resumed.json().data.application.state).toBe('completed-stopped');
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
    'employee-recovery-observe',
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('keeps the newer actual launch owner when an older stopped launch callback completes late', async () => {
  session.setMode('shell');
  const input = session.captureInputAdmission(),
    confirm = session['_confirmWorkerLaunchPane'].bind(session);
  let enteredOld!: () => void,
    enteredNew!: () => void,
    releaseOld!: () => void,
    releaseNew!: () => void,
    calls = 0;
  const oldReached = new Promise<void>((resolve) => {
      enteredOld = resolve;
    }),
    newReached = new Promise<void>((resolve) => {
      enteredNew = resolve;
    });
  const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    }),
    newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
  releaseFixtureWrites.push(releaseOld, releaseNew);
  session['_confirmWorkerLaunchPane'] = async (...args) => {
    if (++calls === 1) {
      enteredOld();
      await oldGate;
    } else if (calls === 2) {
      enteredNew();
      await newGate;
    }
    await confirm(...args);
  };
  const older = session.startShell().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );
  await Promise.race([
    oldReached,
    older.then(() => {
      throw Error('Old real launch never reached its pane confirmation');
    }),
  ]);
  const first = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id];
  const selected = EmployeeRecoveryApproval.parse({ ...approval(), originalAttemptId: first.attemptId });
  expect((await send(selected)).statusCode).toBe(200);
  physical.exit!({ exitCode: 0 });
  stoppedFrame = 'normal-close';
  expect((await inspect(selected)).json().data.application.state).toBe('completed-stopped');
  expect(input()).toBe(false);
  await company.setVacation(employeeId, undefined, false);
  const newer = session.startShell().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );
  await Promise.race([
    newReached,
    newer.then(() => {
      throw Error('New real launch never reached its pane confirmation');
    }),
  ]);
  const second = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id];
  expect(second.attemptId).not.toBe(first.attemptId);
  releaseOld();
  expect((await older).ok).toBe(false);
  physical.exit!({ exitCode: 0 });
  await expect(session.startShell()).rejects.toThrow('Session launch is already in progress');
  expect(physical.spawn).toHaveBeenCalledTimes(2);
  releaseNew();
  expect((await newer).ok).toBe(false);
  expect(session.providerDispatchHeld).toBe(true);
  expect(
    JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[session.id].attemptId
  ).toBe(second.attemptId);
  expect(store.snapshot().employees[0]!.desiredRunning).toBe(true);
  expect(input()).toBe(false);
});
it('retains the original after an expired full-frame observation and requires a fresh protected Inspect', async () => {
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  const before = requireFile(),
    observed = ResourceNativeClient.prototype.observeEmployeeRecoveryOriginal;
  let restoreClock: (() => void) | undefined;
  const late = vi
    .spyOn(ResourceNativeClient.prototype, 'observeEmployeeRecoveryOriginal')
    .mockImplementationOnce(async function (this: ResourceNativeClient, attempt) {
      const reply = await observed.call(this, attempt);
      expect(reply.stopped).toBeInstanceOf(OriginalStoppedRecovery);
      const expiredAt = Date.now() + 11000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
      restoreClock = () => {
        clock.mockRestore();
      };
      return reply;
    });
  try {
    const expired = await inspect(selected);
    expect(expired.statusCode).toBe(503);
    expect(requireFile()).toBe(before);
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  } finally {
    restoreClock?.();
    late.mockRestore();
  }
  const fresh = await inspect(selected);
  expect(fresh.statusCode, fresh.body).toBe(200);
  expect(fresh.json().data.application.state).toBe('completed-stopped');
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
    'employee-recovery-observe',
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it('refuses an unrelated held main writer before the first stopped Company publication even when its attempted bytes match', async () => {
  publicationStore.setSession(session.id, session.toPersistedState());
  await publicationStore.saveNowAsync();
  const actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  let injected = false;
  vi.mocked(syncFs.renameSync).mockImplementation((from, to) => {
    actual(from, to);
    if (String(to) === join(root, 'state.json') && !injected) {
      injected = true;
      throw Error('Synthetic unrelated watcher ACK loss');
    }
  });
  await expect(publicationStore.commitCronWatch(() => {})).rejects.toThrow();
  expect(publicationStore.statePublicationHeld).toBe(true);
  vi.mocked(syncFs.renameSync).mockImplementation(actual);
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  const before = requireFile(),
    main = readFileSync(join(root, 'state.json'), 'utf8');
  stoppedFrame = 'normal-close';
  const refused = await inspect(selected);
  expect(refused.statusCode).toBe(503);
  expect(requireFile()).toBe(before);
  expect(store.snapshot().employees[0]!.desiredRunning).not.toBe(false);
  expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(main);
  expect(publicationStore.statePublicationHeld).toBe(true);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(physical.spawn).not.toHaveBeenCalled();
});
it.each(['mode', 'recipe'] as const)(
  'refuses a loaded terminal original when its actual %s subject changed before fresh Observe',
  async (changed) => {
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    expect((await inspect(selected)).json().data.application.state).toBe('completed-stopped');
    await reconstructRecoveryApplication();
    if (changed === 'mode') session.setMode('shell');
    else
      await store.update((state) => {
        state.employees[0]!.runtimeRecipe = {
          mode: 'claude',
          workingDir: root,
          model: 'different-authorized-recipe',
          configs: {},
        };
      });
    const before = requireFile(),
      count = messages.filter((row) => row.kind === 'resource-operation').length;
    expect((await inspect(selected)).statusCode).not.toBe(200);
    expect(requireFile()).toBe(before);
    expect(messages.filter((row) => row.kind === 'resource-operation')).toHaveLength(count);
    expect(physical.spawn).not.toHaveBeenCalled();
  }
);
it.each(['terminal', 'viewer'] as const)(
  'keeps the independent %s input hold after known stopped settlement and a later explicit Enter',
  async (held) => {
    const id = session.id;
    service.close();
    session = new Session({
      id,
      mode: 'claude',
      workingDir: root,
      useMux: false,
      publicationStore,
      terminalInputHeld: held === 'terminal',
      viewerInputHeld: held === 'viewer',
    });
    company = freshCompany();
    service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
    await openRecoveryApp();
    const selected = approval();
    expect((await send(selected)).statusCode).toBe(200);
    stoppedFrame = 'normal-close';
    const completed = await inspect(selected);
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().data.application.state).toBe('completed-stopped');
    expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(true);
    expect(session.terminalInputHeld).toBe(held === 'terminal');
    expect(session.viewerInputHeld).toBe(held === 'viewer');
    const persisted = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[id];
    expect(persisted[held === 'terminal' ? 'terminalInputHeld' : 'viewerInputHeld']).toBe(true);
    expect(session.captureInputAdmission()()).toBe(false);
    await company.setVacation(employeeId, undefined, false);
    expect(session.terminalInputHeld).toBe(held === 'terminal');
    expect(session.viewerInputHeld).toBe(held === 'viewer');
    expect(session.captureInputAdmission()()).toBe(false);
    expect(physical.spawn).not.toHaveBeenCalled();
  }
);

it('refuses settlement when the main revision changes between the loaded bytes and revision capture', async () => {
  publicationStore.setSession(session.id, session.toPersistedState());
  await publicationStore.saveNowAsync();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const path = join(root, 'state.json'),
    before = actual.readFileSync(path, 'utf8');
  const foreignState = JSON.parse(before);
  foreignState.config.maxConcurrentSessions = 17;
  const foreign = JSON.stringify(foreignState);
  let interleaved = false;
  const read = vi.spyOn(syncFs, 'readFileSync').mockImplementation((...args) => {
    const bytes = actual.readFileSync(...args);
    if (String(args[0]) === path && !interleaved) {
      interleaved = true;
      actual.writeFileSync(path + '.foreign', foreign, { mode: 0o600, flag: 'wx' });
      actual.renameSync(path + '.foreign', path);
    }
    return bytes;
  });
  const loaded = new StateStore(path);
  read.mockRestore();
  expect(interleaved).toBe(true);
  expect(loaded.getConfig().maxConcurrentSessions).not.toBe(17);
  service.close();
  publicationStore = loaded;
  session = new Session({ id: session.id, workingDir: root, mode: 'claude', useMux: false, publicationStore });
  company = freshCompany();
  service = new EmployeeRecoveryService(company, auth, join(root, 'native.sock'), plans);
  await openRecoveryApp();
  const selected = approval();
  expect((await send(selected)).statusCode).toBe(200);
  stoppedFrame = 'normal-close';
  const companyBefore = requireFile(),
    desiredBefore = store.snapshot().employees[0]!.desiredRunning;
  const observed = await inspect(selected);
  expect(observed.statusCode).toBe(503);
  expect(actual.readFileSync(path, 'utf8')).toBe(foreign);
  expect(requireFile()).toBe(companyBefore);
  expect(store.snapshot().employees[0]!.desiredRunning).toBe(desiredBefore);
  expect(company.employeeRecoveryAvailable(employeeId, undefined)).toBe(false);
  expect(messages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
  expect(physical.spawn).not.toHaveBeenCalled();
});

it('returns retained native diagnostics through fresh authenticated inspection without releasing the recovery fence', async () => {
  const launch = vi.spyOn(session, 'startInteractive');
  const stop = vi.spyOn(session, 'stop');
  const selected = approval();
  const before = company.view(undefined).employees[0];
  expect((await send(selected)).statusCode).toBe(200);
  mode = 'diagnostic';
  const observed = await inspect(selected);
  expect(observed.statusCode).toBe(200);
  expect(observed.json().data.native).toMatchObject({
    approval: selected,
    outcome: 'unconfirmed',
    diagnostics: {
      primaryCode: 'WORKER_RECOVERY_PROVIDER_UNCONFIRMED',
      secondaryCode: 'WORKER_REPORT_CLOSE_UNKNOWN',
    },
  });
  expect(observed.json().data.application.state).toBe('recovery-required');
  expect(company.view(undefined).employees[0]).toEqual(before);
  expect((await send()).statusCode).toBe(409);
  expect(messages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect(launch).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(physical.spawn).not.toHaveBeenCalled();
});
