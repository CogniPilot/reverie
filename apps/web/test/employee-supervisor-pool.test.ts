/**
 * The office-level step of the supervisor: the pool every laptop shares, after a host restart, and the stored home
 * of a stopped laptop before it is rebuilt. Everything here runs against a fake box behind the supervisor's ports.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EmployeeSupervisor,
  type EmployeeSupervisorPorts,
  type SupervisedEmployee,
  type SupervisorActionResult,
  type SupervisorAuditEntry,
  type SupervisorLaptopReading,
  type SupervisorOtherWork,
  type SupervisorPoolResult,
} from '../src/employee-supervisor.js';
import type {
  SupervisorAction,
  SupervisorHistory,
  SupervisorObservation,
  SupervisorStoredHome,
  SupervisorStoredHomeCause,
} from '../src/employee-supervisor-policy.js';
import { assessEmployee } from '../src/employee-supervisor-policy.js';

// The policy itself, with one function watched: what the driver shows it.
vi.mock('../src/employee-supervisor-policy.js', async (original) => {
  const real = await original<typeof import('../src/employee-supervisor-policy.js')>();
  return { ...real, assessEmployee: vi.fn(real.assessEmployee) };
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const START = 10 * MINUTE;
const LIMITS = { actionsPerTick: 2, startupGraceMs: 0, actionWaitMs: 50, idleReadMs: 0, limitsCheckMs: 10 * MINUTE };

/** What one employee's laptop is in the fake box. */
type Laptop = 'attached' | 'stopped' | 'fresh-source' | 'running-detached';
interface Person {
  employee: SupervisedEmployee;
  laptop: Laptop;
  storedHome: SupervisorStoredHome;
  /** Why, where the finding has a cause. */
  storedHomeCause?: SupervisorStoredHomeCause;
  /** A hold of a laptop that still runs, as its read names it. */
  hold?: { code: string; allowedActions: string[] };
  /** How many laptop operations this employee has had: a rebuild and its start make a new one. */
  operation: number;
}
const person = (id: string, laptop: Laptop = 'stopped', patch: Partial<SupervisedEmployee> = {}): Person => ({
  employee: {
    id,
    name: id.toUpperCase(),
    owner: undefined,
    sessionId: 'session-' + id,
    sessionGeneration: 1,
    desiredRunning: true,
    onVacation: false,
    bindingMigration: false,
    ...patch,
  },
  laptop,
  storedHome: 'verified',
  operation: 1,
});

