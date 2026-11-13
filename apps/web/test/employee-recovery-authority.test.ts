/** Actual private config/key, account, canonical grant and durable nonce owners.
 * No native controller, deployment or provider effect is represented here. */
import * as fs from 'node:fs';
import * as asyncStorage from 'node:fs/promises';
import { TmuxManager } from '../src/tmux-manager.js';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebServer } from '../src/web/server.js';
import cookie from '@fastify/cookie';
import { createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema } from '../src/company-types.js';
import { loadServiceAuthConfig } from '../src/service-auth-config.js';
import { createServiceAuthorization } from '../src/service-authorization.js';
import { ResourceOwnerAuthority, type RamEmployeeRecoveryContext } from '../src/resource-owner-authority.js';
import { signServiceAssertion, ServiceGrantAuthentication } from '../src/service-grant-auth.js';
import {
  EmployeeRecoveryApproval,
  EmployeeRecoveryRequest,
  NativeEmployeeGeneration,
  EmployeeRecoveryResult,
  parseEmployeeRecoveryResult,
} from '../src/employee-recovery-operation.js';
import { WorkerRecoveryAuthentication } from '../src/worker-recovery-auth.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { PlanMoves, type PlanMoveRecord } from '../src/plan-move.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import {
  EmployeeRecoveryService,
  registerEmployeeRecoveryRoutes,
  isEmployeeRecoveryTransport,
} from '../src/employee-recovery-service.js';
import { registerAuthMiddleware, registerHostGuard, isCapabilityRequest } from '../src/web/middleware/auth.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { relations } from '../src/owner-auth/relations.js';
import { ResourceNativeClient } from '../src/resource-native-client.js';
import { GoalNonceStore } from '../src/goal-nonce-store.js';
import { OfficeScopedActionPublisher } from '../src/office-scoped-action-publisher.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: ((file, options) => {
      const entry = actual.lstatSync(file, options as never);
      // Same explicit sandbox-root metadata edge as worker-recovery-auth.test.
      // All private fixture descendants/opened FDs/canonical bytes remain real.
      return file === '/' ? Object.assign(entry, { uid: typeof entry.uid === 'bigint' ? 0n : 0 }) : entry;
    }) as typeof actual.lstatSync,
  };
});

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const eid = '10000000-0000-4000-8000-000000000001';
const sid = '10000000-0000-4000-8000-000000000002';
const operationId = '10000000-0000-4000-8000-000000000003';
const sourceId = '10000000-0000-4000-8000-000000000004';
const sourceSid = '10000000-0000-4000-8000-000000000005';
const approval = EmployeeRecoveryApproval.parse({
  operationId,
  sessionId: sid,
  sessionGeneration: '1',
  originalAttemptId: null,
  parentOperationId: null,
  action: 'stop-provider',
});
let directory: string, store: CompanyStore, ownerStore: OwnerAuthStore, owner: OfficeAuthService;
let key: Buffer,
  sequence = 0;
