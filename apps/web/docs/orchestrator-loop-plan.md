# Orchestrator Loop — Detailed Implementation Plan (v2)

> Internal research/planning document. Not for GitHub.

## Vision

The **Orchestrator Loop** is a new autonomous execution mode that transforms high-level user goals into phased, verified, team-coordinated implementations. Unlike Ralph Loop (flat task queue → idle sessions), the Orchestrator manages the full lifecycle: **plan → approve → execute → verify → adapt → complete**.

```
USER: "Add OAuth2 login with Google/GitHub, role-based access control, and API key management"

ORCHESTRATOR:
  Phase 1: Research & Setup      ✅ (3m)  — scaffold, deps, config
  Phase 2: Auth Core             ✅ (8m)  — OAuth2 flow, session mgmt
  Phase 3: Provider Integration  🔄 (12m) — Google + GitHub (parallel via team agents)
  Phase 4: RBAC                  ⏳       — roles, permissions, middleware
  Phase 5: API Keys              ⏳       — generation, validation, rate limits
  Phase 6: Testing & Review      ⏳       — integration tests, security review

  Progress: ━━━━━━━━━━━━━━━━━━━━ 40%   |   Agents: 3 active   |   Time: 23m
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    OrchestratorLoop                               │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │ Orchestrator   │  │ Orchestrator   │  │ Orchestrator     │  │
│  │ Planner        │  │ Executor       │  │ Verifier         │  │
│  │                │  │                │  │                  │  │
│  │ PlanOrchestrator│ │ TaskQueue      │  │ AI review        │  │
│  │ + phase grouper│  │ SessionManager │  │ Test commands    │  │
│  │ + team strategy│  │ Team prompts   │  │ File checks      │  │
│  └───────┬────────┘  └───────┬────────┘  └─────────┬────────┘  │
│          │                   │                      │           │
│          └───────────────────┼──────────────────────┘           │
│                              │                                  │
│                    ┌─────────▼─────────┐                       │
│                    │  Existing Reverie  │                       │
│                    │  Infrastructure    │                       │
│                    │                    │                       │
│                    │  SessionManager    │                       │
│                    │  TaskQueue         │                       │
│                    │  RespawnController │                       │
│                    │  TeamWatcher       │                       │
│                    │  PlanOrchestrator  │                       │
│                    │  StateStore        │                       │
│                    │  Hooks + SSE       │                       │
│                    └────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

## State Machine

```
                              ┌─────────┐
                              │  IDLE   │
                              └────┬────┘
                                   │ start(goal)
                                   ▼
                              ┌─────────┐
                     ┌────────│PLANNING │────────┐
                     │ fail   └────┬────┘        │
                     ▼             │ plan ready   │ user cancels
                ┌────────┐        ▼              ▼
                │ FAILED │   ┌─────────┐    ┌────────┐
                └────────┘   │APPROVAL │    │ IDLE   │
                     ▲       └────┬────┘    └────────┘
                     │            │ approve
                     │            ▼
                     │       ┌──────────┐
                     │  ┌───►│EXECUTING │◄────────────────────┐
                     │  │    └────┬─────┘                     │
                     │  │         │ all tasks in phase done    │
                     │  │         ▼                            │
                     │  │    ┌──────────┐                     │
                     │  │    │VERIFYING │                     │
                     │  │    └────┬─────┘                     │
                     │  │    pass │    │ fail                  │
                     │  │         ▼    ▼                       │
                     │  │   more  ┌──────────┐                │
                     │  │  phases?│REPLANNING│── retry ────────┘
                     │  │    │    └────┬─────┘
                     │  │    │         │ max retries
                     │  │    │         ▼
                     │  │    │    ┌────────┐
                     │  └────┘    │ FAILED │
                     │  next      └────────┘
                     │  phase
                     │    │
                     │    ▼
                     │ ┌───────────┐
                     └─│ COMPLETED │
                       └───────────┘
```

**States:** `idle` | `planning` | `approval` | `executing` | `verifying` | `replanning` | `completed` | `failed` | `paused`

Transitions are event-driven. The state machine is the single source of truth — all methods check `this.state` before acting.

## Type Definitions

### `src/types/orchestrator.ts`

```typescript
// ═══════════════════════════════════════════════════════════════
// State Machine
// ═══════════════════════════════════════════════════════════════

