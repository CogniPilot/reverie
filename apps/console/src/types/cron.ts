/**
 * @fileoverview Cron Jobs type definitions.
 *
 * NOTE: This is intentionally distinct from the existing `ScheduledRun` concept
 * (see src/web/ports/infra-port.ts), which is a run-now, duration-bounded
 * autonomous loop. A `CronJob` is a SAVED, NAMED job with a recurring
 * schedule (once/interval/daily/weekly), enable/disable, next-run calculation,
 * and a history of `CronJobRun` records. The two do not interact.
 *
 * Persisted to `~/.codeman/state.json` via StateStore (see AppState).
 */

import type { SessionMode } from './session.js';

/** How a job's fire times are computed. */
export type ScheduleType = 'once' | 'interval' | 'daily' | 'weekly';

/** Where the prompt text comes from. */
export type PromptMode = 'inline_text' | 'prompt_file_path';

/** How the prompt is delivered into the session. */
export type InputMode = 'paste' | 'typed';

/** Lifecycle status of a single job execution. */
export type CronJobRunStatus = 'created' | 'session_started' | 'prompt_sent' | 'posted' | 'failed' | 'skipped';

/** What a job does when it fires. */
export type CronAction = 'launch' | 'post';

/** What triggered a run. */
export type TriggerType = 'scheduled' | 'manual_run_now';

/** What to do for an AUTOMATIC run when sessions of the same agent already exist. */
export type ConcurrencyPolicy = 'warn_only' | 'skip_if_same_agent_running';

/**
 * A saved, named cron job.
 */
export interface CronJob {
  id: string;
  name: string;
  /** Owning username in multi-user mode; the job launches as this user. Undefined in single-user. */
  owner?: string;
  /**
   * What a fire does: 'launch' starts an agent session (the default, and what every job saved before
   * this field existed does); 'post' has a chat bot post `postText` into `roomId`. A post job keeps
   * neutral placeholders in the session fields below, which it never reads.
   */
  action?: CronAction;
  /** post: the chat bot that speaks (an id in the bot registry). */
  botId?: string;
  /** post: the room it speaks in; the bot's allowlist must name it. */
  roomId?: string;
  /** post: the message, with @mentions as typed in a room. */
  postText?: string;
  /** post: log the would-be post in the run history without posting. */
  dryRun?: boolean;
  /**
   * post: a built-in data source the console computes ('plans-pace', 'host-load'). `postText` is then a
   * template with `{field}` placeholders, filled from the source at fire time.
   */
  postSource?: 'plans-pace' | 'host-load' | 'burn-watch' | 'github';
  /** post with a source that takes arguments ('github': owner, repo, kinds). */
  postSourceArgs?: { owner: string; repo: string; kinds?: Array<'pulls' | 'issues'> };
  /** post with a source: post only when this holds; otherwise the scheduled fire is silent (no run recorded). */
  postWhen?: { field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; value: number };
  /** post with a source: skip a scheduled fire whose rendered text equals the last text posted. */
  postChangeOnly?: boolean;
  /** Internal: the last rendered text this job posted (for postChangeOnly). */
  postLastText?: string;
  /** Reuses Codeman's existing session modes; 'shell' covers Terminal/custom. */
  agentType: SessionMode;
  workingDir: string;
  /** Optional custom launch command (only meaningful for 'shell' mode). */
  launchCommand?: string;

  promptMode: PromptMode;
  promptText?: string;
  promptFilePath?: string;
  inputMode: InputMode;

  scheduleType: ScheduleType;
  /** once: absolute epoch-ms fire time. */
  runAt?: number;
  /** interval: minutes between fires. */
  intervalMinutes?: number;
  /** IANA zone (e.g. America/New_York) the daily/weekly times are read in; the server's local zone when absent. */
  timeZone?: string;
  /** daily: 'HH:MM' (24h, in `timeZone`, else server-local time). */
  dailyTime?: string;
  /** weekly: weekdays 0–6 (0=Sunday). */
  weeklyDays?: number[];
  /** weekly: 'HH:MM' (24h, server-local time). */
  weeklyTime?: string;

  enabled: boolean;
  notes?: string;
  /** Applies to automatic (scheduled) runs only. Manual Run Now always warns client-side. */
  concurrencyPolicy: ConcurrencyPolicy;
  /**
   * Close the still-open session created by this job's previous run before the
   * next run launches (via the normal session-cleanup path), so unattended
   * recurring jobs don't accumulate tabs until the global session cap.
   * Default true. Ignored for 'once' schedules.
   */
  autoClosePreviousSession?: boolean;

  // ── Bookkeeping (server-maintained) ─────────────────────────────────────
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: CronJobRunStatus | null;
  /** Duplicate-launch guard: identifies the most recent due-time consumed. */
  lastDueKey: string | null;
  /** True once a 'once' job has fired (it is also disabled). */
  completedOnce?: boolean;
}

/**
 * A single execution of a cron job (history record).
 */
export interface CronJobRun {
  id: string;
  cronJobId: string;
  sessionId: string | null;
  sessionName: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: CronJobRunStatus;
  errorMessage?: string;
  triggerType: TriggerType;
  /** Best-effort deep link to the created session in the web UI. */
  createdSessionUrl: string | null;
}
