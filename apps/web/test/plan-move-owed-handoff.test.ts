/**
 * The handoff a closed plan move still owes its employee: the real private move journal, the real record of typed
 * handoffs and the real supervisor ports, with a recording terminal. No Engine, no provider, nothing live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCli } from '../src/config/cli-registry/registry.js';
import { dockerPlanMaximumStates } from '../src/docker-plan-move-capacity.js';
import { DockerPlanMoveJournalState, dockerPlanMoveHandoffDigest } from '../src/docker-plan-move-data.js';
import { officeSupervisorPorts, type OfficeSupervisorDeps } from '../src/employee-supervisor-office.js';
import { classifyEmployee, type SupervisorObservation } from '../src/employee-supervisor-policy.js';
import { PlanMoveHandoffStore } from '../src/plan-move-handoff-store.js';
import { PlanMoveOwedHandoffs, type OwedHandoffSession } from '../src/plan-move-owed-handoff.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { PlanMoves, type PlanMovePort } from '../src/plan-move.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plan-owed-handoff-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Reached = 'unpublished' | 'published' | 'typing' | 'submitted';
/**
 * A held laptop move over the real journal, stopped where `reached` says: before it switched the employee, after
 * the switch with no handoff, in the middle of typing the handoff, or with the handoff confirmed.
 */
async function heldMove(reached: Reached) {
  const fx = dockerPlanJournalFixture();
  const store = new PlanMoveStore(join(directory, 'moves.json'));
  await store.save([fx.record]);
  await store.dockerPublish(fx.record.id, fx.state, fx.closed, () => {});
  // Recording native state only, as the journal suites do: no Engine effect.
  const maximum = dockerPlanMaximumStates(fx.closed.seed, fx.closed.epoch)[1]!;
  const digest = dockerPlanMoveHandoffDigest(fx.closed.seed.handoff);
  const at = (handoff: unknown) =>
    DockerPlanMoveJournalState.parse({
      ...maximum,
      sourceStop: fx.closed.sourceStop,
      sourceReader: undefined,
      companyPublication: reached === 'unpublished' ? undefined : maximum.companyPublication,
      handoff,
    });
  // The journal takes a handoff only in its own order: nothing, then issued, then submitted.
  const steps = [
    at(undefined),
    ...(reached === 'typing' || reached === 'submitted' ? [at({ phase: 'issued', digest })] : []),
    ...(reached === 'submitted' ? [at({ phase: 'submitted', digest })] : []),
  ];
  let state = fx.closed;
  for (const next of steps) {
    await store.dockerPublish(fx.record.id, state, next, () => {});
    state = next;
  }
  const port = {
    load: () => store.load(),
    save: (records) => store.save(records),
    dockerJournal: {
      record: (id: string) => store.dockerRecord(id),
      abandonOwner: (...args: Parameters<PlanMoveStore['abandonOwnerDockerMove']>) =>
        store.abandonOwnerDockerMove(...args),
    },
  } as unknown as PlanMovePort;
  const moves = new PlanMoves(port);
  const employee = { id: fx.record.employeeId, owner: fx.record.owner, sessionId: state.seed.target.sessionId };
  const close = () => moves.abandonHeldDockerMove(fx.record.id, employee.id, employee.owner);
  return { fx, state, moves, employee, close, text: state.seed.handoff, digest };
}

/** A terminal at an idle, empty Claude composer. It records what is typed into it. */
function terminal() {
  const mark = getCli('claude')!.capabilities.composerReadyMark!;
  const state = { idle: true, working: false, pid: 7 as number | null, typed: [] as string[], confirm: true };
  const session: OwedHandoffSession = {
    mode: 'claude',
    get pid() {
      return state.pid;
    },
    paneDialog: null,
    get isWorking() {
      return state.working;
    },
    terminalBuffer: `ready\n${mark}\n`,
    muxName: 'synthetic',
    captureInputAdmission: (caller) => () => !caller || caller(),
    composerProvablyIdle: () => state.idle,
    writeViaMux: async (text, options) => {
      if (options.admitted && !options.admitted()) return false;
      state.typed.push(text);
      if (state.confirm) options.onOutcome('submitted');
      return true;
    },
  };
  return { session, state };
}

