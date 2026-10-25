import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServerHealthMetadataProvider } from '../src/session-health-provider.js';
const sid = '11111111-2222-3333-4444-555555555555';
const now = 100000;
function fixture() {
  const e = {
    id: 'employee:review.1',
    sessionId: sid,
    sessionGeneration: 7,
    owner: 'a',
    desiredRunning: true,
    onVacation: false,
  };
  const binding = () => ({
    owner: e.owner,
    employeeId: e.id,
    sessionId: e.sessionId,
    sessionGeneration: e.sessionGeneration,
  });
  const runtime = {
    id: sid,
    owner: 'a',
    get terminalBuffer() {
      throw Error('CONTENT_READ');
    },
    get status() {
      throw Error('DISPLAY_READ');
    },
    isRunning() {
      throw Error('PROCESS_CALL');
    },
  };
  const after = {
    sessionId: sid,
    sessionGeneration: 7,
    generation: 2,
    state: 'ACTIVE',
    transitionSequence: 1,
    semanticProgressAt: 99900,
    updatedAt: 99900,
  };
  const g = {
    id: 'project:goal.1',
    employeeId: e.id,
    owner: 'a',
    ...after,
    objective: 'SECRET_OBJECTIVE',
    nextAction: 'SECRET_NEXT',
    transitions: [{ sequence: 1, generation: 2, after }],
  };
  const store = { employees: [e], goals: [g] };
  const ports = {
    authority: { metadataBinding: binding },
    canonical: () => store,
    session: () => runtime,
    now: () => now,
  };
  return { e, g, runtime, ports, store, provider: new ServerHealthMetadataProvider(ports) };
}
describe('actual canonical server metadata projection', () => {
  it('reads canonical generation/Goal receipt scalars without terminal/display/process calls or content', () => {
    const f = fixture();
    const data = f.provider.read(sid);
    expect(data).toMatchObject({
      employeeId: f.e.id,
      sessionGeneration: 7,
      goal: { id: f.g.id, generation: 2 },
      semanticProgressAtMs: 99900,
      progressSource: 'CANONICAL_GOAL_RECEIPT',
      process: 'UNKNOWN',
      pending: 'UNKNOWN',
      classification: 'AMBIGUOUS',
      automaticAction: 'NONE',
    });
    expect(JSON.stringify(data)).not.toMatch(/SECRET|objective|nextAction|owner|terminal/);
    expect(JSON.stringify(data).length).toBeLessThan(2048);
  });
  it('refuses absent accepted authority and never allocates a generation', () => {
    const f = fixture();
    expect(() => new ServerHealthMetadataProvider({ ...f.ports, authority: undefined }).read(sid)).toThrow();
    delete (f.e as Partial<typeof f.e>).sessionGeneration;
    expect(() => f.provider.read(sid)).toThrow();
  });
  it.each(['duplicateSession', 'duplicateEmployee', 'migration', 'foreignOwner', 'foreignBinding', 'replacement'])(
    'refuses %s',
    (kind) => {
      const f = fixture();
      if (kind === 'duplicateSession') f.store.employees.push({ ...f.e, id: 'other' });
      if (kind === 'duplicateEmployee') f.store.employees.push({ ...f.e, sessionId: 'other' });
      if (kind === 'migration') Object.assign(f.e, { bindingMigration: { id: 'pending' } });
      if (kind === 'foreignOwner') f.e.owner = 'other';
      if (kind === 'foreignBinding') f.ports.authority.metadataBinding = () => ({ ...f.e, employeeId: 'other' });
      if (kind === 'replacement') {
        let calls = 0;
        f.ports.session = () => (++calls === 1 ? f.runtime : Object.create(f.runtime));
      }
      expect(() => f.provider.read(sid)).toThrow();
    }
  );
  it.each(['stale', 'future', 'noReceipt', 'receiptGeneration', 'receiptSession', 'receiptState', 'receiptSequence'])(
    'leaves %s progress unknown',
    (kind) => {
      const f = fixture();
      if (kind === 'stale') f.g.semanticProgressAt = 1;
      if (kind === 'future') f.g.semanticProgressAt = now + 1;
      if (kind === 'noReceipt') f.g.transitions = [];
      if (kind === 'receiptGeneration') f.g.transitions[0]!.generation++;
      if (kind === 'receiptSession') f.g.transitions[0]!.after.sessionId = 'other';
      if (kind === 'receiptState') f.g.transitions[0]!.after.state = 'HOLD';
      if (kind === 'receiptSequence') f.g.transitions[0]!.sequence++;
      expect(f.provider.read(sid)).toMatchObject({
        semanticProgressAtMs: null,
        progressSource: 'UNKNOWN',
        automaticAction: 'NONE',
      });
    }
  );
  it.each(['goalGeneration', 'goalOwner', 'multipleGoals', 'malformedGoal'])(
    'leaves %s Goal binding unknown',
    (kind) => {
      const f = fixture();
      if (kind === 'goalGeneration') f.g.sessionGeneration++;
      if (kind === 'goalOwner') f.g.owner = 'other';
      if (kind === 'multipleGoals') f.store.goals.push({ ...f.g, id: 'other' });
      if (kind === 'malformedGoal') f.g.state = 'NOT_A_STATE';
      expect(f.provider.read(sid)).toMatchObject({ goal: null, semanticProgressAtMs: null, automaticAction: 'NONE' });
    }
  );
  it('rechecks accepted binding after snapshot projection and rejects a generation race', () => {
    const f = fixture();
    let calls = 0;
    f.ports.authority.metadataBinding = () => ({
      ...f.e,
      employeeId: f.e.id,
      sessionGeneration: ++calls === 1 ? 7 : 8,
    });
    expect(() => f.provider.read(sid)).toThrow();
  });
});

// Exercise the actual store's projection against a synthetic accepted-Goal-shaped state.
// Poison content accessors make accidental clone/prose/memory reads fail rather than merely disappear from output.
it('actual CompanyStore metadata projection never reads private content or snapshots the whole state', async () => {
  const { CompanyStore } = await import('../src/company-store.js');
  const fs = await import('node:fs/promises');
  const directory = await fs.mkdtemp(join(tmpdir(), 'health-scalar-privacy-'));
  const f = fixture();
  const store = new CompanyStore(directory + '/company.json');
  await store.init();
  await store.update(() => {});
  const poisonedGoal = {
    ...f.g,
    get objective() {
      throw Error('OBJECTIVE_READ');
    },
    get nextAction() {
      throw Error('NEXT_ACTION_READ');
    },
  };
  const synthetic = (store as unknown as { state: typeof f.store }).state;
  synthetic.employees = [f.e];
  synthetic.goals = [poisonedGoal];
  Object.defineProperty(synthetic, 'memories', {
    get() {
      throw Error('MEMORY_READ');
    },
  });
  try {
    const data = new ServerHealthMetadataProvider({ ...f.ports, canonical: () => store.healthMetadataSnapshot() }).read(
      sid
    );
    expect(data).toMatchObject({ semanticProgressAtMs: 99900, automaticAction: 'NONE' });
    expect(synthetic.employees[0]).toBe(f.e);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
it('rejects Goal/intent changes during projection instead of publishing an old observation', () => {
  for (const kind of ['goal', 'intent']) {
    const f = fixture();
    let calls = 0;
    f.ports.canonical = () => {
      if (++calls === 2) {
        if (kind === 'goal') f.g.transitionSequence++;
        else f.e.desiredRunning = false;
      }
      return f.store;
    };
    expect(() => f.provider.read(sid)).toThrow();
  }
});