function box(
  people: Person[],
  limits: Record<string, unknown> = LIMITS,
  /** What an earlier office process saved of each employee's repair steps. */
  saved: ReadonlyMap<string, SupervisorHistory> = new Map()
) {
  const state = {
    now: START,
    flags: { enabled: true, autoRepair: true },
    /** The pool's anchor. A host restart stops it together with every laptop. */
    anchor: 'stopped' as 'stopped' | 'running' | 'dead' | 'absent',
    /** What the container engine answers when the office removes a dead anchor: nothing, or its refusal. */
    removeAnchor: (() => undefined) as () => string | undefined,
    /** A cold recovery that was issued and did not finish. */
    recoveryOpen: false,
    /** The pool cannot be read. */
    unreadable: false,
    /** How the next cold recovery ends. */
    recover: (() => 'done') as () => 'done' | 'refused' | 'left-open',
    people,
    /** Every look at the pool, as `<seconds since the start>:<read|act>`. */
    looks: [] as string[],
    /** Every step taken for the pool, as `<seconds since the start>:<step>:<outcome>`. */
    steps: [] as string[],
    /** Whose record each pool call was offered, in order. */
    candidates: [] as string[][],
    acts: [] as string[],
    reads: [] as string[],
    kept: [] as string[],
    /** What the read inside a running laptop finds of work that is not the agent. */
    otherWork: (() => ({ otherWork: false as const, processes: 0 })) as (
      employee: SupervisedEmployee
    ) => Omit<SupervisorOtherWork, 'at'> | Error,
    /** Every attempt to record a running laptop's home, as `<seconds since the start>:<employee>:<outcome>`. */
    homes: [] as string[],
    recordHome: (() => 'recorded') as (employee: SupervisedEmployee) => 'recorded' | 'not-recorded' | 'failed',
    logs: [] as string[],
    audits: [] as SupervisorAuditEntry[],
    histories: new Map<string, SupervisorHistory>(saved),
  };
  const at = () => (state.now - START) / SECOND;
  const find = (employee: SupervisedEmployee) => state.people.find((row) => row.employee.id === employee.id)!;
  const attached = (row: Person) => row.laptop === 'attached';
  const running = (row: Person) => row.laptop === 'attached' || row.laptop === 'running-detached';
  const glance = (employee: SupervisedEmployee): Omit<SupervisorObservation, 'move' | 'planSignedIn'> => {
    const row = find(employee);
    const up = attached(row);
    return {
      employeeId: employee.id,
      name: employee.name,
      desiredRunning: employee.desiredRunning,
      onVacation: employee.onVacation,
      bindingMigration: false,
      boxed: true,
      session: up
        ? { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', providerHealth: 'healthy' }
        : { available: false, runtimeHealth: 'unknown', viewerHealth: 'disconnected', providerHealth: 'unknown' },
      laptop: {
        record:
          row.laptop === 'fresh-source'
            ? null
            : { phase: 'ready', version: 2, operationId: `op-${employee.id}-${row.operation}` },
        bound: row.laptop !== 'fresh-source',
        policyApproved: true,
        templateOnRecord: true,
        ...(row.laptop === 'fresh-source'
          ? {}
          : {
              restoration: up
                ? { state: 'attached' as const }
                : {
                    state: 'held' as const,
                    code:
                      row.laptop === 'stopped'
                        ? 'DOCKER_CONTINUATION_DESTINATION_STOPPED'
                        : 'DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED',
                  },
            }),
        poolAlive: state.people.some((other) => other !== row && attached(other)),
      },
    };
  };
  const readLaptop = (employee: SupervisedEmployee): SupervisorLaptopReading | undefined => {
    const row = find(employee);
    if (row.hold) return { state: 'held', phase: 'ready', ...row.hold };
    // After a host restart the storage holder of every finished laptop is stopped, and that is what is read first.
    if (row.laptop === 'stopped')
      return {
        state: 'held',
        phase: 'ready',
        code: 'DOCKER_CONTINUATION_STORAGE_UNCONFIRMED',
        allowedActions: ['observe'],
      };
    return { state: 'ready', phase: 'ready', allowedActions: ['observe'] };
  };
  /** The fake of the pool services: the same answers `DockerSupervisorLaptops.keepPool` gives. */
  const keepPool: NonNullable<EmployeeSupervisorPorts['keepPool']> = async (candidates, guard, step) => {
    state.looks.push(`${at()}:${step ? 'act' : 'read'}`);
    state.candidates.push(candidates.map((row) => row.id));
    if (state.unreadable) return { pool: 'unknown', detail: 'DOCKER_POOL_OBSERVATION_UNCONFIRMED' };
    const source = candidates[0]!;
    /** The look only reads unless it was asked for exactly this step. */
    const asked = (wanted: string) => step !== wanted;
    const took = (result: SupervisorPoolResult): SupervisorPoolResult => {
      state.steps.push(`${at()}:${result.step}:${result.outcome}`);
      return { ...result, employeeId: source.id };
    };
    if (state.recoveryOpen) {
      if (step !== 'finish-pool-recovery') return { pool: 'down', step: 'finish-pool-recovery', employeeId: source.id };
      guard(source, 'repair')();
      state.recoveryOpen = false;
      state.anchor = 'running';
      return took({ pool: 'up', step: 'finish-pool-recovery', outcome: 'done', detail: 'retained' });
    }
    if (state.anchor === 'running') return { pool: 'up', employeeId: source.id };
    // No anchor at all: no record can stand for a pool, and a laptop set-up creates one.
    if (state.anchor === 'absent') return { pool: 'none', detail: 'no laptop record names the shared pool' };
    if (state.anchor === 'dead') {
      const step = 'remove-dead-anchor' as const,
        detail = 'DOCKER_POOL_COLD_ANCHOR_DEAD';
      if (state.people.some(running)) return { pool: 'down', detail: 'DOCKER_POOL_COLD_WORKERS_RUNNING' };
      if (asked(step)) return { pool: 'down', step, detail, employeeId: source.id };
      guard(source, 'repair')();
      const refusal = state.removeAnchor();
      if (refusal) return took({ pool: 'down', step, outcome: 'refused', detail: refusal });
      state.anchor = 'absent';
      return took({ pool: 'down', step, outcome: 'done', detail: 'DOCKER_POOL_DEAD_ANCHOR_REMOVED' });
    }
    // The service refuses to recover a pool cold while any laptop of the box runs.
    if (state.people.some(running))
      return { pool: 'down', detail: 'DOCKER_POOL_COLD_WORKERS_RUNNING', employeeId: source.id };
    if (step !== 'recover-pool') return { pool: 'down', step: 'recover-pool', employeeId: source.id };
    guard(source, 'repair')();
    const outcome = state.recover();
    if (outcome === 'done') {
      state.anchor = 'running';
      return took({ pool: 'up', step: 'recover-pool', outcome: 'done', detail: 'retained' });
    }
    if (outcome === 'left-open') state.recoveryOpen = true;
    return took({
      pool: 'down',
      step: 'recover-pool',
      outcome: 'refused',
      detail: outcome === 'left-open' ? 'DOCKER_CONTINUATION_UNCONFIRMED' : 'DOCKER_RESOURCE_HELPER_FAILED',
    });
  };
  const act =
    (action: SupervisorAction) =>
    async (employee: SupervisedEmployee, guard: () => void): Promise<SupervisorActionResult> => {
      guard();
      const row = find(employee);
      state.acts.push(`${at()}:${action}:${employee.id}`);
      if (action === 'rebuild-laptop') {
        // A rebuild retires the laptop record and leaves a fresh source.
        row.laptop = 'fresh-source';
        return { outcome: 'done', detail: 'rebuilt' };
      }
      if (action === 'start-continuation') {
        // A fresh laptop cannot be set up while the pool's anchor is stopped.
        // With no anchor at all a set-up creates and starts one. It never starts one that is stopped or dead.
        if (state.anchor === 'absent') state.anchor = 'running';
        if (state.anchor !== 'running')
          return { outcome: 'refused', detail: 'DOCKER_RESOURCE_ANCHOR_START_UNCONFIRMED' };
        row.laptop = 'attached';
        row.operation++;
        return { outcome: 'done', detail: 'ready' };
      }
      return { outcome: 'refused', detail: 'nothing to do' };
    };
  const ports: EmployeeSupervisorPorts = {
    now: () => state.now,
    ready: () => true,
    employees: () => state.people.map((row) => row.employee),
    flags: () => state.flags,
    glance,
    openMove: async () => undefined,
    readLaptop: async (employee) => readLaptop(employee),
    readSource: async (employee) => (find(employee).laptop === 'fresh-source' ? 'stopped' : 'unknown'),
    readProvider: async (employee) => {
      state.reads.push(`${at()}:provider:${employee.id}`);
      return running(find(employee)) ? 'running' : 'no-laptop';
    },
    readOtherWork: async (employee, guard) => {
      guard();
      state.reads.push(`${at()}:work:${employee.id}`);
      const seen = state.otherWork(employee);
      if (seen instanceof Error) throw seen;
      return { ...seen, at: state.now };
    },
    readStoredHome: async (employee) => {
      state.reads.push(`${at()}:home:${employee.id}`);
      const row = find(employee);
      return { found: row.storedHome, ...(row.storedHomeCause ? { cause: row.storedHomeCause } : {}) };
    },
    keepLimits: async (employee, guard) => {
      guard();
      state.kept.push(`${at()}:${employee.id}`);
      return { outcome: 'refused', detail: 'DOCKER_CONTINUATION_POOL_UNCONFIRMED' };
    },
    storedHomeCheck: () => 'compare-only',
    rememberHome: async (employee, guard) => {
      guard();
      const outcome = running(find(employee)) ? state.recordHome(employee) : 'not-running';
      state.homes.push(`${at()}:${employee.id}:${outcome}`);
      return outcome;
    },
    keepPool,
    actions: {
      'resend-continuation': act('resend-continuation'),
      'start-continuation': act('start-continuation'),
      'reconnect-viewer': act('reconnect-viewer'),
      'rebuild-laptop': act('rebuild-laptop'),
    },
    load: () => new Map(state.histories),
    save: async (histories) => {
      state.histories = new Map(histories);
    },
    audit: (entry) => state.audits.push(entry),
    log: (line) => state.logs.push(line),
  };
  const supervisor = new EmployeeSupervisor(ports, undefined, limits as typeof LIMITS);
  /** Tick every 30 s, as the office timer does. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 30 * SECOND) {
      state.now += 30 * SECOND;
      await supervisor.tick();
    }
  };
  const report = (id: string) => supervisor.reports(undefined).find((row) => row.employeeId === id)!;
  return { state, supervisor, run, report };
}

describe('EmployeeSupervisor: the shared pool after a host restart', () => {
  it('recovers the pool once, then rebuilds and starts every employee, and asks nobody for anything', async () => {
    const w = box([person('a'), person('b'), person('c')]);
    await w.run(20 * MINUTE);
    // One look that only read, then the one recovery a minute after the pool was first seen stopped.
    expect(w.state.looks.slice(0, 2)).toEqual(['30:read', '90:act']);
    expect(w.state.steps).toEqual(['90:recover-pool:done']);
    // Nothing is rebuilt or started before the pool is up, and everyone is brought back after it.
    const acts = w.state.acts.map((line) => line.split(':'));
    expect(acts.every(([at]) => Number(at) >= 90)).toBe(true);
    for (const id of ['a', 'b', 'c']) {
      expect(acts.filter(([, action, who]) => who === id).map(([, action]) => action)).toEqual([
        'rebuild-laptop',
        'start-continuation',
      ]);
      expect(w.report(id)).toMatchObject({ condition: 'healthy' });
      expect(w.report(id).needsHuman).toBeUndefined();
    }
    expect(w.state.logs.join('\n')).not.toMatch(/needs a person/);
    // The step is in the audit trail like every other, under its own name and for the pool.
    expect(w.state.audits.filter((entry) => entry.action === 'supervisor_recover_pool')).toEqual([
      {
        admin: 'office supervisor',
        action: 'supervisor_recover_pool',
        target: 'shared pool',
        detail: { outcome: 'done', detail: 'retained', pool: 'up', attempt: 1, id: 'a' },
      },
    ]);
    // Once a terminal is attached nobody looks at the pool any more.
    const looks = w.state.looks.length;
    await w.run(30 * MINUTE);
    expect(w.state.looks).toHaveLength(looks);
    expect(w.supervisor.pool()).toBeUndefined();
  });

  it('spaces the employees out: two steps in a pass, in the order the office gives them', async () => {
    const w = box([person('c'), person('a'), person('b'), person('d')]);
    await w.run(4 * MINUTE);
    const rebuilds = w.state.acts.filter((line) => line.includes('rebuild-laptop'));
    expect(rebuilds.map((line) => line.split(':')[2])).toEqual(['c', 'a', 'b', 'd']);
    const perPass = new Map<string, number>();
    for (const line of w.state.acts) perPass.set(line.split(':')[0]!, (perPass.get(line.split(':')[0]!) ?? 0) + 1);
    expect(Math.max(...perPass.values())).toBe(2);
  });

  it('says what it waits for while the pool is down, on every employee', async () => {
    const w = box([person('a'), person('b')]);
    w.state.recover = () => 'refused';
    await w.run(5 * MINUTE);
    for (const id of ['a', 'b']) {
      expect(w.report(id)).toMatchObject({
        condition: 'held-needs-rebuild',
        waitingFor: 'the shared pool, which the office is recovering after a host restart',
        pool: {
          pool: 'down',
          step: 'recover-pool',
          last: { step: 'recover-pool', outcome: 'refused', detail: 'DOCKER_RESOURCE_HELPER_FAILED' },
        },
      });
      expect(w.report(id).needsHuman).toBeUndefined();
    }
    expect(w.state.acts).toEqual([]);
  });

  it('never recovers the pool cold while a terminal is attached: it does not even look', async () => {
    // One laptop survived (the host did not restart); the other is stopped and is rebuilt as it always was.
    const w = box([person('a', 'attached'), person('b')]);
    w.state.anchor = 'running';
    await w.run(20 * MINUTE);
    expect(w.state.looks).toEqual([]);
    expect(w.state.steps).toEqual([]);
    expect(w.state.acts.map((line) => line.split(':').slice(1).join(':'))).toEqual([
      'rebuild-laptop:b',
      'start-continuation:b',
    ]);
  });

  it('never recovers the pool cold beside a laptop that runs without a terminal: the service refuses and it waits', async () => {
    const w = box([person('a', 'running-detached'), person('b')]);
    await w.run(2 * HOUR);
    expect(w.state.steps).toEqual([]);
    expect(w.state.looks.every((line) => line.endsWith(':read'))).toBe(true);
    expect(w.state.anchor).toBe('stopped');
    expect(w.state.acts.filter((line) => line.includes('rebuild-laptop'))).toEqual([]);
    expect(w.supervisor.pool()).toMatchObject({ pool: 'down', detail: 'DOCKER_POOL_COLD_WORKERS_RUNNING' });
    expect(w.supervisor.pool()!.step).toBeUndefined();
    // It does not wait in silence: after fifteen minutes the waiting employee's report says what stands in the
    // way, with the refusal's own code, and the pool report says when the office looks again.
    expect(w.report('b').needsHuman).toMatch(
      /The shared pool of this office has been stopped since .* A laptop container of this office is running, paused or restarting although the pool's anchor is stopped.*\(DOCKER_POOL_COLD_WORKERS_RUNNING\) The office looks at the pool again every minute/
    );
    const pool = w.supervisor.pool()!;
    expect(pool.downSince).toBe(START + 30 * SECOND);
    expect(pool.nextLookAt! - pool.at).toBe(MINUTE);
    expect(pool.stepAt).toBeUndefined();
    // The laptop stops: the office recovers the pool by itself and nobody is asked any more.
    w.state.people[0]!.laptop = 'stopped';
    await w.run(20 * MINUTE);
    expect(w.state.steps.at(-1)).toMatch(/:recover-pool:done$/);
    expect(w.report('b').needsHuman).toBeUndefined();
    expect(w.report('b').condition).toBe('healthy');
  });

  it('says nothing for the first fifteen minutes of a pool that is stopped', async () => {
    const w = box([person('a', 'running-detached'), person('b')]);
    await w.run(14 * MINUTE);
    expect(w.report('b').waitingFor).toBe('the shared pool, which the office is recovering after a host restart');
    expect(w.report('b').needsHuman).toBeUndefined();
  });

  it('says that the step needs the switch for repairs when it is off, and takes it once the switch is on', async () => {
    const w = box([person('a'), person('b')]);
    w.state.flags = { enabled: true, autoRepair: false };
    await w.run(20 * MINUTE);
    expect(w.state.steps).toEqual([]);
    expect(w.supervisor.pool()).toMatchObject({ pool: 'down', step: 'recover-pool', stepNeedsRepairSwitch: true });
    expect(w.report('a').needsHuman).toMatch(/supervisorAutoRepair is off, so the office does not take that step/);
    w.state.flags = { enabled: true, autoRepair: true };
    await w.run(5 * MINUTE);
    expect(w.state.steps.at(-1)).toMatch(/:recover-pool:done$/);
    await w.run(20 * MINUTE);
    expect(w.report('a').needsHuman).toBeUndefined();
    expect(w.report('a').condition).toBe('healthy');
  });

  it('goes on without the look once a pool has been unreadable for fifteen minutes: that is no dead end', async () => {
    const w = box([person('a'), person('b')]);
    w.state.unreadable = true;
    w.state.anchor = 'running';
    await w.run(40 * MINUTE);
    // Nothing was ever recovered cold on a guess, and the employees were still brought back.
    expect(w.state.steps).toEqual([]);
    expect(w.state.acts.every((line) => Number(line.split(':')[0]) >= 15 * 60)).toBe(true);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('b').condition).toBe('healthy');
  });

  it('takes a pool it cannot read for unknown, never for stopped, and waits', async () => {
    const w = box([person('a'), person('b')]);
    w.state.unreadable = true;
    await w.run(14 * MINUTE);
    expect(w.state.steps).toEqual([]);
    expect(w.state.acts).toEqual([]);
    expect(w.state.looks.every((line) => line.endsWith(':read'))).toBe(true);
    expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild', pool: { pool: 'unknown' } });
    expect(w.report('a').waitingFor).toBe('a read of the shared pool, which the office could not make yet');
    expect(w.report('a').needsHuman).toBeUndefined();
    // The read comes back: the stopped pool is seen for a minute first, then recovered.
    w.state.unreadable = false;
    const from = (w.state.now - START) / SECOND;
    await w.run(10 * MINUTE);
    expect(w.state.steps).toEqual([`${from + 90}:recover-pool:done`]);
    expect(w.report('a').condition).toBe('healthy');
  });

  it('tries a failed recovery again with a growing wait, for days, and never stops', async () => {
    const w = box([person('a'), person('b')]);
    w.state.recover = () => 'refused';
    await w.run(50 * HOUR);
    const times = w.state.steps.map((line) => Number(line.split(':')[0]));
    // A minute after it was first seen, then after 1, 5, 15 and 60 minutes, then every hour for good: the whole
    // office waits for this step, so it is never left alone for longer.
    expect(times.slice(0, 5)).toEqual([90, 150, 450, 1350, 4950]);
    const gaps = times.slice(1).map((value, index) => value - times[index]!);
    expect(gaps.slice(4)).toEqual(new Array(gaps.length - 4).fill(60 * 60));
    expect(times.length).toBeGreaterThanOrEqual(50);
    expect(times.at(-1)!).toBeGreaterThan(48 * 60 * 60);
    // No laptop was rebuilt against the dead pool and no attempt of anyone's ladder was spent.
    expect(w.state.acts).toEqual([]);
    expect(w.state.histories.get('a')?.attempts ?? {}).toEqual({});
    // Every waiting employee's report says why, with the code the step was refused with, and when it is tried
    // again; the pool report carries the same times.
    for (const id of ['a', 'b'])
      expect(w.report(id).needsHuman, id).toMatch(
        /The pool service refused to start it \(DOCKER_RESOURCE_HELPER_FAILED\)\. The office looks at the pool again every minute and takes its next step \(recover-pool\) at \d{4}-\d\d-\d\d \d\d:\d\d UTC/
      );
    const pool = w.supervisor.pool()!;
    expect(pool).toMatchObject({ pool: 'down', step: 'recover-pool', downSince: START + 30 * SECOND });
    expect(pool.stepAt! - pool.last!.at).toBe(HOUR);
    expect(pool.nextLookAt! - pool.at).toBe(MINUTE);
    expect(w.state.audits.filter((entry) => entry.action === 'supervisor_recover_pool')).toHaveLength(times.length);
    // The cause goes away: the next attempt recovers the pool and everyone is brought back.
    w.state.recover = () => 'done';
    await w.run(7 * HOUR);
    expect(w.state.steps.at(-1)).toMatch(/:recover-pool:done$/);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('b').condition).toBe('healthy');
  });

  it('finishes a recovery that did not finish, as itself, before anything else', async () => {
    const w = box([person('a'), person('b')]);
    w.state.recover = () => 'left-open';
    await w.run(4 * MINUTE);
    expect(w.state.steps).toEqual(['90:recover-pool:refused', '210:finish-pool-recovery:done']);
    await w.run(10 * MINUTE);
    expect(w.state.steps).toHaveLength(2);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.state.audits.map((entry) => entry.action)).toContain('supervisor_finish_pool_recovery');
  });

  it('starts no stopped anchor with repairs switched off, and still looks', async () => {
    const w = box([person('a')]);
    w.state.flags = { enabled: true, autoRepair: false };
    await w.run(30 * MINUTE);
    expect(w.state.steps).toEqual([]);
    expect(w.state.looks.length).toBeGreaterThan(10);
    expect(w.state.looks.every((line) => line.endsWith(':read'))).toBe(true);
    expect(w.report('a').needsHuman).toMatch(/supervisorAutoRepair/);
    // Switched on again, it recovers at the next look.
    w.state.flags = { enabled: true, autoRepair: true };
    await w.run(2 * MINUTE);
    expect(w.state.steps).toHaveLength(1);
  });

  it('does nothing for the pool while nobody should be in the office', async () => {
    const w = box([person('a', 'stopped', { desiredRunning: false }), person('b', 'stopped', { onVacation: true })]);
    await w.run(30 * MINUTE);
    expect(w.state.looks).toEqual([]);
    expect(w.state.acts).toEqual([]);
  });

  it('lets a record of an employee who is out of the office stand for the pool, after those who are in', async () => {
    const w = box([person('away', 'stopped', { onVacation: true }), person('b')]);
    await w.run(10 * MINUTE);
    expect(w.state.candidates[0]).toEqual(['b', 'away']);
    // Only the employee who should be in the office is brought back.
    expect(w.state.acts.map((line) => line.split(':')[2])).toEqual(['b', 'b']);
  });

  it('starts a fresh laptop that was waiting when the host restarted only after the pool is up', async () => {
    const w = box([person('a'), person('b', 'fresh-source')]);
    await w.run(10 * MINUTE);
    const start = w.state.acts.find((line) => line.endsWith('start-continuation:b'))!;
    expect(Number(start.split(':')[0])).toBeGreaterThanOrEqual(90);
    expect(w.state.acts.filter((line) => line.includes(':b')).length).toBe(1);
    expect(w.report('b').condition).toBe('healthy');
  });
});

describe('EmployeeSupervisor: several host restarts in one day', () => {
  it('brings everyone back after each of four restarts, and counts none of those rebuilds against the daily limit', async () => {
    const w = box([person('a'), person('b')]);
    for (let restart = 1; restart <= 4; restart++) {
      await w.run(40 * MINUTE);
      for (const id of ['a', 'b']) expect(w.report(id).condition, `${id} after restart ${restart}`).toBe('healthy');
      // The host goes down again: every laptop, every storage holder and the anchor are stopped.
      for (const row of w.state.people) row.laptop = 'stopped';
      w.state.anchor = 'stopped';
    }
    const rebuilds = w.state.acts.filter((line) => line.includes('rebuild-laptop'));
    expect(rebuilds).toHaveLength(8);
    expect(w.state.steps.filter((line) => line.endsWith(':recover-pool:done'))).toHaveLength(4);
    for (const id of ['a', 'b']) {
      expect(w.state.histories.get(id)?.rebuilds ?? []).toEqual([]);
      expect(w.state.logs.join('\n')).not.toMatch(/daily limit/);
    }
    // The audit entry of such a rebuild says that nothing was running and what was read first.
    const audit = w.state.audits.find((entry) => entry.action === 'supervisor_rebuild_laptop')!;
    expect(audit.detail).toMatchObject({ outcome: 'done', proved: ['stored-home'] });
  });

  it('still counts the rebuild of a laptop that stopped by itself while its storage holder runs', async () => {
    const w = box([person('a', 'attached'), person('b')]);
    w.state.anchor = 'running';
    w.state.people[1]!.hold = { code: 'DOCKER_CONTINUATION_CONTAINER_STOPPED', allowedActions: ['observe'] };
    await w.run(10 * MINUTE);
    expect(w.state.acts.filter((line) => line.includes('rebuild-laptop:b'))).toHaveLength(1);
    expect(w.state.histories.get('b')?.rebuilds).toHaveLength(1);
  });
});

describe('EmployeeSupervisor: the stored home of a stopped laptop', () => {
  it('rebuilds onto a verified home and onto one it cannot compare, after reading it once', async () => {
    const w = box([person('a'), person('b')]);
    w.state.people[1]!.storedHome = 'unchecked';
    await w.run(10 * MINUTE);
    expect(w.state.reads.filter((line) => line.includes(':home:')).map((line) => line.split(':')[2])).toEqual([
      'a',
      'b',
    ]);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('b').condition).toBe('healthy');
  });

  it('does not rebuild onto a renumbered home it cannot prove, reads it again every ten minutes, and rebuilds once it is accepted', async () => {
    const w = box([person('a'), person('b')]);
    w.state.people[0]!.storedHome = 'renumbered';
    await w.run(65 * MINUTE);
    // The other employee is not held up.
    expect(w.report('b').condition).toBe('healthy');
    expect(w.state.acts.filter((line) => line.endsWith(':a'))).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild' });
    expect(w.report('a').needsHuman).toMatch(/new device number.*acceptStorageRenumbering/);
    const reads = w.state.reads.filter((line) => line.endsWith(':home:a')).map((line) => Number(line.split(':')[0]));
    expect(reads.length).toBeGreaterThanOrEqual(6);
    expect(reads.length).toBeLessThanOrEqual(8);
    for (let index = 1; index < reads.length; index++)
      expect(reads[index]! - reads[index - 1]!).toBeGreaterThanOrEqual(600);
    // No attempt of the ladder was spent while it waited.
    expect(w.state.histories.get('a')?.attempts['rebuild-laptop']).toBeUndefined();
    // The owner sets the standing grant (or the office finds its own proof): the next read allows the rebuild.
    w.state.people[0]!.storedHome = 'verified';
    await w.run(15 * MINUTE);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('a').needsHuman).toBeUndefined();
  });

  it('never starts an employee on another directory, keeps reading, and rebuilds when the right one is back', async () => {
    const w = box([person('a')]);
    w.state.people[0]!.storedHome = 'different';
    await w.run(6 * HOUR);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').needsHuman).toMatch(/not the one their laptop was built on/);
    expect(w.state.reads.filter((line) => line.endsWith(':home:a')).length).toBeGreaterThanOrEqual(30);
    w.state.people[0]!.storedHome = 'verified';
    await w.run(15 * MINUTE);
    expect(w.report('a').condition).toBe('healthy');
  });

  it('waits when it could not tell, reads again with a growing wait, and never rebuilds by the recorded path', async () => {
    const w = box([person('a'), person('b')]);
    w.state.people[0]!.storedHome = 'unknown';
    w.state.people[0]!.storedHomeCause = 'verifier-timed-out';
    await w.run(20 * MINUTE);
    expect(w.state.acts.filter((line) => line.endsWith(':a'))).toEqual([]);
    expect(w.report('b').condition).toBe('healthy');
    expect(w.report('a').waitingFor).toBe("a read of the laptop's stored home directory");
    expect(w.report('a').needsHuman).toBeUndefined();
    // Read again after 1, 2, 5 and then every 10 minutes: not every pass, and never given up.
    const reads = () =>
      w.state.reads.filter((line) => line.endsWith(':home:a')).map((line) => Number(line.split(':')[0]));
    const gaps = () =>
      reads()
        .slice(1)
        .map((value, index) => value - reads()[index]!);
    expect(gaps()).toEqual([60, 120, 300]);
    // After half an hour of that, the report says exactly what is in the way. The office still reads, and still
    // does not rebuild.
    await w.run(20 * MINUTE);
    expect(w.state.acts.filter((line) => line.endsWith(':a'))).toEqual([]);
    expect(w.report('a').needsHuman).toMatch(
      /cannot tell whether this employee's home is still the one their laptop was built on, so it does not rebuild the laptop: the read by the recovery helper did not answer within thirty seconds, each time it was tried/
    );
    expect(w.report('a').needsHuman).toMatch(/\(\d+ reads in a row since /);
    await w.run(6 * 60 * MINUTE);
    expect(w.state.acts.filter((line) => line.endsWith(':a'))).toEqual([]);
    expect(reads().length).toBeGreaterThan(35);
    expect(new Set(gaps().slice(3))).toEqual(new Set([600]));
    // Nothing of the ladder was spent on it.
    expect(w.state.histories.get('a')?.attempts['rebuild-laptop']).toBeUndefined();
    // The read answers: the laptop is rebuilt by the office, and nobody is asked any more.
    w.state.people[0]!.storedHome = 'verified';
    delete w.state.people[0]!.storedHomeCause;
    await w.run(15 * MINUTE);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('a').needsHuman).toBeUndefined();
  });

  it('names the cause of a read that could not tell, and starts the count again when the cause changes', async () => {
    const w = box([person('a')]);
    w.state.people[0]!.storedHome = 'unknown';
    w.state.people[0]!.storedHomeCause = 'verifier-image-missing';
    await w.run(45 * MINUTE);
    expect(w.report('a').needsHuman).toMatch(/recoveryHelperImageId\) is not in the container engine/);
    w.state.people[0]!.storedHomeCause = 'receipt-unreadable';
    await w.run(12 * MINUTE);
    // A new cause is a new finding: it is waited for first.
    expect(w.report('a').needsHuman).toBeUndefined();
    await w.run(40 * MINUTE);
    expect(w.report('a').needsHuman).toMatch(/the storage holder of this laptop, or the holder's own record/);
    expect(w.state.acts).toEqual([]);
  });

  it('shows on every employee what the office checks with the verifier image it has', async () => {
    const w = box([person('a', 'attached')]);
    w.state.anchor = 'running';
    await w.run(MINUTE);
    expect(w.report('a').storedHomeCheck).toBe('compare-only');
  });
});

describe('EmployeeSupervisor: what else runs in a laptop besides its agent', () => {
  /** What the policy was shown of one employee's laptop, each time it was asked. */
  const shown = (id: string) =>
    vi
      .mocked(assessEmployee)
      .mock.calls.map(([observed]) => observed)
      .filter((observed) => observed.employeeId === id)
      .map((observed) => observed.laptop as SupervisorObservation['laptop'] & Record<string, unknown>);

  it('reads it with the read of what runs in the laptop, and shows it to the policy and in the report', async () => {
    vi.mocked(assessEmployee).mockClear();
    // A laptop that runs with no terminal, in an office whose pool is up: the ladder reaches the read.
    const w = box([person('a', 'running-detached'), person('b', 'attached')]);
    w.state.anchor = 'running';
    w.state.otherWork = () => ({
      otherWork: true,
      processes: 2,
      names: ['cargo', 'rustc'],
      cpu: { usedMs: 60_000, overMs: 120_000 },
    });
    await w.run(HOUR);
    const provider = w.state.reads.filter((line) => line.endsWith(':provider:a')),
      work = w.state.reads.filter((line) => line.endsWith(':work:a'));
    // Once for every read that found the laptop running, at the same moment, and for nobody else.
    expect(provider.length).toBeGreaterThan(0);
    expect(work.map((line) => line.split(':')[0])).toEqual(provider.map((line) => line.split(':')[0]));
    expect(w.state.reads.filter((line) => line.endsWith(':work:b'))).toEqual([]);
    // The plain fact, and everything that was read, on the observation the policy decides with.
    const facts = shown('a').filter((laptop) => laptop.otherWork !== undefined);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.at(-1)).toMatchObject({
      provider: 'running',
      otherWork: true,
      otherWorkDetail: {
        otherWork: true,
        processes: 2,
        names: ['cargo', 'rustc'],
        cpu: { usedMs: 60_000, overMs: 120_000 },
      },
    });
    expect(w.report('a').otherWork).toMatchObject({ otherWork: true, processes: 2, names: ['cargo', 'rustc'] });
    expect(w.report('b').otherWork).toBeUndefined();
  });

  it('shows unknown as unknown when the read gives no answer, and reads nothing in a laptop that does not run', async () => {
    vi.mocked(assessEmployee).mockClear();
    const w = box([person('a', 'running-detached'), person('b', 'attached')]);
    w.state.anchor = 'running';
    w.state.otherWork = () => new Error('exec failed');
    await w.run(HOUR);
    expect(w.report('a').otherWork).toMatchObject({ otherWork: 'unknown' });
    expect(shown('a').some((laptop) => laptop.otherWork === 'unknown')).toBe(true);
    expect(shown('a').some((laptop) => laptop.otherWork === false)).toBe(false);
    // Every laptop is stopped: nothing can run in one, and no read is made inside it.
    const stopped = box([person('c'), person('d')]);
    await stopped.run(30 * MINUTE);
    expect(stopped.state.reads.filter((line) => line.includes(':work:'))).toEqual([]);
    expect(stopped.report('c').otherWork).toBeUndefined();
  });
});

