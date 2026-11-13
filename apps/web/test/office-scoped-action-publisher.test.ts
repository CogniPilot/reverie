/** Real source HMAC/configured issuer/canonical grant/nonce owners; no native or provider effect. */
import * as fs from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema } from '../src/company-types.js';
import { EmployeeRecoveryApproval } from '../src/employee-recovery-operation.js';
import { OfficeScopedActionPublisher, type OfficeScopedAction } from '../src/office-scoped-action-publisher.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { loadServiceAuthConfig } from '../src/service-auth-config.js';
import { createServiceAuthorization } from '../src/service-authorization.js';
import { ServiceGrantAuthentication, signServiceAssertion } from '../src/service-grant-auth.js';
import { RECOVERY_HEADER, WorkerRecoveryAuthentication } from '../src/worker-recovery-auth.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { WebServer } from '../src/web/server.js';
import {
  MuxMetadataReconciliationService,
  registerMuxMetadataReconciliation,
  isMuxMetadataTransport,
} from '../src/mux-metadata-reconciliation.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { relations } from '../src/owner-auth/relations.js';
import { registerAuthMiddleware, registerHostGuard } from '../src/web/middleware/auth.js';
import * as storage from 'node:fs/promises';
import { dataPath } from '../src/config/instance.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const cleanup: Array<() => unknown> = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(storage.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(storage.open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const targetId = '10000000-0000-4000-8000-000000000001';
const targetSid = '10000000-0000-4000-8000-000000000002';
const sourceId = '10000000-0000-4000-8000-000000000003';
const sourceSid = '10000000-0000-4000-8000-000000000004';
const approval = EmployeeRecoveryApproval.parse({
  operationId: randomUUID(),
  parentOperationId: null,
  sessionId: targetSid,
  sessionGeneration: '1',
  originalAttemptId: null,
  action: 'stop-provider',
});
async function fixture(
  profile: 'recovery' | 'metadata' = 'recovery',
  integration: false | 'basic' | 'multiuser' = false,
  foreignSource = false
) {
  const purpose = profile === 'metadata' ? 'OPS_METADATA' : 'OPS_STOP';
  const manager = integration ? new TmuxManager() : undefined;
  if (manager) cleanup.push(() => manager.destroy());
  const resourceId =
    profile === 'metadata'
      ? (manager?.muxMetadataResourceId() ?? 'mux-metadata:' + 'a'.repeat(64))
      : 'employee-' + targetId;
  const directory = fs.mkdtempSync(join(tmpdir(), 'office-action-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o700);
  const write = (name: string, data: unknown, mode = 0o600) =>
    fs.writeFileSync(join(directory, name), Buffer.isBuffer(data) ? data : JSON.stringify(data), { mode });
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  await store.update((state) => {
    for (const [id, sessionId] of [
      [targetId, targetSid],
      [sourceId, sourceSid],
    ])
      state.employees.push(
        EmployeeSchema.parse({
          id,
          sessionId,
          sessionGeneration: 1,
          desiredRunning: true,
          name: id,
          position: 'Fixture',
          icon: 'F',
          expertise: ['tests'],
          permissions: { recoverEmployees: id === sourceId },
          createdAt: 1,
        })
      );
    state.serviceGrants.push({
      id: 'fixture-grant',
      purpose,
      principal: 'fixture-service',
      epoch: 'epoch1',
      employees: [{ employeeId: targetId, sessionId: targetSid, sessionGeneration: 1 }],
      resources: [resourceId],
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
    });
  });
  const owner = new OfficeAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit'),
    setupEnabled: true,
  });
  await owner.setup('sampleowner', 'Synthetic-recovery-fixture-42!', 'Synthetic-recovery-fixture-42!', '127.0.0.1');
  const key = randomBytes(32),
    sourceKey = randomBytes(32),
    nonceId = randomUUID();
  write('key', key, 0o400);
  write('config.json', {
    version: 1,
    serviceUid: process.geteuid!(),
    purposes: {
      [purpose]: {
        scope: 'employees+resources',
        action: profile === 'metadata' ? 'reverie.ops.mux-metadata.reconcile' : 'reverie.ops.employee.stop-provider',
      },
    },
    principals: [
      { principal: 'fixture-service', epoch: 'epoch1', key: join(directory, 'key'), officeEmployeeId: sourceId },
    ],
  });
  fs.mkdirSync(join(directory, 'nonces'), { mode: 0o700 });
  const file = join(directory, 'nonces', 'ledger.json'),
    flock = fs.realpathSync(
      (process.env.PATH ?? '')
        .split(':')
        .map((part) => join(part, 'flock'))
        .find((path) => fs.existsSync(path))!
    );
  write('nonces/ledger.json', {
    version: 1,
    storeId: nonceId,
    capacity: 64,
    revision: 0,
    clockFloor: Date.now() - 1000,
    entries: [],
  });
  fs.writeFileSync(file + '.lock', '', { mode: 0o600 });
  const services = createServiceAuthorization(loadServiceAuthConfig(join(directory, 'config.json')), {
    company: { store },
    custody: {
      assertPrivateCustody(path) {
        if (path !== store.file) throw Error('Wrong store');
      },
    },
    nonce: {
      file,
      storeId: nonceId,
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
  const grantLease = await services.auth.authenticate(
    {
      assertion: signServiceAssertion(key, {
        purpose,
        principal: 'fixture-service',
        epoch: 'epoch1',
        ownerId: '',
        grantId: 'fixture-grant',
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 9000,
        nonce: randomBytes(16).toString('hex'),
      }),
    },
    purpose
  );
  expect(grantLease).not.toBeNull();
  const grantRef = { grantId: grantLease!.grantId, policyGeneration: grantLease!.generation };
  write('worker-recovery-auth.json', {
    version: 1,
    issuer: 'fixture-source',
    epoch: 'source1',
    key: sourceKey.toString('hex'),
    storeId: nonceId,
  });
  write('recovery-nonces.json', {
    version: 1,
    storeId: nonceId,
    capacity: 4096,
    revision: 0,
    clockFloor: Date.now() - 1000,
    entries: [],
  });
  fs.writeFileSync(join(directory, 'recovery-nonces.json.lock'), '', { mode: 0o600 });
  const signedSourceSid = foreignSource ? randomUUID() : sourceSid;
  const sourceStore = foreignSource ? new CompanyStore(join(directory, 'foreign-company.json')) : store;
  if (foreignSource) {
    await sourceStore.init();
    await sourceStore.update((state) => {
      state.employees = [
        { ...store.snapshot().employees.find((employee) => employee.id === sourceId)!, sessionId: signedSourceSid },
      ];
    });
  }
  const source = new WorkerRecoveryAuthentication(directory, () => sourceStore.snapshot().employees, flock);
  const publisher = new OfficeScopedActionPublisher(services, source, owner);
  cleanup.push(() => publisher.close());
  const app = Fastify();
  cleanup.push(() => app.close());
  await app.register(cookie);
  source.register(app);
  let proof: OfficeScopedAction | undefined;
  const target =
    profile === 'metadata' ? '/api/mux/metadata/reconcile' : '/api/company/employees/' + targetId + '/recovery';
  let writerId: string = randomUUID(),
    expectedIncidentId: string = randomUUID();
  if (manager) {
    vi.stubEnv('REVERIE_PASSWORD', 'Synthetic-basic-auth-42!');
    vi.stubEnv('REVERIE_MULTIUSER', integration === 'multiuser' ? '1' : '0');
    const auth = registerAuthMiddleware(app, false, '', owner);
    registerHostGuard(app, () => ({ bindHost: '127.0.0.1', allowedHosts: [] }));
    cleanup.push(() => {
      for (const value of Object.values(auth)) value?.dispose();
    });
    // Genuine inferred ports from an owned unstarted server: no listener,
    // restoration, provider launch or invented SessionPort capability.
    const fixtureServer = new WebServer(0, false, true);
    cleanup.push(() => fixtureServer.stop());
    const ctx = fixtureServer['createRouteContext']();
    const sessions = fixtureServer['sessions'];
    for (const id of [sourceSid, targetSid])
      sessions.set(id, new Session({ id, mode: 'shell', workingDir: directory, useMux: false }));
    const rooms = new ChatroomStore();
    registerOwnerPolicy(app, {
      service: owner,
      ctx,
      isCapabilityRequest: (req) => isMuxMetadataTransport(req),
      relations: relations({
        recordedParent: (id) => sessions.get(id)?.parentSessionId,
        known: (id) => sessions.has(id),
        rooms: () => [],
        predecessor: () => undefined,
        employeeOf: (id) => store.employeeForSession(id, undefined)?.id,
        keepers: () => owner.keepers(),
        admins: () => owner.admins(),
      }),
    });
    expect(owner.policy()).toBe('enforce');
    const deny = () => {
      throw Error('Metadata fixture forbids research/provider effects');
    };
    const company = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sid, options) => rooms.addMember(id, sid, options).member,
        setStatus: (id, sid, status) => rooms.setStatus(id, sid, status),
      },
      research: { start: deny, inspect: deny, stop: deny },
    });
    const service = new MuxMetadataReconciliationService(
      manager,
      company,
      ownerVerifier({ service: owner, ctx }),
      publisher
    );
    cleanup.push(() => service.close());
    registerMuxMetadataReconciliation(app, service);
    manager.registerSession({
      sessionId: targetSid,
      muxName: 'synthetic-metadata',
      pid: 999_999_997,
      workingDir: directory,
      mode: 'shell',
      attached: false,
      createdAt: 1,
    });
    const originalStorage = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let faulted = false;
    vi.mocked(storage.rename).mockImplementation(async (...args) => {
      await originalStorage.rename(...args);
      if (args[1] === dataPath('mux-sessions.json')) {
        faulted = true;
        throw Error('Synthetic original metadata rename answer lost');
      }
    });
    try {
      await expect(manager.publishCurrentSessionMetadata()).rejects.toThrow('Mux metadata publication is unconfirmed');
    } finally {
      vi.mocked(storage.rename).mockImplementation(originalStorage.rename);
    }
    expect(faulted).toBe(true);
    expect(JSON.parse(await originalStorage.readFile(dataPath('mux-sessions.json'), 'utf8'))[0].sessionId).toBe(
      targetSid
    );
    const status = manager.getMuxMetadataPublicationStatus();
    if (status.kind !== 'unconfirmed') throw Error('Expected original metadata incident');
    writerId = status.writerId;
    expectedIncidentId = status.incidentId;
  } else
    app.post(target, async (request, reply) => {
      try {
        const selection =
          profile === 'metadata'
            ? { kind: 'mux-metadata-reconcile' as const, employeeId: targetId, resourceId, grantRef }
            : {
                kind: 'employee-recovery' as const,
                employeeId: targetId,
                access: 'effect' as const,
                approval,
                grantRef,
              };
        const original = publisher.capture(request, selection);
        expect(publisher.capture(request, selection)).toBe(original);
        proof = await original;
        publisher.assertOriginal(proof, store);
        return { success: true };
      } catch {
        return reply.code(403).send({ success: false });
      }
    });
  const send = (headers: Record<string, string> = {}) => {
    const body = JSON.stringify(
        profile === 'metadata'
          ? { writerId, expectedIncidentId, employeeId: targetId, grantRef }
          : { approval, grantRef }
      ),
      now = Date.now();
    const fields = [
      1,
      'worker-recovery-request',
      'fixture-source',
      'source1',
      signedSourceSid,
      1,
      'POST',
      target,
      createHash('sha256').update(body).digest('hex'),
      now - 1,
      now + 9000,
      randomBytes(16).toString('hex'),
    ];
    const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
    const assertion =
      encoded +
      '.' +
      createHmac('sha256', sourceKey)
        .update('reverie-worker-recovery-request-v1\n' + encoded)
        .digest('hex');
    return app.inject({
      method: 'POST',
      url: target,
      payload: body,
      headers: { 'content-type': 'application/json', [RECOVERY_HEADER]: assertion, ...headers },
    });
  };
  const replaceKey = (bytes: Buffer) => {
    fs.unlinkSync(join(directory, 'key'));
    write('key', bytes, 0o400);
  };
  return {
    directory,
    owner,
    store,
    services,
    publisher,
    send,
    proof: () => {
      if (!proof) throw Error('No proof');
      return proof;
    },
    write,
    key,
    replaceKey,
    manager,
    app,
    grantRef,
    serviceNonceState: () => fs.readFileSync(file, 'utf8'),
    sourceNonceState: () => fs.readFileSync(join(directory, 'recovery-nonces.json'), 'utf8'),
  };
}

