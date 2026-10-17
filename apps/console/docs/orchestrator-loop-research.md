# Orchestrator Loop — Research Findings

> Research doc for the new "Orchestrator Loop" feature. Not for GitHub.

## What We're Building

A new autonomous loop variant — **Orchestrator Loop** — that takes high-level user tasks, decomposes them into a detailed plan using team agents, and executes the plan step-by-step with quality gates. Unlike Ralph Loop (which executes a flat task queue), the Orchestrator coordinates **planning, delegation, and verification** as a continuous cycle.

**Core idea**: User inputs a goal → Orchestrator creates a detailed plan → spins up team agents for parallel execution → validates each step → adapts the plan based on results → delivers polished output.

## Existing Infrastructure Analysis

### What We Can Reuse

#### 1. Ralph Loop (`src/ralph-loop.ts`)
- **Pattern**: Poll loop with `start() → tick() → stop()` lifecycle
- **Reusable**: Event-driven task assignment, session completion handling, timeout management
- **Limitation**: Flat task queue — no concept of phases, dependencies between task groups, or adaptive replanning
- **Key insight**: `assignTaskToSession()` uses `session.sendInput(task.prompt)` — simple prompt injection into PTY

#### 2. Task Queue (`src/task-queue.ts`) + Task (`src/task.ts`)
- **Already has**: Priority ordering, dependency tracking between tasks, completion phrase detection
- **Limitation**: No task *groups* or *phases*. Dependencies are task-to-task, not phase-to-phase
- **Key insight**: Tasks support `completionPhrase` — a string the task watches for in output. This is how Ralph knows a task is done

#### 3. Plan Orchestrator (`src/plan-orchestrator.ts`)
- **Already has**: 2-agent plan generation (Research Agent → Planner Agent), TDD-aware plan items with P0/P1/P2 priorities
- **Output**: `PlanItem[]` with dependencies, verification criteria, TDD phases, complexity ratings
- **Limitation**: Plan generation only — no execution. Plans are generated then sit in state/UI for human review
- **Key insight**: Uses `Session` directly to run Claude subagent instances for research and planning. Returns structured JSON

#### 4. Team Agents (`src/team-watcher.ts`, `~/.claude/teams/`)
- **Already has**: Team creation, member tracking, filesystem inbox messaging, task management via `~/.claude/tasks/{team-name}/`
- **Limitation**: Codeman can only *observe* teams (TeamWatcher is read-only polling), not *create* or *orchestrate* them
- **Key insight**: Teams are a Claude Code feature. Codeman monitors them but doesn't control them. We can't programmatically create teammates — Claude Code does that when you use `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

#### 5. Respawn Controller (`src/respawn-controller.ts`)
- **Already has**: Preset-based automation (ralph-todo, overnight-autonomous), circuit breaker, health scoring
- **Key insight**: The `ralph-todo` preset (8s idle, 480min max) is designed for autonomous task execution. We'd need a new preset or make Orchestrator Loop set its own timing

#### 6. Session Auto-Ops (`src/session-auto-ops.ts`)
- **Already has**: Auto-compact at token thresholds, auto-clear for context management
- **Key insight**: Critical for long Orchestrator runs — prevents context overflow during multi-step execution

#### 7. Hooks (`src/hooks-config.ts`)
- **Already has**: `idle_prompt`, `stop`, `teammate_idle`, `task_completed` hook events
- **Key insight**: Hooks fire POST to `/api/hook-event` — this is how Codeman knows when Claude is idle, stopped, or completed a task. The Orchestrator Loop can listen to these same events

### What We Need to Build New

1. **Plan → Task decomposition**: Convert PlanOrchestrator output (PlanItem[]) into executable task groups with phase ordering
2. **Multi-phase execution engine**: Execute plan phases sequentially, tasks within phases in parallel
3. **Verification gates**: After each phase, run verification (test commands, AI review) before proceeding
4. **Adaptive replanning**: When a task fails or verification fails, generate a recovery plan
5. **Team agent orchestration**: Leverage Claude Code's agent teams for parallel execution within phases
6. **Progress tracking & UI**: Real-time dashboard showing plan progress, phase status, agent activity

## How Teams Actually Work (Important Constraint)

After deep research, here's the reality of agent teams:

```
User starts session with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
  → Claude Code creates a team-lead
  → Team-lead spawns teammates (in-process threads)
  → Teammates appear as subagents (detected by SubagentWatcher)
  → Communication via ~/.claude/teams/{name}/inboxes/{member}.json
  → Tasks tracked in ~/.claude/tasks/{team-name}/{N}.json