let services: ReturnType<typeof createServiceAuthorization>;
const cleanup: Array<() => Promise<unknown> | void> = [];
const flock = fs.realpathSync(
  (process.env.PATH ?? '')
    .split(':')
    .map((part) => join(part, 'flock'))
    .find((file) => fs.existsSync(file))!
);
beforeEach(async () => {
  directory = fs.mkdtempSync(join(tmpdir(), 'employee-recovery-authority-'));
  fs.chmodSync(directory, 0o700);
  ownerStore = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  owner = new OfficeAuthService({ store: ownerStore, auditFile: join(directory, 'audit'), setupEnabled: true });
  const password = 'Synthetic-recovery-fixture-42!';
  await owner.setup('fixture-primary', password, password, '127.0.0.1');
  store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  await store.update((state) => {
    state.employees.push(
      EmployeeSchema.parse({
        id: eid,
        name: 'Fixture',
        icon: 'F',
        position: 'Engineer',
        expertise: ['fixtures'],
        sessionId: sid,
        sessionGeneration: 1,
        desiredRunning: true,
        createdAt: 1,
      })
    );
    // Fixture DATA in the real canonical store. The verifier still requires
    // its real configured HMAC key, exact grant, owner, target and nonce.
    state.serviceGrants.push({
      id: 'recovery-grant',
      purpose: 'OPS_STOP',
      principal: 'recovery-service',
      epoch: 'opaque-epoch',
      employees: [{ employeeId: eid, sessionId: sid, sessionGeneration: 1 }],
      resources: ['employee-' + eid],
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60000,
    });
    state.serviceGrants.push({ ...state.serviceGrants[0]!, id: 'recovery-observe', purpose: 'OPS_OBSERVE' });
    state.serviceGrants.push({ ...state.serviceGrants[0]!, id: 'recovery-close', purpose: 'OPS_CLOSE' });
  });
  key = randomBytes(32);
  fs.writeFileSync(join(directory, 'key'), key, { mode: 0o400 });
  fs.writeFileSync(
    join(directory, 'config.json'),
    JSON.stringify({
      version: 1,
      serviceUid: process.geteuid!(),
      purposes: {
        OPS_STOP: { scope: 'employees+resources', action: 'reverie.ops.employee.stop-provider' },
        OPS_OBSERVE: { scope: 'employees+resources', action: 'reverie.ops.employee.reconcile-owned' },
        OPS_CLOSE: { scope: 'employees+resources', action: 'reverie.ops.employee.close-viewer' },
      },
      principals: [
        {
          principal: 'recovery-service',
          epoch: 'opaque-epoch',
          key: join(directory, 'key'),
          officeEmployeeId: sourceId,
        },
      ],
    }),
    { mode: 0o600 }
  );
  fs.mkdirSync(join(directory, 'nonces'), { mode: 0o700 });
  const file = join(directory, 'nonces', 'ledger.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      storeId: operationId,
      capacity: 64,
      revision: 0,
      clockFloor: Date.now() - 1000,
      entries: [],
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(file + '.lock', '', { mode: 0o600 });
  configure();
});
function configure() {
  const file = join(directory, 'nonces', 'ledger.json');
  services = createServiceAuthorization(loadServiceAuthConfig(join(directory, 'config.json')), {
    company: { store },
    custody: {
      assertPrivateCustody(path) {
        if (path !== store.file) throw Error('wrong company custody');
      },
    },
    nonce: {
      file,
      storeId: operationId,
      capacity: 64,
      flockExecutable: flock,
      authorityNamespace: join(directory, 'nonces', 'authority'),
      assertPrivateCustody(scope) {
        expect(scope).toEqual({
          root: join(directory, 'nonces'),
          parent: directory,
          file,
          lock: file + '.lock',
          temporary: file + '.pending',
          authorityNamespace: join(directory, 'nonces', 'authority'),
        });
      },
    },
  });
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
const assertion = (purpose = 'OPS_STOP', grantId = 'recovery-grant') =>
  signServiceAssertion(key, {
    purpose,
    principal: 'recovery-service',
    epoch: 'opaque-epoch',
    ownerId: '',
    grantId,
    issuedAt: Date.now() - 1,
    expiresAt: Date.now() + 9000,
    nonce: (++sequence).toString(16).padStart(32, '0'),
  });

it.each(['', '0', '01', '-1', '18446744073709551616', 'not-a-generation'])(
  'rejects malformed generation %s without throwing out of safeParse',
  (value) => {
    expect(NativeEmployeeGeneration.safeParse(value).success).toBe(false);
  }
);
it('keeps native generation decimal DATA beyond JavaScript integer precision', () => {
  expect(NativeEmployeeGeneration.parse('18446744073709551615')).toBe('18446744073709551615');
});
it('requires explicit parent null and permits only distinct close-viewer component parent DATA', () => {
  const { parentOperationId: missing, ...without } = approval;
  expect(missing).toBeNull();
  expect(EmployeeRecoveryApproval.safeParse(without).success).toBe(false);
  expect(EmployeeRecoveryApproval.safeParse({ ...approval, parentOperationId: randomUUID() }).success).toBe(false);
  expect(
    EmployeeRecoveryApproval.safeParse({ ...approval, action: 'close-viewer', parentOperationId: approval.operationId })
      .success
  ).toBe(false);
  expect(
    EmployeeRecoveryApproval.parse({ ...approval, action: 'close-viewer', parentOperationId: randomUUID() }).action
  ).toBe('close-viewer');
});

it('decodes every actual Rust encoder fixture with exact original approval and no authority promotion', () => {
  const repo = new URL('../../../crates/reverie-contracts/tests/fixtures/employee-recovery-v1.json', import.meta.url);
  const file = fs.existsSync(repo) ? repo : new URL('./fixtures/employee-recovery-v1.json', import.meta.url);
  const Envelope = z
    .object({ kind: z.literal('resource-result'), requestId: z.string().uuid(), value: EmployeeRecoveryResult })
    .strict();
  const cases = z
    .array(
      z
        .object({
          case: z.string(),
          canonicalReply: z.string(),
          reply: Envelope,
          request: z
            .object({
              kind: z.literal('resource-operation'),
              requestId: z.string().uuid(),
              verb: z.enum(['employee-recovery', 'employee-recovery-observe']),
              employeeId: z.string().uuid(),
              approval: EmployeeRecoveryApproval,
            })
            .strict(),
        })
        .strict()
    )
    .parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  expect(cases).toHaveLength(12);
  expect(new Set(cases.map((row) => row.case)).size).toBe(12);
  for (const row of cases) {
    expect(Envelope.parse(JSON.parse(row.canonicalReply))).toEqual(row.reply);
    expect(parseEmployeeRecoveryResult(row.reply.value, row.request.employeeId, row.request.approval)).toEqual(
      row.reply.value
    );
    expect(row.reply.requestId).toBe(row.request.requestId);
    if (row.request.approval.parentOperationId === null) expect(row.reply.value.outcome).toBe(row.case);
    else expect(['viewer-close-pending', 'viewer-closed']).toContain(row.reply.value.outcome);
    expect(row.reply.value.approval.sessionGeneration).toBe('9007199254740993');
  }
});

it('decodes the closed native recovery outcomes without promoting observations to authority', () => {
  const common = {
    version: 1,
    purpose: 'employee-recovery-v1',
    employeeId: approval.sessionId,
    approval,
    earlierEffects: 'unproved',
  };
  for (const [action, outcomes] of [
    ['reconcile-owned', ['original-handler-pending', 'original-handler-reconciled']],
    ['stop-provider', ['provider-stop-pending', 'provider-stopped-viewer-pending', 'provider-stopped']],
    ['close-viewer', ['viewer-close-pending', 'viewer-closed']],
  ] as const) {
    const selected = EmployeeRecoveryApproval.parse({ ...approval, action });
    for (const outcome of outcomes) {
      const value = { ...common, approval: selected, outcome, newDispatch: 'attempted' };
      expect(parseEmployeeRecoveryResult(value, common.employeeId, selected)).toEqual(value);
      const other = EmployeeRecoveryApproval.parse({
        ...selected,
        action: action === 'stop-provider' ? 'close-viewer' : 'stop-provider',
      });
      expect(EmployeeRecoveryResult.safeParse({ ...value, approval: other }).success).toBe(false);
    }
  }
  for (const outcome of ['custody-unavailable', 'refused-before-new-effect', 'unconfirmed'] as const)
    expect(EmployeeRecoveryResult.safeParse({ ...common, outcome, newDispatch: 'not-attempted' }).success).toBe(true);
});

it('refuses foreign binding, rewritten original approval, unknown fields and invalid native action/dispatch outcomes', () => {
  const value = {
    version: 1,
    purpose: 'employee-recovery-v1',
    employeeId: approval.sessionId,
    approval,
    outcome: 'provider-stopped',
    newDispatch: 'attempted',
    earlierEffects: 'unproved',
  };
  expect(() => parseEmployeeRecoveryResult(value, randomUUID(), approval)).toThrow();
  expect(() =>
    parseEmployeeRecoveryResult(
      { ...value, approval: { ...approval, operationId: randomUUID() } },
      value.employeeId,
      approval
    )
  ).toThrow();
  for (const changed of [
    { extra: true },
    { outcome: 'ready' },
    { newDispatch: 'true' },
    { newDispatch: 'not-attempted' },
    { earlierEffects: 'proved' },
    { outcome: 'custody-unavailable' },
  ])
    expect(EmployeeRecoveryResult.safeParse({ ...value, ...changed }).success).toBe(false);
});
it('does not turn a configured service or structural lease into a human resource context without original source custody', async () => {
  const authority = new ResourceOwnerAuthority(owner, services);
  const app = Fastify();
  let captured: RamEmployeeRecoveryContext | undefined;
  app.post('/api/company/employees/' + eid + '/recovery', async (req) => {
    try {
      captured = await authority.authenticateEmployeeRecovery(req, eid, approval);
      return { allowed: true };
    } catch {
      return { allowed: false };
    }
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/company/employees/' + eid + '/recovery',
    headers: { 'x-reverie-service-assertion': assertion() },
    payload: approval,
  });
  expect(response.json()).toEqual({ allowed: false });
  expect(captured).toBeUndefined();
  expect(() =>
    authority.bindRam({ stage: 'apply', principal: owner.registeredResourceOwner(undefined) } as never)
  ).toThrow();
  expect(() =>
    ServiceGrantAuthentication.prototype.leaseDeadline.call(services.auth, {
      ownerId: '',
      principal: 'recovery-service',
      currentFor: () => true,
    } as never)
  ).toThrow();
  authority.close();
  await app.close();
});
async function actualSource(
  production?: 'basic' | 'enforce' | 'multiuser',
  completion = false,
  expectedAuthorities?: readonly ('human-owner' | 'delegated-service')[]
) {
  await store.update((state) =>
    state.employees.push(
      EmployeeSchema.parse({
        id: sourceId,
        name: 'Operator',
        icon: 'O',
        position: 'Engineer',
        expertise: ['fixtures'],
        sessionId: sourceSid,
        sessionGeneration: 7,
        desiredRunning: true,
        permissions: { recoverEmployees: true },
        createdAt: 1,
      })
    )
  );
  const sourceKey = randomBytes(32),
    sourceConfig = {
      version: 1,
      issuer: 'fixture-source',
      epoch: 'source-epoch',
      key: sourceKey.toString('hex'),
      storeId: operationId,
    };
  fs.writeFileSync(join(directory, 'worker-recovery-auth.json'), JSON.stringify(sourceConfig), { mode: 0o600 });
  fs.writeFileSync(
    join(directory, 'recovery-nonces.json'),
    JSON.stringify({
      version: 1,
      storeId: operationId,
      capacity: 4096,
      revision: 0,
      clockFloor: Date.now() - 1000,
      entries: [],
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(join(directory, 'recovery-nonces.json.lock'), '', { mode: 0o600 });
  const source = new WorkerRecoveryAuthentication(directory, () => store.snapshot().employees, flock);
  const selected = await services.auth.authenticate({ assertion: assertion() }, 'OPS_STOP');
  expect(selected).not.toBeNull();
  const grantRef = { grantId: selected!.grantId, policyGeneration: selected!.generation };
  const readLease = await services.auth.authenticate(
    { assertion: assertion('OPS_OBSERVE', 'recovery-observe') },
    'OPS_OBSERVE'
  );
  expect(readLease).not.toBeNull();
  const observeGrantRef = { grantId: readLease!.grantId, policyGeneration: readLease!.generation };
  const closeLease = await services.auth.authenticate(
    { assertion: assertion('OPS_CLOSE', 'recovery-close') },
    'OPS_CLOSE'
  );
  expect(closeLease).not.toBeNull();
  const closeGrantRef = { grantId: closeLease!.grantId, policyGeneration: closeLease!.generation };
  const authority = new ResourceOwnerAuthority(owner, services, source),
    app = Fastify();
  cleanup.push(
    () => app.close(),
    () => authority.close()
  );
  source.register(app);
  await app.register(cookie);
  let context: RamEmployeeRecoveryContext | undefined;
  const target = '/api/company/employees/' + eid + '/recovery';
  const qMessages: Record<string, unknown>[] = [];
  let callerSession: Session | undefined;
  let prepareColdObservation: (() => Promise<void>) | undefined;
  if (production) {
    vi.stubEnv('REVERIE_PASSWORD', 'Synthetic-basic-fixture-42!');
    vi.stubEnv('REVERIE_MULTIUSER', production === 'multiuser' ? '1' : '0');
    const auth = registerAuthMiddleware(app, false, '', production === 'enforce' ? owner : undefined);
    cleanup.push(() => {
      for (const entry of Object.values(auth)) entry?.dispose();
    });
    registerHostGuard(app, () => ({ bindHost: '127.0.0.1', allowedHosts: [] }));
    const nativeSocket = await nativeObservationPort(qMessages, completion, expectedAuthorities);
    vi.stubEnv('REVERIE_WORKER_SOCKET', nativeSocket);
    const publicationStore = completion ? new StateStore(join(directory, 'state.json')) : undefined;
    const targetSession = new Session({
      id: sid,
      mode: 'claude',
      workingDir: directory,
      useMux: false,
      ...(publicationStore ? { publicationStore } : {}),
    });
    callerSession = new Session({ id: sourceSid, mode: 'claude', workingDir: directory, useMux: false });
    const sessions = new Map([
        [sid, targetSession],
        [sourceSid, callerSession],
      ]),
      rooms = new ChatroomStore();
    const company = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, s, opts) => rooms.addMember(id, s, opts).member,
        setStatus: (id, s, status) => rooms.setStatus(id, s, status),
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    registerOwnerPolicy(app, {
      service: owner,
      ctx: { sessions } as never,
      relations: relations({
        recordedParent: (id) => sessions.get(id)?.parentSessionId,
        known: (id) => sessions.has(id),
        rooms: () => rooms.list(),
        predecessor: () => undefined,
        employeeOf: (id) => store.snapshot().employees.find((employee) => employee.sessionId === id)?.id,
        keepers: () => owner.keepers(),
        admins: () => owner.admins(),
      }),
      isCapabilityRequest: (request) => isCapabilityRequest(request) || isEmployeeRecoveryTransport(request),
    });
    const planStore = new PlanMoveStore(join(directory, 'moves.json'));
    const plans = new PlanMoves({
      load: () => planStore.load(),
      save: (rows: PlanMoveRecord[]) => planStore.save(rows),
    } as never);
    const service = new EmployeeRecoveryService(company, owner, nativeSocket, plans, services, source);
    cleanup.push(() => service.close());
    prepareColdObservation = async () => {
      if (!publicationStore || targetSession.pid !== null) throw Error('Cold fixture requires actual pid-null target');
      publicationStore.setSession(targetSession.id, targetSession.toPersistedState());
      await publicationStore.saveNowAsync();
      service.close();
      await app.close();
    };
    registerEmployeeRecoveryRoutes(app, service);
    app.post('/api/company/employees/:employeeId/recovery/neighbor', async () => ({ unexpected: true }));
    app.get('/api/company/employees/:employeeId/recovery', async () => ({ unexpected: true }));
  } else
    app.post(target, async (req, reply) => {
      try {
        context = await authority.authenticateEmployeeRecovery(
          req,
          eid,
          EmployeeRecoveryRequest.parse(req.body).approval
        );
        expect(
          await authority.authenticateEmployeeRecovery(req, eid, EmployeeRecoveryRequest.parse(req.body).approval)
        ).toBe(context);
        return { kind: context.recoveryAuthority.kind };
      } catch {
        return reply.code(403).send({ error: 'refused' });
      }
    });
  const send = (
    over: Partial<typeof approval> = {},
    headers: Record<string, string> = {},
    selectedGrant = grantRef,
    observe = false,
    selection = false,
    recipient: FastifyInstance = app,
    prefix = '',
    explicit?: { target: string; body: Record<string, unknown> }
  ) => {
    const body = JSON.stringify(
        explicit?.body ??
          (selection ? { grantRef: selectedGrant } : { approval: { ...approval, ...over }, grantRef: selectedGrant })
      ),
      now = Date.now(),
      requestTarget =
        explicit?.target ??
        (selection ? target.replace(/recovery$/, 'recovery-selection') : target + (observe ? '/observe' : ''));
    const fields = [
      1,
      'worker-recovery-request',
      sourceConfig.issuer,
      sourceConfig.epoch,
      sourceSid,
      7,
      'POST',
      requestTarget,
      createHash('sha256').update(body).digest('hex'),
      now - 1,
      now + 9000,
      (++sequence).toString(16).padStart(32, '0'),
    ];
    const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
    const proof =
      encoded +
      '.' +
      createHmac('sha256', sourceKey)
        .update('reverie-worker-recovery-request-v1\n' + encoded)
        .digest('hex');
    return recipient.inject({
      method: 'POST',
      url: prefix + requestTarget,
      headers: { 'content-type': 'application/json', 'x-reverie-recovery-assertion': proof, ...headers },
      payload: body,
    });
  };
  return {
    authority,
    app,
    send,
    grantRef,
    closeGrantRef,
    selection: (selectedGrant = observeGrantRef) => send({}, {}, selectedGrant, false, true),
    selectionFor: (recipient: FastifyInstance, prefix: string, selectedGrant = observeGrantRef) =>
      send({}, {}, selectedGrant, false, true, recipient, prefix),
    metadataFor: (
      recipient: FastifyInstance,
      prefix: string,
      selectedGrant: typeof grantRef,
      writerId: string,
      expectedIncidentId: string
    ) =>
      send({}, {}, selectedGrant, false, false, recipient, prefix, {
        target: '/api/mux/metadata/reconcile',
        body: { employeeId: eid, grantRef: selectedGrant, writerId, expectedIncidentId },
      }),
    qMessages,
    observe: () => send({}, {}, observeGrantRef, true),
    callerSession: () => callerSession!,
    prepareColdObservation: () => {
      if (!prepareColdObservation) throw Error('Cold fixture requires actual production routes');
      return prepareColdObservation();
    },
    context: () => context!,
  };
}
/** Explicit physical transport fixture only. Actual app auth/writer/Session
 * owners remain real; this makes no native provider-stop qualification. */
async function nativeObservationPort(
  messages: Record<string, unknown>[],
  completion = false,
  expectedAuthorities?: readonly ('human-owner' | 'delegated-service')[]
): Promise<string> {
  const peers = new Set<Socket>(),
    originalDirectory = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    ),
    path = `/proc/self/fd/${originalDirectory}/native.sock`;
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)),
      header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
  };
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    let ready = false,
      buffer = Buffer.alloc(0),
      operation: Record<string, unknown>;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        if (buffer.length < 5) return;
        const size = buffer.readUInt32BE(1);
        if (buffer.length < 5 + size) return;
        expect(buffer[0]).toBe('Q'.charCodeAt(0));
        buffer = buffer.subarray(5 + size);
        ready = true;
        socket.write('RESOURCE_READY\n');
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE();
        if (buffer.length < size + 4) return;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString()) as Record<string, unknown>;
        messages.push(value);
        buffer = buffer.subarray(size + 4);
        if (value.kind === 'resource-operation') {
          operation = value;
          socket.write(
            frame({
              kind: 'resource-owner-check',
              requestId: value.requestId,
              nonce: randomUUID(),
              stage: value.verb,
              employeeId: eid,
              approval: value.approval,
            })
          );
        } else {
          expect(value.kind).toBe('resource-owner-current');
          expect(value).not.toHaveProperty('principal');
          const index = messages.filter((row) => row.kind === 'resource-operation').length - 1;
          const expected = expectedAuthorities ? expectedAuthorities[index] : 'delegated-service';
          expect(expected).toBeDefined();
          expect(value.recoveryAuthority).toMatchObject({ kind: expected });
          if (expected === 'delegated-service')
            expect(value.recoveryAuthority).toMatchObject({
              kind: 'delegated-service',
              action:
                operation.verb === 'employee-recovery-observe'
                  ? 'reverie.ops.employee.reconcile-owned'
                  : `reverie.ops.employee.${EmployeeRecoveryApproval.parse(operation.approval).action}`,
            });
          if (completion && operation.verb === 'employee-recovery-observe') {
            const selected = EmployeeRecoveryApproval.parse(operation.approval);
            expect(selected.action).toBe('stop-provider');
            expect(selected.parentOperationId).toBeNull();
            socket.end(
              frame({
                kind: 'resource-stopped-original',
                version: 1,
                purpose: 'employee-recovery-stopped-original-v1',
                requestId: operation.requestId,
                ownerNonce: value.nonce,
                ownerScopeDigest: value.ownerScopeDigest,
                employeeId: eid,
                approval: selected,
                value: {
                  version: 1,
                  purpose: 'employee-recovery-v1',
                  employeeId: eid,
                  approval: selected,
                  outcome: 'provider-stopped',
                  newDispatch: 'attempted',
                  earlierEffects: 'unproved',
                },
              })
            );
            continue;
          }
          socket.write(
            frame({
              kind: 'resource-result',
              requestId: operation.requestId,
              value: {
                version: 1,
                purpose: 'employee-recovery-v1',
                employeeId: eid,
                approval: operation.approval,
                outcome:
                  EmployeeRecoveryApproval.parse(operation.approval).action === 'close-viewer'
                    ? 'viewer-close-pending'
                    : EmployeeRecoveryApproval.parse(operation.approval).action === 'reconcile-owned'
                      ? 'original-handler-pending'
                      : 'provider-stop-pending',
                newDispatch:
                  EmployeeRecoveryApproval.parse(operation.approval).action === 'reconcile-owned'
                    ? 'not-attempted'
                    : 'attempted',
                earlierEffects: 'unproved',
              },
            })
          );
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    fs.closeSync(originalDirectory);
    throw error;
  }
  fs.chmodSync(path, 0o600);
  cleanup.push(async () => {
    for (const peer of peers) peer.destroy();
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    } finally {
      fs.closeSync(originalDirectory);
    }
  });
  return path;
}