function handoffs(moves: PlanMoves, session: OwedHandoffSession | undefined, clock = { now: Date.now() + 1 }) {
  const file = join(directory, 'plan-move-handoffs.json');
  const store = new PlanMoveHandoffStore(file, () => clock.now);
  const service = new PlanMoveOwedHandoffs({ moves, store, session: () => session, now: () => clock.now });
  return { file, store, service, clock };
}
const yes = () => true;

describe('the record of handoffs the office typed', () => {
  const entry = { employeeId: 'e', sessionId: 's', digest: 'a'.repeat(64), at: 5 };
  it('begins when the office first keeps it, and keeps issued before delivered', () => {
    const store = new PlanMoveHandoffStore(join(directory, 'handoffs.json'), () => 1234);
    expect(store.read()).toEqual({ since: 1234, moves: new Map() });
    // Nothing is delivered that was not issued, and nothing is issued twice.
    expect(() => store.record('move-1', { ...entry, phase: 'delivered' })).toThrow();
    store.record('move-1', { ...entry, phase: 'issued' });
    expect(() => store.record('move-1', { ...entry, phase: 'issued' })).toThrow();
    expect(() => store.record('move-1', { ...entry, digest: 'b'.repeat(64), phase: 'delivered' })).toThrow();
    store.record('move-1', { ...entry, phase: 'delivered' });
    // Another office process reads the same.
    expect(new PlanMoveHandoffStore(join(directory, 'handoffs.json'), () => 9999).read()).toEqual({
      since: 1234,
      moves: new Map([['move-1', { ...entry, phase: 'delivered' }]]),
    });
    expect(fs.statSync(join(directory, 'handoffs.json')).mode & 0o777).toBe(0o600);
  });
  it('says nothing, and records nothing, when it cannot be read', () => {
    const file = join(directory, 'handoffs.json');
    fs.writeFileSync(file, '{"version":1,"purpose":"something else"}');
    const store = new PlanMoveHandoffStore(file);
    expect(store.read()).toBeUndefined();
    expect(() => store.record('move-1', { ...entry, phase: 'issued' })).toThrow('cannot be read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1,"purpose":"something else"}');
  });
});

describe('what a closed move owes', () => {
  it('names the handoff of a move that was closed after it switched the employee and before it typed it', async () => {
    const m = await heldMove('published');
    expect(await m.moves.get(m.fx.record.id, m.employee.owner)).toMatchObject({ handoffState: 'owed' });
    // A held move owes nothing yet: it may still type its handoff itself.
    expect(await m.moves.owedHandoffs(m.employee.owner)).toEqual([]);
    const closed = await m.close();
    expect(closed).toMatchObject({ phase: 'failed', handoffState: 'owed' });
    expect(await m.moves.owedHandoffs(m.employee.owner)).toEqual([
      {
        moveId: m.fx.record.id,
        employeeId: m.employee.id,
        sessionId: m.employee.sessionId,
        text: m.text,
        digest: m.digest,
        typed: false,
        closedAt: closed.dockerAbandonment!.at,
      },
    ]);
    expect(await m.moves.owedHandoffs('someone-else')).toEqual([]);
  });
  it('names none for a move that never switched the employee, or whose handoff is confirmed', async () => {
    for (const reached of ['unpublished', 'submitted'] as const) {
      await rm(join(directory, 'moves.json'), { force: true });
      await rm(join(directory, 'moves.json.lock'), { force: true });
      const m = await heldMove(reached);
      await m.close();
      expect(await m.moves.owedHandoffs(m.employee.owner), reached).toEqual([]);
      expect((await m.moves.get(m.fx.record.id, m.employee.owner))!.handoffState).toBe(
        reached === 'submitted' ? 'delivered' : undefined
      );
    }
  });
  it('says so when the move itself had begun to type the handoff', async () => {
    const m = await heldMove('typing');
    await m.close();
    expect(await m.moves.owedHandoffs(m.employee.owner)).toMatchObject([{ typed: true }]);
    expect(await m.moves.get(m.fx.record.id, m.employee.owner)).toMatchObject({ handoffState: 'unconfirmed' });
  });
});

