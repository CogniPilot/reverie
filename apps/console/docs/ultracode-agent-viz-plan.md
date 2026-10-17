# Ultracode / Workflow Agent Visualization — Design & Implementation Plan

> **Status: IMPLEMENTED (2026-06-15, rev. 3) — Phases 1–3 shipped & verified; Phase 4 (live-transcript link) deferred.** A dedicated, opt-in **master-detail tab** (`showUltracodeAgents`, default OFF) shows ultracode/Workflow runs as Claude Code's "working agents" TUI: LEFT = runs + phases (selectable tasks), RIGHT = each run's agents with model, live state, **tokens burned**, and **tool calls**.
>
> ### What rev. 3 changed vs. rev. 2 (decided during implementation against on-disk truth)
> 1. **UI is a master-detail TAB, not grouped floating subagent windows.** The user asked for the CC "working agents" view (left task picker, right agent stats). Built as a new docked panel `#ultracodeAgentsPanel` (clones `.subagents-panel` master-detail CSS) + `src/web/public/ultracode-panel.js` — NOT via `openSubagentWindow`/grouped windows.
> 2. **STANDALONE — zero edits to `subagent-watcher.ts`.** w16-claudeman's commit `f6a30d7` already discovers the per-agent workflow *transcripts* (`watchWorkflowDirs`). The data the view needs (run/phase/per-agent tokens+toolCalls) lives in the *run-state* JSON, read by a brand-new `src/workflow-run-watcher.ts` (globs the disjoint `…/workflows/wf_*.json` tree). No shared files with w16.
> 3. **No per-agent transcript streaming needed for v1.** The run-state JSON already carries `tokens`/`toolCalls`/`state`/`label`/`phase` per agent, so the whole view reads from `wf_<runId>.json` alone. (Phase 4 will optionally link a card to its already-tracked transcript via `agentId` — no watcher edits.)
> 4. **Agent states are `start | progress | done`** (verified on disk) — NOT running/queued. `start`=queued (no agentId/tokens/toolCalls yet), `done` has `durationMs`/`resultPreview`.
> 5. **The run JSON's `script` (15–660KB embedded JS), `scriptPath`, `result`, `logs` are STRIPPED in the watcher** before caching/broadcast (a 28-agent run drops 174KB → ~25KB; `promptPreview`/`resultPreview` truncated).
> 6. **SSE/snapshot ship lightweight run SUMMARIES (no `agents[]`); the RIGHT pane fetches the full run** via `GET /api/workflows/:runId` on selection. (A 25-run snapshot is ~20KB vs ~900KB if it carried every agent.) The LEFT list shows ALL cached runs (LRU-bounded), not a recency window — a run browser must show past runs.
>
> _Original rev. 2 proposal (grouped floating windows, extending subagent-watcher) preserved below for context; superseded by the above._

### What changed in rev. 2 (vs. the first draft)

1. **No backend cross-watcher coupling.** The per-agent label/phase/agentType/state **join moves to the frontend at render time** — the run object already carries every agent's entry keyed by `agentId`. This deletes `subagent-watcher`'s backward dependency on `workflow-run-watcher` (`getAgentLabel()` + its TTL cache), removes the registration-vs-run-state **race** (labels always track the latest `workflow:run_updated`), and drops the per-agent `meta.json` read from the hot path.
2. **`SubagentInfo` grows by 2 fields, not 4** (`isWorkflowAgent`, `workflowRunId`) — both derivable from the file path alone at registration, zero extra I/O. `agentType`/`label`/`phase`/`state` come from the run object on the frontend.
3. **The `isInternalAgent` bypass covers BOTH drop sites** — `registerAgentFile` *and* the late re-resolution in `processEntry`. The first draft named only one.
4. **De-duplicated.** Each trap (`journal.jsonl`, the `projects/*/*/workflows` depth, the gate-mismatch lesson, reuse-not-rebuild) is stated once in its owning section.

### Code-reuse verified against the tree (2026-06-14)

