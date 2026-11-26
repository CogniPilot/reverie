import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EmployeeSupervisor,
  type EmployeeSupervisorPorts,
  type SupervisedEmployee,
  type SupervisorActionResult,
  type SupervisorAuditEntry,
  type SupervisorLaptopReading,
  type SupervisorMove,
} from '../src/employee-supervisor.js';
import { EmployeeSupervisorStore } from '../src/employee-supervisor-store.js';
import type {
  SupervisorAction,
  SupervisorHistory,
  SupervisorObservation,
  SupervisorProviderPresence,
} from '../src/employee-supervisor-policy.js';

const MINUTE = 60_000;
const LIMITS = { actionsPerTick: 2, startupGraceMs: 0, actionWaitMs: 50, idleReadMs: 0, limitsCheckMs: 10 * MINUTE };

interface Person {
  employee: SupervisedEmployee;
  glance: Omit<SupervisorObservation, 'move' | 'planSignedIn'>;
  reading?: SupervisorLaptopReading;
  move?: SupervisorMove;
  provider: SupervisorProviderPresence;
  source: 'stopped' | 'running' | 'absent' | 'outdated' | 'unknown';
}

function person(id: string, patch: Partial<SupervisedEmployee> = {}): Person {
  const employee: SupervisedEmployee = {
    id,
    name: id.toUpperCase(),
    owner: undefined,
    sessionId: 'session-' + id,
    sessionGeneration: 1,
    desiredRunning: true,
    onVacation: false,
    bindingMigration: false,
    planAccountId: 'plan-a',
    planLabel: 'Plan A',
    ...patch,
  };
  return {
    employee,
    provider: 'absent',
    source: 'stopped',
    glance: {
      employeeId: id,
      name: employee.name,
      desiredRunning: employee.desiredRunning,
      onVacation: employee.onVacation,
      bindingMigration: false,
      boxed: true,
      planLabel: 'Plan A',
      session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', providerHealth: 'healthy' },
      laptop: {
        record: { phase: 'ready', version: 2, operationId: 'op-' + id },
        bound: true,
        policyApproved: true,
        restoration: { state: 'attached' },
        templateOnRecord: true,
        poolAlive: true,
      },
    },
  };
}
/** The laptop is held at `code`; the terminal is not attached. */
function hold(target: Person, code: string, allowedActions: string[] = ['observe']): Person {
  target.glance = {
    ...target.glance,
    session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'disconnected', providerHealth: 'unknown' },
    laptop: {
      ...target.glance.laptop,
      record: { phase: 'resources-issued', version: 2, operationId: 'op-' + target.employee.id },
      restoration: { state: 'held', code: 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING' },
    },
  };
  target.reading = { state: 'held', phase: 'resources-issued', code, allowedActions };
  return target;
}
function heldMove(target: Person, error: string): Person {
  target.move = {
    id: 'move-' + target.employee.id,
    docker: true,
    phase: 'recovery-required',
    busy: false,
    error,
    allowedActions: ['continue-original', 'abandon'],
    toAccount: 'plan-b',
  };
  return target;
}

