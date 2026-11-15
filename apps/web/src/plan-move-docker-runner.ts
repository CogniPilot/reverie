/** The native move owns its own journal and effects. The legacy session
 * cleanup/rebind path is never a fallback for a boxed worker. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { DockerPlanMoveJournalState } from './docker-plan-move-data.js';
import type { PlanMoveDockerJournal, PlanMoveDockerJournalStore } from './plan-move-docker.js';
import {
  PlanMoveComposerNotReady,
  PlanMoveError,
  type PlanMoveInput,
  type PlanMoveRecord,
  type PlanMoveExecutor,
} from './plan-move.js';
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child) => frozen(child));
    Object.freeze(value);
  }
  return value;
}
export async function reserveDockerPlanMove(
  record: PlanMoveRecord,
  input: PlanMoveInput,
  executor: PlanMoveExecutor,
  store: PlanMoveDockerJournalStore | undefined
): Promise<void> {
  const actor = executor.dockerReplacement;
  if (!actor || !store) throw new PlanMoveError('The Docker plan transaction is unavailable', 503);
  if (input.resourceIntent || input.purpose)
    throw new PlanMoveError('Docker plan moves cannot inherit a resource transaction');
  const seed = await actor.reserve(frozen(structuredClone(input)), record.owner, record.requestDigest!);
  const state = DockerPlanMoveJournalState.parse({
    version: 1,
    purpose: 'docker-plan-replacement-v1',
    epoch: randomUUID(),
    seed,
  });
  if (
    seed.moveId !== record.id ||
    seed.requestDigest !== record.requestDigest ||
    seed.source.record.employeeId !== record.employeeId ||
    seed.source.record.owner !== record.owner ||
    seed.source.binding.sessionId !== record.oldSession ||
    seed.target.accountId !== record.toAccount ||
    seed.forceBusy !== input.forceBusy ||
    seed.handoff !== input.handoff
  )
    throw new PlanMoveError('The Docker reservation changed the approved move');
  record.newSession = seed.target.sessionId;
  record.dockerReplacement = state;
}
export interface DockerPlanMoveFlight {
  /** Exact in-memory original owner. No native effect authority is conferred. */
  current(): void;
  signal: AbortSignal;
}
function checkedFence(fence: unknown): () => void {
  if (typeof fence !== 'function') throw new PlanMoveError('Native plan verification is unavailable');
  return () => {
    const result: unknown = fence();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw new PlanMoveError('Native plan verification requires a synchronous fence');
    }
  };
}
export async function runDockerPlanMove(
  record: PlanMoveRecord,
  executor: PlanMoveExecutor,
  store: PlanMoveDockerJournalStore,
  flight: DockerPlanMoveFlight,
  mode: 'new' | 'continue' | 'adopt' | 'reconcile' = 'new'
): Promise<void> {
  const actor = executor.dockerReplacement;
  if (!actor || !record.dockerReplacement) throw new PlanMoveError('The original Docker actor is unavailable', 503);
  let cursor = DockerPlanMoveJournalState.parse(record.dockerReplacement);
  const seedDigest = dockerContinuationDigest(cursor.seed);
  let publication: PlanMoveDockerJournal['publication'] = 'admitting';
  const stable = () => {
    if (publication === 'failed') throw new PlanMoveError('The Docker move requires original recovery');
    flight.current();
    if (dockerContinuationDigest(cursor.seed) !== seedDigest)
      throw new PlanMoveError('The original Docker seed changed');
    if (publication === 'admitting') actor.current(record, cursor);
  };
  const adopt = (next: Readonly<PlanMoveRecord>) => {
    if (
      !next.dockerReplacement ||
      next.id !== record.id ||
      next.requestDigest !== record.requestDigest ||
      dockerContinuationDigest(next.dockerReplacement.seed) !== seedDigest
    )
      throw new PlanMoveError('The original Docker journal changed');
    for (const key of [
      'error',
      'recoveryAction',
      'recoveredAt',
      'sourceStopRequested',
      'sourceCleanupVerified',
      'backend',
      'allowedActions',
    ] as const)
      if (!Object.hasOwn(next, key)) delete record[key];
    Object.assign(record, structuredClone(next));
    cursor = DockerPlanMoveJournalState.parse(next.dockerReplacement);
  };
  const journal: PlanMoveDockerJournal = Object.freeze({
    moveId: record.id,
    get epoch() {
      return cursor.epoch;
    },
    get publication() {
      return publication;
    },
    current: () => {
      stable();
      if (publication === 'admitting') {
        if (mode === 'reconcile') store.readCurrent(record.id, cursor.epoch, seedDigest);
        else store.current(record.id, cursor.epoch, seedDigest);
      }
    },
    read: () => frozen(structuredClone(cursor)),
    publish: async (before, next) => {
      if (mode === 'reconcile') throw new PlanMoveError('Terminal Docker recovery is read-only');
      journal.current();
      if (dockerContinuationDigest(before) !== dockerContinuationDigest(cursor))
        throw new PlanMoveError('The native cursor changed');
      adopt(await store.publish(record.id, before, next, stable));
      journal.current();
    },
  } satisfies PlanMoveDockerJournal);
  const phase = async (value: PlanMoveRecord['phase']) => {
    if (mode === 'reconcile') throw new PlanMoveError('Terminal Docker history is immutable');
    journal.current();
    // The store itself rechecks the original cursor under its checked lock.
    // Stable authority must survive this call's own final phase publication.
    const result = await store.phase(record.id, cursor, { phase: value }, stable);
    adopt(result);
    if (value === 'completed') publication = 'published';
    stable();
  };
  // Only a genuine, positively observed pending composer permits another read.
  // Unknown native outcomes never retry STOP, CREATE, START or the work handoff.
  const readyRead = async <T>(read: () => Promise<T>): Promise<T> => {
    const deadline = performance.now() + 120_000;
    for (;;) {
      journal.current();
      flight.signal.throwIfAborted();
      try {
        const result = await read();
        journal.current();
        flight.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (!(error instanceof PlanMoveComposerNotReady) || performance.now() >= deadline) throw error;
        journal.current();
        await delay(1000, undefined, { signal: flight.signal });
      }
    }
  };
  try {
    if (mode !== 'new') {
      // A new HTTP request earns an actual original native proof before the
      // atomic epoch takeover. Issued paid work never enters this path.
      const proof = await readyRead(() => actor.inspectForContinuation(record, journal));
      if (mode === 'continue') {
        actor.requireContinuation(proof, cursor);
        adopt(
          await store.claim(record.id, cursor, randomUUID(), () => actor.requireContinuation(proof, cursor), stable)
        );
      } else if (!cursor.paidDispatch) throw new PlanMoveError('No issued provider exists to inspect');
    }
    if (mode === 'reconcile') {
      if (
        cursor.work?.phase !== 'ready' ||
        cursor.companyPublication?.phase !== 'published' ||
        cursor.handoff?.phase !== 'submitted'
      )
        throw new PlanMoveError('Completed Docker history is inconsistent');
      const fence = checkedFence(await readyRead(() => actor.verify(record, journal)));
      fence();
      journal.current();
      record.phase = 'completed';
      delete record.error;
      publication = 'published';
      stable();
      return;
    }
    journal.current();
    if (mode !== 'adopt') {
      if (!cursor.seed.forceBusy && !cursor.sourceStop) await actor.idle(record, journal, flight.signal);
      flight.signal.throwIfAborted();
      await phase('creating');
      await actor.prepare(record, journal);
      journal.current();
      await executor.audit({ ...record, phase: 'stopping' });
      journal.current();
      flight.signal.throwIfAborted();
      await phase('stopping');
      await actor.stopSource(record, journal);
      journal.current();
      await phase('starting');
      await actor.start(record, journal);
      journal.current();
    }
    await phase('checking');
    let fence = checkedFence(await readyRead(() => actor.verify(record, journal)));
    fence();
    await actor.finalize(record, journal);
    journal.current();
    // Finalize publishes the binding and submits its once-only work handoff.
    // Re-earn the actual running placement after those asynchronous effects.
    fence = checkedFence(await readyRead(() => actor.verify(record, journal)));
    fence();
    await executor.audit({ ...record, phase: 'completed' });
    journal.current();
    fence();
    await phase('completed');
  } catch (error) {
    publication = 'failed';
    const cancelledBeforeEffects =
      flight.signal.aborted &&
      record.phase === 'waiting' &&
      !cursor.sourceStop &&
      !cursor.sourceReader &&
      !cursor.work &&
      !cursor.paidDispatch &&
      !cursor.companyPublication &&
      !cursor.handoff;
    const message = (error instanceof Error ? error.message : 'Docker plan move failed').slice(0, 4000);
    record.phase = 'recovery-required';
    record.error = message;
    try {
      // Denial-only settlement does not revive a revoked requester or authorize
      // further effects. Exact-before CAS still excludes another actor's cursor.
      adopt(
        await store.phase(
          record.id,
          cursor,
          { phase: cancelledBeforeEffects ? 'failed' : 'recovery-required', error: message },
          () => flight.current()
        )
      );
    } catch {
      /* the original disk outcome is uncertain; keep the in-memory hold */
    }
  }
}
