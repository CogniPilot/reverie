/**
 * @fileoverview Workflow (ultracode) run-watcher polling and cache configuration.
 *
 * Controls how frequently WorkflowRunWatcher polls
 * ~/.claude/projects/<projHash>/<sessionUuid>/workflows/wf_*.json
 * and how many runs are cached in memory.
 *
 * Distinct from the Agent-Teams config (team-config.ts). The run-state JSON is
 * rewritten on every agent tick across a whole run (28+ agents), so the watcher
 * relies on a per-file mtime skip; the poll itself is just N stat() calls.
 *
 * @module config/workflow-config
 */

/** Workflow run-state poll interval (ms). Short because a poll is just N mtime stats. */
export const WORKFLOW_RUN_POLL_INTERVAL_MS = 10_000;

/** Max cached workflow runs (LRU eviction). */
export const MAX_CACHED_WORKFLOW_RUNS = 100;

/**
 * Default recency window (minutes) for getRecentRuns(). Generous enough that a
 * recently-finished long run still appears in the LEFT-pane list — filtered on
 * last-activity, not start time, so multi-hour runs don't vanish.
 */
export const WORKFLOW_RUN_RECENT_WINDOW_MIN = 240;