it('publishes one original private source/config/grant proof and rejects a different canonical domain', async () => {
  const f = await fixture();
  expect((await f.send()).statusCode).toBe(200);
  const proof = f.proof();
  expect(proof.action).toBe('reverie.ops.employee.stop-provider');
  expect(proof.source).toEqual({ employeeId: sourceId, sessionId: sourceSid, sessionGeneration: '1' });
  expect(() => JSON.stringify(proof)).toThrow('server-private');
  expect(() => f.publisher.assertOriginal({ ...proof }, f.store)).toThrow('unavailable');
  const other = new CompanyStore(join(tmpdir(), 'unused-' + randomUUID()));
  expect(() => proof.assertDomain(other)).toThrow('Configured service authorization');
  proof.assertCurrent();
});

it.each(['grant', 'source', 'key'] as const)(
  'latches observed %s revocation without resurrecting the original proof',
  async (kind) => {
    const f = await fixture();
    expect((await f.send()).statusCode).toBe(200);
    const original = f.store.snapshot();
    if (kind === 'grant')
      await f.store.update((state) => {
        state.serviceGrants = [];
      });
    if (kind === 'source')
      await f.store.update((state) => {
        state.employees.find((e) => e.id === sourceId)!.sessionGeneration++;
      });
    if (kind === 'key') f.replaceKey(randomBytes(32));
    expect(() => f.proof().assertCurrent()).toThrow();
    await f.store.update((state) => {
      state.serviceGrants = original.serviceGrants;
      state.employees = original.employees;
    });
    if (kind === 'key') f.replaceKey(f.key);
    expect(() => f.proof().assertCurrent()).toThrow();
  }
);

