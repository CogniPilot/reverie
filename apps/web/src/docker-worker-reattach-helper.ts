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
import { classifyDockerExecFailure } from './docker-exec-failure.js';

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
 * - `renumbered`: a new device number; the office holds no record of this employee's storage and no grant covers it.
 * - `renumbered-stale-record`: a new device number; the office's record names other directories, so it proves
 *   nothing and the grant, which is for the case without a record, does not apply.
 * - `renumbered-unverifiable`: a new device number on something the verifier cannot confirm: not ext4, or the two
 *   directories on two filesystems.
 * - `different`: not the directories the laptop was built on (another inode, owner or mode).
 * - `unobserved`: the verifier could not report what is mounted now. The recorded reference is put to it
 *   unchanged, so it confirms an unchanged home and refuses everything else.
 * The first four are confirmed by the pinned verifier before anything is accepted; the verdict only says which
 * reference it was asked to confirm.
 */
export type DockerStoredHomeVerdict =
  | 'same'
  | 'owner-approved'
  | 'renumbered-proved'
  | 'renumbered-granted'
  | 'renumbered'
  | 'renumbered-stale-record'
  | 'renumbered-unverifiable'
  | 'different'
  | 'unobserved';

/**
 * Why one run of the pinned verifier gave no answer, as a closed class. Nothing the Engine or the verifier printed
 * is kept.
 * - `image-missing`: the configured image is not in the Engine.
 * - `lacks-command`: the image does not have the command that was asked for (it was built before the command).
 * - `timed-out`: the run did not answer in time, each time it was tried.
 * - `refused`: the verifier ran and refused with one of its own codes: what is mounted is not what it was given.
 * - `failed`: anything else.
 */
export type DockerVerifierFailure = 'image-missing' | 'lacks-command' | 'timed-out' | 'refused' | 'failed';

/**
 * What the configured verifier image can do, found by one probe at office start and kept current by every later
 * run. `full`: it reports what is mounted, so a renumbered device can be told from another directory.
 * `compare-only`: it was built before that read and can only confirm or refuse a reference it is given.
 * `image-missing`: the image is not in the Engine, so it can confirm nothing. `unknown`: not probed yet, or the
 * probe did not answer.
 */
export type DockerVerifierCapability = 'full' | 'compare-only' | 'image-missing' | 'unknown';

