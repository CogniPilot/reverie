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
/**
 * The agent runs in its laptop, but the office terminal is not attached and its input is held for good. A turn
 * that is not in progress ended at `idleSince`.
 */
function heldTerminal(target: Person, turn: 'working' | 'idle' | 'unknown', idleSince = 0): Person {
  target.glance = {
    ...target.glance,
    session: {
      available: true,
      runtimeHealth: 'unknown',
      viewerHealth: 'connected',
      providerHealth: 'healthy',
      inputHeld: true,
      turn,
      ...(turn === 'idle' ? { idleSince } : {}),
    },
    laptop: {
      ...target.glance.laptop,
      restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' },
    },
  };
  target.reading = { state: 'ready', phase: 'ready', allowedActions: ['observe'] };
  target.provider = 'running';
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
    /** What the office says it is doing about not being ready. */
    notReady?: () => string | undefined;
  } = {}
) {
  const state = {
    now: 10 * MINUTE,
    ready: true,
    flags: { enabled: true, autoRepair: true },
    reads: [] as string[],
    acts: [] as string[],
    /** What each step was told had been proved for it, as `[action, proved]`. */
    proved: [] as Array<[SupervisorAction, readonly string[]]>,
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
    async (
      employee: SupervisedEmployee,
      guard: () => void,
      _move?: SupervisorMove,
      proved: readonly string[] = []
    ): Promise<SupervisorActionResult> => {
      guard();
      state.acts.push(`${action}:${employee.id}`);
      state.proved.push([action, proved]);
      return state.respond(action, employee);
    };
  const ports: EmployeeSupervisorPorts = {
    now: () => state.now,
    ready: () => state.ready,
    ...(options.notReady ? { notReady: options.notReady } : {}),
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
      'apply-standing-limits': act('apply-standing-limits'),
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
    // Every rung of this round is used. Nobody is asked: the report says when the steps start again.
    expect(w.report('a').needsHuman).toBeUndefined();
    expect(w.report('a')).toMatchObject({
      waitingFor: expect.stringMatching(/^the next round of repair steps, which starts at .* UTC: this round's did not help$/),
      waitingUntil: 10 * MINUTE + 1530_000 + 6 * 60 * MINUTE,
    });
    expect(w.state.logs.some((line) => line.includes('needs a person'))).toBe(false);
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
      // Not while the office has no reading of that agent's pane; it waits for one and asks nobody.
      expect(w.report('a').waitingFor).toMatch(/^a reading of the agent's terminal/);
      expect(w.report('a').needsHuman).toBeUndefined();
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

  it('does not rebuild a laptop an agent runs in while it has no reading of the pane, and asks nobody', async () => {
    const running = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    running.provider = 'running';
    const w = world([running]);
    await w.run(110);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({
      condition: 'held-needs-rebuild',
      waitingFor: expect.stringMatching(/^a reading of the agent's terminal; if there is still none, the laptop is rebuilt at/),
      waitingUntil: 10 * MINUTE + 30_000 + 120 * MINUTE,
    });
    expect(w.report('a').needsHuman).toBeUndefined();
    expect(w.state.logs.some((line) => line.includes('needs a person'))).toBe(false);
    // Two hours after the problem was first seen there is still no reading: the laptop is rebuilt.
    await w.run(15);
    expect(w.state.proved).toEqual([['rebuild-laptop', ['laptop-held', 'agent-unreadable']]]);
  });

  it('rebuilds a laptop an agent runs in between that agent’s turns, and never in the middle of one', async () => {
    const running = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    running.provider = 'running';
    const turn = (value: 'working' | 'idle', idleSince?: number) => {
      running.glance = {
        ...running.glance,
        session: { ...running.glance.session, turn: value, ...(idleSince === undefined ? {} : { idleSince }) },
      };
    };
    turn('working');
    const w = world([running]);
    // Far past every bound: a turn the office can see is waited for, however long it takes.
    await w.run(300);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({ waitingFor: "the agent's current turn to end" });
    expect(w.report('a').needsHuman).toBeUndefined();
    // The turn ends. One silent minute is not enough; after two the laptop is rebuilt.
    turn('idle', w.state.now);
    await w.run(1);
    expect(w.state.acts).toEqual([]);
    await w.run(1.5);
    expect(w.state.proved).toEqual([['rebuild-laptop', ['agent-between-turns', 'laptop-held']]]);
    expect(w.state.audits.find((entry) => entry.action === 'supervisor_rebuild_laptop')!.detail).toMatchObject({
      code: 'DOCKER_RESOURCE_HELPER_FAILED',
      proved: ['agent-between-turns', 'laptop-held'],
    });
  });

  it('looks at the terminal once more before such a rebuild, and does not issue it when a turn has just begun', async () => {
    const running = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    running.provider = 'running';
    const idle = { ...running.glance.session, turn: 'idle' as const, idleSince: 0 };
    running.glance = { ...running.glance, session: idle };
    const w = world([running]);
    // The first look of a pass sees the pane idle; the look made last, before the step, sees a turn.
    const glance = w.ports.glance;
    let looks = 0;
    w.ports.glance = (employee) => {
      const seen = glance(employee);
      return ++looks % 2 === 0 ? { ...seen, session: { ...seen.session, turn: 'working' as const } } : seen;
    };
    await w.run(20);
    expect(w.state.acts).toEqual([]);
    expect(w.state.stored.get('a')?.attempts['rebuild-laptop']).toBeUndefined();
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
    expect(w.report('a').waitingFor).toMatch(/^a reading of the agent's terminal/);
    expect(w.report('a').needsHuman).toBeUndefined();
    // The agent exits. A reading that found the laptop occupied is never what a rebuild is decided on.
    occupied.provider = 'exited';
    const before = reads();
    await w.run(3);
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
    expect(reads()).toBe(before + 1);
  });

  it('never takes a laptop it could not read for an empty one, and asks nobody while that lasts', async () => {
    const unread = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    unread.provider = 'unknown';
    const w = world([unread]);
    await w.run(10);
    expect(w.report('a').waitingFor).toBe('a confirmed read of what is running in the laptop');
    await w.run(10);
    // Past fifteen minutes it is treated as a laptop an agent runs in: rebuilt between turns, or after two hours.
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').waitingFor).toMatch(/^a reading of the agent's terminal; if there is still none/);
    expect(w.report('a').needsHuman).toBeUndefined();
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

  describe('a terminal the office can never type into again, with the agent still running', () => {
    /** Every reconnect is refused, as it is for a held terminal; a rebuild leaves a fresh source that then starts. */
    const office = (target: Person, options: Parameters<typeof world>[1] = {}) => {
      const w = world([target], options);
      w.state.respond = async (action) => {
        if (action === 'reconnect-viewer') return { outcome: 'refused', detail: 'start-unconfirmed' };
        if (action === 'rebuild-laptop') {
          target.reading = undefined;
          target.glance = {
            ...person('a').glance,
            session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown' },
            laptop: { ...target.glance.laptop, record: null, bound: false, restoration: undefined },
          };
        }
        if (action === 'start-continuation') Object.assign(target, person('a'));
        return { outcome: 'done' };
      };
      return w;
    };

    it('nudges once, waits for the turn to end and the pane to stay quiet, then rebuilds and starts the laptop', async () => {
      const stuck = heldTerminal(person('a'), 'working');
      const w = office(stuck);
      await w.run(10);
      // One nudge, not six: the refusal is the answer. Nothing is rebuilt in the middle of the turn.
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.report('a')).toMatchObject({
        condition: 'viewer-lost',
        sentence: "The office can no longer type into A's terminal, so the laptop has to be rebuilt once the agent's current turn has ended.",
        waitingFor: "the agent's current turn to end",
        last: { action: 'reconnect-viewer', outcome: 'refused', detail: 'start-unconfirmed' },
      });
      expect(w.report('a').needsHuman).toBeUndefined();
      // The turn ends. One silent minute is not enough; after two the laptop is rebuilt.
      heldTerminal(stuck, 'idle', w.state.now);
      await w.run(1.5);
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.report('a').waitingFor).toBe("the agent's terminal to stay quiet a little longer");
      await w.run(1);
      expect(w.state.acts).toEqual(['reconnect-viewer:a', 'rebuild-laptop:a']);
      await w.run(2);
      expect(w.state.acts).toEqual(['reconnect-viewer:a', 'rebuild-laptop:a', 'start-continuation:a']);
      expect(w.report('a')).toMatchObject({ condition: 'healthy' });
      // What runs in the laptop was never asked: this rebuild is not decided on an empty laptop, and says so.
      expect(w.state.reads).not.toContain('provider:a');
      expect(w.state.proved).toEqual([
        ['reconnect-viewer', []],
        ['rebuild-laptop', ['terminal-input-held']],
        ['start-continuation', []],
      ]);
      expect(w.state.audits.find((entry) => entry.action === 'supervisor_rebuild_laptop')!.detail).toMatchObject({
        condition: 'viewer-lost',
        code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED',
        outcome: 'done',
        proved: ['terminal-input-held'],
      });
      expect(w.state.logs.some((line) => line.includes('needs a person'))).toBe(false);
    });

    it('asks nobody when the turn has not ended after thirty minutes, and rebuilds when it has', async () => {
      const stuck = heldTerminal(person('a'), 'working');
      const w = office(stuck);
      await w.run(29);
      expect(w.report('a').needsHuman).toBeUndefined();
      await w.run(60);
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.report('a').waitingFor).toBe("the agent's current turn to end");
      expect(w.report('a').needsHuman).toBeUndefined();
      heldTerminal(stuck, 'idle', w.state.now);
      await w.run(3);
      expect(w.state.acts).toEqual(['reconnect-viewer:a', 'rebuild-laptop:a', 'start-continuation:a']);
      expect(w.state.logs.some((line) => line.includes('needs a person'))).toBe(false);
    });

    it('never takes a pane it is not reading for an idle one, and rebuilds after two hours without a reading', async () => {
      const w = office(heldTerminal(person('a'), 'unknown'));
      await w.run(20);
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.report('a').waitingFor).toMatch(/^a reading of the agent's terminal; if there is still none, the laptop is rebuilt at/);
      await w.run(95);
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.report('a').needsHuman).toBeUndefined();
      // As after an office restart, which leaves no terminal object for a held session: the wait has an end.
      await w.run(10);
      expect(w.state.proved.slice(0, 2)).toEqual([
        ['reconnect-viewer', []],
        ['rebuild-laptop', ['terminal-input-held', 'agent-unreadable']],
      ]);
      expect(w.state.logs.some((line) => line.includes('needs a person'))).toBe(false);
    });

    it('rebuilds a held laptop at once when a read inside it finds no agent, whatever the pane', async () => {
      const empty = heldTerminal(person('a'), 'unknown');
      empty.provider = 'exited';
      const w = office(empty);
      await w.run(5);
      expect(w.state.proved.slice(0, 2)).toEqual([
        ['reconnect-viewer', []],
        ['rebuild-laptop', []],
      ]);
    });

    it('with automatic repairs switched off nudges once, then names the switch and the calls', async () => {
      const w = office(heldTerminal(person('a'), 'idle'));
      w.state.flags = { enabled: true, autoRepair: false };
      await w.run(60);
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.report('a').next).toBeUndefined();
      expect(w.report('a').needsHuman).toMatch(/supervisorAutoRepair.*docker-rebuild\/preview, then \/apply with confirmDiscardRunning/);
    });

    it('looks at the terminal once more before it issues the rebuild, and spends no attempt on a turn that just began', async () => {
      const stuck = heldTerminal(person('a'), 'idle');
      const w = office(stuck);
      // The pane is idle whenever a pass begins; while the laptop is being read, the agent starts a turn.
      let turnStarts = false;
      const readLaptop = w.ports.readLaptop;
      w.ports.readLaptop = async (employee, guard) => {
        if (turnStarts) heldTerminal(stuck, 'working');
        return readLaptop(employee, guard);
      };
      await w.run(2.5);
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      turnStarts = true;
      for (let pass = 0; pass < 6; pass++) {
        heldTerminal(stuck, 'idle');
        w.state.now += 30_000;
        await w.supervisor.tick();
      }
      expect(w.state.acts).toEqual(['reconnect-viewer:a']);
      expect(w.state.stored.get('a')!.attempts['rebuild-laptop']).toBeUndefined();
      expect(w.report('a').waitingFor).toBe("the agent's current turn to end");
      // The same when the hold itself is gone at that moment: no rebuild is issued for a terminal that takes input.
      w.ports.readLaptop = async (employee, guard) => {
        stuck.glance = { ...stuck.glance, session: { available: true, runtimeHealth: 'unknown', viewerHealth: 'connected' } };
        return readLaptop(employee, guard);
      };
      heldTerminal(stuck, 'idle');
      w.state.now += 30_000;
      await w.supervisor.tick();
      expect(w.state.acts.filter((act) => act.startsWith('rebuild'))).toEqual([]);
    });

    it('gives the attempt back when the step itself finds a turn in progress, and rebuilds once that turn has ended', async () => {
      const stuck = heldTerminal(person('a'), 'idle');
      const w = office(stuck);
      const respond = w.state.respond;
      let inTurn = true;
      w.state.respond = async (action, employee) =>
        action === 'rebuild-laptop' && inTurn
          ? { outcome: 'busy', detail: 'the agent is in the middle of a turn' }
          : respond(action, employee);
      await w.run(4);
      expect(w.state.acts.slice(0, 2)).toEqual(['reconnect-viewer:a', 'rebuild-laptop:a']);
      expect(w.state.stored.get('a')!.attempts['rebuild-laptop']!.count).toBe(0);
      // Never back to the nudge.
      expect(w.state.acts.filter((act) => act.startsWith('reconnect'))).toHaveLength(1);
      inTurn = false;
      await w.run(1);
      expect(w.report('a').last).toMatchObject({ action: 'rebuild-laptop', outcome: 'done' });
    });

    it('goes on nudging a lost terminal that still takes input, and never rebuilds for it', async () => {
      const lost = heldTerminal(person('a'), 'idle');
      lost.glance = { ...lost.glance, session: { available: true, runtimeHealth: 'unknown', viewerHealth: 'connected' } };
      const w = office(lost);
      await w.run(120);
      expect(w.state.acts).toEqual(Array(6).fill('reconnect-viewer:a'));
      expect(w.report('a').waitingFor).toMatch(/^the next round of repair steps/);
      expect(w.report('a').needsHuman).toBeUndefined();
      // Six hours after the last nudge the round starts again, and still nothing is rebuilt.
      await w.run(6 * 60);
      expect(w.state.acts.length).toBeGreaterThan(6);
      expect(w.state.acts.every((act) => act === 'reconnect-viewer:a')).toBe(true);
    });
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

  it('reads a laptop it has no step for only every two minutes, and never acts on a kept reading', async () => {
    const waiting = hold(person('a'), 'DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED');
    const w = world([waiting], { limits: { ...LIMITS, idleReadMs: 120_000 } });
    await w.run(10);
    // 20 passes in ten minutes, one read per two minutes.
    expect(w.state.reads.filter((read) => read === 'laptop:a')).toHaveLength(5);
    expect(w.report('a')).toMatchObject({ condition: 'laptop-not-started' });
    // The hold becomes one the supervisor can continue.
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

  it('asks whether the plan is signed in, and starts nothing again for a screen it cannot prove', async () => {
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
    expect(w.state.reads).not.toContain('laptop:a');
    expect(w.report('a')).toMatchObject({ condition: 'needs-sign-in', sentence: "A is waiting at Claude's sign-in screen." });
  });

  it('rebuilds a laptop whose agent is parked on a proved sign-in screen, after one more look at its terminal', async () => {
    const parked = person('a');
    const screen = { label: "Claude's sign-in screen", kind: 'credential' as const, answering: false, proof: 'widget' as const };
    parked.glance = { ...parked.glance, session: { ...parked.glance.session, startupScreen: screen, turn: 'idle', idleSince: 1 } };
    const w = world([parked]);
    w.state.signedIn = true;
    /** The time of every look at the terminal. */
    const looks: number[] = [];
    const glance = w.ports.glance;
    w.ports.glance = (employee) => {
      looks.push(w.state.now);
      return glance(employee);
    };
    await w.run(2);
    expect(w.state.acts).toEqual([]); // a rebuild waits three minutes from the first sight of the problem
    await w.run(2);
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
    expect(w.state.proved).toEqual([['rebuild-laptop', ['agent-parked-at-screen']]]);
    // What runs in the laptop is not asked: an agent does, and the pane says it is parked.
    expect(w.state.reads).not.toContain('provider:a');
    // The step was decided on a second look at the terminal in the same pass, like every rebuild of a laptop an
    // agent may run in. No other pass looked twice.
    const twice = [...new Set(looks)].filter((at) => looks.filter((value) => value === at).length === 2);
    expect(twice).toHaveLength(1);
    expect(looks.filter((value) => value === twice[0])).toHaveLength(2);
    expect(w.state.audits.at(-1)).toMatchObject({
      action: 'supervisor_rebuild_laptop',
      detail: { condition: 'needs-sign-in', proved: ['agent-parked-at-screen'] },
    });
    expect(w.state.logs.filter((line) => line.includes('needs a person'))).toEqual([]);
  });

  it('does not rebuild when the look taken before the step no longer shows the agent parked', async () => {
    const parked = person('a');
    const screen = { label: "Claude's theme chooser", kind: 'first-run' as const, answering: false, proof: 'launch' as const };
    const plain = parked.glance.session;
    const session = { ...plain, startupScreen: screen, turn: 'idle' as const, idleSince: 1 };
    parked.glance = { ...parked.glance, session };
    const w = world([parked]);
    const glance = w.ports.glance;
    // Between the pass's look and the second one the screen cleared: the agent reached its composer after all.
    let last = -1;
    w.ports.glance = (employee) => {
      const second = last === w.state.now;
      last = w.state.now;
      const seen = glance(employee);
      return second ? { ...seen, session: { ...plain, turn: 'idle', idleSince: 1 } } : seen;
    };
    await w.run(10);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').needsHuman).toBeUndefined();
    // And the same when the pane began to change instead.
    last = -1;
    w.ports.glance = (employee) => {
      const second = last === w.state.now;
      last = w.state.now;
      const seen = glance(employee);
      return second ? { ...seen, session: { ...session, turn: 'working', idleSince: undefined } } : seen;
    };
    await w.run(10);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'stuck-first-run-screen', waitingFor: "the agent's current turn to end" });
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

  it('checks a laptop the repair ladder is working on as well, and leaves the ladder its own step', async () => {
    const held = hold(person('a'), 'DOCKER_RESOURCE_LEAF_ACK_MISSING', ['observe', 'repair']);
    const w = world([held], { keepLimits: restored });
    await w.run(3);
    expect(w.state.kept).toEqual(['30:a']);
    expect(w.state.acts[0]).toBe('resend-continuation:a');
  });

  it('checks the limits of an employee whatever their condition reads, as long as no move step is running', async () => {
    // A lost terminal, a handoff that is still owed, a held move, a record of the retired runtime: in each the
    // laptop may well be running, and none of them is "running normally".
    const lost = person('a');
    lost.glance = { ...lost.glance, session: { ...lost.glance.session, viewerHealth: 'disconnected' } };
    const owing = person('b');
    owing.move = { id: 'move-b', docker: true, phase: 'handoff-owed', busy: false, allowedActions: [] };
    const heldBack = heldMove(person('c'), 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
    const retired = person('d');
    retired.move = { id: 'native', docker: false, phase: 'recovery-required', busy: false, error: 'x', allowedActions: ['settle'] };
    const w = world([lost, owing, heldBack, retired], { keepLimits: unchanged });
    w.state.respond = async () => ({ outcome: 'refused' });
    await w.run(3);
    expect(['a', 'b', 'c', 'd'].map((id) => w.report(id).condition)).toEqual([
      'viewer-lost',
      'move-held-retryable',
      'move-held-retryable',
      'move-held-dead-end',
    ]);
    expect(w.state.kept).toEqual(['30:a', '60:b', '90:c', '120:d']);
    expect(w.report('b').limits).toMatchObject({ outcome: 'done', detail: 'unchanged' });
  });

  it('does not check the limits of a laptop while a step of a plan move is running, and does once it has come back', async () => {
    const moving = heldMove(person('a'), 'x');
    moving.move = { ...moving.move!, busy: true };
    const w = world([moving], { keepLimits: unchanged });
    await w.run(15);
    expect(w.report('a').condition).toBe('move-in-progress');
    expect(w.state.kept).toEqual([]);
    moving.move = undefined;
    await w.run(1);
    expect(w.state.kept).toHaveLength(1);
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

describe('employee supervisor: a plan move that stopped part-way never waits for the owner', () => {
  const SIGN_IN =
    "Stan's new session is waiting at Claude's sign-in screen. The office never answers a sign-in prompt; sign in " +
    'the plan at the office, then continue.';
  /** Every step with the minute it ran at, counted from the first pass. */
  const record = (w: ReturnType<typeof world>, closes: (action: SupervisorAction) => void) => {
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      at.push([(w.state.now - 10 * MINUTE) / MINUTE, action]);
      closes(action);
      return action === 'abandon-move' ? { outcome: 'done', detail: 'abandoned' } : { outcome: 'refused' };
    };
    return at;
  };
  /** Run minute by minute and collect every sentence that asked for a person. */
  const quiet = async (w: ReturnType<typeof world>, minutes: number, id = 'a') => {
    const asked: string[] = [];
    for (let minute = 0; minute < minutes; minute++) {
      await w.run(1);
      const said = w.report(id)?.needsHuman;
      if (said) asked.push(said);
    }
    return asked;
  };

  it.each([false, undefined, true])(
    'continues a move at a sign-in screen three times and abandons it after fifteen minutes (plan signed in: %s)',
    async (signedIn) => {
      const stuck = heldMove(person('a'), SIGN_IN);
      const w = world([stuck]);
      w.state.signedIn = signedIn;
      const at = record(w, (action) => {
        if (action === 'abandon-move') stuck.move = undefined;
      });
      expect(await quiet(w, 20)).toEqual([]);
      expect(at).toEqual([
        [1.5, 'continue-move'],
        [3.5, 'continue-move'],
        [8.5, 'continue-move'],
        [15.5, 'abandon-move'],
      ]);
      expect(w.state.audits.at(-1)).toMatchObject({
        admin: 'office supervisor',
        action: 'supervisor_abandon_move',
        detail: { id: 'a', moveId: 'move-a', code: 'move-sign-in', outcome: 'done', attempt: 1 },
      });
      // Nothing about the move depends on the plan's sign-in, so it is not asked for: neither plan is read.
      expect(w.state.reads.filter((read) => read.startsWith('plan:'))).toEqual([]);
      expect(w.report('a')).toMatchObject({ condition: 'healthy' });
    }
  );

  it.each([
    ['a decision screen', "Stan's new session is waiting at Claude's usage-credit offer. That choice is the owner's; answer it in the session's terminal, then continue.", 15.5],
    ['an error the office does not recognize', 'The original Docker journal changed', 15.5],
    ['no recorded error', undefined, 15.5],
  ] as Array<[string, string | undefined, number]>)('continues a move held at %s three times and then abandons it', async (_title, error, minute) => {
    const stuck = heldMove(person('a'), error as string);
    const w = world([stuck]);
    const at = record(w, (action) => {
      if (action === 'abandon-move') stuck.move = undefined;
    });
    expect(await quiet(w, 40)).toEqual([]);
    expect(at).toEqual([
      [1.5, 'continue-move'],
      [3.5, 'continue-move'],
      [8.5, 'continue-move'],
      [minute, 'abandon-move'],
    ]);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });
  });

  it('probes a move held by the shared pool over thirty minutes and abandons it only after the last probe', async () => {
    const stuck = heldMove(person('a'), 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
    const w = world([stuck]);
    const at = record(w, (action) => {
      if (action === 'abandon-move') stuck.move = undefined;
    });
    expect(await quiet(w, 20)).toEqual([]);
    expect(at).toEqual([
      [1.5, 'continue-move'],
      [10.5, 'continue-move'],
    ]);
    // First seen at the first pass, half a minute in; the last probe is held back until thirty minutes after that.
    expect(w.report('a')).toMatchObject({
      waitingFor: 'the repair of what holds the move, which every laptop shares',
      waitingUntil: 10 * MINUTE + 30_000 + 30 * MINUTE,
    });
    expect(await quiet(w, 20)).toEqual([]);
    expect(at.slice(2)).toEqual([
      [30.5, 'continue-move'],
      [33.5, 'abandon-move'],
    ]);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });
  });

  it('never abandons a move whose outage ended before its last probe', async () => {
    const stuck = heldMove(person('a'), 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED');
    const w = world([stuck]);
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      const minute = (w.state.now - 10 * MINUTE) / MINUTE;
      at.push([minute, action]);
      // The pool is back twenty minutes in: the continue made after that finishes the move.
      if (minute > 20) stuck.move = undefined;
      return { outcome: minute > 20 ? 'done' : 'refused' };
    };
    expect(await quiet(w, 90)).toEqual([]);
    expect(at).toEqual([
      [1.5, 'continue-move'],
      [10.5, 'continue-move'],
      [30.5, 'continue-move'],
    ]);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });
  });

  it.each([
    ['a move of the retired runtime', { docker: false, allowedActions: ['settle'] }],
    ['a move that offers no step at all', { allowedActions: [] }],
    ['a move that offers only abandon', { allowedActions: ['abandon'] }],
  ])('closes %s after fifteen minutes without a continue', async (_title, patch) => {
    const stuck = heldMove(person('a'), 'x');
    stuck.move = { ...stuck.move!, ...patch };
    const w = world([stuck]);
    const at = record(w, (action) => {
      if (action === 'abandon-move') stuck.move = undefined;
    });
    expect(await quiet(w, 20)).toEqual([]);
    expect(at).toEqual([[15.5, 'abandon-move']]);
  });

  it('abandons once: a move that is closed is not asked for again, and the laptop it left is looked after', async () => {
    const stuck = heldMove(hold(person('a'), 'DOCKER_CONTINUATION_CONTAINER_STOPPED'), 'x');
    stuck.provider = 'absent';
    const w = world([stuck]);
    const at = record(w, (action) => {
      if (action === 'abandon-move') stuck.move = undefined;
    });
    await w.run(40);
    expect(at.filter(([, action]) => action === 'abandon-move')).toHaveLength(1);
    // With the move closed the stopped laptop is what remains, and the ordinary rebuild takes it.
    expect(at.map(([, action]) => action)).toContain('rebuild-laptop');
    expect(w.state.reads).toContain('laptop:a');
  });

  it('starts a move the service refused to close again six hours after its last attempt, and closes it once', async () => {
    const stuck = heldMove(person('a'), 'The original Docker journal changed');
    const w = world([stuck]);
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      const minute = (w.state.now - 10 * MINUTE) / MINUTE;
      at.push([minute, action]);
      // The service refuses everything in the first round and accepts the abandon in the second.
      if (action !== 'abandon-move' || minute < 360) return { outcome: 'refused', detail: 'refused' };
      stuck.move = undefined;
      return { outcome: 'done', detail: 'abandoned' };
    };
    expect(await quiet(w, 60)).toEqual([]);
    expect(at).toEqual([
      [1.5, 'continue-move'],
      [3.5, 'continue-move'],
      [8.5, 'continue-move'],
      [15.5, 'abandon-move'],
      [20.5, 'abandon-move'],
    ]);
    expect(w.report('a')).toMatchObject({
      condition: 'move-held-dead-end',
      waitingUntil: 10 * MINUTE + 20.5 * MINUTE + 6 * 60 * MINUTE,
    });
    expect(w.report('a').waitingFor).toMatch(/the next round of repair steps/);
    expect(await quiet(w, 6 * 60)).toEqual([]);
    expect(at.slice(5)).toEqual([
      [380.5, 'continue-move'],
      [382.5, 'continue-move'],
      [387.5, 'continue-move'],
      [390.5, 'abandon-move'],
    ]);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });
  });

  it('continues a held move once after an office restart before it abandons it, and only once', async () => {
    const stuck = heldMove(person('a'), 'The target application viewer is unavailable');
    // What the earlier office process saved: the move first held an hour ago, its three continues used up.
    const saved: SupervisorHistory = {
      fingerprint: 'move:move-a:The target application viewer is unavailable',
      since: 70 * MINUTE,
      attempts: { 'continue-move': { count: 3, lastAt: 78 * MINUTE } },
      rebuilds: [],
    };
    const w = world([stuck], { histories: new Map([['a', saved]]) });
    w.state.now = 130 * MINUTE;
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      at.push([(w.state.now - 130 * MINUTE) / MINUTE, action]);
      return { outcome: 'refused' };
    };
    expect(await quiet(w, 14)).toEqual([]);
    // The new process continues the move itself at its first look. The hour the old office had the move for does
    // not count: nothing is closed before this process has watched the move for fifteen minutes.
    expect(at).toEqual([[0.5, 'continue-move']]);
    expect(w.state.stored.get('a')!.attempts['continue-move']).toEqual({ count: 3, lastAt: 130.5 * MINUTE, resumed: true });
    expect(w.report('a')).toMatchObject({ waitingUntil: 145.5 * MINUTE });
    await w.run(2);
    expect(at).toEqual([
      [0.5, 'continue-move'],
      [15.5, 'abandon-move'],
    ]);
  });

  it('closes nothing after a second office restart in a round, and continues nothing either', async () => {
    const stuck = heldMove(person('a'), 'The target application viewer is unavailable');
    // Saved by an office process that had already been given its one continue back and has ended since.
    const saved: SupervisorHistory = {
      fingerprint: 'move:move-a:The target application viewer is unavailable',
      since: 70 * MINUTE,
      attempts: { 'continue-move': { count: 3, lastAt: 130 * MINUTE, resumed: true } },
      rebuilds: [],
    };
    const w = world([stuck], { histories: new Map([['a', saved]]) });
    w.state.now = 140 * MINUTE;
    expect(await quiet(w, 60)).toEqual([]);
    expect(w.state.acts).toEqual([]);
    // It says what it waits for: the next round, six hours after the last attempt, continues the move first.
    expect(w.report('a')).toMatchObject({ condition: 'move-held-dead-end', waitingUntil: 130 * MINUTE + 6 * 60 * MINUTE });
    expect(w.report('a').waitingFor).toMatch(/the next round of repair steps, which continues the move once more/);
  });

  it('does not abandon at its first pass a move the old office kept for the owner', async () => {
    // The move stopped at a sign-in screen two hours ago. The old office waited for the owner and continued nothing.
    const stuck = heldMove(person('a'), SIGN_IN);
    const saved: SupervisorHistory = { fingerprint: 'move:move-a:' + SIGN_IN, since: 10 * MINUTE, attempts: {}, rebuilds: [] };
    const w = world([stuck], { histories: new Map([['a', saved]]) });
    w.state.now = 130 * MINUTE;
    const at: Array<[number, string]> = [];
    w.state.respond = async (action) => {
      at.push([(w.state.now - 130 * MINUTE) / MINUTE, action]);
      if (action === 'abandon-move') stuck.move = undefined;
      return { outcome: action === 'abandon-move' ? 'done' : 'refused' };
    };
    expect(await quiet(w, 20)).toEqual([]);
    // Its own three continues first, then the fifteen minutes it has itself watched the move.
    expect(at).toEqual([
      [0.5, 'continue-move'],
      [2.5, 'continue-move'],
      [7.5, 'continue-move'],
      [15.5, 'abandon-move'],
    ]);
  });

  it('keeps the mark of a continue that was given back in its saved history', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'supervisor-resumed-')), 'employee-supervisor.json');
    const history: SupervisorHistory = {
      fingerprint: 'move:move-a:x',
      since: 1000,
      attempts: { 'continue-move': { count: 3, lastAt: 2000, resumed: true }, 'abandon-move': { count: 1, lastAt: 3000 } },
      rebuilds: [],
    };
    await new EmployeeSupervisorStore(file).save(new Map([['a', history]]));
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map([['a', history]]));
    rmSync(join(file, '..'), { recursive: true, force: true });
  });

  it('repairs a laptop that is down although a held move of the retired runtime is on record', async () => {
    const down = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    down.provider = 'absent';
    down.move = { id: 'native', docker: false, phase: 'recovery-required', busy: false, error: 'x', allowedActions: ['settle'] };
    const w = world([down]);
    await w.run(5);
    // The laptop is read and rebuilt on its own times. Nothing waits for the record's fifteen minutes.
    expect(w.state.reads).toContain('laptop:a');
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
    expect(w.report('a').code).toBe('DOCKER_RESOURCE_HELPER_FAILED');
  });

  it('acts on nothing while a step of the move is running', async () => {
    const stuck = heldMove(person('a'), 'x');
    stuck.move = { ...stuck.move!, busy: true };
    const w = world([stuck]);
    await w.run(60);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'move-in-progress' });
    expect(w.report('a').needsHuman).toBeUndefined();
  });
});