describe('EmployeeSupervisor: an anchor that the container engine reports dead', () => {
  it('removes it by itself, lets the next laptop set-up create the pool, and brings everyone back', async () => {
    const w = box([person('a'), person('b'), person('c')]);
    w.state.anchor = 'dead';
    await w.run(30 * MINUTE);
    // One minute after it was first seen, like every other step of the pool.
    expect(w.state.steps).toEqual(['90:remove-dead-anchor:done']);
    expect(w.state.audits.filter((entry) => entry.action === 'supervisor_remove_dead_anchor')).toHaveLength(1);
    expect(w.state.anchor).toBe('running');
    for (const id of ['a', 'b', 'c']) {
      expect(w.report(id).condition, id).toBe('healthy');
      expect(w.report(id).needsHuman, id).toBeUndefined();
    }
    // Nobody was rebuilt or started before the dead anchor was gone.
    expect(w.state.acts.every((line) => Number(line.split(':')[0]) > 90)).toBe(true);
  });

  it('shows the engine’s own refusal, tries again with a growing wait, and goes on when the engine lets go', async () => {
    const words =
      'the container engine refused: Error response from daemon: container 3f2a: driver "overlay2" failed to remove root filesystem: device or resource busy';
    const w = box([person('a'), person('b')]);
    w.state.anchor = 'dead';
    w.state.removeAnchor = () => words;
    await w.run(3 * HOUR);
    const times = w.state.steps.map((line) => Number(line.split(':')[0]));
    expect(times.slice(0, 5)).toEqual([90, 150, 450, 1350, 4950]);
    expect(w.state.steps.every((line) => line.endsWith(':remove-dead-anchor:refused'))).toBe(true);
    expect(w.state.acts).toEqual([]);
    expect(w.supervisor.pool()).toMatchObject({ pool: 'down', step: 'remove-dead-anchor', last: { detail: words } });
    for (const id of ['a', 'b'])
      expect(w.report(id).needsHuman, id).toMatch(
        /reports the pool's anchor container as dead.*The office removes it itself.*Its last attempt did not remove it: the container engine refused: Error response from daemon: .*device or resource busy\. \(DOCKER_POOL_COLD_ANCHOR_DEAD\) The office looks at the pool again every minute and takes its next step \(remove-dead-anchor\) at /
      );
    w.state.removeAnchor = () => undefined;
    await w.run(90 * MINUTE);
    expect(w.state.steps.at(-1)).toMatch(/:remove-dead-anchor:done$/);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('b').condition).toBe('healthy');
  });

  it('removes nothing while a laptop of the office runs, and nothing with the switch for repairs off', async () => {
    const beside = box([person('a', 'running-detached'), person('b')]);
    beside.state.anchor = 'dead';
    await beside.run(HOUR);
    expect(beside.state.steps).toEqual([]);
    expect(beside.state.anchor).toBe('dead');
    const off = box([person('a'), person('b')]);
    off.state.anchor = 'dead';
    off.state.flags = { enabled: true, autoRepair: false };
    await off.run(HOUR);
    expect(off.state.steps).toEqual([]);
    expect(off.report('a').needsHuman).toMatch(
      /Removing it is a repair, and the company setting supervisorAutoRepair is off.*POST \/api\/company\/employees\/:id\/docker-pool\/remove-dead-anchor/
    );
  });
});

