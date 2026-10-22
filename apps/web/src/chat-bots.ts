/**
 * @fileoverview Chat bots: named post-only senders that scheduled jobs speak through.
 *
 * A bot reads nothing and joins no room. It has a name, an optional icon, a room allowlist and a
 * posts-per-hour cap. The registry is instance data (`chat-bots.json` next to the rooms), never
 * part of the repository; a missing or damaged file means no bots, so nothing can post.
 */
import { promises as fs, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeIcon } from './chatroom-store.js';

export interface ChatBot {
  id: string;
  name: string;
  /** One emoji (or at most two characters), shown instead of an initial. */
  icon?: string;
  /** Ids of the rooms it may post in; any other room is refused. */
  rooms: string[];
  /** Most posts it may make in any rolling hour, across all jobs. */
  maxPerHour: number;
}

export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_BOTS = 20;
export const MAX_BOT_ROOMS = 100;
export const DEFAULT_BOT_POSTS_PER_HOUR = 30;
const MAX_POSTS_PER_HOUR = 120;

export class ChatBotError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT'
  ) {
    super(message);
  }
}

/** Validate and normalise one bot definition, or throw. */
export function parseBot(raw: unknown, id: string): ChatBot {
  if (!BOT_ID_PATTERN.test(id)) throw new ChatBotError('A bot id is lowercase letters, digits, - or _ (40 at most)', 'INVALID_INPUT');
  if (!raw || typeof raw !== 'object') throw new ChatBotError('A bot is an object', 'INVALID_INPUT');
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > 40 || /[@\n\r]/.test(name)) {
    throw new ChatBotError('A bot name is 1-40 characters without @ or line breaks', 'INVALID_INPUT');
  }
  let icon: string | undefined;
  if (o.icon !== undefined && o.icon !== '') {
    icon = typeof o.icon === 'string' ? normalizeIcon(o.icon) : undefined;
    if (icon === undefined) throw new ChatBotError('An icon is one emoji or at most two characters', 'INVALID_INPUT');
  }
  if (!Array.isArray(o.rooms) || o.rooms.length > MAX_BOT_ROOMS || o.rooms.some((r) => typeof r !== 'string' || !r || r.length > 100)) {
    throw new ChatBotError(`rooms is a list of at most ${MAX_BOT_ROOMS} room ids`, 'INVALID_INPUT');
  }
  const cap = o.maxPerHour === undefined ? DEFAULT_BOT_POSTS_PER_HOUR : o.maxPerHour;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > MAX_POSTS_PER_HOUR) {
    throw new ChatBotError(`maxPerHour is a whole number from 1 to ${MAX_POSTS_PER_HOUR}`, 'INVALID_INPUT');
  }
  return { id, name, ...(icon ? { icon } : {}), rooms: [...new Set(o.rooms as string[])], maxPerHour: cap };
}

export class ChatBotRegistry {
  private bots = new Map<string, ChatBot>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    this.load();
  }

  /** Read the file; anything unreadable or invalid is dropped (fail closed: that bot cannot post). */
  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      try {
        this.bots.set(id, parseBot(raw, id));
      } catch (err) {
        console.error(`[chat-bots] ignoring bot "${id}":`, err instanceof Error ? err.message : err);
      }
    }
  }

  list(): ChatBot[] {
    return [...this.bots.values()];
  }

  get(id: string): ChatBot | undefined {
    return this.bots.get(id);
  }

  async set(id: string, raw: unknown): Promise<ChatBot> {
    const bot = parseBot(raw, id);
    if (!this.bots.has(id) && this.bots.size >= MAX_BOTS) throw new ChatBotError(`At most ${MAX_BOTS} bots`, 'CONFLICT');
    this.bots.set(id, bot);
    await this.save();
    return bot;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.bots.delete(id)) return false;
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.bots), null, 2);
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.saveChain;
  }
}
