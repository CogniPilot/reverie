import { it, expect } from 'vitest';
import { CanonicalRecoveryAuthority, type RecoveryMetadata } from '../src/recovery-authority.js';
const initial: RecoveryMetadata = {
  employeeId: 'employee',
  goalId: 'goal',
  goalGeneration: 1,
  sessionId: '11111111-1111-1111-1111-111111111111',
  sessionGeneration: 1,
  transitionSequence: 0,
  ownerId: 'owner',
  revision: 1,
  goalState: 'ACTIVE',
  desiredRunning: true,
  vacation: false,
  sleeping: false,
  pendingInput: false,
  dialog: 'NONE',
  activeJobs: 0,
  activeTurn: false,
  toolWait: false,
};
function fixture() {
  let value: any = { ...initial };
  let authorized = true,
    frozen = true,
    read = 0;
  const sources = {
    async authenticate(_context: unknown) {
      return { kind: 'RESUME_SERVICE' as const, ownerId: 'owner', current: () => authorized };
    },
    read() {
      read++;
      return value;
    },
    async frozen() {
      return { current: () => frozen };
    },
  };
  return {
    sources,
    authority: new CanonicalRecoveryAuthority(sources),
    set: (v: any) => {
      value = v;
    },
    revoke: () => {
      authorized = false;
    },
    unfreeze: () => {
      frozen = false;
    },
    reads: () => read,
  };
}
it('has no default authority or FROZEN proof even with caller assertions', async () => {
  expect(
    await new CanonicalRecoveryAuthority().prepare({ authenticatedOwner: true, FROZEN: true }, 'employee')
  ).toBeNull();
});
it('reads metadata only after dedicated authentication and returns no content', async () => {
  const f = fixture();
  f.sources.authenticate = async () => null as any;
  expect(await f.authority.prepare({}, 'employee')).toBeNull();
  expect(f.reads()).toBe(0);
  const g = fixture();
  const permit = await g.authority.prepare({}, 'employee');
  expect(permit?.current()).toBe(true);
  expect(Object.keys(permit!).sort()).toEqual(['binding', 'current', 'ownerId']);
});
it('refuses extra private fields/accessors without reading their values', async () => {
  const f = fixture();
  let reads = 0;
  f.set({ ...initial, objective: 'not read' });
  expect(await f.authority.prepare({}, 'employee')).toBeNull();
  f.set(
    Object.defineProperty({ ...initial }, 'pendingInput', {
      get() {
        reads++;
        return false;
      },
    })
  );
  expect(await f.authority.prepare({}, 'employee')).toBeNull();
  expect(reads).toBe(0);
});
it('refuses inactive and unsafe states without weakening action auth', async () => {
  for (const delta of [
    { goalState: 'DONE' },
    { desiredRunning: false },
    { vacation: true },
    { sleeping: true },
    { pendingInput: true },
    { dialog: 'APPROVAL' },
    { activeJobs: 1 },
    { activeTurn: true },
    { toolWait: true },
    { activeJobs: '0' },
    { revision: Number.NaN },
  ]) {
    const f = fixture();
    f.set({ ...initial, ...delta });
    expect(await f.authority.prepare({}, 'employee')).toBeNull();
  }
});
it('refuses wrong owner/employee and exact canonical tuple drift', async () => {
  for (const delta of [{ ownerId: 'other' }, { employeeId: 'other' }]) {
    const f = fixture();
    f.set({ ...initial, ...delta });
    expect(await f.authority.prepare({}, 'employee')).toBeNull();
  }
  const f = fixture();
  const p = await f.authority.prepare({}, 'employee');
  f.set({ ...initial, sessionGeneration: 2 });
  expect(p!.current()).toBe(false);
});
it('refuses missing/stale FROZEN evidence rather than trusting a classifier label', async () => {
  const f = fixture();
  f.unfreeze();
  expect(await f.authority.prepare({}, 'employee')).toBeNull();
  const g = fixture();
  g.sources.frozen = async () => null as any;
  expect(await g.authority.prepare({}, 'employee')).toBeNull();
});
it('rechecks auth and canonical revision after the FROZEN await', async () => {
  for (const change of ['auth', 'revision']) {
    const f = fixture();
    const before = f.sources.frozen;
    f.sources.frozen = async () => {
      const r = await before();
      if (change === 'auth') f.revoke();
      else f.set({ ...initial, revision: 2 });
      return r;
    };
    expect(await f.authority.prepare({}, 'employee')).toBeNull();
  }
});
it('a returned permit still checks revocation, jobs, sleep, proof and generation freshly', async () => {
  for (const change of ['auth', 'frozen', 'jobs', 'sleep', 'generation']) {
    const f = fixture();
    const p = await f.authority.prepare({}, 'employee');
    expect(p!.current()).toBe(true);
    if (change === 'auth') f.revoke();
    else if (change === 'frozen') f.unfreeze();
    else
      f.set({
        ...initial,
        ...(change === 'jobs' ? { activeJobs: 1 } : change === 'sleep' ? { sleeping: true } : { goalGeneration: 2 }),
      });
    expect(p!.current()).toBe(false);
  }
});