export type OrchestratorState =
  | 'idle'
  | 'planning'
  | 'approval'
  | 'executing'
  | 'verifying'
  | 'replanning'
  | 'completed'
  | 'failed'
  | 'paused';

// ═══════════════════════════════════════════════════════════════
// Plan Structure
// ═══════════════════════════════════════════════════════════════

export interface OrchestratorPlan {
  id: string;
  goal: string;
  createdAt: number;
  phases: OrchestratorPhase[];
  metadata: {
    totalTasks: number;
    estimatedComplexity: 'low' | 'medium' | 'high';
    modelUsed: string;
    planDurationMs: number;
  };
}

export interface OrchestratorPhase {
  id: string;                      // "phase-1", "phase-2"
  name: string;                    // Human-readable name
  description: string;
  order: number;
  status: PhaseStatus;
  tasks: OrchestratorTask[];
  verificationCriteria: string[];
  testCommands: string[];
  maxAttempts: number;             // Default: 3
  attempts: number;                // Current attempt count
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  teamStrategy: TeamStrategy;
}

export type PhaseStatus =
  | 'pending'
  | 'executing'
  | 'verifying'
  | 'passed'
  | 'failed'
  | 'skipped';

export interface OrchestratorTask {
  id: string;                      // "phase-1-task-1"
  phaseId: string;
  prompt: string;                  // Single-line prompt for Claude
  status: 'pending' | 'running' | 'completed' | 'failed';
  assignedSessionId: string | null;
  queueTaskId: string | null;     // Links to TaskQueue task
  parallel: boolean;               // Can run in parallel with sibling tasks
  completionPhrase: string;        // Unique phrase for completion detection
  timeoutMs: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  retries: number;
}

// ═══════════════════════════════════════════════════════════════
// Team Strategy
// ═══════════════════════════════════════════════════════════════

export type TeamStrategy =
  | { type: 'single' }                          // One session handles all
  | { type: 'parallel'; maxSessions: number }   // Multiple sessions
  | { type: 'team'; config: TeamSetup }          // Agent teams

export interface TeamSetup {
  leadPrompt: string;
  suggestedTeammates: string[];    // Role descriptions
  maxTeammates: number;
}

// ═══════════════════════════════════════════════════════════════
// Verification
// ═══════════════════════════════════════════════════════════════

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  summary: string;
  suggestions: string[];           // Recovery hints for replanning
}

export interface VerificationCheck {
  type: 'test_command' | 'ai_review' | 'file_check';
  description: string;
  passed: boolean;
  output?: string;
}

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

export interface OrchestratorConfig {
  plannerModel: string;            // Default: 'opus'
  researchEnabled: boolean;        // Default: true
  autoApprove: boolean;            // Default: false
  maxPhaseRetries: number;         // Default: 3
  phaseTimeoutMs: number;          // Default: 1800000 (30min)
  enableTeamAgents: boolean;       // Default: true
  maxParallelSessions: number;     // Default: 3
  verificationMode: 'strict' | 'moderate' | 'lenient';
  compactBetweenPhases: boolean;   // Default: true
}

// ═══════════════════════════════════════════════════════════════
// Persistence (saved to ~/.reverie/state.json)
// ═══════════════════════════════════════════════════════════════

export interface OrchestratorPersistState {
  state: OrchestratorState;
  plan: OrchestratorPlan | null;
  currentPhaseIndex: number;
  startedAt: number | null;
  completedAt: number | null;
  config: OrchestratorConfig;
  stats: OrchestratorStats;
}

export interface OrchestratorStats {
  phasesCompleted: number;
  phasesFailed: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  totalDurationMs: number;
  replanCount: number;
}
```

## New Files (Implementation Order)

### Step 1: `src/types/orchestrator.ts` — Type definitions
All interfaces above. No dependencies. ~120 lines.

### Step 2: `src/orchestrator-planner.ts` — Plan generation + phase grouping
~300 lines. Wraps existing PlanOrchestrator.

```typescript
/**
 * @fileoverview Orchestrator plan generation — converts goals into phased plans.
 *
 * Uses PlanOrchestrator for AI plan generation, then groups PlanItems into
 * sequential phases with team strategies and verification criteria.
 *
 * @module orchestrator-planner
 */