it.each(['recovery', 'metadata'] as const)(
  'refuses revoked canonical authority after the actual %s nonce authentication awaits',
  async (profile) => {
    const f = await fixture(profile);
    let entered!: () => void, release!: () => void;
    const parked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdActualLease = async <T>(lease: T): Promise<T> => {
      entered();
      await gate;
      return lease;
    };
    if (profile === 'metadata') {
      const authenticate = ServiceGrantAuthentication.prototype.authenticate;
      vi.spyOn(ServiceGrantAuthentication.prototype, 'authenticate').mockImplementation(async function (
        this: ServiceGrantAuthentication,
        ...args
      ) {
        return holdActualLease(await authenticate.apply(this, args));
      });
    } else {
      const authenticate = ServiceGrantAuthentication.prototype.authenticateRecovery;
      vi.spyOn(ServiceGrantAuthentication.prototype, 'authenticateRecovery').mockImplementation(async function (
        this: ServiceGrantAuthentication,
        ...args
      ) {
        return holdActualLease(await authenticate.apply(this, args));
      });
    }
    const response = Promise.resolve(f.send());
    try {
      await Promise.race([
        parked,
        response.then(() => {
          throw Error('Original grant verifier did not reach its owned authentication await');
        }),
      ]);
      await f.store.update((state) => {
        state.serviceGrants = [];
      });
    } finally {
      release();
    }
    expect((await response).statusCode).toBe(403);
  }
);

