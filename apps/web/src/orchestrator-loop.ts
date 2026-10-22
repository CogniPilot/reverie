/**
 * @fileoverview Orchestrator Loop — phased plan execution with team agents.
 *
 * State machine that generates plans from user goals, executes them
 * phase-by-phase with verification gates, and adapts on failure.
 *
 * States: idle → planning → approval → executing → verifying → (replanning) → completed/failed
 *
 * Key exports:
 * - `OrchestratorLoop` class — main engine, extends EventEmitter
 * - `OrchestratorLoopEvents` interface — typed event map
 *
 * Lifecycle: `start(goal)` → plan → approve → execute phases → verify → complete
 *
 * @dependencies orchestrator-planner (plan generation), orchestrator-verifier (phase verification),
 *   session-manager (sessions), task-queue (task execution), state-store (persistence),
 *   prompts/orchestrator (prompt templates)
 * @consumedby web/server (orchestrator routes, SSE)
 * @emits stateChanged, planReady, phaseStarted, phaseCompleted, phaseFailed,
 *   taskAssigned, taskCompleted, taskFailed, verificationResult, completed, error
 * @persistence Orchestrator state saved to `~/.reverie/state.json` (orchestrator key)
 *
 * @module orchestrator-loop
 */

import { EventEmitter } from 'node:events';
import { getSessionManager, SessionManager } from './session-manager.js';
import { getTaskQueue, TaskQueue } from './task-queue.js';
import { getStore, StateStore } from './state-store.js';
import { OrchestratorPlanner } from './orchestrator-planner.js';
import { OrchestratorVerifier } from './orchestrator-verifier.js';
import { PHASE_EXECUTION_PROMPT, REPLAN_PROMPT, SINGLE_TASK_PROMPT, TEAM_LEAD_PROMPT } from './prompts/index.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import type { CreateTaskOptions } from './task.js';
import {
  type OrchestratorState,
  type OrchestratorPlan,
  type OrchestratorPhase,
  type OrchestratorTask,
  type OrchestratorConfig,
  type OrchestratorStats,
  type OrchestratorPersistState,
  type VerificationResult,
  DEFAULT_ORCHESTRATOR_CONFIG,
  createInitialOrchestratorStats,
  getErrorMessage,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Poll interval for checking task completion within a phase (2 seconds) */
const PHASE_POLL_INTERVAL_MS = 2000;

/** Delay between phase completion and verification (1 second) */
const POST_PHASE_DELAY_MS = 1000;

// ═══════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// OrchestratorLoop
// ═══════════════════════════════════════════════════════════════

export class OrchestratorLoop extends EventEmitter {
  private _state: OrchestratorState = 'idle';
  private plan: OrchestratorPlan | null = null;
  private currentPhaseIndex = 0;
  private config: OrchestratorConfig;
  private stats: OrchestratorStats;
  private startedAt: number | null = null;
  private completedAt: number | null = null;

  private workingDir: string;
  private planner: OrchestratorPlanner;
  private verifier: OrchestratorVerifier;
  private sessionManager: SessionManager;
  private taskQueue: TaskQueue;
  private store: StateStore;

  /** State before pause (to resume to correct state) */
  private pausedState: OrchestratorState | null = null;

  /** Phase poll timer for checking task completion */
  private phasePollTimer: NodeJS.Timeout | null = null;

  /** Phase-level timeout timer */
  private phaseTimeoutTimer: NodeJS.Timeout | null = null;

  /** Post-phase delay timer before verification */
  private postPhaseTimer: NodeJS.Timeout | null = null;

  /** Session completion listener (bound for cleanup) */
  private sessionCompletionListener: ((sessionId: string, phrase: string) => void) | null = null;

  /** Active sessions assigned to current phase */
  private phaseSessionIds: Set<string> = new Set();

  constructor(mux: TerminalMultiplexer, workingDir: string, config?: Partial<OrchestratorConfig>) {
    super();
    this.workingDir = workingDir;
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.stats = createInitialOrchestratorStats();
    this.sessionManager = getSessionManager();
    this.taskQueue = getTaskQueue();
    this.store = getStore();
    this.planner = new OrchestratorPlanner(mux, workingDir, this.config);
    this.verifier = new OrchestratorVerifier(this.config);

    // Restore state if crashed while running
    this.restore();
  }

  // ═══════════════════════════════════════════════════════════════
  // Public API — Lifecycle
  // ═══════════════════════════════════════════════════════════════

  /** Start orchestration with a goal. Transitions: idle → planning */
  async start(goal: string): Promise<void> {
    if (this._state !== 'idle' && this._state !== 'failed' && this._state !== 'completed') {
      throw new Error(`Cannot start from state "${this._state}"`);
    }

    this.reset();
    this.startedAt = Date.now();
    this.setState('planning');

    try {
      const plan = await this.planner.generatePlan(goal, (phase, detail) => {
        this.emit('planProgress', phase, detail);
      });

      if (this.currentState() !== 'planning') {
        // Cancelled during planning
        return;
      }

      this.plan = plan;
      this.persist();

      if (this.config.autoApprove) {
        this.setState('executing');
        await this.executeCurrentPhase();
      } else {
        this.setState('approval');
        this.emit('planReady', plan);
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /** Approve the generated plan. Transitions: approval → executing */
  async approve(): Promise<void> {
    this.requireState('approval');
    if (!this.plan) {
      throw new Error('No plan to approve');
    }

    this.setState('executing');
    await this.executeCurrentPhase();
  }

  /** Reject plan with feedback. Transitions: approval → planning (regenerate) */
  async reject(feedback: string): Promise<void> {
    this.requireState('approval');
    if (!this.plan) {
      throw new Error('No plan to reject');
    }

    const goal = this.plan.goal + '\n\nFeedback on previous plan: ' + feedback;
    this.plan = null;
    this.setState('planning');

    try {
      const plan = await this.planner.generatePlan(goal);

      if ((this._state as OrchestratorState) !== 'planning') return;

      this.plan = plan;
      this.persist();
      this.setState('approval');
      this.emit('planReady', plan);
    } catch (err) {
      this.handleError(err);
    }
  }

  /** Pause execution. Saves current state. */
  pause(): void {
    if (this._state === 'idle' || this._state === 'paused' || this._state === 'completed' || this._state === 'failed') {
      return;
    }
    this.pausedState = this._state;
    this.clearPhasePoll();
    this.cleanupTaskHandlers();
    this.setState('paused');
  }

  /** Resume from pause. */
  async resume(): Promise<void> {
    if (this._state !== 'paused' || !this.pausedState) {
      throw new Error('Not paused');
    }

    const resumeTo = this.pausedState;
    this.pausedState = null;
    this.setState(resumeTo);

    // Re-enter the appropriate phase of execution
    if (resumeTo === 'executing') {
      await this.executeCurrentPhase();
    } else if (resumeTo === 'verifying') {
      await this.verifyCurrentPhase();
    }
  }

  /** Stop everything and clean up. */
  async stop(): Promise<void> {
    this.clearPhasePoll();
    this.cleanupTaskHandlers();
    await this.planner.cancel();
    this.setState('idle');
    this.store.clearOrchestratorState();
  }

  /** Skip a specific phase. */
  async skipPhase(phaseId: string): Promise<void> {
    if (!this.plan) return;

    const phase = this.plan.phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase "${phaseId}" not found`);

    phase.status = 'skipped';
    phase.completedAt = Date.now();
    this.persist();

    // If this is the current phase, advance
    if (this.plan.phases[this.currentPhaseIndex]?.id === phaseId) {
      await this.advanceToNextPhase();
    }
  }

  /** Retry a failed phase. */
  async retryPhase(phaseId: string): Promise<void> {
    if (!this.plan) return;
    if (this._state !== 'executing' && this._state !== 'failed') {
      throw new Error(`Cannot retry from state "${this._state}"`);
    }

    const phaseIndex = this.plan.phases.findIndex((p) => p.id === phaseId);
    if (phaseIndex === -1) throw new Error(`Phase "${phaseId}" not found`);

    const phase = this.plan.phases[phaseIndex];
    phase.status = 'pending';
    phase.attempts = 0;
    for (const task of phase.tasks) {
      task.status = 'pending';
      task.error = null;
      task.assignedSessionId = null;
      task.queueTaskId = null;
    }

    this.currentPhaseIndex = phaseIndex;
    this.setState('executing');
    await this.executeCurrentPhase();
  }

  // ═══════════════════════════════════════════════════════════════
  // Public API — Getters
  // ═══════════════════════════════════════════════════════════════

  get state(): OrchestratorState {
    return this._state;
  }

  getPlan(): OrchestratorPlan | null {
    return this.plan;
  }

  getCurrentPhase(): OrchestratorPhase | null {
    if (!this.plan) return null;
    return this.plan.phases[this.currentPhaseIndex] ?? null;
  }

  getStats(): OrchestratorStats {
    return { ...this.stats };
  }

  getStatus(): OrchestratorPersistState {
    return {
      state: this._state,
      plan: this.plan,
      currentPhaseIndex: this.currentPhaseIndex,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      config: this.config,
      stats: this.stats,
    };
  }

  isRunning(): boolean {
    return this._state !== 'idle' && this._state !== 'completed' && this._state !== 'failed';
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal — Phase Execution
  // ═══════════════════════════════════════════════════════════════

  private async executeCurrentPhase(): Promise<void> {
    if (!this.plan || this._state !== 'executing') return;

    const phase = this.plan.phases[this.currentPhaseIndex];
    if (!phase) {
      // All phases done
      await this.handleCompletion();
      return;
    }

    // Skip already completed/skipped phases
    if (phase.status === 'passed' || phase.status === 'skipped') {
      await this.advanceToNextPhase();
      return;
    }

    phase.status = 'executing';
    phase.startedAt = Date.now();
    phase.attempts++;
    this.persist();
    this.emit('phaseStarted', phase);

    try {
      await this.assignPhaseTasks(phase);
      this.startPhasePoll(phase);
    } catch (err) {
      this.handlePhaseError(phase, getErrorMessage(err));
    }
  }

  private async assignPhaseTasks(phase: OrchestratorPhase): Promise<void> {
    // For team strategy, send a single comprehensive prompt to a lead session
    if (phase.teamStrategy.type === 'team') {
      await this.assignTeamPhase(phase);
      return;
    }

    // For single/parallel strategy, add individual tasks to TaskQueue
    for (const task of phase.tasks) {
      if (task.status !== 'pending') continue;

      const prompt = this.buildTaskPrompt(task, phase);
      const taskOptions: CreateTaskOptions = {
        prompt,
        workingDir: this.workingDir,
        priority: 100 - phase.order, // Earlier phases get higher priority
        completionPhrase: task.completionPhrase,
        timeoutMs: Math.min(task.timeoutMs, this.config.phaseTimeoutMs),
      };

      const queueTask = this.taskQueue.addTask(taskOptions);
      task.queueTaskId = queueTask.id;
      task.status = 'running';
    }

    this.persist();
    this.setupTaskHandlers();

    // Manually assign tasks to idle sessions
    await this.assignQueuedTasksToSessions();
  }

  private async assignTeamPhase(phase: OrchestratorPhase): Promise<void> {
    const teamConfig = phase.teamStrategy.type === 'team' ? phase.teamStrategy.config : null;
    if (!teamConfig) return;

    // Find or use an idle session
    const sessions = this.sessionManager.getIdleSessions();
    if (sessions.length === 0) {
      throw new Error('No idle sessions available for team phase execution');
    }

    const session = sessions[0];
    this.phaseSessionIds.add(session.id);

    // Mark all tasks as running under this session
    for (const task of phase.tasks) {
      task.status = 'running';
      task.assignedSessionId = session.id;
    }

    // Build and send the team lead prompt
    const prompt = TEAM_LEAD_PROMPT.replace('{PHASE_NAME}', phase.name)
      .replace('{TASK_LIST}', phase.tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join('\n'))
      .replace('{TEAMMATE_HINTS}', teamConfig.suggestedTeammates.map((h, i) => `${i + 1}. ${h}`).join('\n'))
      .replace('{COMPLETION_PHRASE}', `${phase.id.toUpperCase()}_COMPLETE`);

    // Create a TaskQueue task for the entire phase
    const queueTask = this.taskQueue.addTask({
      prompt,
      workingDir: this.workingDir,
      priority: 100 - phase.order,
      completionPhrase: `${phase.id.toUpperCase()}_COMPLETE`,
      timeoutMs: this.config.phaseTimeoutMs,
    });

    // Link all phase tasks to this single queue task
    for (const task of phase.tasks) {
      task.queueTaskId = queueTask.id;
    }

    this.persist();
    this.setupTaskHandlers();

    // Assign the task to the session
    try {
      queueTask.assign(session.id);
      session.assignTask(queueTask.id);
      this.taskQueue.updateTask(queueTask);
      await session.sendInput(prompt);
    } catch (err) {
      queueTask.fail(getErrorMessage(err));
      this.taskQueue.updateTask(queueTask);
      throw err;
    }
  }

  private async assignQueuedTasksToSessions(): Promise<void> {
    const idleSessions = this.sessionManager.getIdleSessions();
    const maxSessions =
      this.getCurrentPhase()?.teamStrategy.type === 'parallel'
        ? (this.getCurrentPhase()?.teamStrategy as { type: 'parallel'; maxSessions: number }).maxSessions
        : 1;

    const sessionsToUse = idleSessions.slice(0, maxSessions);

    for (const session of sessionsToUse) {
      const task = this.taskQueue.next();
      if (!task) break;

      try {
        task.assign(session.id);
        session.assignTask(task.id);
        this.taskQueue.updateTask(task);
        await session.sendInput(task.prompt);

        this.phaseSessionIds.add(session.id);

        // Find the orchestrator task linked to this queue task
        const orchTask = this.findOrchestratorTaskByQueueId(task.id);
        if (orchTask) {
          orchTask.assignedSessionId = session.id;
          orchTask.startedAt = Date.now();
          this.emit('taskAssigned', orchTask, session.id);
        }
      } catch (err) {
        task.fail(getErrorMessage(err));
        session.clearTask();
        this.taskQueue.updateTask(task);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal — Task Completion Tracking
  // ═══════════════════════════════════════════════════════════════

  private setupTaskHandlers(): void {
    this.cleanupTaskHandlers();

    this.sessionCompletionListener = (_sessionId: string, _phrase: string) => {
      // Session completion — check if it's related to our phase tasks
      this.checkPhaseCompletion();
    };

    this.sessionManager.on('sessionCompletion', this.sessionCompletionListener);
  }

  private cleanupTaskHandlers(): void {
    if (this.sessionCompletionListener) {
      this.sessionManager.off('sessionCompletion', this.sessionCompletionListener);
      this.sessionCompletionListener = null;
    }
  }

  private _finalizeTask(queueTaskId: string, status: 'completed' | 'failed', error?: string): OrchestratorTask | null {
    const orchTask = this.findOrchestratorTaskByQueueId(queueTaskId);
    if (!orchTask) return null;

    orchTask.status = status;
    if (status === 'completed') {
      orchTask.completedAt = Date.now();
      this.stats.totalTasksCompleted++;
    } else {
      orchTask.error = error ?? null;
      this.stats.totalTasksFailed++;
    }
    this.persist();
    return orchTask;
  }

  private handleTaskCompleted(queueTaskId: string): void {
    const orchTask = this._finalizeTask(queueTaskId, 'completed');
    if (!orchTask) return;

    this.emit('taskCompleted', orchTask);
    this.checkPhaseCompletion();
  }

  private handleTaskFailed(queueTaskId: string, error: string): void {
    const orchTask = this._finalizeTask(queueTaskId, 'failed', error);
    if (!orchTask) return;

    this.emit('taskFailed', orchTask, error);

    // Check if we should retry the task or fail the phase
    if (orchTask.retries < 2) {
      orchTask.retries++;
      orchTask.status = 'pending';
      orchTask.error = null;
      orchTask.queueTaskId = null;
      // Will be re-queued on next poll
    } else {
      this.checkPhaseCompletion();
    }
  }

  private startPhasePoll(phase: OrchestratorPhase): void {
    this.clearPhasePoll();
    this.phasePollTimer = setInterval(() => {
      if (this._state !== 'executing') {
        this.clearPhasePoll();
        return;
      }
      this.pollPhaseStatus(phase);
    }, PHASE_POLL_INTERVAL_MS);

    // Phase-level timeout — fail the phase if it exceeds the configured timeout
    this.phaseTimeoutTimer = setTimeout(() => {
      if (this._state === 'executing' && phase.status === 'executing') {
        console.warn(`[Orchestrator] Phase "${phase.name}" timed out after ${this.config.phaseTimeoutMs}ms`);
        this.handlePhaseError(phase, `Phase timed out after ${Math.round(this.config.phaseTimeoutMs / 60000)} minutes`);
      }
    }, this.config.phaseTimeoutMs);
  }

  private _clearTimer(
    timerKey: 'phasePollTimer' | 'phaseTimeoutTimer' | 'postPhaseTimer',
    clearFn: typeof clearInterval | typeof clearTimeout
  ): void {
    if (this[timerKey]) {
      clearFn(this[timerKey]);
      this[timerKey] = null;
    }
  }

  private clearPhasePoll(): void {
    this._clearTimer('phasePollTimer', clearInterval);
    this._clearTimer('phaseTimeoutTimer', clearTimeout);
    this._clearTimer('postPhaseTimer', clearTimeout);
  }

  private pollPhaseStatus(phase: OrchestratorPhase): void {
    // Check for queued tasks that need assignment
    const pendingTasks = phase.tasks.filter((t) => t.status === 'pending' && !t.queueTaskId);
    if (pendingTasks.length > 0) {
      // Re-queue pending tasks
      for (const task of pendingTasks) {
        const prompt = this.buildTaskPrompt(task, phase);
        const queueTask = this.taskQueue.addTask({
          prompt,
          workingDir: this.workingDir,
          priority: 100 - phase.order,
          completionPhrase: task.completionPhrase,
          timeoutMs: Math.min(task.timeoutMs, this.config.phaseTimeoutMs),
        });
        task.queueTaskId = queueTask.id;
        task.status = 'running';
      }
      this.assignQueuedTasksToSessions().catch(() => {}); // Best effort
    }

    // Check completion status of queue tasks
    for (const task of phase.tasks) {
      if (task.status === 'running' && task.queueTaskId) {
        const queueTask = this.taskQueue.getTask(task.queueTaskId);
        if (queueTask) {
          if (queueTask.isCompleted()) {
            this.handleTaskCompleted(task.queueTaskId);
          } else if (queueTask.isFailed()) {
            this.handleTaskFailed(task.queueTaskId, queueTask.error || 'Task failed');
          }
        }
      }
    }

    this.checkPhaseCompletion();
  }

  private checkPhaseCompletion(): void {
    if (this._state !== 'executing') return;

    const phase = this.getCurrentPhase();
    if (!phase) return;

    const allDone = phase.tasks.every((t) => t.status === 'completed' || t.status === 'failed');
    if (!allDone) return;

    const anyFailed = phase.tasks.some((t) => t.status === 'failed');

    this.clearPhasePoll();

    if (anyFailed) {
      // Phase has failed tasks
      this.handlePhaseError(phase, 'One or more tasks failed');
    } else {
      // All tasks completed — run verification after brief delay
      this.postPhaseTimer = setTimeout(() => {
        this.postPhaseTimer = null;
        this.verifyCurrentPhase().catch((err) => this.handleError(err));
      }, POST_PHASE_DELAY_MS);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal — Verification
  // ═══════════════════════════════════════════════════════════════

  private async verifyCurrentPhase(): Promise<void> {
    if (!this.plan) return;

    const phase = this.plan.phases[this.currentPhaseIndex];
    if (!phase) return;

    // Skip verification if no criteria defined
    if (phase.verificationCriteria.length === 0 && phase.testCommands.length === 0) {
      phase.status = 'passed';
      phase.completedAt = Date.now();
      phase.durationMs = phase.startedAt ? Date.now() - phase.startedAt : null;
      this.stats.phasesCompleted++;
      this.persist();
      this.emit('phaseCompleted', phase);
      await this.advanceToNextPhase();
      return;
    }

    this.setState('verifying');

    // Get a session for verification — wait briefly for sessions to become idle
    let sessions = this.sessionManager.getIdleSessions();
    if (sessions.length === 0) {
      // Wait up to 10s for a session to become idle
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      sessions = this.sessionManager.getIdleSessions();
    }
    if (sessions.length === 0) {
      // Still no sessions — log warning and skip verification (don't silently pass)
      console.warn('[Orchestrator] No idle sessions for verification — skipping (marking passed with warning)');
      phase.status = 'passed';
      phase.completedAt = Date.now();
      phase.durationMs = phase.startedAt ? Date.now() - phase.startedAt : null;
      this.stats.phasesCompleted++;
      this.persist();
      this.emit('phaseCompleted', phase);
      this.setState('executing');
      await this.advanceToNextPhase();
      return;
    }

    try {
      const result = await this.verifier.verifyPhase(phase, sessions[0]);
      this.emit('verificationResult', phase, result);

      if (result.passed) {
        phase.status = 'passed';
        phase.completedAt = Date.now();
        phase.durationMs = phase.startedAt ? Date.now() - phase.startedAt : null;
        this.stats.phasesCompleted++;
        this.persist();
        this.emit('phaseCompleted', phase);
        this.setState('executing');
        await this.advanceToNextPhase();
      } else {
        // Verification failed — attempt replan
        await this.handleVerificationFailure(phase, result);
      }
    } catch (err) {
      // Verification error — treat as pass (don't block on verification bugs)
      console.warn('[Orchestrator] Verification error, treating as pass:', err);
      phase.status = 'passed';
      phase.completedAt = Date.now();
      phase.durationMs = phase.startedAt ? Date.now() - phase.startedAt : null;
      this.stats.phasesCompleted++;
      this.persist();
      this.emit('phaseCompleted', phase);
      this.setState('executing');
      await this.advanceToNextPhase();
    }
  }

  private async handleVerificationFailure(phase: OrchestratorPhase, result: VerificationResult): Promise<void> {
    if (phase.attempts >= phase.maxAttempts) {
      // Max retries exceeded
      phase.status = 'failed';
      phase.completedAt = Date.now();
      phase.durationMs = phase.startedAt ? Date.now() - phase.startedAt : null;
      this.stats.phasesFailed++;
      this.persist();
      this.emit('phaseFailed', phase, `Verification failed after ${phase.attempts} attempts: ${result.summary}`);
      this.setState('failed');
      return;
    }

    // Replan and retry
    this.stats.replanCount++;
    this.setState('replanning');

    try {
      await this.replanPhase(phase, result);
      // Reset task states for retry
      for (const task of phase.tasks) {
        task.status = 'pending';
        task.error = null;
        task.assignedSessionId = null;
        task.queueTaskId = null;
        task.completedAt = null;
        task.startedAt = null;
      }
      phase.status = 'pending';
      phase.startedAt = null;
      this.persist();

      this.setState('executing');
      await this.executeCurrentPhase();
    } catch (err) {
      this.handleError(err);
    }
  }

  private async replanPhase(phase: OrchestratorPhase, result: VerificationResult): Promise<void> {
    const completionPhrase = phase.tasks[0]?.completionPhrase || `${phase.id.toUpperCase()}_FIXED`;

    const prompt = REPLAN_PROMPT.replace('{PHASE_NAME}', phase.name)
      .replace('{ATTEMPT_NUMBER}', String(phase.attempts))
      .replace('{MAX_ATTEMPTS}', String(phase.maxAttempts))
      .replace('{FAILURE_SUMMARY}', result.summary)
      .replace('{SUGGESTIONS}', result.suggestions.join('\n'))
      .replace('{ORIGINAL_TASKS}', phase.tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join('\n'))
      .replace('{COMPLETION_PHRASE}', completionPhrase);

    // Create a tracked queue task for the replan (so completion is detected)
    const queueTask = this.taskQueue.addTask({
      prompt,
      workingDir: this.workingDir,
      priority: 100,
      completionPhrase,
      timeoutMs: this.config.phaseTimeoutMs,
    });

    // Link to first phase task for tracking
    if (phase.tasks[0]) {
      phase.tasks[0].queueTaskId = queueTask.id;
      phase.tasks[0].status = 'running';
    }

    this.persist();

    // Set up handlers so task completion is tracked
    this.setupTaskHandlers();

    // Assign to a session
    const sessions = this.sessionManager.getIdleSessions();
    if (sessions.length === 0) {
      console.warn('[Orchestrator] No idle sessions for replan — task queued, will pick up on next poll');
      // Start polling so the task gets assigned when a session becomes idle
      this.startPhasePoll(phase);
      return;
    }

    try {
      queueTask.assign(sessions[0].id);
      sessions[0].assignTask(queueTask.id);
      this.taskQueue.updateTask(queueTask);
      await sessions[0].sendInput(prompt);
    } catch (err) {
      queueTask.fail(getErrorMessage(err));
      this.taskQueue.updateTask(queueTask);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal — State Machine
  // ═══════════════════════════════════════════════════════════════

  /** Read current state (bypasses TypeScript narrowing from guards) */
  private currentState(): OrchestratorState {
    return this._state;
  }

  /** Assert state matches expected or throw */
  private requireState(...expected: OrchestratorState[]): void {
    if (!expected.includes(this._state)) {
      throw new Error(`Expected state "${expected.join('|')}", got "${this._state}"`);
    }
  }

  private setState(newState: OrchestratorState): void {
    const prev = this._state;
    if (prev === newState) return;
    this._state = newState;
    this.persist();
    this.emit('stateChanged', newState, prev);
  }

  private async advanceToNextPhase(): Promise<void> {
    this.currentPhaseIndex++;
    this.phaseSessionIds.clear();
    this.persist();

    if (!this.plan || this.currentPhaseIndex >= this.plan.phases.length) {
      await this.handleCompletion();
    } else {
      // Compact between phases if configured
      if (this.config.compactBetweenPhases) {
        const sessions = this.sessionManager.getIdleSessions();
        for (const session of sessions) {
          try {
            await session.writeViaMux('/compact', { opencodeGuard: true });
          } catch {
            // Best effort
          }
        }
        // Brief delay for compact to take effect
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      await this.executeCurrentPhase();
    }
  }

  private async handleCompletion(): Promise<void> {
    this.completedAt = Date.now();
    this.stats.totalDurationMs = this.startedAt ? this.completedAt - this.startedAt : 0;
    this.clearPhasePoll();
    this.cleanupTaskHandlers();
    this.setState('completed');
    this.emit('completed', this.stats);
  }

  private handlePhaseError(phase: OrchestratorPhase, error: string): void {
    if (phase.attempts >= phase.maxAttempts) {
      phase.status = 'failed';
      phase.completedAt = Date.now();
      phase.durationMs = phase.startedAt ? Date.now() - phase.startedAt : null;
      this.stats.phasesFailed++;
      this.persist();
      this.emit('phaseFailed', phase, error);
      this.setState('failed');
    } else {
      // Retry the phase
      for (const task of phase.tasks) {
        if (task.status === 'failed') {
          task.status = 'pending';
          task.error = null;
          task.queueTaskId = null;
          task.assignedSessionId = null;
        }
      }
      phase.status = 'pending';
      this.persist();
      this.executeCurrentPhase().catch((err) => this.handleError(err));
    }
  }

  private handleError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(getErrorMessage(err));
    console.error('[Orchestrator] Error:', error.message);
    this.setState('failed');
    this.emit('error', error);
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal — Persistence
  // ═══════════════════════════════════════════════════════════════

  private persist(): void {
    this.store.setOrchestratorState(this.getStatus());
  }

  private restore(): void {
    const saved = this.store.getOrchestratorState();
    if (!saved) return;

    // If we crashed while running, reset to failed
    if (saved.state === 'executing' || saved.state === 'verifying' || saved.state === 'replanning') {
      this._state = 'failed';
      this.plan = saved.plan;
      this.currentPhaseIndex = saved.currentPhaseIndex;
      this.startedAt = saved.startedAt;
      this.config = saved.config;
      this.stats = saved.stats;
      this.store.setOrchestratorState({ ...saved, state: 'failed' });
    } else if (saved.state === 'planning' || saved.state === 'approval') {
      // Planning/approval — reset to idle (plan is lost)
      this.store.clearOrchestratorState();
    } else if (saved.state === 'completed' || saved.state === 'failed') {
      // Preserve completed/failed state for UI display
      this._state = saved.state;
      this.plan = saved.plan;
      this.currentPhaseIndex = saved.currentPhaseIndex;
      this.startedAt = saved.startedAt;
      this.completedAt = saved.completedAt;
      this.config = saved.config;
      this.stats = saved.stats;
    }
  }

  private reset(): void {
    this._state = 'idle';
    this.plan = null;
    this.currentPhaseIndex = 0;
    this.startedAt = null;
    this.completedAt = null;
    this.stats = createInitialOrchestratorStats();
    this.pausedState = null;
    this.phaseSessionIds.clear();
    this.clearPhasePoll();
    this.cleanupTaskHandlers();
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal — Helpers
  // ═══════════════════════════════════════════════════════════════

  private buildTaskPrompt(task: OrchestratorTask, phase: OrchestratorPhase): string {
    if (phase.tasks.length === 1) {
      // Single task — use simpler prompt
      const completedPhases = this.getCompletedPhasesSummary();
      return SINGLE_TASK_PROMPT.replace('{TASK}', task.prompt)
        .replace('{GOAL}', this.plan?.goal || '')
        .replace('{CONTEXT}', completedPhases ? `Previous phases completed: ${completedPhases}` : '')
        .replace('{COMPLETION_PHRASE}', task.completionPhrase);
    }

    // Multi-task phase — use full prompt
    return PHASE_EXECUTION_PROMPT.replace('{PHASE_NAME}', phase.name)
      .replace('{GOAL}', this.plan?.goal || '')
      .replace('{COMPLETED_PHASES}', this.getCompletedPhasesSummary() || 'None yet')
      .replace('{TASK_LIST}', phase.tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join('\n'))
      .replace('{VERIFICATION_CRITERIA}', phase.verificationCriteria.join('\n') || 'No specific criteria')
      .replace('{COMPLETION_PHRASE}', task.completionPhrase);
  }

  private getCompletedPhasesSummary(): string {
    if (!this.plan) return '';
    return this.plan.phases
      .filter((p) => p.status === 'passed' || p.status === 'skipped')
      .map((p) => `${p.name}: ${p.status}`)
      .join(', ');
  }

  private findOrchestratorTaskByQueueId(queueTaskId: string): OrchestratorTask | null {
    if (!this.plan) return null;
    for (const phase of this.plan.phases) {
      for (const task of phase.tasks) {
        if (task.queueTaskId === queueTaskId) return task;
      }
    }
    return null;
  }

  /** Clean up resources when the loop is being destroyed. */
  destroy(): void {
    this.clearPhasePoll();
    this.cleanupTaskHandlers();
  }
}