export class OrchestratorPlanner {
  constructor(mux: TerminalMultiplexer, workingDir: string, config: OrchestratorConfig);

  /** Generate plan from goal. Uses PlanOrchestrator internally. */
  async generatePlan(goal: string, onProgress?: ProgressCallback): Promise<OrchestratorPlan>;

  /** Cancel in-progress plan generation. */
  async cancel(): Promise<void>;

  // Internal
  private groupIntoPhases(items: PlanItem[], goal: string): OrchestratorPhase[];
  private assignTeamStrategies(phases: OrchestratorPhase[]): void;
  private generateCompletionPhrases(plan: OrchestratorPlan): void;
}
```

**Phase grouping algorithm:**
1. Topological sort by `PlanItem.dependencies`
2. Group into dependency layers (Kahn's algorithm)
3. Within each layer, sub-group by `tddPhase` (setup → test → impl → verify → review)
4. Merge adjacent small phases (< 2 tasks) if they share the same tddPhase
5. Assign team strategies:
   - 1-2 tasks → `{ type: 'single' }`
   - 3+ independent tasks → `{ type: 'parallel', maxSessions: Math.min(taskCount, config.maxParallelSessions) }`
   - 4+ tasks with high complexity → `{ type: 'team', config: { ... } }`
6. Generate unique completion phrases per task: `ORCH_P{phaseOrder}_T{taskIndex}`

### Step 3: `src/orchestrator-verifier.ts` — Phase verification
~200 lines.

```typescript
/**
 * @fileoverview Orchestrator phase verification.
 *
 * Runs verification checks after each phase completes:
 * test commands, AI review, and file existence checks.
 *
 * @module orchestrator-verifier
 */

export class OrchestratorVerifier {
  constructor(config: OrchestratorConfig);

  /** Run all verification checks for a completed phase. */
  async verifyPhase(
    phase: OrchestratorPhase,
    session: Session,
    mode: 'strict' | 'moderate' | 'lenient'
  ): Promise<VerificationResult>;

  // Verification strategies
  private async runTestCommands(commands: string[], session: Session): Promise<VerificationCheck[]>;
  private async aiReview(phase: OrchestratorPhase, session: Session): Promise<VerificationCheck>;
}
```

**Verification modes:**
- `strict`: ALL test commands must pass AND AI review must approve
- `moderate`: Test commands must pass, AI review is advisory
- `lenient`: At least one test command passes, AI review skipped

**AI review prompt (sent as a task to the session):**
```
Review Phase "{phase.name}" completion. Check:
1. Expected functionality works
2. No obvious regressions
3. Code quality is acceptable

Criteria: {phase.verificationCriteria.join('\n')}

If ALL criteria are met, respond: ORCH_VERIFY_PASS
If ANY criteria fail, respond: ORCH_VERIFY_FAIL and explain what failed.
```

### Step 4: `src/orchestrator-loop.ts` — Core state machine
~500 lines. Main orchestrator engine.

```typescript
/**
 * @fileoverview Orchestrator Loop — phased plan execution with team agents.
 *
 * State machine that generates plans from user goals, executes them
 * phase-by-phase with verification gates, and adapts on failure.
 *
 * @module orchestrator-loop
 */

export interface OrchestratorLoopEvents {
  stateChanged: (state: OrchestratorState, prevState: OrchestratorState) => void;
  planReady: (plan: OrchestratorPlan) => void;
  phaseStarted: (phase: OrchestratorPhase) => void;
  phaseCompleted: (phase: OrchestratorPhase) => void;
  phaseFailed: (phase: OrchestratorPhase, reason: string) => void;
  taskAssigned: (task: OrchestratorTask, sessionId: string) => void;
  taskCompleted: (task: OrchestratorTask) => void;
  taskFailed: (task: OrchestratorTask, error: string) => void;
  verificationResult: (phase: OrchestratorPhase, result: VerificationResult) => void;
  completed: (stats: OrchestratorStats) => void;
  error: (error: Error) => void;
}

