import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/company-store.js';
import {
  CompanyError,
  CompanyService,
  type CompanyResearchBackend,
  type ResearchHandle,
} from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';

describe('company identities and genuine research lifecycle', () => {
  let directory: string;
  let store: CompanyStore;
  let service: CompanyService;
  let rooms: ChatroomStore;
  let handles: Map<string, ResearchHandle>;
  let backend: CompanyResearchBackend;
  const sessions = new Map([
    ['expert-main', { id: 'expert-main', name: 'Employee main', owner: undefined }],
    ['other-main', { id: 'other-main', name: 'Other main', owner: 'another-owner' }],
    ['parent-agent', { id: 'parent-agent', name: 'Parent', owner: undefined }],
  ]);
  const night = Date.parse('2026-10-15T01:00:00Z');
  const result = {
    summary: 'Measured a prototype',
    findings: [
      {
        text: 'Prototype passed the experiment',
        status: 'observed' as const,
        evidence: ['artifact: experiment.log; 12/12 cases passed'],
      },
    ],
  };
  const createService = () =>
    new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
      },
      research: backend,
      now: () => night,
    });
  const hire = () =>
    service.hire({
      name: 'Abe',
      icon: '🔭',
      position: 'Research scientist',
      expertise: ['systems'],
      sessionId: 'expert-main',
      researchEnabled: true,
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-company-'));
    store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    rooms = new ChatroomStore();
    handles = new Map();
    backend = {
      inspect: vi.fn(async (id) => handles.get(id)),
      start: vi.fn(async ({ cycle, employee }) => {
        const handle: ResearchHandle = {
          cycleId: cycle.id,
          employeeId: employee.id,
          owner: cycle.owner,
          sessionId: `research-${cycle.id}`,
          dedicated: true,
          state: 'running',
        };
        handles.set(cycle.id, handle);
        return handle;
      }),
      stop: vi.fn(async () => {}),
    };
    service = createService();
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves other grants when changing a single permission through the service', async () => {
    const employee = await hire();
    expect(employee.permissions).toEqual({ recoverEmployees: false, moveOwnPlan: false, managePlans: false });
    await service.update(employee.id, undefined, { permissions: { moveOwnPlan: true, manageBoard: true } });
    await service.update(employee.id, undefined, { permissions: { managePlans: true } });
    expect(store.snapshot().employees[0].permissions).toEqual({
      recoverEmployees: false, moveOwnPlan: true, managePlans: true, manageBoard: true,
    });
    await service.update(employee.id, undefined, { permissions: { recoverEmployees: true } });
    await service.update(employee.id, undefined, { permissions: { managePlans: false } });
    const reloaded = new CompanyStore(store.file); await reloaded.init();
    expect(reloaded.snapshot().employees[0].permissions).toEqual({
      recoverEmployees: true, moveOwnPlan: true, managePlans: false, manageBoard: true,
    });
  });

  it('rechecks authority after a pending audit and never commits a revoked grant', async () => {
    const employee = await hire();
    const previous = store.snapshot();
    let allowed = true;
    await expect(store.update(state => {
      const target = state.employees.find(item => item.id === employee.id)!;
      target.permissions.manageBoard = true;
      return target;
    }, () => {
      if (!allowed) throw new Error('Owner authority revoked');
    }, async detached => {
      detached.permissions.manageBoard = false;
      allowed = false;
    })).rejects.toThrow('Owner authority revoked');
    expect(store.snapshot()).toEqual(previous);
    const reloaded = new CompanyStore(store.file); await reloaded.init();
    expect(reloaded.snapshot()).toEqual(previous);
  });

  it('keeps the pending grant independent from the audit callback result copy', async () => {
    const employee = await hire();
    await store.update(state => {
      const target = state.employees.find(item => item.id === employee.id)!;
      target.permissions.manageBoard = true;
      return target;
    }, undefined, async detached => { detached.permissions.manageBoard = false; });
    expect(store.snapshot().employees[0].permissions.manageBoard).toBe(true);
  });

  it('persists vacation before stopping, blocks late wake and research, and returns the same identity', async () => {
    const employee = await hire();
    await service.remember(employee.id, undefined, 'Durable memory');
    const stopSession = vi.fn(async () => {
      const reloaded = new CompanyStore(join(directory, 'company.json'));
      await reloaded.init();
      expect(reloaded.snapshot().employees[0]).toMatchObject({ onVacation: true, desiredRunning: false });
    });
    service = new CompanyService(store, { getSession: (id) => sessions.get(id), stopSession,
      chatrooms: { rooms: () => rooms.list(), room: (id) => rooms.get(id), addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member }, research: backend, now: () => night });
    await expect(service.setVacation(employee.id, 'foreign', true)).rejects.toMatchObject({ status: 404 });
    await service.setVacation(employee.id, undefined, true);
    await service.setDesiredRunning(employee.sessionId, true);
    expect(await service.claimWake(employee.id, employee.sessionId, night, false)).toBe(false);
    await service.configure(undefined, { ...service.view().settings, enabled: true });
    await service.tick();
    expect(backend.start).not.toHaveBeenCalled();
    expect(stopSession).toHaveBeenCalledWith(employee.sessionId);
    const returned = await service.setVacation(employee.id, undefined, false);
    expect(returned).toMatchObject({ id: employee.id, sessionId: employee.sessionId, onVacation: false, desiredRunning: true });
    expect(service.view().memories[0].text).toBe('Durable memory');
    expect(await service.claimWake(employee.id, employee.sessionId, night, false)).toBe(true);
  });

  it('retires a live employee with durable stop intent and preserves memories', async () => {
    const employee = await hire();
    await service.remember(employee.id, undefined, 'Keep this');
    const stopSession = vi.fn(async () => {
      expect(store.snapshot().employees.some((e) => e.id === employee.id)).toBe(false);
      expect(store.snapshot().retired[0].desiredRunning).toBe(false);
    });
    service = new CompanyService(store, { getSession: (id) => sessions.get(id), stopSession,
      chatrooms: { rooms: () => rooms.list(), room: (id) => rooms.get(id), addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member }, research: backend });
    await service.retire(employee.id, undefined);
    expect(stopSession).toHaveBeenCalledWith(employee.sessionId);
    expect(store.snapshot().memories[0].text).toBe('Keep this');
    expect(store.snapshot().retired[0].id).toBe(employee.id);
  });

  it('persists stop intent and retry claims across store reloads without late-observation overwrite', async () => {
    const employee = await hire();
    await service.setDesiredRunning(employee.sessionId, true);
    await service.setDesiredRunning(employee.sessionId, false);
    await service.setDesiredRunning(employee.sessionId, true, () => false);
    const restored = new CompanyStore(join(directory, 'company.json'));
    await restored.init();
    expect(restored.snapshot().employees[0].desiredRunning).toBe(false);
    expect(await service.claimWake(employee.id, employee.sessionId, night)).toBe(false);
    await service.setDesiredRunning(employee.sessionId, true);
    expect(await service.claimWake(employee.id, employee.sessionId, night)).toBe(true);
    await restored.init();
    expect(restored.snapshot().employees[0].wakeAttempts).toEqual([night]);
    expect(restored.snapshot().employees[0].id).toBe(employee.id);
  });

  it('serializes late running observations behind owner stops and keeps explicit starts available', async () => {
    const employee = await hire();
    await store.update((state) => { delete state.employees[0].desiredRunning; });
    const stopped = service.setDesiredRunning(employee.sessionId, false);
    const observed = service.recordObservedRunning(employee.sessionId);
    await Promise.all([stopped, observed]);
    expect(store.snapshot().employees[0].desiredRunning).toBe(false);
    await service.recordObservedRunning(employee.sessionId);
    expect(store.snapshot().employees[0].desiredRunning).toBe(false);
    await service.setDesiredRunning(employee.sessionId, true);
    expect(store.snapshot().employees[0].desiredRunning).toBe(true);
    await store.update((state) => { delete state.employees[0].desiredRunning; });
    await service.recordObservedRunning(employee.sessionId);
    expect(store.snapshot().employees[0].desiredRunning).toBe(true);
  });

  it('validates owner crash selection and allows explicit recovery when automatic wake is disabled', async () => {
    const employee = await hire();
    await expect(service.configure(undefined, { crashWakeEmployeeId: 'missing' } as never)).rejects.toThrow(
      'active company'
    );
    await service.configure(undefined, { autoWakeEnabled: false, crashWakeEmployeeId: employee.id } as never);
    expect(await service.claimWake(employee.id, employee.sessionId, night)).toBe(false);
    expect(await service.claimWake(employee.id, employee.sessionId, night, false)).toBe(true);
    expect(service.view().settings.crashWakeEmployeeId).toBe(employee.id);
  });

  it('requires an explicitly registered owned real session, preserving durable identity', async () => {
    await expect(
      service.hire({
        name: 'Fake',
        icon: '🦊',
        position: 'Expert',
        expertise: ['x'],
        sessionId: 'imaginary',
        researchEnabled: true,
      })
    ).rejects.toThrow('existing session');
    await expect(
      service.hire({
        name: 'Other',
        icon: '🦊',
        position: 'Expert',
        expertise: ['x'],
        sessionId: 'other-main',
        researchEnabled: true,
      })
    ).rejects.toThrow('owned');
    const employee = await hire();
    await expect(hire()).rejects.toThrow('already');
    const loaded = new CompanyStore(store.file);
    await loaded.init();
    expect(loaded.snapshot().employees[0]).toEqual(employee);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it('keeps one person across repeated session replacements: rebinding moves every room seat with the employee', async () => {
    const dmSessions = ['alice-1', 'alice-2', 'alice-3', 'alice-4'];
    for (const id of dmSessions) sessions.set(id, { id, name: 'Alice', owner: undefined });
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        replaceSession: async (oldId, newId, _by, canTouch) =>
          rooms.replaceMember(oldId, newId, rooms.list().filter(canTouch)).map((r) => ({ id: r.id, name: r.name })),
      },
      research: backend,
      now: () => night,
    });
    const alice = await service.hire({
      name: 'Alice',
      icon: '🦊',
      position: 'Local Agent',
      expertise: ['chat'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    const lounge = rooms.create('Lounge', undefined);
    const game = rooms.create('Game', undefined);
    rooms.addMember(lounge.id, 'alice-1');
    rooms.addMember(game.id, 'alice-1', { role: 'coordinator' });
    for (const [from, to] of [
      ['alice-1', 'alice-2'],
      ['alice-2', 'alice-3'],
      ['alice-3', 'alice-4'],
    ]) {
      // A successor started with its parent's header may already sit in a room, empty.
      if (to === 'alice-3') rooms.addMember(lounge.id, to);
      await service.rebind(alice.id, undefined, to);
      expect(service.view().employees.filter((e) => e.name === 'Alice')).toHaveLength(1);
      expect(service.view().employees.find((e) => e.id === alice.id)?.sessionId).toBe(to);
      for (const room of [lounge, game]) {
        const seats = rooms.get(room.id)?.members.map((m) => m.sessionId) ?? [];
        expect(seats).toContain(to);
        expect(seats).not.toContain(from);
        expect(seats.filter((id) => dmSessions.includes(id))).toEqual([to]);
      }
      expect(rooms.get(game.id)?.members.find((m) => m.sessionId === to)?.role).toBe('coordinator');
    }
  });

  it('retires only a gone employee: off the org chart, the CTO seat and every room, kept with history, and restorable', async () => {
    sessions.set('alice-1', { id: 'alice-1', name: 'Alice', owner: undefined });
    const removeMember = vi.fn((id: string, sessionId: string) => rooms.removeMember(id, sessionId));
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        removeMember,
      },
      research: backend,
      now: () => night,
    });
    const alice = await service.hire({
      name: 'Alice',
      icon: '🦉',
      position: 'CTO',
      expertise: ['ops'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    await service.configure(undefined, { ...service.view().settings, coordinatorEmployeeId: alice.id });
    const lounge = rooms.create('Lounge', undefined);
    const other = rooms.create('Other', 'another-owner');
    rooms.addMember(lounge.id, 'alice-1');
    rooms.addMember(other.id, 'alice-1');
    rooms.post(lounge.id, { kind: 'agent', sessionId: 'alice-1', name: 'Alice' }, 'Morning, all');

    await expect(service.retire(alice.id, undefined)).rejects.toMatchObject({ status: 409 });
    expect(service.view().employees.map((e) => e.id)).toContain(alice.id);
    await expect(service.retire('nobody', undefined)).rejects.toMatchObject({ status: 404 });
    await expect(service.retire(alice.id, 'another-owner')).rejects.toMatchObject({ status: 404 });

    sessions.delete('alice-1');
    const { employee, rooms: left, failed } = await service.retire(alice.id, undefined);
    expect(employee).toMatchObject({ id: alice.id, sessionId: 'alice-1', name: 'Alice', retiredAt: night });
    expect(left).toEqual([lounge.id]);
    expect(failed).toEqual([]);
    // History keeps the retired person's name and session on what they said.
    expect(rooms.messages(lounge.id).find((m) => m.text === 'Morning, all')?.from).toMatchObject({
      kind: 'agent',
      sessionId: 'alice-1',
      name: 'Alice',
    });
    expect(service.view().employees.map((e) => e.id)).not.toContain(alice.id);
    expect(service.view().settings.coordinatorEmployeeId).toBeUndefined();
    expect(service.view().retired.map((e) => e.id)).toEqual([alice.id]);
    expect(service.view('another-owner').retired).toEqual([]);
    expect(rooms.get(lounge.id)?.members.map((m) => m.sessionId)).not.toContain('alice-1');
    // Another owner's room is not this owner's to change.
    expect(rooms.get(other.id)?.members.map((m) => m.sessionId)).toContain('alice-1');

    // A second call is harmless: nothing left to remove, the record stays retired once.
    removeMember.mockClear();
    expect((await service.retire(alice.id, undefined)).rooms).toEqual([]);
    expect(removeMember).not.toHaveBeenCalledWith(lounge.id, 'alice-1');
    expect(store.snapshot().retired).toHaveLength(1);

    const back = await service.restore(alice.id, undefined);
    expect(back).not.toHaveProperty('retiredAt');
    expect(service.view().employees.map((e) => e.id)).toContain(alice.id);
    expect(service.view().retired).toEqual([]);
    await expect(service.restore(alice.id, undefined)).rejects.toMatchObject({ status: 404 });
  });

  it('reports a room it could not leave and retries it on the next call', async () => {
    sessions.set('alice-1', { id: 'alice-1', name: 'Alice', owner: undefined });
    let refuse = true;
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        removeMember: (id, sessionId) => {
          if (refuse) throw new Error('store busy');
          return rooms.removeMember(id, sessionId);
        },
      },
      research: backend,
      now: () => night,
    });
    const alice = await service.hire({
      name: 'Alice',
      icon: '🦉',
      position: 'Ops',
      expertise: ['ops'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    const lounge = rooms.create('Lounge', undefined);
    rooms.addMember(lounge.id, 'alice-1');
    sessions.delete('alice-1');
    expect(await service.retire(alice.id, undefined)).toMatchObject({ rooms: [], failed: [lounge.id] });
    expect(service.view().employees.map((e) => e.id)).not.toContain(alice.id);
    refuse = false;
    expect(await service.retire(alice.id, undefined)).toMatchObject({ rooms: [lounge.id], failed: [] });
    expect(rooms.get(lounge.id)?.members.map((m) => m.sessionId)).not.toContain('alice-1');
  });

  it('refuses to restore a retired employee whose name another employee now has', async () => {
    sessions.set('alice-1', { id: 'alice-1', name: 'Alice', owner: undefined });
    sessions.set('alice-2', { id: 'alice-2', name: 'Alice', owner: undefined });
    const alice = await service.hire({
      name: 'Alice',
      icon: '🦉',
      position: 'Ops',
      expertise: ['ops'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    sessions.delete('alice-1');
    await service.retire(alice.id, undefined);
    await service.hire({
      name: 'alice',
      icon: '🌱',
      position: 'Ops',
      expertise: ['ops'],
      sessionId: 'alice-2',
      researchEnabled: false,
    });
    await expect(service.restore(alice.id, undefined)).rejects.toMatchObject({ status: 409 });
    expect(service.view().retired.map((e) => e.id)).toEqual([alice.id]);
  });

  it('refuses to restore a retired employee whose session another employee now holds', async () => {
    sessions.set('alice-1', { id: 'alice-1', name: 'Alice', owner: undefined });
    const alice = await service.hire({
      name: 'Alice',
      icon: '🦉',
      position: 'Ops',
      expertise: ['ops'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    sessions.delete('alice-1');
    await service.retire(alice.id, undefined);
    sessions.set('alice-1', { id: 'alice-1', name: 'Nora', owner: undefined });
    await service.hire({
      name: 'Nora',
      icon: '🌱',
      position: 'Ops',
      expertise: ['ops'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    await expect(service.restore(alice.id, undefined)).rejects.toMatchObject({ status: 409 });
    expect(service.view().retired.map((e) => e.id)).toEqual([alice.id]);
  });

  it("never lets a new session take an employee's name; a replacement names the employee id and takes over", async () => {
    for (const id of ['alice-1', 'alice-2', 'alice-3']) sessions.set(id, { id, name: 'Alice', owner: undefined });
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        replaceSession: async (oldId, newId, _by, canTouch) =>
          rooms.replaceMember(oldId, newId, rooms.list().filter(canTouch)).map((r) => ({ id: r.id, name: r.name })),
      },
      research: backend,
      now: () => night,
    });
    const alice = await service.hire({
      name: 'Alice',
      icon: '🦊',
      position: 'Local Agent',
      expertise: ['chat'],
      sessionId: 'alice-1',
      researchEnabled: false,
    });
    const lounge = rooms.create('Lounge', undefined);
    rooms.addMember(lounge.id, 'alice-1');
    // By name alone: refused, in any case, whoever asks.
    expect(() => service.prepareSpawn({ owner: undefined, name: 'alice' })).toThrow('existing employee');
    expect(() => service.prepareSpawn({ owner: undefined, parentSessionId: 'parent-agent', name: 'Alice' })).toThrow(
      'existing employee'
    );
    // An unrelated agent may not replace her; the owner may, and so may her own current session.
    expect(() =>
      service.prepareSpawn({ owner: undefined, parentSessionId: 'parent-agent', employeeId: alice.id })
    ).toThrow('own session');
    expect(() => service.prepareSpawn({ owner: undefined, employeeId: 'nobody' })).toThrow('Unknown employee');
    for (const [parent, to] of [
      [undefined, 'alice-2'],
      ['alice-2', 'alice-3'],
    ] as const) {
      const plan = service.prepareSpawn({ owner: undefined, parentSessionId: parent, employeeId: alice.id });
      expect(plan.name).toBe('Alice');
      await service.completeSpawn(to, plan);
      expect(service.view().employees).toHaveLength(1);
      expect(service.view().employees[0].sessionId).toBe(to);
      expect(service.view().temporaryAgents.filter((a) => a.name === 'Alice')).toHaveLength(0);
      expect(rooms.get(lounge.id)?.members.map((m) => m.sessionId)).toEqual([to]);
    }
  });

  it('invites a registered expert only for owned rooms and authorized member agents', async () => {
    const employee = await hire();
    const room = rooms.create('Research', undefined);
    expect(() => service.invite(employee.id, room.id, undefined, 'parent-agent')).toThrow('room member');
    rooms.addMember(room.id, 'parent-agent');
    service.invite(employee.id, room.id, undefined, 'parent-agent');
    expect(room.members.find((m) => m.sessionId === 'expert-main')?.icon).toBe('🔭');
    // An agent's invite is marked as its own (owner sign-in does not count it as an owner-made seat).
    expect(room.members.find((m) => m.sessionId === 'expert-main')?.addedBy).toBe('parent-agent');
    expect(() => service.invite(employee.id, room.id, 'another-owner')).toThrow('Unknown');
  });

  it('reports a refused room join as a client error and records no worker for it', async () => {
    const employee = await hire();
    const room = rooms.create('Closed', undefined);
    rooms.addMember(room.id, 'parent-agent');
    rooms.archive(room.id, true);
    let invited: unknown;
    try {
      service.invite(employee.id, room.id, undefined, 'parent-agent');
    } catch (error) {
      invited = error;
    }
    expect(invited).toBeInstanceOf(CompanyError);
    expect((invited as CompanyError).status).toBe(409);
    await expect(
      service.completeSpawn('child', { channelId: room.id, name: 'Kept', icon: '🎨' })
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(store.snapshot().temporaryAgents.some((a) => a.sessionId === 'child')).toBe(false);
  });

  it('refuses a new worker at the 500-record cap and never drops an existing record to make room', async () => {
    const room = rooms.create('One', undefined);
    rooms.addMember(room.id, 'parent-agent');
    await store.update((state) => {
      for (let i = 0; i < 500; i++)
        state.temporaryAgents.push({ sessionId: `old-${i}`, name: 'Old', icon: '🎨', createdAt: i });
    });
    expect(() => service.prepareSpawn({ parentSessionId: 'parent-agent' })).toThrow('Profile limit');
    await expect(service.completeSpawn('child', { channelId: room.id, name: 'New', icon: '🎨' })).rejects.toMatchObject(
      {
        status: 409,
      }
    );
    expect(room.members.some((m) => m.sessionId === 'child')).toBe(false);
    expect(store.snapshot().temporaryAgents.map((a) => a.sessionId)).toEqual(
      Array.from({ length: 500 }, (_, i) => `old-${i}`)
    );
    // Re-recording a session already on the list is not a new record, so it still succeeds at the cap.
    await service.completeSpawn('old-7', { name: 'Renamed', icon: '🎨' });
    expect(store.snapshot().temporaryAgents).toHaveLength(500);
    expect(store.snapshot().temporaryAgents.find((a) => a.sessionId === 'old-7')?.name).toBe('Renamed');
  });

  it('inherits a unique active channel, preserves explicit identity, and refuses unauthorized channels', async () => {
    const one = rooms.create('One', undefined);
    rooms.addMember(one.id, 'parent-agent');
    const plan = service.prepareSpawn({ parentSessionId: 'parent-agent', name: 'Chosen', icon: '🎨' });
    expect(plan).toEqual({ name: 'Chosen', icon: '🎨', channelId: one.id });
    await service.completeSpawn('child', plan);
    expect(one.members.find((m) => m.sessionId === 'child')?.icon).toBe('🎨');
    const two = rooms.create('Two', undefined);
    expect(() => service.prepareSpawn({ parentSessionId: 'parent-agent', channelId: two.id })).toThrow('parent');
    rooms.addMember(two.id, 'parent-agent');
    expect(service.prepareSpawn({ parentSessionId: 'parent-agent' }).channelId).toBeUndefined();
    expect(service.prepareSpawn({ parentSessionId: 'parent-agent', channelId: two.id }).channelId).toBe(two.id);
    expect(service.prepareSpawn({}).name).toMatch(/^Agent [a-f0-9]{8}$/);
    expect(service.prepareSpawn({}).icon).toBeTruthy();
  });

  it('does no autonomous work before explicit owner opt-in', async () => {
    await hire();
    await service.tick(night);
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('persists claims before launch and resumes once across restart, never using the main session', async () => {
    const employee = await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
      coordinatorEmployeeId: employee.id,
    });
    await Promise.all([service.tick(night), service.tick(night)]);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(store.file, 'utf8')).cycles[0].state).toBe('running');
    store = new CompanyStore(store.file);
    await store.init();
    service = createService();
    await service.tick(night + 1000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(service.view().cycles[0].sessionId).not.toBe('expert-main');
  });

  it('recovers uncertain launch failure through the same persisted claim', async () => {
    await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
    });
    const start = backend.start;
    backend.start = vi.fn(async (input) => {
      await start(input);
      throw new Error('process interrupted after launch');
    });
    await expect(service.tick(night)).rejects.toThrow('interrupted');
    expect(store.snapshot().cycles[0].state).toBe('claimed');
    backend.start = start;
    await service.tick(night + 1000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(store.snapshot().cycles).toHaveLength(1);
  });

  it('enforces budget only on dedicated owned research sessions and reports expiry honestly', async () => {
    await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
    });
    await service.tick(night);
    const cycle = store.snapshot().cycles[0];
    await service.tick(night + 3600000);
    expect(backend.stop).toHaveBeenCalledWith(cycle.id);
    expect(store.snapshot().cycles[0].state).toBe('expired');
    expect(store.snapshot().cycles[0].result).toBeUndefined();
    expect(store.snapshot().memories).toHaveLength(0);
  });

  it('refuses backend reuse of an employee main session without ever stopping it', async () => {
    await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
    });
    await service.tick(night);
    const handle = [...handles.values()][0];
    handle.sessionId = 'expert-main';
    await expect(service.tick(night + 3600000)).rejects.toThrow('unsafe');
    expect(backend.stop).not.toHaveBeenCalled();
  });

  it('accepts only actual structured completion, then launches one real company briefing after morning', async () => {
    const employee = await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
      coordinatorEmployeeId: employee.id,
    });
    await service.tick(night);
    Object.assign([...handles.values()][0], { state: 'completed', result });
    await service.tick(night + 1000);
    expect(service.view().cycles[0].result).toEqual(result);
    await service.tick(Date.parse('2026-10-15T08:00:00Z'));
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(store.snapshot().cycles[1].kind).toBe('briefing');
    Object.assign([...handles.values()][1], {
      state: 'completed',
      result: { summary: 'company briefing of observed prototype results', findings: [] },
    });
    await service.tick(Date.parse('2026-10-15T08:01:00Z'));
    await service.tick(Date.parse('2026-10-15T09:00:00Z'));
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(store.snapshot().memories).toHaveLength(2);
  });

  it('rejects an observed report with no evidence rather than fabricating success', async () => {
    await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
    });
    await service.tick(night);
    Object.assign([...handles.values()][0], {
      state: 'completed',
      result: { summary: 'Claim', findings: [{ text: 'Proved everything', status: 'observed', evidence: [] }] },
    });
    await service.tick(night + 1000);
    expect(store.snapshot().cycles[0].state).toBe('failed');
    expect(store.snapshot().cycles[0].result).toBeUndefined();
  });

  it('keeps imagination out of research context and retains persistent company notes separately', async () => {
    const employee = await hire();
    await service.remember(employee.id, undefined, 'PRIVATE_DREAM_MARKER', 'imagination');
    await service.remember(employee.id, undefined, 'Useful owner note');
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
    });
    await service.tick(night);
    const prompt = vi.mocked(backend.start).mock.calls[0][0].prompt;
    expect(prompt).toContain('Useful owner note');
    expect(prompt).not.toContain('PRIVATE_DREAM_MARKER');
  });

  it('does not reset corrupted durable state or commit a partial failing mutation', async () => {
    await hire();
    await expect(
      store.update((state) => {
        state.employees = [];
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');
    expect(store.snapshot().employees).toHaveLength(1);
    await writeFile(store.file, 'corrupted');
    await expect(new CompanyStore(store.file).init()).rejects.toThrow();
  });
});
