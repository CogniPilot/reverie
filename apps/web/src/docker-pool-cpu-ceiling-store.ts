/** Durable owner approvals of the employee group CPU ceiling. One private
 * append-only file beside the company store; the newest line for this box is
 * the current approval. Approval alone changes nothing in the kernel. */
import { DockerOwnerDecisionJournal } from './docker-owner-decision-journal.js';
import { DockerPoolCpuCeilingApproval, dockerPoolCpuMax } from './docker-pool-cpu-ceiling-data.js';

/** Earlier approvals a pool observation may still legitimately show. */
const remembered = 8;

export class DockerPoolCpuCeilingStore {
  readonly #journal: DockerOwnerDecisionJournal<DockerPoolCpuCeilingApproval>;
  constructor(path: string, boxId: string) {
    this.#journal = new DockerOwnerDecisionJournal(
      path,
      boxId,
      DockerPoolCpuCeilingApproval,
      'DOCKER_POOL_CPU_CEILING'
    );
  }

  /** The owner's current decision for this box, if any. */
  approved(): DockerPoolCpuCeilingApproval | undefined {
    return this.#journal.approved();
  }

  /** Kernel cpu.max values of the current and recent earlier approvals. */
  recentCpuMax(): string[] {
    const values = this.#journal
      .entries()
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
  approve(
    next: DockerPoolCpuCeilingApproval,
    expectedRevision: string | null,
    current: () => void
  ): Promise<DockerPoolCpuCeilingApproval> {
    return this.#journal.approve(next, expectedRevision, current);
  }
}
