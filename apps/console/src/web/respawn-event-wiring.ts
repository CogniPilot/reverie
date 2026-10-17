/**
 * @fileoverview Respawn event wiring — pure functions that connect RespawnController
 * events to SSE broadcasts, push notifications, and run summary tracking.
 *
 * Extracted from WebServer to keep respawn-specific event plumbing separate from
 * HTTP/session concerns. Follows the same DI pattern as session-listener-wiring.ts.
 */

import { Session } from '../session.js';
import { RespawnController, RespawnConfig, RespawnState } from '../respawn-controller.js';
import type { PersistedRespawnConfig } from '../types.js';
import type { RunSummaryTracker } from '../run-summary.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import type { TeamWatcher } from '../team-watcher.js';
import { SseEvent } from './sse-events.js';

// ============================================================================
// Dependency Interface
// ============================================================================

export interface RespawnWiringDeps {
  broadcast(event: string, data: unknown): void;
  sendPushNotifications(event: string, data: Record<string, unknown>): void;
  persistSessionState(session: Session): void;
  getSession(sessionId: string): Session | undefined;
  sessionExists(sessionId: string): boolean;
  getRunSummaryTracker(sessionId: string): RunSummaryTracker | undefined;
  getRespawnControllers(): Map<string, RespawnController>;
  getRespawnTimers(): Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }>;
  getPendingRespawnStarts(): Map<string, NodeJS.Timeout>;
  teamWatcher: TeamWatcher;
  serverStartTime: number;
  respawnRestoreGracePeriodMs: number;
  mux: TerminalMultiplexer;
}

// ============================================================================
// Respawn Listener Wiring
// ============================================================================

/**
 * Wire a RespawnController's events to SSE broadcasts, push notifications,
 * and run summary tracking.
 */
