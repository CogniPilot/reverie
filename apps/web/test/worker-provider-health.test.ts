import { afterEach, expect, it, vi } from 'vitest';
import { WorkerProviderHealth, viewerHealth, PROVIDER_HEALTH_MAX_AGE_MS } from '../src/worker-provider-health.js';
import { EmployeeSchema } from '../src/company-types.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const SID = '22222222-2222-4222-8222-222222222222',
  EID = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const employee = EmployeeSchema.parse({
    id: EID,
    sessionId: SID,
    sessionGeneration: 1,
    name: 'Fixture',
    icon: 'F',
    position: 'Expert',
    expertise: ['systems'],
    createdAt: 1,
    desiredRunning: true,
    onVacation: false,
  });
  let epoch = 10_000,
    mono = 100;
  const changed = vi.fn();
  let row: any = {
    observedBinding: JSON.parse(
      JSON.stringify([
        employee.id,
        employee.owner,
        employee.sessionId,
        employee.sessionGeneration,
        employee.desiredRunning,
        employee.onVacation,
        employee.bindingMigration,
        employee.runtimeRecipe,
        employee.permissions,
      ])
    ),
    employeeId: EID,
    sessionId: SID,
    sessionGeneration: 1,
    state: 'healthy',
    observedAtEpochMs: epoch,
    reason: 'LIVE_NATIVE_COMMAND',
    proofKind: 'live-container',
    containerId: 'a'.repeat(64),
    initPID: 100,
    initStartTick: 200,
  };
  const query = vi.fn(async () => ({
    providerHealth: { version: 1, purpose: 'worker-provider-health-v1', providers: [row] },
  }));
  const employees = vi.fn(() => [employee]);
  const health = new WorkerProviderHealth({
    employees,
    query,
    changed,
    now: () => epoch,
    monotonic: () => mono,
  });
  return {
    employee,
    health,
    query,
    changed,
    employees,
    row,
    setRow: (value: any) => {
      row = value;
    },
    advance: (n: number) => {
      epoch += n;
      mono += n;
    },
    epoch: (n: number) => {
      epoch = n;
    },
  };
}
it('projects independently observed runtime health while the viewer remains disconnected', async () => {
  const f = fixture();
  await f.health.refresh();
  expect(f.health.read(SID)).toMatchObject({
    state: 'healthy',
    employeeId: EID,
    sessionId: SID,
    observedAtEpochMs: 10_000,
  });
  expect(
    viewerHealth({ pid: null, runtimeHealth: 'disconnected', runtimeHealthScope: 'terminal', paneExit: { status: 1 } })
  ).toBe('disconnected');
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.employee.desiredRunning).toBe(true);
});
it('never refreshes an old native observation timestamp when status serves the same cache hit', async () => {
  const f = fixture();
  await f.health.refresh();
  f.advance(5_000);
  await f.health.refresh();
  expect(f.health.read(SID)?.observedAtEpochMs).toBe(10_000);
  f.advance(PROVIDER_HEALTH_MAX_AGE_MS - 5_000 + 1);
  expect(f.health.read(SID)).toBeUndefined();
});
it.each(['owner', 'generation', 'session', 'off', 'vacation', 'move'] as const)(
  'invalidates cached proof for changed %s',
  async (change) => {
    const f = fixture();
    await f.health.refresh();
    if (change === 'owner') f.employee.owner = 'other';
    if (change === 'generation') f.employee.sessionGeneration++;
    if (change === 'session') f.employee.sessionId = '33333333-3333-4333-8333-333333333333';
    if (change === 'off') f.employee.desiredRunning = false;
    if (change === 'vacation') f.employee.onVacation = true;
    if (change === 'move') f.employee.bindingMigration = {} as never;
    expect(f.health.read(SID)).toBeUndefined();
    expect(f.health.read(f.employee)).toBeUndefined();
  }
);
it('refuses a native response after canonical owner changes while its query awaits', async () => {
  const f = fixture();
  let release!: (value: any) => void;
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const flight = f.health.refresh();
  f.employee.owner = 'changed';
  release({ providerHealth: { version: 1, purpose: 'worker-provider-health-v1', providers: [f.row] } });
  await flight;
  expect(f.health.read(SID)).toBeUndefined();
});
it('does not treat an older broker or missing native facts as provider-health proof', async () => {
  const f = fixture();
  await f.health.refresh();
  f.query.mockResolvedValueOnce({ runningSessionIds: [SID] } as any);
  await f.health.refresh();
  expect(f.health.read(SID)).toBeUndefined();
  f.setRow({ ...f.row, containerId: undefined });
  await f.health.refresh();
  expect(f.health.read(SID)).toBeUndefined();
});
it('refuses ambiguous native bindings, future timestamps and wall-clock rollback', async () => {
  const f = fixture();
  f.query.mockResolvedValueOnce({
    providerHealth: { version: 1, purpose: 'worker-provider-health-v1', providers: [f.row, f.row] },
  } as any);
  await f.health.refresh();
  expect(f.health.read(SID)).toBeUndefined();
  f.setRow({ ...f.row, observedAtEpochMs: 11_000 });
  await f.health.refresh();
  expect(f.health.read(SID)).toBeUndefined();
  f.setRow({ ...f.row });
  await f.health.refresh();
  f.epoch(9_999);
  expect(f.health.read(SID)).toBeUndefined();
});
it('bounds refresh concurrency, invalidates on failed query and stops publishing after close', async () => {
  const f = fixture();
  let release!: (v: any) => void;
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const first = f.health.refresh();
  await f.health.refresh();
  expect(f.query).toHaveBeenCalledOnce();
  f.health.close();
  release({ providerHealth: { version: 1, purpose: 'worker-provider-health-v1', providers: [f.row] } });
  await first;
  expect(f.health.read(SID)).toBeUndefined();
  expect(f.changed).not.toHaveBeenCalled();
});