it.each(['basic', 'enforce', 'multiuser'] as const)(
  'supports the genuine source/grant route through full %s middleware without a human credential',
  async (mode) => {
    const f = await actualSource(mode),
      result = await f.send();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      success: true,
      data: { native: { outcome: 'provider-stop-pending' }, application: { state: 'recovery-required' } },
    });
    expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  }
);

it('keeps fake/source-only/grantless/Basic and nearby transport requests behind their actual guards', async () => {
  const f = await actualSource('enforce');
  for (const url of [
    '/api/company/employees/' + eid + '/recovery/neighbor',
    '/api/company/employees/' + eid + '/recovery?alias=1',
  ]) {
    const result = await f.app.inject({
      method: 'POST',
      url,
      headers: { host: 'localhost', 'x-reverie-recovery-assertion': 'fake' },
      payload: { approval },
    });
    expect(result.statusCode).toBe(401);
  }
  expect(
    (
      await f.app.inject({
        method: 'GET',
        url: '/api/company/employees/' + eid + '/recovery',
        headers: { host: 'localhost', 'x-reverie-recovery-assertion': 'fake' },
      })
    ).statusCode
  ).toBe(401);
  expect((await f.send({}, { 'x-reverie-recovery-assertion': 'fake' })).statusCode).toBe(403);
  expect(
    (await f.send({}, { authorization: 'Basic ' + Buffer.from('admin:unused').toString('base64') })).statusCode
  ).toBe(403);
  expect((await f.send({}, {}, { ...f.grantRef, grantId: 'absent' })).statusCode).toBe(403);
  expect((await f.send({}, { origin: 'https://untrusted.invalid' })).statusCode).toBe(403);
  await store.update((state) => {
    state.employees.find((employee) => employee.id === sourceId)!.permissions.recoverEmployees = false;
  });
  expect((await f.send()).statusCode).toBe(403);
  expect(f.qMessages).toHaveLength(0);
  expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
});

