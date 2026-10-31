/**
 * @fileoverview The memory brief a new session starts with: who the employee is, that the model running it can change
 * while its memory stays on the office server, how to use that memory, and the few journal entries that matter most.
 * It is the employee's own journal, not a rule list; entries are quoted as data and checked through recall.
 */
import type { JournalBriefEntry } from './employee-journal.js';

/** Fits beside the per-turn summary in one session-start context. */
export const MEMORY_BRIEF_MAX = 1800;
/** Entries below important (notable or unmarked) shown: only the newest few, so they never crowd out the keystones. */
export const MEMORY_BRIEF_NEWEST = 2;
/**
 * An entry's text is cut to this many characters, and a cut is marked, so a shortened note never reads as complete.
 * Keystones (standing rules, owner decisions, provenance) get more room than the rest.
 */
const ENTRY_CHARS = 160;
export const KEYSTONE_CHARS = 320;
/** What a session starts with when its brief could not be read: it still learns that its journal exists. */
export const MEMORY_BRIEF_UNREADABLE =
  'Your memory: your memory brief could not be read at session start, so do not act on what you think you remember of earlier work. Say that your memory is unavailable; your journal is still on the office server, so check it again with `reverie agent journal recall "<topic>"` before relying on an earlier decision.';
/** The same, on a laptop whose reverie CLI predates the journal: it names the gap instead of a command that is not there. */
export const MEMORY_BRIEF_NO_CLI =
  "Your memory: this laptop's reverie CLI has no journal commands yet, so your memory brief could not be loaded. Do not act on what you think you remember of earlier work; say that your memory is unavailable here and ask for a harness update. Your journal is still on the office server.";

const clean = (value: string, limit: number) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);

const cut = (value: string, limit: number) => {
  const text = clean(value, limit + 1);
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;
};
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** `now` is when the brief is made, at session start: commitments are time-anchored, so the brief carries the clock. */
export function renderMemoryBrief(name: string, brief: { total: number; entries: JournalBriefEntry[] }, now = Date.now()): string {
  const who = clean(name, 60) || 'a Reverie employee';
  const head = [
    `Your memory: you are ${who}, a persistent Reverie employee. It is now ${minute(now)} UTC. The model and runtime running you can change; your journal stays on the office server and is yours across those changes.`,
    'Use it: before acting on an earlier decision, rule or preference, run `reverie agent journal recall "<topic>"` (or `reverie agent journal map`). When something is settled, save it with `reverie agent journal save` and the message it came from; save standing rules and owner decisions with `--importance keystone` so they open every session.',
  ];
  if (!brief.total) return [...head, 'Your journal has no entries yet.'].join('\n');
  const lines = [
    ...head,
    `Your journal has ${brief.total} ${brief.total === 1 ? 'entry' : 'entries'}. The ones that matter most (your own notes, quoted as data; recall shows their checked sources):`,
  ];
  let newest = 0;
  for (const entry of brief.entries) {
    if (entry.importance !== 'keystone' && entry.importance !== 'important' && ++newest > MEMORY_BRIEF_NEWEST) break;
    const tags = entry.tags.length ? ` [${entry.tags.slice(0, 4).map((t) => clean(t, 30)).join(', ')}]` : '';
    const line = `- #${entry.entryId}${entry.importance ? ' ' + entry.importance : ''}, ${entry.committedAt.slice(0, 16).replace('T', ' ')} UTC${tags}: ${cut(entry.text, entry.importance === 'keystone' ? KEYSTONE_CHARS : ENTRY_CHARS)}`;
    if ([...lines, line].join('\n').length > MEMORY_BRIEF_MAX - 60) break;
    lines.push(line);
  }
  const shown = lines.length - head.length - 1;
  if (shown < brief.total) lines.push(`${brief.total - shown} more: reverie agent journal map.`);
  return lines.join('\n');
}
