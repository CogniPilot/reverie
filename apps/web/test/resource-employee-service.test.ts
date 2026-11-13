/** Actual owner/company stores and AF_UNIX framing. The socket is a controlled
 * wire source, not native cgroup/provenance acceptance or a host executor. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { EmployeeResourcesService, registerEmployeeResourceRoutes } from '../src/resource-employee-service.js';
import { EmployeeMemoryDiagnostics } from '../src/resource-employee-data.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

let app: FastifyInstance, root: string, server: Server, service: EmployeeResourcesService;
let token: string, employeeId: string, sessionId: string;
let peers: Set<Socket>, frames: Record<string, unknown>[], connected: number;
let response: Record<string, unknown>;
let editMode: 'applied' | 'lost-reply' | 'refused' | 'no-proof' | 'foreign-challenge';
let editOverride: Record<string, unknown>;
let nativeRefusal: string;
let memoryMode: 'reply' | 'lost' | 'refused' | 'no-proof' | 'foreign-challenge' = 'reply';
let memoryValue: Record<string, unknown> | undefined;
let onMemory: (() => Promise<void>) | undefined;
let authService: OwnerAuthService, companyStore: CompanyStore;
const approval = () => ({
  sessionId,
  operationId: randomUUID(),
  expectedRevision: 'b'.repeat(64),
  memoryHighMiB: 12288,
  cpuWeight: 180,
});
const edit = (payload = approval(), selectedHeaders = headers()) =>
  app.inject({
    method: 'POST',
    url: `/api/company/resources/employees/${employeeId}/policy`,
    headers: selectedHeaders,
    payload,
  });
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};
const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'emp-api-'));
  const auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(root, 'auth.json')),
    auditFile: join(root, 'audit.jsonl'),
    setupEnabled: true,
  });
  authService = auth;
  token = await auth.setup('FixtureOwner', 'Quasar!fixture-8-passphrase', 'Quasar!fixture-8-passphrase', '127.0.0.1');
  const store = new CompanyStore(join(root, 'company.json'));
  companyStore = store;
  await store.init();
  const rooms = new ChatroomStore();
  sessionId = randomUUID();
  const sessions = new Map([[sessionId, { id: sessionId, name: 'Current employee' }]]);
  const company = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    chatrooms: {
      rooms: () => rooms.list(),
      room: (id) => rooms.get(id),
      addMember: (id, session, options) => rooms.addMember(id, session, options).member,
      removeMember: (id, session) => rooms.removeMember(id, session),
      setStatus: (id, session, status) => rooms.setStatus(id, session, status),
    },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  await company.hire({ name: 'Current employee', icon: '1', position: 'Engineer', expertise: ['systems'], sessionId });
  employeeId = company.view(undefined).employees[0].id;
  response = {
    version: 1,
    employeeId,
    sessionId,
    revision: 'b'.repeat(64),
    state: 'stopped',
    requested: { memoryHighMiB: 8192, memoryMaxMiB: 49152, cpuWeight: 100, allowedCpus: [0, 1], perfPolicy: 'task-v2' },
    observed: null,
    perfObserved: null,
    perfObservationReason: 'OWN_PROCESS_PROBE_REQUIRED',
    capabilities: {
      softMemoryLive: false,
      cpuWeightLive: false,
      hardMemoryReplacement: false,
      perfReplacement: false,
      gpuReplacement: false,
    },
    readOnly: true,
  };
  peers = new Set();
  frames = [];
  connected = 0;
  editMode = 'applied';
  editOverride = {};
  nativeRefusal = 'EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE';
  memoryMode = 'reply';
  memoryValue = undefined;
  onMemory = undefined;
  server = createServer((socket) => {
    connected++;
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    let buffer = Buffer.alloc(0),
      greeted = false;
    let operation: Record<string, unknown>;
    const applied = () => {
      const selected = operation.approval as ReturnType<typeof approval>;
      return {
        version: 1,
        employeeId,
        sessionId: selected.sessionId,
        operationId: selected.operationId,
        state: 'applied',
        memoryHighMiB: selected.memoryHighMiB,
        cpuWeight: selected.cpuWeight,
        ...editOverride,
      };
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        if (buffer.length < 5) return;
        const size = buffer.readUInt32BE(1);
        if (buffer.length < size + 5) return;
        expect(buffer[0]).toBe('Q'.charCodeAt(0));
        expect(JSON.parse(buffer.subarray(5, 5 + size).toString())).toEqual({
          purpose: 'resource-ram-pool-v2',
          version: 2,
        });
        buffer = buffer.subarray(5 + size);
        greeted = true;
        socket.write('RESOURCE_READY\n');
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < size + 4) return;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString()) as Record<string, unknown>;
        buffer = buffer.subarray(4 + size);
        frames.push(value);
        if (value.kind === 'resource-operation') {
          operation = value;
          const editing = value.verb === 'employee-policy-edit';
          if (value.verb === 'employee-memory-diagnostics' && memoryMode === 'no-proof') {
            socket.write(
              frame({
                kind: 'resource-result',
                requestId: value.requestId,
                value: {
                  version: 1,
                  purpose: 'employee-memory-diagnostics-v1',
                  employeeId,
                  sessionId,
                  sessionGeneration: '1',
                  state: 'stopped',
                  observation: null,
                  resources: response,
                  readOnly: true,
                },
              })
            );
            continue;
          }
          if (editing && editMode === 'no-proof') {
            socket.write(frame({ kind: 'resource-result', requestId: value.requestId, value: applied() }));
            continue;
          }
          socket.write(
            frame({
              kind: 'resource-owner-check',
              requestId: value.requestId,
              nonce: randomUUID(),
              stage: editing
                ? 'employee-policy-edit'
                : value.verb === 'employee-memory-diagnostics' && memoryMode !== 'foreign-challenge'
                  ? 'employee-memory-diagnostics'
                  : 'status',
              employeeId,
              approval: editing
                ? editMode === 'foreign-challenge'
                  ? { ...(value.approval as object), operationId: randomUUID() }
                  : value.approval
                : null,
            })
          );
        } else if (operation.verb === 'employee-memory-diagnostics') {
          void (async () => {
            await onMemory?.();
            if (memoryMode === 'lost') {
              socket.destroy();
              return;
            }
            if (memoryMode === 'refused') {
              socket.write(
                frame({
                  kind: 'resource-refused',
                  requestId: value.requestId,
                  reason: 'RESOURCE_OPERATION_UNCONFIRMED_KEEP_CLAIM',
                })
              );
              return;
            }
            socket.write(
              frame({
                kind: 'resource-result',
                requestId: value.requestId,
                value: memoryValue || {
                  version: 1,
                  purpose: 'employee-memory-diagnostics-v1',
                  employeeId,
                  sessionId,
                  sessionGeneration: '1',
                  state: 'stopped',
                  observation: null,
                  resources: response,
                  readOnly: true,
                },
              })
            );
          })();
        } else if (operation.verb !== 'employee-policy-edit') {
          socket.write(frame({ kind: 'resource-result', requestId: value.requestId, value: response }));
        } else if (editMode === 'lost-reply') {
          socket.destroy();
        } else if (editMode === 'refused') {
          socket.write(
            frame({
              kind: 'resource-refused',
              requestId: value.requestId,
              reason: nativeRefusal,
            })
          );
        } else {
          socket.write(frame({ kind: 'resource-result', requestId: value.requestId, value: applied() }));
        }
      }
    });
  });
  const socketPath = join(root, 'actor.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  service = new EmployeeResourcesService(company, auth, socketPath);
  app = Fastify();
  await app.register(cookie);
  registerEmployeeResourceRoutes(
    app,
    ownerVerifier({ service: auth, ctx: { sessions } as unknown as SessionPort }),
    service
  );
});
afterEach(async () => {
  service?.close();
  for (const peer of peers ?? []) peer.destroy();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
it('authenticates the original owner and current session without inferring stopped limits or perf', async () => {
  const result = await app.inject({
    method: 'GET',
    url: `/api/company/resources/employees/${employeeId}`,
    headers: headers(),
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json().data).toEqual(response);
  expect(frames[0]).toMatchObject({ verb: 'employee-status', employeeId, sessionId });
  expect(frames[1]).toMatchObject({ kind: 'resource-owner-current', stage: 'status', approval: null });
  expect(JSON.stringify(frames)).not.toContain(token);
});
it('refuses a foreign returned session instead of attributing its observation to the employee', async () => {
  response.sessionId = randomUUID();
  const result = await app.inject({
    method: 'GET',
    url: `/api/company/resources/employees/${employeeId}`,
    headers: headers(),
  });
  expect(result.statusCode).toBe(503);
  expect(result.json().data).toBeUndefined();
});
it('rejects anonymous and mixed guest/service headers before opening any native socket', async () => {
  for (const extra of [
    { cookie: '' },
    { authorization: 'Bearer arbitrary' },
    { 'x-reverie-parent-session': sessionId },
    { 'x-reverie-service-token': 'arbitrary' },
    { 'x-reverie-goal-proof': 'arbitrary' },
  ]) {
    const result = await app.inject({
      method: 'GET',
      url: `/api/company/resources/employees/${employeeId}`,
      headers: { ...headers(), ...extra },
    });
    expect(result.statusCode).toBe(403);
  }
  expect(connected).toBe(0);
  expect(frames).toHaveLength(0);
});

it('submits one exact RAM and CPU edit with current owner proof on the same native channel', async () => {
  const selected = approval();
  const result = await edit(selected);
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json().data).toEqual({
    version: 1,
    employeeId,
    sessionId,
    operationId: selected.operationId,
    state: 'applied',
    memoryHighMiB: selected.memoryHighMiB,
    cpuWeight: selected.cpuWeight,
  });
  expect(connected).toBe(1);
  expect(frames).toHaveLength(2);
  expect(Object.keys(frames[0]).sort()).toEqual(['approval', 'employeeId', 'kind', 'requestId', 'verb']);
  expect(frames[0]).toMatchObject({
    kind: 'resource-operation',
    verb: 'employee-policy-edit',
    employeeId,
    approval: selected,
  });
  expect(frames[1]).toMatchObject({
    kind: 'resource-owner-current',
    requestId: frames[0].requestId,
    stage: 'employee-policy-edit',
    approval: selected,
  });
  expect(JSON.stringify(frames)).not.toContain(token);
});

it('refuses malformed, foreign-origin, guest and stale-session edits before opening the socket', async () => {
  expect((await edit({ ...approval(), memoryHighMiB: 49153 })).statusCode).toBe(400);
  expect((await edit({ ...approval(), cpuWeight: 1.5 })).statusCode).toBe(400);
  expect((await edit(approval(), { ...headers(), origin: 'https://foreign.invalid' })).statusCode).toBe(403);
  expect((await edit(approval(), { ...headers(), cookie: '' })).statusCode).toBe(403);
  expect((await edit({ ...approval(), sessionId: randomUUID() })).statusCode).toBe(409);
  expect(connected).toBe(0);
});

it.each(['sessionId', 'operationId', 'employeeId', 'memoryHighMiB', 'cpuWeight'] as const)(
  'does not accept a native applied result with a changed %s',
  async (field) => {
    editOverride = { [field]: field.endsWith('Id') ? randomUUID() : 333 };
    const result = await edit();
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ success: false, errorCode: 'EMPLOYEE_RESOURCE_EDIT_UNCONFIRMED' });
    expect(result.json().data).toBeUndefined();
    expect(connected).toBe(1);
    expect(frames.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
  }
);

it.each(['no-proof', 'foreign-challenge', 'lost-reply'] as const)(
  'keeps a %s edit unconfirmed without another native request',
  async (mode) => {
    editMode = mode;
    const result = await edit();
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ success: false, errorCode: 'EMPLOYEE_RESOURCE_EDIT_UNCONFIRMED' });
    expect(connected).toBe(1);
    expect(frames.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
    expect(frames.filter((row) => row.kind === 'resource-owner-current')).toHaveLength(mode === 'lost-reply' ? 1 : 0);
  }
);

it('preserves the fixed native refusal code without claiming an unverified success', async () => {
  editMode = 'refused';
  const result = await edit();
  expect(result.statusCode).toBe(409);
  expect(result.json()).toMatchObject({ success: false, errorCode: 'EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE' });
  expect(result.json().data).toBeUndefined();
  expect(connected).toBe(1);
});

it.each([
  ['RESOURCE_OPERATION_UNCONFIRMED_KEEP_CLAIM', 'EMPLOYEE_RESOURCE_EDIT_UNCONFIRMED', 'was not confirmed'],
  ['EMPLOYEE_RESOURCE_RECONCILIATION_REQUIRED', 'EMPLOYEE_RESOURCE_RECONCILIATION_REQUIRED', 'requires reconciliation'],
  ['WORKER_POOL_MEMBER_EDIT_UNSUPPORTED', 'EMPLOYEE_RESOURCE_EDIT_UNCONFIRMED', 'was not confirmed'],
])('projects native %s without reporting a known refusal', async (reason, code, message) => {
  editMode = 'refused';
  nativeRefusal = reason;
  const result = await edit();
  expect(result.statusCode).toBe(503);
  expect(result.json()).toMatchObject({ success: false, errorCode: code, error: expect.stringContaining(message) });
  expect(result.json().data).toBeUndefined();
  expect(connected).toBe(1);
  expect(frames.filter((row) => row.kind === 'resource-operation')).toHaveLength(1);
});

const memoryGet = (extra: Record<string, string | undefined> = {}) =>
  app.inject({
    method: 'GET',
    url: `/api/company/resources/employees/${employeeId}/memory-diagnostics`,
    headers: { ...headers(), ...extra },
  });
const operations = () => frames.filter((row) => row.kind === 'resource-operation').map((row) => row.verb);
function pressureSnapshot(some = 9400, full = 9200, sampledAtEpochMs = Date.now()) {
  response.state = 'running';
  response.observed = {
    containerId: 'a'.repeat(64),
    pid: 42,
    processStart: '99',
    leafDevice: '7',
    leafInode: '11',
    memoryHighBytes: '8589934592',
    memoryMaxBytes: 'max',
    memoryCurrentBytes: '18000000000',
    memorySwapMaxBytes: '0',
    cpuWeight: 100,
    cpuMax: 'max 100000',
    allowedCpus: [0, 1],
  };
  return EmployeeMemoryDiagnostics.parse({
    version: 1,
    purpose: 'employee-memory-diagnostics-v1',
    employeeId,
    sessionId,
    sessionGeneration: '1',
    state: 'observed',
    resources: response,
    readOnly: true,
    observation: {
      binding: { containerId: 'a'.repeat(64), initPid: 42, initProcessStart: '99', leafDevice: '7', leafInode: '11' },
      sampledAtEpochMs,
      sampleDurationUs: '50',
      pressure: {
        state: 'available',
        some: { avg10Hundredths: some, avg60Hundredths: 0, avg300Hundredths: 0, totalUs: '100' },
        full: { avg10Hundredths: full, avg60Hundredths: 0, avg300Hundredths: 0, totalUs: '100' },
      },
      events: {
        state: 'available',
        low: '0',
        high: '999999',
        max: '0',
        oom: '999',
        oomKill: '999',
        oomGroupKill: null,
      },
    },
  });
}
it('projects a fresh original high-stall sample as a read-only advisory without issuing policy or recovery operations', async () => {
  memoryValue = pressureSnapshot();
  const result = await memoryGet();
  expect(result.statusCode).toBe(200);
  expect(result.json().data.advisory).toMatchObject({
    state: 'warning',
    code: 'high-memory-stall',
    sampledAtEpochMs: (memoryValue.observation as { sampledAtEpochMs: number }).sampledAtEpochMs,
    evaluatedAtEpochMs: expect.any(Number),
  });
  expect(operations()).toEqual(['employee-memory-diagnostics']);
  expect(result.json().data.resources).toEqual(response);
});
it.each(['historical', 'stale', 'future', 'unavailable', 'out-of-range'] as const)(
  'keeps %s pressure evidence out of a high-stall warning while preserving the original single-query limits',
  async (kind) => {
    const sampledAt = Date.now();
    const value = pressureSnapshot(
      kind === 'historical' ? 0 : 9400,
      kind === 'historical' ? 0 : 9200,
      kind === 'stale'
        ? sampledAt - 60_000
        : kind === 'future'
          ? sampledAt + 60_000
          : kind === 'out-of-range'
            ? Number.MAX_SAFE_INTEGER
            : sampledAt
    );
    if (kind === 'unavailable') value.observation!.pressure = { state: 'unavailable', reason: 'missing' };
    memoryValue = value;
    const result = await memoryGet();
    expect(result.statusCode).toBe(200);
    expect(result.json().data.advisory).toMatchObject(
      kind === 'historical'
        ? { state: 'not-observed' }
        : {
            state: 'unknown',
            reason: (
              {
                stale: 'stale-sample',
                future: 'future-sample',
                unavailable: 'pressure-unavailable',
                'out-of-range': 'sample-time-unavailable',
              } as const
            )[kind],
          }
    );
    expect(result.json().data.resources).toEqual(response);
    expect(operations()).toEqual(['employee-memory-diagnostics']);
  }
);
it('returns a separately authenticated compound snapshot with one original native query', async () => {
  const result = await memoryGet();
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json().data).toMatchObject({
    source: 'native-compound',
    sessionGeneration: '1',
    resources: response,
    diagnostics: { kind: 'snapshot', value: { state: 'stopped' } },
  });
  expect(EmployeeMemoryDiagnostics.safeParse(result.json().data.diagnostics.value).success).toBe(true);
  expect(operations()).toEqual(['employee-memory-diagnostics']);
  expect(frames[1]).toMatchObject({
    kind: 'resource-owner-current',
    stage: 'employee-memory-diagnostics',
    approval: null,
  });
});
it.each(['lost', 'refused'] as const)(
  'a %s diagnostic read allows one fresh status read without claiming its predecessor settled',
  async (mode) => {
    memoryMode = mode;
    const result = await memoryGet();
    expect(result.statusCode).toBe(200);
    expect(result.json().data).toMatchObject({
      source: 'independent-status-read',
      resources: response,
      diagnostics: { kind: 'unavailable', reason: 'native-observation-unconfirmed' },
      advisory: { state: 'unknown', reason: 'native-observation-unconfirmed', sampledAtEpochMs: null },
    });
    expect(result.json().data.diagnostics.value).toBeUndefined();
    expect(operations()).toEqual(['employee-memory-diagnostics', 'employee-status']);
    expect(connected).toBe(2);
  }
);
it.each(['session', 'generation', 'owner'] as const)(
  'canonical %s changes forbid fallback or attribution to a successor',
  async (kind) => {
    memoryMode = 'lost';
    onMemory = () =>
      companyStore.update((state) => {
        const employee = state.employees.find((row) => row.id === employeeId)!;
        if (kind === 'session') employee.sessionId = randomUUID();
        if (kind === 'generation') employee.sessionGeneration++;
        if (kind === 'owner') employee.owner = 'other-owner';
      });
    expect((await memoryGet()).statusCode).toBe(503);
    expect(operations()).toEqual(['employee-memory-diagnostics']);
  }
);
it('revoked owner cannot open a fresh fallback channel', async () => {
  memoryMode = 'lost';
  onMemory = async () => {
    authService.logout(token);
  };
  expect((await memoryGet()).statusCode).toBe(403);
  expect(operations()).toEqual(['employee-memory-diagnostics']);
});
it.each([
  { authorization: 'Bearer not-owner' },
  { 'x-reverie-parent-session': 'invented' },
  { 'x-reverie-service-token': 'invented' },
])('rejects mixed principal headers before diagnostics opens a native channel', async (extra) => {
  expect((await memoryGet(extra)).statusCode).toBe(403);
  expect(connected).toBe(0);
});
it('refuses both observations without inventing current limits or a native diagnostic value', async () => {
  memoryMode = 'lost';
  response.sessionId = randomUUID();
  const result = await memoryGet();
  expect(result.statusCode).toBe(503);
  expect(result.json().data).toBeUndefined();
  expect(operations()).toEqual(['employee-memory-diagnostics', 'employee-status']);
});

it('fresh fallback consumes only the original monotonic budget rather than a new ten-second window', async () => {
  const { performance } = await import('node:perf_hooks');
  let elapsed = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const timers = vi.spyOn(globalThis, 'setTimeout');
  memoryMode = 'lost';
  onMemory = async () => {
    elapsed = 8000;
  };
  try {
    expect((await memoryGet()).statusCode).toBe(200);
    expect(operations()).toEqual(['employee-memory-diagnostics', 'employee-status']);
    const delays = timers.mock.calls.map((call) => call[1]);
    expect(delays).toContain(2000);
    expect(delays).not.toContain(180000);
  } finally {
    clock.mockRestore();
    timers.mockRestore();
  }
});
it('an exhausted original monotonic budget cannot open an independent fallback channel', async () => {
  const { performance } = await import('node:perf_hooks');
  let elapsed = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  memoryMode = 'lost';
  onMemory = async () => {
    elapsed = 10001;
  };
  try {
    expect((await memoryGet()).statusCode).toBe(503);
    expect(connected).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

it('missing optional metrics preserve verified editable limits from the same single compound read', async () => {
  response.state = 'running';
  response.observed = {
    containerId: 'a'.repeat(64),
    pid: 42,
    processStart: '99',
    leafDevice: '7',
    leafInode: '11',
    memoryHighBytes: '8589934592',
    memoryMaxBytes: 'max',
    memoryCurrentBytes: '4096',
    memorySwapMaxBytes: '0',
    cpuWeight: 100,
    cpuMax: 'max 100000',
    allowedCpus: [0, 1],
  };
  (response.capabilities as Record<string, unknown>).softMemoryLive = true;
  (response.capabilities as Record<string, unknown>).cpuWeightLive = true;
  memoryValue = {
    version: 1,
    purpose: 'employee-memory-diagnostics-v1',
    employeeId,
    sessionId,
    sessionGeneration: '1',
    state: 'observed',
    observation: {
      binding: { containerId: 'a'.repeat(64), initPid: 42, initProcessStart: '99', leafDevice: '7', leafInode: '11' },
      sampledAtEpochMs: Date.now(),
      sampleDurationUs: '50',
      pressure: { state: 'unavailable', reason: 'missing' },
      events: {
        state: 'available',
        low: '0',
        high: '9007199254740993',
        max: '0',
        oom: '0',
        oomKill: '0',
        oomGroupKill: null,
      },
    },
    resources: response,
    readOnly: true,
  };
  const result = await memoryGet();
  expect(result.statusCode).toBe(200);
  expect(result.json().data.source).toBe('native-compound');
  expect(result.json().data.resources.capabilities.softMemoryLive).toBe(true);
  expect(result.json().data.diagnostics.value.observation.events.high).toBe('9007199254740993');
  expect(operations()).toEqual(['employee-memory-diagnostics']);
});
it('a malformed compound cannot promote limits; its independent fresh read has explicit separate provenance', async () => {
  memoryValue = {
    version: 1,
    purpose: 'employee-memory-diagnostics-v1',
    employeeId,
    sessionId,
    sessionGeneration: '01',
    state: 'stopped',
    observation: null,
    resources: response,
    readOnly: true,
  };
  const result = await memoryGet();
  expect(result.statusCode).toBe(200);
  expect(result.json().data.source).toBe('independent-status-read');
  expect(result.json().data.diagnostics).toEqual({ kind: 'unavailable', reason: 'native-observation-unconfirmed' });
  expect(operations()).toEqual(['employee-memory-diagnostics', 'employee-status']);
});

it.each(['no-proof', 'foreign-challenge'] as const)(
  'a %s diagnostic peer cannot borrow status authority or confirm the compound result',
  async (mode) => {
    memoryMode = mode;
    const result = await memoryGet();
    expect(result.statusCode).toBe(200);
    expect(result.json().data.source).toBe('independent-status-read');
    expect(operations()).toEqual(['employee-memory-diagnostics', 'employee-status']);
    expect(frames.filter((row) => row.kind === 'resource-owner-current').map((row) => row.stage)).toEqual(['status']);
  }
);
it('an unsafe numeric canonical generation is refused before opening any diagnostic channel', async () => {
  const state = companyStore.snapshot();
  state.employees.find((row) => row.id === employeeId)!.sessionGeneration = 9007199254740992;
  // Native storage can retain a wider exact generation; the JS reader must refuse,
  // rather than round that existing source into a new observation's identity.
  await writeFile(join(root, 'company.json'), JSON.stringify(state));
  expect((await memoryGet()).statusCode).toBe(503);
  expect(connected).toBe(0);
});

it.each(['both', 'absolute-context'] as const)(
  'actual route classifies %s expiry as unavailable, not owner revocation',
  async (kind) => {
    const { performance } = await import('node:perf_hooks');
    let elapsed = 0,
      epoch = Date.now();
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const wall = vi.spyOn(Date, 'now').mockImplementation(() => epoch);
    memoryMode = 'lost';
    onMemory = async () => {
      elapsed = kind === 'both' ? 10001 : 1;
      epoch += 10001;
    };
    try {
      const result = await memoryGet();
      expect(result.statusCode).toBe(503);
      expect(result.json().code).toBe('EMPLOYEE_RESOURCE_OBSERVATION_UNAVAILABLE');
      expect(operations()).toEqual(['employee-memory-diagnostics']);
      expect(connected).toBe(1);
      expect(authService.session(token)).toBeDefined();
    } finally {
      monotonic.mockRestore();
      wall.mockRestore();
    }
  }
);
