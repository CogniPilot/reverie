/** Isolated real private-file ownership; native/wake calls are counted fixtures. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { FleetResourcesService, registerFleetResourceRoutes } from '../src/resource-fleet-service.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { CompanyStore } from '../src/company-store.js';
import * as companyFiles from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { FleetNativeService, type FleetEmployeeRecovery } from '../src/resource-fleet-native-service.js';
import { FleetNativeClient, NativeFleetMigrationFailureError } from '../src/resource-fleet-native-client.js';
import { FleetOperationStore } from '../src/resource-fleet-operation-store.js';
import { FleetOperationData, advanceFleetOperation, fleetOperationFailure } from '../src/resource-fleet-operation.js';
import { FleetRecoveryHistory } from '../src/resource-fleet-recovery.js';
import type { NativeFleetPreview, NativeFleetMigration } from '../src/resource-fleet-native-data.js';
import type { ProviderHealth } from '../src/types/provider-health.js';

let directory: string, file: string, auth: OwnerAuthService, token: string, company: CompanyService;
let service: FleetNativeService, recovery: FleetEmployeeRecovery, preview: NativeFleetPreview;
let migrate: ReturnType<typeof vi.fn>, wake: ReturnType<typeof vi.fn>, open: ReturnType<typeof vi.spyOn>;
const request = (body: unknown): FastifyRequest =>
  ({
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost' },
    cookies: { reverie_owner: token },
    body,
  }) as unknown as FastifyRequest;
const rows = async () => JSON.parse(await readFile(file, 'utf8'));
const apply = () =>
  service.apply(
    request({
      previewId: preview.approval.previewId,
      expectedRevision: preview.approval.revisionDigest,
      consent: true,
      verb: 'migrate-pool',
    })
  );
const result = () => service.result(request({ operationId: preview.approval.operationId }));
const nextPreview = () => {
  preview = {
    ...preview,
    expiresAtEpochMs: Date.now() + 60_000,
    approval: { ...preview.approval, operationId: randomUUID(), previewId: randomUUID() },
  };
};
const restart = () => {
  service.close();
  service = new FleetNativeService(
    company,
    auth,
    '/unused-native-fixture',
    recovery,
    undefined,
    new FleetOperationStore(file)
  );
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fleet-operation-'));
  file = join(directory, 'operations.json');
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  token = await auth.setup('FixtureOwner', 'synthetic-Operation!7', 'synthetic-Operation!7', '127.0.0.1');
  const sessions = new Map([randomUUID(), randomUUID()].map((id) => [id, { id, name: id }]));
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  company = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), setStatus: vi.fn() },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  for (const sessionId of sessions.keys())
    await company.hire({
      name: sessionId,
      icon: 'F',
      position: 'Fixture',
      expertise: ['testing'],
      sessionId,
      researchEnabled: false,
    });
  await store.update((state) => {
    for (const employee of state.employees) {
      employee.desiredRunning = true;
      employee.onVacation = false;
    }
  });
  const employees = company.view().employees;
  const policy = {
    version: 1 as const,
    purpose: 'reverie-docker-worker-pool-v1' as const,
    deployment: 'fixture',
    instanceRoot: directory,
    engineId: randomUUID(),
    anchorImage: 'sha256:' + 'a'.repeat(64),
    controllerImage: 'sha256:' + 'b'.repeat(64),
    websiteContainer: 'c'.repeat(64),
    brokerUid: 1000,
    brokerGid: 100,
    memoryMaxMiB: 49152 as const,
    poolTasksMax: 4096,
    cpuWeight: 100,
    allowedCpus: [0],
    employeeMemoryHighMiB: Object.fromEntries(employees.map((employee) => [employee.id, 8192])),
  };
  preview = {
    kind: 'fleet-preview',
    purpose: 'resource-fleet-maintenance-v1',
    version: 1,
    requestId: randomUUID(),
    approval: {
      operationId: randomUUID(),
      previewId: randomUUID(),
      cohortDigest: 'd'.repeat(64),
      poolPolicyDigest: 'e'.repeat(64),
      coverageDigest: 'f'.repeat(64),
      revisionDigest: '1'.repeat(64),
    },
    policy,
    status: 'awaiting-maintenance-consent',
    expiresAtEpochMs: Date.now() + 60_000,
  };
  const native = (): NativeFleetMigration =>
    ({
      ...preview,
      kind: 'fleet-migration-result',
      phase: 'pool-configured',
      configurationDigest: '2'.repeat(64),
      domainDigest: '3'.repeat(64),
      restore: employees.map((employee) => ({ employeeId: employee.id, sessionId: employee.sessionId })),
      // The closed migration codec deliberately has no preview-only fields.
      ...{ status: undefined, expiresAtEpochMs: undefined },
    }) as unknown as NativeFleetMigration;
  migrate = vi.fn(async () => {
    expect((await rows())[0].phase).toBe('issued');
    const {
      status: _status,
      expiresAtEpochMs: _expiry,
      ...value
    } = native() as NativeFleetMigration & { status?: unknown; expiresAtEpochMs?: unknown };
    return value;
  });
  open = vi.spyOn(FleetNativeClient, 'open').mockImplementation(async (_path, authority, originalRequest) => {
    const viewer = authority.captureFleetViewer(originalRequest);
    preview = { ...preview, requestId: viewer.requestId };
    const current = () => authority.assertContext(viewer);
    return {
      preview: async () => preview,
      ownerBinding: () =>
        Object.freeze({ ownerScopeDigest: viewer.ownerScopeDigest, principal: viewer.principal, owner: viewer.owner }),
      assertSession: (selected: FastifyRequest) => authority.assertFleetSession(selected, viewer),
      assertViewing: (selected: FastifyRequest) => {
        current();
        authority.assertFleetSession(selected, viewer);
      },
      assertOwnerCurrent: current,
      migrate: async (selected: FastifyRequest) => {
        current();
        authority.assertFleetSession(selected, viewer);
        const value = await migrate();
        current();
        return value;
      },
      close: vi.fn(),
    } as unknown as FleetNativeClient;
  });
  wake = vi.fn(async (employeeId: string, options: { stillCurrent(): boolean }) => {
    const record = (await rows())[0];
    expect(record.phase).toBe('restoring');
    expect(record.restore.find((row: { employeeId: string }) => row.employeeId === employeeId).state).toBe('pending');
    expect(options.stillCurrent()).toBe(true);
    return { awakened: [employeeId], skipped: [] };
  });
  recovery = {
    wakeEmployee: wake,
    refreshHealth: async () => {},
    providerHealth: () => ({ state: 'healthy' }) as ProviderHealth,
  };
  service = new FleetNativeService(
    company,
    auth,
    '/unused-native-fixture',
    recovery,
    undefined,
    new FleetOperationStore(file)
  );
});
afterEach(async () => {
  service.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each(['expired', 'disconnected'] as const)(
  'ends an %s never-issued preview and permits a fresh review without native effects',
  async (reason) => {
    await service.preview(request({}));
    const original = (await rows())[0];
    const client = await open.mock.results[0].value;
    if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
    else
      vi.spyOn(client, 'assertViewing').mockImplementation(() => {
        throw new Error('original socket disconnected');
      });
    nextPreview();
    const fresh = await service.preview(request({}));
    expect(fresh.approval.operationId).not.toBe(original.operationId);
    const saved = (await rows())[0];
    expect(saved).toMatchObject({
      version: 2,
      purpose: 'fleet-migration-operation-v2',
      phase: 'not-issued',
      sequence: 1,
      native: null,
      nativeFailure: null,
      restore: [],
      reconciledAsUnconfirmed: null,
      failure: { code: 'PREVIEW_ENDED_BEFORE_ISSUE' },
    });
    expect(saved.preview).toEqual(original.preview);
    expect(saved.originalBindings).toEqual(original.originalBindings);
    expect(await service.result(request({ operationId: original.operationId }))).toMatchObject({
      state: 'not-issued',
      blocksFurtherChanges: false,
    });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(migrate).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  }
);
it('blocks concurrent review and Apply until the never-issued terminal CAS is known', async () => {
  await service.preview(request({}));
  const client = await open.mock.results[0].value;
  vi.spyOn(client, 'assertViewing').mockImplementation(() => {
    throw new Error('preview disconnected');
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = companyFiles.writeCompanyStateFile;
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, text, guard) => {
    if (path === file && JSON.parse(text)[0].phase === 'not-issued') {
      entered();
      await gate;
    }
    await original(path, text, guard);
  });
  nextPreview();
  const fresh = service.preview(request({}));
  await started;
  expect(await service.operationHistory(request({}))).toMatchObject({
    available: true,
    blocksFurtherChanges: true,
    operations: [{ phase: 'prepared', blocksFurtherChanges: true }],
  });
  await expect(service.preview(request({}))).rejects.toThrow('pending or unconfirmed');
  await expect(apply()).rejects.toThrow('recovery is in progress');
  expect(open).toHaveBeenCalledTimes(1);
  release();
  await fresh;
  expect((await rows()).map((row: { phase: string }) => row.phase)).toEqual(['not-issued', 'prepared']);
  expect(open).toHaveBeenCalledTimes(2);
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('records a legacy prepared preview as never issued after restart and permits another review', async () => {
  await service.preview(request({}));
  const original = (await rows())[0];
  expect(original).toMatchObject({ version: 1, phase: 'prepared', sequence: 0 });
  restart();
  nextPreview();
  await service.preview(request({}));
  expect((await rows())[0]).toMatchObject({
    version: 2,
    purpose: 'fleet-migration-operation-v2',
    phase: 'not-issued',
    sequence: 1,
    native: null,
    nativeFailure: null,
    restore: [],
    failure: { code: 'WEB_PROCESS_ENDED_BEFORE_ISSUE' },
  });
  expect((await rows())[1]).toMatchObject({
    version: 1,
    purpose: 'fleet-migration-operation-v1',
    phase: 'prepared',
    sequence: 0,
  });
  expect(open).toHaveBeenCalledTimes(2);
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('reports expired Apply as never issued without consuming native consent', async () => {
  await service.preview(request({}));
  const client = await open.mock.results[0].value;
  vi.spyOn(client, 'assertViewing').mockImplementation(() => {
    throw new Error('preview expired');
  });
  expect(await apply()).toMatchObject({
    state: 'not-issued',
    phase: 'not-issued',
    blocksFurtherChanges: false,
    native: null,
    restore: [],
  });
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('does not claim native preview closure when actual client cleanup reports failure', async () => {
  await service.preview(request({}));
  const client = await open.mock.results[0].value;
  vi.spyOn(client, 'assertViewing').mockImplementation(() => {
    throw new Error('preview disconnected');
  });
  vi.spyOn(client, 'close').mockImplementationOnce(() => {
    throw new Error('preview cleanup unconfirmed');
  });
  await expect(service.preview(request({}))).rejects.toThrow('preview cleanup unconfirmed');
  expect(await result()).toMatchObject({ phase: 'not-issued', native: null, blocksFurtherChanges: false });
  expect(open).toHaveBeenCalledTimes(1);
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('keeps abandonment unavailable if owner authorization is revoked before its durable CAS', async () => {
  await service.preview(request({}));
  const client = await open.mock.results[0].value;
  vi.spyOn(client, 'assertViewing').mockImplementation(() => {
    throw new Error('preview disconnected');
  });
  const original = companyFiles.writeCompanyStateFile;
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, text, guard) => {
    if (path === file && JSON.parse(text)[0].phase === 'not-issued') auth.logout(token);
    await original(path, text, guard);
  });
  await expect(service.preview(request({}))).rejects.toThrow();
  expect((await rows())[0]).toMatchObject({ version: 1, phase: 'prepared', sequence: 0 });
  expect(open).toHaveBeenCalledTimes(1);
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('refuses a competing issued CAS while settling a preview and preserves that uncertain operation after restart', async () => {
  await service.preview(request({}));
  const client = await open.mock.results[0].value;
  vi.spyOn(client, 'assertViewing').mockImplementation(() => {
    throw new Error('preview disconnected');
  });
  const prepared = FleetOperationData.parse((await rows())[0]);
  const original = companyFiles.writeCompanyStateFile;
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, text, guard) => {
    if (path === file && JSON.parse(text)[0].phase === 'not-issued')
      await writeFile(file, JSON.stringify([advanceFleetOperation(prepared, 'issued')]));
    await original(path, text, guard);
  });
  await expect(service.preview(request({}))).rejects.toThrow('changed before commit');
  expect((await rows())[0]).toMatchObject({ version: 1, phase: 'issued', sequence: 1 });
  expect((await service.operationHistory(request({}))).blocksFurtherChanges).toBe(true);
  vi.restoreAllMocks();
  restart();
  expect(await result()).toMatchObject({ phase: 'unknown', blocksFurtherChanges: true });
  await expect(service.preview(request({}))).rejects.toThrow();
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('restricts the new persisted version to one original never-issued terminal transition', async () => {
  await service.preview(request({}));
  const prepared = FleetOperationData.parse((await rows())[0]);
  const ended = advanceFleetOperation(prepared, 'not-issued', {
    failure: fleetOperationFailure('PREVIEW_ENDED_BEFORE_ISSUE'),
  });
  expect(FleetOperationData.parse(ended)).toEqual(ended);
  for (const phase of ['prepared', 'issued', 'native-confirmed', 'restoring', 'completed', 'unknown'])
    expect(FleetOperationData.safeParse({ ...ended, phase }).success).toBe(false);
  expect(() => advanceFleetOperation(ended, 'issued')).toThrow();
  const issued = advanceFleetOperation(prepared, 'issued');
  expect(() =>
    advanceFleetOperation(issued, 'not-issued', { failure: fleetOperationFailure('PREVIEW_ENDED_BEFORE_ISSUE') })
  ).toThrow();
  const unknown = advanceFleetOperation(issued, 'unknown', {
    failure: fleetOperationFailure('NATIVE_OUTCOME_UNCONFIRMED'),
  });
  expect(() =>
    advanceFleetOperation(unknown, 'not-issued', { failure: fleetOperationFailure('PREVIEW_ENDED_BEFORE_ISSUE') })
  ).toThrow();
});
it('keeps issued uncertainty blocked unless fresh authoritative pool absence is recorded', async () => {
  await service.preview(request({}));
  migrate.mockRejectedValueOnce(new Error('lost original native reply'));
  await expect(apply()).rejects.toThrow();
  const { accountId, personId, sessionEpoch } = auth.registrationIdentity(token);
  const evidence = {
    version: 1,
    purpose: 'worker-pool-uninstalled-observation-v1',
    nonce: randomUUID(),
    observedAtEpochMs: Date.now(),
    expiresAtEpochMs: Date.now() + 5000,
    nominationDigest: 'a'.repeat(64),
    configurationDigest: 'b'.repeat(64),
    brokerPid: 2,
    brokerStart: '1',
    brokerProgramDigest: 'c'.repeat(64),
    lifecycleGeneration: '0',
    principal: { accountId, personId, sessionEpoch },
    websiteContainerId: 'd'.repeat(64),
    uninstalled: false,
    oldOperationOutcome: 'unconfirmed',
    startsAuthorized: false,
    activationAuthorized: false,
  };
  evidence.expiresAtEpochMs = evidence.observedAtEpochMs + 5000;
  recovery.observeUninstalledPool = vi.fn(async () => evidence);
  service.close();
  service = new FleetNativeService(
    company,
    auth,
    '/unused-native-fixture',
    recovery,
    new FleetRecoveryHistory(join(directory, 'recovery.json')),
    new FleetOperationStore(file)
  );
  const reconcile = () =>
    service.reconcile(request({ operationId: preview.approval.operationId, preserveUnconfirmedHistory: true }));
  await expect(reconcile()).rejects.toThrow();
  expect(await result()).toMatchObject({ phase: 'unknown', blocksFurtherChanges: true });
  await expect(service.preview(request({}))).rejects.toThrow();
  evidence.uninstalled = true;
  expect(await reconcile()).toMatchObject({
    priorOutcome: 'unconfirmed',
    currentState: 'pool-uninstalled',
    activationAuthorized: false,
    startsAuthorized: false,
  });
  expect(await result()).toMatchObject({ phase: 'unknown', blocksFurtherChanges: false, native: null });
  expect((await rows())[0]).toMatchObject({
    version: 1,
    phase: 'unknown',
    failure: { code: 'NATIVE_OUTCOME_UNCONFIRMED' },
  });
  expect(migrate).toHaveBeenCalledTimes(1);
  expect(wake).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledTimes(1);
});
it('persists native dispatch and each original wake before effect, then reads completion after restart without replay', async () => {
  await service.preview(request({}));
  const answer = await apply();
  expect(answer.phase).toBe('completed');
  expect(wake).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await rows())).not.toContain(token);
  restart();
  expect((await result()).phase).toBe('completed');
  expect(migrate).toHaveBeenCalledTimes(1);
  expect(wake).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledTimes(1);
});
it('keeps a lost native reply unknown across restart and refuses both native and wake replay', async () => {
  await service.preview(request({}));
  migrate.mockRejectedValueOnce(new Error('lost native reply'));
  await expect(apply()).rejects.toThrow('lost native reply');
  expect((await rows())[0]).toMatchObject({ phase: 'unknown', failure: { code: 'NATIVE_OUTCOME_UNCONFIRMED' } });
  restart();
  expect((await result()).blocksFurtherChanges).toBe(true);
  await expect(apply()).rejects.toThrow();
  await expect(service.preview(request({}))).rejects.toThrow();
  expect(migrate).toHaveBeenCalledTimes(1);
  expect(wake).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledTimes(1);
});
it('does not dispatch after an uncertain issued-record publication, including after process restart', async () => {
  await service.preview(request({}));
  const original = companyFiles.writeCompanyStateFile;
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, text, guard) => {
    await original(path, text, guard);
    if (path === file && JSON.parse(text)[0].phase === 'issued') throw new Error('post-rename uncertainty');
  });
  await expect(apply()).rejects.toThrow('post-rename uncertainty');
  expect((await rows())[0].phase).toBe('issued');
  expect(migrate).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  restart();
  expect((await result()).phase).toBe('unknown');
  expect(wake).not.toHaveBeenCalled();
});
it('retains known native result and individual unknown recovery without replaying a failed wake', async () => {
  await service.preview(request({}));
  wake.mockRejectedValueOnce(new Error('lost wake reply'));
  expect((await apply()).phase).toBe('unknown');
  const saved = (await rows())[0];
  expect(saved.native.phase).toBe('pool-configured');
  expect(saved.restore.map((row: { state: string }) => row.state)).toEqual(['unknown', 'wake-confirmed']);
  restart();
  expect((await result()).phase).toBe('unknown');
  expect(wake).toHaveBeenCalledTimes(2);
  expect(migrate).toHaveBeenCalledTimes(1);
});
it('persists revocation as unknown and starts nobody after owner authorization ends', async () => {
  await service.preview(request({}));
  const complete = migrate.getMockImplementation()!;
  migrate.mockImplementationOnce(async () => {
    const value = await complete();
    auth.logout(token);
    return value;
  });
  await expect(apply()).rejects.toThrow();
  expect((await rows())[0].phase).toBe('unknown');
  expect(wake).not.toHaveBeenCalled();
  await expect(result()).rejects.toThrow();
});
it('refuses a different enrolled owner and never treats recorded metadata as migration authority', async () => {
  await service.preview(request({}));
  const original = (await rows())[0];
  service.close();
  const other = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'other', 'owner.json')),
    auditFile: join(directory, 'other', 'audit.jsonl'),
    setupEnabled: true,
  });
  token = await other.setup('OtherOwner', 'synthetic-Other!7', 'synthetic-Other!7', '127.0.0.1');
  service = new FleetNativeService(
    company,
    other,
    '/unused-native-fixture',
    recovery,
    undefined,
    new FleetOperationStore(file)
  );
  await expect(result()).rejects.toThrow('another owner scope');
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
  expect((await service.operationHistory(request({}))).operations).toEqual([]);
  expect((await service.operationHistory(request({}))).blocksFurtherChanges).toBe(true);
  await expect(service.preview(request({}))).rejects.toThrow('pending or unconfirmed');
  expect((await rows())[0]).toEqual(original);
});
it('cannot terminalize a recovered prepared record belonging to another Office person', async () => {
  await service.preview(request({}));
  const original = (await rows())[0];
  original.principal.personId = randomUUID();
  await writeFile(file, JSON.stringify([original]));
  restart();
  await expect(service.preview(request({}))).rejects.toThrow('pending or unconfirmed');
  expect((await rows())[0]).toEqual(original);
  expect((await service.operationHistory(request({}))).operations).toEqual([]);
  expect(open).toHaveBeenCalledTimes(1);
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('retains the exact authenticated native failure code without recording a completed native result', async () => {
  await service.preview(request({}));
  migrate.mockRejectedValueOnce(
    new NativeFleetMigrationFailureError({
      kind: 'fleet-migration-failure',
      purpose: preview.purpose,
      version: 1,
      requestId: preview.requestId,
      approval: preview.approval,
      outcome: 'unconfirmed',
      code: 'POOL_CONTROLLER_ACTIVATION_RETAINED',
    })
  );
  await expect(apply()).rejects.toThrow();
  expect((await rows())[0]).toMatchObject({
    phase: 'unknown',
    native: null,
    nativeFailure: { code: 'POOL_CONTROLLER_ACTIVATION_RETAINED', outcome: 'unconfirmed' },
  });
});
it('refuses an illegal replay transition or removal of an already attempted employee', async () => {
  await service.preview(request({}));
  await apply();
  const saved = FleetOperationData.parse((await rows())[0]);
  expect(() => advanceFleetOperation(saved, 'issued')).toThrow();
});
it('allows a fresh epoch to inspect history without reviving original consent or wake authority', async () => {
  await service.preview(request({}));
  const before = (await rows())[0];
  await auth.logoutEverywhere('127.0.0.1');
  const login = await auth.login('FixtureOwner', 'synthetic-Operation!7', '127.0.0.1');
  token = login.session!;
  expect(auth.registrationIdentity(token).sessionEpoch).toBeGreaterThan(before.principal.sessionEpoch);
  expect((await result()).phase).toBe('not-issued');
  expect((await rows())[0].ownerScopeDigest).toBe(before.ownerScopeDigest);
  await expect(apply()).rejects.toThrow();
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
it('claims one issued intent before persistence yields, so concurrent Apply cannot poison or repeat dispatch', async () => {
  await service.preview(request({}));
  const complete = migrate.getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  migrate.mockImplementationOnce(async () => {
    entered();
    await gate;
    return complete();
  });
  const first = apply();
  await starting;
  await expect(apply()).rejects.toThrow();
  release();
  expect((await first).phase).toBe('completed');
  expect(migrate).toHaveBeenCalledTimes(1);
  expect(wake).toHaveBeenCalledTimes(2);
});
it('does not wake an employee whose current generation changed after the native result', async () => {
  await service.preview(request({}));
  const complete = migrate.getMockImplementation()!;
  migrate.mockImplementationOnce(async () => {
    const native = await complete();
    await company.store.update((state) => {
      state.employees[0].sessionGeneration++;
    });
    return native;
  });
  const answer = await apply();
  expect(answer.phase).toBe('completed');
  expect(answer.restore.map((row) => row.state)).toEqual(['skipped-current-intent', 'wake-confirmed']);
  expect(wake).toHaveBeenCalledTimes(1);
});
it('freezes after a partial restoration commit and never starts the remaining cohort on restart', async () => {
  await service.preview(request({}));
  const original = companyFiles.writeCompanyStateFile;
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, text, guard) => {
    await original(path, text, guard);
    const record = path === file ? JSON.parse(text)[0] : undefined;
    if (record?.phase === 'restoring' && record.restore[0]?.state === 'wake-confirmed')
      throw new Error('restoration receipt response lost');
  });
  await expect(apply()).rejects.toThrow('restoration receipt response lost');
  expect(wake).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
  restart();
  const answer = await result();
  expect(answer.phase).toBe('unknown');
  expect(answer.native?.phase).toBe('pool-configured');
  expect(answer.restore).toHaveLength(1);
  expect(answer.restore[0].state).toBe('wake-confirmed');
  expect(wake).toHaveBeenCalledTimes(1);
});
it('does not expose a prepared preview or dispatch when owner revocation occurs during its durable write', async () => {
  const original = companyFiles.writeCompanyStateFile;
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, text, guard) => {
    await original(path, text, guard);
    if (path === file && JSON.parse(text)[0].phase === 'prepared') auth.logout(token);
  });
  await expect(service.preview(request({}))).rejects.toThrow();
  expect((await rows())[0]).toMatchObject({ phase: 'unknown', failure: { code: 'OWNER_AUTHORIZATION_CHANGED' } });
  expect(migrate).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});

it('never sends private persistence paths or raw errors through the native HTTP boundary', async () => {
  service.close();
  const fleet = new FleetResourcesService(company, auth, '/unused-native-fixture', recovery, undefined, file);
  service = fleet.native!;
  const app = Fastify();
  await app.register(cookie);
  registerFleetResourceRoutes(app, ownerVerifier({ service: auth, ctx: {} as SessionPort }), fleet);
  const privateError = new Error(`EIO: private-operation-secret at ${file}`);
  vi.spyOn(companyFiles, 'writeCompanyStateFile').mockRejectedValueOnce(privateError);
  try {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/native-preview',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: `reverie_owner=${token}` },
      payload: {},
    });
    expect(reply.statusCode).toBe(503);
    expect(reply.json()).toEqual({
      success: false,
      code: 'FLEET_NATIVE_OUTCOME_UNCONFIRMED',
      outcome: 'unconfirmed',
      error: 'Original native fleet outcome is unavailable. Inspect the original operation; do not replay it.',
    });
    expect(reply.body).not.toContain(file);
    expect(reply.body).not.toContain('private-operation-secret');
    const failure = (code: string) =>
      new NativeFleetMigrationFailureError({
        kind: 'fleet-migration-failure',
        purpose: preview.purpose,
        version: 1,
        requestId: preview.requestId,
        approval: preview.approval,
        outcome: 'unconfirmed',
        code,
      });
    for (const code of ['unsafe/private-operation-secret', 'POOL_CONTROLLER_ACTIVATION_RETAINED']) {
      vi.spyOn(service, 'preview').mockRejectedValueOnce(failure(code));
      const diagnostic = await app.inject({
        method: 'POST',
        url: '/api/company/resources/fleet/native-preview',
        headers: { host: 'localhost', origin: 'http://localhost', cookie: `reverie_owner=${token}` },
        payload: {},
      });
      expect(diagnostic.statusCode).toBe(503);
      expect(diagnostic.json().code).toBe(code.startsWith('unsafe') ? 'FLEET_NATIVE_OUTCOME_UNCONFIRMED' : code);
      expect(diagnostic.json().outcome).toBe('unconfirmed');
      expect(diagnostic.body).not.toContain('private-operation-secret');
    }
    expect(migrate).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