function world(
  people: Person[],
  options: {
    limits?: typeof LIMITS;
    histories?: Map<string, SupervisorHistory>;
    /** The office's answer to a limits check. Without it the office has no such port. */
    keepLimits?: (employee: SupervisedEmployee) => Promise<SupervisorActionResult | undefined>;
  } = {}
) {
  const state = {
    now: 10 * MINUTE,
    ready: true,
    flags: { enabled: true, autoRepair: true },
    reads: [] as string[],
    acts: [] as string[],
    /** Limits checks, as `<seconds since the start>:<employee>`. */
    kept: [] as string[],
    logs: [] as string[],
    audits: [] as SupervisorAuditEntry[],
    saves: [] as Array<Map<string, SupervisorHistory>>,
    stored: options.histories ?? new Map<string, SupervisorHistory>(),
    signedIn: undefined as boolean | undefined,
    people,
    respond: (async () => ({ outcome: 'done' })) as (
      action: SupervisorAction,
      employee: SupervisedEmployee
    ) => Promise<SupervisorActionResult>,
  };
  const find = (employee: SupervisedEmployee) => state.people.find((row) => row.employee.id === employee.id)!;
  const act =
    (action: SupervisorAction) =>
    async (employee: SupervisedEmployee, guard: () => void): Promise<SupervisorActionResult> => {
      guard();
      state.acts.push(`${action}:${employee.id}`);
      return state.respond(action, employee);
    };
  const ports: EmployeeSupervisorPorts = {
    now: () => state.now,
    ready: () => state.ready,
    employees: () => state.people.map((row) => row.employee),
    flags: () => state.flags,
    glance: (employee) => {
      state.reads.push('glance:' + employee.id);
      return find(employee).glance;
    },
    openMove: async (employee) => {
      state.reads.push('move:' + employee.id);
      return find(employee).move;
    },
    planSignedIn: async (account) => {
      state.reads.push('plan:' + account);
      return state.signedIn;
    },
    readLaptop: async (employee) => {
      state.reads.push('laptop:' + employee.id);
      return find(employee).reading;
    },
    readSource: async (employee) => {
      state.reads.push('source:' + employee.id);
      return find(employee).source;
    },
    readProvider: async (employee) => {
      state.reads.push('provider:' + employee.id);
      return find(employee).provider;
    },
    ...(options.keepLimits
      ? {
          keepLimits: async (employee: SupervisedEmployee, guard: () => void) => {
            guard();
            state.kept.push(`${(state.now - 10 * MINUTE) / 1000}:${employee.id}`);
            return options.keepLimits!(employee);
          },
        }
      : {}),
    actions: {
      'resend-continuation': act('resend-continuation'),
      'start-continuation': act('start-continuation'),
      'continue-move': act('continue-move'),
      'reconnect-viewer': act('reconnect-viewer'),
      'abandon-move': act('abandon-move'),
      'rebuild-laptop': act('rebuild-laptop'),
    },
    load: () => new Map(state.stored),
    save: async (histories) => {
      state.stored = new Map(histories);
      state.saves.push(new Map(histories));
    },
    audit: (entry) => state.audits.push(entry),
    log: (line) => state.logs.push(line),
  };
  const supervisor = new EmployeeSupervisor(ports, undefined, options.limits ?? LIMITS);
  /** Tick every 30 s for `minutes`, as the office timer does. */
  const run = async (minutes: number) => {
    for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
      state.now += 30_000;
      await supervisor.tick();
    }
  };
  return { state, ports, supervisor, run, report: (id: string) => supervisor.reports(undefined).find((row) => row.employeeId === id)! };
}

