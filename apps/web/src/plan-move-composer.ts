import { composerIsEmpty } from './session-submit-verifier.js';
import { CLAUDE_WORKING_LINE_PATTERN, stripAnsi } from './utils/index.js';

/** Additional Claude task-footer observation for plan recovery only. This proves
 * an empty, framed composer, not idle execution: callers retain working/dialog,
 * native identity, account and authority fences. No input is sent here. */
export function claudeComposerIsReady(screen: string): boolean {
  if (!screen || screen.length > 131_072 || !composerIsEmpty(screen, '❯')) return false;
  const lines = stripAnsi(screen).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const tail = lines.slice(-6);
  const footer = tail.at(-1)?.trim() ?? '';
  if (!/^⏵⏵ bypass permissions on · [1-9]\d{0,2} shells?(?: · [1-9]\d{0,2} feedback drafts?)?$/u.test(footer)) return false;
  let bottom = -1;
  for (let i = 0; i < tail.length; i++) if (/^─{8,}$/u.test(tail[i].trim())) bottom = i;
  if (bottom < 2 || bottom < tail.length - 3) return false;
  // Only the row immediately above this composer's upper ruler is current
  // native work chrome; matching words in earlier transcript are not a fence.
  const top = lines.length - tail.length + bottom - 2;
  if (CLAUDE_WORKING_LINE_PATTERN.test((lines[top - 1] ?? '').toLowerCase())) return false;
  // A custom statusLine may occupy exactly one row between the ruler and the
  // CLI-owned footer. Its text/model is not readiness evidence.
  if (tail.slice(bottom + 1, -1).some(line => !line.trim() || line.length > 512 ||
      /[❯›⏵]|trust|sign[ -]?in|log[ -]?in|permission|approve|allow|esc to interrupt/iu.test(line))) return false;
  return /^❯[ \t\u00a0]*$/u.test(tail[bottom - 1]) &&
    /^─{8,}(?: [^\r\n]{1,80} ─+)?$/u.test(tail[bottom - 2].trim());
}
