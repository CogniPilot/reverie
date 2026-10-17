/**
 * @fileoverview Input shape for creating/updating a cron job. This is the
 * user-settable subset of `CronJob` (server-maintained bookkeeping fields
 * such as nextRunAt / lastStatus are excluded). Produced by the zod schema.
 */

import type { ConcurrencyPolicy, CronAction, CronJob, InputMode, PromptMode, ScheduleType } from '../types/cron.js';
import type { SessionMode } from '../types/session.js';

export type { CronJob, CronJobRun, CronJobRunStatus, TriggerType } from '../types/cron.js';

export interface CronJobInput {
  name: string;
  /** Default 'launch'. A 'post' job needs botId, roomId and postText and leaves the session fields out. */
  action?: CronAction;
  botId?: string;
  roomId?: string;
  postText?: string;
  dryRun?: boolean;
  postSource?: CronJob['postSource'];
  postSourceArgs?: CronJob['postSourceArgs'];
  /** null clears a saved condition on edit. */
  postWhen?: CronJob['postWhen'] | null;
  postChangeOnly?: boolean;
  timeZone?: string;
  /** The session fields below are required for a 'launch' job (the schema enforces it). */
  agentType?: SessionMode;
  workingDir?: string;
  launchCommand?: string;
  promptMode?: PromptMode;
  promptText?: string;
  promptFilePath?: string;
  inputMode?: InputMode;
  scheduleType: ScheduleType;
  runAt?: number;
  intervalMinutes?: number;
  dailyTime?: string;
  weeklyDays?: number[];
  weeklyTime?: string;
  enabled: boolean;
  notes?: string;
  concurrencyPolicy?: ConcurrencyPolicy;
  /** Default true. Ignored for 'once' schedules. */
  autoClosePreviousSession?: boolean;
}
