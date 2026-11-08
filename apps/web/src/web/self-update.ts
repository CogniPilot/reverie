/**
 * @fileoverview Server-side logic for App Settings → Updates.
 *
 * Reverie no longer updates itself in place: a Nix package upgrade or a rebuilt
 * image replaces the install. `getInstallInfo` reports `selfUpdateEnabled: false`,
 * `checkForUpdate` reports no release, and `startUpdate` refuses with
 * `NIX_UPDATE_MESSAGE`.
 *
 * What remains: the status file at `dataPath('update-status.json')` with its PURE
 * reconcile and expiry helpers (a status left by an older updater still settles
 * on boot and on read), install probing, and the Docker environment gate. See
 * `docs/docker-self-update.md`.
 *
 * Related: `src/types/update.ts`, routes in `src/web/routes/system-routes.ts`.
 *
 * @module web/self-update
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dataPath } from '../config/instance.js';
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from '../config/service-names.js';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import type {
  EnvironmentBlocker,
  EnvironmentGate,
  InstallInfo,
  InstallKind,
  SupervisorKind,
  UpdateCheckResult,
  UpdatePhase,
  UpdateStatus,
} from '../types/update.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json') as { version: string };

// Unit name / job label live in config/service-names.ts so install.sh, this
// detector and `reverie service install` cannot drift apart. Unchanged for the
// default instance.
/** Path to the persisted update status file. */
const STATUS_FILE = dataPath('update-status.json');
/** Network/git timeout for the "check" path (longer than EXEC_TIMEOUT_MS — ls-remote hits the network). */
const CHECK_TIMEOUT_MS = 12_000;
/** How long after `startedAt` a non-terminal status is treated as abandoned on boot. */
const RECONCILE_STALE_MS = 15 * 60 * 1000;

/** Phases that mean "an update is currently running". */
const IN_FLIGHT_PHASES: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>([
  'queued',
  'preparing',
  'stashing',
  'fetching',
  'checkout',
  'installing',
  'building',
  'restarting',
]);

export function isInFlight(status: UpdateStatus | null | undefined): boolean {
  return !!status && IN_FLIGHT_PHASES.has(status.phase);
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE helpers (unit tested — no IO)
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Non-empty for prereleases like `0.9.3-rc1`. */
  prerelease: string;
}

/**
 * Parse a semver out of a release tag. Accepts `reverie@0.9.3`, `aireverie@0.9.3`,
 * `v0.9.3`, and bare `0.9.3` (with optional `-prerelease`). Returns null if no
 * `X.Y.Z` is present.
 */
export function parseVersionFromTag(tag: string): ParsedVersion | null {
  const m = tag.trim().match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ?? '',
  };
}

/** Compare two parsed versions. Returns >0 if a>b, <0 if a<b, 0 if equal. A release outranks a prerelease of the same X.Y.Z. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Equal core: a release (no prerelease) is greater than a prerelease.
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** True when `latest` is a strictly newer STABLE version than `current`. */
export function isNewerStableVersion(current: string, latest: string): boolean {
  const c = parseVersionFromTag(current);
  const l = parseVersionFromTag(latest);
  if (!c || !l) return false;
  if (l.prerelease) return false; // never offer a prerelease as an update
  return compareVersions(l, c) > 0;
}

/**
 * From a list of `refs/tags/...` (or bare tag names), pick the highest STABLE
 * release tag we recognize. Skips prereleases and unrecognized tags.
 */