export function wireRespawnListeners(sessionId: string, controller: RespawnController, deps: RespawnWiringDeps): void {
  // Wire team watcher for team-aware idle detection
  controller.setTeamWatcher(deps.teamWatcher);

  // Helper to get tracker lazily (may not exist at setup time for restored sessions)
  const getTracker = () => deps.getRunSummaryTracker(sessionId);

  // ─── Respawn State Machine ──────────────────────────────

  /** Broadcasts `respawn:stateChanged` — state machine transition (e.g., IDLE → DETECTING → RESPAWNING) */
  controller.on('stateChanged', (state: RespawnState, prevState: RespawnState) => {
    deps.broadcast(SseEvent.RespawnStateChanged, { sessionId, state, prevState });
    const tracker = getTracker();
    if (tracker) tracker.recordStateChange(state, `${prevState} → ${state}`);
  });

  // ─── Respawn Cycle Lifecycle ────────────────────────────

  /** Broadcasts `respawn:cycleStarted` — new respawn cycle begins */
  controller.on('respawnCycleStarted', (cycleNumber: number) => {
    deps.broadcast(SseEvent.RespawnCycleStarted, { sessionId, cycleNumber });
  });

  /** Broadcasts `respawn:cycleCompleted` — respawn cycle finished */
  controller.on('respawnCycleCompleted', (cycleNumber: number) => {
    deps.broadcast(SseEvent.RespawnCycleCompleted, { sessionId, cycleNumber });
  });

  /** Broadcasts `respawn:blocked` + push notification — respawn blocked by error/circuit breaker */
  controller.on('respawnBlocked', (data: { reason: string; details: string }) => {
    deps.broadcast(SseEvent.RespawnBlocked, { sessionId, reason: data.reason, details: data.details });
    const sessionForPush = deps.getSession(sessionId);
    deps.sendPushNotifications(SseEvent.RespawnBlocked, {
      sessionId,
      sessionName: sessionForPush?.name ?? sessionId.slice(0, 8),
      reason: data.reason,
    });
    const tracker = getTracker();
    if (tracker) tracker.recordWarning(`Respawn blocked: ${data.reason}`, data.details);
  });

  // ─── Respawn Step Progress ──────────────────────────────

  /** Broadcasts `respawn:stepSent` — respawn step input sent (e.g., /clear, kickstart prompt) */
  controller.on('stepSent', (step: string, input: string) => {
    deps.broadcast(SseEvent.RespawnStepSent, { sessionId, step, input });
  });

  /** Broadcasts `respawn:stepCompleted` — respawn step finished */
  controller.on('stepCompleted', (step: string) => {
    deps.broadcast(SseEvent.RespawnStepCompleted, { sessionId, step });
  });

  /** Broadcasts `respawn:detectionUpdate` — idle/completion detection state changed */
  controller.on('detectionUpdate', (detection: unknown) => {
    deps.broadcast(SseEvent.RespawnDetectionUpdate, { sessionId, detection });
  });

  /** Broadcasts `respawn:autoAcceptSent` — auto-accepted a permission prompt */
  controller.on('autoAcceptSent', () => {
    deps.broadcast(SseEvent.RespawnAutoAcceptSent, { sessionId });
  });

  // ─── AI Checker Events ──────────────────────────────────

  /** Broadcasts `respawn:aiCheckStarted` — AI idle checker invoked */
  controller.on('aiCheckStarted', () => {
    deps.broadcast(SseEvent.RespawnAiCheckStarted, { sessionId });
  });

  /** Broadcasts `respawn:aiCheckCompleted` — AI idle check returned verdict (idle/working/stuck) */
  controller.on('aiCheckCompleted', (result: { verdict: string; reasoning: string; durationMs: number }) => {
    deps.broadcast(SseEvent.RespawnAiCheckCompleted, {
      sessionId,
      verdict: result.verdict,
      reasoning: result.reasoning,
      durationMs: result.durationMs,
    });
    const tracker = getTracker();
    if (tracker) tracker.recordAiCheckResult(result.verdict);
  });

  /** Broadcasts `respawn:aiCheckFailed` — AI idle check errored */
  controller.on('aiCheckFailed', (error: string) => {
    deps.broadcast(SseEvent.RespawnAiCheckFailed, { sessionId, error });
    const tracker = getTracker();
    if (tracker) tracker.recordError('AI check failed', error);
  });

  /** Broadcasts `respawn:aiCheckCooldown` — AI check on cooldown after failure */
  controller.on('aiCheckCooldown', (active: boolean, endsAt: number | null) => {
    deps.broadcast(SseEvent.RespawnAiCheckCooldown, { sessionId, active, endsAt });
  });

  // ─── Plan Checker Events ────────────────────────────────

  /** Broadcasts `respawn:planCheckStarted` — AI plan completion checker invoked */
  controller.on('planCheckStarted', () => {
    deps.broadcast(SseEvent.RespawnPlanCheckStarted, { sessionId });
  });

  /** Broadcasts `respawn:planCheckCompleted` — plan check returned verdict */
  controller.on('planCheckCompleted', (result: { verdict: string; reasoning: string; durationMs: number }) => {
    deps.broadcast(SseEvent.RespawnPlanCheckCompleted, {
      sessionId,
      verdict: result.verdict,
      reasoning: result.reasoning,
      durationMs: result.durationMs,
    });
  });

  /** Broadcasts `respawn:planCheckFailed` — plan check errored */
  controller.on('planCheckFailed', (error: string) => {
    deps.broadcast(SseEvent.RespawnPlanCheckFailed, { sessionId, error });
  });

  // ─── Timer Events (UI countdown display) ────────────────

  /** Broadcasts `respawn:timerStarted` — countdown timer started (idle, cooldown, etc.) */
  controller.on('timerStarted', (timer) => {
    deps.broadcast(SseEvent.RespawnTimerStarted, { sessionId, timer });
  });

  /** Broadcasts `respawn:timerCancelled` — timer cancelled before expiry */
  controller.on('timerCancelled', (timerName, reason) => {
    deps.broadcast(SseEvent.RespawnTimerCancelled, { sessionId, timerName, reason });
  });

  /** Broadcasts `respawn:timerCompleted` — timer expired */
  controller.on('timerCompleted', (timerName) => {
    deps.broadcast(SseEvent.RespawnTimerCompleted, { sessionId, timerName });
  });

  // ─── Logging & Errors ───────────────────────────────────

  /** Broadcasts `respawn:actionLog` — respawn action logged for audit/debugging */
  controller.on('actionLog', (action) => {
    deps.broadcast(SseEvent.RespawnActionLog, { sessionId, action });
  });

  /** Broadcasts `respawn:log` — general respawn log message */
  controller.on('log', (message: string) => {
    deps.broadcast(SseEvent.RespawnLog, { sessionId, message });
  });

  /** Broadcasts `respawn:error` — respawn controller error */
  controller.on('error', (error: Error) => {
    deps.broadcast(SseEvent.RespawnError, { sessionId, error: error.message });
    const tracker = getTracker();
    if (tracker) tracker.recordError('Respawn error', error.message);
  });
}

