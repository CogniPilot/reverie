/**
 * Versioned, private instance configuration for registered bot types.
 * Parsing creates no schedules, posts or credentials. Sender identities and posting
 * limits remain in ChatBotRegistry; configuration cannot supply executable handlers.
 * A new type requires a reviewed schema, handler, renderer and fixtures in source.
 */
import { z } from 'zod';
import { BOT_ID_PATTERN, type ChatBot } from './chat-bots.js';
import { isValidTimeZone, parseHHMM } from './cron/cron-time.js';
import { POST_CONDITION_OPS, validatePostSource } from './cron/post-sources.js';

const id = z.string().regex(BOT_ID_PATTERN);
const time = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .refine((value) => parseHHMM(value) !== null, 'Invalid HH:MM time');
const timeZone = z.string().min(1).max(100).refine(isValidTimeZone, 'Unknown time zone');

/** Uses the existing cron schedule vocabulary, with explicit zones for wall times. */
export const BotScheduleSchema = z.discriminatedUnion('scheduleType', [
  z.object({ scheduleType: z.literal('once'), runAt: z.number().int().nonnegative().safe() }).strict(),
  z.object({ scheduleType: z.literal('interval'), intervalMinutes: z.number().int().min(1).max(10080) }).strict(),
  z.object({ scheduleType: z.literal('daily'), dailyTime: time, timeZone }).strict(),
  z
    .object({
      scheduleType: z.literal('weekly'),
      weeklyTime: time,
      timeZone,
      weeklyDays: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, 'Repeated weekday'),
    })
    .strict(),
]);

const common = {
  schemaVersion: z.literal(1),
  id,
  botId: id,
  roomId: z.string().min(1).max(100).regex(/^\S+$/),
  enabled: z.boolean().default(false),
  /** Autonomous maintenance requires a separately reviewed schema and owner approval. */
  maintenanceEnabled: z.literal(false).default(false),
};

const repository = z
  .string()
  .max(140)
  .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i, 'Use owner/repository, without a URL or wildcard')
  .refine((value) => !['.', '..'].includes(value.split('/')[1]), 'Invalid repository');

export const GitHubWatcherPresetSchema = z
  .object({
    ...common,
    type: z.literal('github-watcher'),
    repositories: z
      .array(repository)
      .min(1)
      .max(100)
      .refine((repos) => new Set(repos.map((repo) => repo.toLowerCase())).size === repos.length, 'Repeated repository'),
    events: z
      .array(z.enum(['ci-failure', 'issue', 'pull-request', 'review-request', 'review-result']))
      .min(1)
      .max(5)
      .refine((events) => new Set(events).size === events.length, 'Repeated event'),
    pollIntervalSeconds: z.number().int().min(30).max(86400).default(120),
    /** Posting budgets may be smaller than the broker's 200-line / 64-KiB response ceiling. */
    logExcerptChars: z.number().int().min(0).max(2000).default(1000),
    logExcerptLines: z.number().int().min(0).max(200).default(40),
    /** GET-only v1 broker contract; permission, credential and transport policy is not preset data. */
    brokerContractVersion: z.literal(1).default(1),
    /** An opaque reference resolved by the owner-side broker, never a key, token or URL. */
    brokerRef: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .optional(),
    /** Missing App access must leave public reads available and private coverage incomplete. */
    missingAppPolicy: z.literal('public-only').default('public-only'),
  })
  .strict();

const condition = z
  .object({
    field: z.string().min(1).max(80),
    op: z.enum(POST_CONDITION_OPS),
    value: z.number().finite(),
  })
  .strict();

const routinePost = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(5000) }).strict(),
  z
    .object({
      kind: z.literal('source'),
      source: z.enum(['plans-pace', 'host-load', 'burn-watch']),
      text: z.string().trim().min(1).max(5000),
      when: condition.optional(),
      changeOnly: z.boolean().default(false),
    })
    .strict()
    .superRefine((post, ctx) => {
      const error = validatePostSource(post.source, post.text, post.when);
      if (error) ctx.addIssue({ code: 'custom', message: error });
    }),
]);

export const RoutineBotPresetSchema = z
  .object({
    ...common,
    type: z.literal('routine-bot'),
    schedule: BotScheduleSchema,
    post: routinePost,
    missedRunPolicy: z.enum(['skip', 'latest']).default('skip'),
  })
  .strict();

export const BotPresetSchema = z.discriminatedUnion('type', [GitHubWatcherPresetSchema, RoutineBotPresetSchema]);
export type BotPreset = z.infer<typeof BotPresetSchema>;

/** Resolve against a validated registry entry before a caller can save or activate a preset. */
export function parseBotPreset(raw: unknown, sender: ChatBot | undefined): BotPreset {
  const preset = BotPresetSchema.parse(raw);
  if (!sender || sender.id !== preset.botId) throw new Error('The configured bot sender does not exist');
  if (!sender.rooms.includes(preset.roomId)) throw new Error('The bot cannot post in this room');
  return preset;
}