class VerifierRunFailed extends Error {
  constructor(readonly failure: DockerVerifierFailure) {
    super('The pinned verifier gave no answer');
  }
}
/** One run of the verifier may take this long. It is the longest the Engine port allows. */
const VERIFIER_RUN_MS = 30_000;
/** A read that only timed out or failed without a refusal is tried this often before it is given up. */
const VERIFIER_READ_TRIES = 2;

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
  /** Why the last read of what is mounted, and the last confirmation of a reference, gave no answer, by laptop container. */
  readonly #failures = new Map<string, { observe?: DockerVerifierFailure; verify?: DockerVerifierFailure }>();
  #capability: DockerVerifierCapability = 'unknown';

  /** What the configured image can do, as far as this office has found out. */
  capability(): DockerVerifierCapability {
    return this.#capability;
  }

  /**
   * One probe of the configured image: is it in the Engine, and does it have the read of what is mounted. It
   * mounts nothing and reads nothing of anyone's. A probe that gives no answer leaves the capability unknown, and
   * the first real read settles it.
   */
  async probe(current: () => void = () => {}): Promise<DockerVerifierCapability> {
    try {
      await this.#run(['observe-storage-reference', '--help'], '65534:65534', [], current, undefined, VERIFIER_READ_TRIES);
      this.#capability = 'full';
    } catch (error) {
      this.#learn(error instanceof VerifierRunFailed ? error.failure : 'failed');
    }
    return this.#capability;
  }

  #learn(failure: DockerVerifierFailure): void {
    if (failure === 'image-missing') this.#capability = 'image-missing';
    if (failure === 'lacks-command') this.#capability = 'compare-only';
  }

  /** Why the reads of this laptop's stored directories gave no answer, since `forgetVerdict`. */
  failures(row: DockerEmployeeContinuationRecord): { observe?: DockerVerifierFailure; verify?: DockerVerifierFailure } {
    return (row.destination && this.#failures.get(row.destination.containerId)) || {};
  }

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
    if (row.destination) this.#failures.delete(row.destination.containerId);
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
   * filesystem is the one the office recorded for this employee earlier, or the office holds no record of this
   * employee's storage at all and the owner's standing grant covers it. The grant is for the case without a record
   * only: a record that does not match what is mounted is never overridden by it. A record that names these same
   * directories on another filesystem says that the filesystem at the path is not the employee's.
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
    const single = !!identity && historical.home.dev === historical.nix.dev;
    const recorded = this.renumbering?.identity.read(row.employeeId);
    const sameDirectories = !!recorded && !!identity &&
      isDeepStrictEqual(recorded.home, identity.home) && isDeepStrictEqual(recorded.nix, identity.nix);
    // The office recorded these very directories on another filesystem: what is mounted is not that one.
    if (sameDirectories && recorded!.filesystemId !== identity!.filesystemId) {
      this.#decided(row, 'different');
      return { observation: historical };
    }
    const proved = single && sameDirectories;
    const granted = single && !recorded && this.renumbering?.granted(row.owner) === true;
    if (!proved && !granted) {
      this.#decided(row, !single ? 'renumbered-unverifiable' : recorded ? 'renumbered-stale-record' : 'renumbered');
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

  /**
   * One run of the pinned verifier, with why it gave no answer when it gave none (`VerifierRunFailed`). A read that
   * timed out or failed without a refusal of the verifier's own is repeated up to `tries` times: these runs only
   * read, and a host that has just restarted is slow. A refusal and a missing command are answers and are not
   * repeated. Limit diagnostics to the class: subprocess details and input never leave this method.
   */
  async #run(
    args: string[], user: string, mounts: string[], current: () => void, input: string | undefined, tries: number
  ): Promise<string> {
    current();
    if (!/^sha256:[0-9a-f]{64}$/.test(this.imageId) || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(user))
      return refuse();
    const raw = await this.command.run(['image', 'inspect', '--format', '{{json .Id}}', this.imageId]).catch(() => '');
    current();
    if (raw.trim() !== JSON.stringify(this.imageId)) {
      this.#capability = 'image-missing';
      throw new VerifierRunFailed('image-missing');
    }
    let failure: DockerVerifierFailure = 'failed';
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const output = await this.command.run([
          'run', '--rm', '--pull=never', '--read-only', '--network=none', '--cap-drop=ALL',
          '--security-opt=no-new-privileges', '--memory=32m', '--memory-swap=32m', '--pids-limit=8',
          '--log-driver=none', '--user', user, '--entrypoint', executable,
          ...(input === undefined ? [] : ['--interactive']),
          ...mounts, this.imageId, ...args,
        ], input, VERIFIER_RUN_MS);
        current();
        return output;
      } catch (error) {
        current();
        const seen = classifyDockerExecFailure(error);
        // The verifier exits with 2 for a command line it does not know, and with 1 and its own code for a refusal.
        failure = seen.kind === 'helper-refused' ? 'refused'
          : seen.kind === 'timed-out' ? 'timed-out'
            : seen.kind === 'failed' && seen.exitCode === 2 ? 'lacks-command' : 'failed';
        if (failure === 'refused' || failure === 'lacks-command') break;
      }
    }
    throw new VerifierRunFailed(failure);
  }

  async #verify(
    args: string[], user: string, mounts: string[], current: () => void, input?: string, tries = 1
  ): Promise<unknown> {
    let output: string;
    try {
      output = await this.#run(args, user, mounts, current, input, tries);
    } catch (error) {
      if (error instanceof VerifierRunFailed) return refuse();
      throw error;
    }
    if (Buffer.byteLength(output) > 2048) return refuse();
    return parseBoxedConfigurationJson(output);
  }

  /** Keeps why a read of one laptop's stored directories gave no answer, and what that says about the image. */
  #failed(containerId: string, read: 'observe' | 'verify', error: unknown): never {
    const failure = error instanceof VerifierRunFailed ? error.failure : 'failed';
    this.#failures.set(containerId, { ...this.#failures.get(containerId), [read]: failure });
    this.#learn(failure);
    if (error instanceof VerifierRunFailed) return refuse();
    throw error;
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
   * verifier image that predates this read refuses, and is not asked again: `failures` says why. */
  async observe(destination: DockerEmployeeInspect, current: () => void): Promise<DockerStorageFilesystemObservation> {
    const mounts = this.#referenceMounts(destination);
    let output: string;
    try {
      if (this.#capability === 'compare-only') throw new VerifierRunFailed('lacks-command');
      output = await this.#run(
        ['observe-storage-reference'], destination.Config.User, mounts, current, undefined, VERIFIER_READ_TRIES
      );
    } catch (error) {
      return this.#failed(destination.Id, 'observe', error);
    }
    this.#capability = 'full';
    if (Buffer.byteLength(output) > 2048) return refuse();
    const parsed = StorageFilesystemObservation.safeParse(parseBoxedConfigurationJson(output));
    return parsed.success ? parsed.data : refuse();
  }

  async storage(
    destination: DockerEmployeeInspect,
    seen: Readonly<{ home: Directory; nix: Directory }>,
    current: () => void,
    filesystemId?: string
  ): Promise<unknown> {
    const expected = (value: Directory) => [value.dev, value.ino, value.uid, value.gid, value.mode].join(':');
    const mounts = this.#referenceMounts(destination);
    let output: string;
    try {
      output = await this.#run(
        ['verify-storage-reference', '--home', expected(seen.home), '--nix', expected(seen.nix),
          ...(filesystemId === undefined ? [] : ['--filesystem-id', filesystemId])],
        destination.Config.User, mounts, current, undefined, VERIFIER_READ_TRIES
      );
    } catch (error) {
      return this.#failed(destination.Id, 'verify', error);
    }
    if (Buffer.byteLength(output) > 2048) return refuse();
    const verified = parseBoxedConfigurationJson(output);
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
