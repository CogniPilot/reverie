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
 * replaces the pinned verifier's own check and never authorizes a write.
 *
 * Damage is told apart by where it is:
 *
 * - A last line that was never finished is what an append leaves when the
 *   office or the host stopped in the middle of it. It wrote no record. It is
 *   left out and every line before it stands. The next record that is written
 *   sets that file aside as `.previous` and carries the newest record of every
 *   employee into a new one, so the fragment never becomes a line in the middle.
 * - A line that does not read and is not the last cannot come from an append,
 *   which writes whole lines: the file was changed or damaged by something
 *   else. Nothing in it is trusted then. `read` answers `unreadable`, which is
 *   neither a record nor the absence of one, so it proves nothing and the
 *   owner's standing grant, which is for an employee the office holds no
 *   record of, does not apply either. The next record that is written sets
 *   the damaged file aside whole as `.damaged` and starts a new one, which
 *   holds exactly what running laptops show from then on.
 *
 * A file that is not this user's own private file is `unreadable` as well. */
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
    /**
     * `grant`: not seen in a running laptop, but accepted under the owner's standing grant for a home the office
     * held no record of. Such a record proves nothing: it stands for the grant, while the grant is on.
     */
    basis: z.literal('grant').optional(),
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

interface Contents {
  readonly latest: Map<string, DockerStorageIdentity>;
  /** The last line was never finished. */
  readonly torn: boolean;
  /** A line that is not the last does not read. */
  readonly damaged: boolean;
}

export class DockerStorageIdentityJournal {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.warn(line)
  ) {}

  #contents(): Contents {
    const latest = new Map<string, DockerStorageIdentity>();
    let torn = false,
      damaged = false;
    const lines = readDockerPrivateJournal(this.path, refusals, {
      emptyAllowed: true,
      tornTail: () => {
        torn = true;
      },
    });
    for (const line of lines) {
      let value: DockerStorageIdentity;
      try {
        value = DockerStorageIdentity.parse(JSON.parse(line));
      } catch {
        damaged = true;
        continue;
      }
      latest.set(value.employeeId, value);
    }
    return { latest, torn, damaged };
  }

  /**
   * The newest record of one employee, or undefined when the office holds none. `unreadable` when the file cannot
   * be trusted: see the file comment. An unfinished last line is left out and changes nothing else.
   */
  read(employeeId: string): DockerStorageIdentity | undefined | 'unreadable' {
    try {
      const contents = this.#contents();
      return contents.damaged ? 'unreadable' : contents.latest.get(employeeId);
    } catch {
      return 'unreadable';
    }
  }

  /** Keeps one observation. The same facts are not written twice. A failure to write is reported to the caller,
   * who loses a later proof and nothing else. */
  remember(input: Omit<DockerStorageIdentity, 'version' | 'recordedAt'>): void {
    const next = DockerStorageIdentity.parse({ ...input, version: 1, recordedAt: this.now() });
    let contents = this.#contents();
    if (contents.damaged) {
      // Not what an interrupted append leaves. The file is kept for whoever wants to look, and a new one is begun.
      renameSync(this.path, this.path + '.damaged');
      this.log(
        '[docker-storage-identity] the record of employee storage held a line that does not read and was set aside ' +
          'as docker-storage-identity.jsonl.damaged; a new one is begun from what running laptops show'
      );
      contents = { latest: new Map(), torn: false, damaged: false };
    }
    const before = contents.latest.get(next.employeeId);
    if (before && same(before, next) && !contents.torn) return;
    // Only the newest record of an employee is ever read. A file with an unfinished last line, and a full one, is
    // set aside whole, and the newest record of everyone is carried into the new one.
    const renew = () => {
      renameSync(this.path, this.path + '.previous');
      contents.latest.set(next.employeeId, before && same(before, next) ? before : next);
      for (const kept of contents.latest.values())
        appendDockerPrivateJournal(this.path, JSON.stringify(kept) + '\n', refusals);
    };
    if (contents.torn) return renew();
    try {
      appendDockerPrivateJournal(this.path, JSON.stringify(next) + '\n', refusals);
    } catch (error) {
      if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_STORAGE_IDENTITY_JOURNAL_FULL')
        throw error;
      renew();
    }
  }
}
