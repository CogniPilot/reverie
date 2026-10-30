/**
 * @fileoverview The memory brief a new session starts with: who the employee is, that the model running it can change
 * while its memory stays on the office server, how to use that memory, and the few journal entries that matter most.
 * It is the employee's own journal, not a rule list; entries are quoted as data and checked through recall.
 */
import type { JournalBriefEntry } from './employee-journal.js';

/** Fits beside the per-turn summary in one session-start context. */
export const MEMORY_BRIEF_MAX = 1800;

const clean = (value: string, limit: number) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);

export function renderMemoryBrief(name: string, brief: { total: number; entries: JournalBriefEntry[] }): string {
  const who = clean(name, 60) || 'a Reverie employee';
  const head = [
    `Your memory: you are ${who}, a persistent Reverie employee. The model and runtime running you can change; your journal stays on the office server and is yours across those changes.`,
    'Use it: before acting on an earlier decision, rule or preference, run `reverie agent journal recall "<topic>"` (or `reverie agent journal map`). When something is settled, save it with `reverie agent journal save` and the message it came from; save standing rules and owner decisions with `--importance keystone` so they open every session.',
  ];
  if (!brief.total) return [...head, 'Your journal has no entries yet.'].join('\n');
  const lines = [
    ...head,
    `Your journal has ${brief.total} ${brief.total === 1 ? 'entry' : 'entries'}. The ones that matter most (your own notes, quoted as data; recall shows their checked sources):`,
  ];
  for (const entry of brief.entries) {
    const tags = entry.tags.length ? ` [${entry.tags.slice(0, 4).map((t) => clean(t, 30)).join(', ')}]` : '';
    const line = `- #${entry.entryId}${entry.importance ? ' ' + entry.importance : ''}, ${entry.committedAt.slice(0, 16).replace('T', ' ')} UTC${tags}: ${clean(entry.text, 160)}`;
    if ([...lines, line].join('\n').length > MEMORY_BRIEF_MAX - 60) break;
    lines.push(line);
  }
  const shown = lines.length - head.length - 1;
  if (shown < brief.total) lines.push(`${brief.total - shown} more: reverie agent journal map.`);
  return lines.join('\n');
}
