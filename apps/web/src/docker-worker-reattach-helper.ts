/** Transport for the pinned Rust verifier. It does not hold recovery state. */
import { z } from 'zod';
import type { DockerEmployeeStorageObservation } from './docker-employee-storage.js';
import { isDeepStrictEqual } from 'node:util';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
import type { DockerStorageIdentityJournal } from './docker-storage-identity-journal.js';

type Directory = Readonly<{ dev: string; ino: string; uid: number; gid: number; mode: number }>;
type Issuer = () => Readonly<{ instanceId: string; key: string }>;

const executable = '/bin/reverie-docker-resources';
const withoutDevice = (value: Directory) => ({ ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode });
const refuse = (): never => {
  throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_REATTACH_VERIFIER_UNCONFIRMED');
};

const positive = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= 0xffffffffffffffffn);
export const StorageDeviceApproval = z.object({
  sessionId: z.string().uuid(),
  sessionGeneration: z.number().int().positive().safe(),
  operationId: z.string().uuid(),
  containerId: z.string().regex(/^[0-9a-f]{64}$/),
  historicalDevice: positive, currentDevice: positive, filesystemId: positive,
  homeInode: positive, nixInode: positive,
}).strict().refine(value => value.historicalDevice !== value.currentDevice && value.homeInode !== value.nixInode);
type StorageApproval = Readonly<z.infer<typeof StorageDeviceApproval>>;

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const observedDirectory = z.object({
  dev: decimal, ino: decimal, uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
}).strict();
const observedFilesystem = z.object({ ext4: z.boolean(), id: decimal }).strict();
/** What the pinned verifier reports of the two reference mounts as they are now. */
const StorageFilesystemObservation = z.object({
  version: z.literal(1), purpose: z.literal('reverie-boxed-storage-filesystem-observation-v1'),
  home: observedDirectory, nix: observedDirectory,
  homeFilesystem: observedFilesystem, nixFilesystem: observedFilesystem,
}).strict();
export type DockerStorageFilesystemObservation = z.infer<typeof StorageFilesystemObservation>;

/**
 * How the stored HOME and Nix directories of one stopped laptop compare with what its storage holder recorded.
 * - `same`: the same directories on the same device numbers.
 * - `owner-approved`: a new device number that the owner approved for this laptop through the approval route.
 * - `renumbered-proved`: a new device number, and the filesystem is the one the office itself recorded for this
 *   employee earlier.
 * - `renumbered-granted`: a new device number that the office cannot prove, accepted under the owner's standing
 *   grant (company setting `acceptStorageRenumbering`).
 * - `renumbered`: a new device number, neither proved nor granted.
 * - `different`: not the directories the laptop was built on (another inode, owner or mode).
 * - `unobserved`: the verifier could not report what is mounted now.
 * The first four are confirmed by the pinned verifier before anything is accepted; the verdict only says which
 * reference it was asked to confirm.
 */
export type DockerStoredHomeVerdict =
  | 'same'
  | 'owner-approved'
  | 'renumbered-proved'
  | 'renumbered-granted'
  | 'renumbered'
  | 'different'
  | 'unobserved';

/** What stands where the owner's per-request approval stood: the office's own record, and the owner's standing grant. */
export interface DockerStorageRenumbering {
  /** The owner's standing grant. Absent or false: the office accepts only what it can prove. */
  granted(owner: string | undefined): boolean;
  readonly identity: Pick<DockerStorageIdentityJournal, 'read' | 'remember'>;
}

const unchanged = (a: Directory, b: Directory) =>
  a.ino !== '0' && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
/** Both directories on one ext4 filesystem with a usable ID: what `--filesystem-id` can verify. */
const oneFilesystem = (seen: DockerStorageFilesystemObservation) =>
  seen.home.dev === seen.nix.dev && seen.homeFilesystem.ext4 && seen.nixFilesystem.ext4 &&
  seen.homeFilesystem.id === seen.nixFilesystem.id && seen.homeFilesystem.id !== '0';