it('fresh scoped observation survives revocation of the original stop grant without replaying stop or clearing its fence', async () => {
  const f = await actualSource('enforce');
  expect((await f.send()).statusCode).toBe(200);
  await store.update((state) => {
    state.serviceGrants = state.serviceGrants.filter((grant) => grant.id !== 'recovery-grant');
  });
  const result = await f.observe();
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    success: true,
    data: { native: { approval, outcome: 'provider-stop-pending' }, application: { state: 'recovery-required' } },
  });
  const operations = f.qMessages.filter((message) => message.kind === 'resource-operation');
  expect(operations.map((message) => message.verb)).toEqual(['employee-recovery', 'employee-recovery-observe']);
  expect(operations.map((message) => message.approval)).toEqual([approval, approval]);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  await store.update((state) => {
    state.serviceGrants = [];
  });
  expect((await f.observe()).statusCode).toBe(403);
  expect(f.qMessages.filter((message) => message.kind === 'resource-operation')).toHaveLength(2);
});

it.each(['stopped', 'vacation'] as const)(
  'retains only reconcile-owned target binding after a canonical %s publication, never source or stop authority',
  async (state) => {
    const f = await actualSource('enforce');
    expect((await f.send()).statusCode).toBe(200);
    await store.update((value) => {
      const target = value.employees.find((employee) => employee.id === eid)!;
      if (state === 'stopped') target.desiredRunning = false;
      else target.onVacation = true;
    });
    expect(services.source.binding(eid)).toBeUndefined();
    expect(services.source.retainedBinding(eid)).toMatchObject({
      employeeId: eid,
      sessionId: sid,
      sessionGeneration: 1,
    });
    expect((await f.observe()).statusCode).toBe(200);
    expect((await f.send()).statusCode).toBe(403);
    await store.update((value) => {
      value.employees.find((employee) => employee.id === sourceId)!.desiredRunning = false;
    });
    expect((await f.observe()).statusCode).toBe(403);
    expect(
      f.qMessages.filter((message) => message.kind === 'resource-operation').map((message) => message.verb)
    ).toEqual(['employee-recovery', 'employee-recovery-observe']);
  }
);

it.each(['same', 'aba'] as const)(
  'joins the original caller epoch across actual native open: %s owner assignment',
  async (change) => {
    const f = await actualSource('enforce'),
      originalOpen = ResourceNativeClient.openRam.bind(ResourceNativeClient);
    vi.spyOn(ResourceNativeClient, 'openRam').mockImplementationOnce(async (...args) => {
      const caller = f.callerSession(),
        owner = caller.owner;
      caller.owner = change === 'same' ? owner : 'fixture-other-owner';
      await Promise.resolve();
      caller.owner = owner;
      return originalOpen(...args);
    });
    expect((await f.send()).statusCode).toBe(change === 'same' ? 200 : 409);
    expect(f.qMessages.filter((message) => message.kind === 'resource-operation')).toHaveLength(
      change === 'same' ? 1 : 0
    );
    expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  }
);