```

**Codeman cannot programmatically create team members.** This is a Claude Code internal feature. However, Codeman CAN:
- Start a session that has teams enabled
- Send a prompt to the lead that instructs it to use agent teams
- Monitor team activity via TeamWatcher
- React to teammate_idle and task_completed hook events
- Read team task status from the filesystem

**This means**: The Orchestrator Loop orchestrates at the *session prompt* level, not the *team member* level. We tell the lead what to do, and the lead decides how to use its team.

## Architecture Decision: Prompt-Level Orchestration

Given the team constraint, the Orchestrator Loop works by:

1. **Planning phase**: Use PlanOrchestrator to generate a detailed plan from user input
2. **Execution phase**: Feed plan steps as prompts to sessions, one phase at a time
3. **Verification phase**: After each phase, run verification prompts and check results
4. **Adaptation phase**: If verification fails, generate recovery prompts

The "team agents" aspect works by:
- Starting sessions with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Crafting prompts that *instruct the lead to delegate* to teammates
- Monitoring team activity to track parallel progress
- The lead agent is smart enough to decompose work across its team

## Key Technical Findings

### Session Input Mechanics
```typescript
// From session.ts - how we send prompts
await session.sendInput(task.prompt);  // Uses writeViaMux() internally
// writeViaMux() does: tmux send-keys -l "prompt text" + tmux send-keys Enter
// CRITICAL: Single-line only! Multi-line breaks Ink rendering
```

### Completion Detection Chain
```
PTY output → RalphTracker.processData() → completion phrase fuzzy match
  → CompletionConfidence scoring (multi-signal: promise tag + todos + exit signal)
  → If confident → emit 'completionDetected'
  → RalphLoop listens → marks task complete → assigns next
```

### How Plan Items Map to Tasks
```typescript
// PlanItem has:
interface PlanItem {
  id: string;            // "P0-001"
  content: string;       // "Implement error handling for API endpoints"
  priority: 'P0' | 'P1' | 'P2';
  dependencies: string[]; // ["P0-000"] — other PlanItem IDs
  verificationCriteria: string;
  testCommand: string;
  tddPhase: 'setup' | 'test' | 'impl' | 'verify' | 'review';
  complexity: 'low' | 'medium' | 'high';
}

// Task has:
interface CreateTaskOptions {
  prompt: string;
  priority: number;
  dependencies: string[];  // Task IDs
  completionPhrase: string;
  timeoutMs: number;
}

// Natural mapping: PlanItem.content → Task.prompt
// PlanItem.dependencies → Task.dependencies
// PlanItem.priority → Task.priority (P0=100, P1=50, P2=10)
// PlanItem.verificationCriteria → verification task prompt
```

### Context Management for Long Runs
- Auto-compact at ~110k tokens (configurable)
- Auto-clear at ~140k tokens (configurable)
- Respawn cycling: kill + restart session to reset context entirely
- For Orchestrator: we want compact between phases, respawn between major milestones

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Context overflow during complex phases | High | Auto-compact between tasks, respawn between phases |
| Team agents not predictable | Medium | Orchestrate at session level, let Claude decide team delegation |
| Plan too ambitious → infinite loop | High | Phase budgets (max attempts per phase), circuit breaker |
| Verification too strict → blocks progress | Medium | Configurable strictness, human override via UI |
| Single-line prompt limit | Medium | Use CLAUDE.md file for complex instructions, prompt references file |
| Long planning phase delays execution | Low | Show plan for approval before execution |
