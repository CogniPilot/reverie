/**
 * The office-level step of the supervisor: the pool every laptop shares, after a host restart, and the stored home
 * of a stopped laptop before it is rebuilt. Everything here runs against a fake box behind the supervisor's ports.
 */
import { describe, expect, it } from 'vitest';
import {
  EmployeeSupervisor,
  type EmployeeSupervisorPorts,
  type SupervisedEmployee,
  type SupervisorActionResult,
  type SupervisorAuditEntry,
  type SupervisorLaptopReading,
  type SupervisorPoolResult,
} from '../src/employee-supervisor.js';
import type {
  SupervisorAction,
  SupervisorHistory,
  SupervisorObservation,
  SupervisorStoredHome,
} from '../src/employee-supervisor-policy.js';

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
  /** A hold of a laptop that still runs, as its read names it. */
  hold?: { code: string; allowedActions: string[] };
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
});

function box(people: Person[], limits: Record<string, unknown> = LIMITS) {
  const state = {
    now: START,
    flags: { enabled: true, autoRepair: true },
    /** The pool's anchor. A host restart stops it together with every laptop. */
    anchor: 'stopped' as 'stopped' | 'running',
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
    logs: [] as string[],
    audits: [] as SupervisorAuditEntry[],
    histories: new Map<string, SupervisorHistory>(),
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
        record: row.laptop === 'fresh-source' ? null : { phase: 'ready', version: 2, operationId: 'op-' + employee.id },
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
        if (state.anchor !== 'running')
          return { outcome: 'refused', detail: 'DOCKER_RESOURCE_ANCHOR_START_UNCONFIRMED' };
        row.laptop = 'attached';
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
    readStoredHome: async (employee) => {
      state.reads.push(`${at()}:home:${employee.id}`);
      return find(employee).storedHome;
    },
    keepLimits: async (employee, guard) => {
      guard();
      state.kept.push(`${at()}:${employee.id}`);
      return { outcome: 'refused', detail: 'DOCKER_CONTINUATION_POOL_UNCONFIRMED' };
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
  });

  it('takes a pool it cannot read for unknown, never for stopped, and waits', async () => {
    const w = box([person('a'), person('b')]);
    w.state.unreadable = true;
    await w.run(30 * MINUTE);
    expect(w.state.steps).toEqual([]);
    expect(w.state.acts).toEqual([]);
    expect(w.state.looks.every((line) => line.endsWith(':read'))).toBe(true);
    expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild', pool: { pool: 'unknown' } });
    expect(w.report('a').waitingFor).toMatch(/the shared pool/);
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
    // A minute after it was first seen, then after 1, 5, 15 and 60 minutes, then every six hours for good.
    expect(times.slice(0, 5)).toEqual([90, 150, 450, 1350, 4950]);
    const gaps = times.slice(1).map((value, index) => value - times[index]!);
    expect(gaps.slice(4)).toEqual(new Array(gaps.length - 4).fill(6 * 60 * 60));
    expect(times.length).toBeGreaterThanOrEqual(11);
    expect(times.at(-1)!).toBeGreaterThan(44 * 60 * 60);
    // No laptop was rebuilt against the dead pool, no attempt of anyone's ladder was spent, nobody was asked.
    expect(w.state.acts).toEqual([]);
    expect(w.state.histories.get('a')?.attempts ?? {}).toEqual({});
    expect(w.report('a').needsHuman).toBeUndefined();
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

  it('waits when the home could not be read, and reads again at the next pass', async () => {
    const w = box([person('a')]);
    w.state.people[0]!.storedHome = 'unknown';
    await w.run(5 * MINUTE);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').waitingFor).toBe("a read of the laptop's stored home directory");
    expect(w.report('a').needsHuman).toBeUndefined();
    w.state.people[0]!.storedHome = 'verified';
    await w.run(2 * MINUTE);
    expect(w.state.acts.map((line) => line.split(':')[1])).toContain('rebuild-laptop');
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