it('conjoins actual source proof and exact scoped service grant without representing a service as a human', async () => {
  const f = await actualSource();
  expect((await f.send()).statusCode).toBe(200);
  const context = f.context();
  expect(context.recoveryAuthority).toEqual({
    kind: 'delegated-service',
    ownerRegistration: owner.registeredResourceOwner(undefined),
    service: {
      principal: 'recovery-service',
      issuerEpoch: 'opaque-epoch',
      grantId: 'recovery-grant',
      grantGeneration: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    },
    source: { employeeId: sourceId, sessionId: sourceSid, sessionGeneration: '7' },
    resourceId: 'employee-' + eid,
    action: 'reverie.ops.employee.stop-provider',
  });
  expect(context).not.toHaveProperty('principal');
  f.authority.assertRecoveryAuthentication(context);
  expect(() => f.authority.assertContext(context)).toThrow(); // Staged auth is not a dispatch permit.
  expect(() => JSON.stringify(context)).toThrow('server-private');
  expect(() => f.authority.bindRam(context as never)).toThrow();
  expect(() => f.authority.assertContext({ ...context })).toThrow();
});

it.each(['grant', 'issuer', 'account', 'source', 'target'] as const)(
  'denies retained context after actual %s changes',
  async (change) => {
    const f = await actualSource();
    expect((await f.send()).statusCode).toBe(200);
    const context = f.context();
    if (change === 'grant')
      await store.update((state) => state.serviceGrantRevocations.push({ grantId: 'recovery-grant', at: Date.now() }));
    if (change === 'issuer') {
      fs.unlinkSync(join(directory, 'key'));
      fs.writeFileSync(join(directory, 'key'), randomBytes(32), { mode: 0o400 });
    }
    if (change === 'account')
      await ownerStore.update((account) => {
        account.epoch++;
      });
    if (change === 'source')
      await store.update((state) => {
        state.employees.find((row) => row.id === sourceId)!.sessionGeneration++;
      });
    if (change === 'target')
      await store.update((state) => {
        state.employees.find((row) => row.id === eid)!.sessionGeneration++;
      });
    expect(() => f.authority.assertRecoveryAuthentication(context)).toThrow();
  }
);

it('does not reuse one recovery action grant for another action or wrong source proof', async () => {
  const f = await actualSource();
  expect((await f.send({ action: 'close-viewer' })).statusCode).toBe(403);
  expect((await f.send({}, { 'x-reverie-recovery-assertion': 'forged' })).statusCode).toBe(403);
  expect((await f.send({}, { 'x-reverie-service-assertion': 'forged' })).statusCode).toBe(403);
  expect((await f.send({}, {}, { ...f.grantRef, grantId: 'different-grant' })).statusCode).toBe(403);
  expect((await f.send({}, {}, { ...f.grantRef, policyGeneration: 'sha256:' + '0'.repeat(64) })).statusCode).toBe(403);
  expect((await f.send()).statusCode).toBe(200);
});

it.each(['account', 'source', 'grant'] as const)(
  'rechecks %s across the actual asynchronous service authentication',
  async (change) => {
    const f = await actualSource();
    let entered!: () => void, release!: () => void;
    const joined = new Promise<void>((resolve) => (entered = resolve)),
      wait = new Promise<void>((resolve) => (release = resolve));
    const actual = ServiceGrantAuthentication.prototype.authenticateRecovery;
    vi.spyOn(ServiceGrantAuthentication.prototype, 'authenticateRecovery').mockImplementationOnce(async function (
      this: ServiceGrantAuthentication,
      ...args
    ) {
      const lease = await actual.apply(this, args);
      entered();
      await wait;
      return lease;
    });
    const pending = f.send();
    await joined;
    if (change === 'account')
      await ownerStore.update((account) => {
        account.epoch++;
      });
    if (change === 'source')
      await store.update((state) => {
        state.employees.find((row) => row.id === sourceId)!.sessionGeneration++;
      });
    if (change === 'grant')
      await store.update((state) => state.serviceGrantRevocations.push({ grantId: 'recovery-grant', at: Date.now() }));
    release();
    expect((await pending).statusCode).toBe(403);
  }
);

it('does not accept a prototype-shaped source authenticator with fabricated cached principals', () => {
  const fake = Object.assign(Object.create(WorkerRecoveryAuthentication.prototype), { principals: new WeakMap() });
  expect(() => WorkerRecoveryAuthentication.prototype.authenticate.call(fake, {} as never)).toThrow();
});

it('publishes and consumes the service assertion once per original request, preserving its original deadline', async () => {
  const f = await actualSource();
  const actual = vi.spyOn(ServiceGrantAuthentication.prototype, 'authenticateRecovery');
  expect((await f.send()).statusCode).toBe(200);
  expect(actual).toHaveBeenCalledTimes(1);
  const original = f.context();
  expect((await f.send()).statusCode).toBe(200);
  expect(actual).toHaveBeenCalledTimes(2);
  expect(f.context()).not.toBe(original);
});

it.each(['absent', 'wrong', 'duplicate'] as const)(
  'refuses %s Office issuer association without native authority',
  async (kind) => {
    const file = join(directory, 'config.json'),
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kind === 'absent') delete config.principals[0].officeEmployeeId;
    if (kind === 'wrong') config.principals[0].officeEmployeeId = eid;
    if (kind === 'duplicate') config.principals.push({ ...config.principals[0], principal: 'second-issuer' });
    fs.writeFileSync(file, JSON.stringify(config));
    if (kind === 'duplicate') {
      expect(() => loadServiceAuthConfig(file)).toThrow();
      return;
    }
    configure();
    const f = await actualSource();
    expect((await f.send()).statusCode).toBe(403);
  }
);

it('retains a source association revocation after observing config change even if old bytes are restored', async () => {
  const f = await actualSource();
  expect((await f.send()).statusCode).toBe(200);
  const context = f.context();
  const file = join(directory, 'config.json'),
    before = fs.readFileSync(file);
  const changed = JSON.parse(before.toString());
  delete changed.principals[0].officeEmployeeId;
  fs.writeFileSync(file, JSON.stringify(changed));
  expect(() => context.assertCurrent()).toThrow();
  fs.writeFileSync(file, before);
  expect(() => context.assertCurrent()).toThrow();
});

it('scoped close-viewer can join only its actual retained stopped parent, never borrow stop permission or a body parent ID', async () => {
  const f = await actualSource('enforce');
  expect((await f.send()).statusCode).toBe(200);
  await store.update((state) => {
    state.employees.find((employee) => employee.id === eid)!.desiredRunning = false;
  });
  const child = EmployeeRecoveryApproval.parse({
    ...approval,
    operationId: randomUUID(),
    parentOperationId: approval.operationId,
    action: 'close-viewer',
  });
  expect((await f.send(child)).statusCode).toBe(403);
  expect((await f.send({ ...child, parentOperationId: null }, {}, f.closeGrantRef)).statusCode).toBe(403);
  expect((await f.send({ ...child, parentOperationId: randomUUID() }, {}, f.closeGrantRef)).statusCode).toBe(409);
  expect(f.qMessages.filter((message) => message.kind === 'resource-operation')).toHaveLength(1);
  expect((await f.send(child, {}, f.closeGrantRef)).statusCode).toBe(200);
  expect(store.snapshot().employeeRecoveryOperations).toHaveLength(1);
  expect(store.snapshot().employeeRecoveryOperations![0]!.approval).toEqual(approval);
  expect(store.snapshot().employeeRecoveryOperations![0]!.component?.approval).toEqual(child);
  await store.update((state) => {
    state.employees.find((employee) => employee.id === sourceId)!.desiredRunning = false;
  });
  expect((await f.send(child, {}, f.closeGrantRef)).statusCode).toBe(403);
  expect(
    f.qMessages.filter((message) => message.kind === 'resource-operation').map((message) => message.approval)
  ).toEqual([approval, child]);
});

it.each(['basic', 'enforce', 'multiuser'] as const)(
  'discovers recovery through genuine source and separate reconcile grant under %s without reserving',
  async (mode) => {
    const f = await actualSource(mode);
    const response = await f.selection();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        purpose: 'employee-recovery-selection-v1',
        employeeId: eid,
        sessionId: sid,
        readOnly: true,
        recovery: { kind: 'none' },
        availability: { stopProvider: { state: 'unavailable', reason: 'action-approval-required' } },
      },
    });
    expect(f.qMessages).toHaveLength(0);
    expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
    expect((await f.selection(f.grantRef)).statusCode).toBe(403);
    expect((await f.selection({ ...f.grantRef, grantId: 'missing' })).statusCode).toBe(403);
    expect(f.qMessages).toHaveLength(0);
    expect(store.snapshot().employeeRecoveryOperations).toBeUndefined();
  }
);