describe('EmployeeSupervisor: no round of repair steps is sat out after a host restart', () => {
  it('begins a new round for everyone when the stopped pool runs again, whatever was used before the restart', async () => {
    // Both rebuilds of this round were used a few minutes before the host went down.
    const used: SupervisorHistory = {
      fingerprint: 'held-needs-rebuild:earlier',
      since: START - 20 * MINUTE,
      attempts: { 'rebuild-laptop': { count: 2, lastAt: START - 5 * MINUTE } },
      rebuilds: [],
    };
    const w = box([person('a'), person('b')], LIMITS, new Map([['a', used]]));
    await w.run(30 * MINUTE);
    expect(w.state.steps).toEqual(['90:recover-pool:done']);
    expect(w.state.logs).toContain(
      '[supervisor] shared pool: running again; 1 employee(s) start a new round of repair steps'
    );
    // Not in six hours: with everyone else.
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('b').condition).toBe('healthy');
    expect(w.state.acts.filter((line) => line.endsWith(':rebuild-laptop:a'))).toHaveLength(1);
  });

  it('gives back what was spent against a stopped pool that the office could not read', async () => {
    const w = box([person('a'), person('b')]);
    w.state.unreadable = true;
    // Fifteen minutes of a pool that cannot be read, and then the ladder goes on: its starts meet the stopped
    // anchor and are refused, until the round's starts are used.
    await w.run(3 * HOUR);
    const refused = w.state.acts.filter((line) => line.includes(':start-continuation:')).length;
    expect(refused).toBeGreaterThan(0);
    expect(w.report('a').condition).not.toBe('healthy');
    // The read comes back. The pool is seen stopped, recovered, and everyone is brought back in minutes.
    w.state.unreadable = false;
    await w.run(20 * MINUTE);
    expect(w.state.steps.at(-1)).toMatch(/:recover-pool:done$/);
    expect(w.report('a').condition).toBe('healthy');
    expect(w.report('b').condition).toBe('healthy');
  });

  it('begins no new round at an office start that finds the pool running, and none twice within ten minutes', async () => {
    const used: SupervisorHistory = {
      fingerprint: 'held-needs-rebuild:earlier',
      since: START - 20 * MINUTE,
      attempts: { 'rebuild-laptop': { count: 2, lastAt: START - 5 * MINUTE } },
      rebuilds: [],
    };
    const w = box([person('a'), person('b', 'attached')], LIMITS, new Map([['a', used]]));
    w.state.anchor = 'running';
    await w.run(30 * MINUTE);
    // The pool never stopped: the round that was used stays used, as on any other day.
    expect(w.state.logs.filter((line) => line.includes('new round'))).toEqual([]);
    expect(w.state.acts.filter((line) => line.includes(':rebuild-laptop:a'))).toEqual([]);
    expect(w.report('a').waitingFor).toMatch(/the next round of repair steps/);
  });
});

