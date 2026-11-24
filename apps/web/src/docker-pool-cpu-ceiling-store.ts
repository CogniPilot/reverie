/** Durable owner approvals of the employee group CPU ceiling. One private
 * append-only file beside the company store; the newest line for this box is
 * the current approval. Approval alone changes nothing in the kernel. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withCanonicalStateLock } from './canonical-state-lock.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import { DockerPoolCpuCeilingApproval, dockerPoolCpuMax } from './docker-pool-cpu-ceiling-data.js';

const budget = 512 * 1024;
/** Earlier approvals a pool observation may still legitimately show. */
const remembered = 8;
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
    refuse('DOCKER_POOL_CPU_CEILING_JOURNAL_UNCONFIRMED');
}

export class DockerPoolCpuCeilingStore {
  constructor(
    private readonly path: string,
    private readonly boxId: string
  ) {
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed box identity required');
  }

  #entries(): DockerPoolCpuCeilingApproval[] {
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
      if (!raw) return [];
      if (!raw.endsWith('\n')) refuse('DOCKER_POOL_CPU_CEILING_JOURNAL_UNCONFIRMED');
      return raw
        .slice(0, -1)
        .split('\n')
        .map((line) => DockerPoolCpuCeilingApproval.parse(JSON.parse(line)))
        .filter((entry) => entry.boxId === this.boxId);
    } finally {
      closeSync(fd);
    }
  }

  #append(entry: DockerPoolCpuCeilingApproval, current: () => void): void {
    const line = JSON.stringify(DockerPoolCpuCeilingApproval.parse(entry)) + '\n';
    current();
    const file = openSync(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    try {
      privateFile(file);
      if (fstatSync(file).size + Buffer.byteLength(line) > budget) refuse('DOCKER_POOL_CPU_CEILING_JOURNAL_FULL');
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
  approved(): DockerPoolCpuCeilingApproval | undefined {
    return this.#entries().at(-1);
  }

  /** Kernel cpu.max values of the current and recent earlier approvals. */
  recentCpuMax(): string[] {
    const values = this.#entries()
      .slice(-remembered)
      .filter((entry) => entry.cpuCores !== null)
      .map((entry) => dockerPoolCpuMax(entry.cpuCores));
    return [...new Set(values)];
  }

  /** Deny-only widening for pool observations. An unreadable journal approves
   * nothing, so a pool ceiling then reads as an unapproved change. */
  acceptedCpuMax(): readonly string[] {
    try {
      return this.recentCpuMax();
    } catch {
      return [];
    }
  }

  /** Compare-and-append. `expectedRevision` is the approval the owner saw. */
  async approve(
    next: DockerPoolCpuCeilingApproval,
    expectedRevision: string | null,
    current: () => void
  ): Promise<DockerPoolCpuCeilingApproval> {
    const input = DockerPoolCpuCeilingApproval.parse(structuredClone(next));
    if (input.boxId !== this.boxId) refuse('DOCKER_POOL_CPU_CEILING_CHANGED');
    return withCanonicalStateLock(this.path, async () => {
      current();
      const entries = this.#entries(),
        last = entries.at(-1);
      // A repeated identical request is the same decision, not a second one.
      if (last && isDeepStrictEqual(last, input)) return last;
      if ((last?.revision ?? null) !== expectedRevision || entries.some((entry) => entry.revision === input.revision))
        refuse('DOCKER_POOL_CPU_CEILING_CHANGED');
      this.#append(input, current);
      const saved = this.#entries().at(-1);
      if (!saved || !isDeepStrictEqual(saved, input)) refuse('DOCKER_POOL_CPU_CEILING_JOURNAL_UNCONFIRMED');
      return saved;
    });
  }
}