it('uses the actual WebServer nonroot ingress for human and genuine Source discovery', async () => {
  const f = await actualSource('enforce');
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  const nonceFile = join(directory, 'nonces', 'ledger.json');
  const nonce = {
    file: nonceFile,
    storeId: operationId,
    capacity: 64,
    flockExecutable: flock,
    authorityNamespace: join(directory, 'nonces', 'authority'),
    assertPrivateCustody(scope: { file: string }) {
      expect(scope.file).toBe(nonceFile);
    },
  };
  const server = new WebServer(
    0,
    false,
    true,
    '127.0.0.1',
    undefined,
    false,
    '/recovery-fixture',
    {
      kind: 'canonical-goal-provisioning',
      mode: 'owner-only',
      issuer: () => undefined,
      nonce,
      custody: {
        assertPrivateCustody(file: string) {
          expect(file).toBe(store.file);
        },
      },
    },
    join(directory, 'config.json')
  );
  const actual = server as unknown as {
    app: FastifyInstance;
    companyService: CompanyService;
    sessions: Map<string, Session>;
    setupRoutes(): Promise<void>;
  };
  await actual.setupRoutes();
  await actual.app.ready();
  cleanup.push(() => actual.app.close());
  actual.sessions.set(sid, new Session({ id: sid, workingDir: directory, mode: 'claude', useMux: false }));
  actual.sessions.set(sourceSid, new Session({ id: sourceSid, workingDir: directory, mode: 'claude', useMux: false }));
  const login = await actual.app.inject({
    method: 'POST',
    url: '/recovery-fixture/api/owner/login',
    headers: { host: 'localhost', origin: 'http://localhost' },
    payload: { username: 'fixture-primary', password: 'Synthetic-recovery-fixture-42!' },
  });
  expect(login.statusCode, login.body).toBe(200);
  const token = login.cookies.find((c) => c.name === 'reverie_owner')!.value;
  const human = await actual.app.inject({
    method: 'GET',
    url: '/recovery-fixture/api/company/employees/' + eid + '/recovery-selection',
    headers: { host: 'localhost', cookie: 'reverie_owner=' + token },
  });
  expect(human.statusCode, human.body).toBe(200);
  expect(human.json()).toMatchObject({ success: true, data: { employeeId: eid, readOnly: true } });
  const delegated = await f.selectionFor(actual.app, '/recovery-fixture');
  expect(delegated.statusCode, delegated.body).toBe(200);
  expect(delegated.json()).toMatchObject({ success: true, data: { employeeId: eid, readOnly: true } });
  // The maintained raw-port bridge path remains unprefixed even with a public mount.
  const direct = await f.selectionFor(actual.app, '');
  expect(direct.statusCode, direct.body).toBe(200);
  expect(direct.json()).toMatchObject({ success: true, data: { employeeId: eid, readOnly: true } });
  expect((await f.selectionFor(actual.app, '/recovery-fixture', f.grantRef)).statusCode).toBe(403);
  for (const suffix of ['/neighbor', '?alias=1']) {
    const refused = await actual.app.inject({
      method: 'POST',
      url: '/recovery-fixture/api/company/employees/' + eid + '/recovery-selection' + suffix,
      headers: { host: 'localhost', 'x-reverie-recovery-assertion': 'fake' },
      payload: { grantRef: f.grantRef },
    });
    expect(refused.statusCode).toBe(401);
  }
  const missingProof = await actual.app.inject({
    method: 'POST',
    url: '/recovery-fixture/api/company/employees/' + eid + '/recovery-selection',
    payload: { grantRef: f.grantRef },
  });
  expect(missingProof.statusCode).toBe(401);

  expect(actual.companyService.store.snapshot().employeeRecoveryOperations).toBeUndefined();
  expect(f.qMessages).toHaveLength(0);
});

