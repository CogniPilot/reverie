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
  SIGN_IN_NO_FOLDER,
  SIGN_IN_NOWHERE,
  SUPERVISOR_PATHS,
  SUPERVISOR_POLICY,
  assessEmployee,
  classifyEmployee,
  ladderRestartAt,
  moveOwnsLaptop,
  officeReading,
  recordSupervisorAttempt,
  rollSupervisorHistory,
  type SupervisorFlags,
  type SupervisorHistory,
  type SupervisorObservation,
} from '../src/employee-supervisor-policy.js';
import { EmployeeSupervisorStore } from '../src/employee-supervisor-store.js';
import type { PlanSignInReport } from '../src/plan-signin-reconciler.js';

const MINUTE = 60_000;
const screen = { label: "Claude's sign-in screen", kind: 'credential' as const, answering: false };
/** The same screen as the office's terminal reports it when its live widget is on the frame and the pane is silent. */
const parkedSession: SupervisorObservation['session'] = {
  available: true,
  runtimeHealth: 'healthy',
  viewerHealth: 'connected',
  startupScreen: { ...screen, proof: 'widget' },
  turn: 'idle',
  idleSince: 0,
};
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
    session: parkedSession,
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
    expect(SUPERVISOR_PATHS['needs-sign-in']).toEqual(['replace-sign-in', 'relaunch-provider', 'rebuild-laptop']);
  });

  it('waits beside another operation without asking anybody', () => {
    const result = assessEmployee(atSignIn({ busy: 'laptop-operation' }), seenAt(0), flags(), MINUTE);
    expect(result.next).toMatchObject({ action: null, waitingFor: 'another laptop operation that is running' });
    expect(result.needsHuman).toBeUndefined();
  });

  it('is left to the move while a plan move owns the employee', () => {
    const moving = atSignIn({
      move: { id: 'm1', docker: true, phase: 'recovery-required', busy: false, allowedActions: ['continue-original'] },
    });
    expect(['continue-move', null]).toContain(assessEmployee(moving, seenAt(0), flags({ autoRepair: true }), 60 * MINUTE).next.action);
    // A move in a phase the supervisor does not act on still owns the laptop: none of the screen's steps is taken.
    const other = atSignIn({ move: { id: 'm1', docker: true, phase: 'approval', busy: false, allowedActions: [] } });
    for (const now of [MINUTE, 10 * MINUTE, 60 * MINUTE])
      expect(assessEmployee(other, seenAt(0), flags({ autoRepair: true, relaunchAvailable: true }), now).next.action).toBeNull();
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

describe('the sign-in is in place and the agent still shows the sign-in screen', () => {
  const REPAIR = flags({ autoRepair: true });
  const placed = (detail = 'sign-in placed') => recordSupervisorAttempt(seenAt(0), 'replace-sign-in', 0, 'done', detail);

  it('does not place it again: the agent is started again by a rebuild, three minutes after the screen was first seen', () => {
    for (const detail of ['sign-in placed', 'sign-in already in place']) {
      // One minute in, the pane has not been silent for two yet.
      const early = assessEmployee(atSignIn(), placed(detail), REPAIR, MINUTE);
      expect(early.next).toMatchObject({ action: null, waitingFor: "the agent's terminal to stay quiet a little longer" });
      const waiting = assessEmployee(atSignIn(), placed(detail), REPAIR, 2 * MINUTE);
      expect(waiting.next).toEqual({ action: 'rebuild-laptop', at: 3 * MINUTE, preconditions: ['agent-parked-at-screen'] });
      expect(waiting.needsHuman).toBeUndefined();
    }
  });

  it('relaunches the agent inside its laptop first where the office can, on the same proof', () => {
    const step = assessEmployee(atSignIn(), placed(), flags({ autoRepair: true, relaunchAvailable: true }), 2 * MINUTE);
    expect(step.next).toEqual({ action: 'relaunch-provider', at: 30_000, preconditions: ['agent-parked-at-screen'] });
    // Two relaunches that did not clear the screen are followed by the rebuild.
    let history = placed();
    for (const at of [MINUTE, 3 * MINUTE]) history = recordSupervisorAttempt(history, 'relaunch-provider', at, 'done');
    const next = assessEmployee(atSignIn({ session: { ...parkedSession, idleSince: 4 * MINUTE } }), history, flags({ autoRepair: true, relaunchAvailable: true }), 10 * MINUTE);
    expect(next.next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['agent-parked-at-screen'] });
    // A plan replacement record is never relaunched.
    const replaced = atSignIn({ laptop: { ...atSignIn().laptop, record: { phase: 'ready', version: 3, operationId: 'op-1' } } });
    expect(assessEmployee(replaced, placed(), flags({ autoRepair: true, relaunchAvailable: true }), 2 * MINUTE).next.action).toBe('rebuild-laptop');
  });

  it('does not look again when the last read of the copies already found a usable sign-in in the laptop', () => {
    const held = atSignIn({ laptopSignedIn: true });
    expect(assessEmployee(held, seenAt(0), REPAIR, 2 * MINUTE).next).toEqual({
      action: 'rebuild-laptop',
      at: 3 * MINUTE,
      preconditions: ['agent-parked-at-screen'],
    });
    // A read that found none there changes nothing: the office looks, and places one if any holder has it.
    expect(assessEmployee(atSignIn({ laptopSignedIn: false }), seenAt(0), REPAIR, 0).next.action).toBe('replace-sign-in');
  });

  it('goes straight on when the laptop has no sign-in folder of the plan: only a new laptop gets one', () => {
    const none = recordSupervisorAttempt(seenAt(0), 'replace-sign-in', 0, 'refused', SIGN_IN_NO_FOLDER);
    expect(assessEmployee(atSignIn({ planSignedIn: true }), none, REPAIR, 2 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      at: 3 * MINUTE,
    });
  });

  it('tries the placement again while it only could not be done yet, and then goes on', () => {
    let history = seenAt(0);
    const order: Array<string | null> = [];
    for (let now = 0; now <= 12 * MINUTE; now += 30_000) {
      const step = assessEmployee(atSignIn({ planSignedIn: true }), history, REPAIR, now);
      if (!step.next.action || (step.next.at ?? 0) > now) continue;
      order.push(step.next.action);
      history = recordSupervisorAttempt(history, step.next.action, now, 'refused', 'the sign-in could not be placed yet');
    }
    expect(order).toEqual(['replace-sign-in', 'replace-sign-in', 'replace-sign-in', 'rebuild-laptop']);
  });

  it('never starts an agent again in the middle of anything: the pane must be idle and silent for two minutes', () => {
    const at = (session: Partial<SupervisorObservation['session']>, now = 10 * MINUTE) =>
      assessEmployee(atSignIn({ session: { ...parkedSession, ...session } }), placed(), REPAIR, now);
    // The waits are those of every laptop an agent may run in: one rule for "between turns", not a second one.
    expect(at({ turn: 'working', idleSince: undefined }).next).toMatchObject({ action: null, waitingFor: "the agent's current turn to end" });
    // A pane that shows no turn at all: a read inside the laptop is asked first, and with an agent found there the
    // office waits the two hours of an unread pane. The screen stays what the step has to prove.
    for (const turn of ['unknown', undefined] as const) {
      expect(at({ turn, idleSince: undefined }).next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['no-agent-running'] });
      const occupied = atSignIn({ session: { ...parkedSession, turn, idleSince: undefined }, laptop: { ...atSignIn().laptop, provider: 'running' } });
      const since = recordSupervisorAttempt(seenAt(MINUTE), 'replace-sign-in', MINUTE, 'done', 'sign-in placed');
      expect(assessEmployee(occupied, since, REPAIR, 10 * MINUTE).next).toMatchObject({ action: null, at: MINUTE + SUPERVISOR_POLICY.blindRebuildMs });
      expect(assessEmployee(occupied, since, REPAIR, MINUTE + SUPERVISOR_POLICY.blindRebuildMs).next).toMatchObject({
        action: 'rebuild-laptop',
        preconditions: ['agent-parked-at-screen', 'agent-unreadable'],
      });
    }
    expect(at({ idleSince: 9 * MINUTE }).next).toMatchObject({ action: null, waitingFor: "the agent's terminal to stay quiet a little longer" });
    expect(at({ idleSince: 8 * MINUTE }).next.action).toBe('rebuild-laptop');
    // Work the pane says was left running is given thirty minutes from when the office first saw it.
    const since = {
      ...recordSupervisorAttempt(seenAt(MINUTE), 'replace-sign-in', MINUTE, 'done', 'sign-in placed'),
      backgroundSince: MINUTE,
    };
    const left = (now: number) => assessEmployee(atSignIn({ session: { ...parkedSession, background: true } }), since, REPAIR, now);
    expect(left(10 * MINUTE).next).toMatchObject({ action: null, waitingFor: 'the work the agent left running to finish' });
    expect(left(30 * MINUTE).next.action).toBeNull();
    expect(left(31 * MINUTE).next.action).toBe('rebuild-laptop');
    // None of these waits asks a person for anything.
    for (const session of [{ turn: 'working' as const }, { turn: 'unknown' as const }, { background: true }])
      expect(at(session, 120 * MINUTE).needsHuman).toBeUndefined();
  });

  it('never starts an agent again for a screen the office knows only by its words', () => {
    // A conversation that quotes the sign-in screen reads the same. The sign-in is put back, which harms nothing.
    const words = atSignIn({ session: { ...parkedSession, startupScreen: screen } });
    let history = seenAt(0);
    const taken = new Set<string>();
    for (let now = 0; now <= 30 * 60 * MINUTE; now += 5 * MINUTE) {
      history = rollSupervisorHistory(history, classifyEmployee(words), now);
      const step = assessEmployee(words, history, flags({ autoRepair: true, relaunchAvailable: true }), now);
      if (!step.next.action || (step.next.at ?? 0) > now) continue;
      taken.add(step.next.action);
      history = recordSupervisorAttempt(history, step.next.action, now, 'done', 'sign-in already in place');
    }
    expect([...taken]).toEqual(['replace-sign-in']);
  });

  it('names the switch, not a sign-in, while automatic repairs are off', () => {
    const off = assessEmployee(atSignIn(), placed(), flags({ autoRepair: false }), 10 * MINUTE);
    expect(off.next.action).toBeNull();
    expect(off.needsHuman).toMatch(/supervisorAutoRepair/);
  });

  it('keeps the limits every rebuild keeps', () => {
    const noLayout = atSignIn({ laptop: { ...atSignIn().laptop, templateOnRecord: false } });
    expect(assessEmployee(noLayout, placed(), REPAIR, 10 * MINUTE).next.action).toBeNull();
    // The limit per day is a pause that says when it lifts, as for every rebuild.
    const today = { ...placed(), rebuilds: [MINUTE, 2 * MINUTE] };
    const paused = assessEmployee(atSignIn(), today, REPAIR, 10 * MINUTE);
    expect(paused.next).toMatchObject({ action: null, at: MINUTE + 24 * 60 * MINUTE });
    expect(paused.next.waitingFor).toMatch(/the daily limit on rebuilds of one laptop/);
    expect(paused.needsHuman).toBeUndefined();
    // An employee with no layout of their own is rebuilt with the owner's standing default layout.
    const standing = atSignIn({ laptop: { ...noLayout.laptop, standing: { enabled: true, limits: true, layout: true } } });
    expect(assessEmployee(standing, placed(), REPAIR, 10 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['agent-parked-at-screen'],
    });
  });

  it('starts over six hours after the last step, by the rule of every ladder, and says when meanwhile', () => {
    let history = placed();
    for (const at of [3 * MINUTE, 20 * MINUTE]) history = recordSupervisorAttempt(history, 'rebuild-laptop', at, 'refused', 'DOCKER_REPROVISION_BUSY_ELSEWHERE');
    const spent = assessEmployee(atSignIn(), history, REPAIR, 60 * MINUTE);
    expect(spent.next).toMatchObject({ action: null, at: ladderRestartAt(history) });
    expect(spent.next.waitingFor).toMatch(/the next round of repair steps, which starts at /);
    expect(spent.needsHuman).toBeUndefined();
    // The counts are kept until the last step is six hours old.
    const seen = classifyEmployee(atSignIn());
    const early = rollSupervisorHistory(history, seen, 20 * MINUTE + SUPERVISOR_POLICY.ladderRestartMs - 1);
    expect(early.attempts).toEqual(history.attempts);
    const later = 20 * MINUTE + SUPERVISOR_POLICY.ladderRestartMs;
    const restarted = rollSupervisorHistory(history, seen, later);
    expect(restarted.attempts).toEqual({});
    expect(restarted.since).toBe(history.since);
    expect(assessEmployee(atSignIn({ session: { ...parkedSession, idleSince: later - 10 * MINUTE } }), restarted, REPAIR, later).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['agent-parked-at-screen'],
    });
    expect(SUPERVISOR_POLICY.ladderRestartMs).toBeGreaterThanOrEqual(60 * MINUTE);
  });
});

