/** Owned actual CompanyStore + real unstarted Session registry; no process, key or live authority. */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanonicalHealthMetadataReader } from '../src/health-canonical-reader.js';
import { ServerHealthMetadataProvider } from '../src/session-health-provider.js';
import { GoalCanonicalAuthority } from '../src/goal-canonical-authority.js';
import { Session } from '../src/session.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

const sid = '11111111-2222-3333-4444-555555555555';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const f = await goalFixture();
  cleanups.push(f.cleanup);
  await f.store.update((state) => {
    state.employees.find((e) => e.id === 'w')!.sessionId = sid;
  });
  f.createInput.sessionId = sid;
  (f.principals.worker as { sessionId: string }).sessionId = sid;
  const goal = await f.active();
  const registry = new Map([
    [sid, new Session({ id: sid, owner: 'a', workingDir: f.directory, mode: 'shell', useMux: false })],
  ]);
  const sessions = { getSession: (id: string) => registry.get(id) };
  const retired = { value: false };
  const retirement = { isRetired: () => retired.value };
  const reader = new CanonicalHealthMetadataReader({ store: f.store, sessions, retirement, custody: f.auth });
  const provider = new ServerHealthMetadataProvider({
    authority: reader,
    canonical: () => f.store.healthMetadataSnapshot(),
    session: (id) => registry.get(id),
    now: () => f.clock.now,
  });
  return { ...f, goal, registry, sessions, retirement, retired, reader, provider };
}
describe('purpose-distinct same-store canonical health metadata', () => {
  it('reads real r3 receipt scalars without whole-store/Goal binding/private content/process reads', async () => {
    const f = await fixture();
    const bytes = fs.readFileSync(f.file, 'utf8');
    const raw = (f.store as unknown as { state: ReturnType<typeof f.store.snapshot> }).state;
    const snapshots = vi.spyOn(f.store, 'snapshot').mockImplementation(() => {
      throw Error('FULL_SNAPSHOT');
    });
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw Error('FULL_CLONE');
    });
    const content: [object, string, PropertyDescriptor | undefined][] = [];
    const poison = (object: object, key: string) => {
      content.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
      Object.defineProperty(object, key, {
        configurable: true,
        get() {
          throw Error('PRIVATE_' + key);
        },
      });
    };
    poison(raw, 'memories');
    poison(raw.employees[0]!, 'name');
    poison(raw.employees[0]!, 'personality');
    poison(raw.goals[0]!, 'objective');
    poison(raw.goals[0]!, 'nextAction');
    poison(raw.goals[0]!.creation, 'objective');
    poison(raw.goals[0]!.transitions.at(-1)!.after, 'nextAction');
    const running = vi.spyOn(f.registry.get(sid)!, 'isRunning').mockImplementation(() => {
      throw Error('PROCESS_READ');
    });
    try {
      expect(() => f.store.snapshot()).toThrow('FULL_SNAPSHOT');
      expect(() => structuredClone(raw)).toThrow('FULL_CLONE');
      expect(() => f.registry.get(sid)!.isRunning()).toThrow('PROCESS_READ');
      snapshots.mockClear();
      clone.mockClear();
      running.mockClear();
      const data = f.provider.read(sid);
      expect(data).toMatchObject({
        sessionGeneration: 1,
        goal: { id: f.goal.id, generation: 1, state: 'ACTIVE' },
        semanticProgressAtMs: f.clock.now,
        progressSource: 'CANONICAL_GOAL_RECEIPT',
        process: 'UNKNOWN',
        automaticAction: 'NONE',
      });
      expect(JSON.stringify(data)).not.toMatch(/Synthetic Goal|objective|nextAction|personality|owner|memories/);
      expect(snapshots).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(running).not.toHaveBeenCalled();
      expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
      expect('binding' in f.reader).toBe(false);
      expect('assertAction' in f.reader).toBe(false);
      expect('authenticate' in f.reader).toBe(false);
    } finally {
      for (const [object, key, descriptor] of content) {
        if (descriptor) Object.defineProperty(object, key, descriptor);
        else Reflect.deleteProperty(object, key);
      }
    }
  });
  it.each(['stopped', 'vacation'] as const)('reports %s intent without weakening active Goal binding', async (kind) => {
    const f = await fixture();
    await f.store.update((state) => {
      const e = state.employees.find((e) => e.id === 'w')!;
      e.desiredRunning = kind !== 'stopped';
      e.onVacation = kind === 'vacation';
    });
    const activeAuthority = new GoalCanonicalAuthority({
      company: { store: f.store },
      sessions: f.sessions,
      retirement: f.retirement,
      custody: f.auth,
      owner: { session: () => undefined },
    });
    expect(activeAuthority.binding(sid)).toBeUndefined();
    const snapshot = vi.spyOn(f.store, 'snapshot').mockImplementation(() => {
      throw Error('FULL_SNAPSHOT');
    });
    expect(f.provider.read(sid)).toMatchObject({
      intent: kind === 'stopped' ? 'STOPPED' : 'VACATION',
      process: 'UNKNOWN',
      classification: 'AMBIGUOUS',
      automaticAction: 'NONE',
    });
    expect(snapshot).not.toHaveBeenCalled();
  });
  it.each(['retired', 'crossOwner', 'missingRuntime', 'custody', 'migration'] as const)('refuses %s', async (kind) => {
    const f = await fixture();
    if (kind === 'retired') f.retired.value = true;
    if (kind === 'crossOwner') f.registry.get(sid)!.owner = 'other';
    if (kind === 'missingRuntime') f.registry.delete(sid);
    if (kind === 'custody') f.custody.ready = false;
    if (kind === 'migration')
      await f.store.update((state) => {
        state.employees.find((e) => e.id === 'w')!.bindingMigration = { id: 'synthetic', from: sid, to: sid };
      });
    expect(f.reader.metadataBinding(sid)).toBeUndefined();
    expect(() => f.provider.read(sid)).toThrow();
  });
  it('never reports a stale Goal tuple after a real canonical generation change', async () => {
    const f = await fixture();
    await f.store.update((state) => {
      state.employees.find((e) => e.id === 'w')!.sessionGeneration++;
    });
    expect(f.provider.read(sid)).toMatchObject({ sessionGeneration: 2, goal: null, semanticProgressAtMs: null });
  });
  it.each(['intent', 'goal', 'generation'] as const)(
    'refuses externally changed %s without a private reload',
    async (kind) => {
      const f = await fixture();
      const changed = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      if (kind === 'intent') changed.employees[0].desiredRunning = false;
      if (kind === 'goal') changed.goals[0].transitionSequence++;
      if (kind === 'generation') changed.employees[0].sessionGeneration++;
      fs.writeFileSync(f.file + '.external', JSON.stringify(changed), { mode: 0o600 });
      fs.renameSync(f.file + '.external', f.file);
      const snapshot = vi.spyOn(f.store, 'snapshot').mockImplementation(() => {
        throw Error('PRIVATE_RELOAD');
      });
      expect(f.reader.metadataBinding(sid)).toBeUndefined();
      expect(() => f.provider.read(sid)).toThrow();
      expect(snapshot).not.toHaveBeenCalled();
    }
  );
  it.each(['custody', 'registry', 'canonical'] as const)('rechecks %s after scalar observation', async (kind) => {
    const f = await fixture();
    const original = f.store.healthMetadataSnapshot.bind(f.store);
    vi.spyOn(f.store, 'healthMetadataSnapshot').mockImplementationOnce(() => {
      const result = original();
      if (kind === 'custody') f.custody.ready = false;
      if (kind === 'registry')
        f.registry.set(
          sid,
          new Session({ id: sid, owner: 'other', workingDir: f.directory, mode: 'shell', useMux: false })
        );
      if (kind === 'canonical') fs.appendFileSync(f.file, ' ');
      return result;
    });
    expect(() => f.provider.read(sid)).toThrow();
  });
  it('resumes scalar reads only after an ordinary canonical reload, never an automatic health reload', async () => {
    const f = await fixture();
    fs.appendFileSync(f.file, ' ');
    expect(() => f.provider.read(sid)).toThrow();
    f.store.snapshot(); // Explicit ordinary canonical operation, not called by the health reader.
    expect(f.provider.read(sid)).toMatchObject({ goal: { id: f.goal.id }, automaticAction: 'NONE' });
  });
});