describe('EmployeeSupervisor: the record of each running laptop’s home', () => {
  const recorded = (w: ReturnType<typeof box>) => w.state.homes.filter((line) => line.endsWith(':recorded'));
  it('records every running laptop within minutes of an office start, those in the office first, and each once', async () => {
    const w = box([
      person('away', 'running-detached', { onVacation: true }),
      person('a', 'attached'),
      person('b', 'attached'),
      person('c', 'attached'),
      person('d', 'attached'),
    ]);
    w.state.anchor = 'running';
    await w.run(2 * MINUTE);
    // Two per pass: five laptops within three passes of the first.
    expect(recorded(w).map((line) => line.split(':')[1])).toEqual(['a', 'b', 'c', 'd', 'away']);
    expect(Number(recorded(w).at(-1)!.split(':')[0])).toBeLessThanOrEqual(90);
    await w.run(3 * 60 * MINUTE);
    expect(w.state.homes).toHaveLength(5);
  });

  it('tries again with a growing wait when nothing was recorded, for as long as it takes', async () => {
    const w = box([person('a', 'attached')]);
    w.state.anchor = 'running';
    w.state.recordHome = () => 'failed';
    await w.run(3 * 60 * MINUTE);
    const times = w.state.homes.map((line) => Number(line.split(':')[0]));
    // At once, then after 1, 5, 15 and 60 minutes, then every hour.
    expect(times.slice(0, 6).map((value, index) => (index ? value - times[index - 1]! : value))).toEqual([
      30, 60, 300, 900, 3600, 3600,
    ]);
    w.state.recordHome = () => 'recorded';
    await w.run(61 * MINUTE);
    expect(w.state.homes.at(-1)).toMatch(/:a:recorded$/);
    const count = w.state.homes.length;
    await w.run(3 * 60 * MINUTE);
    expect(w.state.homes).toHaveLength(count);
    // The first attempt that recorded nothing is said once, and the record when it is made.
    expect(w.state.logs.filter((line) => line.includes('record-home'))).toEqual([
      '[supervisor] A (a): record-home -> failed',
      '[supervisor] A (a): record-home -> recorded',
    ]);
  });

  it('records a laptop that was rebuilt again, and one that was not running once it runs', async () => {
    const w = box([person('a'), person('b', 'attached')]);
    w.state.anchor = 'running';
    await w.run(20 * MINUTE);
    // 'a' was stopped, then rebuilt and started by the supervisor: its new laptop is recorded.
    expect(w.report('a').condition).toBe('healthy');
    expect(
      recorded(w)
        .map((line) => line.split(':')[1])
        .sort()
    ).toEqual(['a', 'b']);
    // A rebuild later on makes a new laptop operation, which is recorded again.
    w.state.people[1]!.laptop = 'stopped';
    await w.run(30 * MINUTE);
    expect(w.report('b').condition).toBe('healthy');
    expect(recorded(w).filter((line) => line.includes(':b:'))).toHaveLength(2);
  });

  it('records nothing while the supervisor is switched off', async () => {
    const w = box([person('a', 'attached')]);
    w.state.anchor = 'running';
    w.state.flags = { enabled: false, autoRepair: false };
    await w.run(10 * MINUTE);
    expect(w.state.homes).toEqual([]);
  });
});

