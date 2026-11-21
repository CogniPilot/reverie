/** A shared pool cold-start cursor survives a console restart or rollback.
 * An incomplete attempt remains held. Only an observed, published pool can
 * close it, and completed records remain available for later diagnosis. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { withCanonicalStateLock } from './canonical-state-lock.js';
import {
  DockerContinuationTask,
  allowedDockerTaskTransition,
  type DockerContinuationTaskJournal,
} from './docker-continuation-task.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';

const budget = 512 * 1024;
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
function privateFile(fd: number): void {
  const status = fstatSync(fd);
  if (
    !status.isFile() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    status.size > budget
  )
    refuse('DOCKER_POOL_COLD_JOURNAL_UNCONFIRMED');
}

export class DockerColdPoolJournal {
  constructor(private readonly path: string) {}

  #entries(): Entry[] {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      privateFile(fd);
      const raw = readFileSync(fd, 'utf8');
      if (!raw.endsWith('\n')) refuse('DOCKER_POOL_COLD_JOURNAL_UNCONFIRMED');
      return raw
        .slice(0, -1)
        .split('\n')
        .map((line) => journalEntry.parse(JSON.parse(line)));
    } finally {
      closeSync(fd);
    }
  }

  #append(entry: Entry, current: () => void): void {
    const line = JSON.stringify(journalEntry.parse(entry)) + '\n';
    current();
    const file = openSync(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    try {
      privateFile(file);
      if (fstatSync(file).size + Buffer.byteLength(line) > budget) refuse('DOCKER_POOL_COLD_JOURNAL_FULL');
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
