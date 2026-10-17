import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/company-store.js';
import { CompanyError, CompanyService, type CompanyResearchBackend, type ResearchHandle } from '../src/company-service.js';
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
      name: 'Ada',
      icon: '🔭',
      position: 'Research scientist',
      expertise: ['systems'],
      sessionId: 'expert-main',
      researchEnabled: true,
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fleet-company-'));
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
    await expect(service.completeSpawn('child', { channelId: room.id, name: 'Kept', icon: '🎨' })).rejects.toMatchObject({
      status: 409,
    });
    expect(store.snapshot().temporaryAgents.some((a) => a.sessionId === 'child')).toBe(false);
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
    expect(service.prepareSpawn({}).name).toMatch(/^[A-Za-z]+$/);
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
      ctoId: employee.id,
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

  it('accepts only actual structured completion, then launches one real CTO briefing after morning', async () => {
    const employee = await hire();
    await service.configure(undefined, {
      enabled: true,
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 60,
      briefingMinutes: 10,
      ctoId: employee.id,
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
      result: { summary: 'CTO briefing of observed prototype results', findings: [] },
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