describe('EmployeeSupervisor: no path ends for good', () => {
  const needed = (w: ReturnType<typeof world>) => w.state.logs.filter((line) => line.includes('needs a person'));

  it('gives an employee with no approved limits the owner’s standing default, then starts the laptop', async () => {
    const bare = person('a');
    bare.glance = {
      ...bare.glance,
      session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown' },
      laptop: {
        record: null,
        bound: false,
        policyApproved: false,
        templateOnRecord: false,
        poolAlive: true,
        standing: { enabled: true, limits: true, layout: true },
      },
    };
    const w = world([bare]);
    w.state.respond = async (action) => {
      if (action === 'apply-standing-limits')
        bare.glance = { ...bare.glance, laptop: { ...bare.glance.laptop, policyApproved: true } };
      if (action === 'start-continuation') bare.glance = person('a').glance;
      return { outcome: 'done', detail: action === 'apply-standing-limits' ? 'standing limits 0123456789ab' : 'ready' };
    };
    await w.run(1);
    // Nothing is read from the Engine for an employee who has no limits yet.
    expect(w.state.reads.filter((read) => read.startsWith('source') || read.startsWith('laptop'))).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'laptop-not-started', next: { action: 'apply-standing-limits' } });
    await w.run(4);
    expect(w.state.acts).toEqual(['apply-standing-limits:a', 'start-continuation:a']);
    expect(w.report('a')).toMatchObject({ condition: 'healthy' });
    expect(needed(w)).toEqual([]);
    expect(w.state.audits.map((entry) => [entry.admin, entry.action, entry.detail.outcome])).toEqual([
      ['office supervisor', 'supervisor_apply_standing_limits', 'done'],
      ['office supervisor', 'supervisor_start_continuation', 'done'],
    ]);
  });

  it('leaves the limits alone and names the switch when the owner switched the standing defaults off', async () => {
    const bare = person('a');
    bare.glance = {
      ...bare.glance,
      laptop: {
        record: null,
        bound: false,
        policyApproved: false,
        templateOnRecord: false,
        standing: { enabled: false, limits: true, layout: true },
      },
    };
    const w = world([bare]);
    await w.run(30);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a').needsHuman).toMatch(/^The standing defaults are switched off \(company setting supervisorStandingDefaults\)\./);
  });

  it('starts its steps again six hours after a round that did not help, and still rebuilds only twice a day', async () => {
    const failing = hold(person('a'), 'DOCKER_RESOURCE_HELPER_FAILED');
    const w = world([failing]);
    const at: number[] = [];
    // Every rebuild is carried out, and the laptop is held again afterwards.
    w.state.respond = async () => {
      at.push((w.state.now - 10 * MINUTE) / MINUTE);
      return { outcome: 'done', detail: 'rebuilt' };
    };
    await w.run(60);
    expect(at).toEqual([3.5, 18.5]);
    expect(w.report('a')).toMatchObject({
      condition: 'held-needs-rebuild',
      waitingFor: expect.stringMatching(/^the next round of repair steps, which starts at/),
      waitingUntil: 10 * MINUTE + 18.5 * MINUTE + 6 * 60 * MINUTE,
    });
    expect(w.report('a').needsHuman).toBeUndefined();
    // The new round finds the day's two rebuilds used: it waits for the limit, and says until when.
    await w.run(6 * 60);
    expect(at).toHaveLength(2);
    expect(w.report('a')).toMatchObject({
      waitingFor: expect.stringMatching(/^the daily limit on rebuilds of one laptop \(2\)/),
      waitingUntil: 10 * MINUTE + 3.5 * MINUTE + 24 * 60 * MINUTE,
    });
    expect(w.state.stored.get('a')!.attempts).toEqual({});
    // The next day it goes on by itself.
    await w.run(18 * 60);
    expect(at.length).toBeGreaterThanOrEqual(3);
    expect(at[2]).toBeGreaterThanOrEqual(24 * 60 + 3.5);
    expect(needed(w)).toEqual([]);
    // Never more than two in any twenty-four hours.
    for (const [index, time] of at.entries()) if (index >= 2) expect(time - at[index - 2]!).toBeGreaterThanOrEqual(24 * 60);
  });

  it('says on every employee what the office is doing while it is not ready, and checks nothing meanwhile', async () => {
    let waiting: string | undefined;
    const w = world([hold(person('a'), 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', ['observe', 'continue']), person('b')], {
      notReady: () => waiting,
    });
    await w.run(0.5);
    expect(w.report('a').next).toMatchObject({ action: 'resend-continuation' });
    w.state.ready = false;
    waiting = 'the office to restart itself at 1970-01-01 01:00 UTC and read its configuration again';
    const reads = w.state.reads.length;
    await w.run(5);
    expect(w.state.reads).toHaveLength(reads);
    expect(w.state.acts).toEqual([]);
    for (const id of ['a', 'b']) {
      expect(w.report(id).waitingFor).toBe(waiting);
      expect(w.report(id).next).toBeUndefined();
      expect(w.report(id).checkedAt).toBe(w.state.now);
    }
    // Ready again: the ladder goes on where it was.
    w.state.ready = true;
    waiting = undefined;
    await w.run(0.5);
    expect(w.state.acts).toEqual(['resend-continuation:a']);
  });

  it('remembers an attempt of the limits step across an office restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'supervisor-round-')), 'employee-supervisor.json');
    const history: SupervisorHistory = {
      fingerprint: 'no-policy',
      since: 1000,
      attempts: { 'apply-standing-limits': { count: 1, lastAt: 2000 } },
      rebuilds: [],
      lastAction: { action: 'apply-standing-limits', at: 2000, outcome: 'refused', detail: 'no standing default limits to give' },
    };
    await new EmployeeSupervisorStore(file).save(new Map([['a', history]]));
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map([['a', history]]));
  });
});