it('refuses claimed service/parent identities instead of converting them into an Office source', async () => {
  const f = await fixture();
  expect((await f.send({ authorization: 'Basic ignored' })).statusCode).toBe(403);
  expect((await f.send({ 'x-reverie-parent-session': sourceSid })).statusCode).toBe(403);
});

it('publishes metadata only with its separately configured action and exact instance resource grant', async () => {
  const f = await fixture('metadata');
  expect((await f.send()).statusCode).toBe(200);
  expect(f.proof().action).toBe('reverie.ops.mux-metadata.reconcile');
  expect(f.proof().resourceId).toBe('mux-metadata:' + 'a'.repeat(64));
  await f.store.update((state) => {
    state.serviceGrants[0]!.resources = ['employee-' + targetId];
  });
  expect(() => f.proof().assertCurrent()).toThrow();
  const current = await f.services.auth.authenticate(
    {
      assertion: signServiceAssertion(f.key, {
        purpose: 'OPS_METADATA',
        principal: 'fixture-service',
        epoch: 'epoch1',
        ownerId: '',
        grantId: 'fixture-grant',
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 9000,
        nonce: randomBytes(16).toString('hex'),
      }),
    },
    'OPS_METADATA'
  );
  expect(current).not.toBeNull();
  f.grantRef.policyGeneration = current!.generation; // Current generation; the missing file resource is the refusal.
  expect((await f.send()).statusCode).toBe(403); // A native employee grant cannot substitute for the metadata file grant.
});

it.each(['basic', 'multiuser'] as const)(
  'joins actual %s and enforced owner-policy layers to the configured metadata handler without an owner cookie',
  async (mode) => {
    const f = await fixture('metadata', mode);
    const original = f.manager?.getMuxMetadataPublicationStatus();
    expect((await f.send({ [RECOVERY_HEADER]: 'invalid' })).statusCode).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/mux/metadata/reconcile/neighbor',
          headers: { [RECOVERY_HEADER]: 'invalid' },
          payload: {},
        })
      ).statusCode
    ).toBe(401);
    expect(f.manager?.getMuxMetadataPublicationStatus()).toEqual(original);
    expect((await f.send()).statusCode).toBe(200);
    expect(f.manager?.getMuxMetadataPublicationStatus().kind).toBe('reconciled');
    expect(f.store.snapshot().employees.every((employee) => employee.sessionGeneration === 1)).toBe(true);
  }
);

