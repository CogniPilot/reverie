import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EmployeeSupervisor,
  type EmployeeSupervisorPorts,
  type SupervisedEmployee,
  type SupervisorActionResult,
} from '../src/employee-supervisor.js';
import { officeSupervisorPorts, type OfficeSupervisorDeps } from '../src/employee-supervisor-office.js';
import {
  EMPTY_SUPERVISOR_HISTORY,
  SUPERVISOR_PATHS,
  SUPERVISOR_POLICY,
  assessEmployee,
  classifyEmployee,
  recordSupervisorAttempt,
  type SupervisorFlags,
  type SupervisorHistory,
  type SupervisorObservation,
} from '../src/employee-supervisor-policy.js';
import { EmployeeSupervisorStore } from '../src/employee-supervisor-store.js';
import type { PlanSignInReport } from '../src/plan-signin-reconciler.js';

const MINUTE = 60_000;
const screen = { label: "Claude's sign-in screen", kind: 'credential' as const, answering: false };
/** Burt as he was at 10:47 on 2026-11-24: a ready laptop whose agent shows the provider's sign-in screen. */
function atSignIn(patch: Partial<SupervisorObservation> = {}): SupervisorObservation {
  return {
    employeeId: 'burt',
    name: 'Burt',
    desiredRunning: true,
    onVacation: false,
    bindingMigration: false,
    boxed: true,
    planLabel: 'Claude CogniPilot',
    session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', startupScreen: screen },
    laptop: {
      record: { phase: 'ready', version: 2, operationId: 'op-1' },
      bound: true,
      policyApproved: true,
      restoration: { state: 'attached' },
      templateOnRecord: true,
    },
    ...patch,
  };
}
const flags = (patch: Partial<SupervisorFlags> = {}): SupervisorFlags => ({
  enabled: true,
  autoRepair: false,
  relaunchAvailable: false,
  signInRepairAvailable: true,
  ...patch,
});
const seenAt = (since: number): SupervisorHistory => ({
  ...EMPTY_SUPERVISOR_HISTORY,
  fingerprint: classifyEmployee(atSignIn()).fingerprint,
  since,
});

