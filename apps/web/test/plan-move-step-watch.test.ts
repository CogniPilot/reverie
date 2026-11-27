/**
 * The step watch of a laptop plan move: a step that never returns, or never ends, leaves the move held as an office
 * restart would, and nothing is repeated. A recording actor over the real private journal; no Engine, no provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PlanMoves, type PlanMoveInput, type PlanMovePort, type PlanMoveStepLimits } from '../src/plan-move.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import type { PlanMoveDockerActor, PlanMoveDockerJournal } from '../src/plan-move-docker.js';
import { dockerPlanMaximumStates } from '../src/docker-plan-move-capacity.js';
import { dockerPlanMoveHandoffDigest } from '../src/docker-plan-move-data.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/**
 * Short enough to test with real time: a step is given up after 150 ms of silence and released 100 ms later. Only the
 * step a test means to stall runs under it. A test that then continues the move calls `relax()` first, so that the
 * healthy steps after it are not taken for stalled on a loaded machine (a continue writes the journal several times).
 */
const QUICK: PlanMoveStepLimits = {
  stallMs: 150,
  phaseMs: { waiting: 60_000, creating: 60_000, stopping: 60_000, starting: 60_000, checking: 60_000 },
  graceMs: 100,
  checkMs: 20,
};
/**
 * For a test whose healthy steps must all come back in time while one step never does: the stall bound is long enough
 * that no healthy step on a loaded machine reaches it (a whole healthy move takes well under a second here, two seconds
 * under heavy load), and short enough for the test to see the one that never returns.
 */
const PATIENT: PlanMoveStepLimits = { ...QUICK, stallMs: 3_000 };
/** A wait that never returns until the test lets it. */
function stuck() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function fixture(limits: PlanMoveStepLimits = QUICK, forceBusy = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'plan-move-step-watch-'));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const f = dockerPlanJournalFixture(),
    store = new PlanMoveStore(join(root, 'moves.json'));
  const input: PlanMoveInput = {
    id: f.record.id,
    employeeId: f.record.employeeId,
    sessionId: f.record.oldSession,
    fromAccount: f.record.fromAccount,
    toAccount: f.record.toAccount,
    forceBusy,
    handoff: f.state.seed.handoff,
  };
  /** The provider launch the move records before it issues it, as the real actor does. */
  const recordLaunch = async (journal: PlanMoveDockerJournal) => {
    const before = journal.read(),
      maximum = dockerPlanMaximumStates(before.seed, before.epoch)[1]!;
    await journal.publish(before, {
      ...maximum,
      sourceStop: before.sourceStop,
      sourceReader: undefined,
      companyPublication: undefined,
      handoff: undefined,
    });
  };
  const actor: PlanMoveDockerActor = {
    current: vi.fn(() => {}),
    snapshot: vi.fn(async () => ({
      backend: 'docker' as const,
      sessionId: input.sessionId,
      sessionGeneration: 1,
      name: f.record.name,
      account: input.fromAccount,
      working: forceBusy,
    })),
    reserve: vi.fn(async (_input, _owner, requestDigest) => ({ ...f.state.seed, forceBusy, requestDigest })),
    idle: vi.fn(async () => {}),
    prepare: vi.fn(async (_record, journal) => journal.current()),
    stopSource: vi.fn(async (_record, journal) => {
      const before = journal.read();
      await journal.publish(before, { ...before, sourceStop: { ...f.closed.sourceStop!, epoch: journal.epoch } });
    }),
    start: vi.fn(async (_record, journal) => recordLaunch(journal)),
    verify: vi.fn(async (_record, journal) => () => {
      journal.current();
    }),
    finalize: vi.fn(async (_record, journal) => {
      let before = journal.read();
      if (before.handoff?.phase === 'submitted') return;
      await journal.publish(before, { ...before, companyPublication: { phase: 'issued', digest: 'a'.repeat(64) } });
      before = journal.read();
      await journal.publish(before, { ...before, companyPublication: { phase: 'published', digest: 'a'.repeat(64) } });
      before = journal.read();
      await journal.publish(before, {
        ...before,
        handoff: { phase: 'issued', digest: dockerPlanMoveHandoffDigest(before.seed.handoff) },
      });
      before = journal.read();
      await journal.publish(before, { ...before, handoff: { ...before.handoff!, phase: 'submitted' } });
    }),
    inspectForContinuation: vi.fn(async () => ({ recording: true })),
    requireContinuation: vi.fn(() => {}),
  };
  const unexpected = () => {
    throw Error('legacy effect forbidden');
  };
  const audits: Array<{ phase: string; error?: string }> = [];
  const port: PlanMovePort = {
    load: () => store.load(),
    save: (records) => store.save(records),
    dockerJournal: {
      reserve: (...args) => store.dockerReserve(...args),
      readCurrent: (...args) => store.dockerReadCurrent(...args),
      record: (id) => store.dockerRecord(id),
      current: (...args) => store.dockerCurrent(...args),
      publish: (...args) => store.dockerPublish(...args),
      claim: (...args) => store.dockerClaim(...args),
      phase: (...args) => store.dockerPhase(...args),
      abandonOwner: (...args) => store.abandonOwnerDockerMove(...args),
    },
    dockerReplacement: actor,
    snapshot: actor.snapshot,
    idle: vi.fn(unexpected),
    create: vi.fn(unexpected),
    start: vi.fn(unexpected),
    ready: vi.fn(unexpected),
    beforeStop: vi.fn(unexpected),
    binding: () => input.sessionId,
    exists: () => true,
    rebind: vi.fn(unexpected),
    stop: vi.fn(unexpected),
    audit: vi.fn(async (record) => {
      audits.push({ phase: record.phase, ...(record.error ? { error: record.error } : {}) });
    }),
  };
  // The service reads its limits at every look, so a test can relax them once the stall it wanted has happened.
  const live: { stallMs: number; graceMs: number; checkMs: number; phaseMs: Record<string, number> } = {
    stallMs: limits.stallMs,
    graceMs: limits.graceMs,
    checkMs: limits.checkMs,
    phaseMs: { ...limits.phaseMs } as Record<string, number>,
  };
  const relax = () => {
    live.stallMs = 60_000;
    for (const phase of Object.keys(live.phaseMs)) live.phaseMs[phase] = 60_000;
  };
  const moves = new PlanMoves(port, live);
  const owner = f.record.owner;
  /** Wait until the move is held, closed or completed. */
  const settled = async () => {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const value = await moves.get(input.id, owner);
      if (
        value &&
        (['completed', 'failed'].includes(value.phase) || value.allowedActions?.includes('continue-original'))
      )
        return value;
      await delay(10);
    }
    throw Error('the move did not settle');
  };
  const resume = async () => {
    const durable = await store.dockerRecord(input.id);
    return moves.continueDocker(
      input.id,
      { oldSession: input.sessionId, newSession: durable.newSession!, toAccount: input.toAccount },
      owner,
      port
    );
  };
  return { f, input, store, moves, port, actor, audits, owner, settled, resume, recordLaunch, relax };
}