describe('a plan that is signed in nowhere', () => {
  const REPAIR = flags({ autoRepair: true });
  const NOWHERE = SIGN_IN_NOWHERE;

  it('is said as soon as one attempt found no sign-in to place, and the office keeps trying', () => {
    const first = assessEmployee(atSignIn({ planSignedIn: false }), seenAt(0), REPAIR, 0);
    expect(first).toMatchObject({ condition: 'needs-sign-in', code: 'plan-signed-out', next: { action: 'replace-sign-in' } });
    expect(first.needsHuman).toBeUndefined();
    const refused = recordSupervisorAttempt(seenAt(0), 'replace-sign-in', 0, 'refused', NOWHERE);
    const result = assessEmployee(atSignIn({ planSignedIn: false }), refused, REPAIR, 30_000);
    expect(result.next).toMatchObject({ action: 'replace-sign-in', at: MINUTE });
    expect(result.needsHuman).toMatch(/^The plan “Claude CogniPilot” is not signed in at the office/);
    expect(result.needsHuman).toMatch(/Only the account holder can sign a plan in \(Plans\)/);
    expect(result.needsHuman).toMatch(/The office never types a sign-in|the office never types a sign-in/);
  });

  it('is never rebuilt for: a new laptop would stop at the same screen', () => {
    let history = seenAt(0);
    const taken: string[] = [];
    for (let now = 0; now <= 5 * 60 * MINUTE; now += MINUTE) {
      const step = assessEmployee(atSignIn({ planSignedIn: false }), history, flags({ autoRepair: true, relaunchAvailable: true }), now);
      if (!step.next.action || (step.next.at ?? 0) > now) continue;
      taken.push(step.next.action);
      history = recordSupervisorAttempt(history, step.next.action, now, 'refused', NOWHERE);
    }
    expect(taken).toEqual(['replace-sign-in', 'replace-sign-in', 'replace-sign-in']);
    const stopped = assessEmployee(atSignIn({ planSignedIn: false }), history, REPAIR, 5 * 60 * MINUTE);
    expect(stopped.next.action).toBeNull();
    expect(stopped.needsHuman).toMatch(/Neither the office nor this laptop holds a sign-in of the plan “Claude CogniPilot” that works/);
    expect(stopped.needsHuman).toMatch(/starts the agent again by itself/);
    expect(stopped.needsHuman).not.toMatch(/docker-rebuild|terminal/);
  });

  it('is believed from the look at every copy, whatever the Plans page says of the office copy', () => {
    // The office's file looks signed in, and the provider has refused exactly that copy: no holder has a usable one.
    const refused = recordSupervisorAttempt(seenAt(0), 'replace-sign-in', 6 * MINUTE, 'refused', NOWHERE);
    const stale = { ...refused, attempts: { 'replace-sign-in': { count: 3, lastAt: 6 * MINUTE } } };
    const step = assessEmployee(atSignIn({ planSignedIn: true }), stale, REPAIR, 60 * MINUTE);
    expect(step.next.action).toBeNull();
    expect(step.needsHuman).toMatch(/Only the account holder can sign a plan in/);
  });

  it('is rebuilt by the office itself once the plan has been signed in', () => {
    let history = seenAt(0);
    for (const at of [0, MINUTE, 6 * MINUTE]) history = recordSupervisorAttempt(history, 'replace-sign-in', at, 'refused', NOWHERE);
    // The reconciler places the new sign-in by itself within a minute, and its read says the laptop holds it. The
    // supervisor does not wait for its own next look: the agent is started again at the next pass.
    const signedIn = atSignIn({ planSignedIn: true, laptopSignedIn: true, session: { ...parkedSession, idleSince: 50 * MINUTE } });
    const step = assessEmployee(signedIn, history, REPAIR, 60 * MINUTE);
    expect(step.next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['agent-parked-at-screen'] });
    expect(step.needsHuman).toBeUndefined();
  });

  it('is not what an office that is merely signed out itself has: a laptop that still holds a sign-in is started again', () => {
    const held = recordSupervisorAttempt(seenAt(0), 'replace-sign-in', 0, 'done', 'sign-in already in place');
    const step = assessEmployee(atSignIn({ planSignedIn: false }), held, REPAIR, 10 * MINUTE);
    expect(step.next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['agent-parked-at-screen'] });
    // Said as information: the office is not waiting for it.
    expect(step.needsHuman).toMatch(/While this laptop still holds a sign-in that works, the office starts the agent again with it/);
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
      expect(await step(answer)(employee, () => {}, undefined)).toEqual({ outcome: 'refused', detail: SIGN_IN_NO_FOLDER });
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

  it('says from the last read of the copies whether the laptop holds a usable sign-in, without reading anything', () => {
    const state = { now: 10 * MINUTE, answer: undefined as PlanSignInReport | undefined, asked: [] as string[] };
    const deps = {
      company: { registeredEmployees: () => [], view: () => ({ settings: {} }), store: {} },
      moves: {},
      now: () => state.now,
      signIn: {
        reconcile: async () => {
          throw new Error('a look is a step, never part of an observation');
        },
        report: (accountId: string) => {
          state.asked.push(accountId);
          return state.answer;
        },
      },
    } as unknown as OfficeSupervisorDeps;
    const held = officeSupervisorPorts(deps).laptopSignedIn!;
    expect(held(employee)).toBeUndefined();
    state.answer = report({ checkedAt: 9 * MINUTE, holders: [{ id: 'laptop:994f57d6', state: 'usable' }] });
    expect(held(employee)).toBe(true);
    expect(state.asked).toEqual(['anthropic-898367f5', 'anthropic-898367f5']);
    state.answer = report({ checkedAt: 9 * MINUTE, holders: [{ id: 'laptop:994f57d6', state: 'blank' }] });
    expect(held(employee)).toBe(false);
    // Another laptop's copy says nothing of this one, and neither does a read that is no longer recent.
    state.answer = report({ checkedAt: 9 * MINUTE, holders: [{ id: 'laptop:other', state: 'usable' }] });
    expect(held(employee)).toBeUndefined();
    state.answer = report({ checkedAt: 4 * MINUTE, holders: [{ id: 'laptop:994f57d6', state: 'usable' }] });
    expect(held(employee)).toBeUndefined();
    expect(held({ ...employee, planAccountId: undefined })).toBeUndefined();
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

describe('the supervisor starting a parked agent again', () => {
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
  function driven(options: { signedIn: boolean; laptopHolds: () => boolean | undefined }) {
    const state = { now: 10 * MINUTE, acts: [] as string[], lines: [] as string[], rebuilt: false };
    const act = (name: string, result: () => SupervisorActionResult) => async (): Promise<SupervisorActionResult> => {
      state.acts.push(name);
      return result();
    };
    const ports: EmployeeSupervisorPorts = {
      now: () => state.now,
      ready: () => true,
      employees: () => [employee],
      flags: () => ({ enabled: true, autoRepair: true }),
      glance: () => {
        const { session, ...rest } = atSignIn();
        // The pane has been silent since the office first looked at it.
        return state.rebuilt
          ? { ...rest, session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected' } }
          : { ...rest, session: { ...session, idleSince: 5 * MINUTE } };
      },
      openMove: async () => undefined,
      planSignedIn: async () => options.signedIn,
      laptopSignedIn: () => options.laptopHolds(),
      readLaptop: async () => undefined,
      readSource: async () => 'unknown',
      readProvider: async () => 'running',
      actions: {
        'replace-sign-in': act('replace-sign-in', () =>
          options.laptopHolds()
            ? { outcome: 'done', detail: 'sign-in already in place' }
            : { outcome: 'refused', detail: SIGN_IN_NOWHERE }
        ),
        'rebuild-laptop': act('rebuild-laptop', () => {
          state.rebuilt = true;
          return { outcome: 'done', detail: 'rebuilt new' };
        }),
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
    const run = async (minutes: number) => {
      for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
        await supervisor.tick();
        state.now += 30_000;
      }
    };
    return { state, supervisor, run, report: () => supervisor.reports(undefined)[0]! };
  }

  it('rebuilds the laptop of an agent that still shows the sign-in screen with its sign-in in place, and asks nobody', async () => {
    const w = driven({ signedIn: true, laptopHolds: () => true });
    await w.run(10);
    // No look is spent: the last read already says the laptop holds the sign-in. One rebuild, and it is over.
    expect(w.state.acts).toEqual(['rebuild-laptop']);
    expect(w.report()).toMatchObject({ condition: 'healthy' });
    expect(w.state.lines.filter((line) => line.includes('needs a person'))).toEqual([]);
  });

  it('does not rebuild for a plan that is signed in nowhere, says so once, and goes on by itself when it is signed in', async () => {
    let holds = false;
    const w = driven({ signedIn: false, laptopHolds: () => holds });
    await w.run(60);
    expect(w.state.acts).toEqual(['replace-sign-in', 'replace-sign-in', 'replace-sign-in']);
    expect(w.report()).toMatchObject({ condition: 'needs-sign-in', code: 'plan-signed-out' });
    expect(w.report().needsHuman).toMatch(/Only the account holder can sign a plan in/);
    expect(w.state.lines.filter((line) => line.includes('needs a person')).length).toBeLessThanOrEqual(2);
    // The account holder signs the plan in; the reconciler puts the sign-in into the laptop.
    holds = true;
    await w.run(5);
    expect(w.state.acts.at(-1)).toBe('rebuild-laptop');
    expect(w.state.acts.filter((name) => name === 'rebuild-laptop')).toHaveLength(1);
    expect(w.report()).toMatchObject({ condition: 'healthy' });
  });
});

describe('an agent parked on its sign-in screen beside what a closed plan move still owes', () => {
  const REPAIR = flags({ autoRepair: true, relaunchAvailable: true });
  const owing = (phase: 'handoff-owed' | 'handoff-unconfirmed') =>
    ({ id: 'm1', docker: true, phase, busy: false, allowedActions: [] }) as const;

  for (const phase of ['handoff-owed', 'handoff-unconfirmed'] as const) {
    it(`${phase}: has its sign-in put back and its agent started again, as without the record`, () => {
      const steps = new Set<string>();
      let history: SupervisorHistory = EMPTY_SUPERVISOR_HISTORY;
      for (let now = 0; now < 12 * 60 * MINUTE; now += 30_000) {
        const seen = atSignIn({ move: owing(phase), session: { ...parkedSession, idleSince: now - 10 * MINUTE } });
        history = rollSupervisorHistory(history, classifyEmployee(seen), now);
        const result = assessEmployee(seen, history, REPAIR, now);
        expect(result.needsHuman).toBeUndefined();
        if (result.next.action && (result.next.at ?? 0) <= now) {
          steps.add(result.next.action);
          history = recordSupervisorAttempt(history, result.next.action, now, 'done', 'sign-in already in place');
        }
      }
      expect([...steps].sort()).toEqual(['rebuild-laptop', 'relaunch-provider', 'replace-sign-in']);
    });
  }

  it('is a laptop the office reads, so the record does not keep it from counting as evidence about the office', () => {
    for (const phase of ['handoff-owed', 'handoff-unconfirmed'] as const) {
      const seen = atSignIn({ move: owing(phase), session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown' } });
      const ready = { ...seen, laptop: { ...seen.laptop, restoration: undefined, continuation: { state: 'ready', phase: 'ready', allowedActions: [] } } } as SupervisorObservation;
      expect(officeReading(ready, true)).toBe('cannot-read');
    }
    // A move that is open still owns the laptop.
    const open = atSignIn({ move: { id: 'm2', docker: true, phase: 'starting', busy: false, allowedActions: [] } });
    expect(moveOwnsLaptop(open.move)).toBe(true);
    expect(moveOwnsLaptop(owing('handoff-owed'))).toBe(false);
    // A held move of the retired runtime gates no laptop either.
    expect(moveOwnsLaptop({ id: 'm3', docker: false, phase: 'recovery-required', busy: false, allowedActions: ['settle'] })).toBe(false);
  });

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
  /** The office with the handoff on record for the session Burt is on; a rebuild keeps that session. */
  function driven(phase: 'handoff-owed' | 'handoff-unconfirmed') {
    const state = { now: 10 * MINUTE, acts: [] as string[], rebuilt: false, delivered: false };
    const ports: EmployeeSupervisorPorts = {
      now: () => state.now,
      ready: () => true,
      employees: () => [employee],
      flags: () => ({ enabled: true, autoRepair: true }),
      glance: () => {
        const { session, ...rest } = atSignIn();
        return state.rebuilt
          ? { ...rest, session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', turn: 'idle', idleSince: state.now - MINUTE } }
          : { ...rest, session: { ...session, idleSince: 5 * MINUTE } };
      },
      openMove: async () => (state.delivered ? undefined : owing(phase)),
      planSignedIn: async () => true,
      laptopSignedIn: () => true,
      readLaptop: async () => undefined,
      readSource: async () => 'unknown',
      readProvider: async () => 'running',
      actions: {
        'rebuild-laptop': async () => {
          state.acts.push('rebuild-laptop');
          state.rebuilt = true;
          return { outcome: 'done', detail: 'rebuilt new' };
        },
        'continue-move': async (_employee, _guard, move) => {
          state.acts.push('continue-move:' + move?.id + ':' + move?.phase);
          state.delivered = true;
          return { outcome: 'done', detail: 'handoff delivered m1' };
        },
      },
      load: () => new Map(),
      save: async () => {},
      audit: () => {},
      log: () => {},
    };
    const supervisor = new EmployeeSupervisor(ports, SUPERVISOR_POLICY, {
      actionsPerTick: 2,
      startupGraceMs: 0,
      actionWaitMs: 1000,
      idleReadMs: 2 * MINUTE,
      limitsCheckMs: 10 * MINUTE,
    });
    const run = async (minutes: number) => {
      for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
        await supervisor.tick();
        state.now += 30_000;
      }
    };
    return { state, run, report: () => supervisor.reports(undefined)[0]! };
  }

  it('types the owed handoff into the rebuilt laptop once its agent is back, and is then running', async () => {
    const w = driven('handoff-owed');
    await w.run(30);
    expect(w.state.acts).toEqual(['rebuild-laptop', 'continue-move:m1:handoff-owed']);
    expect(w.report()).toMatchObject({ condition: 'healthy' });
  });

  it('rebuilds beside a handoff whose outcome is not known, and never types that one', async () => {
    const w = driven('handoff-unconfirmed');
    await w.run(30);
    expect(w.state.acts).toEqual(['rebuild-laptop']);
    expect(w.report()).toMatchObject({ condition: 'healthy' });
    expect(w.report().sentence).toMatch(/never typed twice/);
  });
});