it('reconciles metadata through actual nonroot WebServer Source ingress and keeps nearby routes protected', async () => {
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  const nonceFile = join(directory, 'nonces', 'ledger.json');
  const server = new WebServer(
    0,
    false,
    true,
    '127.0.0.1',
    undefined,
    false,
    '/metadata-fixture',
    {
      kind: 'canonical-goal-provisioning',
      mode: 'owner-only',
      issuer: () => undefined,
      nonce: {
        file: nonceFile,
        storeId: operationId,
        capacity: 64,
        flockExecutable: flock,
        authorityNamespace: join(directory, 'nonces', 'authority'),
        assertPrivateCustody(scope: { file: string }) {
          expect(scope.file).toBe(nonceFile);
        },
      },
      custody: {
        assertPrivateCustody(file: string) {
          expect(file).toBe(store.file);
        },
      },
    },
    join(directory, 'config.json')
  );
  const actual = server as unknown as {
    app: FastifyInstance;
    companyService: CompanyService;
    sessions: Map<string, Session>;
    mux: TmuxManager;
    setupRoutes(): Promise<void>;
  };
  const manager = actual.mux;
  expect(manager).toBeInstanceOf(TmuxManager);
  cleanup.push(() => manager.destroy());
  const config = JSON.parse(fs.readFileSync(join(directory, 'config.json'), 'utf8'));
  config.purposes.OPS_METADATA = { scope: 'employees+resources', action: 'reverie.ops.mux-metadata.reconcile' };
  fs.writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
  await store.update((state) =>
    state.serviceGrants.push({
      ...state.serviceGrants[0]!,
      id: 'metadata-grant',
      purpose: 'OPS_METADATA',
      resources: [manager.muxMetadataResourceId()],
    })
  );
  configure();
  const f = await actualSource('enforce');
  const lease = await services.auth.authenticate(
    { assertion: assertion('OPS_METADATA', 'metadata-grant') },
    'OPS_METADATA'
  );
  expect(lease).not.toBeNull();
  const grantRef = { grantId: lease!.grantId, policyGeneration: lease!.generation };
  await actual.setupRoutes();
  await actual.app.ready();
  cleanup.push(() => actual.app.close());
  for (const id of [sid, sourceSid])
    actual.sessions.set(id, new Session({ id, workingDir: directory, mode: 'claude', useMux: false }));
  manager.registerSession({
    sessionId: sid,
    muxName: 'synthetic-metadata',
    pid: 999_999_997,
    workingDir: directory,
    mode: 'shell',
    attached: false,
    createdAt: 1,
  });
  const storage = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let metadataFile: string | undefined;
  const failOriginal = async () => {
    let faulted = false;
    vi.mocked(asyncStorage.rename).mockImplementation(async (...args) => {
      await storage.rename(...args);
      if (String(args[1]).endsWith('/mux-sessions.json')) {
        if (metadataFile) expect(args[1]).toBe(metadataFile);
        metadataFile = String(args[1]);
        faulted = true;
        throw Error('Synthetic metadata rename answer lost');
      }
    });
    try {
      await expect(manager.publishCurrentSessionMetadata()).rejects.toThrow('Mux metadata publication is unconfirmed');
    } finally {
      vi.mocked(asyncStorage.rename).mockImplementation(storage.rename);
    }
    expect(faulted).toBe(true);
    const status = manager.getMuxMetadataPublicationStatus();
    if (status.kind !== 'unconfirmed') throw Error('Expected genuine metadata incident');
    return status;
  };
  const first = await failOriginal();
  // These cannot use the exact registered opaque transport's auth exception.
  for (const [method, suffix, header] of [
    ['POST', '/neighbor', true],
    ['POST', '?alias=1', true],
    ['GET', '', true],
    ['POST', '', false],
  ] as const) {
    const denied = await actual.app.inject({
      method,
      url: '/metadata-fixture/api/mux/metadata/reconcile' + suffix,
      headers: { host: 'localhost', ...(header ? { 'x-reverie-recovery-assertion': 'fake' } : {}) },
      ...(method === 'POST'
        ? { payload: { writerId: first.writerId, expectedIncidentId: first.incidentId, employeeId: eid, grantRef } }
        : {}),
    });
    expect(denied.statusCode, denied.body).toBe(401);
  }
  for (const prefix of ['/metadata-fixture', '']) {
    const incident = prefix ? first : await failOriginal();
    const result = await f.metadataFor(actual.app, prefix, grantRef, incident.writerId, incident.incidentId);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      success: true,
      data: {
        muxMetadataPublication: {
          kind: 'reconciled',
          writerId: incident.writerId,
          repairedIncidentId: incident.incidentId,
        },
      },
    });
    expect(JSON.parse(await storage.readFile(metadataFile!, 'utf8'))[0].sessionId).toBe(sid);
    const repaired = manager.getMuxMetadataPublicationStatus();
    const denied = await f.metadataFor(
      actual.app,
      prefix,
      { ...grantRef, grantId: 'absent' },
      incident.writerId,
      incident.incidentId
    );
    expect(denied.statusCode, denied.body).toBe(403);
    expect(manager.getMuxMetadataPublicationStatus()).toEqual(repaired);
  }
  expect(f.qMessages).toHaveLength(0);
  expect(actual.companyService.store.snapshot().employeeRecoveryOperations).toBeUndefined();
});
/** Private optional acceptance diagnostics; real verifier owners are never replaced. */
function recoveryVerifierCosts(mode: string) {
  const started = performance.now();
  let phase = 'setup';
  const events: Array<{
    kind: string;
    phase: string;
    atMs: number;
    durationMs: number;
    remainingMs?: number;
    site?: string;
    status?: number;
  }> = [];
  const sample = (kind: string, at: number, extra: { remainingMs?: number; site?: string; status?: number } = {}) => {
    events.push({ kind, phase, atMs: at - started, durationMs: performance.now() - at, ...extra });
  };
  const site = () =>
    new Error().stack
      ?.split('\n')
      .filter((line) => line.includes('/src/'))
      .slice(0, 4)
      .map((line) => line.slice(line.indexOf('/src/')))
      .join(' <- ');
  const nonce = GoalNonceStore.prototype.assertCurrent;
  vi.spyOn(GoalNonceStore.prototype, 'assertCurrent').mockImplementation(function (this: GoalNonceStore, ...args) {
    const at = performance.now(),
      origin = site();
    try {
      return nonce.apply(this, args);
    } finally {
      sample(args[1].issuer.startsWith('service:') ? 'service-nonce' : 'source-nonce', at, { site: origin });
    }
  });
  const source = WorkerRecoveryAuthentication.prototype.authenticate;
  vi.spyOn(WorkerRecoveryAuthentication.prototype, 'authenticate').mockImplementation(async function (
    this: WorkerRecoveryAuthentication,
    ...args
  ) {
    const at = performance.now();
    try {
      return await source.apply(this, args);
    } finally {
      sample('source-request-authentication', at);
    }
  });
  const scoped = OfficeScopedActionPublisher.prototype.assertOriginal;
  vi.spyOn(OfficeScopedActionPublisher.prototype, 'assertOriginal').mockImplementation(function (
    this: OfficeScopedActionPublisher,
    ...args
  ) {
    const at = performance.now(),
      origin = site();
    try {
      return scoped.apply(this, args);
    } finally {
      sample('scoped-current-inclusive', at, { site: origin });
    }
  });
  const authenticate = ResourceOwnerAuthority.prototype.authenticateEmployeeRecovery;
  vi.spyOn(ResourceOwnerAuthority.prototype, 'authenticateEmployeeRecovery').mockImplementation(async function (
    this: ResourceOwnerAuthority,
    ...args
  ) {
    const at = performance.now();
    try {
      const context = await authenticate.apply(this, args);
      sample('context-created', at, { remainingMs: context.expiresAtEpochMs - Date.now() });
      return context;
    } catch (error) {
      sample('context-creation-refused', at);
      throw error;
    }
  });
  const open = ResourceNativeClient.openRam;
  vi.spyOn(ResourceNativeClient, 'openRam').mockImplementation(async (...args) => {
    const at = performance.now();
    events.push({
      kind: 'native-open-entry',
      phase,
      atMs: at - started,
      durationMs: 0,
      remainingMs: args[2].expiresAtEpochMs - Date.now(),
    });
    try {
      return await open.apply(ResourceNativeClient, args);
    } finally {
      sample('native-open-inclusive', at);
    }
  });
  const effect = ResourceNativeClient.prototype.employeeRecovery;
  vi.spyOn(ResourceNativeClient.prototype, 'employeeRecovery').mockImplementation(async function (
    this: ResourceNativeClient,
    ...args
  ) {
    const at = performance.now();
    try {
      return await effect.apply(this, args);
    } finally {
      sample('effect-Q-inclusive', at);
    }
  });
  const observe = ResourceNativeClient.prototype.observeEmployeeRecoveryOriginal;
  vi.spyOn(ResourceNativeClient.prototype, 'observeEmployeeRecoveryOriginal').mockImplementation(async function (
    this: ResourceNativeClient,
    ...args
  ) {
    const at = performance.now();
    try {
      return await observe.apply(this, args);
    } finally {
      sample('observe-Q-inclusive', at);
    }
  });
  return {
    phase: (value: string) => {
      phase = value;
      sample('request-phase-entry', performance.now());
    },
    sample,
    site,
    mark: (kind: string, status?: number) => sample(kind, performance.now(), { status }),
    save: () => {
      const directory = process.env.TEST_RECOVERY_VERIFIER_COST_DIR;
      if (!directory) return;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const totals: Record<string, { calls: number; inclusiveMs: number }> = {};
      for (const event of events) {
        const key = event.phase + ':' + event.kind;
        const row = (totals[key] ??= { calls: 0, inclusiveMs: 0 });
        row.calls++;
        row.inclusiveMs += event.durationMs;
      }
      fs.writeFileSync(
        join(directory, 'verifier-cost-' + mode + '.json'),
        JSON.stringify(
          {
            purpose: 'PRIVATE TEST DIAGNOSTIC; controlled native physical port only',
            wallStartedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
            elapsedMs: performance.now() - started,
            notes:
              'Durations are inclusive/nested and must not be summed across verifier layers. Native Q durations include application owner challenges; no physical native effect time is claimed.',
            totals,
            events,
          },
          null,
          2
        )
      );
    },
  };
}
it.each(['enforce', 'basic', 'multiuser'] as const)(
  'settles only the actual source parent observe under %s while its own target becomes stopped',
  async (mode) => {
    const costs = recoveryVerifierCosts(mode);
    try {
      const f = await actualSource(mode, true);
      const failures: Array<{ stage: string; remaining: number; message: string; cause?: string }> = [];
      let authChecks = 0;
      const originalAuth = ResourceOwnerAuthority.prototype.assertRecoveryAuthentication;
      vi.spyOn(ResourceOwnerAuthority.prototype, 'assertRecoveryAuthentication').mockImplementation(function (
        this: ResourceOwnerAuthority,
        ...args
      ) {
        authChecks++;
        const at = performance.now(),
          origin = costs.site();
        try {
          return originalAuth.apply(this, args);
        } catch (error) {
          failures.push({
            stage: args[0].stage,
            remaining: args[0].expiresAtEpochMs - Date.now(),
            message: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
          });
          throw error;
        } finally {
          costs.sample('full-recovery-auth-inclusive', at, {
            site: origin,
            remainingMs: args[0].expiresAtEpochMs - Date.now(),
          });
        }
      });
      costs.phase('effect');
      const effect = await f.send();
      costs.mark('effect-response', effect.statusCode);
      expect(effect.statusCode, effect.body).toBe(200);
      authChecks = 0;
      costs.phase('observe');
      const begun = Date.now(),
        complete = await f.observe(),
        observedAttempts = 1;
      expect(
        complete.statusCode,
        JSON.stringify({
          body: complete.body,
          elapsed: Date.now() - begun,
          authChecks,
          failures,
          application: store.snapshot().employeeRecoveryOperations?.[0]?.application,
        })
      ).toBe(200);
      costs.mark('observe-response', complete.statusCode);
      // At most16 full verifier calls per phase covers native admission/response
      // and each of3 acknowledged writer phases, including their commit/release
      // fences. This is an upper budget, not an exact implementation call count.
      expect(authChecks).toBeLessThanOrEqual((1 + 3) * 16);
      expect(complete.json().data.application).toEqual({
        state: 'completed-stopped',
        intentRetirement: 'not-applicable',
      });
      expect(store.snapshot().employees.find((row) => row.id === eid)!.desiredRunning).toBe(false);
      expect(store.snapshot().employees.find((row) => row.id === sourceId)!.desiredRunning).toBe(true);
      expect(services.source.binding(eid)).toBeUndefined();
      expect(services.source.retainedBinding(eid)).toMatchObject({
        employeeId: eid,
        sessionId: sid,
        sessionGeneration: 1,
      });
      expect(store.snapshot().employeeRecoveryOperations![0]!.application?.state).toBe('completed-stopped');
      costs.phase('repeat-observe');
      expect((await f.observe()).statusCode).toBe(200);
      expect(f.qMessages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
        'employee-recovery',
        ...Array(observedAttempts + 1).fill('employee-recovery-observe'),
      ]);
      costs.phase('effect-after-stop-denied');
      expect((await f.send()).statusCode).toBe(403);
      await store.update((state) => {
        state.employees.find((row) => row.id === sourceId)!.permissions.recoverEmployees = false;
      });
      costs.phase('source-revoked-observe');
      expect((await f.observe()).statusCode).toBe(403);
      expect(f.qMessages.filter((row) => row.kind === 'resource-operation')).toHaveLength(observedAttempts + 2);
    } finally {
      costs.save();
    }
  }
);