describe('a laptop at the sign-in screen of a plan the system still holds', () => {
  it('has its sign-in put back at once, with automatic repairs switched off, and asks nobody', () => {
    const result = assessEmployee(atSignIn(), seenAt(1000), flags(), 1000);
    expect(result).toMatchObject({ condition: 'needs-sign-in', code: 'sign-in-screen' });
    expect(result.next).toEqual({ action: 'replace-sign-in', at: 1000, preconditions: [] });
    expect(result.needsHuman).toBeUndefined();
    // It discards nothing, which is the only reason it may run without the owner's repair switch.
    expect(SUPERVISOR_POLICY.ladder['replace-sign-in'].tier).toBe('retry');
    expect(SUPERVISOR_PATHS['needs-sign-in']).toEqual(['replace-sign-in']);
  });

  it('never leads to a rebuild by itself, whatever the repair switch says', () => {
    for (const autoRepair of [true, false]) {
      let history = seenAt(0);
      for (let attempt = 0; attempt < 8; attempt++) {
        const now = (attempt + 1) * 20 * MINUTE;
        const step = assessEmployee(atSignIn(), history, flags({ autoRepair }), now);
        expect([null, 'replace-sign-in']).toContain(step.next.action);
        if (step.next.action) history = recordSupervisorAttempt(history, step.next.action, now, 'done', 'sign-in placed');
      }
      expect(history.attempts['replace-sign-in']!.count).toBe(SUPERVISOR_POLICY.ladder['replace-sign-in'].maxAttempts);
      expect(Object.keys(history.attempts)).toEqual(['replace-sign-in']);
    }
  });

  it('is left exactly as before while the supervisor is off, the office cannot place sign-ins, or a move owns it', () => {
    const before = (observed: SupervisorObservation, given: SupervisorFlags) => {
      const result = assessEmployee(observed, seenAt(0), given, 10 * MINUTE);
      expect(result.next.action).toBeNull();
      expect(result.needsHuman).toMatch(/Sign in the plan “Claude CogniPilot” at the office \(Plans\)/);
    };
    before(atSignIn(), flags({ enabled: false }));
    before(atSignIn(), flags({ signInRepairAvailable: false }));
    before(atSignIn(), { enabled: true, autoRepair: true, relaunchAvailable: true });
    before(atSignIn({ boxed: false }), flags());
    const moving = atSignIn({
      move: { id: 'm1', docker: true, phase: 'recovery-required', busy: false, allowedActions: ['continue-original'] },
    });
    expect(assessEmployee(moving, seenAt(0), flags(), 10 * MINUTE).next.action).not.toBe('replace-sign-in');
  });

  it('waits beside another operation without asking anybody', () => {
    const result = assessEmployee(atSignIn({ busy: 'laptop-operation' }), seenAt(0), flags(), MINUTE);
    expect(result.next).toMatchObject({ action: null, waitingFor: 'another laptop operation that is running' });
    expect(result.needsHuman).toBeUndefined();
  });

  it('asks for a sign-in as soon as an attempt found none to place, and keeps trying', () => {
    const refused = recordSupervisorAttempt(seenAt(0), 'replace-sign-in', 0, 'refused', 'no usable sign-in');
    const result = assessEmployee(atSignIn({ planSignedIn: false }), refused, flags(), 30_000);
    expect(result.next).toMatchObject({ action: 'replace-sign-in', at: MINUTE });
    expect(result.needsHuman).toMatch(/Sign in the plan “Claude CogniPilot” at the office \(Plans\)/);
    // Once the owner has signed the plan in, the next attempt places it and the request is withdrawn.
    const placed = recordSupervisorAttempt(refused, 'replace-sign-in', MINUTE, 'done', 'sign-in placed');
    expect(assessEmployee(atSignIn(), placed, flags(), 2 * MINUTE).needsHuman).toBeUndefined();
  });

  it('names the exact rebuild calls once the sign-in is in place and the agent is still at the screen', () => {
    let history = seenAt(0);
    for (const at of [0, MINUTE, 6 * MINUTE])
      history = recordSupervisorAttempt(history, 'replace-sign-in', at, 'done', 'sign-in already in place');
    const settling = assessEmployee(atSignIn(), history, flags(), 7 * MINUTE);
    expect(settling.next).toMatchObject({ action: null, at: 9 * MINUTE });
    expect(settling.needsHuman).toBeUndefined();
    const spent = assessEmployee(atSignIn(), history, flags(), 9 * MINUTE);
    expect(spent.next.action).toBeNull();
    expect(spent.needsHuman).toMatch(/put the plan's sign-in back into this laptop/);
    expect(spent.needsHuman).toMatch(/POST \/api\/company\/employees\/:id\/docker-rebuild\/preview/);
    expect(spent.needsHuman).toMatch(/docker-rebuild\/apply/);
    expect(spent.needsHuman).toMatch(/confirmDiscardRunning/);
  });

  it('asks for a sign-in, not a rebuild, when every attempt found none', () => {
    let history = seenAt(0);
    for (const at of [0, MINUTE, 6 * MINUTE])
      history = recordSupervisorAttempt(history, 'replace-sign-in', at, 'refused', 'no usable sign-in');
    const spent = assessEmployee(atSignIn({ planSignedIn: false }), history, flags(), 20 * MINUTE);
    expect(spent.next.action).toBeNull();
    expect(spent.needsHuman).toMatch(/Sign in the plan “Claude CogniPilot” at the office \(Plans\)/);
    expect(spent.needsHuman).not.toMatch(/docker-rebuild/);
  });

  it('is remembered across an office restart, so a restart does not spend the attempts again', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'reverie-supervisor-signin-'));
    try {
      const history = recordSupervisorAttempt(seenAt(5), 'replace-sign-in', 10, 'done', 'sign-in placed');
      const file = join(dir, 'employee-supervisor.json');
      await new EmployeeSupervisorStore(file).save(new Map([['burt', history]]));
      expect(new EmployeeSupervisorStore(file).load().get('burt')).toEqual(history);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the office's step for it", () => {
  const employee: SupervisedEmployee = {
    id: '994f57d6',
    name: 'Burt',
    owner: undefined,
    sessionId: 's1',
    sessionGeneration: 1,
    desiredRunning: true,
    onVacation: false,
    bindingMigration: false,
    planAccountId: 'anthropic-898367f5',
    planLabel: 'Claude CogniPilot',
  };
  const report = (patch: Partial<PlanSignInReport>): PlanSignInReport => ({
    accountId: 'anthropic-898367f5',
    checkedAt: 1,
    usable: true,
    holders: [],
    transfers: [],
    ...patch,
  });
  function step(answer: PlanSignInReport | undefined, calls: string[] = []) {
    const deps = {
      company: { registeredEmployees: () => [], view: () => ({ settings: {} }), store: {} },
      session: () => undefined,
      ready: () => true,
      restorations: () => [],
      ownerStopPending: () => false,
      moves: {},
      planSignedIn: async () => true,
      signIn: {
        reconcile: async (accountId: string) => {
          calls.push(accountId);
          return answer;
        },
      },
    } as unknown as OfficeSupervisorDeps;
    return officeSupervisorPorts(deps).actions['replace-sign-in']!;
  }

  it('asks for exactly that plan and reports what the laptop holds afterwards', async () => {
    const calls: string[] = [];
    const placed = report({
      holders: [
        { id: 'office', state: 'usable' },
        { id: 'laptop:994f57d6', state: 'usable' },
      ],
      transfers: [{ from: 'office', to: 'laptop:994f57d6', reason: 'stranded', outcome: 'written' }],
    });
    expect(await step(placed, calls)(employee, () => {}, undefined)).toEqual({ outcome: 'done', detail: 'sign-in placed' });
    expect(calls).toEqual(['anthropic-898367f5']);
    expect(await step(report({ holders: placed.holders }))(employee, () => {}, undefined)).toEqual({
      outcome: 'done',
      detail: 'sign-in already in place',
    });
  });

  it('refuses when nothing usable is held, when it could not be placed, and when the laptop holds no copy', async () => {
    const blank = [{ id: 'laptop:994f57d6', state: 'blank' as const }];
    expect(await step(report({ usable: false, holders: blank }))(employee, () => {}, undefined)).toEqual({
      outcome: 'refused',
      detail: 'no usable sign-in of this plan is held anywhere',
    });
    expect(await step(report({ holders: blank }))(employee, () => {}, undefined)).toEqual({
      outcome: 'refused',
      detail: 'the sign-in could not be placed yet',
    });
    for (const answer of [undefined, report({ holders: [{ id: 'laptop:other', state: 'usable' }] })])
      expect(await step(answer)(employee, () => {}, undefined)).toEqual({
        outcome: 'refused',
        detail: 'the laptop has no sign-in folder of this plan to read',
      });
  });

  it('does nothing once the supervisor may no longer act, or for an employee on no plan', async () => {
    const calls: string[] = [];
    const stopped = () => {
      throw Error('stopped');
    };
    await expect(step(report({}), calls)(employee, stopped, undefined)).rejects.toThrow('stopped');
    expect(await step(report({}), calls)({ ...employee, planAccountId: undefined }, () => {}, undefined)).toEqual({
      outcome: 'refused',
      detail: 'the employee is on no plan',
    });
    expect(calls).toEqual([]);
  });

  it('is absent where the office cannot place sign-ins', () => {
    const deps = {
      company: { registeredEmployees: () => [], view: () => ({ settings: {} }), store: {} },
      moves: {},
    } as unknown as OfficeSupervisorDeps;
    expect(officeSupervisorPorts(deps).actions['replace-sign-in']).toBeUndefined();
  });
});

describe('the supervisor driving it', () => {
  it('places the sign-in on the first pass that sees the screen, with repairs off, and stops asking once healthy', async () => {
    const employee: SupervisedEmployee = {
      id: 'burt',
      name: 'Burt',
      owner: undefined,
      sessionId: 's1',
      sessionGeneration: 1,
      desiredRunning: true,
      onVacation: false,
      bindingMigration: false,
      planAccountId: 'anthropic-898367f5',
      planLabel: 'Claude CogniPilot',
    };
    const state = { now: 10 * MINUTE, screen: true, placed: 0, lines: [] as string[], rebuilds: 0 };
    const ports: EmployeeSupervisorPorts = {
      now: () => state.now,
      ready: () => true,
      employees: () => [employee],
      flags: () => ({ enabled: true, autoRepair: false }),
      glance: () => {
        const { session, ...rest } = atSignIn();
        return { ...rest, session: state.screen ? session : { ...session, startupScreen: undefined } };
      },
      openMove: async () => undefined,
      planSignedIn: async () => true,
      readLaptop: async () => undefined,
      readSource: async () => 'unknown',
      readProvider: async () => 'running',
      actions: {
        'replace-sign-in': async (): Promise<SupervisorActionResult> => {
          state.placed++;
          state.screen = false;
          return { outcome: 'done', detail: 'sign-in placed' };
        },
        'rebuild-laptop': async (): Promise<SupervisorActionResult> => {
          state.rebuilds++;
          return { outcome: 'done' };
        },
      },
      load: () => new Map(),
      save: async () => {},
      audit: () => {},
      log: (line) => state.lines.push(line),
    };
    const supervisor = new EmployeeSupervisor(ports, SUPERVISOR_POLICY, {
      actionsPerTick: 2,
      startupGraceMs: 0,
      actionWaitMs: 1000,
      idleReadMs: 2 * MINUTE,
      limitsCheckMs: 10 * MINUTE,
    });
    await supervisor.tick();
    expect(state.placed).toBe(1);
    expect(state.lines).toEqual([
      'supervisor] Burt (burt): replace-sign-in -> done sign-in placed (needs-sign-in, sign-in-screen; attempt 1)',
    ].map((line) => '[' + line));
    state.now += 30_000;
    await supervisor.tick();
    expect(supervisor.reports(undefined)).toMatchObject([{ condition: 'healthy', sentence: 'Burt is running.' }]);
    expect([state.placed, state.rebuilds]).toEqual([1, 0]);
    // Nobody was ever asked for anything.
    expect(state.lines.filter((line) => line.includes('needs a person'))).toEqual([]);
  });
});
