/** Durable owner decisions about one Docker box's shared resources. One private
 * append-only file beside the company store; the newest line for this box is
 * the current decision. A decision is DATA: it grants no kernel write, launch
 * or resource credit by itself. */
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { withCanonicalStateLock } from './canonical-state-lock.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import {
  appendDockerPrivateJournal,
  readDockerPrivateJournal,
  type DockerPrivateJournalRefusals,
} from './docker-private-journal.js';

/** Every decision names its revision and the box it belongs to. */
export interface DockerOwnerDecision {
  readonly revision: string;
  readonly boxId: string;
}

export class DockerOwnerDecisionJournal<T extends DockerOwnerDecision> {
  /** `code` prefixes every refusal, e.g. `DOCKER_POOL_CPU_CEILING` gives
   * `DOCKER_POOL_CPU_CEILING_CHANGED` and `..._JOURNAL_UNCONFIRMED`. */
  constructor(
    private readonly path: string,
    private readonly boxId: string,
    private readonly schema: z.ZodType<T>,
    private readonly code: string
  ) {
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed box identity required');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw Error('Fixed refusal code prefix required');
  }

  #refuse(suffix: string): never {
    throw new DockerEmployeeContinuationError(this.code + '_' + suffix);
  }

  get #refusals(): DockerPrivateJournalRefusals {
    return { unconfirmed: () => this.#refuse('JOURNAL_UNCONFIRMED'), full: () => this.#refuse('JOURNAL_FULL') };
  }

  /** Every decision for this box, oldest first. */
  entries(): T[] {
    return readDockerPrivateJournal(this.path, this.#refusals, { emptyAllowed: true })
      .map((line) => this.schema.parse(JSON.parse(line)))
      .filter((entry) => entry.boxId === this.boxId);
  }

  #append(entry: T, current: () => void): void {
    const line = JSON.stringify(this.schema.parse(entry)) + '\n';
    current();
    appendDockerPrivateJournal(this.path, line, this.#refusals);
  }

  /** The owner's current decision for this box, if any. */
  approved(): T | undefined {
    return this.entries().at(-1);
  }

  /** Compare-and-append. `expectedRevision` is the decision the owner saw. */
  async approve(next: T, expectedRevision: string | null, current: () => void): Promise<T> {
    const input = this.schema.parse(structuredClone(next));
    if (input.boxId !== this.boxId) this.#refuse('CHANGED');
    return withCanonicalStateLock(this.path, async () => {
      current();
      const entries = this.entries(),
        last = entries.at(-1);
      // A repeated identical request is the same decision, not a second one.
      if (last && isDeepStrictEqual(last, input)) return last;
      if ((last?.revision ?? null) !== expectedRevision || entries.some((entry) => entry.revision === input.revision))
        this.#refuse('CHANGED');
      this.#append(input, current);
      const saved = this.entries().at(-1);
      if (!saved || !isDeepStrictEqual(saved, input)) this.#refuse('JOURNAL_UNCONFIRMED');
      return saved;
    });
  }
}