Confirmed present and shaped as assumed: `subagent-watcher.ts` — `watchSubagentDir`/`registerAgentFile`/`tailFile`/`processEntry`, `getRecentSubagents`, `isInternalAgent` (drops on `MIN_DESCRIPTION_LENGTH=5`), `STARTUP_MAX_FILE_AGE_MS=4h`, `MAX_TRACKED_AGENTS`, `knownSubagentDirs`/`dirWatchers`. `team-watcher.ts` — `configMtimes` mtime-skip + chokidar + `setInterval` poll. `server.ts` — `setupSubagentWatcherListeners`, `getLightState()` (`subagents: getRecentSubagents(15)`, `LIGHT_STATE_CACHE_TTL_MS=1000`), `isSubagentTrackingEnabled()` (`settings.subagentTrackingEnabled ?? true`). Frontend — `_SSE_HANDLER_MAP`, `this.subagents` Map, `handleInit`/`cleanupAllFloatingWindows`, `renderSubagentPanel`/`_renderSubagentPanelImmediate`, `getTeammateBadgeHtml`, `openSubagentWindow` + `.subagent-window-parent` sub-header.

## 1. The enabling fact: on-disk artifacts

The Workflow tool (what `ultracode` drives) persists each workflow agent as a transcript under the **same `subagents/` directory Codeman already watches**, one level deeper. Empirically verified against a real run (`wf_a8e09f2c-550`); **re-confirm the shape against a fresh run at implementation time** (§8 mandates a live e2e pass anyway):

```
~/.claude/projects/<projHash>/<sessionUuid>/
  ├─ subagents/
  │    ├─ agent-XX.jsonl                    ← regular Task subagent (tracked today)
  │    └─ workflows/wf_<runId>/
  │         ├─ agent-YY.jsonl               ← WORKFLOW agent — IDENTICAL line format
  │         ├─ agent-YY.meta.json           ← {"agentType":"workflow-subagent"} (optional enrichment)
  │         └─ journal.jsonl                ← run journal {type:"started",...} — MUST be skipped
  └─ workflows/wf_<runId>.json              ← run state: runId, workflowName, summary, status,
                                               phases[], workflowProgress[], totals (DIFFERENT tree)
```

The per-agent `.jsonl` line shape is identical to a regular subagent transcript:

```jsonc
{ "parentUuid": null, "isSidechain": true, "agentId": "ac6a1d27012a64e38",
  "type": "user" | "assistant", "message": { "role": "...", "content": "..." }, ... }
```

Because the line shape is identical, the entire existing parse→event→render pipeline works unchanged once discovery reaches those files. The only new data is the **run-level metadata** in `workflows/wf_<runId>.json` (name, summary, phases, and `workflowProgress[]` — the per-agent labels/state/tools), which supplies the group header and per-agent labels.

