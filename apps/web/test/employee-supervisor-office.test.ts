import { describe, expect, it } from 'vitest';
import { officeSupervisorPorts, type OfficeSupervisorDeps } from '../src/employee-supervisor-office.js';
import type { SupervisedEmployee, SupervisorAuditEntry } from '../src/employee-supervisor.js';
import { EmployeeSupervisor } from '../src/employee-supervisor.js';
import { PlanMoveError, type PlanMoveRecord } from '../src/plan-move.js';

const row = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  owner: undefined,
  sessionId: 'session-' + id,
  sessionGeneration: 1,
  desiredRunning: true,
  onVacation: false,
  runtimeRecipe: { subscriptionProfile: { id: 'plan-a', label: 'Plan A', provider: 'anthropic' } },
  ...patch,
});
const move = (patch: Partial<PlanMoveRecord> = {}): PlanMoveRecord => ({
  id: 'move-1',
  employeeId: 'a',
  name: 'A',
  oldSession: 'session-a',
  newSession: 'session-new',
  fromAccount: 'plan-a',
  toAccount: 'plan-b',
  phase: 'recovery-required',
  at: 1,
  error: 'DOCKER_RESOURCE_HELPER_FAILED',
  backend: 'docker',
  allowedActions: ['continue-original', 'abandon'],
  ...patch,
});

function office() {
  const state = {
    now: 1_000_000,
    ready: true,
    rows: [row('a'), row('b')] as Array<ReturnType<typeof row>>,
    settings: {} as Record<string, unknown>,
    sessions: new Map<string, Record<string, unknown>>([
      ['session-a', { pid: 10, status: 'idle', runtimeHealth: 'healthy' }],
      ['session-b', { pid: 11, status: 'idle', runtimeHealth: 'healthy' }],
    ]),
    restorations: [
      { employeeId: 'a', state: 'attached' },
      { employeeId: 'b', state: 'attached' },
    ] as Array<{ employeeId: string; state: 'attached' | 'held'; code?: string }>,
    moves: [] as PlanMoveRecord[],
    publicationUnconfirmed: false,
    ownerStop: false,
    recovery: true,
    flight: false,
    /** Sessions whose saved record says their terminal input is held, and each time that record was asked. */
    heldOnRecord: [] as string[],
    recordReads: [] as string[],
    screenReads: 0,
    calls: [] as Array<[string, ...unknown[]]>,
    /** Limits checks the laptops service was asked for, by employee. */
    keeps: [] as string[],
    audits: [] as SupervisorAuditEntry[],
    wake: { awakened: ['a'], skipped: [] } as { awakened: string[]; skipped: Array<{ employeeId: string; reason: string }> },
    throwing: undefined as Error | undefined,
    /** What the adoption of a retired move answers with; undefined adopts. */
    adoption: undefined as Error | undefined,
    bound: true,
  };
  const deps = {
    company: {
      registeredEmployees: () => structuredClone(state.rows),
      view: () => ({ settings: state.settings }),
      employeeRecoveryAvailable: () => state.recovery,
      store: {
        get publicationUnconfirmed() {
          return state.publicationUnconfirmed;
        },
      },
    },
    session: (id: string) => state.sessions.get(id),
    inputHeldOnRecord: (id: string) => {
      state.recordReads.push(id);
      return state.heldOnRecord.includes(id);
    },
    ready: () => state.ready,
    laptops: {
      glance: () => ({ record: { phase: 'ready', version: 2, operationId: 'op' }, bound: state.bound, policyApproved: true, templateOnRecord: true }),
      flightActive: () => state.flight,
      read: async () => undefined,
      source: async () => 'stopped',
      provider: async () => 'absent',
      resend: async () => ({ outcome: 'done' }),
      start: async () => ({ outcome: 'done' }),
      rebuild: async (employee: SupervisedEmployee, guard: () => void, proved: readonly string[]) => {
        guard();
        state.calls.push(['rebuild', employee.id, proved]);
        return { outcome: 'done', detail: 'rebuilt new' };
      },
      keepLimits: async (employee: SupervisedEmployee, guard: () => void) => {
        guard();
        state.keeps.push(employee.id);
        return { outcome: 'done', detail: 'unchanged' };
      },
    },
    restorations: () => state.restorations,
    providerHealth: () => ({ state: 'healthy' }),
    ownerStopPending: () => state.ownerStop,
    moves: {
      list: async () => structuredClone(state.moves),
      get: async (id: string) => structuredClone(state.moves.find((value) => value.id === id)),
      continueDocker: async (...args: unknown[]) => {
        state.calls.push(['continueDocker', ...args]);
        if (state.throwing) throw state.throwing;
      },
      abandonHeldDockerMove: async (
        id: string,
        employeeId: string,
        owner: unknown,
        authorized: () => void,
        note?: string
      ) => {
        authorized();
        state.calls.push(['abandon', id, employeeId, owner, note]);
        if (state.throwing) throw state.throwing;
        state.moves = state.moves.map((value) => (value.id === id ? { ...value, phase: 'failed' } : value));
      },
      resolve: async (id: string, expected: unknown, owner: unknown, executor: unknown) => {
        state.calls.push(['resolve', id, expected, owner, executor]);
        if (state.adoption) throw state.adoption;
        state.moves = state.moves.map((value) => (value.id === id ? { ...value, phase: 'completed' } : value));
      },
      settleRetiredMove: async (id: string, employeeId: string, owner: unknown, authorized: () => void, note: string) => {
        authorized();
        state.calls.push(['settle', id, employeeId, owner, note]);
        if (state.throwing) throw state.throwing;
        state.moves = state.moves.map((value) => (value.id === id ? { ...value, phase: 'failed' } : value));
      },
    },
    moveExecutor: (employee: SupervisedEmployee, current: () => boolean) => ({ executorFor: employee.id, current }),
    planSignedIn: async () => true,
    wake: async (id: string, options: { stillCurrent: () => boolean }) => {
      state.calls.push(['wake', id, options.stillCurrent()]);
      return state.wake;
    },
    load: () => new Map(),
    save: async () => {},
    audit: (entry: SupervisorAuditEntry) => state.audits.push(entry),
    log: () => {},
    now: () => state.now,
  } as unknown as OfficeSupervisorDeps;
  const ports = officeSupervisorPorts(deps);
  const employee = (id = 'a') => ports.employees().find((value) => value.id === id)!;
  return { state, ports, employee };
}
const pass = () => {};

