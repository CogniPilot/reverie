/** Coordinator/real private-file tests with an explicitly recording actor.
 * These tests never claim real Engine, account or paid-provider acceptance. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanMoves, type PlanMovePort, type PlanMoveInput } from '../src/plan-move.js';
import { PlanMoveStore, dockerPlanMoveNotIssuedOf } from '../src/plan-move-store.js';
import type { PlanMoveDockerActor, PlanMoveDockerJournal } from '../src/plan-move-docker.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { dockerPlanMaximumStates } from '../src/docker-plan-move-capacity.js';
import { dockerPlanMoveHandoffDigest } from '../src/docker-plan-move-data.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(forceBusy = false) {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-move-coordinator-'));
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
  let authorized = true,
    retained: PlanMoveDockerJournal | undefined;
  const actor: PlanMoveDockerActor = {
    current: vi.fn(() => {
      if (!authorized) throw Error('permission revoked');
    }),
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
    prepare: vi.fn(async (_record, journal) => {
      retained = journal;
      journal.current();
      const durable = await store.dockerRecord(input.id);
      expect(durable.newSession).toBe(f.targetSid);
      expect(durable.dockerSettlementBudget).toBeDefined();
    }),
    stopSource: vi.fn(async (_record, journal) => {
      const before = journal.read();
      await journal.publish(before, { ...before, sourceStop: { ...f.closed.sourceStop!, epoch: journal.epoch } });
    }),
    start: vi.fn(async (_record, journal) => {
      const before = journal.read(),
        maximum = dockerPlanMaximumStates(before.seed, before.epoch)[1]!;
      // Recording native state only; actual effects belong to the separate
      // Engine acceptance suite, never these synthetic descriptor values.
      await journal.publish(before, {
        ...maximum,
        sourceStop: before.sourceStop,
        sourceReader: undefined,
        companyPublication: undefined,
        handoff: undefined,
      });
    }),
    verify: vi.fn(async (_record, journal) => () => {
      journal.current();
    }),
    finalize: vi.fn(async (_record, journal) => {
      let before = journal.read();
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
    audit: vi.fn(async () => {}),
  };
  const moves = new PlanMoves(port);
  const settled = async () => {
    for (let i = 0; i < 150; i++) {
      const value = await moves.get(input.id, f.record.owner);
      if (
        value &&
        (value.phase === 'completed' || value.phase === 'failed' || value.allowedActions?.includes('continue-original'))
      )
        return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error('coordinator did not settle');
  };
  return {
    input,
    store,
    moves,
    port,
    actor,
    settled,
    view: () => retained!,
    revoke: () => {
      authorized = false;
    },
    owner: f.record.owner,
  };
}
describe('native plan coordinator with recording actor and actual protected journal', () => {
  it('releases a cancelled idle wait only after its effect-free failure is durably acknowledged', async () => {
    const f = await fixture();
    let waiting!: () => void;
    const entered = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    vi.mocked(f.actor.idle).mockImplementation(async (_record, _journal, signal) => {
      waiting();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    });
    await f.moves.begin(f.input, f.owner);
    await entered;
    await f.moves.cancel(f.input.id, f.owner);
    expect(await f.settled()).toMatchObject({ phase: 'failed', error: 'Move cancelled by the owner' });
    expect(await f.store.dockerRecord(f.input.id)).toMatchObject({ phase: 'failed' });
    await expect(f.moves.assertAvailable(f.input.employeeId)).resolves.toBeUndefined();
    expect(f.actor.prepare).not.toHaveBeenCalled();
    expect(f.actor.stopSource).not.toHaveBeenCalled();
    expect(f.actor.start).not.toHaveBeenCalled();
  });
  it('keeps cancellation held when its durable failure acknowledgement is lost', async () => {
    const f = await fixture();
    let waiting!: () => void;
    const entered = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    vi.mocked(f.actor.idle).mockImplementation(async (_record, _journal, signal) => {
      waiting();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    });
    const original = f.port.dockerJournal!.phase;
    f.port.dockerJournal!.phase = async (...args) => {
      const actual = await original(...args);
      if (args[2].phase === 'failed') throw Error('lost cancellation ACK');
      return actual;
    };
    await f.moves.begin(f.input, f.owner);
    await entered;
    await f.moves.cancel(f.input.id, f.owner);
    expect(await f.settled()).toMatchObject({ phase: 'recovery-required' });
    await expect(f.moves.assertAvailable(f.input.employeeId)).rejects.toThrow();
    expect(await f.store.dockerRecord(f.input.id)).toMatchObject({ phase: 'failed' });
    expect(f.actor.prepare).not.toHaveBeenCalled();
    expect(f.actor.stopSource).not.toHaveBeenCalled();
    expect(f.actor.start).not.toHaveBeenCalled();
  });
  it('binds an explicit source generation into the idempotent request instead of reusing another generation', async () => {
    const f = await fixture();
    vi.mocked(f.actor.prepare).mockRejectedValueOnce(Error('preflight held'));
    await f.moves.begin({ ...f.input, sessionGeneration: 1 }, f.owner);
    await f.settled();
    await expect(f.moves.begin({ ...f.input, sessionGeneration: 2 }, f.owner)).rejects.toThrow('another request');
    expect(f.actor.reserve).toHaveBeenCalledTimes(1);
    expect(f.actor.stopSource).not.toHaveBeenCalled();
  });
  it('reports a typed no-dispatch count-capacity refusal under the actual locked file despite a stale coordinator census', async () => {
    const f = await fixture();
    const history = Array.from({ length: 100 }, (_, i) => ({
      id: 'legacy-' + i,
      employeeId: 'history-' + i,
      name: 'Historical',
      oldSession: 'old-' + i,
      fromAccount: 'old',
      toAccount: 'other',
      phase: 'failed' as const,
      at: i,
    }));
    await f.store.save(history.slice(0, 99));
    await f.moves.list(f.owner);
    await f.store.save(history);
    let refusal: unknown;
    try {
      await f.moves.begin(f.input, f.owner);
    } catch (error) {
      refusal = error;
    }
    expect(dockerPlanMoveNotIssuedOf(refusal)).toMatchObject({
      id: f.input.id,
      employeeId: f.input.employeeId,
      sessionId: f.input.sessionId,
    });
    expect(await f.moves.get(f.input.id, f.owner)).toBeUndefined();
    await expect(f.moves.assertAvailable(f.input.employeeId)).resolves.toBeUndefined();
    expect(await f.store.load()).toHaveLength(100);
    expect(f.actor.prepare).not.toHaveBeenCalled();
    expect(f.actor.stopSource).not.toHaveBeenCalled();
  });
  it('continues original closed-source preparation without recapturing idle or stopping it again', async () => {
    const f = await fixture();
    vi.mocked(f.actor.start).mockRejectedValueOnce(Error('stopped before dispatch'));
    await f.moves.begin(f.input, f.owner);
    expect(await f.settled()).toMatchObject({ phase: 'recovery-required' });
    const original = await f.store.dockerRecord(f.input.id);
    expect(original.dockerReplacement?.sourceStop?.phase).toBe('closed');
    vi.mocked(f.actor.idle).mockRejectedValue(Error('a stopped source has no composer'));
    vi.mocked(f.actor.stopSource).mockImplementation(async (_record, journal) => {
      expect(journal.read().sourceStop?.phase).toBe('closed'); // read original effect; never issue another STOP
    });
    await f.moves.continueDocker(
      f.input.id,
      { oldSession: f.input.sessionId, newSession: original.newSession!, toAccount: f.input.toAccount },
      f.owner,
      f.port
    );
    expect(await f.settled()).toMatchObject({ phase: 'completed' });
    expect(f.actor.idle).toHaveBeenCalledTimes(1);
    expect(f.actor.requireContinuation).toHaveBeenCalled();
    expect(f.port.stop).not.toHaveBeenCalled();
  });
  it('settles a lost final write acknowledgement by fresh read-only inspection, without a second dispatch or handoff', async () => {
    const f = await fixture(),
      original = f.port.dockerJournal!.phase;
    let lose = true;
    f.port.dockerJournal!.phase = async (...args) => {
      const result = await original(...args);
      if (args[2].phase === 'completed' && lose) {
        lose = false;
        throw Error('lost final ACK');
      }
      return result;
    };
    await f.moves.begin(f.input, f.owner);
    expect(await f.settled()).toMatchObject({ phase: 'recovery-required', error: 'lost final ACK' });
    const durable = await f.store.dockerRecord(f.input.id);
    expect(durable.phase).toBe('completed');
    expect(() => f.view().current()).toThrow();
    await f.moves.continueDocker(
      f.input.id,
      { oldSession: f.input.sessionId, newSession: durable.newSession!, toAccount: f.input.toAccount },
      f.owner,
      f.port
    );
    expect(await f.settled()).toMatchObject({ phase: 'completed' });
    expect(f.actor.start).toHaveBeenCalledTimes(1);
    expect(f.actor.finalize).toHaveBeenCalledTimes(1);
    expect(f.actor.stopSource).toHaveBeenCalledTimes(1);
    expect(f.port.stop).not.toHaveBeenCalled();
    expect(await f.store.dockerRecord(f.input.id)).toEqual(durable);
  });
  it.each([false, true])('durably reserves before effects, force=%s, and never calls legacy cleanup', async (force) => {
    const f = await fixture(force);
    await f.moves.begin(f.input, f.owner);
    expect(await f.settled()).toMatchObject({ phase: 'completed', backend: 'docker' });
    expect(f.actor.idle).toHaveBeenCalledTimes(force ? 0 : 1);
    expect(f.actor.stopSource).toHaveBeenCalledTimes(1);
    expect(f.actor.start).toHaveBeenCalledTimes(1);
    expect(f.actor.verify).toHaveBeenCalledTimes(2);
    for (const key of ['create', 'start', 'stop', 'rebind'] as const) expect(f.port[key]).not.toHaveBeenCalled();
    expect(f.view().publication).toBe('published');
    const record = await f.store.dockerRecord(f.input.id);
    expect(record).toMatchObject({
      phase: 'completed',
      sourceStopRequested: true,
      sourceCleanupVerified: true,
      dockerReplacement: { handoff: { phase: 'submitted' } },
    });
    const data = await f.moves.get(f.input.id, f.owner);
    expect(data).not.toHaveProperty('dockerReplacement');
    expect(data).not.toHaveProperty('dockerSettlementBudget');
    f.revoke();
    expect(() => f.view().current()).not.toThrow(); // completed read lifetime is independent of requester grant
  });
  it('holds the original reservation on preparation failure without source stop or rollback', async () => {
    const f = await fixture();
    vi.mocked(f.actor.prepare).mockRejectedValueOnce(Error('preflight refused'));
    await f.moves.begin(f.input, f.owner);
    expect(await f.settled()).toMatchObject({
      phase: 'recovery-required',
      error: 'preflight refused',
      allowedActions: ['continue-original'],
    });
    expect(f.actor.stopSource).not.toHaveBeenCalled();
    expect(f.actor.start).not.toHaveBeenCalled();
    expect(f.port.rebind).not.toHaveBeenCalled();
    expect(f.port.stop).not.toHaveBeenCalled();
    expect((await f.store.dockerRecord(f.input.id)).dockerReplacement?.seed.moveId).toBe(f.input.id);
  });
  it('rechecks native authority after the slow stop audit before any source effect', async () => {
    const f = await fixture();
    vi.mocked(f.port.audit).mockImplementation(async (record) => {
      if (record.phase === 'stopping') f.revoke();
    });
    await f.moves.begin(f.input, f.owner);
    expect(await f.settled()).toMatchObject({ phase: 'recovery-required', error: 'permission revoked' });
    expect(f.actor.stopSource).not.toHaveBeenCalled();
    expect(f.actor.start).not.toHaveBeenCalled();
    expect(f.view().publication).toBe('failed');
    expect(() => f.view().current()).toThrow();
  });
  it('rejects asynchronous verification fences without finalize or another paid start', async () => {
    const f = await fixture();
    vi.mocked(f.actor.verify).mockResolvedValueOnce((() => Promise.resolve()) as () => void);
    await f.moves.begin(f.input, f.owner);
    expect(await f.settled()).toMatchObject({
      phase: 'recovery-required',
      error: expect.stringContaining('synchronous'),
    });
    expect(f.actor.start).toHaveBeenCalledTimes(1);
    expect(f.actor.finalize).not.toHaveBeenCalled();
    expect(f.port.stop).not.toHaveBeenCalled();
  });
});