describe('EmployeeSupervisor: an office start does not carry over what an earlier office watched', () => {
  const HOUR = 60 * MINUTE;
  /** The office starts ten hours in; whatever is in the store was written before it went down. */
  const START = 10 * HOUR;
  const started = (target: Person, history: SupervisorHistory) => {
    const w = world([target], { histories: new Map([[target.employee.id, history]]) });
    w.state.now = START;
    return w;
  };

  it('gives an employee who is being attached again fifteen minutes, whatever the saved clock says', async () => {
    // Starting since the first hour, by the saved history. A read inside the laptop would find no agent yet.
    const starting = hold(person('a'), 'DOCKER_CONTINUATION_BUSY');
    const w = started(starting, {
      fingerprint: '',
      since: 0,
      transitSince: HOUR,
      transitOf: 'starting',
      attempts: {},
      rebuilds: [],
    });
    await w.run(14.5);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'starting' });
    expect(w.state.reads.filter((read) => read === 'provider:a')).toEqual([]);
    // Fifteen minutes after it was first seen starting by this office, and three more for the rebuild.
    await w.run(3);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({ condition: 'held-needs-rebuild', next: { action: 'rebuild-laptop' } });
    await w.run(1);
    expect(w.state.acts).toEqual(['rebuild-laptop:a']);
  });

  it('gives a laptop whose pane cannot be read its two hours again, and still acts on a read made now', async () => {
    const saved: SupervisorHistory = {
      fingerprint: 'code:DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED',
      since: HOUR,
      watchSince: HOUR,
      attempts: { 'reconnect-viewer': { count: 1, lastAt: 9 * HOUR } },
      rebuilds: [],
      lastAction: { action: 'reconnect-viewer', at: 9 * HOUR, outcome: 'refused', detail: 'start-unconfirmed' },
    };
    // Held for nine hours by the saved history; the office has no terminal object for it after its start.
    const w = started(heldTerminal(person('a'), 'unknown'), saved);
    await w.run(110);
    expect(w.state.acts).toEqual([]);
    expect(w.report('a')).toMatchObject({
      since: HOUR,
      waitingFor: expect.stringMatching(/^a reading of the agent's terminal; if there is still none, the laptop is rebuilt at/),
      waitingUntil: START + 30_000 + 2 * HOUR,
    });
    // It was asked what runs in the laptop, so the wait is not blind to an empty one.
    expect(w.state.reads.filter((read) => read === 'provider:a').length).toBeGreaterThan(0);
    await w.run(11);
    expect(w.state.proved).toEqual([['rebuild-laptop', ['terminal-input-held', 'agent-unreadable']]]);

    const empty = heldTerminal(person('a'), 'unknown');
    empty.provider = 'exited';
    const now = started(empty, saved);
    await now.run(1);
    expect(now.state.proved).toEqual([['rebuild-laptop', []]]);
  });

  it('writes its clocks to the store and reads them back as a file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'supervisor-clocks-')), 'employee-supervisor.json');
    const history: SupervisorHistory = {
      fingerprint: 'code:X',
      since: 1000,
      transitSince: 3000,
      transitOf: 'starting',
      watchSince: 2000,
      attempts: {},
      rebuilds: [],
    };
    await new EmployeeSupervisorStore(file).save(new Map([['a', history]]));
    expect(new EmployeeSupervisorStore(file).load()).toEqual(new Map([['a', history]]));
  });
});
