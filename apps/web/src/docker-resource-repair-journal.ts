/** Durable cursors of the office's own in-place limit repairs.
 *
 * A reload of the host's service manager resets every cgroup limit that only
 * a helper wrote: the shared pool's, and each laptop's soft memory and swap
 * limits. Putting the approved values back needs one more fixed helper, and
 * that helper needs the same fences as any other: its intent is durable
 * before CREATE and before START, an attempt is resumed as itself, and an
 * attempt whose outcome is unknown is never followed by another.
 *
 * A laptop operation that is finished cannot hold such a cursor: its tasks
 * are part of the published record. So repairs keep their own journal, one
 * private append-only file beside the company store. An entry is DATA. It
 * approves no policy, acknowledges no limit and names no laptop as current;
 * the controller earns every one of those from the Engine and the kernel. */
import { randomUUID } from 'node:crypto';
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
  DOCKER_PRIVATE_JOURNAL_BUDGET,
  appendDockerPrivateJournal,
  readDockerPrivateJournal,
  type DockerPrivateJournalRefusals,
} from './docker-private-journal.js';

const cid = z.string().regex(/^[a-f0-9]{64}$/);
/** What one repair re-applies: the shared pool's limits, or one laptop's own. */
export const DockerResourceRepairTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pool') }).strict(),
  z.object({ kind: z.literal('leaf'), workerId: cid }).strict(),
]);
export type DockerResourceRepairTarget = z.infer<typeof DockerResourceRepairTarget>;
const entry = z
  .object({
    attemptId: z.string().uuid(),
    boxId: cid,
    target: DockerResourceRepairTarget,
    task: DockerContinuationTask.optional(),
    /** The writer was never created: the Engine positively listed no container
     * of its name. The attempt is closed and is never resumed or started. */
    abandoned: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.task ||
        // One attempt is one writer. A rerun is a new attempt with its own name.
        (value.task.role === (value.target.kind === 'pool' ? 'pool-helper' : 'leaf-helper') &&
          !('attempt' in value.task))) &&
      (!value.abandoned || value.task?.phase === 'create-issued')
  );
type Entry = z.infer<typeof entry>;

function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
const refusals: DockerPrivateJournalRefusals = {
  unconfirmed: () => refuse('DOCKER_RESOURCE_REPAIR_JOURNAL_UNCONFIRMED'),
  full: () => refuse('DOCKER_RESOURCE_REPAIR_JOURNAL_FULL'),
};
const terminal = (task: DockerContinuationTask | undefined) => task?.phase === 'completed' || task?.phase === 'failed';
/** Nothing more will be issued for it: its writer ended, or was never created. */
const closed = (value: Entry) => terminal(value.task) || value.abandoned === true;

export interface DockerResourceRepairAttempt {
  readonly id: string;
  /** Whether this call began the attempt. A resumed attempt is observed as itself. */
  readonly fresh: boolean;
  /** The attempt's one task cursor, whichever record the caller passes. */
  readonly journal: DockerContinuationTaskJournal;
  /** Closes an attempt whose writer was recorded as about to be created and
   * was never created. The caller proves that no container of its name exists. */
  abandon(current: () => void): void;
}