export function pickLatestStableTag(tagRefs: string[]): { tag: string; version: string } | null {
  let best: { tag: string; parsed: ParsedVersion } | null = null;
  for (const raw of tagRefs) {
    // Accept `refs/tags/reverie@0.9.3`, dereferenced `...^{}`, or bare tag names.
    const tag = raw
      .replace(/^.*refs\/tags\//, '')
      .replace(/\^\{\}$/, '')
      .trim();
    if (!tag) continue;
    if (!/^(reverie|aireverie)@\d+\.\d+\.\d+$/.test(tag) && !/^v?\d+\.\d+\.\d+$/.test(tag)) continue;
    const parsed = parseVersionFromTag(tag);
    if (!parsed || parsed.prerelease) continue;
    if (!best || compareVersions(parsed, best.parsed) > 0) {
      best = { tag, parsed };
    }
  }
  if (!best) return null;
  return { tag: best.tag, version: `${best.parsed.major}.${best.parsed.minor}.${best.parsed.patch}` };
}

/** Tags must match this before they're ever passed to the shell. */
export function isValidReleaseTag(tag: string): boolean {
  return /^(reverie|aireverie)@\d+\.\d+\.\d+$/.test(tag);
}

/** Derive `{owner, repo}` from a GitHub SSH or HTTPS remote URL. */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const m = remoteUrl.trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * PURE boot-time reconcile decision. Given the persisted status, the version the
 * freshly-booted process is actually running, and `now`, return the status to
 * persist — or null to leave it untouched.
 *
 * Rules (see plan "Hardening"):
 * - Terminal phases → untouched, EXCEPT `completed-needs-manual-restart`: once we
 *   boot into the staged target version the manual restart evidently happened, so
 *   it flips to `completed` (otherwise the stale instruction lingers in the UI).
 * - Only the `restarting` marker (written right before the updater triggers our
 *   restart) flips to completed/failed by comparing running version vs. target.
 * - Other in-flight phases are owned by the still-running updater scope — leave
 *   them alone so a normal/crash restart mid-update isn't misreported.
 * - A backstop staleness guard fails any in-flight status older than the window.
 */
export function reconcileStatusDecision(
  status: UpdateStatus | null,
  runningVersion: string,
  now: number
): UpdateStatus | null {
  if (!status) return null;

  // A staged update that asked for a manual restart: if we're now running the
  // target version, the user (or supervisor) did restart — mark it completed so
  // the UI stops showing the stale "restart Reverie to apply" instruction.
  if (status.phase === 'completed-needs-manual-restart') {
    if (status.toVersion && runningVersion === status.toVersion) {
      return { ...status, phase: 'completed', message: `Updated to v${runningVersion}`, updatedAt: now };
    }
    return null;
  }

  if (!IN_FLIGHT_PHASES.has(status.phase)) return null;

  if (status.phase === 'restarting') {
    if (status.toVersion && runningVersion === status.toVersion) {
      return { ...status, phase: 'completed', message: `Updated to v${runningVersion}`, updatedAt: now };
    }
    return {
      ...status,
      phase: 'failed',
      message: 'Restarted but version did not change',
      error: `expected ${status.toVersion ?? '?'}, running ${runningVersion}`,
      updatedAt: now,
    };
  }

  // Not the restart marker: only intervene if clearly abandoned.
  if (now - status.startedAt > RECONCILE_STALE_MS) {
    return {
      ...status,
      phase: 'failed',
      message: 'Update did not complete',
      error: `abandoned during "${status.phase}"`,
      updatedAt: now,
    };
  }
  return null;
}

/**
 * PURE runtime staleness check, applied whenever the status is READ (not only on
 * boot). The live updater heartbeats `updatedAt` every few seconds, so an
 * in-flight status whose last write is older than the window has no updater
 * behind it. Without this, a status that never advanced (e.g. the updater could
 * not run its `--node` binary because Homebrew upgraded node under a long-running
 * server, so every status write failed) blocked every later update with "An
 * update is already in progress." until the server happened to restart.
 * Returns the failed status to persist, or null to leave the status untouched.
 */
export function expireStalledStatus(status: UpdateStatus | null, now: number): UpdateStatus | null {
  if (!status || !IN_FLIGHT_PHASES.has(status.phase)) return null;
  const lastWrite = status.updatedAt || status.startedAt;
  if (now - lastWrite <= RECONCILE_STALE_MS) return null;
  return {
    ...status,
    phase: 'failed',
    message: 'Update stopped reporting progress',
    error: `no status update for ${Math.round((now - lastWrite) / 60_000)} min during "${status.phase}"`,
    updatedAt: now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE helpers — the container environment gate
// ─────────────────────────────────────────────────────────────────────────────

/** Host command that resolves every environment blocker. */
export const DOCKER_HOST_UPDATE_COMMAND = 'reverie-request-update';

/**
 * Parse the SET keys out of a dotenv file. Commented-out lines are deliberately
 * NOT keys: `docker/.env.example` uses `# PUID=1000` to document an OPTIONAL
 * override, so treating those as required would block every update on settings
 * the user is meant to leave alone.
 */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/**
 * Keys the TARGET release's `.env.example` sets that the user's `.env` does not.
 *
 * This is the check that makes a new required setting visible: Compose resolves
 * an unset `${VAR}` to the empty string and starts anyway, so a missing key is
 * otherwise silent until something misbehaves at runtime.
 */
export function diffRequiredEnvKeys(targetExample: string, userEnv: string): string[] {
  const have = new Set(parseEnvKeys(userEnv));
  return parseEnvKeys(targetExample).filter((k) => !have.has(k));
}

/**
 * True when the container's restart policy relaunches it after the server exits.
 * `no` and an empty policy mean an in-place update would take Reverie DOWN
 * rather than restart it, so the update is refused instead.
 */
export function isAutoRestartPolicy(name: string | null | undefined): boolean {
  return name === 'always' || name === 'unless-stopped' || name === 'on-failure';
}

/**
 * PURE: may the container updater restart the server by exiting? Yes when the
 * Compose file declared it (`REVERIE_RESTART_BY_EXIT=1`, set only there, since
 * that file is what sets `restart: unless-stopped`) or when the daemon reports an
 * auto-restart policy. Otherwise the answer is NO, and the updater stages the
 * build and asks for a manual restart instead of exiting: an unknown policy is
 * fine to fail open in the GATE (refusing would block installs with no socket),
 * but the kill itself must not fail open, or a container the daemon would not
 * bring back goes down with no UI left to recover it from.
 */
export function shouldRestartByExit(declared: boolean, restartPolicy: string | null): boolean {
  return declared || isAutoRestartPolicy(restartPolicy);
}

/** The Compose file's declaration that exiting relaunches this container. */
export function restartByExitDeclared(): boolean {
  return process.env.REVERIE_RESTART_BY_EXIT === '1';
}

export interface EnvironmentGateInput {
  /** sha256 of `docker/server.Dockerfile` the running container was built from. */
  appliedDockerfileHash: string | null;
  /** sha256 of `docker/server.Dockerfile` at the target release tag. */
  targetDockerfileHash: string | null;
  /** sha256 of `docker/docker-compose.yaml` the running container was created from. */
  appliedComposeHash: string | null;
  /** sha256 of `docker/docker-compose.yaml` at the target release tag. */
  targetComposeHash: string | null;
  /** Keys from `diffRequiredEnvKeys()`. */
  missingEnvKeys: string[];
  /** Docker restart policy name of the running container, or null if unknown. */
  restartPolicy: string | null;
}

/**
 * PURE gate decision. An in-place container update applies CODE only: the server
 * exits and the container's restart policy relaunches it on the new `dist/`. A
 * restart reuses the existing container's image and config, so anything that
 * changes the ENVIRONMENT cannot take effect that way and is refused here with
 * the host command that can apply it.
 *
 * ⚠️ An unknown hash (null) is NOT treated as "changed": a first update from a
 * container created before the fingerprint file existed has no baseline, and
 * failing closed there would block every such install from ever updating. The
 * baseline is written by `Start-Reverie.sh`, so it exists from the first
 * host-side start onward. An unknown restart policy is likewise not a blocker —
 * the shipped Compose file sets `unless-stopped`, and the probe needs the Docker
 * socket, which a user may not have mounted.
 */
export function computeEnvironmentBlockers(input: EnvironmentGateInput): EnvironmentBlocker[] {
  const blockers: EnvironmentBlocker[] = [];

  if (
    input.appliedDockerfileHash &&
    input.targetDockerfileHash &&
    input.appliedDockerfileHash !== input.targetDockerfileHash
  ) {
    blockers.push({
      kind: 'dockerfile-changed',
      message: 'This release changes docker/server.Dockerfile, so the image must be rebuilt.',
    });
  }

  if (input.appliedComposeHash && input.targetComposeHash && input.appliedComposeHash !== input.targetComposeHash) {
    blockers.push({
      kind: 'compose-changed',
      message: 'This release changes docker/docker-compose.yaml, so the container must be recreated.',
    });
  }

  if (input.missingEnvKeys.length > 0) {
    blockers.push({
      kind: 'env-keys-missing',
      message: `This release adds ${input.missingEnvKeys.length} setting(s) your docker/.env has no value for.`,
      details: input.missingEnvKeys,
    });
  }

  if (input.restartPolicy !== null && !isAutoRestartPolicy(input.restartPolicy)) {
    blockers.push({
      kind: 'no-auto-restart',
      message: `This container's restart policy is "${input.restartPolicy}", so it would not come back after the update.`,
    });
  }

  return blockers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status file IO
// ─────────────────────────────────────────────────────────────────────────────

/** Read the persisted status; tolerant of a missing/torn file (returns null). */
export function readUpdateStatus(): UpdateStatus | null {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    return JSON.parse(readFileSync(STATUS_FILE, 'utf-8')) as UpdateStatus;
  } catch {
    return null;
  }
}

/** Write the status atomically (temp + rename — readers never see a torn file). */
export function writeUpdateStatusAtomic(status: UpdateStatus): void {
  const tmp = `${STATUS_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(status, null, 2));
  renameSync(tmp, STATUS_FILE);
}

/** Read the status, first failing (and persisting) an in-flight one that stopped heartbeating. */
function readCurrentUpdateStatus(now = Date.now()): UpdateStatus | null {
  const status = readUpdateStatus();
  const expired = expireStalledStatus(status, now);
  if (!expired) return status;
  try {
    writeUpdateStatusAtomic(expired);
  } catch {
    // Still report the expired view; the next read retries the write.
  }
  return expired;
}

/** Reconcile the status file on server boot (call once, early in start()). */
export function reconcileUpdateOnBoot(now = Date.now()): void {
  const status = readUpdateStatus();
  const next = reconcileStatusDecision(status, APP_VERSION, now);
  if (next) writeUpdateStatusAtomic(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment probing (git / supervisor / install kind)
// ─────────────────────────────────────────────────────────────────────────────

/** Run a command, returning trimmed stdout, or null on any error. */
function tryExec(cmd: string, args: string[], cwd?: string, timeout = EXEC_TIMEOUT_MS): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the repo root from this module's location. Compiled to
 * `dist/web/self-update.js` (or `src/web/self-update.ts` under tsx) → two levels
 * up is the package root that holds `package.json` and `.git`. Matches the
 * `require('../../package.json')` resolution in `server.ts`.
 */
export function resolveInstallDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const root = join(moduleDir, '..', '..');
  if (existsSync(join(root, 'package.json'))) return root;
  return process.cwd();
}

/**
 * True when this process runs inside a container. `/.dockerenv` is created by the
 * Docker daemon itself; the env var is set by our own Compose file so the check
 * also holds under runtimes that omit that file.
 */
export function isRunningInContainer(): boolean {
  return process.env.REVERIE_IN_CONTAINER === '1' || existsSync('/.dockerenv');
}

function detectInstallKind(dir: string): InstallKind {
  // A container whose code is a bind-mounted checkout updates in place (the pull
  // and build land on the host filesystem and survive container recreation). A
  // container WITHOUT that mount runs a baked image copy — a pull there would go
  // to the writable layer and vanish on the next `up`, so it is not updatable.
  if (existsSync(join(dir, '.git'))) return isRunningInContainer() ? 'docker-compose' : 'git';
  // Global npm install ships only dist/ (no src/, no .git).
  if (!existsSync(join(dir, 'src'))) return 'npm';
  return 'unknown';
}

/** The refusal every update path returns: no install updates itself in place. */
export const NIX_UPDATE_MESSAGE = 'Upgrade the Nix package or rebuild the image.';

/** Immutable Nix installations are updated by their package manager, never by the console. */
export function isNixManagedInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REVERIE_MANAGED_INSTALL === 'nix';
}

export function canSelfUpdateInPlace(kind: InstallKind): boolean {
  if (isNixManagedInstall()) return false;
  return kind === 'git' || kind === 'docker-compose';
}

/** Path of the fingerprint baseline written by `reverie-request-update`. */
const DOCKER_ENV_APPLIED_FILE = dataPath('docker-env-applied.json');

/** Files whose content defines the container ENVIRONMENT (vs. the app's code). */
const DOCKERFILE_REL = 'docker/server.Dockerfile';
const COMPOSE_REL = 'docker/docker-compose.yaml';
const ENV_EXAMPLE_REL = 'docker/.env.example';
const ENV_REL = 'docker/.env';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Read a file at a git TAG without checking it out (`git show tag:path`). */
function gitShowAtTag(repo: string, tag: string, relPath: string): string | null {
  return tryExec('git', ['show', `${tag}:${relPath}`], repo);
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The fingerprints the RUNNING container was created from, recorded on the host
 * by `Start-Reverie.sh` at each build/recreate. Returns nulls when absent (a
 * container started before this file existed) — `computeEnvironmentBlockers()`
 * deliberately treats an unknown baseline as "not a blocker".
 */
function readAppliedEnvironmentFingerprints(): { dockerfile: string | null; compose: string | null } {
  const raw = readFileOrNull(DOCKER_ENV_APPLIED_FILE);
  if (!raw) return { dockerfile: null, compose: null };
  try {
    const parsed = JSON.parse(raw) as { dockerfileSha256?: string; composeSha256?: string };
    return { dockerfile: parsed.dockerfileSha256 ?? null, compose: parsed.composeSha256 ?? null };
  } catch {
    return { dockerfile: null, compose: null };
  }
}

/**
 * Restart policy of the container we're running in, via the mounted Docker
 * socket. Returns null when the socket or CLI is unavailable — an unknown policy
 * is not a blocker (see `computeEnvironmentBlockers`).
 */
function detectOwnRestartPolicy(): string | null {
  // Docker sets HOSTNAME to the short container id; os.hostname() is the same
  // value when the env var is absent. A custom `hostname:` in the compose file
  // makes both unresolvable to the daemon, which fails open (unknown is not a
  // blocker) rather than refusing an update over a cosmetic setting.
  const id = process.env.HOSTNAME || hostname();
  if (!id) return null;
  const out = tryExec('docker', ['inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', id]);
  return out && out.length > 0 ? out : null;
}

/**
 * Evaluate the environment gate for a candidate release tag. Reads the TARGET
 * tag's files straight out of git (`git show`), so nothing is checked out and the
 * answer is available at CHECK time — the UI can refuse before the user commits
 * to an update.
 */
export function evaluateEnvironmentGate(installDir: string, tag: string): EnvironmentGate {
  // `git show <tag>:<path>` needs the tag's objects locally, and neither the
  // GitHub API nor `ls-remote` fetches anything — so a check that has never seen
  // this tag would read nothing and report a falsely clean gate. Fetch the one
  // ref first (cheap: it deltas against what the clone already has) and only
  // then read. The updater fetches the same ref again; both are idempotent.
  if (tryExec('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], installDir) === null) {
    tryExec(
      'git',
      ['fetch', '--tags', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`],
      installDir,
      CHECK_TIMEOUT_MS
    );
  }

  const targetDockerfile = gitShowAtTag(installDir, tag, DOCKERFILE_REL);
  const targetCompose = gitShowAtTag(installDir, tag, COMPOSE_REL);
  const targetExample = gitShowAtTag(installDir, tag, ENV_EXAMPLE_REL);

  // No environment files at the target tag at all: we cannot judge, so say so
  // rather than reporting a clean gate the caller would trust.
  if (targetDockerfile === null && targetCompose === null && targetExample === null) {
    return { checked: false, blockers: [], hostCommand: DOCKER_HOST_UPDATE_COMMAND };
  }

  const applied = readAppliedEnvironmentFingerprints();
  const userEnv = readFileOrNull(join(installDir, ENV_REL));

  const blockers = computeEnvironmentBlockers({
    appliedDockerfileHash: applied.dockerfile,
    targetDockerfileHash: targetDockerfile === null ? null : sha256(targetDockerfile),
    appliedComposeHash: applied.compose,
    targetComposeHash: targetCompose === null ? null : sha256(targetCompose),
    // A missing/unreadable .env cannot be diffed — report no missing keys rather
    // than every key, which would block on an install using a non-standard path.
    missingEnvKeys: targetExample !== null && userEnv !== null ? diffRequiredEnvKeys(targetExample, userEnv) : [],
    restartPolicy: detectOwnRestartPolicy(),
  });

  return { checked: true, blockers, hostCommand: DOCKER_HOST_UPDATE_COMMAND };
}

