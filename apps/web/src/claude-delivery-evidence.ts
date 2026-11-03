/**
 * Native evidence that a chat delivery reached a Claude session: a new user turn in the session's own transcript.
 *
 * The pane alone cannot always say. Claude can keep paste chrome drawn after a submit, so a composer that still shows the
 * delivery is not proof it is unsent, and an empty-looking one after a chip is not proof it was sent. The transcript is the
 * CLI's own record of what it took as a user turn.
 *
 * The evidence is deliberately narrow:
 * - the transcript is found only by the session's own conversation id, and must be exactly one file; never the newest
 *   file or an mtime guess;
 * - only a user turn written after the byte offset marked before the write counts, so scrollback or an earlier identical
 *   line cannot confirm it;
 * - that turn's text must contain the full delivered line exactly (a long delivery may be expanded from a paste and
 *   wrapped in it), with no prefix or fuzzy matching;
 * - one turn confirms at most one delivery, so two identical lines each need their own turn;
 * - a missing, replaced, shrunk or unreadable transcript is no evidence, and the delivery stays held.
 *
 * @module claude-delivery-evidence
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { claudeProjectsDir } from './utils/claude-transcript.js';

/** Where the transcript stood just before a write: the same file must have grown past `offset` for a turn to count. */
export interface TranscriptMark {
  file: string;
  dev: number;
  ino: number;
  offset: number;
}

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most transcript read after a mark; a delivery's turn lands well inside it. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** The one transcript of `conversationId` under the projects directory, or undefined when there is none or more than one. */
export async function locateClaudeTranscript(conversationId: string, configDir?: string): Promise<string | undefined> {
  if (!CONVERSATION_ID.test(conversationId)) return undefined;
  const projects = claudeProjectsDir(configDir);
  let dirs: string[];
  try { dirs = await fs.readdir(projects); } catch { return undefined; }
  const found: string[] = [];
  for (const dir of dirs) {
    const file = join(projects, dir, `${conversationId}.jsonl`);
    try { if ((await fs.lstat(file)).isFile()) found.push(file); } catch { /* not in this project directory */ }
  }
  return found.length === 1 ? found[0] : undefined;
}

async function openRegular(file: string): Promise<{ handle: fs.FileHandle; dev: number; ino: number; size: number } | undefined> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  const info = await handle.stat();
  if (!info.isFile()) { await handle.close(); return undefined; }
  return { handle, dev: info.dev, ino: info.ino, size: info.size };
}

/** Mark the transcript's current end before a write. */
export async function markTranscript(file: string): Promise<TranscriptMark | undefined> {
  const opened = await openRegular(file);
  if (!opened) return undefined;
  await opened.handle.close();
  return { file, dev: opened.dev, ino: opened.ino, offset: opened.size };
}

/** The text a user turn carries: a string content, or its text blocks (never tool results). */
function turnTexts(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const row = entry as { type?: unknown; isSidechain?: unknown; message?: { role?: unknown; content?: unknown } };
  if (row.type !== 'user' || row.isSidechain === true || row.message?.role !== 'user') return [];
  const content = row.message.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []);
}

/**
 * The byte position of the first complete user turn after `mark` whose text contains `line`, skipping positions in
 * `consumed`; undefined when there is none yet or the transcript is no longer the marked file.
 */
export async function findDeliveredTurn(mark: TranscriptMark, line: string, consumed: ReadonlySet<number>): Promise<number | undefined> {
  if (!line) return undefined;
  const opened = await openRegular(mark.file);
  if (!opened) return undefined;
  const { handle } = opened;
  try {
    if (opened.dev !== mark.dev || opened.ino !== mark.ino || opened.size < mark.offset) return undefined;
    const length = Math.min(opened.size - mark.offset, MAX_READ_BYTES);
    if (length <= 0) return undefined;
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, mark.offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    // Only complete rows count: a turn still being written is checked again later.
    let start = 0;
    for (let end = bytes.indexOf(10, 0); end >= 0 && end < read; start = end + 1, end = bytes.indexOf(10, start)) {
      const position = mark.offset + start;
      if (consumed.has(position)) continue;
      let entry: unknown;
      try { entry = JSON.parse(bytes.subarray(start, end).toString('utf8')); } catch { continue; }
      if (turnTexts(entry).some((text) => text.includes(line))) return position;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