describe('the step watch of a laptop plan move', () => {
  it('holds a move whose step never returns, as an office restart would, and says that its outcome is not known', async () => {
    const t = await fixture();
    const hang = stuck();
    t.actor.stopSource = vi.fn(async () => hang.wait);
    await t.moves.begin(t.input, t.owner);
    const held = await t.settled();
    expect(held).toMatchObject({ phase: 'recovery-required', allowedActions: ['continue-original', 'abandon'] });
    expect(held.error).toMatch(/^The office stopped waiting for this move in its “stopping” step: nothing came back/);
    expect(held.error).toMatch(/How far that step got is not known\. The move is held .* nothing was repeated\.$/);
    // The hold is in the journal, with the cursor the step last wrote and nothing else.
    const durable = await t.store.dockerRecord(t.input.id);
    expect(durable).toMatchObject({ phase: 'recovery-required', error: held.error });
    expect(durable.dockerReplacement!.sourceStop).toBeUndefined();
    // It still locks the employee, like any held move, and the audit says what happened.
    await expect(t.moves.assertAvailable(t.input.employeeId, t.owner)).rejects.toMatchObject({
      blocker: { id: t.input.id, action: 'inspect-existing' },
    });
    await vi.waitFor(() => expect(t.audits.at(-1)).toMatchObject({ phase: 'recovery-required', error: held.error }));
    expect(t.actor.start).not.toHaveBeenCalled();
    hang.release();
  });

  it('gives the stuck step nothing to do when it comes back: no checkpoint passes and nothing is written', async () => {
    const t = await fixture();
    const hang = stuck();
    let late: PlanMoveDockerJournal | undefined;
    const after: string[] = [];
    t.actor.stopSource = vi.fn(async (_record, journal) => {
      late = journal;
      await hang.wait;
      // What a real step does next: pass its checkpoint, then record its effect.
      try {
        journal.current();
        after.push('checkpoint passed');
      } catch (error) {
        after.push((error as Error).message);
      }
      const before = journal.read();
      await journal.publish(before, { ...before, sourceStop: { ...t.f.closed.sourceStop!, epoch: journal.epoch } });
      after.push('published');
    });
    await t.moves.begin(t.input, t.owner);
    const held = await t.settled();
    const durable = await t.store.dockerRecord(t.input.id);
    hang.release();
    await delay(100);
    expect(after).toEqual(['The original Docker move flight changed']);
    expect(() => late!.current()).toThrow();
    expect(await t.store.dockerRecord(t.input.id)).toEqual(durable);
    expect(await t.moves.get(t.input.id, t.owner)).toMatchObject({ phase: 'recovery-required', error: held.error });
    expect(t.actor.start).not.toHaveBeenCalled();
  });

  it('never repeats a provider launch whose outcome is unknown: the continue only reads and finishes', async () => {
    const t = await fixture();
    const hang = stuck();
    // The launch intent is in the journal; the launch itself never returns.
    t.actor.start = vi.fn(async (_record, journal) => {
      await t.recordLaunch(journal);
      await hang.wait;
    });
    await t.moves.begin(t.input, t.owner);
    const held = await t.settled();
    expect(held.error).toMatch(/in its “starting” step/);
    const durable = await t.store.dockerRecord(t.input.id);
    expect(durable).toMatchObject({ phase: 'recovery-required' });
    expect(durable.dockerReplacement!.paidDispatch).toMatchObject({ phase: 'issued' });
    // The supervisor's ordinary next step. With a launch on record it inspects and verifies; it does not start.
    t.relax();
    await t.resume();
    expect(await t.settled()).toMatchObject({ phase: 'completed' });
    expect(t.actor.start).toHaveBeenCalledTimes(1);
    expect(t.actor.stopSource).toHaveBeenCalledTimes(1);
    expect(t.actor.requireContinuation).not.toHaveBeenCalled();
    expect((await t.store.dockerRecord(t.input.id)).dockerReplacement!.paidDispatch).toEqual(
      durable.dockerReplacement!.paidDispatch
    );
    // The first step comes back after the move has finished: it changes nothing.
    const finished = await t.store.dockerRecord(t.input.id);
    hang.release();
    await delay(100);
    expect(await t.store.dockerRecord(t.input.id)).toEqual(finished);
    expect(await t.moves.get(t.input.id, t.owner)).toMatchObject({ phase: 'completed' });
  });

  it('lets a step that is waiting in a loop end by itself, and holds the move instead of closing it', async () => {
    const t = await fixture(QUICK, false);
    // The wait for the employee honours the abort signal, as the real one does. Nothing has been issued yet.
    t.actor.idle = vi.fn(async (_record, _journal, signal) => {
      await delay(60_000, undefined, { signal });
    });
    await t.moves.begin(t.input, t.owner);
    const held = await t.settled();
    // A cancellation in this phase closes the move as failed. A step the watch gave up is not a cancellation.
    expect(held).toMatchObject({ phase: 'recovery-required', allowedActions: ['continue-original', 'abandon'] });
    expect(held.error).toMatch(/in its “waiting” step: nothing came back/);
    expect(await t.store.dockerRecord(t.input.id)).toMatchObject({ phase: 'recovery-required', error: held.error });
    expect(t.actor.prepare).not.toHaveBeenCalled();
  });

  it('still closes a move the owner cancels while it waits for the employee', async () => {
    const t = await fixture({ ...QUICK, stallMs: 60_000 }, false);
    t.actor.idle = vi.fn(async (_record, _journal, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    });
    await t.moves.begin(t.input, t.owner);
    await vi.waitFor(() => expect(t.actor.idle).toHaveBeenCalled());
    await t.moves.cancel(t.input.id, t.owner);
    expect(await t.settled()).toMatchObject({ phase: 'failed', error: 'Move cancelled by the owner' });
  });

  it('stops a step that keeps passing checkpoints and never ends, once its phase has lasted too long', async () => {
    const t = await fixture({ ...QUICK, stallMs: 60_000, phaseMs: { ...QUICK.phaseMs, creating: 150 } });
    let passes = 0,
      ended = '';
    t.actor.prepare = vi.fn(async (_record, journal) => {
      try {
        for (;;) {
          journal.current();
          passes++;
          await delay(10);
        }
      } catch (error) {
        ended = (error as Error).message;
        throw error;
      }
    });
    await t.moves.begin(t.input, t.owner);
    const held = await t.settled();
    expect(held).toMatchObject({ phase: 'recovery-required' });
    expect(held.error).toMatch(/in its “creating” step: that had lasted \d+ minutes?\./);
    await vi.waitFor(() => expect(ended).toBe('The original Docker move flight changed'));
    const seen = passes;
    await delay(60);
    expect(passes).toBe(seen);
    expect(await t.moves.get(t.input.id, t.owner)).toMatchObject({ phase: 'recovery-required', error: held.error });
    expect(t.actor.stopSource).not.toHaveBeenCalled();
  });

  it('leaves the ordinary ways out open: a held move can be continued to the end, or abandoned', async () => {
    const t = await fixture();
    const hang = stuck();
    t.actor.stopSource = vi.fn(async () => hang.wait);
    await t.moves.begin(t.input, t.owner);
    await t.settled();
    // Continue: a new flight takes the journal over under a new epoch and runs the move to its end.
    t.actor.stopSource = vi.fn(async (_record, journal) => {
      const before = journal.read();
      await journal.publish(before, { ...before, sourceStop: { ...t.f.closed.sourceStop!, epoch: journal.epoch } });
    });
    const epoch = (await t.store.dockerRecord(t.input.id)).dockerReplacement!.epoch;
    t.relax();
    await t.resume();
    expect(await t.settled()).toMatchObject({ phase: 'completed' });
    expect((await t.store.dockerRecord(t.input.id)).dockerReplacement!.epoch).not.toBe(epoch);
    hang.release();

    const other = await fixture();
    const second = stuck();
    other.actor.stopSource = vi.fn(async () => second.wait);
    await other.moves.begin(other.input, other.owner);
    await other.settled();
    await expect(
      other.moves.abandonHeldDockerMove(other.input.id, other.input.employeeId, other.owner)
    ).resolves.toMatchObject({ phase: 'failed', dockerAbandonment: { reason: 'owner-abandoned' } });
    await expect(other.moves.assertAvailable(other.input.employeeId, other.owner)).resolves.toBeUndefined();
    second.release();
  });

  it('keeps a finished move finished when only the retirement of its old terminal never returns', async () => {
    const t = await fixture(PATIENT);
    const hang = stuck();
    t.actor.retireSource = vi.fn(async () => hang.wait);
    await t.moves.begin(t.input, t.owner);
    const done = await t.settled();
    expect(done).toMatchObject({ phase: 'completed', allowedActions: ['continue-original'] });
    expect(done.sourceViewRetirement).toMatchObject({ state: 'unconfirmed' });
    expect(done.sourceViewRetirement!.error).toMatch(/while the old terminal of the finished move was being retired/);
    expect(await t.store.dockerRecord(t.input.id)).toMatchObject({ phase: 'completed' });
    await expect(t.moves.assertAvailable(t.input.employeeId, t.owner)).resolves.toBeUndefined();
    hang.release();
  });

  it('holds the move in memory when the journal itself does not answer', async () => {
    const t = await fixture();
    const hang = stuck(),
      journal = stuck();
    t.actor.stopSource = vi.fn(async () => hang.wait);
    const record = t.port.dockerJournal!.record;
    let silent = false;
    t.port.dockerJournal!.record = async (id) => {
      if (silent) await journal.wait;
      return record(id);
    };
    await t.moves.begin(t.input, t.owner);
    await vi.waitFor(() => expect(t.actor.stopSource).toHaveBeenCalled());
    silent = true;
    const held = await t.settled();
    expect(held).toMatchObject({ phase: 'recovery-required', allowedActions: ['continue-original', 'abandon'] });
    expect(held.error).toMatch(/^The office stopped waiting for this move/);
    // The journal still shows the step's phase, which is what a restart would read and hold.
    silent = false;
    expect(await t.store.dockerRecord(t.input.id)).toMatchObject({ phase: 'stopping' });
    // The late answer changes nothing in memory.
    journal.release();
    hang.release();
    await delay(100);
    expect(await t.moves.get(t.input.id, t.owner)).toMatchObject({ phase: 'recovery-required', error: held.error });
  });

  it('does not touch a move whose steps come back in time', async () => {
    const t = await fixture(PATIENT);
    t.actor.stopSource = vi.fn(async (_record, journal) => {
      // Slower than the watch looks (every 20 ms), faster than it gives up.
      await delay(60);
      const before = journal.read();
      await journal.publish(before, { ...before, sourceStop: { ...t.f.closed.sourceStop!, epoch: journal.epoch } });
    });
    await t.moves.begin(t.input, t.owner);
    expect(await t.settled()).toMatchObject({ phase: 'completed' });
    expect(t.audits.map((entry) => entry.phase)).toEqual(['stopping', 'completed']);
  });
});
