/**
 * @fileoverview Orchestrator Loop type definitions.
 *
 * Types for the phased plan execution system: state machine, plan structure,
 * phase grouping, team strategies, verification, configuration, and persistence.
 *
 * Key exports:
 * - OrchestratorState — state machine states (idle → planning → approval → executing → verifying → ...)
 * - OrchestratorPlan / OrchestratorPhase / OrchestratorTask — hierarchical plan structure
 * - TeamStrategy — how agents are coordinated per phase (single, parallel, team)
 * - VerificationResult / VerificationCheck — phase verification output
 * - OrchestratorConfig — user-configurable options
 * - OrchestratorPersistState / OrchestratorStats — persistence and metrics
 *
 * Cross-domain relationships:
 * - OrchestratorTask.queueTaskId links to TaskState.id (task domain)
 * - OrchestratorTask.assignedSessionId links to SessionState.id (session domain)
 * - OrchestratorPersistState is embedded in AppState.orchestrator (app-state domain)
 *
 * Served at `GET /api/orchestrator/status` and `GET /api/orchestrator/plan`.
 * No dependencies on other domain modules.
 */

// ═══════════════════════════════════════════════════════════════
// State Machine
// ═══════════════════════════════════════════════════════════════

/** Orchestrator loop states */
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

/** Top-level orchestrator plan generated from a user goal */
export interface OrchestratorPlan {
  /** Unique plan identifier */
  id: string;
  /** Original user goal/task description */
  goal: string;
  /** When the plan was generated */
  createdAt: number;
  /** Ordered list of execution phases */
  phases: OrchestratorPhase[];
  /** Plan generation metadata */
  metadata: OrchestratorPlanMetadata;
}

/** Metadata from plan generation */
export interface OrchestratorPlanMetadata {
  /** Total tasks across all phases */
  totalTasks: number;
  /** Estimated overall complexity */
  estimatedComplexity: 'low' | 'medium' | 'high';
  /** Model used for plan generation */
  modelUsed: string;
  /** Time taken to generate the plan */
  planDurationMs: number;
}

/** A sequential execution phase containing parallel tasks */
export interface OrchestratorPhase {
  /** Phase identifier (e.g., "phase-1") */
  id: string;
  /** Human-readable phase name */
  name: string;
  /** Detailed description of what this phase accomplishes */
  description: string;
  /** Execution order (0-based) */
  order: number;
  /** Current phase status */
  status: PhaseStatus;
  /** Tasks within this phase */
  tasks: OrchestratorTask[];
  /** Criteria to verify after phase completion */
  verificationCriteria: string[];
  /** Shell commands to run for verification */
  testCommands: string[];
  /** Maximum retry attempts for this phase */
  maxAttempts: number;
  /** Current attempt count */
  attempts: number;
  /** When execution started */
  startedAt: number | null;
  /** When phase completed (passed or failed) */
  completedAt: number | null;
  /** Total execution duration */
  durationMs: number | null;
  /** How to coordinate agents for this phase */
  teamStrategy: TeamStrategy;
}

/** Phase execution status */
export type PhaseStatus = 'pending' | 'executing' | 'verifying' | 'passed' | 'failed' | 'skipped';

/** A single executable task within a phase */
export interface OrchestratorTask {
  /** Task identifier (e.g., "phase-1-task-1") */
  id: string;
  /** Parent phase identifier */
  phaseId: string;
  /** Single-line prompt to send to Claude */
  prompt: string;
  /** Current task status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Session running this task */
  assignedSessionId: string | null;
  /** Links to TaskQueue task ID (for completion tracking) */
  queueTaskId: string | null;
  /** Whether this task can run in parallel with siblings */
  parallel: boolean;
  /** Unique phrase for completion detection */
  completionPhrase: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** When task started executing */
  startedAt: number | null;
  /** When task completed */
  completedAt: number | null;
  /** Error message if task failed */
  error: string | null;
  /** Number of retry attempts */
  retries: number;
}

