/**
 * @fileoverview Session lifecycle audit types.
 *
 * Types for the append-only JSONL audit log at `~/.codeman/session-lifecycle.jsonl`.
 * Records session creation, PTY launch/exit, server start/stop, tmux recovery,
 * and QR auth events. Written by `SessionLifecycleLog`, read for debugging.
 *
 * Key exports:
 * - LifecycleEventType — union of 13 event types (created, started, exit, qr_auth, thread_set, full_access_missing, etc.)
 * - LifecycleEntry — a single timestamped log entry with event, sessionId, and optional metadata
 *
 * No dependencies on other domain modules. LifecycleEntry.sessionId links
 * back to SessionState.id for correlation.
 */

/** Types of session lifecycle events recorded to the audit log */
export type LifecycleEventType =
  | 'created' // Session object created
  | 'started' // PTY process launched (interactive/shell/prompt)
  | 'exit' // PTY process exited (with exit code)
  | 'deleted' // cleanupSession() called — session removed
  | 'detached' // Server shutdown — PTY left alive in tmux for recovery
  | 'recovered' // Session restored from tmux on server restart
  | 'stale_cleaned' // Removed from state.json by cleanupStaleSessions()
  | 'mux_died' // tmux session died (detected by reconciliation)
  | 'server_started' // Server started (marker for restart detection)
  | 'server_stopped' // Server shutting down
  | 'qr_auth' // Device authenticated via QR code scan
  | 'thread_set' // Owner pointed an OpenCode session at another thread (extra: from, to, by)
  | 'full_access_missing'; // A local launch's real argv lacks its CLI bypass flag (extra: pid, missing, reason)

/** A single entry in the session lifecycle audit log */
export interface LifecycleEntry {
  ts: number;
  event: LifecycleEventType;
  sessionId: string;
  name?: string;
  mode?: string;
  reason?: string;
  exitCode?: number | null;
  extra?: Record<string, unknown>;
}
