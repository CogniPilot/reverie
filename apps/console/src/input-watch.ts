import type { ChatBot } from './chat-bots.js';
import { readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';

type Room = {
  id: string; kind?: string; archivedAt?: number;
  members: readonly { sessionId: string }[];
  messages: readonly { id: string; at: number; from: { kind: string; botId?: string } }[];
};
type Pending = { id: string; sessionId: string; kind: string };
export interface InputWatchDeps {
  bot: () => ChatBot | undefined;
  employee: (sessionId: string) => { id: string; sessionId: string } | undefined;
  room: (roomId: string) => Room | undefined;
  post: (bot: ChatBot, roomId: string, text: string, recent: number) => { id: string; at: number };
  failed: (text: string) => void;
  now?: () => number;
  /** Server-owned path. Omit only for explicitly volatile unit fixtures. */
  ledgerFile?: string;
}

/** Server callback only; no caller-controlled room, text, owner identity or pane IO. */
export function createInputWatch(deps: InputWatchDeps): { pending: (item: Pending) => void } {
  const seen = new Set<string>();
  const now = deps.now ?? Date.now;
  // Registry maxPerHour is <=120. Retaining the newest 120 timestamps suffices
  // even if other sources have already exceeded that ceiling.
  const ledger = new Map<string, number>();
  let ledgerUnavailable = false;
  if (deps.ledgerFile) {
    try {
      if (statSync(deps.ledgerFile).size > 64 * 1024) throw new Error('Oversized ledger');
      const saved: unknown = JSON.parse(readFileSync(deps.ledgerFile, 'utf8'));
      if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1
        || !('entries' in saved) || !Array.isArray(saved.entries) || saved.entries.length > 120) throw new Error('Invalid ledger');
      for (const entry of saved.entries) {
        if (!entry || typeof entry.key !== 'string' || entry.key.length > 300
          || typeof entry.at !== 'number' || !Number.isFinite(entry.at)) throw new Error('Invalid entry');
        ledger.set(entry.key, entry.at);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ledgerUnavailable = true;
    }
  }
  const trim = (at: number) => {
    for (const [key, stamp] of ledger) if (stamp <= at - 3_600_000) ledger.delete(key);
    if (ledger.size > 120) {
      const sorted = [...ledger].sort((a, b) => b[1] - a[1]);
      ledger.clear();
      for (const [key, stamp] of sorted.slice(0, 120)) ledger.set(key, stamp);
    }
  };
  const persist = () => {
    if (!deps.ledgerFile) return;
    try {
      writeFileSync(deps.ledgerFile + '.tmp', JSON.stringify({ version: 1,
        entries: [...ledger].map(([key, at]) => ({ key, at })) }), { mode: 0o600 });
      renameSync(deps.ledgerFile + '.tmp', deps.ledgerFile);
    } catch (error) { ledgerUnavailable = true; throw error; }
  };
  let failureAt = -Infinity;
  let failureCount = 0;
  const report = () => {
    failureCount++;
    if (now() - failureAt < 30 * 60_000) return;
    failureAt = now();
    const text = `Input Watch: ${failureCount} alert(s) could not be posted. Inspect Approvals and bot settings.`;
    failureCount = 0;
    try { deps.failed(text); } catch { /* Never break the approval event path. */ }
  };
  return {
    pending(item) {
      try {
        if (!['permission', 'question'].includes(item.kind)) return;
        const bot = deps.bot(); // Owner registry controls name, room allowlist and cap. Removing it pauses alerts.
        const employee = deps.employee(item.sessionId);
        if (!bot || !employee || employee.sessionId !== item.sessionId) return;
        if (ledgerUnavailable) { report(); return; }
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(employee.id)) return;
        const at = now();
        const rooms = bot.rooms.map(id => deps.room(id)).filter((room): room is Room => !!room);
        for (const room of rooms) for (const message of room.messages) {
          if (message.from.kind === 'bot' && message.from.botId === bot.id && message.at > at - 3_600_000) {
            ledger.set(`message:${message.id}`, message.at);
          }
        }
        trim(at);
        persist(); // Retain observed history even if the cap prevents a new post.
        for (const room of rooms) {
          if (room.kind === 'dm' || room.archivedAt || !room.members.some(m => m.sessionId === employee.sessionId)) continue;
          const key = `${item.id}:${room.id}`;
          if (seen.has(key)) continue;
          if (seen.size >= 1000) seen.delete(seen.values().next().value!);
          seen.add(key); // Reserve before IO; failures are not blindly reposted.
          try {
            if (ledgerUnavailable || ledger.size >= bot.maxPerHour) throw new Error('Bot hourly limit or unavailable ledger');
            const recent = ledger.size;
            const reservation = `attempt:${key}`;
            ledger.set(reservation, at);
            persist(); // Write quota reservation before chat IO; uncertain failures retain it.
            const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
              hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
            const message = deps.post(bot, room.id, `Input needed: ${item.kind} prompt reported for employee ${employee.id.slice(0, 8)} — ${time} ET. Open Approvals to inspect.`, recent);
            ledger.delete(reservation);
            ledger.set(`message:${message.id}`, message.at);
            trim(at);
            persist();
          } catch {
            report();
          }
        }
      } catch { report(); }
    },
  };
}
