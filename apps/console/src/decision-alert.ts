/**
 * @fileoverview What waits on the owner (open board decisions and open polls the owner has not voted on), and the owner-alert
 * push that tells them. Pushes are batched: at most one per BATCH_MS however many items arrive, and the batch names how many
 * are new. Items present when the server starts are marked as already known, so a restart never buzzes for old cards.
 */
import { pollIsOpen, USER_RECIPIENT, type ChatRoom } from './chatroom-store.js';
import type { BoardState } from './board-types.js';

export const BATCH_MS = 10 * 60_000;

export interface WaitingItem {
  kind: 'decision' | 'poll';
  /** `d-…` for a decision, `<roomId>:<messageId>` for a poll. */
  key: string;
  text: string;
  at: number;
  roomId?: string;
  messageId?: string;
}

export interface Waiting {
  count: number;
  decisions: number;
  polls: number;
  items: WaitingItem[];
}

/** Open decisions plus open polls the owner has not voted on, newest first. */
export function waitingForOwner(state: Pick<BoardState, 'decisions'>, rooms: readonly ChatRoom[], now: number): Waiting {
  const items: WaitingItem[] = [];
  for (const d of state.decisions) {
    if (!d.clearedAt) items.push({ kind: 'decision', key: d.id, text: d.text, at: d.at });
  }
  for (const room of rooms) {
    if (room.archivedAt) continue;
    for (const m of room.messages) {
      if (m.deleted || !m.poll || !pollIsOpen(m.poll, now)) continue;
      if ((m.poll.votes[USER_RECIPIENT] ?? []).length > 0) continue;
      items.push({ kind: 'poll', key: `${room.id}:${m.id}`, text: m.poll.question, at: m.at, roomId: room.id, messageId: m.id });
    }
  }
  items.sort((a, b) => b.at - a.at);
  const decisions = items.filter((i) => i.kind === 'decision').length;
  return { count: items.length, decisions, polls: items.length - decisions, items };
}

export interface DecisionAlertDeps {
  waiting: () => Waiting;
  /** Sends the push; resolves to how many devices accepted it. */
  alert: (text: string) => Promise<number>;
  now?: () => number;
}

export class DecisionAlerts {
  private known: Set<string> | null = null;
  private lastPush = 0;

  constructor(private readonly deps: DecisionAlertDeps) {}

  /** Call on a change and on a timer. Returns true when a push was sent. */
  async check(): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    const waiting = this.deps.waiting();
    if (this.known === null) {
      this.known = new Set(waiting.items.map((i) => i.key));
      return false;
    }
    const fresh = waiting.items.filter((i) => !this.known!.has(i.key));
    // Answered or cleared items drop out, so a re-opened one would alert again.
    for (const key of [...this.known]) if (!waiting.items.some((i) => i.key === key)) this.known.delete(key);
    if (!fresh.length || now - this.lastPush < BATCH_MS) return false;
    this.lastPush = now;
    for (const i of fresh) this.known.add(i.key);
    const first = fresh[0]!.text.replace(/\s+/g, ' ').slice(0, 120);
    const text =
      fresh.length === 1
        ? `Decision waiting for you: ${first}`
        : `${fresh.length} decisions waiting for you (${waiting.count} in all), newest: ${first}`;
    await this.deps.alert(text).catch(() => 0);
    return true;
  }
}