export class OrchestratorLoop extends EventEmitter {
  private state: OrchestratorState = 'idle';
  private plan: OrchestratorPlan | null = null;
  private currentPhaseIndex = 0;
  private config: OrchestratorConfig;
  private planner: OrchestratorPlanner;
  private verifier: OrchestratorVerifier;
  private sessionManager: SessionManager;
  private taskQueue: TaskQueue;
  private store: StateStore;
  private stats: OrchestratorStats;
  private cleanup: CleanupManager;
  private pausedState: OrchestratorState | null = null; // State before pause

  // ── Lifecycle ──────────────────────────────────────────────

  constructor(mux: TerminalMultiplexer, workingDir: string, config?: Partial<OrchestratorConfig>);

  /** Start orchestration with a goal. Transitions: idle → planning */
  async start(goal: string): Promise<void>;

  /** Approve the generated plan. Transitions: approval → executing */
  async approve(): Promise<void>;

  /** Reject plan with feedback. Transitions: approval → planning (regenerate) */
  async reject(feedback: string): Promise<void>;

  /** Pause execution. Saves current state. */
  pause(): void;

  /** Resume from pause. */
  resume(): void;

  /** Stop everything and clean up. → idle */
  async stop(): Promise<void>;

  /** Skip current phase. → executing (next phase) or completed */
  async skipPhase(phaseId: string): Promise<void>;

  /** Retry a failed phase. → executing */
  async retryPhase(phaseId: string): Promise<void>;

  // ── Getters ────────────────────────────────────────────────

  getState(): OrchestratorState;
  getPlan(): OrchestratorPlan | null;
  getCurrentPhase(): OrchestratorPhase | null;
  getStats(): OrchestratorStats;
  getStatus(): OrchestratorPersistState;

  // ── Internal: Phase Execution ──────────────────────────────

  private async executeCurrentPhase(): Promise<void>;
  private async executePhase(phase: OrchestratorPhase): Promise<void>;
  private async assignPhaseTasks(phase: OrchestratorPhase): Promise<void>;
  private handleTaskCompleted(taskId: string): void;
  private handleTaskFailed(taskId: string, error: string): void;
  private async onPhaseTasksComplete(phase: OrchestratorPhase): Promise<void>;

  // ── Internal: Verification ─────────────────────────────────

  private async verifyCurrentPhase(): Promise<void>;
  private async handleVerificationResult(phase: OrchestratorPhase, result: VerificationResult): Promise<void>;

  // ── Internal: Replanning ───────────────────────────────────

  private async replanPhase(phase: OrchestratorPhase, failures: string[]): Promise<void>;

  // ── Internal: State Machine ────────────────────────────────