**Can show:** per-agent live transcript (tool calls, messages, results); per-agent status (active/idle/completed via the existing mtime/PID/pgrep liveness); per-agent model + running token totals (from each agent's JSONL `message.usage`, exactly as today); the run's `workflowName`/`summary`/`phases[]`; per-agent `label`/`phaseTitle`/`state`/`lastToolName` (from `workflowProgress[]`); grouping under `wf_<runId>`.

**Cannot show:** anything absent from the artifacts — a live phase cursor beyond `workflowProgress[].state`; an authoritative **budget/cost ceiling** (only consumed totals exist — `usage` + run-state `totalTokens`, no remaining-budget field); runs older than `STARTUP_MAX_FILE_AGE_MS` (4h) after a server restart (live monitoring only).

## 2. Architecture

**Decision: EXTEND `subagent-watcher.ts` for per-agent discovery/streaming; ADD a thin `workflow-run-watcher.ts` (modeled on `team-watcher.ts`) for the group-header metadata ONLY. The agent→run-metadata join happens on the FRONTEND, so the two watchers stay decoupled.**

- The per-agent JSONL is identical in shape, so re-running it through `registerAgentFile()` → `tailFile()` → `processEntry()` and the existing `subagent:*` events is free and reconnect-safe (those agents land in `agentInfo`, replayed by `getRecentSubagents(15)`). A parallel per-agent watcher would duplicate the liveness/token/tool-call/SSE machinery for zero benefit.
- Run metadata lives in a *different* file under a *different* tree (`workflows/wf_<runId>.json`, sibling to `subagents/`). A small `WorkflowRunWatcher` watching `projects/*/*/workflows/wf_*.json` (mtime-skip, like `team-watcher`'s `configMtimes`) is the clean home; folding it into `subagent-watcher` would entangle two unrelated watch roots and put a JSON re-read in the hot per-line path.
- **The two watchers never call each other.** The frontend receives both streams and joins agent→label by `agentId` at render time (the run object carries every agent's entry). This removes the timing coupling entirely.

```
~/.claude/projects/<projHash>/<sessionUuid>/
  ├─ subagents/
  │    ├─ agent-XX.jsonl ──────────────► SubagentWatcher (EXTENDED: also descends
  │    └─ workflows/wf_<runId>/                workflows/wf_<runId>/, tags isWorkflowAgent+runId)
  │         ├─ agent-YY.jsonl ─┐           reuse registerAgentFile/tailFile/processEntry
  │         └─ journal.jsonl (SKIP)        emits subagent:* (now w/ 2 workflow fields)
  └─ workflows/wf_<runId>.json ──────► WorkflowRunWatcher (NEW, team-watcher-shaped)
       {workflowName,phases,workflowProgress[]}   emits workflow:run_discovered|updated|removed

                         server.ts
   setupSubagentWatcherListeners()    ──► broadcast(subagent:*)     ─┐
   setupWorkflowRunWatcherListeners() ──► broadcast(workflow:run_*)  │ SSE
   getLightState(): subagents + workflowRuns ───────────────────────┘
                              │
                              ▼  app.js dispatch table
   panels-ui: partition this.subagents by workflowRunId; header + per-agent
   labels JOINED from this.workflowRuns.get(runId).agents (by agentId)
```

## 3. Backend changes (ordered, file-by-file)

### 3a. `src/subagent-watcher.ts` — nested discovery + 2 tag fields

**(1) Extend `SubagentInfo` with exactly two optional fields** (optional → regular subagents and the wire shape are unaffected):

```ts
isWorkflowAgent?: boolean;   // true when discovered under subagents/workflows/<wf_runId>/
workflowRunId?: string;      // e.g. "wf_23dbeab2-152" (parent dir name)
```

Both are derived from the **file path alone** at registration — no extra reads. They ride existing `subagent:discovered|updated|completed` payloads (no new per-agent event). Do **not** add `agentType`/`label`/`phase`/`workflowName` here — those come from the run object on the frontend (§4c).

**(2) Constant.** `const WORKFLOWS_SUBDIR = 'workflows';` near the existing dir constants.

**(3) `watchSubagentDir()` — descend into `workflows/<wf_runId>/`.** After the existing direct-child registration loop:

```ts
// Workflow agents live one level deeper: subagents/workflows/<wf_runId>/agent-*.jsonl
const wfRoot = join(dir, WORKFLOWS_SUBDIR);
try {
  for (const runId of await readdir(wfRoot)) {
    if (!runId.startsWith('wf_')) continue;
    await this.watchWorkflowRunDir(join(wfRoot, runId), projectHash, sessionId, runId);
  }
} catch { /* no workflows subdir — normal for most sessions */ }
```

The existing `fs.watch(dir, …)` on `subagents/` is **non-recursive on Linux** and won't fire for writes inside `workflows/<runId>/`, so each run dir needs its own watcher.

**(4) New private `watchWorkflowRunDir(runDir, projectHash, sessionId, runId)`** — clone `watchSubagentDir`'s structure, but:
- Register only files matching `^agent-.*\.jsonl$`, **explicitly skipping `journal.jsonl`** (it ends in `.jsonl` but is `{type:'started',…}`, not a transcript — registering it would create a phantom agent).
- Call `registerAgentFile(filePath, projectHash, sessionId, isInitialScan, runId)` so the agent is tagged.
- Install one `watch(runDir, …)` per run dir; on `error` and `stop()`, reuse the existing teardown (close + delete from `dirWatchers`/`knownSubagentDirs`/`dirWatcherErrorHandlers`).
- Guard re-registration **per run dir** in `knownSubagentDirs`, **not** `wfRoot` — the 5s full scan must still re-`readdir(wfRoot)` to pick up *new* `wf_<runId>` dirs created mid-session.

**(5) `registerAgentFile()` — accept + apply `runId`.** Add a trailing optional `runId?: string`. When set, the whole change is:

```ts
if (runId) { info.isWorkflowAgent = true; info.workflowRunId = runId; }
```

No `meta.json` read, no run-state lookup, no description override. `agentId`s are globally unique `a<16hex>` (verified: 0 collisions across a 370-agent corpus), so keep the flat `agentInfo` map keyed by `agentId` — do **not** switch to a composite key. Add a one-line dev-assert log if `agentInfo.has(agentId)` with a *different* `workflowRunId`, so a future collision is observable.

**(6) `isInternalAgent` bypass — BOTH drop sites.** Workflow agents have no Task-tool spawn record, so `_resolveDescription` yields only the first-user-message fallback (often a long phase prompt) or empty → `isInternalAgent` (`length < MIN_DESCRIPTION_LENGTH`) would wrongly drop them. They are real by construction (the `subagents/workflows/wf_*/` path is the discriminator). Gate the drop on `!info.isWorkflowAgent` at **both** places:
- `registerAgentFile` initial check (`isInternalAgent(description)`),
- `processEntry`'s late re-resolution (the second `isInternalAgent` call).

**(7) `stop()` teardown.** Per-run watchers live in `dirWatchers`, so the existing close-all loop covers them — verify no separate map was introduced (24h runs spawn many `wf_<runId>` dirs → FSWatcher leak risk).

### 3b. NEW `src/workflow-run-watcher.ts` (singleton, EventEmitter — model on `team-watcher.ts`)

- **Watch root:** `~/.claude/projects/<projHash>/<sessionUuid>/workflows/wf_*.json` — **two** levels under `projects` (verified: `projects/*/workflows` is empty; must be `projects/*/*/workflows/`). chokidar `depth:3` + a poll fallback, mirroring `team-watcher`'s dual discovery + interval.
- **mtime-skip:** `runMtimes: Map<absPath, number>` (mirror `team-watcher.configMtimes`).
- **Parse:** read `wf_<runId>.json`, take the **top-level structured keys** (`runId`, `workflowName`, `summary`, `status`, `phases:[{title,detail}]`, `agentCount`, `defaultModel`, `durationMs`, `totalTokens`, `totalToolCalls`, `workflowProgress[]`). **Do NOT parse the embedded `script` string** — name/phases/summary are already top-level; the script's `export const meta` is redundant and costly. Derive `sessionUuid` from the dir name, `projectHash` from the dir above; expose `getProjectHash(workingDir)` for Codeman-session correlation.
- **`workflowProgress[] → agents[]`:** filter `type === 'workflow_agent'`, map each to a `WorkflowAgentEntry` (§3c) keyed by `agentId`. **This array is the join source the frontend uses** — no backend `getAgentLabel()` API, no TTL cache, no import from `subagent-watcher`.
- **Emit** `workflow:run_discovered|updated|removed` carrying `WorkflowRunInfo`; removal by set-diff (mirror `team-watcher`).
- **Lifecycle:** `start()`/`stop()` with `CleanupManager` teardown of chokidar + interval + caches; `LRUMap`-bounded run cache (24h memory rule).

### 3c. `src/types/` — workflow run types

```ts
export interface WorkflowAgentEntry {   // one workflowProgress[type==='workflow_agent']
  agentId: string; label: string; phaseIndex?: number; phaseTitle?: string;
  agentType?: string; model?: string; state?: string;       // 'done'|'running'|'queued'|...
  lastToolName?: string; lastToolSummary?: string; tokens?: number; toolCalls?: number;
}
export interface WorkflowRunInfo {
  runId: string; sessionUuid: string; projectHash: string;
  workflowName?: string; summary?: string; status?: string;  // 'running'|'completed'|...
  phases: Array<{ title: string; detail?: string }>;
  agentCount?: number; defaultModel?: string;
  agents: WorkflowAgentEntry[];          // workflowProgress filtered to workflow_agent, keyed by agentId
  startedAt?: number; durationMs?: number; totalTokens?: number; totalToolCalls?: number;
}
```

The two `SubagentInfo` workflow fields stay inline in `subagent-watcher.ts` (matching the existing convention).

### 3d. `src/web/sse-events.ts` — register run events

Add `workflow:run_discovered`, `workflow:run_updated`, `workflow:run_removed` after the `subagent:*` block and to the `SseEvent` union. **No new per-agent event** — workflow agents reuse `subagent:*`.

### 3e. `src/web/server.ts` — bridge, snapshot, gating

- **`setupWorkflowRunWatcherListeners()`** (beside `setupSubagentWatcherListeners`): map the three run events → `this.broadcast(...)`. Add `cleanupWorkflowRunWatcherListeners()` (store handler refs).
- **Start/stop:** call `workflowRunWatcher.start()`/`.stop()` beside `subagentWatcher`, **gated on the same enable condition** (§3f).
- **`getLightState()`:** add `workflowRuns: workflowRunWatcher.getRecentRuns(15)` beside `subagents: subagentWatcher.getRecentSubagents(15)` so headers replay on reconnect (agents already replay via `subagents`). Keep the `LIGHT_STATE_CACHE_TTL_MS` memoization.
- **Gating read:** add `isWorkflowAgentTrackingEnabled()` mirroring `isSubagentTrackingEnabled()` (boot-time `dataPath('settings.json')` read). Gate `workflowRunWatcher.start()` **and** the subagent-watcher `workflows/` descent (§3a-3) on `showUltracodeAgents` so non-opted-in users never register historical workflow agents.

### 3f. `src/web/schemas.ts` — settings key

Add `showUltracodeAgents: z.boolean().optional()` to the `.strict()` settings update schema near `showPlanUsageLimits` (required — `.strict()` 400s the whole PUT on an unknown key).

### 3g. `src/web/routes/system-routes.ts` — poll API

- `GET /api/subagents` and `GET /api/sessions/:id/subagents` include workflow agents once registered — **no change** (they carry `isWorkflowAgent`/`workflowRunId`; a consumer joins to `/api/workflows/:runId` for labels).
- Add `GET /api/workflows` → `workflowRunWatcher.getRecentRuns()` and `GET /api/workflows/:runId` (uniform `ApiResponse` contract; headers are also in `getLightState`).
- `GET /api/subagents/:agentId/transcript` works for workflow agents (they're in `agentInfo`) — no new route.

## 4. Frontend changes (file-by-file)

### 4a. `src/web/public/constants.js`
- Add the three SSE strings to `SSE_EVENTS`, matching §3d exactly (`WORKFLOW_RUN_DISCOVERED: 'workflow:run_discovered'`, etc.).
- Reuse `ZINDEX_SUBAGENT_BASE=1000` for the agent windows (they ARE subagent windows). The group **header/cluster** is in-flow panel DOM, not a floating window — no new z-index (1100 is plan-subagent).

### 4b. `src/web/public/app.js`
- Constructor: `this.workflowRuns = new Map();  // runId -> WorkflowRunInfo` beside `this.subagents`.
- `_SSE_HANDLER_MAP`: add three rows → `_onWorkflowRunDiscovered/Updated/Removed` (must exist before `connectSSE` builds the wrappers).
- `handleInit`: after seeding `data.subagents`, seed `this.workflowRuns` from `data.workflowRuns` (clear-then-set). **Clear `this.workflowRuns` everywhere the subagent Maps are cleared** (incl. `cleanupAllFloatingWindows`) — 24h leak guard.

### 4c. `src/web/public/panels-ui.js` — the join lives here
- `_onWorkflowRunDiscovered/Updated(data)` → `this.workflowRuns.set(data.runId, data)` + debounced re-render; `_onWorkflowRunRemoved` → delete + re-render.
- **No change to `_onSubagentDiscovered/Updated`** — they already store the whole payload, so the 2 new fields ride along.
- `renderSubagentPanel`/`_renderSubagentPanelImmediate`: when `showUltracodeAgents` is on, **partition `this.subagents` into flat (no `workflowRunId`) vs grouped-by-`workflowRunId`**. Flat agents render exactly as today. For each group: build the header from `this.workflowRuns.get(runId)` (`workflowName` + phase/status chip from `phases[]`), then render that run's agents reusing the existing per-agent row markup. **Per-agent label/phase/agentType come from the JOIN** — build `Map(agentId → entry)` from `this.workflowRuns.get(runId).agents` and look each agent up by `agent.agentId`; render the small chip via the `getTeammateBadgeHtml` pattern. (If the run object hasn't arrived yet, fall back to the agent's own `description` — the run `:updated` event will fill it in on the next render.)
- `findParentSessionForSubagent` is unchanged — workflow agent `sessionId === session.claudeSessionId`. **Do not conflate `workflowRunId` with `sessionId`.**

### 4d. `src/web/public/subagent-windows.js`
**Decision: REUSE `.subagent-window` per agent + a group sub-header — do NOT build a cluster class.** A cluster path duplicates Map/z-index/drag/cleanup/persistence for no functional gain; reuse keeps connection lines, minimize-to-tab, and `localStorage` persistence. In `openSubagentWindow`, where the optional `.subagent-window-parent` sub-header is built: when `agent.workflowRunId` is set, inject a `.subagent-workflow-header` showing `this.workflowRuns.get(runId)?.workflowName` + the joined agent's `label`/phase (look up by `agentId`), mirroring the `from <session>` sub-header. Respect the existing skip guards (teammate-terminal windows, minimized/`_lazyTerminal`).

**Do NOT auto-open windows** for workflow agents — a multi-phase run can spawn many, against the 50-window/60fps budget + `MAX_TRACKED_AGENTS=500`. They render collapsed in the grouped panel; the user expands via the existing panel buttons.

### 4e. `src/web/public/settings-ui.js` + `index.html`
- `index.html` Panels block: add a `settings-item` checkbox `id="appSettingsShowUltracodeAgents"` ("Show ULTRACODE / Workflow Agents").
- `openAppSettings`: load `settings.showUltracodeAgents` with `false` fallback (mirror `showPlanUsageLimits`).
- `saveAppSettings`: collect `showUltracodeAgents` into the fresh settings literal (uncollected keys reset to default every save).
- Live-apply on toggle: re-run `renderSubagentPanel()` (show/hide group sections) — a panel re-render, not a CSS-class strip.
- **SYNCED, not per-device:** do NOT add `showUltracodeAgents` to `displayKeys` and do NOT strip it in the per-device block. A synced value gives the server-side gate (`isWorkflowAgentTrackingEnabled`, §3e) one canonical truth to decide whether to run the watcher; a per-device value can't gate a process-wide watcher. (Contrast `showResponseViewer`, pure client display.)
- `styles.css` + `mobile.css`: add `.subagent-workflow-header` and `.subagent-group-badge` next to `.subagent-window-parent`; mirror device overrides in `mobile.css`.

## 5. Settings / opt-in wiring

- **Key:** `showUltracodeAgents` (boolean, **default OFF**). Fallback `false` in `openAppSettings`; "absent ⇒ off" in `isWorkflowAgentTrackingEnabled()`. Schema `z.boolean().optional()` in the `.strict()` update schema, kept OUT of `displayKeys` (synced).
- **Runtime gating:** `workflowRunWatcher.start()` and the subagent-watcher `workflows/` descent run only when the boot-time `settings.json` read reports `showUltracodeAgents === true` (mirroring `isSubagentTrackingEnabled`). The frontend additionally gates display. Toggling at runtime gates **display** immediately (panel re-render); the **watcher branch** picks up on next boot — matches existing `subagentTrackingEnabled` semantics. (Optional polish: restart just the workflow watcher on toggle for instant on/off.)

## 6. SSE events

**Reused (no change):** `subagent:discovered|updated|tool_call|tool_result|progress|message|completed`. Workflow agents flow through these; payloads now carry the optional `isWorkflowAgent`/`workflowRunId` fields on `SubagentInfo`. SSE payloads aren't schema-gated (typed only at `broadcast()` call sites), so the new fields propagate with zero friction.

**New (3 events, run-level metadata):**

| Event (backend const / frontend key) | Payload |
|---|---|
| `workflow:run_discovered` / `WORKFLOW_RUN_DISCOVERED` | `WorkflowRunInfo` |
| `workflow:run_updated` / `WORKFLOW_RUN_UPDATED` | `WorkflowRunInfo` |
| `workflow:run_removed` / `WORKFLOW_RUN_REMOVED` | `{ runId: string }` |

Sync requirement (CLAUDE.md): each must appear in **both** `sse-events.ts` (§3d) and `constants.js` `SSE_EVENTS` (§4a), be emitted via `broadcast()` in `setupWorkflowRunWatcherListeners()` (§3e), and have a dispatch-table row + `_on*` handler (§4b/§4c).

## 7. Edge cases & cleanup

- **`journal.jsonl` phantom-agent trap** — owned by §3a-4: run-dir registration requires the `agent-` prefix and excludes `journal.jsonl`.
- **`isInternalAgent` over-filtering** — owned by §3a-6: bypass at BOTH drop sites; titled from the frontend join (or the description fallback).
- **No workflow agents in the flat list** — `renderSubagentPanel` partitions on `agent.workflowRunId` (§4c). When the toggle is OFF, the descent never ran, so they aren't in `this.subagents` at all.
- **Completion/idle** — keep the existing per-agent mtime/PID/pgrep liveness as the per-card source of truth. Optionally render a group-level "workflow done" badge from run-state `status==='completed'`.
- **Limits** — `MAX_TRACKED_AGENTS=500` LRU-evicts workflow agents in the same flat map; no auto-open (50-window budget); the 4h `STARTUP_MAX_FILE_AGE_MS` skip means a run completed >4h ago won't reload after restart (acceptable — live monitoring).
- **Reconnect/replay** — agents via `getRecentSubagents(15)`; headers via `workflowRuns: getRecentRuns(15)` in `getLightState`. `handleInit` clears `this.workflowRuns` alongside the subagent Maps.
- **Watcher teardown** — every per-run `fs.watch` and the chokidar watcher closes in `stop()` and on `error`; `CleanupManager` for the new watcher (24h runs create many run dirs).
- **CLAUDE.md discipline** — read-only `~/.claude/...` artifacts; no new `~/.codeman/...` paths, no env-var prefixes touched. Claude-mode-only by nature (external CLIs don't write workflow transcripts).

## 8. Testing & verification

- **Unit (pure):**
  - `test/workflow-run-watcher.test.ts`: feed a scrubbed fixture `wf_<runId>.json` → assert `WorkflowRunInfo` extraction (name/summary/phases, `workflowProgress`→`agents[]` keyed by `agentId`), mtime-skip, removal-by-set-diff.
  - Extend `subagent-watcher` coverage: temp `subagents/workflows/wf_X/agent-Y.jsonl` + a stray `journal.jsonl` → assert `agent-Y` registered with `isWorkflowAgent`/`workflowRunId` and `journal.jsonl` NOT registered; assert a short-description workflow agent is NOT dropped at **either** `isInternalAgent` site.
- **Route/inject (`app.inject`):** `GET /api/workflows` + `:runId` return the `ApiResponse` envelope; `GET /api/subagents` includes a tagged agent.
- **Frontend (vm-sandbox, like `test/run-mode-ui.test.ts`):** dispatch `subagent:discovered` with `workflowRunId` + `workflow:run_discovered` → assert `renderSubagentPanel` produces a group section under the workflow name with the agent inside it (label sourced from the **join**, not flat); assert order-independence (agent before run, and run before agent both resolve); assert OFF hides the section.
- **REQUIRED real end-to-end** (the always-end-to-end-test rule — the plan-usage chip shipped *dead* from a gate mismatch): on dev/beta with `showUltracodeAgents` ON, **drive a real ultracode/workflow run**, then (1) `curl …/api/workflows | jq` shows the live run with `agents[]`; (2) `curl …/api/subagents | jq '.data[]|select(.isWorkflowAgent)'` shows tagged agents; (3) watch `/api/events` for `workflow:run_discovered` + `subagent:discovered` with the workflow fields; (4) Playwright (`waitUntil:'domcontentloaded'`, wait 3–4s) asserts the grouped DOM cluster renders with the workflow-name header and live status. Verify path gates against `GET /api/sessions` `workingDir`. **Test against a LIVE run** — all at-rest runs are `completed`/`done`; `running`/`queued` states only exist mid-run.

## 9. Phased rollout

| Phase | Scope | Done-check | Size |
|---|---|---|---|
| **P1 — Backend discovery + tagging (gated, no UI)** | §3a (nested descent, `journal.jsonl` skip, 2 `SubagentInfo` fields, `isInternalAgent` bypass ×2) + §3f schema key + §3e gate read. No run watcher yet. | With `showUltracodeAgents` forced on, `curl /api/subagents \| jq '.data[]\|select(.isWorkflowAgent)'` lists real workflow agents during a live run; flat subagents unchanged; `tsc --noEmit` + targeted watcher test green. | S–M |
| **P2 — Run-state metadata + SSE** | §3b (`workflow-run-watcher.ts`) + §3c types + §3d/§3e (SSE, bridge, `getLightState` replay) + §3g routes. | `curl /api/workflows \| jq` returns runs with `agents[]`/`phases`; SSE emits `workflow:run_discovered`; reconnect snapshot carries `workflowRuns`. | M |
| **P3 — Frontend grouped UI** | §4a–§4d (constants, app.js state/dispatch/init, panels-ui grouped render + **agent→label join**, subagent-windows group sub-header). Reuse `.subagent-window`; no auto-open. | Playwright: live run renders a group section under the workflow name with per-agent rows + live status + joined labels; flat subagents stay flat; expand opens a window with the workflow sub-header. | M |
| **P4 — Settings toggle + polish + docs** | §4e (checkbox, settings-ui load/save/live-apply, SYNCED), styles/mobile, phase chips, CLAUDE.md "Key Patterns" entry + this doc's status → SHIPPED. | Toggling the checkbox shows/hides the cluster live (no reload for display); OFF by default on a fresh install; CI green. | S |

Each phase is independently shippable: P1 is invisible (gated, no UI), P2 adds an API with no UI dependency, P3 lights up the UI for flag-enablers, P4 exposes the toggle and finalizes defaults/docs.

## 10. Effort & risk

**Size:** P1 = S–M, P2 = M, P3 = M, P4 = S. Total ≈ **M** (one focused engineer, ~2–4 days incl. the real end-to-end run — down from the first draft's M-L now that the backend join/coupling is gone).

**Top 3 risks:**

1. **Non-recursive watch on Linux misses live writes.** `fs.watch` is non-recursive and `{recursive:true}` is unreliable on Linux → per-`wf_<runId>` watchers (§3a-4) are correct, but the 5s full scan must re-`readdir(wfRoot)` to catch *new* run dirs mid-session, and each watcher must be torn down to avoid FSWatcher leaks in 24h runs. Mitigation: explicit per-run-dir registration + verified `dirWatchers` teardown; chokidar (with `CleanupManager`) only in the new run watcher, where `team-watcher` already proves the pattern.
2. **Discovery cost / over-registration.** A user with hundreds of historical workflow agents could flood `agentInfo` on boot. Mitigation: the 4h `STARTUP_MAX_FILE_AGE_MS` skip drops old files on the initial scan, the descent only runs when the toggle is on, and `MAX_TRACKED_AGENTS=500` LRU-evicts. Verify boot scan time doesn't regress with the corpus present.
3. **Shipping-dead-on-a-gate** (the repo's recurring failure mode — the plan-usage chip shipped dead because injection was gated on `CASES_DIR` while real sessions ran elsewhere). Same trap here if the path/mode gate is wrong (e.g. `projects/*/workflows` instead of `projects/*/*/workflows`, or correlation via the wrong session key). Mitigation: the **mandatory live ultracode end-to-end run** in §8 against a real session's `workingDir`, observing the real SSE event + real DOM cluster — not the at-rest corpus, not unit tests alone.
