// Discrete gesture → command detection.
//
// Maps the recognizer's canned gesture categories onto Codeman commands, with
// debouncing so each command fires once per gesture *entry* (not every frame
// while it's held). Open_Palm is special: it must be held continuously for
// `palmHoldMs` before firing halt-all — a dead-man's-switch that's hard to
// trigger by accident, since pausing every session is a big hammer.

import type { CommandName } from './types.ts';

interface CommandSpec {
  name: CommandName;
  /** If set, the gesture must be held this long (ms) before it fires. */
  holdMs?: number;
}

/** MediaPipe canned gesture category → command. */
const GESTURE_COMMANDS: Record<string, CommandSpec> = {
  Open_Palm: { name: 'halt-all', holdMs: -1 }, // holdMs filled from palmHoldMs
  Thumb_Up: { name: 'approve' },
  Victory: { name: 'new-session' },
};

export class CommandDetector {
  /** gesture category → timestamp (ms) it was first seen in the current hold. */
  private heldSince = new Map<string, number>();
  /** gestures that already fired during the current hold (cleared on release). */
  private fired = new Set<string>();

  constructor(private palmHoldMs = 1000) {}

  reset(): void {
    this.heldSince.clear();
    this.fired.clear();
  }

  private holdMsFor(spec: CommandSpec): number {
    return spec.holdMs === -1 ? this.palmHoldMs : (spec.holdMs ?? 0);
  }

  /**
   * Feed the set of command-gestures currently shown (across all hands).
   * @returns the commands that fired on this frame (usually empty).
   */
  update(gestures: Set<string>, nowMs: number): CommandName[] {
    // Forget gestures no longer held, so they can re-fire on the next entry.
    for (const g of [...this.heldSince.keys()]) {
      if (!gestures.has(g)) {
        this.heldSince.delete(g);
        this.fired.delete(g);
      }
    }

    const fired: CommandName[] = [];
    for (const g of gestures) {
      const spec = GESTURE_COMMANDS[g];
      if (!spec) continue;

      const since = this.heldSince.get(g) ?? nowMs;
      if (!this.heldSince.has(g)) this.heldSince.set(g, since);
      if (this.fired.has(g)) continue;

      if (nowMs - since >= this.holdMsFor(spec)) {
        fired.push(spec.name);
        this.fired.add(g);
      }
    }
    return fired;
  }

  /** 0–1 charge of the held halt-all gesture (1 once fired, 0 when released). */
  haltProgress(nowMs: number): number {
    const since = this.heldSince.get('Open_Palm');
    if (since === undefined) return 0;
    if (this.fired.has('Open_Palm')) return 1;
    return Math.min(1, (nowMs - since) / this.palmHoldMs);
  }
}
