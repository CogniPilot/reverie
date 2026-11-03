/**
 * @fileoverview Cron service: CRUD for cron jobs, manual Run Now,
 * the background due-job tick, and run-history recording.
 *
 * It does NOT own session/tmux logic — it reuses Reverie's existing session
 * layer (create → addSession → setupSessionListeners → startInteractive/Shell →
 * send prompt via writeViaMux/write), mirroring the "quick start" route flow.
 */

import type { AuthorQuotaStore } from './author-quota.js';
import { v4 as uuidv4 } from 'uuid';
import { readFile } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { getCli } from '../config/cli-registry/registry.js';
import { resolveCliLaunchError } from '../utils/cli-launcher.js';
import { Session } from '../session.js';
import { applyWorkspaceHooks } from '../hooks-config.js';
import { SseEvent } from '../web/sse-events.js';
import { CronJobSchema } from '../web/schemas.js';
import { getErrorMessage, createErrorResponse, ApiErrorCode } from '../types/api.js';
import { MAX_CONCURRENT_SESSIONS, MAX_CRON_JOBS, MAX_CRON_RUN_HISTORY } from '../config/map-limits.js';
import { canUsernameRunPrivilegedCommands, resolveClaudeModeForUsername } from '../user-store.js';
import { sessionCapacityState, isWorkingDirAllowedForUsername } from '../web/route-helpers.js';
import { CRON_PASTE_ENTER_DELAY_MS, CRON_READY_MAX_ATTEMPTS, CRON_READY_SETTLE_MS } from '../config/server-timing.js';
import {
  DEFAULT_BLOCKED_TREES,
  isBlockedAttachmentPath,
  loadAttachmentGuardConfig,
} from '../config/attachment-guard.js';
import { validateSessionFilePath } from '../web/route-helpers.js';
import { computeNextRunAt, dueKeyFor } from './cron-time.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../web/ports/index.js';
import type { CronJob, CronJobRun, CronJobRunStatus, TriggerType, InputMode, PromptMode, ConcurrencyPolicy } from '../types/cron.js';
import type { ChatBot } from '../chat-bots.js';
import { conditionHolds, renderTemplate, type PostSources } from './post-sources.js';
import type { GeminiConfig, PiConfig, SessionMode } from '../types/session.js';
import type { CronJobInput } from './cron-input.js';
import { fixedTarget, fixedTargetId, parseWatchCursor, FIXED_WATCH_LIMITS, type WatchSnapshot } from './fixed-github-watch.js';

/** The subset of the route context the cron depends on. */
export type CronDeps = SessionPort & EventPort & ConfigPort & InfraPort;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Section 6.3 clamp for a cron-launched external CLI, mirroring
 * `clampExternalCliBypassForOwner()` in session-routes.ts.
 *
 * A cron job carries NO per-CLI config, so what a non-granted owner actually gets is
 * each CLI's SPAWN DEFAULT, and for two of them that default is itself unsafe:
 *  - gemini: `buildGeminiCommand(undefined)` emits `--approval-mode yolo` (classifier-free),
 *    so `auto_edit` is materialized.
 *  - pi: pi's own `defaultProjectTrust` is an interactive prompt the session user can simply
 *    answer "yes" to, which then loads and EXECUTES repo-local `.pi/extensions` TypeScript,
 *    so `approveProjectTrust: false` (`--no-approve`) is materialized. Omitting `--approve`
 *    is NOT a clamp.
 * Codex, antigravity, grok and deepseek need nothing here: their absent config already spawns safe
 * (grok's bare spawn is its own ask-mode default and deepseek's omits DSH_PERMISSION_MODE
 * entirely, leaving the harness on workspace-write, which asks; both switches are only ever sent).
 * Granted/admin/single-user get undefined for both, i.e. upstream defaults untouched.
 */
export function clampCronExternalCliConfigs(
  mode: SessionMode,
  ownerGranted: boolean
): { geminiConfig: GeminiConfig | undefined; piConfig: PiConfig | undefined } {
  if (ownerGranted) return { geminiConfig: undefined, piConfig: undefined };

  // A cron job carries no per-CLI config at all, so ONLY the materialize-when-absent params
  // can apply here — an only-if-sent clamp has nothing to clamp. Reading them off the
  // registry rather than naming gemini and pi means a future CLI whose bare spawn is unsafe
  // is covered the moment its entry says so, instead of silently missing this path.
  const entry = getCli(mode);
  const aliases = entry?.launch.legacyConfigAliases ?? {};
  const materialized: Record<string, unknown> = {};
  for (const { param, clampTo, materializeWhenAbsent } of entry?.capabilities.privilegedParams ?? []) {
    // Same registry-param → legacy-wire-field hop the HTTP clamp makes. Neither gemini's
    // `approvalMode` nor pi's `approveProjectTrust` is aliased today, so this changes nothing
    // now — but the two are DIFFERENT namespaces, and writing the raw param here would make
    // this path stop clamping the moment one of them gained an alias, silently.
    if (materializeWhenAbsent) materialized[aliases[param] ?? param] = clampTo;
  }
  const has = Object.keys(materialized).length > 0;
  const field = entry?.launch.legacyConfigField;
  return {
    geminiConfig: has && field === 'geminiConfig' ? (materialized as GeminiConfig) : undefined,
    piConfig: has && field === 'piConfig' ? (materialized as PiConfig) : undefined,
  };
}

/** Hard ceiling on a prompt-file read (defends against unbounded-read DoS). */
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;

/**
 * Pseudo-filesystem trees a cron job may never touch, ON TOP of the shared
 * attachment blocklist. `/proc` in particular defeats the workingDir
 * confinement trick (`workingDir: '/proc'` + `promptFilePath:
 * '/proc/self/environ'` would read the SERVER's own environment).
 */
const CRON_PSEUDO_FS_TREES: readonly string[] = ['/proc', '/sys', '/dev'];

/** Sync blocklist for the create/update workingDir gate (no settings extras). */
const CRON_WORKING_DIR_BLOCKED_TREES: readonly string[] = [...DEFAULT_BLOCKED_TREES, ...CRON_PSEUDO_FS_TREES];

/** Prompt delivery is single-line only (writeViaMux/Ink constraint). */
const HAS_NEWLINE = /[\r\n]/;

/** The three session calls prompt delivery needs, so it can be tested without a PTY. */
type CronPromptTarget = Pick<Session, 'write' | 'writeViaMux' | 'verifySubmitted'>;

/**
 * Send a cron job's (single-line) prompt into its session and press Enter.
 *
 * `typed` goes through the mux: the text is typed, Enter is its own key, and the
 * session re-presses it while the prompt is still on the composer.
 *
 * `paste` writes the text straight into the PTY, and must send its Enter as a
 * SEPARATE write. It used to send `<text>\r` in one piece, and Claude Code (measured
 * on 2.1.283) takes a burst of about a hundred characters as a paste, so the `\r`
 * landed as a newline and the prompt sat unsent while the run reported
 * `prompt_sent`. The Enter goes down the same PTY as the text, so it cannot overtake
 * it, and the same composer check then covers a CLI that was not taking Enter yet.
 *
 * @returns false when the session had no PTY or mux to write to
 */
export async function deliverCronPrompt(
  target: CronPromptTarget,
  prompt: string,
  inputMode: CronJob['inputMode'],
  wait: (ms: number) => Promise<void> = delay
): Promise<boolean> {
  if (inputMode !== 'paste') {
    return target.writeViaMux(prompt.endsWith('\r') ? prompt : `${prompt}\r`, { opencodeGuard: true });
  }
  const text = prompt.replace(/[\r\n]+$/, '');
  if (!target.write(text)) return false;
  await wait(CRON_PASTE_ENTER_DELAY_MS);
  if (!target.write('\r')) return false;
  target.verifySubmitted(text);
  return true;
}