describe('office supervisor ports', () => {
  it('reads each employee and the plan they should run on from the company record', () => {
    const o = office();
    o.state.rows = [row('a'), row('b', { onVacation: true, runtimeRecipe: { customModel: {} } }), row('c', { runtimeRecipe: undefined })];
    expect(o.ports.employees()).toEqual([
      expect.objectContaining({ id: 'a', planAccountId: 'plan-a', planLabel: 'Plan A', onVacation: false, bindingMigration: false }),
      expect.objectContaining({ id: 'b', planLabel: 'their local model', onVacation: true }),
      expect.not.objectContaining({ planLabel: expect.anything() }),
    ]);
  });

  it('is on unless the owner switched it off, one switch at a time', () => {
    const o = office();
    expect(o.ports.flags(undefined)).toEqual({ enabled: true, autoRepair: true });
    o.state.settings = { supervisorAutoRepair: false };
    expect(o.ports.flags(undefined)).toEqual({ enabled: true, autoRepair: false });
    o.state.settings = { supervisorEnabled: false };
    expect(o.ports.flags(undefined)).toEqual({ enabled: false, autoRepair: true });
  });

  it('glances from memory: session, laptop record, last attach and whether another laptop runs', () => {
    const o = office();
    expect(o.ports.glance(o.employee())).toEqual({
      employeeId: 'a',
      name: 'A',
      desiredRunning: true,
      onVacation: false,
      bindingMigration: false,
      boxed: true,
      planLabel: 'Plan A',
      session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', providerHealth: 'healthy' },
      laptop: {
        record: { phase: 'ready', version: 2, operationId: 'op' },
        bound: true,
        policyApproved: true,
        templateOnRecord: true,
        restoration: { state: 'attached' },
        poolAlive: true,
      },
    });
    o.state.restorations = [{ employeeId: 'a', state: 'held', code: 'DOCKER_CONTINUATION_DESTINATION_STOPPED' }];
    o.state.sessions.delete('session-a');
    expect(o.ports.glance(o.employee())).toMatchObject({
      session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown' },
      laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_DESTINATION_STOPPED' }, poolAlive: false },
    });
  });

  it('says when a terminal can never be typed into again, and what its pane shows of the agent’s turn', () => {
    const o = office();
    const seen = () => o.ports.glance(o.employee()).session;
    const held = { pid: 10, status: 'idle', runtimeHealth: 'unknown', terminalInputHeld: true, isWorking: false };
    o.state.sessions.set('session-a', { ...held, lastActivityAt: 900_000, lastPromptTime: 800_000, paneStartedAt: 100_000 });
    expect(seen()).toEqual({
      available: true,
      runtimeHealth: 'unknown',
      viewerHealth: 'connected',
      providerHealth: 'healthy',
      inputHeld: true,
      turn: 'idle',
      idleSince: 900_000,
    });
    o.state.sessions.set('session-a', { ...held, status: 'busy', isWorking: true });
    expect(seen()).toMatchObject({ inputHeld: true, turn: 'working' });
    expect(seen()).not.toHaveProperty('idleSince');
    // The terminal lost its client: what it last showed is not what the pane shows now.
    o.state.sessions.set('session-a', { ...held, runtimeHealth: 'disconnected' });
    expect(seen()).toMatchObject({ inputHeld: true, turn: 'unknown' });
    // A terminal that takes input reports no hold, and its own word is taken over the saved record's. What its
    // pane shows of the turn is still reported: any rebuild of a laptop an agent runs in is judged by it.
    o.state.heldOnRecord = ['session-a'];
    o.state.sessions.set('session-a', { pid: 10, status: 'busy', isWorking: true, runtimeHealth: 'unknown' });
    expect(seen()).toEqual({
      available: true,
      runtimeHealth: 'unknown',
      viewerHealth: 'connected',
      providerHealth: 'healthy',
      turn: 'working',
    });
    o.state.sessions.set('session-a', { pid: 10, status: 'idle', isWorking: false, runtimeHealth: 'unknown', lastActivityAt: 700_000, watching: 'a monitor' });
    expect(seen()).toMatchObject({ turn: 'idle', idleSince: 700_000, background: true });
    expect(seen()).not.toHaveProperty('inputHeld');
    expect(o.state.recordReads).toEqual([]);
  });

  it('reads a hold from the saved record once the office has no terminal object, and then knows nothing of the turn', () => {
    const o = office();
    o.state.sessions.delete('session-a');
    expect(o.ports.glance(o.employee()).session).toEqual({ available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown', providerHealth: 'healthy' });
    o.state.heldOnRecord = ['session-a'];
    expect(o.ports.glance(o.employee()).session).toEqual({
      available: false,
      runtimeHealth: 'unknown',
      viewerHealth: 'unknown',
      providerHealth: 'healthy',
      inputHeld: true,
      turn: 'unknown',
    });
    expect(o.state.recordReads).toEqual(['session-a', 'session-a']);
  });

  it.each([
    ['publication-unconfirmed', (state: ReturnType<typeof office>['state']) => (state.publicationUnconfirmed = true)],
    ['owner-stop-pending', (state: ReturnType<typeof office>['state']) => (state.ownerStop = true)],
    ['recovery-pending', (state: ReturnType<typeof office>['state']) => (state.recovery = false)],
    ['continuation-flight', (state: ReturnType<typeof office>['state']) => (state.flight = true)],
    [
      'lifecycle-in-progress',
      (state: ReturnType<typeof office>['state']) => (state.sessions.get('session-a')!.paneLifecycleInFlight = true),
    ],
  ])('reports %s so nothing starts beside it', (busy, change) => {
    const o = office();
    expect(o.ports.glance(o.employee()).busy).toBeUndefined();
    change(o.state);
    expect(o.ports.glance(o.employee()).busy).toBe(busy);
  });

  it('reads the screen of a session that looks fine at most once a minute and never while the agent is working', () => {
    const o = office();
    const session = o.state.sessions.get('session-a')!;
    session.isWorking = false;
    session.startupScreen = () => {
      o.state.screenReads++;
      return null;
    };
    const seen = () => o.ports.glance(o.employee()).session.startupScreen;
    expect(seen()).toBeUndefined();
    expect(seen()).toBeUndefined();
    expect(o.state.screenReads).toBe(1);
    o.state.now += 61_000;
    seen();
    expect(o.state.screenReads).toBe(2);
    session.status = 'busy';
    expect(seen()).toBeUndefined();
    expect(o.state.screenReads).toBe(2);
    session.status = 'idle';
    session.startupScreen = () => {
      throw new Error('tmux gone');
    };
    expect(seen()).toBeUndefined();
  });

  it('reports a start-up screen only when it is proved, and reads the pane at every look once it showed one', () => {
    const o = office();
    const session = o.state.sessions.get('session-a')!;
    Object.assign(session, { isWorking: false, lastActivityAt: 900_000, paneStartedAt: 100_000 });
    let shown: string | undefined = 'widget';
    session.startupScreen = () => {
      o.state.screenReads++;
      return { id: 'login', label: "Claude's sign-in screen", kind: 'credential', answering: false, ...(shown ? { shown } : {}) };
    };
    const seen = () => o.ports.glance(o.employee()).session;
    expect(seen()).toEqual({
      available: true,
      runtimeHealth: 'healthy',
      viewerHealth: 'connected',
      providerHealth: 'healthy',
      startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false, proof: 'widget' },
      turn: 'idle',
      idleSince: 900_000,
    });
    // Never from a kept read: the look the driver takes before a step reads the pane again, in the same pass.
    seen();
    seen();
    expect(o.state.screenReads).toBe(3);
    shown = 'launch';
    expect(seen().startupScreen).toMatchObject({ proof: 'launch' });
    // The pane says its agent left something running.
    session.watching = '1 shell';
    expect(seen()).toMatchObject({ turn: 'idle', background: true });
    // Words about a screen are what a conversation that quotes it shows too: nothing is reported for them.
    // What the pane shows of a turn is reported as for every laptop, screen or not.
    for (const words of ['words', undefined]) {
      shown = words;
      expect(seen()).not.toHaveProperty('startupScreen');
      expect(seen()).toMatchObject({ turn: 'idle', idleSince: 900_000 });
    }
    // Nor for a pane the office is not reading.
    shown = 'widget';
    session.runtimeHealth = 'disconnected';
    expect(seen()).not.toHaveProperty('startupScreen');
  });

  it('shows the one open laptop move and ignores held moves of the retired runtime', async () => {
    const o = office();
    expect(await o.ports.openMove(o.employee())).toBeUndefined();
    o.state.moves = [move({ id: 'old', phase: 'completed' }), move({ id: 'native', backend: undefined }), move()];
    expect(await o.ports.openMove(o.employee())).toEqual({
      id: 'move-1',
      docker: true,
      phase: 'recovery-required',
      busy: false,
      error: 'DOCKER_RESOURCE_HELPER_FAILED',
      allowedActions: ['continue-original', 'abandon'],
      toAccount: 'plan-b',
    });
    expect(await o.ports.openMove(o.employee('b'))).toBeUndefined();
    // A working move of the retired runtime still counts as a move in progress.
    o.state.moves = [move({ id: 'native', backend: undefined, phase: 'starting' })];
    expect(await o.ports.openMove(o.employee())).toMatchObject({ id: 'native', docker: false, phase: 'starting' });
  });

  it('continues a held move as its original, with an executor that follows the employee and the switch', async () => {
    const o = office();
    o.state.moves = [move()];
    const held = (await o.ports.openMove(o.employee()))!;
    expect(await o.ports.actions['continue-move']!(o.employee(), pass, held)).toEqual({
      outcome: 'done',
      detail: 'continuing move-1',
    });
    const [, id, expected, owner, executor] = o.state.calls[0]!;
    expect([id, expected, owner]).toEqual([
      'move-1',
      { oldSession: 'session-a', newSession: 'session-new', toAccount: 'plan-b' },
      undefined,
    ]);
    const { current } = executor as { current: () => boolean };
    expect(current()).toBe(true);
    // The move rebinds the employee's session when it completes: the authority follows the employee, not the session.
    o.state.rows[0]!.sessionId = 'session-new';
    expect(current()).toBe(true);
    o.state.settings = { supervisorEnabled: false };
    expect(current()).toBe(false);
    o.state.settings = {};
    o.state.rows[0]!.onVacation = true;
    expect(current()).toBe(false);
    o.state.rows[0]!.onVacation = false;
    o.state.ready = false;
    expect(current()).toBe(false);
  });

  it('does not continue a move that changed, and reports a refusal in the move’s own words', async () => {
    const o = office();
    o.state.moves = [move()];
    const held = (await o.ports.openMove(o.employee()))!;
    o.state.moves = [move({ phase: 'completed' })];
    expect(await o.ports.actions['continue-move']!(o.employee(), pass, held)).toEqual({ outcome: 'refused', detail: 'the move changed' });
    o.state.moves = [move()];
    o.state.throwing = new PlanMoveError('The move is still active');
    expect(await o.ports.actions['continue-move']!(o.employee(), pass, held)).toEqual({ outcome: 'busy', detail: 'The move is still active' });
    o.state.throwing = new PlanMoveError('The original recovery target changed');
    expect((await o.ports.actions['continue-move']!(o.employee(), pass, held)).outcome).toBe('refused');
    o.state.throwing = new Error('disk');
    await expect(o.ports.actions['continue-move']!(o.employee(), pass, held)).rejects.toThrow('disk');
    expect(await o.ports.actions['continue-move']!(o.employee(), pass, undefined)).toEqual({ outcome: 'refused', detail: 'no held move' });
  });

  it('abandons a held move through the same service call, under the supervisor’s own guard', async () => {
    const o = office();
    o.state.moves = [move()];
    const held = (await o.ports.openMove(o.employee()))!;
    expect(await o.ports.actions['abandon-move']!(o.employee(), pass, held)).toEqual({ outcome: 'done', detail: 'abandoned move-1' });
    expect(o.state.calls).toEqual([['abandon', 'move-1', 'a', undefined, expect.stringContaining('supervisorAutoRepair')]]);
    o.state.moves = [move()];
    const refusing = () => {
      throw new Error('switched off');
    };
    expect(await o.ports.actions['abandon-move']!(o.employee(), refusing, held)).toEqual({
      outcome: 'refused',
      detail: 'The office supervisor may no longer abandon this move',
    });
    expect(o.state.calls).toHaveLength(1);
  });

  it('reconnects a terminal with the owner’s Wake, which only attaches what already runs', async () => {
    const o = office();
    expect(await o.ports.actions['reconnect-viewer']!(o.employee(), pass, undefined)).toEqual({ outcome: 'done', detail: 'attached' });
    expect(o.state.calls).toEqual([['wake', 'a', true]]);
    o.state.wake = { awakened: [], skipped: [{ employeeId: 'a', reason: 'docker-destination-stopped' }] };
    expect(await o.ports.actions['reconnect-viewer']!(o.employee(), pass, undefined)).toEqual({
      outcome: 'refused',
      detail: 'docker-destination-stopped',
    });
    o.state.wake = { awakened: [], skipped: [{ employeeId: 'a', reason: 'recovery-in-progress' }] };
    expect((await o.ports.actions['reconnect-viewer']!(o.employee(), pass, undefined)).outcome).toBe('busy');
  });

  it('hands the rebuild what was proved for it, so the laptops service can tell why it was chosen', async () => {
    const o = office();
    expect(await o.ports.actions['rebuild-laptop']!(o.employee(), pass, undefined, ['terminal-input-held'])).toEqual({
      outcome: 'done',
      detail: 'rebuilt new',
    });
    await o.ports.actions['rebuild-laptop']!(o.employee(), pass, undefined, []);
    expect(o.state.calls).toEqual([
      ['rebuild', 'a', ['terminal-input-held']],
      ['rebuild', 'a', []],
    ]);
  });

  it('drives a held terminal through a whole pass: one refused wake, then a rebuild asked for with its reason', async () => {
    const o = office();
    o.state.restorations = [
      { employeeId: 'a', state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' },
      { employeeId: 'b', state: 'attached' },
    ];
    const terminal = { pid: 10, status: 'idle', runtimeHealth: 'unknown', terminalInputHeld: true, isWorking: false };
    o.state.sessions.set('session-a', { ...terminal, lastActivityAt: o.state.now - 600_000 });
    o.state.wake = { awakened: [], skipped: [{ employeeId: 'a', reason: 'start-unconfirmed' }] };
    const supervisor = new EmployeeSupervisor(o.ports, undefined, { actionsPerTick: 2, startupGraceMs: 0, actionWaitMs: 50, idleReadMs: 0, limitsCheckMs: 600_000 });
    const report = () => supervisor.reports(undefined).find((value) => value.employeeId === 'a')!;
    const run = async (passes: number) => {
      for (let pass = 0; pass < passes; pass++) {
        await supervisor.tick();
        o.state.now += 30_000;
      }
    };
    // The agent is in the middle of a turn for the first five minutes.
    o.state.sessions.set('session-a', { ...terminal, status: 'busy', isWorking: true });
    await run(10);
    expect(o.state.calls).toEqual([['wake', 'a', true]]);
    expect(report()).toMatchObject({
      condition: 'viewer-lost',
      sentence: "The office can no longer type into A's terminal, so the laptop has to be rebuilt once the agent's current turn has ended.",
      waitingFor: "the agent's current turn to end",
      last: { action: 'reconnect-viewer', outcome: 'refused', detail: 'start-unconfirmed' },
    });
    // The turn ends; two silent minutes later the rebuild is asked for, once.
    o.state.sessions.set('session-a', { ...terminal, lastActivityAt: o.state.now, lastPromptTime: o.state.now });
    await run(3);
    expect(o.state.calls).toEqual([['wake', 'a', true]]);
    await run(3);
    expect(o.state.calls).toEqual([
      ['wake', 'a', true],
      ['rebuild', 'a', ['terminal-input-held']],
    ]);
    expect(o.state.audits.at(-1)).toMatchObject({
      admin: 'office supervisor',
      action: 'supervisor_rebuild_laptop',
      detail: { condition: 'viewer-lost', outcome: 'done', detail: 'rebuilt new', proved: ['terminal-input-held'] },
    });
  });

  it('offers no relaunch step and no laptop steps without the laptop runtime', () => {
    const o = office();
    expect(Object.keys(o.ports.actions).sort()).toEqual([
      'abandon-move', 'apply-standing-limits', 'continue-move', 'rebuild-laptop', 'reconnect-viewer', 'resend-continuation',
      'start-continuation',
    ]);
  });

  it('keeps a laptop’s approved limits through the laptops service, wherever its employee is', async () => {
    const o = office();
    o.state.rows[1] = { ...o.state.rows[1]!, onVacation: true };
    expect(await o.ports.keepLimits!(o.employee('b'), pass)).toEqual({ outcome: 'done', detail: 'unchanged' });
    expect(await o.ports.keepLimits!(o.employee('a'), pass)).toEqual({ outcome: 'done', detail: 'unchanged' });
    expect(o.state.keeps).toEqual(['b', 'a']);
  });

  it('drives a whole pass: a held move is continued and recorded under the supervisor’s own name', async () => {
    const o = office();
    o.state.moves = [move()];
    const supervisor = new EmployeeSupervisor(o.ports, undefined, { actionsPerTick: 2, startupGraceMs: 0, actionWaitMs: 50, idleReadMs: 0, limitsCheckMs: 600_000 });
    await supervisor.tick();
    o.state.now += 61_000;
    await supervisor.tick();
    expect(o.state.calls.map(([name]) => name)).toEqual(['continueDocker']);
    expect(o.state.audits).toEqual([
      {
        admin: 'office supervisor',
        action: 'supervisor_continue_move',
        target: 'A',
        detail: {
          id: 'a',
          sessionId: 'session-a',
          condition: 'move-held-retryable',
          code: 'move-laptop-step',
          outcome: 'done',
          detail: 'continuing move-1',
          attempt: 1,
          moveId: 'move-1',
        },
      },
    ]);
    expect(supervisor.reports(undefined).find((report) => report.employeeId === 'a')).toMatchObject({
      condition: 'move-held-retryable',
      sentence: "A's plan move stopped part-way: DOCKER_RESOURCE_HELPER_FAILED",
      last: { action: 'continue-move', outcome: 'done' },
    });
    expect(supervisor.reports(undefined).find((report) => report.employeeId === 'b')).toMatchObject({ condition: 'healthy' });
  });
});

describe('office supervisor ports: a plan move that stopped part-way', () => {
  const native = (patch: Partial<PlanMoveRecord> = {}) =>
    move({
      id: 'native',
      backend: undefined,
      allowedActions: undefined,
      error: 'The server restarted during this move; inspect both sessions before retrying',
      oldSession: 'session-old',
      newSession: 'session-other',
      ...patch,
    });
  const abandon = (o: ReturnType<typeof office>, held: Parameters<NonNullable<typeof o.ports.actions['abandon-move']>>[2], guard = pass) =>
    o.ports.actions['abandon-move']!(o.employee(), guard, held);

  it('closes several open moves one at a time, oldest first, and continues none of them', async () => {
    const o = office();
    // The service lists the newest first.
    o.state.moves = [move({ id: 'move-2' }), move()];
    const first = (await o.ports.openMove(o.employee()))!;
    expect(first).toMatchObject({ id: 'move-1', allowedActions: ['abandon'] });
    expect(await abandon(o, first)).toEqual({ outcome: 'done', detail: 'abandoned move-1' });
    // One is left: it keeps its whole ladder.
    expect(await o.ports.openMove(o.employee())).toMatchObject({
      id: 'move-2',
      allowedActions: ['continue-original', 'abandon'],
    });
  });

  it('records who closed a move and why, in the sentence the closed move keeps', async () => {
    const o = office();
    o.state.moves = [move({ error: 'The target application viewer is unavailable' })];
    await abandon(o, (await o.ports.openMove(o.employee()))!);
    const note = o.state.calls[0]![4] as string;
    expect(note).toMatch(/^Closed by the office on the owner's standing rule \(company setting supervisorAutoRepair\)/);
    expect(note).toContain('The target application viewer is unavailable');
    expect(note.length).toBeLessThan(1000);
  });

  it('answers a repeat for a move that has ended with done and calls nothing', async () => {
    const o = office();
    o.state.moves = [move()];
    const held = (await o.ports.openMove(o.employee()))!;
    await abandon(o, held);
    expect(await abandon(o, held)).toEqual({ outcome: 'done', detail: 'already closed move-1' });
    o.state.moves = [move({ phase: 'completed' })];
    expect(await abandon(o, held)).toEqual({ outcome: 'done', detail: 'already closed move-1' });
    expect(o.state.calls.filter(([name]) => name === 'abandon')).toHaveLength(1);
    // The service's own replay answer is passed through the same way.
    o.state.moves = [move()];
    o.state.throwing = new PlanMoveError('This move is still working on a step; wait until it is held for recovery', 409);
    expect((await abandon(o, held)).outcome).toBe('busy');
  });

  it('abandons with no executor and no requester, whatever the move had issued', async () => {
    const o = office();
    o.state.moves = [move()];
    await abandon(o, (await o.ports.openMove(o.employee()))!);
    // Only the journal call was made: nothing that could continue, inspect or launch.
    expect(o.state.calls.map(([name]) => name)).toEqual(['abandon']);
    expect(o.state.calls[0]).toHaveLength(5);
  });

  it('shows a held move of the retired runtime only behind every laptop move, and only under the laptop runtime', async () => {
    const o = office();
    o.state.moves = [native(), move()];
    expect(await o.ports.openMove(o.employee())).toMatchObject({ id: 'move-1', docker: true });
    o.state.moves = [native()];
    expect(await o.ports.openMove(o.employee())).toEqual({
      id: 'native',
      docker: false,
      phase: 'recovery-required',
      busy: false,
      error: 'The server restarted during this move; inspect both sessions before retrying',
      allowedActions: ['settle'],
      toAccount: 'plan-b',
    });
    // With repairs switched off nothing would close it, so it is not put in front of the laptop's own retries.
    o.state.settings = { supervisorAutoRepair: false };
    expect(await o.ports.openMove(o.employee())).toBeUndefined();
    o.state.settings = {};
    // A resource transaction keeps its own recovery actor and is never shown.
    for (const patch of [
      { resourceIntent: {} as never },
      { resourcePhase: 'prepared' as const },
      { resourceOwnerScope: 'a'.repeat(64) },
      { purpose: 'runtime-refresh' as const },
    ]) {
      o.state.moves = [native(patch)];
      expect(await o.ports.openMove(o.employee()), JSON.stringify(patch)).toBeUndefined();
    }
  });

  it('closes a retired move and keeps the employee where they work', async () => {
    const o = office();
    o.state.moves = [native()];
    const held = (await o.ports.openMove(o.employee()))!;
    expect(await abandon(o, held)).toEqual({ outcome: 'done', detail: 'closed native' });
    expect(o.state.calls).toEqual([
      ['settle', 'native', 'a', undefined, expect.stringContaining('The server restarted during this move')],
    ]);
    expect(await o.ports.openMove(o.employee())).toBeUndefined();
    expect(await abandon(o, held)).toEqual({ outcome: 'done', detail: 'already closed native' });
  });

  it('finishes a retired move by the owner’s adoption when the employee already works on its new session', async () => {
    const o = office();
    o.state.moves = [native({ newSession: 'session-a', sourceStopRequested: true, sourceCleanupVerified: true })];
    const held = (await o.ports.openMove(o.employee()))!;
    expect(await abandon(o, held)).toEqual({ outcome: 'done', detail: 'adopted native' });
    expect(o.state.calls).toEqual([
      [
        'resolve',
        'native',
        { oldSession: 'session-old', newSession: 'session-a', toAccount: 'plan-b' },
        undefined,
        expect.objectContaining({ executorFor: 'a' }),
      ],
    ]);
    // The executor it was given holds only while the supervisor's guard holds.
    const executor = o.state.calls[0]![4] as { current(): boolean };
    expect(executor.current()).toBe(true);
  });

  it('closes the record instead when the adoption’s own checks refuse, and adopts nothing without cleanup proof', async () => {
    const o = office();
    o.state.moves = [native({ newSession: 'session-a', sourceStopRequested: true, sourceCleanupVerified: true })];
    o.state.adoption = new PlanMoveError('The candidate harness or destination plan changed');
    expect(await abandon(o, (await o.ports.openMove(o.employee()))!)).toEqual({ outcome: 'done', detail: 'closed native' });
    expect(o.state.calls.map(([name]) => name)).toEqual(['resolve', 'settle']);
    // An adoption that is only busy is waited for, and nothing is closed beside it.
    o.state.calls.length = 0;
    o.state.moves = [native({ newSession: 'session-a', sourceStopRequested: true, sourceCleanupVerified: true })];
    o.state.adoption = new PlanMoveError('The move is still active; wait before recovery');
    const waiting = (await o.ports.openMove(o.employee()))!;
    expect((await abandon(o, waiting)).outcome).toBe('busy');
    expect(o.state.calls.map(([name]) => name)).toEqual(['resolve']);
    expect(await o.ports.openMove(o.employee())).toMatchObject({ id: 'native' });
    // Without durable cleanup proof there is nothing to adopt: only the record is closed.
    o.state.calls.length = 0;
    o.state.adoption = undefined;
    o.state.moves = [native({ newSession: 'session-a', sourceStopRequested: true })];
    await abandon(o, (await o.ports.openMove(o.employee()))!);
    expect(o.state.calls.map(([name]) => name)).toEqual(['settle']);
  });

  it('closes nothing for an employee without a laptop, or once the supervisor may no longer act', async () => {
    const o = office();
    o.state.moves = [native()];
    const held = (await o.ports.openMove(o.employee()))!;
    o.state.bound = false;
    expect(await abandon(o, held)).toMatchObject({ outcome: 'refused', detail: expect.stringContaining('does not work in a laptop') });
    o.state.bound = true;
    o.state.now += 7 * 60 * 60_000;
    const refusing = () => {
      throw new Error('switched off');
    };
    expect(await abandon(o, held, refusing)).toMatchObject({ outcome: 'refused', detail: 'The office supervisor may no longer close this move' });
    expect(o.state.calls).toEqual([]);
  });

  it('leaves a retired move it could not close out of sight for six hours, so the laptop is still looked after', async () => {
    const o = office();
    o.state.moves = [native()];
    const held = (await o.ports.openMove(o.employee()))!;
    o.state.throwing = new PlanMoveError('The move journal did not confirm the closure, so the move is still held', 409);
    expect((await abandon(o, held)).outcome).toBe('refused');
    expect(await o.ports.openMove(o.employee())).toBeUndefined();
    o.state.now += 6 * 60 * 60_000 - 1;
    expect(await o.ports.openMove(o.employee())).toBeUndefined();
    o.state.now += 1;
    expect(await o.ports.openMove(o.employee())).toMatchObject({ id: 'native', allowedActions: ['settle'] });
    // A failure that is not the service's own refusal counts the same, and is still reported as a failure.
    o.state.throwing = new Error('disk');
    await expect(abandon(o, held)).rejects.toThrow('disk');
    expect(await o.ports.openMove(o.employee())).toBeUndefined();
  });

  it('drives a retired move from first sight to closed without asking anyone', async () => {
    const o = office();
    o.state.moves = [native()];
    const supervisor = new EmployeeSupervisor(o.ports, undefined, { actionsPerTick: 2, startupGraceMs: 0, actionWaitMs: 50, idleReadMs: 0, limitsCheckMs: 600_000 });
    const report = () => supervisor.reports(undefined).find((value) => value.employeeId === 'a')!;
    for (let minute = 0; minute <= 16; minute++) {
      await supervisor.tick();
      expect(report().needsHuman).toBeUndefined();
      o.state.now += 60_000;
    }
    await supervisor.tick();
    expect(o.state.calls.map(([name]) => name)).toEqual(['settle']);
    expect(o.state.audits.at(-1)).toMatchObject({
      action: 'supervisor_abandon_move',
      detail: { moveId: 'native', code: 'move-retired', outcome: 'done', detail: 'closed native' },
    });
    expect(report()).toMatchObject({ condition: 'healthy' });
  });
});