it('rechecks actual recovery permission after metadata file sync before publishing the repair', async () => {
  const f = await fixture('metadata', 'basic');
  const before = await storage.readFile(dataPath('mux-sessions.json'), 'utf8');
  const original = f.manager?.getMuxMetadataPublicationStatus();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let revoked = false;
  vi.mocked(storage.open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (
      !revoked &&
      typeof args[0] === 'string' &&
      args[0].startsWith(dataPath('mux-sessions.json') + '.') &&
      args[1] === 'wx'
    ) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
        await sync();
        await f.store.update((state) => {
          state.employees.find((employee) => employee.id === sourceId)!.permissions.recoverEmployees = false;
        });
        revoked = true;
      });
    }
    return file;
  });
  expect((await f.send()).statusCode).toBe(409);
  expect(revoked).toBe(true);
  expect(f.manager?.getMuxMetadataPublicationStatus()).toEqual(original);
  expect(await storage.readFile(dataPath('mux-sessions.json'), 'utf8')).toBe(before);
});

it('refuses a delegated subset repair when the original global manager includes another owner', async () => {
  const f = await fixture('metadata', 'basic');
  const before = await storage.readFile(dataPath('mux-sessions.json'), 'utf8');
  const original = f.manager!.getMuxMetadataPublicationStatus();
  f.manager!.registerSession({
    sessionId: randomUUID(),
    owner: 'another-account',
    muxName: 'synthetic-foreign',
    pid: 999_999_996,
    createdAt: 1,
    workingDir: '/synthetic',
    mode: 'shell',
    attached: false,
  });
  expect((await f.send()).statusCode).toBe(403);
  expect(f.manager!.getMuxMetadataPublicationStatus()).toEqual(original);
  expect(await storage.readFile(dataPath('mux-sessions.json'), 'utf8')).toBe(before);
});

it('refuses ambiguous canonical source identity even when the signed original source SID still matches', async () => {
  const f = await fixture('metadata');
  await f.store.update((state) => {
    state.employees.push({ ...state.employees.find((employee) => employee.id === sourceId)!, sessionId: randomUUID() });
  });
  const nonceBefore = f.serviceNonceState();
  const sourceNonceBefore = f.sourceNonceState();
  expect((await f.send()).statusCode).toBe(403);
  expect(f.serviceNonceState()).toBe(nonceBefore);
  expect(f.sourceNonceState()).toBe(sourceNonceBefore);
  expect(() => f.proof()).toThrow('No proof');
});

it('joins a genuine source verifier back to the same original canonical service domain', async () => {
  const f = await fixture('metadata', false, true);
  const before = f.serviceNonceState();
  expect((await f.send()).statusCode).toBe(403);
  expect(f.serviceNonceState()).toBe(before);
  expect(() => f.proof()).toThrow('No proof');
});
it.each(['grant', 'service-nonce', 'source-config'] as const)(
  'refuses actual %s drift between the outer Source checks and latches that original proof',
  async (kind) => {
    const f = await fixture();
    expect((await f.send()).statusCode).toBe(200);
    const companyBefore = fs.readFileSync(f.store.file, 'utf8');
    const nonceBefore = f.serviceNonceState(),
      sourceBefore = fs.readFileSync(join(f.directory, 'worker-recovery-auth.json'), 'utf8');
    const registered = f.owner.registeredResourceOwner.bind(f.owner);
    let injected = false;
    const gap = vi.spyOn(f.owner, 'registeredResourceOwner').mockImplementation((...args) => {
      const actual = registered(...args);
      if (!injected) {
        injected = true;
        if (kind === 'grant') {
          const state = f.store.snapshot();
          state.serviceGrants = [];
          fs.writeFileSync(f.store.file, JSON.stringify(state), { mode: 0o600 });
        } else if (kind === 'service-nonce') {
          const state = JSON.parse(nonceBefore);
          state.entries = [];
          state.revision++;
          f.write('nonces/ledger.json', state);
        } else {
          const config = JSON.parse(sourceBefore);
          config.epoch = 'source2';
          f.write('worker-recovery-auth.json', config);
        }
      }
      return actual;
    });
    expect(() => f.proof().assertCurrent()).toThrow();
    expect(injected).toBe(true);
    gap.mockRestore();
    fs.writeFileSync(f.store.file, companyBefore, { mode: 0o600 });
    fs.writeFileSync(join(f.directory, 'nonces/ledger.json'), nonceBefore, { mode: 0o600 });
    fs.writeFileSync(join(f.directory, 'worker-recovery-auth.json'), sourceBefore, { mode: 0o600 });
    expect(() => f.proof().assertCurrent()).toThrow();
  }
);
