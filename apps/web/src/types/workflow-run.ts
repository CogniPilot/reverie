/**
 * @fileoverview Types for ultracode / Workflow-tool run visualization.
 *
 * A Workflow run persists its state to
 * `~/.claude/projects/<projHash>/<sessionUuid>/workflows/wf_<runId>.json`
 * (a sibling of the deeper `subagents/workflows/wf_<runId>/agent-*.jsonl`
 * transcript tree that subagent-watcher tracks). This file is the single source
 * for the master-detail "working agents" view: a run's tasks/phases on the LEFT
 * and per-agent stats (tokens burned, tool calls) on the RIGHT.
 *
 * Field presence is STATE-DRIVEN and verified against real runs on disk:
 *   - state 'start'    (queued): no agentId/tokens/toolCalls/startedAt/durationMs/...
 *   - state 'progress' (running): has agentId/tokens/toolCalls, no durationMs/resultPreview
 *   - state 'done'     (finished): all fields, incl. durationMs/resultPreview
 * Absent fields are genuinely ABSENT (never explicit null) — use `?:`, not null.
 *
 * @module types/workflow-run
 */

/** One declared phase of a run (from the run JSON's top-level `phases[]`, 0-indexed). */
export interface WorkflowRunPhase {
  /** Phase title; equals each member agent's `phaseTitle`. Always present. */
  title: string;
  /** Human description of the phase. Always present in `phases[]`. */
  detail: string;
}

/**
 * One agent slot in a run, derived from `workflowProgress[]` entries where
 * `type === 'workflow_agent'`. Optional fields are absent until the agent
 * reaches the relevant lifecycle state (see module doc).
 */
export interface WorkflowAgentInfo {
  /** 1-based stable slot index, unique within the run. Always present. */
  index: number;
  /** Agent label, e.g. "probe:dompurify-config". Always present. */
  label: string;
  /** 1-based phase number; join via `run.phases[phaseIndex - 1]`. Always present. */
  phaseIndex: number;
  /** Phase title (=== run.phases[phaseIndex-1].title). Always present. */
  phaseTitle: string;
  /** Model id, e.g. "claude-opus-4-8[1m]". Always present. */
  model: string;
  /** Lifecycle state. Real on-disk values: 'start' | 'progress' | 'done'. Open union. */
  state: 'start' | 'progress' | 'done' | (string & {});
  /** Epoch ms the slot was queued. Always present. */
  queuedAt?: number;
  /** Epoch ms of the last progress tick. Always present once any progress occurs. */
  lastProgressAt?: number;
  /** Truncated prompt the agent was given. Always present. */
  promptPreview?: string;
  /**
   * Globally-unique agent id; equals the `agent-<agentId>.jsonl` transcript stem
   * (the Phase-4 correlation key). ABSENT while state === 'start'.
   */
  agentId?: string;
  /** Epoch ms the agent began. Absent while 'start'. */
  startedAt?: number;
  /** Attempt counter. Absent while 'start'. */
  attempt?: number;
  /** Tokens burned so far (RIGHT pane). Absent while 'start'. */
  tokens?: number;
  /** Tool calls made so far (RIGHT pane). Absent while 'start'. */
  toolCalls?: number;
  /** Name of the most recent tool. Present for progress/done (occasionally absent). */
  lastToolName?: string;
  /** Short summary of the most recent tool call. May be absent even when 'done'. */
  lastToolSummary?: string;
  /** Total run time (ms). Present ONLY when 'done' — the live-vs-finished discriminator. */
  durationMs?: number;
  /** Truncated final result. Present ONLY when 'done'. */
  resultPreview?: string;
}

/**
 * Run-level info shipped to the browser.
 *
 * IMPORTANT: the on-disk JSON also carries `script` (15–660KB of embedded JS),
 * `scriptPath`, `result`, and `logs`. The watcher STRIPS all four before the
 * object is ever cached/broadcast — never let them reach SSE/getLightState/route.
 */
export interface WorkflowRunInfo {
  /** Run id (=== the wf_<runId>.json filename stem). Always present. */
  runId: string;
  /** Workflow name from `meta.name`. Always present. */
  workflowName?: string;
  /**
   * Run status. Real on-disk values seen: 'completed' | 'killed'.
   * 'running' | 'failed' are inferred (parse defensively; keep open union).
   */
  status?: 'completed' | 'killed' | 'running' | 'failed' | (string & {});
  /** Concise human description (best LEFT-pane label). Always present. */
  summary?: string;
  /** Total agent slots, INCLUDING not-yet-started 'start' agents. */
  agentCount?: number;
  /** Total tokens across the run (partial mid-run). */
  totalTokens?: number;
  /** Total tool calls across the run (partial mid-run). */
  totalToolCalls?: number;
  /** Total run duration (ms). */
  durationMs?: number;
  /** Run start time (epoch MILLIS). */
  startTime?: number;
  /** ISO end/write timestamp. */
  timestamp?: string;
  /** Default model for the run. */
  defaultModel?: string;
  /** Background-task id that owns the run. */
  taskId?: string;
  /** Declared phases (0-indexed). */
  phases: WorkflowRunPhase[];
  /** Agents, derived from `workflowProgress` filtered to `type === 'workflow_agent'`. */
  agents: WorkflowAgentInfo[];
  /** Error message, present when status is 'killed'/'failed'. */
  error?: string;

  // ----- Watcher-derived (NOT in the JSON body — captured from the file path) -----
  /** `<sessionUuid>` path segment (for per-session scoping). */
  sessionUuid: string;
  /** `<projHash>` path segment. */
  projectHash: string;
  /**
   * Most recent activity (epoch ms): max agent `lastProgressAt`, else `startTime`.
   * Drives recency filtering/sorting so finished long runs still surface.
   */
  lastActivityAt: number;
}

/**
 * Lightweight run projection (no `agents[]`) for the LEFT-pane list and the
 * getLightState reconnect snapshot. A full run with 28 agents serializes to
 * ~36KB; the snapshot ships dozens of runs, so it carries summaries only and the
 * RIGHT pane fetches the full run (`GET /api/workflows/:runId`) on selection.
 */
export type WorkflowRunSummary = Omit<WorkflowRunInfo, 'agents'>;