/**
 * Detect which init system supervises us. Detection happens HERE (in the running
 * server, which has a rich env) and the result is passed to the updater script —
 * the detached child must not re-probe with a stripped-down environment.
 */
export function detectSupervisor(): SupervisorKind {
  // Checked FIRST: a container has no init system of its own, and its "restart"
  // is the server exiting so the Docker restart policy relaunches it. Probing
  // systemd here would find nothing and report `none`, which stages the update
  // and then asks the user to restart by hand for no reason.
  if (isRunningInContainer()) return 'docker-compose';
  if (process.platform === 'darwin') {
    if (existsSync(join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))) return 'launchd';
    // Headless Macs (no GUI login → no gui domain) run Reverie as a system-level
    // LaunchDaemon instead. Restarting one needs no root IF it has KeepAlive: the
    // updater just kills the server and launchd respawns it on the new build. Only
    // claim this supervisor when the daemon is actually bootstrapped and KeepAlive.
    const daemonPlist = join('/Library/LaunchDaemons', `${LAUNCHD_LABEL}.plist`);
    if (existsSync(daemonPlist)) {
      const loaded = tryExec('launchctl', ['print', `system/${LAUNCHD_LABEL}`]) !== null;
      const keepAlive = tryExec('plutil', ['-extract', 'KeepAlive', 'raw', '-o', '-', daemonPlist]);
      if (loaded && keepAlive === 'true') return 'launchd-daemon';
    }
    return 'none';
  }
  if (process.platform === 'linux') {
    // INVOCATION_ID is set by systemd for service processes; confirm with is-active.
    if (process.env.INVOCATION_ID && tryExec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]) === 'active') {
      return 'systemd';
    }
    if (tryExec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]) === 'active') return 'systemd';
  }
  return 'none';
}