  private setState(newState: OrchestratorState): void;
  private advanceToNextPhase(): Promise<void>;
  private persist(): void;
  private restore(): void;
}
```

**Key execution flow in `executePhase()`:**
1. Mark phase as `executing`, emit `phaseStarted`
2. For each task in phase:
   - Create a `CreateTaskOptions` from `OrchestratorTask`
   - Add to `TaskQueue` with proper dependencies + completion phrase
   - Store the TaskQueue task ID in `OrchestratorTask.queueTaskId`
3. Poll task completion (listen to TaskQueue events)
4. When all tasks complete → call `onPhaseTasksComplete()`
5. `onPhaseTasksComplete()` triggers verification

**How tasks get assigned to sessions:**
The OrchestratorLoop does NOT manage session assignment directly. It adds tasks to the existing TaskQueue and starts a mini poll loop that assigns pending tasks to idle sessions — the same pattern as RalphLoop's `assignTasks()`. This reuses existing session management.

**Team agent flow:**
For phases with `teamStrategy.type === 'team'`:
- Start a single session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Instead of adding individual tasks to TaskQueue, send ONE comprehensive prompt to the lead
- The prompt instructs the lead to create teammates and delegate
- Monitor via TeamWatcher for team task completion + hook events
- Phase completion is detected via the lead's completion phrase

### Step 5: `src/web/routes/orchestrator-routes.ts` — API endpoints
~300 lines.

```
POST   /api/orchestrator/start          — { goal, config? } → start planning
POST   /api/orchestrator/approve        — approve generated plan
POST   /api/orchestrator/reject         — { feedback } → reject + replan
POST   /api/orchestrator/pause          — pause execution
POST   /api/orchestrator/resume         — resume execution
POST   /api/orchestrator/stop           — stop orchestration
GET    /api/orchestrator/status         — full state + plan + stats
GET    /api/orchestrator/plan           — plan details only
POST   /api/orchestrator/phase/:id/skip — skip a phase
POST   /api/orchestrator/phase/:id/retry — retry a failed phase
```

Port dependency: `SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort`

The route module receives the OrchestratorLoop instance via the InfraPort (added to `createRouteContext()`).

### Step 6: SSE Events — `src/web/sse-events.ts` additions

```typescript
// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Orchestrator state machine transitioned. */
export const OrchestratorStateChanged = 'orchestrator:stateChanged' as const;
/** Orchestrator plan generated and ready for approval. */
export const OrchestratorPlanReady = 'orchestrator:planReady' as const;
/** Orchestrator phase started executing. */
export const OrchestratorPhaseStarted = 'orchestrator:phaseStarted' as const;
/** Orchestrator phase completed successfully. */
export const OrchestratorPhaseCompleted = 'orchestrator:phaseCompleted' as const;
/** Orchestrator phase failed. */
export const OrchestratorPhaseFailed = 'orchestrator:phaseFailed' as const;
/** Orchestrator verification result for a phase. */
export const OrchestratorVerification = 'orchestrator:verification' as const;
/** Orchestrator task assigned to session. */
export const OrchestratorTaskAssigned = 'orchestrator:taskAssigned' as const;
/** Orchestrator task completed. */
export const OrchestratorTaskCompleted = 'orchestrator:taskCompleted' as const;
/** Orchestrator task failed. */
export const OrchestratorTaskFailed = 'orchestrator:taskFailed' as const;
/** All phases completed successfully. */
export const OrchestratorCompleted = 'orchestrator:completed' as const;
/** Orchestrator error. */
export const OrchestratorError = 'orchestrator:error' as const;
```

11 new events. Add to `SseEvent` namespace object + mirror in `constants.js`.

### Step 7: State persistence — `src/state-store.ts` additions

Add to `AppState`:
```typescript
orchestrator?: OrchestratorPersistState;
```

Add methods:
```typescript
getOrchestratorState(): OrchestratorPersistState | null;
setOrchestratorState(state: Partial<OrchestratorPersistState>): void;
clearOrchestratorState(): void;
```

### Step 8: Server integration — `src/web/server.ts` modifications

1. Import `OrchestratorLoop` and `registerOrchestratorRoutes`
2. Add `private orchestratorLoop: OrchestratorLoop` field
3. Initialize in constructor (lazy — created on first start, not at boot)
4. Add to `createRouteContext()` InfraPort: `orchestratorLoop: this.orchestratorLoop`
5. Wire up OrchestratorLoop events → SSE broadcasts
6. Register routes: `registerOrchestratorRoutes(this.app, ctx)`
7. Clean up in `stop()`

### Step 9: `src/web/public/orchestrator-ui.js` — Frontend panel
~500 lines. New frontend module.

**Load order**: After `panels-ui.js` (11), before `ralph-wizard.js` (13). So load order = 11.5.

**UI elements:**
- Goal input form (text area + config toggles)
- Plan approval view (phase list, task details, approve/reject buttons)
- Execution dashboard (progress bar, phase cards, task status indicators)
- Agent activity panel (session count, team status)
- Controls (pause, resume, stop, skip phase, retry phase)

**SSE listeners:**
- All 11 orchestrator events → update UI state
- Reuses existing session/respawn/team event handlers for agent monitoring

### Step 10: `src/prompts/orchestrator.ts` — Prompt templates
~200 lines.

Templates for:
- Phase execution prompt (tells Claude what to do in this phase)
- Team lead delegation prompt (instructs lead to create and coordinate teammates)
- Verification prompt (asks Claude to verify phase output)
- Replan prompt (gives failure context, asks for recovery steps)

### Step 11: Constants, schemas, route barrel updates

- `src/web/public/constants.js` — Add 11 SSE event mirrors
- `src/web/schemas.ts` — Add Zod schemas for orchestrator API input validation
- `src/web/routes/index.ts` — Export `registerOrchestratorRoutes`
- `src/web/ports/infra-port.ts` — Add `orchestratorLoop` to InfraPort
- `src/types/index.ts` — Export orchestrator types

## Existing File Modifications Summary

| File | Change | Lines |
|------|--------|-------|
| `src/types/index.ts` | Add orchestrator barrel export | +1 |
| `src/web/sse-events.ts` | Add 11 orchestrator events + SseEvent entries | +30 |
| `src/web/public/constants.js` | Mirror 11 SSE events | +15 |
| `src/web/routes/index.ts` | Export registerOrchestratorRoutes | +1 |
| `src/web/ports/infra-port.ts` | Add orchestratorLoop to InfraPort | +3 |
| `src/web/server.ts` | Initialize OrchestratorLoop, wire events, register routes | +40 |
| `src/web/schemas.ts` | Add orchestrator Zod schemas | +20 |
| `src/state-store.ts` | Add orchestrator state persistence | +20 |
| `src/web/public/app.js` | Add orchestrator SSE listeners + panel toggle | +30 |
| `src/web/public/index.html` | Add orchestrator-ui.js script tag | +1 |

**Total new code**: ~2,300 lines across 6 new files
**Total modifications**: ~160 lines across 10 existing files

## Implementation Execution Order

This is the actual build order — each step is a commit checkpoint:

1. **Types** — `src/types/orchestrator.ts` + barrel export. Zero risk, pure types.
2. **SSE events** — Add all 11 events to both `sse-events.ts` and `constants.js`. Wire in SseEvent namespace.
3. **State persistence** — Add orchestrator state to StateStore. Small, isolated change.
4. **Schemas** — Add Zod validation schemas for API input.
5. **Planner** — `src/orchestrator-planner.ts`. Can test in isolation.
6. **Verifier** — `src/orchestrator-verifier.ts`. Can test in isolation.
7. **Core loop** — `src/orchestrator-loop.ts`. The big one. Depends on planner + verifier.
8. **Prompts** — `src/prompts/orchestrator.ts`. Templates used by core loop.
9. **Port + routes** — `src/web/ports/infra-port.ts` update + `src/web/routes/orchestrator-routes.ts`.
10. **Server integration** — Wire OrchestratorLoop into WebServer. Routes become live.
11. **Frontend** — `src/web/public/orchestrator-ui.js` + app.js listeners + index.html script tag.
12. **Tests** — `test/orchestrator-*.test.ts`.
13. **Typecheck + lint** — Fix all issues, ensure CI passes.

## Edge Cases & Error Handling

- **Session limit reached**: Queue tasks and wait for sessions to free up (existing SessionManager handles this)
- **All sessions crash during phase**: Mark phase as failed, attempt replan
- **Verification flaky**: `moderate` mode allows test retries; `lenient` skips AI review
- **Plan too large**: Cap at 10 phases, 50 total tasks. Warn user.
- **Context overflow**: Auto-compact between phases. Respawn if needed (orchestrator state is external).
- **User pauses mid-phase**: Pause task assignment, don't cancel running tasks. Resume picks up where it left off.
- **Network/API errors during planning**: Retry plan generation up to 2 times, then fail with clear message.
- **Orchestrator vs Ralph conflict**: Mutually exclusive. Starting orchestrator stops Ralph if running. Starting Ralph stops orchestrator.

## Testing Strategy

- **Unit tests**: `test/orchestrator-planner.test.ts` — phase grouping algorithm, team strategy assignment
- **Unit tests**: `test/orchestrator-verifier.test.ts` — verification logic with mocked sessions
- **Integration tests**: `test/orchestrator-loop.test.ts` — state machine transitions, task lifecycle
- **Route tests**: `test/routes/orchestrator-routes.test.ts` — API validation, status responses

All tests use `MockSession` pattern from existing test infrastructure. No real tmux needed.
