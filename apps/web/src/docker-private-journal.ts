/** One private append-only journal file beside the company store: the custody
 * checks, bounded read and durable append that every Docker box journal shares.
 * A line is DATA for its owner to parse; nothing here interprets one. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The most one journal file may hold. */
export const DOCKER_PRIVATE_JOURNAL_BUDGET = 512 * 1024;

/** How the owning journal names a refusal. Each throws its own coded error. */
export interface DockerPrivateJournalRefusals {
  /** The file is not this user's own private regular file, or is malformed. */
  unconfirmed(): never;
  /** The next line would not fit. */
  full(): never;
}

function requirePrivate(fd: number, refuse: DockerPrivateJournalRefusals): void {
  const status = fstatSync(fd);
  if (
    !status.isFile() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    status.size > DOCKER_PRIVATE_JOURNAL_BUDGET
  )
    refuse.unconfirmed();
}

/** Every complete line, oldest first. A missing file has none. An existing
 * file that is empty is refused unless the owner says it may be. A file whose
 * last line was never finished is refused as well, unless the owner asks for
 * that fragment to be left out (`tornTail`, which is then called): an append
 * that was cut off wrote no complete line, so every line before it stands. */
export function readDockerPrivateJournal(
  path: string,
  refuse: DockerPrivateJournalRefusals,
  options: { readonly emptyAllowed?: boolean; readonly tornTail?: () => void } = {}
): string[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    requirePrivate(fd, refuse);
    const raw = readFileSync(fd, 'utf8');
    if (!raw && options.emptyAllowed) return [];
    if (!raw.endsWith('\n')) {
      if (!options.tornTail) refuse.unconfirmed();
      options.tornTail!();
      const complete = raw.lastIndexOf('\n');
      return complete < 0 ? [] : raw.slice(0, complete).split('\n');
    }
    return raw.slice(0, -1).split('\n');
  } finally {
    closeSync(fd);
  }
}

/** Appends one line and makes it and its directory entry durable. An owner
 * may keep its file below the shared budget; it can never exceed it. */
export function appendDockerPrivateJournal(
  path: string,
  line: string,
  refuse: DockerPrivateJournalRefusals,
  budget = DOCKER_PRIVATE_JOURNAL_BUDGET
): void {
  const file = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600
  );
  try {
    requirePrivate(file, refuse);
    if (fstatSync(file).size + Buffer.byteLength(line) > Math.min(budget, DOCKER_PRIVATE_JOURNAL_BUDGET)) refuse.full();
    writeFileSync(file, line, 'utf8');
    fsyncSync(file);
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    closeSync(file);
  }
}
