/** A shared pool cold-start cursor survives a console restart or rollback.
 * An incomplete attempt remains held until it is finished as itself: either an
 * observed, published pool closes it, or it is recorded as ended once it is
 * proved that it can write nothing more. Completed records remain available
 * for later diagnosis. */
import { renameSync } from 'node:fs';
import { z } from 'zod';
import { withCanonicalStateLock } from './canonical-state-lock.js';
import {
  DockerContinuationTask,
  allowedDockerTaskTransition,
  type DockerContinuationTaskJournal,
} from './docker-continuation-task.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import {
  appendDockerPrivateJournal,
  readDockerPrivateJournal,
  type DockerPrivateJournalRefusals,
} from './docker-private-journal.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z
  .object({
    operationId: z.string().uuid(),
    employeeId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionGeneration: z.number().int().positive().safe(),
    scopeDigest: digest,
  })
  .strict();
export type DockerColdPoolScope = z.infer<typeof scope>;
const journalEntry = z
  .object({
    scope,
    task: DockerContinuationTask.refine((task) => task.role === 'pool-helper').optional(),
    /** Reached only after the canonical company writer published this ACK. */
    observationDigest: digest.optional(),
    /** The attempt confirmed nothing and can write nothing more: its helper is terminal or was never created. */
    ended: z.literal(true).optional(),
  })
  .strict()
  .refine((entry) => entry.observationDigest === undefined || entry.task?.phase === 'completed')
  .refine((entry) => !entry.ended || entry.observationDigest === undefined);
type Entry = z.infer<typeof journalEntry>;
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
const refusals: DockerPrivateJournalRefusals = {
  unconfirmed: () => refuse('DOCKER_POOL_COLD_JOURNAL_UNCONFIRMED'),
  full: () => refuse('DOCKER_POOL_COLD_JOURNAL_FULL'),
};
/** Nothing more will be issued for it. */
const finished = (entry: Entry | undefined): boolean => !entry || !!entry.observationDigest || entry.ended === true;

/** What a caller that continues or issues an attempt is given: its one helper cursor and its two endings. */
export interface DockerColdPoolAttempt {
  readonly scope: DockerColdPoolScope;
  readonly journal: DockerContinuationTaskJournal;
  /** The published observation closes the attempt. */
  confirm(observationDigest: string): void;
  /** Closes an attempt that confirmed nothing. The caller proves that it can write nothing more. */
  end(): void;
}

export class DockerColdPoolJournal {
  constructor(private readonly path: string) {}

  #entries(): Entry[] {
    return readDockerPrivateJournal(this.path, refusals).map((line) => journalEntry.parse(JSON.parse(line)));
  }

  #append(entry: Entry, current: () => void, first = false): void {
    const line = JSON.stringify(journalEntry.parse(entry)) + '\n';
    current();
    try {
      appendDockerPrivateJournal(this.path, line, refusals);
    } catch (error) {
      // Only the first line of a new attempt may start a new file, and only
      // when every attempt in the full one is finished. That file is set aside
      // whole; an open attempt is never moved.
      if (
        !first ||
        !(error instanceof DockerEmployeeContinuationError) ||
        error.code !== 'DOCKER_POOL_COLD_JOURNAL_FULL' ||
        !finished(this.#entries().at(-1))
      )
        throw error;
      renameSync(this.path, this.path + '.previous');
      appendDockerPrivateJournal(this.path, line, refusals);
    }
  }

  requireIdle(): void {
    if (!finished(this.#entries().at(-1))) refuse('DOCKER_POOL_COLD_ATTEMPT_HELD');
  }

  /** The one unfinished attempt, when there is one. DATA only. */
  held(): DockerColdPoolScope | undefined {
    const last = this.#entries().at(-1);
    return finished(last) ? undefined : last!.scope;
  }

  /** The attempt's cursor over `entry`, the journal's last line. Every append proves it is still the last. */
  #attempt(first: Entry, current: () => void): DockerColdPoolAttempt {
    let entry = first;
    const append = (next: Entry) => {
      current();
      if (
        finished(entry) ||
        dockerContinuationDigest(this.#entries().at(-1) ?? null) !== dockerContinuationDigest(entry)
      )
        refuse('DOCKER_POOL_COLD_JOURNAL_CHANGED');
      this.#append(next, current);
      entry = next;
    };
    const journal: DockerContinuationTaskJournal = {
      read: (_row, role) => (role === 'pool-helper' ? entry.task : undefined),
      publish: async (row, before, next, admitted) => {
        admitted();
        if (
          next.role !== 'pool-helper' ||
          !allowedDockerTaskTransition(before, next) ||
          dockerContinuationDigest(before ?? null) !== dockerContinuationDigest(entry.task ?? null)
        )
          refuse('DOCKER_POOL_COLD_JOURNAL_CHANGED');
        append({ ...entry, task: next });
        return row;
      },
    };
    return {
      scope: entry.scope,
      journal,
      confirm: (observationDigest) => append({ ...entry, observationDigest }),
      end: () => append({ ...entry, ended: true }),
    };
  }

  async issue<T>(
    selected: DockerColdPoolScope,
    current: () => void,
    recover: (journal: DockerContinuationTaskJournal, confirm: (observationDigest: string) => void) => Promise<T>
  ): Promise<T> {
    const input = scope.parse(structuredClone(selected));
    return withCanonicalStateLock(this.path, async () => {
      current();
      const prior = this.#entries();
      if (!finished(prior.at(-1))) refuse('DOCKER_POOL_COLD_ATTEMPT_HELD');
      // An attempt that ended without confirming anything changed nothing that lasts. When every native fact is
      // again exactly what it was issued for, the same scope may be issued once more, under a new operation.
      const latest = new Map(prior.map((entry) => [entry.scope.operationId, entry]));
      if (
        latest.has(input.operationId) ||
        [...latest.values()].some((entry) => entry.scope.scopeDigest === input.scopeDigest && !entry.ended)
      )
        refuse('DOCKER_POOL_COLD_ALREADY_ISSUED');
      const entry: Entry = { scope: input };
      this.#append(entry, current, true);
      const attempt = this.#attempt(entry, current);
      return recover(attempt.journal, attempt.confirm);
    });
  }

  /** Continues the one unfinished attempt as itself: the same operation, scope and helper cursor. Nothing is
   * appended here; `finish` decides from fresh reads what is left of it, and ends it one of the two ways. */
  async resume<T>(current: () => void, finish: (attempt: DockerColdPoolAttempt) => Promise<T>): Promise<T> {
    return withCanonicalStateLock(this.path, async () => {
      current();
      const last = this.#entries().at(-1);
      if (!last || finished(last)) refuse('DOCKER_POOL_COLD_ATTEMPT_ABSENT');
      return finish(this.#attempt(last, current));
    });
  }
}
