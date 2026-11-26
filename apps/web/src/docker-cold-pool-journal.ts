/** A shared pool cold-start cursor survives a console restart or rollback.
 * An incomplete attempt remains held. Only an observed, published pool can
 * close it, and completed records remain available for later diagnosis. */
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
  })
  .strict()
  .refine((entry) => entry.observationDigest === undefined || entry.task?.phase === 'completed');
type Entry = z.infer<typeof journalEntry>;
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
const refusals: DockerPrivateJournalRefusals = {
  unconfirmed: () => refuse('DOCKER_POOL_COLD_JOURNAL_UNCONFIRMED'),
  full: () => refuse('DOCKER_POOL_COLD_JOURNAL_FULL'),
};

export class DockerColdPoolJournal {
  constructor(private readonly path: string) {}

  #entries(): Entry[] {
    return readDockerPrivateJournal(this.path, refusals).map((line) => journalEntry.parse(JSON.parse(line)));
  }

  #append(entry: Entry, current: () => void): void {
    const line = JSON.stringify(journalEntry.parse(entry)) + '\n';
    current();
    appendDockerPrivateJournal(this.path, line, refusals);
  }

  requireIdle(): void {
    const last = this.#entries().at(-1);
    if (last && !last.observationDigest) refuse('DOCKER_POOL_COLD_ATTEMPT_HELD');
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
      const last = prior.at(-1);
      if (last && !last.observationDigest) refuse('DOCKER_POOL_COLD_ATTEMPT_HELD');
      if (
        prior.some(
          (entry) => entry.scope.operationId === input.operationId || entry.scope.scopeDigest === input.scopeDigest
        )
      )
        refuse('DOCKER_POOL_COLD_ALREADY_ISSUED');
      let entry: Entry = { scope: input };
      this.#append(entry, current);
      const append = (next: Entry) => {
        current();
        if (
          entry.observationDigest ||
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
      return recover(journal, (observationDigest) => append({ ...entry, observationDigest }));
    });
  }
}