// ============================================================================
// Timed Respawn
// ============================================================================

/**
 * Set up a duration-limited respawn timer that stops respawn after N minutes.
 */
export function setupTimedRespawn(sessionId: string, durationMinutes: number, deps: RespawnWiringDeps): void {
  const timers = deps.getRespawnTimers();

  // Clear existing timer if any
  const existing = timers.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const now = Date.now();
  const endAt = now + durationMinutes * 60 * 1000;

  const timer = setTimeout(
    () => {
      // Stop respawn when time is up
      const controllers = deps.getRespawnControllers();
      const controller = controllers.get(sessionId);
      if (controller) {
        controller.stop();
        controller.removeAllListeners();
        controllers.delete(sessionId);
        deps.broadcast(SseEvent.RespawnStopped, { sessionId, reason: 'duration_expired' });
      }
      timers.delete(sessionId);
      // Update persisted state (respawn no longer active)
      const session = deps.getSession(sessionId);
      if (session) {
        deps.persistSessionState(session);
      }
    },
    durationMinutes * 60 * 1000
  );

  timers.set(sessionId, { timer, endAt, startedAt: now });
  deps.broadcast(SseEvent.RespawnTimerStarted, { sessionId, durationMinutes, endAt, startedAt: now });
}

// ============================================================================
// Respawn Controller Restore
// ============================================================================

/**
 * Restore a RespawnController from persisted configuration.
 * Creates the controller, wires listeners, and starts after a grace period.
 */
