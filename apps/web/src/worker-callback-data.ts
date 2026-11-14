// Shared callback DATA schemas. No registry, filesystem, request or native authority.
import { z } from 'zod';
const RateLimitWindowSchema = z
  .object({
    used_percentage: z.number().nullish(),
    resets_at: z.number().nullish(),
  })
  .nullish();

export const StatusTelemetrySchema = z.object({
  sessionId: z.string().min(1).max(100),
  data: z
    .object({
      rate_limits: z
        .object({
          five_hour: RateLimitWindowSchema,
          seven_day: RateLimitWindowSchema,
        })
        .nullish(),
      context_window: z
        .object({
          used_percentage: z.number().nullish(),
          total_input_tokens: z.number().nullish(),
          total_output_tokens: z.number().nullish(),
        })
        .nullish(),
      cost: z.object({ total_cost_usd: z.number().nullish() }).nullish(),
      model: z.object({ display_name: z.string().max(100).nullish() }).nullish(),
      // Main-conversation prompt-cache statistics (Claude Code v2.1.251+). Every documented
      // scalar field is listed nullish: `expires_at`/`hit_ratio`/`last_miss_at`/
      // `recache_tokens_if_cold` are all documented as possibly null, and the object gains
      // fields over CLI versions, so a stricter shape would 400 the whole post and blank the
      // footer (the recurring .optional()/null trap). Causes stay `unknown` (the parser keeps
      // the strings); `last_miss_cause`'s extra numeric keys and the `miss_causes` record are
      // stripped by Zod unread, which keeps the stored object bounded — a hostile localhost
      // payload cannot bloat state, since only the normalized subset below is ever stored.
      prompt_cache: z
        .object({
          warm: z.boolean().nullish(),
          caching_observed: z.boolean().nullish(),
          // No length cap: a future TTL longer than today's `5m`/`1h` must not 400 the whole
          // post and blank the footer. parsePromptCache discards any TTL it does not know, so
          // the stored value stays bounded to those two regardless.
          ttl: z.string().nullish(),
          expires_at: z.number().nullish(),
          requests: z.number().nullish(),
          misses: z.number().nullish(),
          expected_rebuilds: z.number().nullish(),
          hit_ratio: z.number().nullish(),
          cache_write_tokens: z.number().nullish(),
          miss_recache_tokens: z.number().nullish(),
          last_miss_at: z.number().nullish(),
          recache_tokens_if_cold: z.number().nullish(),
          last_miss_cause: z.object({ causes: z.array(z.unknown()).max(20).nullish() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export const HookEventSchema = z.object({
  event: z.enum([
    'permission_prompt',
    'elicitation_dialog',
    'elicitation_complete',
    'elicitation_response',
    'idle_prompt',
    'stop',
    'teammate_idle',
    'task_completed',
    // Claude Code's UserPromptSubmit: a first-hand report of the pane's live
    // conversation id. Keep in step with HookEventType in types/api.ts.
    'prompt_submitted',
    // Claude Code's PreCompact and SessionStart(source "compact"): a context compaction started / ended.
    'compact_started',
    'compact_finished',
    // A turn STARTED. Unlike the others this one has no Claude Code hook behind
    // it: it is reported by the DeepSeek Harness status shim, and exists so a
    // dialog answered in the terminal resolves its Approvals Inbox item at once
    // instead of lingering red until the next `stop`.
    'agent_working',
  ]),
  sessionId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});
