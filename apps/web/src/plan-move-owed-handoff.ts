/**
 * @fileoverview The handoff a closed plan move still owes its employee.
 *
 * A plan move switches the employee to the new session, launches the agent there and then types the handoff: the
 * text that tells the agent on the new plan to carry on from where the old one was. A move that is closed between
 * the switch and the handoff leaves the employee on a session that was never told anything. On another provider
 * that session starts with an empty conversation, so the handoff is all it would have had.
 *
 * So the handoff of such a move stays owed. The office types exactly that text, once, into that same session when
 * it is next idle at an empty composer: the conditions under which the move itself types it, and the same guarded
 * writer. Exactly once is kept the way the move keeps it: `issued` is on record before the first byte is typed
 * (`PlanMoveHandoffStore`), and a handoff that was issued and not confirmed is never typed again. That case, and
 * a move that had begun to type its handoff itself, is reported as unconfirmed for as long as the session lasts.
 *
 * Nothing is owed for a move that was closed before this office kept the record, for a session the employee has
 * left since, or once the handoff is on record as delivered. Nothing here closes, continues or reads a move.
 */
import { recoveryComposerReady, submitRecoveryPrompt, type RecoveryPromptSession } from './company-recovery-prompt.js';
import { getCli } from './config/cli-registry/registry.js';
import type { PlanMoveOwedHandoff, PlanMoves } from './plan-move.js';
import type { PlanMoveHandoffStore } from './plan-move-handoff-store.js';
import { composerIsEmpty } from './session-submit-verifier.js';

/** The part of an office terminal that the handoff is typed through. */
export interface OwedHandoffSession extends RecoveryPromptSession {
  readonly muxName?: string | null;
  captureInputAdmission(caller?: () => boolean): () => boolean;
  composerProvablyIdle(): boolean;
}

export interface OwedHandoffEmployee {
  readonly id: string;
  readonly owner: string | undefined;
  readonly sessionId: string;
}

export interface OwedHandoffDeps {
  readonly moves: Pick<PlanMoves, 'owedHandoffs'>;
  readonly store: Pick<PlanMoveHandoffStore, 'read' | 'record'>;
  session(sessionId: string): OwedHandoffSession | undefined;
  /** The pane as it is shown, for the one CLI whose empty composer is read from the screen. */
  capturePane?(muxName: string): string | null | undefined;
  submit?: typeof submitRecoveryPrompt;
  now?(): number;
}

export interface OwedHandoffResult {
  readonly outcome: 'done' | 'busy' | 'refused' | 'failed';
  readonly detail: string;
}

/** `owed`: it can still be typed. `unconfirmed`: it was typed, or may have been, and is never typed again. */
export interface OwedHandoffState {
  readonly moveId: string;
  readonly state: 'owed' | 'unconfirmed';
}

export class PlanMoveOwedHandoffs {
  constructor(private readonly deps: OwedHandoffDeps) {
    // The record begins when the office does, so that a move closed from now on is covered.
    deps.store.read();
  }

  /** The newest closed move that switched this employee to the session they are on and never typed its handoff. */
  async #open(
    employee: OwedHandoffEmployee
  ): Promise<{ move: PlanMoveOwedHandoff; state: OwedHandoffState['state'] } | undefined> {
    const move = (await this.deps.moves.owedHandoffs(employee.owner))
      .filter((row) => row.employeeId === employee.id && row.sessionId === employee.sessionId)
      .at(-1);
    if (!move) return undefined;
    const record = this.deps.store.read();
    // Without the record nothing is known about what was typed, so nothing may be typed.
    if (!record) return { move, state: 'unconfirmed' };
    if (move.closedAt < record.since) return undefined;
    const entry = record.moves.get(move.moveId);
    if (entry?.phase === 'delivered' && entry.digest === move.digest) return undefined;
    return { move, state: move.typed || entry ? 'unconfirmed' : 'owed' };
  }

  /** What is owed to this employee, if anything. */
  async owed(employee: OwedHandoffEmployee): Promise<OwedHandoffState | undefined> {
    const open = await this.#open(employee);
    return open ? { moveId: open.move.moveId, state: open.state } : undefined;
  }

  /** The agent is at its composer, the composer is empty and nothing is being worked on. */
  #ready(session: OwedHandoffSession): boolean {
    const mark = getCli(session.mode)?.capabilities.composerReadyMark;
    if (!mark || session.pid === null || !session.composerProvablyIdle()) return false;
    if (recoveryComposerReady(session, mark)) return true;
    if (session.mode !== 'codex' || session.isWorking || session.paneDialog || !session.muxName) return false;
    return composerIsEmpty(this.deps.capturePane?.(session.muxName), '›');
  }

  /**
   * Type the owed handoff now, if the session is ready for it. `current` is the caller's guard; it is asked again
   * by the writer before every key.
   *
   * - `done`: typed and confirmed; nothing is owed any more.
   * - `busy`: the session is not at an idle, empty composer; nothing was typed or recorded.
   * - `refused`: nothing is owed, or it may not be typed (again); nothing was typed.
   * - `failed`: `issued` is on record and the terminal did not confirm. The handoff is never typed again.
   */
  async deliver(employee: OwedHandoffEmployee, moveId: string, current: () => boolean): Promise<OwedHandoffResult> {
    const open = await this.#open(employee);
    if (!open || open.move.moveId !== moveId) return { outcome: 'refused', detail: 'no handoff is owed for this move' };
    if (open.state !== 'owed')
      return { outcome: 'refused', detail: 'the handoff was typed before and not confirmed; it is never typed twice' };
    const session = this.deps.session(employee.sessionId);
    if (!session) return { outcome: 'busy', detail: 'the office has no terminal for the session' };
    const admitted = session.captureInputAdmission(current);
    if (!admitted() || !this.#ready(session))
      return { outcome: 'busy', detail: 'the agent is not idle at an empty composer' };
    const { move } = open,
      entry = { employeeId: employee.id, sessionId: employee.sessionId, digest: move.digest };
    const at = this.deps.now ?? Date.now;
    try {
      this.deps.store.record(move.moveId, { ...entry, phase: 'issued', at: at() });
    } catch {
      return { outcome: 'refused', detail: 'the handoff could not be put on record, so it was not typed' };
    }
    try {
      await (this.deps.submit ?? submitRecoveryPrompt)(session, move.text, admitted, undefined, { fromUser: true });
      this.deps.store.record(move.moveId, { ...entry, phase: 'delivered', at: at() });
    } catch {
      return { outcome: 'failed', detail: 'the handoff was typed and not confirmed; it is not typed again' };
    }
    return { outcome: 'done', detail: 'handoff delivered ' + move.moveId };
  }
}