/** Inspect the running install: kind, dir, branch, dirtiness, supervisor, version. */
export function getInstallInfo(): InstallInfo {
  const installDir = resolveInstallDir();
  const installKind = detectInstallKind(installDir);
  let branch: string | undefined;
  let dirty = false;
  if (installKind === 'git') {
    branch = tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], installDir) ?? undefined;
    const porcelain = tryExec('git', ['status', '--porcelain'], installDir);
    dirty = !!porcelain && porcelain.length > 0;
  }
  return {
    installKind,
    installDir,
    branch,
    dirty,
    supervisor: detectSupervisor(),
    currentVersion: APP_VERSION,
    selfUpdateEnabled: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update check (network)
// ─────────────────────────────────────────────────────────────────────────────

/** Check the configured remote for a newer release than the running version. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return {
    currentVersion: APP_VERSION,
    latestVersion: null,
    latestTag: null,
    updateAvailable: false,
    notes: null,
    htmlUrl: null,
    checkedAt: Date.now(),
    source: 'none',
    error: NIX_UPDATE_MESSAGE,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Start an update
// ─────────────────────────────────────────────────────────────────────────────

export type StartUpdateResult =
  | { ok: true; updateId: string; toTag: string; toVersion: string | null }
  | {
      ok: false;
      code: 'disabled' | 'not-git' | 'in-flight' | 'up-to-date' | 'bad-tag' | 'env-blocked' | 'error';
      message: string;
    };

/**
 * Refuse the update. No install kind updates itself in place any more
 * (`getInstallInfo` reports `selfUpdateEnabled: false` for all of them): a Nix
 * package upgrade or a rebuilt image replaces the install instead.
 */
export async function startUpdate(): Promise<StartUpdateResult> {
  return { ok: false, code: 'disabled', message: NIX_UPDATE_MESSAGE };
}

/** Current status for the polling endpoint; null collapses to an explicit idle. */
export function getUpdateStatusForApi(): UpdateStatus {
  const status = readCurrentUpdateStatus();
  if (status) return status;
  return {
    updateId: '',
    phase: 'idle',
    message: '',
    fromVersion: APP_VERSION,
    startedAt: 0,
    updatedAt: 0,
  };
}