export class DockerWorkerReattachHelper {
  readonly #approvals = new Map<string, StorageApproval>();
  /** The last verdict for each employee's laptop operation. DATA for reports. */
  readonly #verdicts = new Map<string, { operationId: string; verdict: DockerStoredHomeVerdict }>();
  /** A reference the verifier was asked to confirm, by laptop container: recorded once it has confirmed it twice. */
  readonly #pending = new Map<string, {
    home: Directory; nix: Directory; confirmations: number;
    identity: Parameters<DockerStorageIdentityJournal['remember']>[0];
  }>();

  approveStorage(row: DockerEmployeeContinuationRecord, input: unknown): void {
    const approval = StorageDeviceApproval.parse(input);
    if (!this.#matches(row, approval)) return refuse();
    this.#approvals.set(row.employeeId, Object.freeze(approval));
  }

  #matches(row: DockerEmployeeContinuationRecord, approval: StorageApproval): boolean {
    return row.destination?.containerId === approval.containerId &&
      row.request.sessionId === approval.sessionId && row.request.sessionGeneration === approval.sessionGeneration &&
      row.request.operationId === approval.operationId;
  }

  /** The last verdict on this laptop operation's stored directories, when one was reached. */
  verdict(row: DockerEmployeeContinuationRecord): DockerStoredHomeVerdict | undefined {
    const last = this.#verdicts.get(row.employeeId);
    return last?.operationId === row.request.operationId ? last.verdict : undefined;
  }

  /** Before a new read: an earlier verdict says nothing about it. */
  forgetVerdict(row: DockerEmployeeContinuationRecord): void {
    this.#verdicts.delete(row.employeeId);
  }

  #decided(row: DockerEmployeeContinuationRecord, verdict: DockerStoredHomeVerdict): void {
    this.#verdicts.set(row.employeeId, { operationId: row.request.operationId, verdict });
  }

  /**
   * The reference the pinned verifier is asked to confirm for a stopped laptop: what its holder recorded, or that
   * record under a new device number.
   *
   * The owner's approval for this laptop comes first and is used exactly as before. Without one, and when the
   * stopped laptop is given, the office reads what is mounted now and accepts a new device number by itself only
   * when both directories are otherwise unchanged (inode, owner, mode) on one ext4 filesystem, and either the
   * filesystem is the one the office recorded for this employee earlier, or the owner's standing grant covers it.
   * In every other case the recorded reference is returned unchanged, so the verifier refuses whatever differs.
   * Nothing is accepted here: the verifier then checks the returned reference, with the filesystem ID, twice.
   */
  async stoppedReference(
    row: DockerEmployeeContinuationRecord,
    historical: DockerEmployeeStorageObservation,
    destination?: DockerEmployeeInspect,
    current?: () => void
  ): Promise<{ observation: DockerEmployeeStorageObservation; filesystemId?: string }> {
    const approval = this.#approvals.get(row.employeeId);
    if (approval && this.#matches(row, approval)) {
      if (historical.home.dev !== approval.historicalDevice || historical.nix.dev !== approval.historicalDevice ||
          historical.home.ino !== approval.homeInode || historical.nix.ino !== approval.nixInode) return refuse();
      this.#decided(row, 'owner-approved');
      return { observation: { ...historical, home: { ...historical.home, dev: approval.currentDevice },
        nix: { ...historical.nix, dev: approval.currentDevice } }, filesystemId: approval.filesystemId };
    }
    if (!destination || !current) return { observation: historical };
    this.#pending.delete(destination.Id);
    const seen = await this.observe(destination, current).catch(() => undefined);
    current();
    if (!seen) {
      this.#decided(row, 'unobserved');
      return { observation: historical };
    }
    if (!unchanged(historical.home, seen.home) || !unchanged(historical.nix, seen.nix)) {
      this.#decided(row, 'different');
      return { observation: historical };
    }
    const identity = oneFilesystem(seen) ? {
      employeeId: row.employeeId, home: withoutDevice(seen.home), nix: withoutDevice(seen.nix),
      device: seen.home.dev, filesystemId: seen.homeFilesystem.id,
    } : undefined;
    const pend = (home: Directory, nix: Directory) => {
      if (identity) this.#pending.set(destination.Id, { home, nix, confirmations: 0, identity });
    };
    if (seen.home.dev === historical.home.dev && seen.nix.dev === historical.nix.dev) {
      this.#decided(row, 'same');
      pend(historical.home, historical.nix);
      return { observation: historical };
    }
    const recorded = identity && historical.home.dev === historical.nix.dev
      ? this.renumbering?.identity.read(row.employeeId) : undefined;
    const proved = !!recorded && recorded.filesystemId === identity!.filesystemId &&
      isDeepStrictEqual(recorded.home, identity!.home) && isDeepStrictEqual(recorded.nix, identity!.nix);
    const granted = !proved && !!identity && historical.home.dev === historical.nix.dev &&
      this.renumbering?.granted(row.owner) === true;
    if (!proved && !granted) {
      this.#decided(row, 'renumbered');
      return { observation: historical };
    }
    this.#decided(row, proved ? 'renumbered-proved' : 'renumbered-granted');
    const home = { ...historical.home, dev: seen.home.dev }, nix = { ...historical.nix, dev: seen.nix.dev };
    pend(home, nix);
    return { observation: { ...historical, home, nix }, filesystemId: identity!.filesystemId };
  }

  /** Records what a running laptop's own mounts are on, for a later proof. `live` is what the laptop itself
   * reports of its HOME and Nix directories; the record is kept only when the verifier sees exactly the same
   * directories through the same two bind sources, on one ext4 filesystem. True when a record is held now. */
  async rememberRunning(
    row: DockerEmployeeContinuationRecord,
    destination: DockerEmployeeInspect,
    live: Readonly<{ home: Directory; nix: Directory }>,
    current: () => void
  ): Promise<boolean> {
    if (!this.renumbering) return false;
    const seen = await this.observe(destination, current);
    current();
    if (!isDeepStrictEqual(seen.home, live.home) || !isDeepStrictEqual(seen.nix, live.nix) || !oneFilesystem(seen))
      return false;
    this.renumbering.identity.remember({
      employeeId: row.employeeId, home: withoutDevice(seen.home), nix: withoutDevice(seen.nix),
      device: seen.home.dev, filesystemId: seen.homeFilesystem.id,
    });
    return true;
  }

  constructor(
    private readonly command: DockerEngineCommand,
    private readonly imageId: string,
    private readonly issuer: Issuer,
    private readonly renumbering?: DockerStorageRenumbering
  ) {}

  async #verify(args: string[], user: string, mounts: string[], current: () => void, input?: string): Promise<unknown> {
    current();
    if (!/^sha256:[0-9a-f]{64}$/.test(this.imageId) || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(user))
      return refuse();
    const raw = await this.command.run(['image', 'inspect', '--format', '{{json .Id}}', this.imageId]);
    current();
    if (raw.trim() !== JSON.stringify(this.imageId)) return refuse();
    let output: string;
    try {
      output = await this.command.run([
        'run', '--rm', '--pull=never', '--read-only', '--network=none', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--memory=32m', '--memory-swap=32m', '--pids-limit=8',
        '--log-driver=none', '--user', user, '--entrypoint', executable,
        ...(input === undefined ? [] : ['--interactive']),
        ...mounts, this.imageId, ...args,
      ], input, 15_000);
    } catch {
      // Limit diagnostics to the operation. Never surface subprocess details or input.
      return refuse();
    }
    current();
    if (Buffer.byteLength(output) > 2048) return refuse();
    return parseBoxedConfigurationJson(output);
  }

  /** The two bind sources of a laptop, mounted read-only where the verifier expects them. */
  #referenceMounts(destination: DockerEmployeeInspect): string[] {
    const bind = (guest: string, target: string) => {
      const mounts = destination.Mounts.filter(mount => mount.Destination === guest);
      const mount = mounts[0];
      if (mounts.length !== 1 || !mount || mount.Type !== 'bind' || !mount.Source.startsWith('/') ||
        mount.Source === '/') return refuse();
      if (Array.from(mount.Source).some((character) =>
        character === ',' || character === '"' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )) return refuse();
      return ['--mount', 'type=bind,source=' + mount.Source + ',target=' + target + ',readonly'];
    };
    return [...bind('/home/agent', '/run/reverie-worker-home'), ...bind('/nix', '/run/reverie-worker-nix')];
  }

  /** What the two bind sources of a laptop are now: each directory and the filesystem it is on. Read-only. A
   * verifier image that predates this read refuses, like any other failed run. */
  async observe(destination: DockerEmployeeInspect, current: () => void): Promise<DockerStorageFilesystemObservation> {
    const mounts = this.#referenceMounts(destination);
    const parsed = StorageFilesystemObservation.safeParse(
      await this.#verify(['observe-storage-reference'], destination.Config.User, mounts, current)
    );
    return parsed.success ? parsed.data : refuse();
  }

  async storage(
    destination: DockerEmployeeInspect,
    seen: Readonly<{ home: Directory; nix: Directory }>,
    current: () => void,
    filesystemId?: string
  ): Promise<unknown> {
    const expected = (value: Directory) => [value.dev, value.ino, value.uid, value.gid, value.mode].join(':');
    const verified = await this.#verify(
      ['verify-storage-reference', '--home', expected(seen.home), '--nix', expected(seen.nix),
        ...(filesystemId === undefined ? [] : ['--filesystem-id', filesystemId])],
      destination.Config.User,
      this.#referenceMounts(destination),
      current
    );
    this.#confirmed(destination.Id, seen);
    return verified;
  }

  /** The verifier confirmed a reference. The second confirmation of the one this helper proposed for a stopped
   * laptop is what the office keeps as its own record of that employee's storage. */
  #confirmed(containerId: string, seen: Readonly<{ home: Directory; nix: Directory }>): void {
    const pending = this.#pending.get(containerId);
    if (!pending || !isDeepStrictEqual(pending.home, seen.home) || !isDeepStrictEqual(pending.nix, seen.nix)) return;
    if (++pending.confirmations < 2) return;
    this.#pending.delete(containerId);
    try {
      this.renumbering?.identity.remember(pending.identity);
    } catch {
      /* A record that could not be written loses a later proof and nothing else. */
    }
  }

  async credential(row: DockerEmployeeContinuationRecord, observedTokenDigest: string, current: () => void): Promise<void> {
    current();
    if (!row.destination || !/^[0-9a-f]{64}$/.test(observedTokenDigest)) return refuse();
    const binding = {
      employeeId: row.employeeId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
      owner: row.owner ?? null,
      containerId: row.destination.containerId,
      credentialId: row.credentialId,
    };
    const receipt = await this.#verify(['verify-worker-credential'], '65534:65534', [], current, JSON.stringify({
      version: 1,
      purpose: 'reverie-boxed-worker-credential-check-v1',
      binding,
      observedTokenDigest,
      issuer: { version: 1, purpose: 'reverie-docker-worker-key-v1', ...this.issuer() },
    }));
    current();
    if (!isDeepStrictEqual(receipt, { version: 1, purpose: 'reverie-boxed-worker-credential-verified-v1', binding }))
      return refuse();
  }
}
