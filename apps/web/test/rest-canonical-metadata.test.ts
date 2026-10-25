/** Actual CompanyStore, StateStore and SessionManager; only process-backed Session is a no-I/O test double. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { CompanyService } from '../src/company-service.js';
import { createGoalServerAssembly, type GoalServerProvisioning } from '../src/goal-server-assembly.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema, type CompanyState } from '../src/company-types.js';
import { CanonicalRestMetadataReader, restSessionMetadataFromRegistry } from '../src/rest-canonical-metadata.js';
import { CanonicalRecoveryAuthority } from '../src/recovery-authority.js';
import { SessionManager } from '../src/session-manager.js';
import { getStore } from '../src/state-store.js';

vi.mock('../src/session.js', () => ({
  Session: class extends EventEmitter {
    id = '11111111-1111-4111-8111-111111111111';
    owner: string | undefined = 'owner:1';
    async start() {}
    async stop() {
      this.emit('exit');
    }
    getEnvOverridesForPersist() {
      return undefined;
    }
    getCustomModelForPersist() {
      return undefined;
    }
    toState() {
      return { id: this.id, owner: this.owner, status: 'stopped', pid: null };
    }
  },
}));

const sid = '11111111-1111-4111-8111-111111111111';
let root: string;
let directory: string;
let store: CompanyStore;
let manager: SessionManager;
let reader: CanonicalRestMetadataReader;
let target: ReturnType<SessionManager['getSession']>;
let internal: CompanyState;
let company: { store: CompanyStore };
let calls: string[];
const owner = 'owner:1';
const employee = 'employee:1';
const secret = 'PRIVATE_MEMORY_PROFILE_PROMPT_CODE_SENTINEL';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rest-real-canonical-'));
  getStore(join(root, 'sessions.json')); // The real singleton is confined to this owned test directory.
});
beforeEach(async () => {
  directory = await mkdtemp(join(root, 'case-'));
  store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  await store.update((state) => {
    state.employees.push(
      EmployeeSchema.parse({
        id: employee,
        owner,
        sessionId: sid,
        name: secret,
        icon: 'X',
        position: secret,
        expertise: [secret],
        personality: secret,
        createdAt: 1,
        desiredRunning: true,
        sleepEnabled: true,
        dreamEnabled: true,
      })
    );
    state.memories.push({ id: 'memory:1', employeeId: employee, at: 1, kind: 'note', text: secret });
    internal = state;
  });
  manager = new SessionManager();
  target = await manager.createSession(directory); // Only the mocked Session starts; no PTY/model/transport.
  company = { store };
  calls = [];
  reader = new CanonicalRestMetadataReader({
    company,
    sessions: manager,
    custody: {
      assertPrivateCustody(file) {
        calls.push(file);
        if (file !== company.store.file || !file.startsWith(root + '/')) throw Error('unowned');
        const info = statSync(file);
        if (!info.isFile() || (info.mode & 0o077) !== 0) throw Error('not private');
      },
    },
  });
});
afterEach(async () => {
  await manager.stopAllSessions();
  getStore().flushAll();
  vi.restoreAllMocks();
});
afterAll(async () => {
  getStore().flushAll();
  await rm(root, { recursive: true, force: true });
});
const observe = () => reader.observe(owner, employee);
const unavailable = () => expect(observe()).toMatchObject({ code: 'REST_CANONICAL_UNAVAILABLE', metadata: null });

describe('actual canonical REST scalar projection', () => {
  it('reads real company and manager scalars, preserves exact17-field recovery shape with unknowns', () => {
    const result = observe();
    expect(result).toMatchObject({
      stage: 'REPORT_ONLY',
      adapterStatus: 'UNAVAILABLE',
      authorization: 'UNPROVEN',
      automaticAction: 'NONE',
      code: 'REST_CANONICAL_INCOMPLETE',
      metadata: {
        employeeId: employee,
        ownerId: owner,
        sessionId: sid,
        desiredRunning: true,
        vacation: false,
        goalId: null,
        goalGeneration: null,
        sessionGeneration: null,
        transitionSequence: null,
        revision: null,
        goalState: null,
        sleeping: null,
        pendingInput: null,
        dialog: null,
        activeJobs: null,
        activeTurn: null,
        toolWait: null,
      },
      eligibility: { sleepEnabled: true, dreamEnabled: true },
    });
    expect(Object.keys(result.metadata!)).toHaveLength(17);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metadata)).toBe(true);
    expect(Object.isFrozen(result.eligibility)).toBe(true);
    expect(calls).toHaveLength(3);
  });
  it('does not snapshot or enumerate private profile, memory, output or runtime-state content', () => {
    vi.spyOn(store, 'snapshot').mockImplementation(() => {
      throw Error('full snapshot');
    });
    for (const [object, keys] of [
      [internal, ['memories', 'settings', 'cycles']],
      [internal.employees[0]!, ['personality', 'name', 'expertise', 'runtimeRecipe', 'threadId']],
      [target!, ['toState', 'getOutput', 'getError', 'isBusy', 'isRunning', 'getEnvOverridesForPersist']],
    ] as const)
      for (const key of keys)
        Object.defineProperty(object, key, {
          configurable: true,
          get() {
            throw Error('private access');
          },
        });
    const result = observe();
    expect(result.code).toBe('REST_CANONICAL_INCOMPLETE');
    expect(JSON.stringify(result)).not.toContain(secret);
    // Restore only lifecycle serialization needed by test cleanup.
    Object.defineProperty(target!, 'toState', { value: () => ({ id: sid, owner, status: 'stopped', pid: null }) });
    Object.defineProperty(target!, 'getEnvOverridesForPersist', { value: () => undefined });
  });
  it('cannot supply accepted recovery authority even with synthetic grant/frozen ports', async () => {
    const frozen = vi.fn();
    const authority = new CanonicalRecoveryAuthority({
      authenticate: async () => ({ kind: 'RESUME_SERVICE', ownerId: owner, current: () => true }),
      read: reader.recoveryRead,
      frozen,
    });
    expect(await authority.prepare({}, employee)).toBeNull();
    expect(frozen).not.toHaveBeenCalled();
    expect(reader.recoveryRead(owner, employee)).toBeNull();
  });
  it('reopens the real persisted company store without changing private bytes or file metadata', async () => {
    const before = await readFile(store.file);
    const beforeStat = await stat(store.file, { bigint: true });
    const previous = observe();
    const reopened = new CompanyStore(store.file);
    await reopened.init();
    company.store = reopened;
    expect(observe()).toEqual(previous);
    expect(await readFile(store.file)).toEqual(before);
    const afterStat = await stat(store.file, { bigint: true });
    expect([afterStat.ino, afterStat.mtimeNs, afterStat.ctimeNs, afterStat.size]).toEqual([
      beforeStat.ino,
      beforeStat.mtimeNs,
      beforeStat.ctimeNs,
      beforeStat.size,
    ]);
    expect(reopened.snapshot().memories[0]!.text).toBe(secret);
    expect(reopened.snapshot().employees[0]!.personality).toBe(secret);
  });
  it('observes committed OFF/vacation/preferences through the same store and after reopen', async () => {
    await store.update((state) => {
      Object.assign(state.employees[0]!, {
        desiredRunning: false,
        onVacation: true,
        sleepEnabled: false,
        dreamEnabled: false,
      });
    });
    expect(observe()).toMatchObject({
      metadata: { desiredRunning: false, vacation: true },
      eligibility: { sleepEnabled: false, dreamEnabled: false },
    });
    company.store = new CompanyStore(store.file);
    await company.store.init();
    expect(observe()).toMatchObject({
      metadata: { desiredRunning: false, vacation: true },
      eligibility: { sleepEnabled: false, dreamEnabled: false },
    });
    expect(reader.recoveryRead(owner, employee)).toBeNull();
  });
  it('does not turn missing running intent into true', async () => {
    await store.update((state) => {
      delete state.employees[0]!.desiredRunning;
    });
    expect(observe().metadata?.desiredRunning).toBeNull();
  });
  it('reflects current session-owner changes rather than reusing a previous positive observation', () => {
    expect(observe().metadata).not.toBeNull();
    target!.owner = 'owner:other';
    unavailable();
    target!.owner = owner;
    expect(observe().metadata).not.toBeNull();
  });
  it('refuses absent sessions and current registry removal', async () => {
    await manager.stopSession(sid);
    unavailable();
  });
  it('refuses current company owner rebinding', async () => {
    await store.update((state) => {
      state.employees[0]!.owner = 'owner:other';
    });
    unavailable();
  });
  it('refuses ambiguous employee identity without exposing the duplicate profile', async () => {
    await store.update((state) => {
      state.employees.push({ ...state.employees[0]!, sessionId: '22222222-2222-4222-8222-222222222222' });
    });
    unavailable();
  });
  it('refuses cross-owner duplicate session binding', async () => {
    await store.update((state) => {
      state.employees.push({ ...state.employees[0]!, id: 'employee:2', owner: 'owner:other' });
    });
    unavailable();
  });
  it('never exposes an ownerless employee to a named owner or invents an owner ID', async () => {
    await store.update((state) => {
      delete state.employees[0]!.owner;
    });
    target!.owner = undefined;
    unavailable();
    expect(reader.observe(undefined, employee).metadata?.ownerId).toBeNull();
    expect(reader.recoveryRead(owner, employee)).toBeNull();
  });
  it.each(['', 'x'.repeat(101), 'owner prose', 'owner\n'])('rejects noncanonical owner without echo: %j', (bad) => {
    const result = reader.observe(bad, employee);
    expect(result.metadata).toBeNull();
    expect(result.code).toBe('REST_CANONICAL_UNAVAILABLE');
  });
  it('refuses missing custody and refuses asynchronous custody before source reads', () => {
    expect(new CanonicalRestMetadataReader().observe(owner, employee).metadata).toBeNull();
    const selected = vi.spyOn(store, 'restEmployeeMetadata');
    const bad = new CanonicalRestMetadataReader({
      company,
      sessions: manager,
      custody: { assertPrivateCustody: (() => Promise.resolve()) as never },
    });
    expect(bad.observe(owner, employee).metadata).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });
  it('refuses revoked custody at the final fence without leaking data or exception text', () => {
    let count = 0;
    const bad = new CanonicalRestMetadataReader({
      company,
      sessions: manager,
      custody: {
        assertPrivateCustody() {
          if (++count === 3) throw Error(secret);
        },
      },
    });
    expect(bad.observe(owner, employee)).toMatchObject({ metadata: null, code: 'REST_CANONICAL_UNAVAILABLE' });
    expect(JSON.stringify(bad.observe(owner, employee))).not.toContain(secret);
  });
  it('detects a canonical-store replacement during its read instead of merging two sources', () => {
    const other = new CompanyStore(join(directory, 'other.json'));
    let count = 0;
    const bad = new CanonicalRestMetadataReader({
      company,
      sessions: manager,
      custody: {
        assertPrivateCustody() {
          if (++count === 2) company.store = other;
        },
      },
    });
    expect(bad.observe(owner, employee).metadata).toBeNull();
  });
  it('never reads or invents future generation fields on the current schema', () => {
    Object.defineProperty(internal.employees[0]!, 'sessionGeneration', {
      get() {
        throw Error('fabricated generation');
      },
    });
    expect(observe().metadata?.sessionGeneration).toBeNull();
  });
  it('requires a reopened canonical instance to see external disk changes; it never claims cross-process authority', async () => {
    const disk = JSON.parse(await readFile(store.file, 'utf8'));
    disk.employees[0].desiredRunning = false;
    await writeFile(store.file, JSON.stringify(disk)); // Owned fixture only, simulates another writer.
    expect(observe().metadata?.desiredRunning).toBe(true); // Existing store cache, explicitly NOT authority.
    expect(reader.recoveryRead(owner, employee)).toBeNull();
    company.store = new CompanyStore(store.file);
    await company.store.init();
    expect(observe().metadata?.desiredRunning).toBe(false);
    expect(reader.recoveryRead(owner, employee)).toBeNull();
  });
});

describe('same canonical Goal/service/registry composition (synthetic owner fixture only)', () => {
  async function compose() {
    const auth = {
      authenticate: async (context: unknown) =>
        context === 'synthetic-owner' ? { kind: 'owner' as const, owner } : undefined,
      assertCurrent: (_principal: unknown, context: unknown) => {
        if (context !== 'synthetic-owner') throw Error('refused');
      },
      assertPrivateCustody: (file: string) => {
        if (file !== store.file) throw Error('custody');
      },
    };
    const service = new CompanyService(store, {
      goalAuthentication: auth,
      getSession: (id) => manager.getSession(id),
      chatrooms: {
        rooms: () => [],
        room: () => undefined,
        addMember: () => {
          throw Error('no effect');
        },
        setStatus: () => {
          throw Error('no effect');
        },
      },
      research: {
        inspect: async () => undefined,
        start: async () => {
          throw Error('no effect');
        },
        stop: async () => {
          throw Error('no effect');
        },
      },
    });
    const ownerService = new OwnerAuthService({
      store: new OwnerAuthStore(join(directory, 'owner.json')),
      auditFile: join(directory, 'audit.jsonl'),
    });
    const configuration: GoalServerProvisioning = {
      kind: 'canonical-goal-provisioning',
      mode: 'owner-only',
      custody: auth,
      get issuer(): never {
        throw Error('employee issuer read');
      },
      get nonce(): never {
        throw Error('employee nonce read');
      },
    };
    const assembly = createGoalServerAssembly(ownerService, store.file, configuration);
    expect(assembly.restMetadataReader.observe(owner, employee).metadata).toBeNull();
    assembly.attach(service, manager, { isRetired: () => false });
    const goal = await service.goals.create(
      {
        createId: 'canonical-create',
        employeeId: employee,
        sessionId: sid,
        sessionGeneration: 1,
        objective: secret,
        nextAction: secret,
      },
      'synthetic-owner'
    );
    return { assembly, service, goal };
  }
  it('reports only actual canonical Goal scalars through the same service and actual manager', async () => {
    const { assembly, service, goal } = await compose();
    expect(service.store).toBe(store);
    vi.spyOn(store, 'snapshot').mockImplementation(() => {
      throw Error('private clone');
    });
    const report = assembly.restMetadataReader.observe(owner, employee);
    expect(report).toMatchObject({
      automaticAction: 'NONE',
      adapterStatus: 'UNAVAILABLE',
      metadata: {
        goalId: goal.id,
        goalGeneration: goal.generation,
        goalState: 'READY',
        transitionSequence: 0,
        sessionGeneration: null,
        revision: null,
        activeJobs: null,
        sleeping: null,
      },
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(assembly.restMetadataReader.recoveryRead(owner, employee)).toBeNull();
  });
  it('reflects canonical transitions but refuses registry removal and never infers ACTIVE/FROZEN', async () => {
    const { assembly, service, goal } = await compose();
    await service.goals.transition(
      {
        goalId: goal.id,
        generation: goal.generation,
        expectedState: 'READY',
        expectedSequence: 0,
        sessionId: sid,
        sessionGeneration: 1,
        transitionId: 'assigned',
        to: 'ASSIGNED',
        nextAction: secret,
      },
      'synthetic-owner'
    );
    expect(assembly.restMetadataReader.observe(owner, employee).metadata).toMatchObject({
      goalState: 'ASSIGNED',
      transitionSequence: 1,
      sleeping: null,
    });
    await manager.stopSession(sid);
    expect(assembly.restMetadataReader.observe(owner, employee).metadata).toBeNull();
    expect(assembly.restMetadataReader.recoveryRead(owner, employee)).toBeNull();
  });
  it('drops Goal fields on external store drift and restores only after ordinary store reopen', async () => {
    const { assembly } = await compose();
    const disk = await readFile(store.file, 'utf8');
    await writeFile(store.file, disk + ' ');
    expect(assembly.restMetadataReader.observe(owner, employee).metadata?.goalId).toBeNull();
    await store.init();
    expect(assembly.restMetadataReader.observe(owner, employee).metadata?.goalId).not.toBeNull();
  });
  it('refuses custody revocation on the same attachment without reading employee signer ports', async () => {
    const { assembly, service } = await compose();
    vi.spyOn(store, 'restGoalMetadata').mockImplementation(() => {
      throw Error('revoked');
    });
    expect(assembly.restMetadataReader.observe(owner, employee).metadata).toBeNull();
    expect(() => assembly.attach(service, manager, { isRetired: () => false })).toThrow();
  });
  it('never selects a guessed latest Goal when two canonical Goals match the employee/session', async () => {
    const { assembly, service } = await compose();
    await service.goals.create(
      {
        createId: 'second-create',
        employeeId: employee,
        sessionId: sid,
        sessionGeneration: 1,
        objective: secret,
        nextAction: secret,
      },
      'synthetic-owner'
    );
    expect(assembly.restMetadataReader.observe(owner, employee).metadata).toMatchObject({
      goalId: null,
      goalGeneration: null,
      transitionSequence: null,
      goalState: null,
    });
    expect(assembly.restMetadataReader.recoveryRead(owner, employee)).toBeNull();
  });
  it('projects the actual WebServer-style Map with no output/process or stale-object fallback', () => {
    const record = {
      id: sid,
      owner,
      get output(): never {
        throw Error('private');
      },
    };
    const registry = new Map([[sid, record]]);
    expect(restSessionMetadataFromRegistry(registry, sid)).toEqual({ sessionId: sid, ownerId: owner });
    registry.delete(sid);
    expect(restSessionMetadataFromRegistry(registry, sid)).toBeUndefined();
    registry.set(sid, {
      id: 'different',
      owner,
      get output(): never {
        throw Error('private');
      },
    });
    expect(restSessionMetadataFromRegistry(registry, sid)).toBeUndefined();
  });
  it('does not touch canonical Goal objectives, actions, evidence or transition bodies while reporting', async () => {
    const { assembly } = await compose();
    let privateGoal: object | undefined;
    await store.update((state) => {
      privateGoal = state.goals[0];
    });
    for (const key of ['objective', 'nextAction', 'evidenceRefs', 'transitions', 'creation'])
      Object.defineProperty(privateGoal!, key, {
        configurable: true,
        get() {
          throw Error('private Goal content');
        },
      });
    vi.spyOn(store, 'snapshot').mockImplementation(() => {
      throw Error('whole store clone');
    });
    expect(assembly.restMetadataReader.observe(owner, employee).metadata).toMatchObject({
      goalState: 'READY',
      goalGeneration: 1,
      sessionGeneration: null,
    });
    expect(assembly.restMetadataReader.recoveryRead(owner, employee)).toBeNull();
  });
});