describe('EmployeeSupervisor', () => {
  it('reads a healthy employee from memory and does nothing', async () => {
    const w = world([person('a')]);
    await w.run(5);
    expect(w.state.acts).toEqual([]);
    expect(new Set(w.state.reads)).toEqual(new Set(['glance:a', 'move:a']));
    expect(w.report('a')).toMatchObject({ condition: 'healthy', sentence: 'A is running.' });
    expect(w.report('a').needsHuman).toBeUndefined();
    // Nothing worth remembering, so nothing is written.
    expect(w.state.saves).toEqual([]);
  });

  it('never reads or repairs an employee the owner stopped, whatever is wrong with their laptop', async () => {
    for (const patch of [{ desiredRunning: false }, { onVacation: true }, { desiredRunning: undefined }]) {
      const stopped = heldMove(hold(person('a', patch), 'DOCKER_RESOURCE_HELPER_FAILED'), 'DOCKER_RESOURCE_HELPER_FAILED');
      const w = world([stopped]);
      await w.run(60);
      expect(w.state.reads).toEqual([]);
      expect(w.state.acts).toEqual([]);
      expect(w.report('a')).toMatchObject({ condition: 'owner-stopped' });
    }
  });

  it('re-sends a held step with backoff, stops at the bound, then rebuilds a laptop nothing runs in', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue', 'retry', 'rebuild-preview'])]);
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      at.push([(w.state.now - 10 * MINUTE) / 1000, action]);
      return { outcome: 'refused', detail: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING' };
    };
    await w.run(40);
    expect(at).toEqual([
      [60, 'resend-continuation'], // first seen at 30 s, 20 s dwell, next tick
      [90, 'resend-continuation'], // +30 s
      [210, 'resend-continuation'], // +2 min
      [510, 'resend-continuation'], // +5 min
      [630, 'rebuild-laptop'], // +2 min to settle, then the next rung
      [1530, 'rebuild-laptop'], // +15 min
    ]);
    expect(w.report('a').needsHuman).toMatch(/Repeating the step and rebuilding did not help/);
    expect(w.state.reads.filter((read) => read === 'provider:a')).toHaveLength(2);
  });

  describe('a set-up made for a laptop image the office no longer uses, with no laptop running', () => {
    const CODE = 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED';
    /** As seen after an office deploy: held at `pool-issued`, the read still offers `continue`, nothing runs. */
    const outdated = () => {
      const target = hold(person('a'), CODE, ['observe', 'continue']);
      target.glance.laptop = {
        ...target.glance.laptop,
        record: { phase: 'pool-issued', version: 2, operationId: 'op-a' },
      };
      target.reading = { ...target.reading!, phase: 'pool-issued' };
      target.provider = 'no-laptop';
      return target;
    };
    /** The laptop services as the supervisor's steps leave them: a refused request, a rebuilt source, a start. */
    const office = (target: Person, w: ReturnType<typeof world>) => {
      const at: Array<[number, string]> = [];
      w.state.respond = async (action) => {
        at.push([(w.state.now - 10 * MINUTE) / 1000, action]);
        if (action === 'rebuild-laptop') {
          // The rebuild retires the record and leaves a fresh, stopped source made from the current image.
          const { restoration: _restoration, ...laptop } = target.glance.laptop;
          target.glance = { ...target.glance, laptop: { ...laptop, record: null } };
          target.reading = undefined;
          target.source = 'stopped';
          return { outcome: 'done', detail: 'rebuilt op-new' };
        }
        if (action === 'start-continuation') {
          target.glance = person('a').glance;
          return { outcome: 'done', detail: 'ready' };
        }
        return { outcome: 'refused', detail: CODE };
      };
      return at;
    };

    it('sends the request once, then rebuilds the laptop and starts it, and asks nobody', async () => {
      const target = outdated();
      const w = world([target]);
      const at = office(target, w);
      await w.run(1);
      expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild', code: CODE });
      await w.run(9);
      expect(at).toEqual([
        [60, 'resend-continuation'], // first seen at 30 s, 20 s dwell, next tick
        [210, 'rebuild-laptop'], // three minutes after it was first seen; the refused re-send is not repeated
        [270, 'start-continuation'], // the fresh source, 20 s dwell, next tick
      ]);
      // The one read a rebuild depends on was made right before it, and found no laptop running.
      expect(w.state.reads.filter((read) => read === 'provider:a')).toHaveLength(1);
      expect(w.report('a')).toMatchObject({ condition: 'healthy' });
      expect(w.report('a').needsHuman).toBeUndefined();
      expect(w.state.logs.some((line) => line.includes('needs a person'))).toBe(false);
      await w.run(60);
      expect(at).toHaveLength(3);
    });

    it('never rebuilds it while an agent runs in a laptop of that employee', async () => {
      const target = outdated();
      target.provider = 'running';
      const w = world([target]);
      const at = office(target, w);
      await w.run(120);
      expect(at.map(([, action]) => action)).toEqual(['resend-continuation']);
      expect(w.report('a').needsHuman).toMatch(/confirmDiscardRunning/);
    });

    it('with automatic repairs switched off, sends the request once and then names the switch and the calls', async () => {
      const target = outdated();
      const w = world([target]);
      w.state.flags = { enabled: true, autoRepair: false };
      const at = office(target, w);
      await w.run(120);
      expect(at).toEqual([[60, 'resend-continuation']]);
      expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild' });
      expect(w.report('a').next).toBeUndefined();
      expect(w.report('a').needsHuman).toMatch(/supervisorAutoRepair.*docker-rebuild\/preview/);
      // Switched on, the same laptop is rebuilt and started without anything else being asked of the owner.
      w.state.flags = { enabled: true, autoRepair: true };
      await w.run(3);
      expect(at.map(([, action]) => action)).toEqual(['resend-continuation', 'rebuild-laptop', 'start-continuation']);
      expect(w.report('a')).toMatchObject({ condition: 'healthy' });
    });
  });

  it('never rebuilds while an agent is running in the laptop, and says who has to decide', async () => {
    const running = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    running.provider = 'running';
    const w = world([running]);
    await w.run(120);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild' });
    expect(w.report('a').needsHuman).toMatch(/would discard its conversation.*confirmDiscardRunning/);
    expect(w.state.logs.filter((line) => line.includes('needs a person'))).toHaveLength(1);
  });

  it('does not keep asking an occupied laptop what runs in it, and still reads again before any rebuild', async () => {
    const occupied = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    occupied.provider = 'running';
    const w = world([occupied], { limits: { ...LIMITS, idleReadMs: 120_000 } });
    await w.run(20);
    const reads = () => w.state.reads.filter((read) => read === 'provider:a').length;
    // Forty passes; one read when the rebuild first came due, then one per two minutes.
    expect(reads()).toBeLessThanOrEqual(9);
    expect(reads()).toBeGreaterThanOrEqual(7);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').needsHuman).toMatch(/needs the owner/);
    // The agent exits. A reading that found the laptop occupied is never what a rebuild is decided on.
    occupied.provider = 'exited';
    const before = reads();
    await w.run(3);
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
    expect(reads()).toBe(before + 1);
  });

  it('never rebuilds on a laptop it could not read, and asks for a person once that lasts', async () => {
    const unread = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    unread.provider = 'unknown';
    const w = world([unread]);
    await w.run(10);
    expect(w.report('a').waitingFor).toBe('a confirmed read of what is running in the laptop');
    await w.run(10);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').needsHuman).toMatch(/cannot read what is running/);
  });

  it('starts the fresh source a rebuild leaves behind', async () => {
    const failed = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    const w = world([failed]);
    w.state.respond = async (action) => {
      if (action === 'rebuild-laptop') {
        failed.reading = undefined;
        failed.glance = { ...failed.glance, laptop: { ...failed.glance.laptop, record: null, bound: false, restoration: undefined } };
      }
      if (action === 'start-continuation') Object.assign(failed, person('a'));
      return { outcome: 'done' };
    };
    await w.run(10);
    expect(w.state.acts).toEqual(['rebuild-laptop:a', 'start-continuation:a']);
    expect(w.report('a')).toMatchObject({ condition: 'healthy', last: { action: 'start-continuation', outcome: 'done' } });
    expect(w.state.audits.map((entry) => [entry.admin, entry.action, entry.target])).toEqual([
      ['office supervisor', 'supervisor_rebuild_laptop', 'A'],
      ['office supervisor', 'supervisor_start_continuation', 'A'],
    ]);
  });

  it('replaces an unused laptop that was made for an earlier laptop image, then starts the new one', async () => {
    // The office was redeployed with another laptop image while a rebuilt laptop had not been started yet.
    const stale = person('a');
    stale.source = 'outdated';
    stale.provider = 'no-laptop';
    stale.glance = {
      ...stale.glance,
      session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'disconnected', providerHealth: 'unknown' },
      laptop: { ...stale.glance.laptop, record: null, bound: false, restoration: undefined },
    };
    const w = world([stale]);
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      at.push([(w.state.now - 10 * MINUTE) / 1000, action]);
      if (action === 'rebuild-laptop') stale.source = 'stopped';
      if (action === 'start-continuation') Object.assign(stale, person('a'));
      return { outcome: 'done' };
    };
    await w.run(2);
    expect(w.report('a')).toMatchObject({
      condition: 'held-needs-rebuild',
      code: 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED',
      sentence: "A's laptop has never been started and was made for an earlier laptop image, so the office cannot start it.",
      next: { action: 'rebuild-laptop' },
    });
    expect(w.report('a')).not.toHaveProperty('needsHuman');
    await w.run(8);
    // Three minutes on the same finding, a fresh read that nothing runs, the rebuild, and then the ordinary start.
    expect(at).toEqual([
      [210, 'rebuild-laptop'],
      [270, 'start-continuation'], // seen stopped at 240 s, 20 s dwell, next tick
    ]);
    expect(w.state.reads.filter((read) => read === 'provider:a')).toHaveLength(1);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });

    // With automatic repairs switched off nothing is replaced, and the owner is told the calls.
    const off = person('b');
    off.source = 'outdated';
    off.glance = { ...off.glance, laptop: { ...off.glance.laptop, record: null, bound: false, restoration: undefined } };
    const told = world([off]);
    told.state.flags = { enabled: true, autoRepair: false };
    await told.run(10);
    expect(told.state.acts).toEqual([]);
    expect(told.report('b').needsHuman).toMatch(
      /Automatic repairs are switched off.*POST \/api\/company\/employees\/:id\/docker-rebuild\/preview, then \/apply/
    );
  });

  it('continues a held move three times, then abandons it after fifteen minutes on the same error', async () => {
    const stuck = heldMove(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    const w = world([stuck]);
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      at.push([(w.state.now - 10 * MINUTE) / MINUTE, action]);
      if (action === 'abandon-move') stuck.move = undefined;
      return { outcome: 'done' };
    };
    await w.run(30);
    expect(at).toEqual([
      [1.5, 'continue-move'],
      [3.5, 'continue-move'],
      [8.5, 'continue-move'],
      [15.5, 'abandon-move'],
    ]);
    expect(w.state.audits.at(-1)).toMatchObject({
      admin: 'office supervisor',
      action: 'supervisor_abandon_move',
      detail: { id: 'a', moveId: 'move-a', condition: 'move-held-dead-end', outcome: 'done', attempt: 1 },
    });
    // The laptop is not read while a move owns the employee.
    expect(w.state.reads.filter((read) => read.startsWith('laptop:'))).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });
  });

  it('retries with repairs switched off but neither abandons nor rebuilds', async () => {
    const w = world([heldMove(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED'), hold(person('b'), 'DOCKER_RESOURCE_HELPER_FAILED')]);
    w.state.flags = { enabled: true, autoRepair: false };
    await w.run(60);
    expect(new Set(w.state.acts)).toEqual(new Set(['continue-move:a']));
    expect(w.state.acts).toHaveLength(3);
    expect(w.report('a').needsHuman).toMatch(/supervisorAutoRepair/);
    expect(w.report('b').needsHuman).toMatch(/supervisorAutoRepair.*docker-rebuild/);
    expect(w.state.reads).not.toContain('provider:b');
  });

  it('only describes what it sees when it is switched off', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    w.state.flags = { enabled: false, autoRepair: true };
    await w.run(60);
    expect(w.state.acts).toEqual([]);
    expect(new Set(w.state.reads)).toEqual(new Set(['glance:a']));
    expect(w.report('a').sentence).toBe("A's laptop set-up has not finished yet.");
  });

  it('stops an action that was decided before the switch was turned off', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    let guarded: (() => void) | undefined;
    w.ports.actions['resend-continuation'] = async (_employee, guard) => {
      guarded = guard;
      return { outcome: 'done' };
    };
    await w.run(1);
    expect(guarded).toBeDefined();
    expect(() => guarded!()).not.toThrow();
    w.state.flags = { enabled: false, autoRepair: false };
    expect(() => guarded!()).toThrow(/switched off/);
    w.state.flags = { enabled: true, autoRepair: true };
    w.state.people[0]!.employee = { ...w.state.people[0]!.employee, onVacation: true };
    expect(() => guarded!()).toThrow(/no longer meant to be running/);
  });

  it('does nothing in the first moments after the office starts', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])], {
      limits: { ...LIMITS, startupGraceMs: 90_000 },
    });
    // Starting the office changes nothing by itself: not even a read.
    await w.run(1);
    expect(w.state.reads).toEqual([]);
    expect(w.supervisor.reports(undefined)).toEqual([]);
    await w.run(0.5);
    expect(w.state.reads).toContain('laptop:a');
    expect(w.state.acts).toEqual([]);
    await w.run(0.5);
    expect(w.state.acts).toEqual(['resend-continuation:a']);
  });

  it('reads a laptop that waits for a person only every two minutes, and never acts on a kept reading', async () => {
    const waiting = hold(person('a'), 'DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED');
    const w = world([waiting], { limits: { ...LIMITS, idleReadMs: 120_000 } });
    await w.run(10);
    // 20 passes in ten minutes, one read per two minutes.
    expect(w.state.reads.filter((read) => read === 'laptop:a')).toHaveLength(5);
    expect(w.report('a')).toMatchObject({ condition: 'needs-owner' });
    // The owner approves the limits: the hold becomes one the supervisor can continue.
    const before = w.state.reads.filter((read) => read === 'laptop:a').length;
    waiting.reading = { state: 'held', phase: 'resources-issued', code: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', allowedActions: ['observe', 'continue'] };
    await w.run(4);
    expect(w.state.acts[0]).toBe('resend-continuation:a');
    expect(w.state.reads.filter((read) => read === 'laptop:a').length).toBeGreaterThan(before);
  });

  it('keeps its ladder across an office restart instead of starting over in a burst', async () => {
    const people = [hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])];
    const first = world(people);
    first.state.respond = async () => ({ outcome: 'refused', detail: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING' });
    await first.run(4);
    expect(first.state.acts).toHaveLength(3);
    const second = world(people, { histories: first.state.stored });
    second.state.now = first.state.now;
    second.state.respond = first.state.respond;
    await second.run(3);
    // The fourth attempt is due five minutes after the third, not immediately after the restart.
    expect(second.state.acts).toEqual([]);
    await second.run(3);
    expect(second.state.acts).toEqual(['resend-continuation:a']);
    expect(second.state.stored.get('a')?.attempts['resend-continuation']?.count).toBe(4);
  });

  it('writes an attempt down before its effect', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    let seen: SupervisorHistory | undefined;
    w.state.respond = async () => {
      seen = w.state.stored.get('a');
      throw Object.assign(new Error('boom /secret/path'), { code: 'EPIPE' });
    };
    await w.run(1);
    expect(seen).toMatchObject({ attempts: { 'resend-continuation': { count: 1 } }, lastAction: { outcome: 'issued' } });
    expect(w.state.stored.get('a')?.lastAction).toMatchObject({ outcome: 'failed', detail: 'EPIPE' });
    expect(w.state.logs.join('\n')).not.toMatch(/secret/);
  });

  it('gives an attempt back when another operation held the employee', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    w.state.respond = async () => ({ outcome: 'busy', detail: 'DOCKER_CONTINUATION_BUSY' });
    await w.run(1);
    expect(w.state.stored.get('a')?.attempts['resend-continuation']).toMatchObject({ count: 0 });
    expect(w.state.acts).toHaveLength(1);
  });

  it('starts nothing beside an operation the office already runs for the employee', async () => {
    const busy = hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue']);
    busy.glance = { ...busy.glance, busy: 'continuation-flight' };
    const w = world([busy]);
    await w.run(30);
    expect(w.state.acts).toEqual([]);
    expect(w.state.reads.filter((read) => read.startsWith('laptop:'))).toEqual([]);
  });

  it('never has two actions in flight for one employee', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    let release!: (result: SupervisorActionResult) => void;
    let running = 0;
    let most = 0;
    w.state.respond = () => {
      most = Math.max(most, ++running);
      return new Promise<SupervisorActionResult>((resolve) => {
        release = (result) => {
          running--;
          resolve(result);
        };
      });
    };
    await w.run(20);
    expect(w.state.acts).toEqual(['resend-continuation:a']);
    expect(w.report('a').waitingFor).toBe('the last step to return');
    release({ outcome: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.report('a').last).toMatchObject({ action: 'resend-continuation', outcome: 'done' });
    await w.run(1);
    expect(w.state.acts).toHaveLength(2);
    release({ outcome: 'done' });
    expect(most).toBe(1);
  });

  it('starts at most two actions per pass and serves whoever waited longest first', async () => {
    const people = ['a', 'b', 'c'].map((id) => hold(person(id), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue']));
    const w = world(people);
    await w.run(0.5);
    expect(w.state.acts).toEqual([]);
    w.state.now += 30_000;
    await w.supervisor.tick();
    expect(w.state.acts).toEqual(['resend-continuation:a', 'resend-continuation:b']);
    w.state.now += 30_000;
    await w.supervisor.tick();
    expect(w.state.acts.slice(2)).toEqual(['resend-continuation:c', 'resend-continuation:a']);
  });

  it('keeps checking the others when one employee cannot be read', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue']), person('b')]);
    w.ports.readLaptop = async () => {
      throw new Error('engine down');
    };
    await expect(w.run(1)).resolves.toBeUndefined();
    expect(w.report('b')).toMatchObject({ condition: 'healthy' });
    expect(w.state.logs.some((line) => line.includes('A (a): could not be checked'))).toBe(true);
    expect(w.state.acts).toEqual([]);
  });

  it('does nothing until the office is ready, and joins a pass that is still running', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    w.state.ready = false;
    await w.run(5);
    expect(w.state.reads).toEqual([]);
    w.state.ready = true;
    await w.run(0.5);
    w.state.now += MINUTE;
    const [first, second] = [w.supervisor.tick(), w.supervisor.tick()];
    expect(second).toBe(first);
    await first;
    expect(w.state.acts).toHaveLength(1);
  });

  it('asks whether the plan is signed in and never answers the screen', async () => {
    const waiting = person('a');
    waiting.glance = {
      ...waiting.glance,
      session: { ...waiting.glance.session, startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false } },
    };
    const w = world([waiting]);
    w.state.signedIn = true;
    await w.run(60);
    expect(w.state.acts).toEqual([]);
    expect(w.state.reads).toContain('plan:plan-a');
    expect(w.report('a')).toMatchObject({ condition: 'needs-sign-in', sentence: "A is waiting at Claude's sign-in screen." });
    expect(w.report('a').needsHuman).toMatch(/the plan “Plan A” is signed in at the office/);
  });

  it('skips a step this office has no port for', async () => {
    const dead = hold(person('a'), 'DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED');
    dead.provider = 'exited';
    const w = world([dead]);
    // No relaunch port: the policy goes on to the rebuild.
    await w.run(5);
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
    delete (w.ports.actions as Record<string, unknown>)['rebuild-laptop'];
    await w.run(30);
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
  });

  it('forgets an employee who left the company and stops when it is closed', async () => {
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])]);
    await w.run(1);
    expect(w.state.stored.has('a')).toBe(true);
    w.state.people = [];
    await w.run(1);
    expect(w.state.stored.has('a')).toBe(false);
    expect(w.supervisor.reports(undefined)).toEqual([]);
    w.supervisor.close();
    w.state.people = [hold(person('b'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue'])];
    await w.run(5);
    expect(w.state.acts).toEqual(['resend-continuation:a']);
  });

  it('shows only the employees of the asking owner', async () => {
    const w = world([person('a'), person('b', { owner: 'someone' })]);
    await w.run(1);
    expect(w.supervisor.reports(undefined).map((row) => row.employeeId)).toEqual(['a']);
    expect(w.supervisor.reports('someone').map((row) => row.employeeId)).toEqual(['b']);
  });
});