describe('typing the handoff a closed move owes', () => {
  it('types exactly the move’s text once, with issued on record before the first byte, and then owes nothing', async () => {
    const m = await heldMove('published');
    const t = terminal();
    const h = handoffs(m.moves, t.session);
    expect(await h.service.owed(m.employee)).toBeUndefined();
    h.clock.now = Date.now() + 10;
    await m.close();
    expect(await h.service.owed(m.employee)).toEqual({ moveId: m.fx.record.id, state: 'owed' });
    const write = t.session.writeViaMux;
    let onRecord: unknown;
    t.session.writeViaMux = async (text, options) => {
      onRecord = h.store.read()!.moves.get(m.fx.record.id)?.phase;
      return write(text, options);
    };
    expect(await h.service.deliver(m.employee, m.fx.record.id, yes)).toEqual({
      outcome: 'done',
      detail: 'handoff delivered ' + m.fx.record.id,
    });
    expect(onRecord).toBe('issued');
    expect(t.state.typed).toEqual([m.text + '\r']);
    expect(h.store.read()!.moves.get(m.fx.record.id)).toMatchObject({ phase: 'delivered', digest: m.digest });
    // Nothing is owed any more, in this office process or the next, and a repeat types nothing.
    expect(await h.service.owed(m.employee)).toBeUndefined();
    const later = handoffs(
      new PlanMoves({ load: () => new PlanMoveStore(join(directory, 'moves.json')).load() } as never),
      t.session
    );
    expect(await later.service.owed(m.employee)).toBeUndefined();
    expect(await h.service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(t.state.typed).toHaveLength(1);
  });

  it('types nothing while the agent is not idle at an empty composer, and records nothing', async () => {
    const m = await heldMove('published');
    const t = terminal();
    const h = handoffs(m.moves, t.session);
    await m.close();
    const attempt = () => h.service.deliver(m.employee, m.fx.record.id, yes);
    t.state.idle = false;
    expect(await attempt()).toMatchObject({ outcome: 'busy' });
    t.state.idle = true;
    t.state.working = true;
    expect(await attempt()).toMatchObject({ outcome: 'busy' });
    t.state.working = false;
    t.state.pid = null;
    expect(await attempt()).toMatchObject({ outcome: 'busy' });
    t.state.pid = 7;
    // The caller's guard no longer holds: the terminal admits no input.
    expect(await h.service.deliver(m.employee, m.fx.record.id, () => false)).toMatchObject({ outcome: 'busy' });
    // No terminal at all.
    expect(await handoffs(m.moves, undefined).service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({
      outcome: 'busy',
    });
    expect(t.state.typed).toEqual([]);
    expect(h.store.read()!.moves.size).toBe(0);
    expect(await h.service.owed(m.employee)).toEqual({ moveId: m.fx.record.id, state: 'owed' });
    expect(await attempt()).toMatchObject({ outcome: 'done' });
  });

  it('never types a handoff twice: one that was typed and not confirmed stays unconfirmed', async () => {
    const m = await heldMove('published');
    const t = terminal();
    const h = handoffs(m.moves, t.session);
    await m.close();
    const submit = vi.fn(async () => {
      throw new Error('Recovery instruction submission was not confirmed');
    });
    const service = new PlanMoveOwedHandoffs({ moves: m.moves, store: h.store, session: () => t.session, submit });
    expect(await service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'failed' });
    expect(h.store.read()!.moves.get(m.fx.record.id)).toMatchObject({ phase: 'issued' });
    expect(await service.owed(m.employee)).toEqual({ moveId: m.fx.record.id, state: 'unconfirmed' });
    // Asked again, by this process or a later one: refused before the terminal is touched.
    expect(await service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(await h.service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(t.state.typed).toEqual([]);
  });

  it('never types a handoff the move itself had begun to type', async () => {
    const m = await heldMove('typing');
    const t = terminal();
    const h = handoffs(m.moves, t.session);
    await m.close();
    expect(await h.service.owed(m.employee)).toEqual({ moveId: m.fx.record.id, state: 'unconfirmed' });
    expect(await h.service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(t.state.typed).toEqual([]);
  });

  it('types nothing for a move that was closed before the office kept the record', async () => {
    // The move was closed by hand long ago. A new version of the office starts and finds its journal.
    const m = await heldMove('published');
    const closed = await m.close();
    const t = terminal();
    const h = handoffs(m.moves, t.session, { now: closed.dockerAbandonment!.at + 60_000 });
    expect(await h.service.owed(m.employee)).toBeUndefined();
    expect(await h.service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(t.state.typed).toEqual([]);
  });

  it('types nothing into a session the employee has left, or when the record cannot be read', async () => {
    const m = await heldMove('published');
    const t = terminal();
    const h = handoffs(m.moves, t.session);
    await m.close();
    const moved = { ...m.employee, sessionId: 'another-session' };
    expect(await h.service.owed(moved)).toBeUndefined();
    expect(await h.service.deliver(moved, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(await h.service.owed({ ...m.employee, id: 'someone-else' })).toBeUndefined();
    // The record is damaged: what was typed is not known, so nothing is typed and that is what is said.
    fs.writeFileSync(h.file, 'not json');
    expect(await h.service.owed(m.employee)).toEqual({ moveId: m.fx.record.id, state: 'unconfirmed' });
    expect(await h.service.deliver(m.employee, m.fx.record.id, yes)).toMatchObject({ outcome: 'refused' });
    expect(t.state.typed).toEqual([]);
  });
});

describe('an employee is never left on a new session without its handoff, and never called healthy meanwhile', () => {
  /** The supervisor's real ports over the real journal and the real handoff record. */
  function office(m: Awaited<ReturnType<typeof heldMove>>, session: OwedHandoffSession, withHandoffs = true) {
    const h = handoffs(m.moves, session);
    const row = {
      id: m.employee.id,
      name: 'Stan',
      owner: m.employee.owner,
      sessionId: m.employee.sessionId,
      sessionGeneration: 2,
      desiredRunning: true,
      onVacation: false,
    };
    const calls: string[] = [];
    const ports = officeSupervisorPorts({
      company: {
        registeredEmployees: () => [row],
        view: () => ({ settings: {} }),
        employeeRecoveryAvailable: () => true,
        store: { publicationUnconfirmed: false },
      },
      session: () => ({ pid: 7, status: 'idle', runtimeHealth: 'healthy', isWorking: false }),
      ready: () => true,
      laptops: {
        glance: () => ({
          record: { phase: 'ready', version: 3, operationId: 'op' },
          bound: true,
          policyApproved: true,
          templateOnRecord: true,
        }),
        flightActive: () => false,
      },
      restorations: () => [{ employeeId: row.id, state: 'attached' }],
      ownerStopPending: () => false,
      moves: m.moves,
      ...(withHandoffs ? { handoffs: h.service } : {}),
      moveExecutor: () => {
        calls.push('executor');
        return {};
      },
      planSignedIn: async () => true,
      wake: async () => ({ awakened: [], skipped: [] }),
      load: () => new Map(),
      save: async () => {},
      audit: () => {},
      log: () => {},
    } as unknown as OfficeSupervisorDeps);
    const employee = ports.employees()[0]!;
    const seen = async (): Promise<SupervisorObservation> => {
      const move = await ports.openMove(employee);
      return { ...ports.glance(employee), ...(move ? { move } : {}) };
    };
    return { ports, employee, seen, calls, h };
  }
  const pass = () => {};

  it('closes a move that switched the employee, reports the handoff as owed, types it, and only then calls them healthy', async () => {
    const m = await heldMove('published');
    const t = terminal();
    const o = office(m, t.session);
    const held = (await o.ports.openMove(o.employee))!;
    expect(held).toMatchObject({ phase: 'recovery-required', docker: true });
    expect(await o.ports.actions['abandon-move']!(o.employee, pass, held)).toMatchObject({ outcome: 'done' });

    // The move is closed and the employee is on the new session with a running laptop. That is not "healthy".
    const owed = await o.seen();
    expect(owed.move).toEqual({
      id: m.fx.record.id,
      docker: true,
      phase: 'handoff-owed',
      busy: false,
      allowedActions: [],
    });
    const said = classifyEmployee(owed);
    expect(said).toMatchObject({ condition: 'move-held-retryable', code: 'move-handoff-owed' });
    expect(said.sentence).toMatch(/the handoff of their plan move has not been typed there yet/);
    expect(t.state.typed).toEqual([]);

    // The step that is left of the move types the handoff. After it nothing is owed, and only now are they healthy.
    expect(await o.ports.actions['continue-move']!(o.employee, pass, owed.move as never)).toEqual({
      outcome: 'done',
      detail: 'handoff delivered ' + m.fx.record.id,
    });
    expect(t.state.typed).toEqual([m.text + '\r']);
    const after = await o.seen();
    expect(after.move).toBeUndefined();
    expect(classifyEmployee(after)).toMatchObject({ condition: 'healthy' });
    // The step is asked once more with the old observation: nothing is typed again.
    expect(await o.ports.actions['continue-move']!(o.employee, pass, owed.move as never)).toMatchObject({
      outcome: 'refused',
    });
    expect(t.state.typed).toHaveLength(1);
    expect(o.calls).toEqual([]);
  });

  it('goes on saying what is owed across office restarts until the handoff is typed', async () => {
    const m = await heldMove('published');
    const t = terminal();
    t.state.idle = false;
    const o = office(m, t.session);
    await o.ports.actions['abandon-move']!(o.employee, pass, (await o.ports.openMove(o.employee))!);
    // The agent is not at an empty composer: nothing is typed, and it stays owed.
    expect(await o.ports.actions['continue-move']!(o.employee, pass, (await o.seen()).move as never)).toMatchObject({
      outcome: 'busy',
    });
    // A new office process over the same files.
    const restarted = await (async () => {
      const store = new PlanMoveStore(join(directory, 'moves.json'));
      const moves = new PlanMoves({ load: () => store.load(), save: (records) => store.save(records) } as never);
      return office({ ...m, moves }, t.session);
    })();
    expect(classifyEmployee(await restarted.seen())).toMatchObject({ code: 'move-handoff-owed' });
    t.state.idle = true;
    expect(
      await restarted.ports.actions['continue-move']!(restarted.employee, pass, (await restarted.seen()).move as never)
    ).toMatchObject({ outcome: 'done' });
    expect(classifyEmployee(await restarted.seen())).toMatchObject({ condition: 'healthy' });
    expect(t.state.typed).toEqual([m.text + '\r']);
  });

  it('does not close such a move at all where the office could not type the handoff afterwards', async () => {
    const m = await heldMove('published');
    const t = terminal();
    const o = office(m, t.session, false);
    const held = (await o.ports.openMove(o.employee))!;
    expect(await o.ports.actions['abandon-move']!(o.employee, pass, held)).toEqual({
      outcome: 'refused',
      detail: 'the move has switched the employee to the new session and its handoff could not be typed afterwards',
    });
    expect(await m.moves.get(m.fx.record.id, m.employee.owner)).toMatchObject({ phase: 'recovery-required' });
  });

  it('closes a move that never switched the employee without owing anything', async () => {
    const m = await heldMove('unpublished');
    const t = terminal();
    const o = office(m, t.session, false);
    // The employee is still on the session they came from.
    const employee = { ...o.employee, sessionId: m.fx.record.oldSession };
    expect(await o.ports.actions['abandon-move']!(employee, pass, (await o.ports.openMove(o.employee))!)).toMatchObject(
      {
        outcome: 'done',
      }
    );
    expect(await office(m, t.session).ports.openMove(o.employee)).toBeUndefined();
  });

  it('says that a handoff of unknown outcome is not known, and has no step for it', async () => {
    const m = await heldMove('typing');
    const t = terminal();
    const o = office(m, t.session);
    await o.ports.actions['abandon-move']!(o.employee, pass, (await o.ports.openMove(o.employee))!);
    const seen = await o.seen();
    expect(seen.move).toMatchObject({ phase: 'handoff-unconfirmed' });
    expect(classifyEmployee(seen).sentence).toMatch(
      /nothing confirmed that it was submitted\. It is never typed twice\.$/
    );
    expect(t.state.typed).toEqual([]);
  });
});