/** Order-insensitive equality for the weekly-days arrays. */
function sameDays(a: number[] | undefined, b: number[] | undefined): boolean {
  const x = [...(a ?? [])].sort((p, q) => p - q);
  const y = [...(b ?? [])].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** What Run once would do now (CronService.preview). Nothing in it has happened. */
export interface CronRunPreview {
  jobId: string;
  name: string;
  action: 'launch' | 'post';
  generatedAt: number;
  /** post: posts a message; dry-run: records a dry run only; skip: the source condition is not met; launch: starts a session. */
  outcome: 'post' | 'dry-run' | 'skip' | 'launch' | 'blocked' | 'not-previewed';
  reason?: string;
  sender?: string;
  roomId?: string;
  /** The message that would be posted, or the prompt a session would get. */
  text?: string;
  /** A data source read for this preview. */
  readsSource?: string;
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
  /** What Run once would change. */
  effects: string[];
}

/** What a 'post' job needs from the chat side; wired by the server once the chat service exists. */
export interface BotPoster {
  getBot(id: string): ChatBot | undefined;
  /** Throws when the bot may not post in the room now (allowlist, hourly cap, archived room, unknown room). */
  check(bot: ChatBot, roomId: string, recentPosts: number): void;
  post(bot: ChatBot, roomId: string, text: string, recentPosts: number): void;
  postWatchNotice?(bot: ChatBot, roomId: string, text: string, recentPosts: number, owner?: string): { messageId: string };
  /**
   * Post as the employee who owns an author routine, with the server's "routine" prefix. Throws with a plain message when the
   * employee is gone, no longer sits in the room, or the room is archived. Optional: without it author routines fail their run.
   */
  postAsAuthor?(employeeId: string, roomId: string, text: string): { name: string };
  /** The same checks as postAsAuthor, without posting (for a run preview); throws with the same plain message. */
  canPostAsAuthor?(employeeId: string, roomId: string): void;
  /** One system line in the routine's room, also queued for its author, telling them the routine was disabled. */
  notifyDisabled?(employeeId: string, roomId: string, text: string): void;
}

/** Author routines: consecutive failed fires before the routine switches itself off, and posts an hour per author. */
export const AUTHOR_FAIL_LIMIT = 3;
export const AUTHOR_POSTS_PER_HOUR = 30;

/** A post job that missed its time by more than this (server down, long pause) is skipped, not sent late. */
export const POST_CATCH_UP_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

export class CronService {
  private poster: BotPoster | undefined;
  private postSources: PostSources = {};
  private executingJobs = new Map<string, { job: Pick<CronJob, 'id' | 'name' | 'owner'>; count: number }>();

  constructor(private readonly deps: CronDeps) {}

  setBotPoster(poster: BotPoster): void {
    this.poster = poster;
  }

  setPostSources(sources: PostSources): void {
    this.postSources = sources;
  }

  private get store() {
    return this.deps.store;
  }

  // ───────────────────────────── Reads ─────────────────────────────

  listJobs(): CronJob[] {
    return Object.values(this.store.getCronJobs());
  }

  /** Actual executions in this scheduler process, never inferred from persisted run history. */
  listRunningJobs(): Array<Pick<CronJob, 'id' | 'name' | 'owner'>> {
    return [...this.executingJobs.values()].map(({ job }) => ({ ...job }));
  }

  getJob(id: string): CronJob | null {
    return this.store.getCronJob(id);
  }

  listRuns(jobId?: string): CronJobRun[] {
    const all = Object.values(this.store.getCronJobRuns());
    const filtered = jobId ? all.filter((r) => r.cronJobId === jobId) : all;
    return filtered.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Number of LIVE sessions of a given agent type (for the multi-session
   * warning and the skip_if_same_agent_running policy). Sessions whose CLI has
   * exited (`stopped`/`error` — the tab is still open but nothing is running)
   * don't count. When `excludeJobId` is given, sessions created by that job's
   * own runs are also excluded — otherwise a recurring job with the skip
   * policy would deadlock on its own previous (never-closed) session and fire
   * exactly once, forever skipping after that.
   */
  countActiveAgents(agentType: string, excludeJobId?: string): number {
    const ownSessionIds = excludeJobId
      ? new Set(
          this.listRuns(excludeJobId)
            .map((r) => r.sessionId)
            .filter((id): id is string => id !== null)
        )
      : null;
    let n = 0;
    for (const [id, s] of this.deps.sessions.entries()) {
      if (s.mode !== agentType) continue;
      if (s.status === 'stopped' || s.status === 'error') continue;
      if (ownSessionIds?.has(id)) continue;
      n++;
    }
    return n;
  }

  // ──────────────────────────── Mutations ───────────────────────────

  createJob(input: CronJobInput, owner?: string, createdBy?: CronJob['createdBy'], createdByOwner = false): CronJob {
    if (input.postSourceArgs?.pull !== undefined) {
      if (!createdByOwner || createdBy) throw this.badRequest('Only the verified owner can configure a fixed watcher');
      this.assertFixedWatchInput(input);
      if (this.listJobs().some(j => j.postSourceArgs?.pull !== undefined)) throw this.badRequest('Only one fixed watcher job is supported per console, including disabled jobs');
    }
    if (Object.keys(this.store.getCronJobs()).length >= MAX_CRON_JOBS) {
      throw this.badRequest(`Maximum number of cron jobs (${MAX_CRON_JOBS}) reached`);
    }
    const action = input.action ?? 'launch';
    if (action === 'launch') this.assertValidWorkingDir(input.workingDir as string);
    const now = Date.now();
    const job: CronJob = {
      id: uuidv4(),
      ...(input.postSourceArgs?.pull !== undefined ? { watchGeneration: uuidv4() } : {}),
      name: input.name,
      owner,
      ...(!createdBy && createdByOwner ? { createdByOwner: true as const } : {}),
      ...(action === 'post'
        ? {
            action,
            ...(createdBy ? { postAs: 'author' as const, createdBy } : { botId: input.botId }),
            roomId: input.roomId,
            postText: input.postText,
            dryRun: input.dryRun === true,
            ...(input.postSource ? { postSource: input.postSource } : {}),
            ...(input.postSourceArgs ? { postSourceArgs: input.postSourceArgs } : {}),
            ...(input.postWhen ? { postWhen: input.postWhen } : {}),
            ...(input.postChangeOnly ? { postChangeOnly: true } : {}),
            // Neutral placeholders: a post job never starts a session, so none of these is read.
            agentType: 'shell' as const,
            workingDir: '/',
            promptMode: 'inline_text' as const,
            inputMode: 'paste' as const,
            concurrencyPolicy: 'warn_only' as const,
          }
        : {
            agentType: input.agentType as SessionMode,
            workingDir: input.workingDir as string,
            promptMode: input.promptMode as PromptMode,
            inputMode: input.inputMode as InputMode,
            concurrencyPolicy: input.concurrencyPolicy as ConcurrencyPolicy,
          }),
      launchCommand: input.launchCommand,
      promptText: input.promptText,
      promptFilePath: input.promptFilePath,
      timeZone: input.timeZone,
      scheduleType: input.scheduleType,
      runAt: input.runAt,
      intervalMinutes: input.intervalMinutes,
      dailyTime: input.dailyTime,
      weeklyDays: input.weeklyDays,
      weeklyTime: input.weeklyTime,
      enabled: input.enabled,
      notes: input.notes,
      autoClosePreviousSession: input.autoClosePreviousSession ?? true,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      lastDueKey: null,
    };
    job.nextRunAt = job.enabled ? computeNextRunAt(job, now) : null;
    this.store.setCronJob(job.id, job);
    this.broadcastListChanged();
    return job;
  }

  updateJob(id: string, patch: Partial<CronJobInput>): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    this.assertRecoveryCertain(existing);
    if (existing.postSourceArgs?.pull !== undefined && (!existing.watchGeneration || existing.watchState?.pending || this.executingJobs.has(id))) {
      throw this.badRequest('WATCH_DELIVERY_UNCERTAIN or running: disable and retain this job for owner reconciliation; edits cannot reset its delivery fence');
    }
    const fixed = patch.postSourceArgs?.pull !== undefined || (patch.postSourceArgs === undefined && existing.postSourceArgs?.pull !== undefined);
    if (fixed) {
      if (!existing.createdByOwner || existing.createdBy) throw this.badRequest('Only an owner-created job can be a fixed watcher');
      this.assertFixedWatchInput({ ...existing, ...patch });
      if (this.listJobs().some(j => j.id !== id && j.postSourceArgs?.pull !== undefined)) throw this.badRequest('Only one fixed watcher job is supported per console');
    }
    const now = Date.now();

    // A completed one-time job is only re-armed when the SCHEDULE actually
    // CHANGES — otherwise a cosmetic edit would silently resurrect a job that
    // already fired. We compare VALUES, not field-presence: the edit form
    // round-trips the full job (incl. unchanged scheduleType/runAt) on every
    // save, so a presence check would always re-arm. Only a real schedule
    // change re-arms.
    const changed = <T>(next: T | undefined, prev: T): boolean => next !== undefined && next !== prev;
    const scheduleChanged =
      changed(patch.scheduleType, existing.scheduleType) ||
      changed(patch.runAt, existing.runAt) ||
      changed(patch.intervalMinutes, existing.intervalMinutes) ||
      changed(patch.dailyTime, existing.dailyTime) ||
      changed(patch.timeZone, existing.timeZone) ||
      changed(patch.weeklyTime, existing.weeklyTime) ||
      (patch.weeklyDays !== undefined && !sameDays(patch.weeklyDays, existing.weeklyDays));
    const reArm = existing.scheduleType !== 'once' || !existing.completedOnce || scheduleChanged;

    const { postWhen: patchWhen, ...patchRest } = patch;
    const updated: CronJob = {
      ...existing,
      ...patchRest,
      // null clears a saved condition; undefined keeps it.
      ...(patchWhen === undefined ? {} : patchWhen === null ? { postWhen: undefined } : { postWhen: patchWhen }),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      completedOnce: reArm ? false : existing.completedOnce,
      lastDueKey: null,
      ...(fixed ? { watchGeneration: uuidv4(), watchState: undefined } : {}),
    };

    if (updated.postWhen === undefined) delete updated.postWhen;
    if (!updated.postChangeOnly) delete updated.postLastText;
    // A cursor belongs to one repository: pointing the job elsewhere starts over from a baseline.
    const sameFixedTarget = updated.postSourceArgs?.pull !== undefined && existing.postSourceArgs?.pull !== undefined &&
      fixedTargetId(fixedTarget(updated.postSourceArgs)) === fixedTargetId(fixedTarget(existing.postSourceArgs));
    if (!sameFixedTarget && JSON.stringify(updated.postSourceArgs) !== JSON.stringify(existing.postSourceArgs)) delete updated.postLastText;

    // The PUT schema is `.partial()`, so its cross-field rules don't run on a
    // partial body. Re-validate the MERGED job against the full schema so a
    // partial edit can't leave an enabled job with an inconsistent schedule
    // (e.g. switching to `once` without a `runAt` → a dead `nextRunAt:null`).
    const check = CronJobSchema.safeParse(updated);
    if (!check.success) {
      throw this.badRequest(check.error.issues[0]?.message ?? 'Invalid cron job update');
    }
    if (patch.workingDir !== undefined && (existing.action ?? 'launch') === 'launch') this.assertValidWorkingDir(patch.workingDir);

    updated.nextRunAt = updated.enabled ? computeNextRunAt(updated, now) : null;
    this.store.setCronJob(updated.id, updated);
    this.broadcastListChanged();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    if (enabled) this.assertRecoveryCertain(existing);
    const now = Date.now();
    if (existing.postSourceArgs?.pull !== undefined && enabled && !existing.watchGeneration) throw this.badRequest('Recovered watcher has no current generation; owner reconciliation required');
    existing.enabled = enabled;
    if (existing.postSourceArgs?.pull !== undefined && existing.watchGeneration) existing.watchGeneration = uuidv4();
    if (enabled) delete existing.failStreak;
    existing.updatedAt = now;
    existing.nextRunAt = enabled ? computeNextRunAt(existing, now) : null;
    this.store.setCronJob(existing.id, existing);
    this.broadcastListChanged();
    return existing;
  }

  deleteJob(id: string): boolean {
    const existing = this.getJob(id);
    if (!existing) return false;
    this.assertRecoveryCertain(existing);
    if (existing.postSourceArgs?.pull !== undefined && (!existing.watchGeneration || existing.watchState?.pending || this.executingJobs.has(id))) throw this.badRequest('Retain uncertain/running watcher receipts for owner reconciliation');
    this.store.removeCronJob(id);
    for (const run of this.listRuns(id)) this.store.removeCronJobRun(run.id);
    this.deps.broadcast(SseEvent.CronJobDeleted, { id });
    this.broadcastListChanged();
    return true;
  }

  // ──────────────────────────── Execution ───────────────────────────

  /** Manual Run Now — always launches regardless of schedule/enabled state. */
  async runNow(id: string): Promise<CronJobRun | null> {
    const job = this.getJob(id);
    if (!job) return null;
    return this.launch(job, 'manual_run_now');
  }

  /**
   * What Run once would do now, without doing it: no run record, status, schedule, change key, post, session or broadcast.
   * Reading a post job's data source is the one outside call it makes (a read). Checks are the ones the run itself makes.
   */
  async preview(id: string): Promise<CronRunPreview | null> {
    const job = this.getJob(id);
    if (!job) return null;
    const checks: CronRunPreview['checks'] = [];
    const check = (label: string, fn: () => string | void): boolean => {
      try {
        const detail = fn();
        checks.push({ label, ok: true, ...(detail ? { detail } : {}) });
        return true;
      } catch (err) {
        checks.push({ label, ok: false, detail: getErrorMessage(err) });
        return false;
      }
    };
    const base = { jobId: job.id, name: job.name, action: job.action ?? 'launch', generatedAt: Date.now(), checks };
    const unchanged = 'Does not change the schedule or the next run time.';
    if (job.recoveryUncertain)
      return { ...base, outcome: 'blocked', reason: 'Held after a backup restore; the owner must reconcile it first.', effects: [] };
    if (job.postSourceArgs?.pull !== undefined)
      return { ...base, outcome: 'not-previewed', reason: 'Repository watchers are not previewed: Run once queries GitHub and posts only new activity.',
        effects: ['May post one notice and move the watcher cursor.', unchanged] };
    if ((job.action ?? 'launch') === 'post') {
      const room = job.roomId as string;
      if (job.postAs === 'author') {
        const employeeId = job.createdBy?.employeeId;
        const ready = check('Author can post', () => {
          if (!employeeId || !this.poster?.postAsAuthor) throw new Error('This routine has no author who can post');
          // Without the read-only check the answer is unknown, so it is not shown as passing.
          if (!this.poster.canPostAsAuthor) throw new Error('Not verified: this server cannot check the author without posting');
          this.poster.canPostAsAuthor(employeeId, room);
        }) && check('Author hourly limit', () => {
          const used = this.recentAuthorPosts(employeeId as string, Date.now());
          if (used >= AUTHOR_POSTS_PER_HOUR) throw new Error(`Limit of ${AUTHOR_POSTS_PER_HOUR} routine posts an hour reached`);
          return `${used} of ${AUTHOR_POSTS_PER_HOUR} used this hour`;
        });
        if (!ready) return { ...base, outcome: 'blocked', sender: 'Routine author', roomId: room, effects: ['Records a failed run in history.', unchanged] };
        return job.dryRun
          ? { ...base, outcome: 'dry-run', sender: 'Routine author', roomId: room, text: job.postText, effects: ['Records a dry run in history; posts nothing.', unchanged] }
          : { ...base, outcome: 'post', sender: 'Routine author', roomId: room, text: job.postText,
            effects: ['Posts one message as the routine author in the room.', 'Records the run in history.', unchanged] };
      }
      const bot = job.botId ? this.poster?.getBot(job.botId) : undefined;
      const sender = bot?.name ?? job.botId ?? 'Bot';
      if (!check('Bot is registered', () => { if (!this.poster || !bot) throw new Error(`No bot "${job.botId ?? ''}" is registered`); }))
        return { ...base, outcome: 'blocked', sender, roomId: room, effects: ['Records a failed run in history.', unchanged] };
      let text = job.postText as string;
      if (job.postSource) {
        let sourced: { text: string | null; reason: string };
        try {
          sourced = await this.renderSourcePost(job, true);
          checks.push({ label: `Data source "${job.postSource}" reads`, ok: true });
        } catch (err) {
          checks.push({ label: `Data source "${job.postSource}" reads`, ok: false, detail: getErrorMessage(err) });
          return { ...base, outcome: 'blocked', sender, roomId: room, readsSource: job.postSource, effects: ['Records a failed run in history.', unchanged] };
        }
        if (sourced.text === null)
          return { ...base, outcome: 'skip', reason: sourced.reason, sender, roomId: room, readsSource: job.postSource,
            effects: ['Records a skipped run in history; posts nothing.', unchanged] };
        text = sourced.text;
      }
      const allowed = check('Bot may post in this room now', () => {
        this.poster!.check(bot!, room, this.recentBotPosts(bot!.id, Date.now()));
      });
      const read = job.postSource ? { readsSource: job.postSource } : {};
      if (!allowed) return { ...base, outcome: 'blocked', sender, roomId: room, text, ...read, effects: ['Records a failed run in history.', unchanged] };
      if (job.dryRun)
        return { ...base, outcome: 'dry-run', sender, roomId: room, text, ...read, effects: ['Records a dry run in history; posts nothing.', unchanged] };
      return { ...base, outcome: 'post', sender, roomId: room, text, ...read, effects: [
        `Posts one message as ${sender} in the room.`, 'Records the run in history.',
        ...(job.postChangeOnly ? ['Remembers this text, so the same text is not posted again.'] : []), unchanged] };
    }
    // An agent session job.
    let prompt: string | undefined;
    try {
      prompt = await this.resolvePrompt(job);
      checks.push({ label: 'Prompt resolves', ok: true });
    } catch (err) {
      checks.push({ label: 'Prompt resolves', ok: false, detail: getErrorMessage(err) });
    }
    const dir = check('Working directory exists', () => { if (!statSync(job.workingDir).isDirectory()) throw new Error('workingDir is not a directory'); });
    let allowedDir = false;
    if (dir) {
      allowedDir = await isWorkingDirAllowedForUsername(job.owner, job.workingDir);
      checks.push({ label: 'Working directory is in the owner workspace', ok: allowedDir });
    }
    const active = this.countActiveAgents(job.agentType, job.id);
    checks.push({ label: 'Other sessions of this agent', ok: true, detail: active ? `${active} already running` : 'None running' });
    // The same session limits the launch checks. A routine that closes its earlier sessions first may free room.
    const cap = sessionCapacityState(this.deps.sessions, job.owner);
    const earlier = job.scheduleType !== 'once' && job.autoClosePreviousSession !== false
      ? this.listRuns(job.id).filter((r) => r.sessionId && this.deps.sessions.has(r.sessionId)).length : 0;
    const full = cap.atGlobalCap ? `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached` : cap.atUserCap ? "Owner's per-user session limit reached" : '';
    checks.push(!full ? { label: 'Session limit', ok: true }
      : earlier ? { label: 'Session limit', ok: true, detail: `${full}; Run once first closes ${earlier} earlier session${earlier === 1 ? '' : 's'} of this routine` }
      : { label: 'Session limit', ok: false, detail: full });
    // The owner's grant, re-resolved now exactly as the launch does, for shell and launch-command jobs.
    let granted = true;
    if (getCli(job.agentType)?.capabilities.privilegedCommandGate || job.launchCommand) {
      granted = await canUsernameRunPrivilegedCommands(job.owner);
      checks.push(granted ? { label: 'Owner grant for shell or launch-command jobs', ok: true }
        : { label: 'Owner grant for shell or launch-command jobs', ok: false, detail: 'Owner lacks the can-bypass-permissions grant for shell/launchCommand jobs' });
    }
    const ready = prompt !== undefined && dir && allowedDir && (!full || earlier > 0) && granted;
    return { ...base, outcome: ready ? 'launch' : 'blocked', ...(prompt !== undefined ? { text: prompt } : {}), effects: ready ? [
      `Starts a new ${job.agentType} session in ${job.workingDir} and sends it the prompt.`,
      ...(job.scheduleType !== 'once' && job.autoClosePreviousSession !== false ? ['Closes the sessions this routine started before.'] : []),
      'Records the run in history.', unchanged] : ['Records a failed run in history.', unchanged] };
  }

  /**
   * Background tick: launch every enabled job whose next run is due. Advances
   * each job's schedule and guards against double-launching the same due time.
   */
  async tickDueJobs(now: number = Date.now()): Promise<void> {
    for (const job of this.listJobs()) {
      if (job.recoveryUncertain || !job.enabled || job.nextRunAt == null || job.nextRunAt > now) continue;

      const key = dueKeyFor(job.id, job.nextRunAt);
      if (job.lastDueKey === key) {
        // This due time was already consumed (overlap/restart) — just advance.
        this.advanceAfterFire(job, now);
        continue;
      }

      // Optional concurrency policy for AUTOMATIC runs. Only LIVE sessions
      // block, and this job's own previous sessions never do (see
      // countActiveAgents) — otherwise a recurring job would deadlock on the
      // session it created last time.
      if (job.concurrencyPolicy === 'skip_if_same_agent_running' && this.countActiveAgents(job.agentType, job.id) > 0) {
        // Record the skip so the job's run history isn't silently empty when it
        // keeps getting skipped (otherwise it looks like the job never ran).
        this.recordSkippedRun(job);
        if (job.scheduleType === 'once') {
          // A skipped one-time job is NOT consumed: leave nextRunAt armed (and
          // the due key unconsumed) so the next tick retries once the blocking
          // session goes away.
          continue;
        }
        job.lastDueKey = key;
        this.advanceAfterFire(job, now);
        continue;
      }

      if ((job.action ?? 'launch') === 'post' && now - job.nextRunAt > POST_CATCH_UP_MS) {
        // A post is only useful on time: never send yesterday's reminder because the server was down.
        this.recordMissedPost(job, job.nextRunAt, now);
        job.lastDueKey = key;
        this.advanceAfterFire(job, now);
        continue;
      }

      job.lastDueKey = key;
      // Advance the schedule BEFORE launching so a slow launch can't be
      // re-triggered by the next tick.
      this.advanceAfterFire(job, now);
      this.launch(job, 'scheduled').catch((err) =>
        console.error(`[cron] launch failed for job ${job.id}:`, getErrorMessage(err))
      );
    }
  }

  /** Recompute nextRunAt for loaded jobs on boot (e.g. after a restart). */
  init(): void {
    const now = Date.now();
    for (const job of this.listJobs()) {
      const isDeadOnce = job.scheduleType === 'once' && job.completedOnce;
      if (job.enabled && job.nextRunAt == null && !isDeadOnce) {
        job.nextRunAt = computeNextRunAt(job, now);
        this.store.setCronJob(job.id, job);
      }
    }
  }

  // ──────────────────────────── Internals ───────────────────────────

  private advanceAfterFire(job: CronJob, now: number): void {
    if (job.scheduleType === 'once') {
      job.completedOnce = true;
      job.enabled = false;
      job.nextRunAt = null;
    } else {
      job.nextRunAt = computeNextRunAt(job, now);
    }
    job.updatedAt = now;
    this.store.setCronJob(job.id, job);
    this.broadcastListChanged();
  }

  /**
   * A post job with a data source: read it, apply the condition and the change-only rule, and render the
   * text. `text` is null when a scheduled fire should stay silent (nothing to say), with `reason`.
   */
  private async renderSourcePost(job: CronJob, preview = false): Promise<{ text: string | null; reason: string; key?: string }> {
    const read = job.postSource ? this.postSources[job.postSource] : undefined;
    if (!job.postSource || !read) throw new Error(`Data source "${job.postSource ?? ''}" is not available`);
    const data = await read({ args: job.postSourceArgs, last: job.postLastText, ...(preview ? { preview: true } : {}) });
    // A source that could not finish reading (`_hold`) always says so, whatever the template, condition or change-only
    // rule, and does not move the change key: silence must never read as an all-clear.
    if (data._hold) return { text: String(data.message ?? 'monitoring incomplete'), reason: '', key: job.postLastText ?? '' };
    if (job.postWhen && !conditionHolds(job.postWhen, data)) {
      const w = job.postWhen;
      return { text: null, reason: `Condition not met: ${w.field} ${w.op} ${w.value} (now ${data[w.field] ?? 'n/a'})` };
    }
    const text = renderTemplate(job.postText as string, data);
    // A source may name its own change key (`_key`); its empty key is the quiet baseline, so a first
    // run with nothing to report stays silent. Otherwise the rendered text is the key.
    const key = typeof data._key === 'string' ? data._key : text;
    const last = job.postLastText ?? (typeof data._key === 'string' ? '' : undefined);
    if (job.postChangeOnly && key === last) return { text: null, reason: 'Unchanged since the last post' };
    return { text, reason: '', key };
  }

  private async launch(job: CronJob, trigger: TriggerType): Promise<CronJobRun | null> {
    this.assertRecoveryCertain(job);
    const current = this.executingJobs.get(job.id);
    if (job.postSourceArgs?.pull !== undefined && current) return null;
    this.executingJobs.set(job.id, {
      job: { id: job.id, name: job.name, owner: job.owner }, count: (current?.count ?? 0) + 1,
    });
    try { return job.postSourceArgs?.pull !== undefined ? await this.executeFixedWatch(job, trigger) : await this.executeLaunch(job, trigger); }
    finally {
      const active = this.executingJobs.get(job.id);
      if (active && active.count > 1) active.count--;
      else this.executingJobs.delete(job.id);
    }
  }

  private assertRecoveryCertain(job: CronJob): void {
    const current = this.getJob(job.id);
    if (!current || job.recoveryUncertain || current.recoveryUncertain) throw this.badRequest('RECOVERY_UNCERTAIN: backup-restored or unavailable job is held; owner reconciliation is unavailable. Disable and retain its evidence; no edit, re-enable, delete or replay.');
  }

  private assertFixedWatchInput(input: Partial<CronJobInput>): void {
    fixedTarget(input.postSourceArgs);
    if (input.action !== 'post' || input.postSource !== 'github' || input.postAs === 'author' || input.postText !== '{message}' ||
      !input.postChangeOnly || input.postWhen || input.scheduleType !== 'interval' || (input.intervalMinutes ?? 0) < 15) throw this.badRequest('Invalid fixed watcher configuration');
  }

  /** One job / one console writer only. Pending survives crashes; uncertainty never automatically resends. */
  private async executeFixedWatch(job: CronJob, trigger: TriggerType): Promise<CronJobRun> {
    const run: CronJobRun = { id: uuidv4(), cronJobId: job.id, sessionId: null, sessionName: null, startedAt: Date.now(), finishedAt: null, status: 'created', triggerType: trigger, createdSessionUrl: null };
    const generation = job.watchGeneration;
    const current = (): CronJob => {
      const j = this.getJob(job.id);
      if (!j || !generation || j.watchGeneration !== generation || !j.createdByOwner || j.createdBy ||
        this.listJobs().filter(x => x.postSourceArgs?.pull !== undefined).length !== 1) throw new Error('WATCH_GENERATION_STALE or duplicate configuration');
      this.assertFixedWatchInput(j);
      return j;
    };
    let posting = false;
    try {
      const fresh = current();
      if (fresh.watchState?.pending) throw new Error('WATCH_DELIVERY_UNCERTAIN: owner must disable and reconcile retained receipt; no automatic resend or cursor advance');
      if ((fresh.watchState?.failures ?? 0) >= 3) throw new Error('WATCH_RETRY_LIMIT: owner review required');
      const read = this.postSources.github;
      if (!read) throw new Error('WATCH_QUERY_INVALID: source unavailable');
      const data = await read({ args: fresh.postSourceArgs, last: fresh.postLastText });
      current();
      if (data._hold || typeof data._watchSnapshot !== 'string' || data._watchSnapshot.length > FIXED_WATCH_LIMITS.snapshotChars) throw new Error('WATCH_QUERY_INVALID: incomplete snapshot');
      const snapshot = JSON.parse(data._watchSnapshot) as WatchSnapshot;
      const target = fixedTargetId(fixedTarget(fresh.postSourceArgs));
      const cursor = JSON.stringify(snapshot.cursor);
      parseWatchCursor(cursor, target);
      if (!Array.isArray(snapshot.events) || snapshot.events.length > FIXED_WATCH_LIMITS.eventsPerPoll || snapshot.events.some(e => e.target_id !== target || e.event_id !== e.dedupe_key || !snapshot.cursor.events.includes(e.event_id)) || typeof snapshot.message !== 'string' || snapshot.message.length > 2000 || /[@\r\n]/.test(snapshot.message)) throw new Error('WATCH_QUERY_INVALID: invalid event projection');
      if (!snapshot.events.length || fresh.dryRun) {
        run.status = 'skipped';
        run.errorMessage = fresh.dryRun ? 'Dry run: bounded metadata observed; no delivery/cursor change' : 'No new metadata events';
        run.finishedAt = Date.now();
        this.store.setCronJobRun(run.id, run);
        return run;
      }
      const bot = this.poster?.getBot(fresh.botId as string);
      if (!bot || !this.poster?.postWatchNotice) throw new Error('DELIVERY_UNAVAILABLE');
      const recent = this.recentBotPosts(bot.id, Date.now());
      this.poster.check(bot, fresh.roomId as string, recent);
      const pending = { receipt: run.id, utc: Date.now(), events: snapshot.events };
      await this.store.commitCronWatch(() => {
        const j = current();
        if (j.watchState?.pending) throw new Error('WATCH_DELIVERY_UNCERTAIN');
        j.watchState = { generation: generation as string, failures: j.watchState?.failures ?? 0, pending };
        this.store.setCronJob(j.id, j);
        this.store.setCronJobRun(run.id, run);
      });
      const active = current();
      // No await between this last fence, the checked DB commit, and capturing its acknowledgement.
      posting = true;
      const receipt = this.poster.postWatchNotice(bot, active.roomId as string, `${snapshot.message} Receipt ${run.id}.`, recent, active.owner);
      if (!receipt.messageId || receipt.messageId.length > 100) throw new Error('DELIVERY_UNCONFIRMED');
      await this.store.commitCronWatch(() => {
        const j = current();
        if (j.watchState?.pending?.receipt !== run.id) throw new Error('WATCH_DELIVERY_UNCERTAIN');
        j.postLastText = cursor;
        j.watchState = { generation: generation as string, failures: 0, delivery: { ...pending, room: j.roomId as string, result: 'DELIVERED', messageId: receipt.messageId } };
        run.status = 'posted'; run.finishedAt = Date.now();
        j.lastRunAt = run.startedAt; j.lastStatus = run.status;
        this.store.setCronJob(j.id, j); this.store.setCronJobRun(run.id, run);
      });
      return run;
    } catch {
      run.status = 'failed'; run.finishedAt = Date.now();
      run.errorMessage = posting || this.getJob(job.id)?.watchState?.pending
        ? 'WATCH_DELIVERY_UNCERTAIN: disable watcher; owner reconciliation of retained receipt required. Cursor held; no automatic resend.'
        : 'WATCH_QUERY_INVALID / DELIVERY_FAILED: bounded retry (maximum 3); cursor held. No all-clear.';
      // No upstream titles, response bodies or exception strings enter receipts/logs.
      try { await this.store.commitCronWatch(() => {
        const j = current();
        j.watchState ??= { generation: generation as string, failures: 0 };
        j.watchState.failures = Math.min(3, j.watchState.failures + 1);
        j.lastStatus = 'failed';
        this.store.setCronJob(j.id, j); this.store.setCronJobRun(run.id, run);
      }); } catch { /* unavailable state is not a successful delivery */ }
      return run;
    } finally {
      this.pruneRunHistory();
      this.deps.broadcast(SseEvent.CronRunUpdated, run);
      this.broadcastListChanged();
    }
  }

  private async executeLaunch(job: CronJob, trigger: TriggerType): Promise<CronJobRun | null> {
    // A scheduled source post with nothing to say leaves no run behind (a 15-minute check would otherwise
    // flood the 500-run history); Run Now always records what the source says.
    let sourced: { text: string | null; reason: string; key?: string } | undefined;
    if ((job.action ?? 'launch') === 'post' && job.postSource) {
      try {
        sourced = await this.renderSourcePost(job);
      } catch (err) {
        sourced = undefined;
        console.error(`[cron] source failed for job ${job.id}:`, getErrorMessage(err));
      }
      if (sourced && sourced.text === null && trigger === 'scheduled') {
        const fresh = this.store.getCronJob(job.id);
        if (fresh) {
          fresh.lastRunAt = Date.now();
          this.store.setCronJob(fresh.id, fresh);
        }
        return null;
      }
    }
    this.assertRecoveryCertain(job);
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'created',
      triggerType: trigger,
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.pruneRunHistory();
    this.deps.broadcast(SseEvent.CronRunCreated, run);

    if ((job.action ?? 'launch') === 'post') return this.firePost(job, run, sourced);

    // Resolve the prompt.
    let prompt: string;
    try {
      prompt = await this.resolvePrompt(job);
    } catch (err) {
      return this.failRun(job, run, `Prompt error: ${getErrorMessage(err)}`);
    }

    // Validate working directory.
    this.assertRecoveryCertain(job);
    try {
      if (!statSync(job.workingDir).isDirectory()) {
        return this.failRun(job, run, 'workingDir is not a directory');
      }
    } catch {
      return this.failRun(job, run, 'workingDir does not exist');
    }

    // Section 6.3: defense-in-depth workingDir confinement re-check at FIRE time against the
    // owner's CURRENT space (complements the create/update gate). No-op in single-user / unset owner.
    if (!(await isWorkingDirAllowedForUsername(job.owner, job.workingDir))) {
      return this.failRun(job, run, 'workingDir is outside the owner workspace');
    }

    // Recurring jobs: close the still-open session created by this job's
    // previous run before launching the next (default ON, opt-out via
    // autoClosePreviousSession:false) — otherwise an unattended interval/daily
    // job accumulates a new tab per fire until the global session cap.
    if (job.scheduleType !== 'once' && job.autoClosePreviousSession !== false) {
      this.assertRecoveryCertain(job);
      await this.closePreviousRunSessions(job, run.id);
    }

    // Respect the global cap AND the owner's per-user cap (multi-user).
    const cap = sessionCapacityState(this.deps.sessions, job.owner);
    if (cap.atGlobalCap) {
      return this.failRun(job, run, `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
    }
    if (cap.atUserCap) {
      return this.failRun(job, run, `Owner's per-user session limit reached`);
    }

    // Section 6.3: re-resolve the owner's grant at FIRE time (it may have been revoked
    // since create). Gates shell/launchCommand AND clamps the external-CLI bypass below.
    const ownerGranted = await canUsernameRunPrivilegedCommands(job.owner);
    if ((getCli(job.agentType)?.capabilities.privilegedCommandGate || job.launchCommand) && !ownerGranted) {
      return this.failRun(job, run, 'Owner lacks the can-bypass-permissions grant for shell/launchCommand jobs');
    }

    // Create + start the session (mirrors the quick-start route flow).
    let session: Session;
    try {
      this.assertRecoveryCertain(job);
      const mode = job.agentType;
      // A LAUNCHER CLI's binary is not its agent, so "installed" is not "runnable": without
      // this, a job on a box carrying only dsh's stock web/headless profiles spawns a bare
      // `dsh` that boots a profile unable to drive a pane, and the prompt is typed into a
      // logging server or a dead pane instead of failing the run with an actionable message.
      //
      // ⚠️ Scoped to `discovery.launcherProfile`, which is byte-identical to the
      // `mode === 'deepseek'` check this replaces (dsh is the only launcher today) and
      // generalises to the next one. Deliberately NOT every CLI: cron has never pre-flighted
      // a merely-missing binary, and doing so replaces tmux-manager's own not-found throw
      // ("Session launch failed") with a different message for claude and shell. An earlier
      // draft of this line was unscoped and did exactly that — three cron tests caught it.
      if (getCli(mode)?.discovery.launcherProfile !== undefined) {
        const cronLaunchError = await resolveCliLaunchError(mode);
        if (cronLaunchError) return this.failRun(job, run, cronLaunchError);
      }
      const globalNice = await this.deps.getGlobalNiceConfig();
      const modelConfig = await this.deps.getModelConfig();
      const claudeModeConfig = await this.deps.getClaudeModeConfig();
      const effectiveClaudeMode = await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, job.owner);
      // Cron carries no per-CLI config object, so the only model it can supply is the global
      // default — and only to a CLI that takes a model at all.
      //
      // ⚠️ `!== 'none'` is the faithful reading of the `mode !== 'shell' && mode !== 'deepseek'`
      // ladder this replaces: those two are exactly the entries declaring `model.source: 'none'`
      // (shell has no model; deepseek's is a profile composition entry, not a session flag).
      // NOT `=== 'claude-settings-file'`, which is the HTTP route's question — there, every
      // external CLI reads its model from its own config object earlier in the chain, so only
      // claude reaches the global default. Cron has no such config, so the same expression
      // means something different here.
      const model =
        getCli(mode)?.capabilities.model.source !== 'none' ? modelConfig?.defaultModel || undefined : undefined;
      // Section 6.3: materialize the safe default for a non-granted owner (see
      // clampCronExternalCliConfigs — cron sends no per-CLI config, so the CLI's own
      // spawn default is what would otherwise apply).
      const { geminiConfig, piConfig } = clampCronExternalCliConfigs(mode, ownerGranted);
      // Workspace hooks (see applyWorkspaceHooks in hooks-config): cron jobs are
      // always local (workingDir was stat-validated above) but used to bypass the
      // shared install-vs-refresh decision, so a job firing in a linked case that
      // never had an interactive session ran hook-blind — no `stop` for the
      // completion detection, no tab alert on a blocking dialog. Claude mode only
      // (nothing else reads `.claude` hooks); best-effort inside the helper.
      if (mode === 'claude') {
        this.assertRecoveryCertain(job);
        await applyWorkspaceHooks(job.workingDir);
      }
      this.assertRecoveryCertain(job);
      session = new Session({
        workingDir: job.workingDir,
        mode,
        name: job.name,
        mux: this.deps.mux,
        useMux: true,
        niceConfig: globalNice,
        model,
        claudeMode: effectiveClaudeMode,
        allowedTools: claudeModeConfig.allowedTools,
        geminiConfig,
        piConfig,
        owner: job.owner,
      });
      await this.deps.addSession(session);
      this.assertRecoveryCertain(job);
      this.store.incrementSessionsCreated();
      this.assertRecoveryCertain(job);
      this.deps.persistSessionState(session);
      this.assertRecoveryCertain(job);
      await this.deps.setupSessionListeners(session);
      this.assertRecoveryCertain(job);
      this.deps.broadcast(SseEvent.SessionCreated, this.deps.getSessionStateWithRespawn(session));
      this.assertRecoveryCertain(job);
      if (mode === 'shell') {
        await session.startShell();
      } else {
        await session.startInteractive();
      }
      this.assertRecoveryCertain(job);
      this.deps.broadcast(SseEvent.SessionInteractive, { id: session.id, mode });
    } catch (err) {
      return this.failRun(job, run, `Session launch failed: ${getErrorMessage(err)}`);
    }

    run.sessionId = session.id;
    run.sessionName = session.name;
    run.createdSessionUrl = `/?session=${session.id}`;
    run.status = 'session_started';
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'session_started');

    // Send the prompt once the CLI is ready (async; does not block the caller).
    this.sendPromptWhenReady(session.id, prompt, job, run);
    return run;
  }

  /**
   * Resolves the prompt text and enforces the single-line constraint: prompt
   * delivery rides writeViaMux/PTY writes where a newline is Enter, so a
   * multi-line prompt would be silently corrupted (typed mode fuses lines,
   * paste mode submits the first line and dribbles the rest in as separate
   * messages). Rather than mangle an unattended agent's instructions, fail the
   * run with a clear error. A prompt FILE may end with trailing newline(s)
   * (every editor writes one) — those are stripped before the check.
   */
  private async resolvePrompt(job: CronJob): Promise<string> {
    if (job.promptMode === 'prompt_file_path') {
      if (!job.promptFilePath) throw new Error('prompt file path is empty');
      const safePath = await this.resolveSafePromptPath(job.promptFilePath, job.workingDir);
      const content = (await readFile(safePath, 'utf-8')).replace(/[\r\n]+$/, '');
      if (HAS_NEWLINE.test(content)) {
        throw new Error('prompt file must contain a single line — multi-line prompts are not supported');
      }
      return content;
    }
    const text = job.promptText ?? '';
    if (HAS_NEWLINE.test(text)) {
      // Schema-rejected since this check was added; guards legacy persisted jobs.
      throw new Error('promptText must be a single line — multi-line prompts are not supported');
    }
    return text;
  }

  /**
   * Guards a prompt-file path before it is read. The path is user-supplied via
   * the API and its contents are injected into an agent session (an exfil sink
   * over SSE/terminal), so an unconfined read would let a hostile job config
   * pull arbitrary host files — including the SERVER PROCESS'S OWN secrets via
   * `/proc/self/environ` — into the session.
   *
   * A denylist is the wrong posture for an exfil sink (it kept missing `/proc`,
   * `/dev`, other users' `~/.ssh`, modern cloud creds…). So the PRIMARY gate is
   * an allowlist: the prompt file must resolve INSIDE the job's working
   * directory. A symlink escaping the workspace fails this because we check the
   * realpath-resolved target. We additionally require a regular file (rejects
   * directories, FIFOs, and `/dev/*` character devices that would hang or OOM
   * the unbounded read) within a sane size cap, and keep the shared blocklist as
   * cheap defense-in-depth. Returns the symlink-resolved path to read.
   */
  private async resolveSafePromptPath(rawPath: string, workingDir: string): Promise<string> {
    let resolved: string;
    try {
      resolved = realpathSync(rawPath);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }

    // workingDir is USER-CONTROLLED, so it is not a trust boundary by itself:
    // realpath-resolve it (a symlinked workspace must not defeat containment)
    // and reject blocked/pseudo-fs trees — otherwise workingDir '/proc' would
    // make '/proc/self/environ' pass the containment check below.
    let realWorkingDir: string;
    try {
      realWorkingDir = realpathSync(workingDir);
    } catch {
      throw new Error('job working directory could not be resolved');
    }
    const guard = await loadAttachmentGuardConfig();
    const blockedTrees = [...guard.blockedTrees, ...CRON_PSEUDO_FS_TREES];
    if (realWorkingDir === '/' || isBlockedAttachmentPath(realWorkingDir, blockedTrees)) {
      throw new Error('job working directory is blocked');
    }

    // Defense-in-depth blocklist (secret locations, /etc, /root, pseudo-fs).
    if (isBlockedAttachmentPath(resolved, blockedTrees)) {
      throw new Error('prompt file path is blocked');
    }

    // Primary gate: the prompt file must live inside the job's workspace.
    if (!validateSessionFilePath(realWorkingDir, resolved)) {
      throw new Error('prompt file path must be inside the job working directory');
    }

    // Reject non-regular files and oversized files (DoS via unbounded read).
    let info;
    try {
      info = statSync(resolved);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }
    if (!info.isFile()) throw new Error('prompt file path is not a regular file');
    if (info.size > MAX_PROMPT_FILE_BYTES) throw new Error('prompt file is too large');

    return resolved;
  }

  private sendPromptWhenReady(sessionId: string, prompt: string, job: CronJob, run: CronJobRun): void {
    setImmediate(() => {
      const poll = async (): Promise<void> => {
        // A shell pane is ready the moment it exists; an agent CLI has a TUI to paint
        // first. That is the `kind` the registry already records, not a fact about shell.
        if (getCli(job.agentType)?.kind !== 'shell') {
          for (let attempt = 0; attempt < CRON_READY_MAX_ATTEMPTS; attempt++) {
            await delay(500);
            const s = this.deps.sessions.get(sessionId);
            if (!s) return; // session was removed
            const buf = s.getTerminalBuffer().slice(-2048);
            if (buf.includes('❯') || buf.includes('tokens')) break;
          }
          await delay(CRON_READY_SETTLE_MS);
        } else {
          await delay(1000);
          // Shell mode: deliver the optional custom launch command as the
          // first input line (single-line, schema-enforced), then give it a
          // moment to start before the prompt follows.
          if (job.launchCommand) {
            this.assertRecoveryCertain(job);
            const shell = this.deps.sessions.get(sessionId);
            if (!shell) return;
            const sent = await shell.writeViaMux(`${job.launchCommand}\r`);
            if (!sent) {
              this.failRun(job, run, 'Failed to send launch command: mux write failed');
              return;
            }
            await delay(1000);
          }
        }
        const s = this.deps.sessions.get(sessionId);
        if (!s) return;
        try {
          this.assertRecoveryCertain(job);
          const delivered = await deliverCronPrompt(s, prompt, job.inputMode, async ms => {
            await delay(ms);
            this.assertRecoveryCertain(job);
          });
          this.assertRecoveryCertain(job);
          if (!delivered) {
            this.failRun(job, run, 'Failed to send prompt: the session could not be written to');
            return;
          }
          run.status = 'prompt_sent';
          run.finishedAt = Date.now();
          this.store.setCronJobRun(run.id, run);
          this.deps.broadcast(SseEvent.CronRunUpdated, run);
          this.updateJobLastStatus(job.id, 'prompt_sent');
        } catch (err) {
          this.failRun(job, run, `Failed to send prompt: ${getErrorMessage(err)}`);
        }
      };
      poll().catch((err) => console.error('[cron] sendPromptWhenReady error:', getErrorMessage(err)));
    });
  }

  /** 400-shaped error for route handlers (mirrors parseBody's error contract). */
  private badRequest(msg: string): Error {
    return Object.assign(new Error(msg), {
      statusCode: 400,
      body: createErrorResponse(ApiErrorCode.INVALID_INPUT, msg),
    });
  }

  /**
   * Create/update gate for a job's workingDir: must exist, be a directory, and
   * not resolve into a blocked or pseudo-filesystem tree (nor the fs root).
   * The user-supplied workingDir doubles as the prompt-file confinement root,
   * so an unrestricted value would defeat that boundary (e.g. '/proc').
   */
  private assertValidWorkingDir(workingDir: string): void {
    let real: string;
    try {
      real = realpathSync(workingDir);
    } catch {
      throw this.badRequest('workingDir does not exist');
    }
    if (!statSync(real).isDirectory()) throw this.badRequest('workingDir is not a directory');
    if (real === '/' || isBlockedAttachmentPath(real, CRON_WORKING_DIR_BLOCKED_TREES)) {
      throw this.badRequest('workingDir is not allowed (blocked or pseudo-filesystem tree)');
    }
  }

  /** Close still-open sessions created by this job's previous runs (normal cleanup path). */
  private async closePreviousRunSessions(job: CronJob, currentRunId: string): Promise<void> {
    for (const prev of this.listRuns(job.id)) {
      if (prev.id === currentRunId || !prev.sessionId) continue;
      if (!this.deps.sessions.has(prev.sessionId)) continue;
      // Keep refusal outside the cleanup-error catch: recovery during an earlier await stops the loop.
      this.assertRecoveryCertain(job);
      try {
        await this.deps.cleanupSession(prev.sessionId, true, 'cron: superseded by the next run of this job');
      } catch (err) {
        console.error(`[cron] failed to auto-close previous session ${prev.sessionId}:`, getErrorMessage(err));
      }
    }
  }

  /** Posts by this bot in the last hour, from the run history of every job that speaks as it. */
  private recentBotPosts(botId: string, now: number): number {
    const jobIds = new Set(this.listJobs().filter((j) => j.action === 'post' && j.botId === botId).map((j) => j.id));
    return this.listRuns().filter((r) => r.status === 'posted' && jobIds.has(r.cronJobId) && r.startedAt > now - HOUR_MS).length;
  }

  /**
   * Posts an author made in the last hour, across every routine they own or ever owned. Kept in a ledger of its own (saved to
   * the author quota file when one is set), not read from the job and run records, so deleting a routine (which removes its
   * runs), pruning the run history or restarting cannot reset the count. An author with no saved entry is counted from the runs
   * still on file, which covers the first start after this change.
   */
  private authorLedger?: Map<string, number[]>;
  private authorQuota?: AuthorQuotaStore;
  setAuthorQuota(store: AuthorQuotaStore): void {
    this.authorQuota = store;
    this.authorLedger = undefined;
  }
  private ledger(): Map<string, number[]> {
    this.authorLedger ??= new Map(Object.entries(this.authorQuota?.load() ?? {}));
    return this.authorLedger;
  }
  private recentAuthorPosts(employeeId: string, now: number): number {
    const ledger = this.ledger();
    let log = ledger.get(employeeId);
    if (!log) {
      const jobIds = new Set(this.listJobs().filter((j) => j.action === 'post' && j.createdBy?.employeeId === employeeId).map((j) => j.id));
      log = this.listRuns().filter((r) => r.status === 'posted' && jobIds.has(r.cronJobId)).map((r) => r.startedAt);
    }
    log = log.filter((t) => t > now - HOUR_MS);
    ledger.set(employeeId, log);
    return log.length;
  }
  private recordAuthorPost(employeeId: string, at: number): void {
    const ledger = this.ledger();
    ledger.set(employeeId, [...(ledger.get(employeeId) ?? []), at]);
    if (!this.authorQuota) return;
    const keep: Record<string, number[]> = {};
    for (const [id, times] of ledger) {
      const recent = times.filter((t) => t > at - HOUR_MS);
      if (recent.length) keep[id] = recent;
    }
    this.authorQuota.save(keep);
  }

  private fireAuthorPost(job: CronJob, run: CronJobRun): CronJobRun {
    const employeeId = job.createdBy?.employeeId;
    if (!employeeId || !this.poster?.postAsAuthor) return this.failRun(job, run, 'This routine has no author who can post');
    if (this.recentAuthorPosts(employeeId, run.startedAt) >= AUTHOR_POSTS_PER_HOUR) {
      // A rate limit is the author's own doing, not a broken routine: it does not count toward the auto-disable.
      return this.failRun(job, run, `Limit of ${AUTHOR_POSTS_PER_HOUR} routine posts an hour reached`, false);
    }
    let name: string;
    try {
      if (job.dryRun) {
        run.status = 'skipped';
        run.errorMessage = `Dry run: would post in ${job.roomId}: ${job.postText}`;
        run.finishedAt = Date.now();
        this.store.setCronJobRun(run.id, run);
        this.deps.broadcast(SseEvent.CronRunUpdated, run);
        this.updateJobLastStatus(job.id, 'skipped');
        return run;
      }
      ({ name } = this.poster.postAsAuthor(employeeId, job.roomId as string, job.postText as string));
    } catch (err) {
      return this.failRun(job, run, `Post failed: ${getErrorMessage(err)}`);
    }
    run.status = 'posted';
    run.finishedAt = Date.now();
    this.recordAuthorPost(employeeId, run.startedAt);
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'posted');
    const fresh = this.store.getCronJob(job.id);
    if (fresh?.failStreak) {
      fresh.failStreak = 0;
      this.store.setCronJob(fresh.id, fresh);
    }
    console.log(`[cron] posted ${job.id}: ${name} -> ${job.roomId}`);
    return run;
  }

  private firePost(job: CronJob, run: CronJobRun, sourced?: { text: string | null; reason: string; key?: string }): CronJobRun {
    if (job.postAs === 'author') return this.fireAuthorPost(job, run);
    const bot = job.botId ? this.poster?.getBot(job.botId) : undefined;
    if (!this.poster || !bot) return this.failRun(job, run, `No bot "${job.botId ?? ''}" is registered`);
    try {
      if (job.postSource && !sourced) return this.failRun(job, run, `Data source "${job.postSource}" failed to read`);
      let text = job.postText as string;
      if (sourced) {
        if (sourced.text === null) {
          // Run Now on a source job whose condition does not hold: say why, post nothing.
          run.status = 'skipped';
          run.errorMessage = sourced.reason;
          run.finishedAt = Date.now();
          this.store.setCronJobRun(run.id, run);
          this.deps.broadcast(SseEvent.CronRunUpdated, run);
          this.updateJobLastStatus(job.id, 'skipped');
          return run;
        }
        text = sourced.text;
      }
      const recent = this.recentBotPosts(bot.id, run.startedAt);
      this.poster.check(bot, job.roomId as string, recent);
      if (job.dryRun) {
        run.status = 'skipped';
        run.errorMessage = `Dry run: ${bot.name} would post in ${job.roomId}: ${text}`;
        run.finishedAt = Date.now();
        this.store.setCronJobRun(run.id, run);
        this.deps.broadcast(SseEvent.CronRunUpdated, run);
        this.updateJobLastStatus(job.id, 'skipped');
        console.log(`[cron] dry run ${job.id}: ${bot.id} -> ${job.roomId}`);
        return run;
      }
      this.poster.post(bot, job.roomId as string, text, recent);
      if (job.postChangeOnly) {
        const fresh = this.store.getCronJob(job.id);
        if (fresh) {
          fresh.postLastText = sourced?.key ?? text;
          this.store.setCronJob(fresh.id, fresh);
        }
      }
    } catch (err) {
      return this.failRun(job, run, `Post failed: ${getErrorMessage(err)}`);
    }
    run.status = 'posted';
    run.finishedAt = Date.now();
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'posted');
    console.log(`[cron] posted ${job.id}: ${bot.id} -> ${job.roomId}`);
    return run;
  }

  private recordMissedPost(job: CronJob, due: number, now: number): void {
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: now,
      finishedAt: now,
      status: 'skipped',
      errorMessage: `Missed: due ${new Date(due).toISOString()}, more than ${POST_CATCH_UP_MS / 60_000} minutes ago`,
      triggerType: 'scheduled',
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.pruneRunHistory();
    this.deps.broadcast(SseEvent.CronRunCreated, run);
    this.updateJobLastStatus(job.id, 'skipped', { touchLastRun: false });
  }

  private failRun(job: CronJob, run: CronJobRun, message: string, countsTowardDisable = true): CronJobRun {
    run.status = 'failed';
    run.errorMessage = message;
    run.finishedAt = Date.now();
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'failed');
    if (job.postAs === 'author' && countsTowardDisable) this.countAuthorFailure(job.id, message);
    return run;
  }

  /** The third failed fire in a row switches an author routine off and tells its author once, in the routine's room. */
  private countAuthorFailure(jobId: string, message: string): void {
    const job = this.store.getCronJob(jobId);
    if (!job || job.postAs !== 'author') return;
    job.failStreak = (job.failStreak ?? 0) + 1;
    this.store.setCronJob(job.id, job);
    if (job.failStreak < AUTHOR_FAIL_LIMIT || !job.enabled) return;
    this.setEnabled(job.id, false);
    try {
      this.poster?.notifyDisabled?.(
        job.createdBy?.employeeId as string,
        job.roomId as string,
        `Routine "${job.name}" is switched off after ${AUTHOR_FAIL_LIMIT} failed runs in a row (${message}). Fix it and enable it again.`
      );
    } catch (err) {
      console.warn(`[cron] could not tell the author of ${job.id} that it was disabled:`, getErrorMessage(err));
    }
  }

  private recordSkippedRun(job: CronJob): void {
    // Coalesce consecutive skips: if the job is already in a skip streak, don't
    // record again — a perpetually-skipped interval job would otherwise write a
    // run every tick forever and bloat state.json.
    if (this.listRuns(job.id)[0]?.status === 'skipped') return;

    const now = Date.now();
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: now,
      finishedAt: now,
      status: 'skipped',
      errorMessage: `Skipped: a ${job.agentType} agent is already running (concurrency policy)`,
      triggerType: 'scheduled',
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.pruneRunHistory();
    this.deps.broadcast(SseEvent.CronRunCreated, run);
    // A skip is NOT a run: surface it as the lastStatus, but do NOT advance
    // lastRunAt (no session was created).
    this.updateJobLastStatus(job.id, 'skipped', { touchLastRun: false });
  }

  /** Prune the oldest run records (by startedAt) once the global cap is exceeded. */
  private pruneRunHistory(): void {
    const runs = Object.values(this.store.getCronJobRuns());
    if (runs.length <= MAX_CRON_RUN_HISTORY) return;
    runs.sort((a, b) => a.startedAt - b.startedAt);
    for (const run of runs.slice(0, runs.length - MAX_CRON_RUN_HISTORY)) {
      this.store.removeCronJobRun(run.id);
    }
  }

  private updateJobLastStatus(jobId: string, status: CronJobRunStatus, opts: { touchLastRun?: boolean } = {}): void {
    const fresh = this.store.getCronJob(jobId);
    if (!fresh) return;
    const now = Date.now();
    fresh.lastStatus = status;
    if (opts.touchLastRun !== false) fresh.lastRunAt = now;
    fresh.updatedAt = now;
    this.store.setCronJob(fresh.id, fresh);
    this.broadcastListChanged();
  }

  private broadcastListChanged(): void {
    this.deps.broadcast(SseEvent.CronJobsChanged, { jobs: this.listJobs() });
  }
}