describe('EmployeeSupervisor: a hold of the shared pool that the ladder cannot settle', () => {
  it('goes on putting the pool limits back every ten minutes after the re-sends are used up', async () => {
    // Both laptops run and are attached; one reads as held by the pool's limits and its repair keeps being refused.
    const w = box([person('a', 'attached'), person('b', 'attached')]);
    w.state.people[0]!.hold = {
      code: 'DOCKER_CONTINUATION_POOL_UNCONFIRMED',
      allowedActions: ['observe', 'repair-pool'],
    };
    w.state.people[0]!.laptop = 'running-detached';
    await w.run(3 * HOUR);
    expect(w.state.acts.filter((line) => line.includes('resend-continuation:a'))).toHaveLength(4);
    expect(w.state.acts.filter((line) => line.includes('rebuild-laptop'))).toEqual([]);
    // No cold recovery beside a running laptop.
    expect(w.state.steps).toEqual([]);
    const kept = w.state.kept.filter((line) => line.endsWith(':a')).map((line) => Number(line.split(':')[0]));
    expect(kept.length).toBeGreaterThanOrEqual(12);
    expect(kept.at(-1)!).toBeGreaterThan(2.5 * 60 * 60);
    expect(w.report('a').needsHuman).toMatch(/The office puts the approved limits of the shared pool back itself/);
  });
});