it('projects native availability and viewer failure separately through the actual member DTO without changing alive or writing input', async () => {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), 'ph-'));
  const write = vi.fn(async () => false),
    session = {
      id: SID,
      name: 'Fixture',
      mode: 'codex',
      status: 'idle',
      pid: null,
      isWorking: false,
      runtimeHealth: 'disconnected',
      runtimeHealthScope: 'terminal',
      viewerInputHeld: true,
      writeViaMux: write,
      canAcceptChatInput: () => false,
    };
  const chat = new ChatroomService({
    file: join(directory, 'chat.json'),
    getSession: () => session,
    providerHealth: (id, owner) => f.health.read(id, { owner }),
    workerViewers: true,
    broadcast: vi.fn(),
    deferDeliveryRecovery: true,
  });
  try {
    await chat.init();
    const room = chat.createRoom('Office', undefined);
    chat.addMember(room.id, SID);
    await f.health.refresh();
    const member = chat.view(room).members[0];
    expect(member.alive).toBe(false);
    expect(member.viewerHealth).toBe('disconnected');
    expect(member.providerHealth).toMatchObject({ employeeId: EID, sessionId: SID, state: 'healthy' });
    expect(member.providerHealth).not.toHaveProperty('initPID');
    expect(member.providerHealth).not.toHaveProperty('containerId');
    expect(f.health.read(SID, { owner: 'foreign-owner' })).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  } finally {
    await chat.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['owner', 'recipe', 'permissions', 'intent'])(
  'refuses broker proof of a different same-generation %s binding',
  async (change) => {
    const f = fixture();
    if (change === 'owner') f.row.observedBinding[1] = 'other';
    if (change === 'recipe') f.row.observedBinding[7] = { cwd: '/other' };
    if (change === 'permissions') f.row.observedBinding[8] = { recoverEmployees: true };
    if (change === 'intent') f.row.observedBinding[4] = false;
    await f.health.refresh();
    expect(f.health.read(SID)).toBeUndefined();
  }
);

it('retains the first monotonic expiry across repeated proof and partial wall-clock rollback', async () => {
  const f = fixture();
  await f.health.refresh();
  f.advance(20000);
  await f.health.refresh();
  f.advance(1000);
  f.epoch(20000);
  await f.health.refresh();
  f.advance(5000);
  expect(f.health.read(SID)).toBeUndefined();
  expect(f.health.read(f.employee)).toBeUndefined();
});
it('accepts exact stopped-container proof without inventing an init process', async () => {
  const f = fixture();
  f.setRow({
    ...f.row,
    state: 'dead',
    reason: 'CONTAINER_STOPPED',
    proofKind: 'stopped-container',
    initPID: undefined,
    initStartTick: undefined,
  });
  await f.health.refresh();
  expect(f.health.read(SID)?.state).toBe('dead');
  f.setRow({ ...f.row, state: 'healthy', reason: 'LIVE_NATIVE_COMMAND', proofKind: 'stopped-container' });
  await f.health.refresh();
  expect(f.health.read(SID)).toBeUndefined();
});

it('retains the original deadline after an unavailable snapshot clears published health', async () => {
  const f = fixture();
  await f.health.refresh();
  f.advance(20000);
  f.query.mockRejectedValueOnce(Error('unavailable'));
  await f.health.refresh();
  expect(f.health.read(SID)).toBeUndefined();
  f.advance(1000);
  f.epoch(20000);
  await f.health.refresh();
  f.advance(5000);
  expect(f.health.read(SID)).toBeUndefined();
  expect(f.health.read(f.employee)).toBeUndefined();
});