it('allows a currently permitted delegated observer after a human effect without reviving the revoked human actor', async () => {
  const f = await actualSource('enforce', true, ['human-owner', 'delegated-service']);
  const login = await owner.login('fixture-primary', 'Synthetic-recovery-fixture-42!', '127.0.0.1');
  expect(login.session).toBeDefined();
  const human = () =>
    f.app.inject({
      method: 'POST',
      url: '/api/company/employees/' + eid + '/recovery',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + login.session },
      payload: { approval },
    });
  const effect = await human();
  expect(effect.statusCode, effect.body).toBe(200);
  owner.logout(login.session!);
  expect((await human()).statusCode).toBe(401);
  expect(f.qMessages.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
  const complete = await f.observe();
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json().data.application.state).toBe('completed-stopped');
  expect(store.snapshot().employees.find((row) => row.id === eid)!.desiredRunning).toBe(false);
  expect(store.snapshot().employees.find((row) => row.id === sourceId)!.desiredRunning).toBe(true);
  await store.update((state) => {
    state.serviceGrants = state.serviceGrants.filter((row) => row.id !== 'recovery-observe');
  });
  expect((await f.observe()).statusCode).toBe(403);
  expect(f.qMessages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
});
it('allows a fresh human observer in a different Node process after a delegated effect and revoked original grant', async () => {
  const f = await actualSource('enforce', true, ['delegated-service', 'human-owner']);
  const effect = await f.send();
  expect(effect.statusCode, effect.body).toBe(200);
  await store.update((state) => {
    state.serviceGrants = state.serviceGrants.filter((row) => row.id !== 'recovery-grant');
  });
  expect((await f.send()).statusCode).toBe(403);
  expect(f.qMessages.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
  await f.prepareColdObservation();
  const child = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/employee-recovery-restart.mts', import.meta.url)),
      directory,
      eid,
      sid,
      JSON.stringify(approval),
      'office-source',
    ],
    { timeout: 15000, maxBuffer: 64 * 1024, cwd: fileURLToPath(new URL('..', import.meta.url)) }
  ).catch((error: Error & { stdout?: string; stderr?: string }) => {
    console.error('Actual cross-principal restart child output:', error.stdout, error.stderr);
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
  const canonical = new CompanyStore(store.file);
  await canonical.init();
  expect(canonical.snapshot().employees.find((row) => row.id === eid)!.desiredRunning).toBe(false);
  expect(canonical.snapshot().employees.find((row) => row.id === sourceId)!.desiredRunning).toBe(true);
  expect(f.qMessages.filter((row) => row.kind === 'resource-operation').map((row) => row.verb)).toEqual([
    'employee-recovery',
    'employee-recovery-observe',
  ]);
});

it('accepts bounded observational recovery diagnostics without changing the action or original binding', () => {
  const value = {
    version: 1,
    purpose: 'employee-recovery-v1',
    employeeId: approval.sessionId,
    approval,
    outcome: 'unconfirmed',
    newDispatch: 'attempted',
    earlierEffects: 'unproved',
    diagnostics: { primaryCode: 'WORKER_RECOVERY_PROVIDER_UNCONFIRMED', secondaryCode: 'WORKER_REPORT_CLOSE_UNKNOWN' },
  };
  expect(parseEmployeeRecoveryResult(value, value.employeeId, approval)).toEqual(value);
  expect(
    EmployeeRecoveryResult.safeParse({ ...value, diagnostics: { primaryCode: null, secondaryCode: null } }).success
  ).toBe(false);
  expect(() => parseEmployeeRecoveryResult(value, randomUUID(), approval)).toThrow();
});

it.each([
  null,
  {},
  { primaryCode: null },
  { primaryCode: 'x', secondaryCode: null },
  { primaryCode: 'A'.repeat(97), secondaryCode: null },
  { primaryCode: '<img src=x onerror=alert(1)>', secondaryCode: null },
  { primaryCode: 'WORKER_ERROR', secondaryCode: 1 },
  { primaryCode: null, secondaryCode: null, permission: 'recover' },
])('refuses malformed recovery diagnostic data: %j', (diagnostics) => {
  const value = {
    version: 1,
    purpose: 'employee-recovery-v1',
    employeeId: approval.sessionId,
    approval,
    outcome: 'unconfirmed',
    newDispatch: 'attempted',
    earlierEffects: 'unproved',
    diagnostics,
  };
  expect(EmployeeRecoveryResult.safeParse(value).success).toBe(false);
});

it('normalizes a valid expected approval key order without weakening its strict original binding', () => {
  const value = {
    version: 1,
    purpose: 'employee-recovery-v1',
    employeeId: approval.sessionId,
    approval,
    outcome: 'unconfirmed',
    newDispatch: 'attempted',
    earlierEffects: 'unproved',
  };
  const reversed = Object.fromEntries(Object.entries(approval).reverse()) as typeof approval;
  const sorted = Object.fromEntries(
    Object.entries(approval).sort(([left], [right]) => left.localeCompare(right))
  ) as typeof approval;
  for (const original of [reversed, sorted]) {
    expect(parseEmployeeRecoveryResult(value, value.employeeId, original)).toEqual(value);
    expect(() =>
      parseEmployeeRecoveryResult(value, value.employeeId, { ...original, operationId: randomUUID() })
    ).toThrow();
  }
  expect(() => parseEmployeeRecoveryResult(value, value.employeeId, { ...reversed, extra: true } as never)).toThrow();
  const { action: _action, ...missing } = reversed;
  expect(() => parseEmployeeRecoveryResult(value, value.employeeId, missing as never)).toThrow();
  expect(() =>
    parseEmployeeRecoveryResult(value, value.employeeId, { ...reversed, sessionGeneration: '01' })
  ).toThrow();
});
