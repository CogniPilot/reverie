/** Durable owner decisions about one Docker box's shared resources. One private
 * append-only file beside the company store; the newest line for this box is
 * the current decision. A decision is DATA: it grants no kernel write, launch
 * or resource credit by itself. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { withCanonicalStateLock } from './canonical-state-lock.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';

const budget = 512 * 1024;

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

  #privateFile(fd: number): void {
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.uid !== process.getuid?.() ||
      (status.mode & 0o077) !== 0 ||
      status.size > budget
    )
      this.#refuse('JOURNAL_UNCONFIRMED');
  }

  /** Every decision for this box, oldest first. */
  entries(): T[] {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      this.#privateFile(fd);
      const raw = readFileSync(fd, 'utf8');
      if (!raw) return [];
      if (!raw.endsWith('\n')) this.#refuse('JOURNAL_UNCONFIRMED');
      return raw
        .slice(0, -1)
        .split('\n')
        .map((line) => this.schema.parse(JSON.parse(line)))
        .filter((entry) => entry.boxId === this.boxId);
    } finally {
      closeSync(fd);
    }
  }

  #append(entry: T, current: () => void): void {
    const line = JSON.stringify(this.schema.parse(entry)) + '\n';
    current();
    const file = openSync(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    try {
      this.#privateFile(file);
      if (fstatSync(file).size + Buffer.byteLength(line) > budget) this.#refuse('JOURNAL_FULL');
      writeFileSync(file, line, 'utf8');
      fsyncSync(file);
      const parent = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      closeSync(file);
    }
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