it('reads an already-current employee without another registry load and preserves owner and expiry fences', async () => {
  const f = fixture();
  await f.health.refresh();
  f.employees.mockClear();
  expect(f.health.read(f.employee)?.state).toBe('healthy');
  expect(f.health.read(f.employee, { owner: 'foreign' })).toBeUndefined();
  f.advance(PROVIDER_HEALTH_MAX_AGE_MS + 1);
  expect(f.health.read(f.employee)).toBeUndefined();
  expect(f.employees).not.toHaveBeenCalled();
});

it.each(['runtimeRecipe', 'permissions'] as const)('checks current %s on the direct-row path', async (field) => {
  const f = fixture();
  await f.health.refresh();
  const current = structuredClone(f.employee);
  if (field === 'runtimeRecipe') current.runtimeRecipe = { cwd: '/changed' } as never;
  else current.permissions.recoverEmployees = !current.permissions.recoverEmployees;
  f.employees.mockClear();
  expect(f.health.read(current)).toBeUndefined();
  expect(f.employees).not.toHaveBeenCalled();
});

it('uses one canonical snapshot per N-employee company render and one post-query census per refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-render-'));
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  const employees = Array.from({ length: 12 }, (_, i) =>
    EmployeeSchema.parse({
      id: randomUUID(),
      sessionId: randomUUID(),
      sessionGeneration: 1,
      name: 'Employee ' + i,
      icon: 'F',
      position: 'Expert',
      expertise: ['systems'],
      createdAt: 1,
      desiredRunning: true,
      onVacation: false,
    })
  );
  await store.update((state) => {
    state.employees = employees;
  });
  const nativeRows = employees.map((employee) => ({
    observedBinding: JSON.parse(
      JSON.stringify([
        employee.id,
        employee.owner,
        employee.sessionId,
        employee.sessionGeneration,
        employee.desiredRunning,
        employee.onVacation,
        employee.bindingMigration,
        employee.runtimeRecipe,
        employee.permissions,
      ])
    ),
    employeeId: employee.id,
    sessionId: employee.sessionId,
    sessionGeneration: employee.sessionGeneration,
    state: 'healthy',
    observedAtEpochMs: 10_000,
    reason: 'LIVE_NATIVE_COMMAND',
    proofKind: 'live-container',
    containerId: 'a'.repeat(64),
    initPID: 100,
    initStartTick: 200,
  }));
  let service!: CompanyService;
  const census = vi.fn(() => service.registeredEmployees());
  const health = new WorkerProviderHealth({
    employees: census,
    query: async () => ({
      providerHealth: { version: 1, purpose: 'worker-provider-health-v1', providers: nativeRows },
    }),
    changed: () => {},
    now: () => 10_000,
    monotonic: () => 100,
  });
  const project = vi.fn((employee) => health.read(employee));
  service = new CompanyService(store, {
    getSession: () => undefined,
    providerHealth: project,
    chatrooms: {} as never,
    research: {} as never,
  });
  const snapshots = vi.spyOn(store, 'snapshot');
  try {
    await health.refresh();
    // Keep the pre-query binding fence and ONE fresh census after the await.
    expect(census).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveBeenCalledTimes(2);
    census.mockClear();
    snapshots.mockClear();
    for (let i = 0; i < 4; i++) {
      const view = service.view();
      expect(view.employees).toHaveLength(12);
      expect(view.employees.every((e) => e.providerHealth?.state === 'healthy')).toBe(true);
    }
    expect(project).toHaveBeenCalledTimes(48);
    expect(snapshots).toHaveBeenCalledTimes(4);
    expect(census).not.toHaveBeenCalled();

    // Ambiguity across owners must still suppress the direct-row projection.
    await store.update((state) => {
      state.employees.push(
        EmployeeSchema.parse({
          ...employees[0],
          id: randomUUID(),
          owner: 'another-owner',
          name: 'Ambiguous',
        })
      );
    });
    snapshots.mockClear();
    census.mockClear();
    project.mockClear();
    expect(service.view().employees.find((e) => e.id === employees[0].id)?.providerHealth).toBeUndefined();
    expect(service.view('another-owner').employees[0].providerHealth).toBeUndefined();
    expect(project).toHaveBeenCalledTimes(11);
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(census).not.toHaveBeenCalled();
  } finally {
    health.close();
    await rm(directory, { recursive: true, force: true });
  }
});