describe('EmployeeSupervisor: keeping approved limits in place', () => {
  const restored = async (): Promise<SupervisorActionResult> => ({ outcome: 'done', detail: 'restored' });
  const unchanged = async (): Promise<SupervisorActionResult> => ({ outcome: 'done', detail: 'unchanged' });

  it('puts the limits of a running laptop back for an employee who is out of the office or stopped', async () => {
    for (const patch of [{ onVacation: true }, { desiredRunning: false }, { desiredRunning: undefined }]) {
      const away = hold(person('a', patch), 'DOCKER_RESOURCE_HELPER_FAILED');
      const w = world([away], { keepLimits: restored });
      await w.run(1);
      expect(w.state.kept).toEqual(['30:a']);
      // Nothing else was read, no repair step was taken, and the employee is described as before.
      expect(w.state.reads).toEqual([]);
      expect(w.state.acts).toEqual([]);
      expect(w.report('a')).toMatchObject({
        condition: 'owner-stopped',
        limits: { at: 10 * MINUTE + 30_000, outcome: 'done', detail: 'restored' },
      });
      expect(w.report('a').next).toBeUndefined();
      expect(w.state.logs).toEqual(['[supervisor] A (a): keep-limits -> done restored']);
      expect(w.state.audits).toEqual([
        {
          admin: 'office supervisor',
          action: 'supervisor_keep_limits',
          target: 'A',
          detail: { id: 'a', sessionId: 'session-a', outcome: 'done', detail: 'restored' },
        },
      ]);
      // No attempt of the repair ladder is spent and nothing is written for it.
      expect(w.state.saves).toEqual([]);
    }
  });

  it('checks each laptop again every ten minutes, one employee per pass, and says nothing while all is in place', async () => {
    const w = world([person('a', { onVacation: true }), person('b', { onVacation: true }), person('c')], {
      keepLimits: unchanged,
    });
    await w.run(21);
    expect(w.state.kept).toEqual(['30:a', '60:b', '90:c', '630:a', '660:b', '690:c', '1230:a', '1260:b']);
    expect(w.state.logs).toEqual([]);
    expect(w.state.audits).toEqual([]);
    expect(w.report('a').limits).toEqual({ at: 10 * MINUTE + 1230_000, outcome: 'done', detail: 'unchanged' });
    // An employee who is running normally is checked the same way; nothing about them is touched.
    expect(w.report('c')).toMatchObject({ condition: 'healthy', limits: { outcome: 'done', detail: 'unchanged' } });
    expect(w.state.acts).toEqual([]);
  });

  it('leaves a laptop the repair ladder is working on to the ladder', async () => {
    const held = hold(person('a'), 'DOCKER_RESOURCE_LEAF_ACK_MISSING', ['observe', 'repair']);
    const w = world([held], { keepLimits: restored });
    await w.run(3);
    expect(w.state.kept).toEqual([]);
    expect(w.state.acts[0]).toBe('resend-continuation:a');
  });

  it('reports a refusal once, and again only when it changes or ends', async () => {
    let answer: SupervisorActionResult | undefined = { outcome: 'refused', detail: 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED' };
    const w = world([person('a', { onVacation: true })], { keepLimits: async () => answer });
    await w.run(31);
    expect(w.state.kept).toHaveLength(4);
    expect(w.state.logs).toEqual(['[supervisor] A (a): keep-limits -> refused DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED']);
    expect(w.report('a').limits).toMatchObject({ outcome: 'refused', detail: 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED' });
    answer = { outcome: 'failed', detail: 'Error' };
    await w.run(10);
    expect(w.state.logs).toHaveLength(2);
    answer = { outcome: 'done', detail: 'not-running' };
    await w.run(10);
    expect(w.state.logs).toHaveLength(2);
    expect(w.report('a').limits).toMatchObject({ outcome: 'done', detail: 'not-running' });
    // An employee with no finished laptop has nothing to keep and nothing to show.
    answer = undefined;
    await w.run(10);
    expect(w.report('a').limits).toBeUndefined();
  });

  it('asks again soon when another operation held the employee, and keeps the earlier finding', async () => {
    let answer: SupervisorActionResult = { outcome: 'done', detail: 'unchanged' };
    const w = world([person('a', { onVacation: true })], { keepLimits: async () => answer });
    await w.run(1);
    answer = { outcome: 'busy', detail: 'DOCKER_CONTINUATION_BUSY' };
    await w.run(11);
    expect(w.state.kept).toEqual(['30:a', '630:a', '690:a']);
    expect(w.report('a').limits).toMatchObject({ outcome: 'done', detail: 'unchanged' });
  });

  it('does nothing while the supervisor is switched off, the office is not ready or it has stopped', async () => {
    const w = world([person('a', { onVacation: true })], { keepLimits: restored });
    w.state.flags = { enabled: false, autoRepair: true };
    await w.run(5);
    w.state.flags = { enabled: true, autoRepair: false };
    w.state.ready = false;
    await w.run(5);
    expect(w.state.kept).toEqual([]);
    // Putting limits back gives nothing up: it needs the first switch only.
    w.state.ready = true;
    await w.run(1);
    expect(w.state.kept).toHaveLength(1);
    w.supervisor.close();
    await w.run(30);
    expect(w.state.kept).toHaveLength(1);
  });

  it('holds only for the unchanged employee, and never asks or changes where the employee is', async () => {
    const away = person('a', { onVacation: true });
    let guard!: () => void;
    const w = world([away]);
    w.ports.keepLimits = async (_employee, held) => {
      guard = held;
      return { outcome: 'done', detail: 'unchanged' };
    };
    await w.run(1);
    expect(() => guard()).not.toThrow();
    // Back in the office, or stopped: the same guard still holds.
    away.employee = { ...away.employee, onVacation: false };
    expect(() => guard()).not.toThrow();
    away.employee = { ...away.employee, desiredRunning: false };
    expect(() => guard()).not.toThrow();
    for (const change of [{ sessionGeneration: 2 }, { sessionId: 'another' }, { owner: 'someone' }, { bindingMigration: true }]) {
      const before = away.employee;
      away.employee = { ...before, ...change };
      expect(() => guard()).toThrow(/employee changed/);
      away.employee = before;
    }
    w.state.flags = { enabled: false, autoRepair: true };
    expect(() => guard()).toThrow(/switched off/);
  });

  it('never runs beside a repair step of the same employee', async () => {
    const target = person('a', { onVacation: true });
    let release!: (result: SupervisorActionResult) => void;
    const w = world([target], {
      keepLimits: () => new Promise<SupervisorActionResult>((resolve) => (release = resolve)),
    });
    await w.run(1);
    expect(w.state.kept).toEqual(['30:a']);
    // The employee comes back and their laptop is held, while the limits check has not returned.
    hold(target, 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue']);
    target.employee = { ...target.employee, onVacation: false };
    target.glance = { ...target.glance, onVacation: false };
    await w.run(5);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').waitingFor).toBe('the last step to return');
    release({ outcome: 'done', detail: 'restored' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await w.run(1);
    expect(w.state.acts).toEqual(['resend-continuation:a']);
  });
});

describe('EmployeeSupervisorStore', () => {
  const directories: string[] = [];
  const temporary = () => {
    const directory = mkdtempSync(join(tmpdir(), 'supervisor-'));
    directories.push(directory);
    return join(directory, 'state', 'employee-supervisor.json');
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const history: SupervisorHistory = {
    fingerprint: 'code:DOCKER_RESOURCE_HELPER_FAILED',
    since: 1000,
    attempts: { 'rebuild-laptop': { count: 1, lastAt: 2000 } },
    rebuilds: [2000],
    lastAction: { action: 'rebuild-laptop', at: 2000, outcome: 'done', detail: 'ready' },
  };

  it('reads back what it wrote', async () => {
    const file = temporary();
    await new EmployeeSupervisorStore(file).save(new Map([['a', history]]));
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map([['a', history]]));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, purpose: 'employee-supervisor-v1' });
  });

  it('remembers nothing from a missing or damaged file', async () => {
    const file = temporary();
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map());
    await new EmployeeSupervisorStore(file).save(new Map([['a', history]]));
    writeFileSync(file, '{"version":1,"purpose":"employee-supervisor-v1","employees":{"a":{"attempts":{"sudo":1}}}}');
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map());
    writeFileSync(file, 'not json');
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map());
  });

  it('keeps the last good write when writes are issued together', async () => {
    const file = temporary();
    const store = new EmployeeSupervisorStore(file);
    await Promise.all([
      store.save(new Map([['a', history]])),
      store.save(new Map([['b', history]])),
      store.save(new Map([['c', { ...history, since: 3000 }]])),
    ]);
    expect([...store.load().keys()]).toEqual(['c']);
  });
});