export class DockerResourceRepairJournal {
  #turns: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly boxId: string,
    /** How much the file may hold before it is set aside. Never above the shared journal budget. */
    private readonly budget = DOCKER_PRIVATE_JOURNAL_BUDGET
  ) {
    cid.parse(boxId);
  }

  /** The newest state of every attempt of this box, oldest attempt first. */
  #attempts(): Entry[] {
    const latest = new Map<string, Entry>();
    for (const line of readDockerPrivateJournal(this.path, refusals, { emptyAllowed: true })) {
      const value = entry.parse(JSON.parse(line));
      if (value.boxId === this.boxId) latest.set(value.attemptId, value);
    }
    return [...latest.values()];
  }

  #append(next: Entry, current: () => void): void {
    const line = JSON.stringify(entry.parse(next)) + '\n';
    current();
    try {
      appendDockerPrivateJournal(this.path, line, refusals, this.budget);
    } catch (error) {
      if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_RESOURCE_REPAIR_JOURNAL_FULL')
        throw error;
      // A full file of finished attempts is set aside whole. A file that
      // still holds an open attempt is never moved: that attempt stays held.
      if (this.#attempts().some((value) => value.attemptId !== next.attemptId && value.task && !closed(value)))
        throw error;
      renameSync(this.path, this.path + '.previous');
      appendDockerPrivateJournal(this.path, line, refusals, this.budget);
    }
  }

  #open(target: DockerResourceRepairTarget): Entry | undefined {
    const digest = dockerContinuationDigest(target);
    return this.#attempts()
      .filter((value) => dockerContinuationDigest(value.target) === digest)
      .reverse()
      .find((value) => value.task !== undefined && !closed(value));
  }

  /** The cursor of every pool repair writer on record, for the controller's
   * closed-writer census and acknowledgement search. */
  poolTasks(): DockerContinuationTask[] {
    return this.#attempts().flatMap((value) => (value.target.kind === 'pool' && value.task ? [value.task] : []));
  }

  /** The writers of `target` that are recorded finished, oldest attempt first. */
  finished(selected: DockerResourceRepairTarget): Extract<DockerContinuationTask, { phase: 'completed' | 'failed' }>[] {
    const digest = dockerContinuationDigest(DockerResourceRepairTarget.parse(selected));
    return this.#attempts().flatMap((value) =>
      dockerContinuationDigest(value.target) === digest &&
      (value.task?.phase === 'completed' || value.task?.phase === 'failed')
        ? [value.task]
        : []
    );
  }

  /** Runs one attempt for `target`: the open one as itself, otherwise a new
   * one. Serialized with every other writer of this journal. */
  async attempt<T>(
    selected: DockerResourceRepairTarget,
    current: () => void,
    run: (attempt: DockerResourceRepairAttempt) => Promise<T>
  ): Promise<T> {
    const target = DockerResourceRepairTarget.parse(structuredClone(selected));
    // Attempts of this office wait for each other here. The file lock below
    // waits only a few seconds, and that wait is for another process.
    const turn = this.#turns.then(
      () => this.#locked(target, current, run),
      () => this.#locked(target, current, run)
    );
    this.#turns = turn.catch(() => undefined);
    return turn;
  }

  #locked<T>(
    target: DockerResourceRepairTarget,
    current: () => void,
    run: (attempt: DockerResourceRepairAttempt) => Promise<T>
  ): Promise<T> {
    return withCanonicalStateLock(this.path, async () => {
      current();
      const open = this.#open(target);
      let state: Entry = open ?? { attemptId: randomUUID(), boxId: this.boxId, target };
      const role = target.kind === 'pool' ? 'pool-helper' : 'leaf-helper';
      const journal: DockerContinuationTaskJournal = {
        read: (_row, asked) => (asked === role ? state.task : undefined),
        publish: async (row, before, next, admitted) => {
          admitted();
          current();
          const recorded = this.#attempts().find((value) => value.attemptId === state.attemptId);
          if (
            next.role !== role ||
            state.abandoned ||
            terminal(before) ||
            !allowedDockerTaskTransition(before, next) ||
            dockerContinuationDigest(before ?? null) !== dockerContinuationDigest(state.task ?? null) ||
            dockerContinuationDigest(recorded?.task ?? null) !== dockerContinuationDigest(state.task ?? null)
          )
            refuse('DOCKER_RESOURCE_REPAIR_JOURNAL_CHANGED');
          const following = { ...state, task: next };
          this.#append(following, current);
          state = following;
          return row;
        },
      };
      const abandon = (admitted: () => void) => {
        admitted();
        current();
        if (state.task?.phase !== 'create-issued' || state.abandoned) refuse('DOCKER_RESOURCE_REPAIR_JOURNAL_CHANGED');
        const following = { ...state, abandoned: true as const };
        this.#append(following, current);
        state = following;
      };
      return run({ id: state.attemptId, fresh: !open, journal, abandon });
    });
  }
}