export function restoreRespawnController(
  session: Session,
  config: PersistedRespawnConfig,
  source: string,
  deps: RespawnWiringDeps
): void {
  const controller = new RespawnController(session, {
    idleTimeoutMs: config.idleTimeoutMs,
    updatePrompt: config.updatePrompt,
    interStepDelayMs: config.interStepDelayMs,
    enabled: true,
    sendClear: config.sendClear,
    sendInit: config.sendInit,
    kickstartPrompt: config.kickstartPrompt,
    completionConfirmMs: config.completionConfirmMs,
    noOutputTimeoutMs: config.noOutputTimeoutMs,
    autoAcceptPrompts: config.autoAcceptPrompts,
    autoAcceptDelayMs: config.autoAcceptDelayMs,
    aiIdleCheckEnabled: config.aiIdleCheckEnabled,
    aiIdleCheckModel: config.aiIdleCheckModel,
    aiIdleCheckMaxContext: config.aiIdleCheckMaxContext,
    aiIdleCheckTimeoutMs: config.aiIdleCheckTimeoutMs,
    aiIdleCheckCooldownMs: config.aiIdleCheckCooldownMs,
    aiPlanCheckEnabled: config.aiPlanCheckEnabled,
    aiPlanCheckModel: config.aiPlanCheckModel,
    aiPlanCheckMaxContext: config.aiPlanCheckMaxContext,
    aiPlanCheckTimeoutMs: config.aiPlanCheckTimeoutMs,
    aiPlanCheckCooldownMs: config.aiPlanCheckCooldownMs,
  });

  const controllers = deps.getRespawnControllers();
  controllers.set(session.id, controller);
  wireRespawnListeners(session.id, controller, deps);

  // Calculate delay: wait until grace period after server start before starting respawn
  // This prevents false idle detection immediately after a server restart/rebuild
  const timeSinceStart = Date.now() - deps.serverStartTime;
  const delayMs = Math.max(0, deps.respawnRestoreGracePeriodMs - timeSinceStart);

  const pendingStarts = deps.getPendingRespawnStarts();

  if (delayMs > 0) {
    console.log(
      `[Server] Restored respawn controller for session ${session.id} from ${source} (will start in ${Math.ceil(delayMs / 1000)}s)`
    );
    const delayTimer = setTimeout(() => {
      pendingStarts.delete(session.id);
      // Verify session still exists (may have been deleted during grace period)
      if (!deps.sessionExists(session.id)) {
        console.log(`[Server] Skipping restored respawn start - session ${session.id} no longer exists`);
        return;
      }
      // Double-check controller still exists and is stopped
      const ctrl = controllers.get(session.id);
      if (ctrl && ctrl.state === 'stopped') {
        ctrl.start();
        deps.broadcast(SseEvent.RespawnStarted, { sessionId: session.id });
        console.log(`[Server] Restored respawn controller started for session ${session.id}`);
      }
    }, delayMs);
    pendingStarts.set(session.id, delayTimer);
  } else {
    // Grace period has passed, start immediately
    controller.start();
    console.log(`[Server] Restored respawn controller for session ${session.id} from ${source} (started immediately)`);
  }

  if (config.durationMinutes && config.durationMinutes > 0) {
    setupTimedRespawn(session.id, config.durationMinutes, deps);
  }
}

// ============================================================================
// Respawn Config Persistence
// ============================================================================

/**
 * Save respawn config to mux for restart recovery.
 */
export function saveRespawnConfig(
  sessionId: string,
  config: RespawnConfig,
  mux: TerminalMultiplexer,
  durationMinutes?: number
): void {
  const persistedConfig: PersistedRespawnConfig = {
    enabled: config.enabled,
    idleTimeoutMs: config.idleTimeoutMs,
    updatePrompt: config.updatePrompt,
    interStepDelayMs: config.interStepDelayMs,
    sendClear: config.sendClear,
    sendInit: config.sendInit,
    kickstartPrompt: config.kickstartPrompt,
    autoAcceptPrompts: config.autoAcceptPrompts,
    autoAcceptDelayMs: config.autoAcceptDelayMs,
    completionConfirmMs: config.completionConfirmMs,
    noOutputTimeoutMs: config.noOutputTimeoutMs,
    aiIdleCheckEnabled: config.aiIdleCheckEnabled,
    aiIdleCheckModel: config.aiIdleCheckModel,
    aiIdleCheckMaxContext: config.aiIdleCheckMaxContext,
    aiIdleCheckTimeoutMs: config.aiIdleCheckTimeoutMs,
    aiIdleCheckCooldownMs: config.aiIdleCheckCooldownMs,
    aiPlanCheckEnabled: config.aiPlanCheckEnabled,
    aiPlanCheckModel: config.aiPlanCheckModel,
    aiPlanCheckMaxContext: config.aiPlanCheckMaxContext,
    aiPlanCheckTimeoutMs: config.aiPlanCheckTimeoutMs,
    aiPlanCheckCooldownMs: config.aiPlanCheckCooldownMs,
    durationMinutes,
  };
  mux.updateRespawnConfig(sessionId, persistedConfig);
}
