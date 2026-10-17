/**
 * @fileoverview What each agent session has actually SEEN of each room: the newest message that
 * reached its prompt (a delivery line the CLI was seen to submit) or that it read through the API.
 *
 * Room messages reach an agent as typed prompt lines, so a read cursor on the agent's side
 * rarely exists. The console is the one place that knows what an agent was really given. A line
 * that was typed but never left the composer (the Codex paste placeholder of 2026-10-16) does
 * NOT count: that is exactly a message the agent has not seen.
 *
 * Kept next to chatrooms.json (0600, tmp+rename, debounced) so a console restart does not reset
 * every agent to "has seen nothing". Bounded per session and in total; the marker only ever
 * moves forward (by message time).
 */
import fs from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SeenMark {
  messageId: string;
  /** The message's own time, which orders it in the room. */
  at: number;
}

const MAX_SESSIONS = 500;
const MAX_ROOMS_PER_SESSION = 500;
const PERSIST_DEBOUNCE_MS = 1000;

type Marks = Map<string, Map<string, SeenMark>>;

export class LastSeenStore {
  private marks: Marks = new Map();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | undefined) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      for (const [sessionId, rooms] of Object.entries(raw as Record<string, unknown>)) {
        if (!rooms || typeof rooms !== 'object') continue;
        for (const [roomId, mark] of Object.entries(rooms as Record<string, unknown>)) {
          const m = mark as Partial<SeenMark>;
          if (typeof m?.messageId === 'string' && typeof m.at === 'number' && Number.isFinite(m.at)) {
            this.set(sessionId, roomId, { messageId: m.messageId, at: m.at });
          }
        }
      }
    } catch {
      // A missing or broken file starts empty: the warning just says less until the next delivery.
    }
  }

  get(sessionId: string, roomId: string): SeenMark | undefined {
    return this.marks.get(sessionId)?.get(roomId);
  }

  /** Move the marker forward to `mark` if it is newer; returns whether it moved. */
  advance(sessionId: string, roomId: string, mark: SeenMark): boolean {
    const current = this.get(sessionId, roomId);
    if (current && current.at >= mark.at) return false;
    this.set(sessionId, roomId, mark);
    this.schedulePersist();
    return true;
  }

  /** Forget a session (deleted) or a room (deleted). */
  forget(sessionId?: string, roomId?: string): void {
    if (sessionId && !roomId) this.marks.delete(sessionId);
    else if (roomId) for (const [sid, rooms] of this.marks) if (!sessionId || sid === sessionId) rooms.delete(roomId);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.persist();
    }
    await this.chain;
  }

  private set(sessionId: string, roomId: string, mark: SeenMark): void {
    let rooms = this.marks.get(sessionId);
    if (!rooms) {
      if (this.marks.size >= MAX_SESSIONS) this.marks.delete(this.marks.keys().next().value as string);
      rooms = new Map();
      this.marks.set(sessionId, rooms);
    }
    rooms.delete(roomId); // re-insert: map order is recency, the oldest goes first at the cap
    if (rooms.size >= MAX_ROOMS_PER_SESSION) rooms.delete(rooms.keys().next().value as string);
    rooms.set(roomId, mark);
  }

  private schedulePersist(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private persist(): void {
    const file = this.file;
    if (!file) return;
    const snapshot: Record<string, Record<string, SeenMark>> = {};
    for (const [sid, rooms] of this.marks) snapshot[sid] = Object.fromEntries(rooms);
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
        await fs.rename(tmp, file);
      })
      .catch(() => undefined);
  }
}
