/** What the office itself has seen of the filesystem an employee's HOME and
 * Nix directories are on, kept beside the company store.
 *
 * A storage holder's receipt names a directory by device number and inode. The
 * device number of one filesystem can change across a host restart, and the
 * receipt then no longer says whether the directory at the same path is the
 * same one. The kernel's filesystem ID of an ext4 filesystem is derived from
 * the identifier in its superblock and does not change with the device number.
 * The office records it while a directory is verifiably the recorded one, and
 * that record is what later proves a renumbering.
 *
 * A record is DATA for that one comparison. It never selects a path, never
 * replaces the pinned verifier's own check and never authorizes a write. A
 * file that cannot be read is no record: nothing is proved with it. */
import { renameSync } from 'node:fs';
import { z } from 'zod';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import {
  appendDockerPrivateJournal,
  readDockerPrivateJournal,
  type DockerPrivateJournalRefusals,
} from './docker-private-journal.js';

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const positive = z.string().regex(/^[1-9][0-9]{0,19}$/);
const directory = z
  .object({
    ino: positive,
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
  })
  .strict();
export const DockerStorageIdentity = z
  .object({
    version: z.literal(1),
    employeeId: z.string().uuid(),
    home: directory,
    nix: directory,
    /** The device number both directories had when this was recorded. */
    device: decimal,
    /** The kernel filesystem ID of the one ext4 filesystem both directories are on. */
    filesystemId: positive,
    recordedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type DockerStorageIdentity = z.infer<typeof DockerStorageIdentity>;

function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
const refusals: DockerPrivateJournalRefusals = {
  unconfirmed: () => refuse('DOCKER_STORAGE_IDENTITY_JOURNAL_UNCONFIRMED'),
  full: () => refuse('DOCKER_STORAGE_IDENTITY_JOURNAL_FULL'),
};
const same = (a: DockerStorageIdentity, b: DockerStorageIdentity) =>
  JSON.stringify({ ...a, recordedAt: 0 }) === JSON.stringify({ ...b, recordedAt: 0 });

export class DockerStorageIdentityJournal {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  #latest(): Map<string, DockerStorageIdentity> {
    const latest = new Map<string, DockerStorageIdentity>();
    for (const line of readDockerPrivateJournal(this.path, refusals, { emptyAllowed: true })) {
      const value = DockerStorageIdentity.parse(JSON.parse(line));
      latest.set(value.employeeId, value);
    }
    return latest;
  }

  /** The newest record of one employee. Undefined when there is none, or when the file cannot be read. */
  read(employeeId: string): DockerStorageIdentity | undefined {
    try {
      return this.#latest().get(employeeId);
    } catch {
      return undefined;
    }
  }

  /** Keeps one observation. The same facts are not written twice. A failure to write is reported to the caller,
   * who loses a later proof and nothing else. */
  remember(input: Omit<DockerStorageIdentity, 'version' | 'recordedAt'>): void {
    const next = DockerStorageIdentity.parse({ ...input, version: 1, recordedAt: this.now() });
    const latest = this.#latest(),
      before = latest.get(next.employeeId);
    if (before && same(before, next)) return;
    const line = JSON.stringify(next) + '\n';
    try {
      appendDockerPrivateJournal(this.path, line, refusals);
    } catch (error) {
      if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_STORAGE_IDENTITY_JOURNAL_FULL')
        throw error;
      // Only the newest record of an employee is ever read, so a full file is set aside whole and the newest
      // record of everyone else is carried into the new one.
      renameSync(this.path, this.path + '.previous');
      latest.delete(next.employeeId);
      for (const kept of latest.values()) appendDockerPrivateJournal(this.path, JSON.stringify(kept) + '\n', refusals);
      appendDockerPrivateJournal(this.path, line, refusals);
    }
  }
}