// ═══════════════════════════════════════════════════════════════
// Team Strategy
// ═══════════════════════════════════════════════════════════════

/** How agents are coordinated for a phase */
export type TeamStrategy =
  | { type: 'single' }
  | { type: 'parallel'; maxSessions: number }
  | { type: 'team'; config: TeamSetup };

/** Configuration for team-based phase execution */
export interface TeamSetup {
  /** Prompt to send to the team lead */
  leadPrompt: string;
  /** Suggested teammate role descriptions */
  suggestedTeammates: string[];
  /** Maximum number of teammates to create */
  maxTeammates: number;
}

// ═══════════════════════════════════════════════════════════════
// Verification
// ═══════════════════════════════════════════════════════════════

/** Result of phase verification */
export interface VerificationResult {
  /** Whether all checks passed */
  passed: boolean;
  /** Individual verification checks */
  checks: VerificationCheck[];
  /** Human-readable summary */
  summary: string;
  /** Suggestions for replanning if verification failed */
  suggestions: string[];
}

/** A single verification check result */
export interface VerificationCheck {
  /** Type of check performed */
  type: 'test_command' | 'ai_review' | 'file_check';
  /** What was checked */
  description: string;
  /** Whether this check passed */
  passed: boolean;
  /** Command output or review text */
  output?: string;
}

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

/** User-configurable orchestrator options */
export interface OrchestratorConfig {
  /** Model to use for plan generation (default: 'opus') */
  plannerModel: string;
  /** Whether to run research agent before planning (default: true) */
  researchEnabled: boolean;
  /** Auto-approve generated plans without user review (default: false) */
  autoApprove: boolean;
  /** Maximum retry attempts per phase (default: 3) */
  maxPhaseRetries: number;
  /** Phase execution timeout in ms (default: 1800000 = 30min) */
  phaseTimeoutMs: number;
  /** Enable Claude Code agent teams for parallel phases (default: true) */
  enableTeamAgents: boolean;
  /** Maximum parallel sessions for task execution (default: 3) */
  maxParallelSessions: number;
  /** Verification strictness (default: 'moderate') */
  verificationMode: 'strict' | 'moderate' | 'lenient';
  /** Run /compact between phases to manage context (default: true) */
  compactBetweenPhases: boolean;
}

/** Default orchestrator configuration */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  plannerModel: 'opus',
  researchEnabled: true,
  autoApprove: false,
  maxPhaseRetries: 3,
  phaseTimeoutMs: 30 * 60 * 1000, // 30 minutes
  enableTeamAgents: true,
  maxParallelSessions: 3,
  verificationMode: 'moderate',
  compactBetweenPhases: true,
};

// ═══════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════

/** Orchestrator state persisted to ~/.codeman/state.json */
export interface OrchestratorPersistState {
  /** Current state machine state */
  state: OrchestratorState;
  /** Generated plan (null before planning) */
  plan: OrchestratorPlan | null;
  /** Index of currently executing phase */
  currentPhaseIndex: number;
  /** When orchestration started */
  startedAt: number | null;
  /** When orchestration completed */
  completedAt: number | null;
  /** User configuration */
  config: OrchestratorConfig;
  /** Execution statistics */
  stats: OrchestratorStats;
}

/** Orchestrator execution statistics */
export interface OrchestratorStats {
  /** Number of phases completed successfully */
  phasesCompleted: number;
  /** Number of phases that failed (after all retries) */
  phasesFailed: number;
  /** Total individual tasks completed */
  totalTasksCompleted: number;
  /** Total individual tasks failed */
  totalTasksFailed: number;
  /** Total time spent executing (ms) */
  totalDurationMs: number;
  /** Number of times replanning was triggered */
  replanCount: number;
}

/** Factory function for initial orchestrator stats */
export function createInitialOrchestratorStats(): OrchestratorStats {
  return {
    phasesCompleted: 0,
    phasesFailed: 0,
    totalTasksCompleted: 0,
    totalTasksFailed: 0,
    totalDurationMs: 0,
    replanCount: 0,
  };
}
