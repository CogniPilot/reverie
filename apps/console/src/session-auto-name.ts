/**
 * @fileoverview Automatic session names from the first prompt.
 *
 * A new tab is born as `w3-myapp`, which says where it runs and nothing about
 * what it is doing. Once the user submits a real prompt the tab can carry a
 * title derived from it (`w3-myapp: fix the login redirect`), and this module
 * holds the three pure pieces of that: a tracker that reconstructs the composer
 * text from the keystrokes Codeman forwards, the title heuristic, and the
 * prefix-preserving composition.
 *
 * Deliberately no LLM: the prompt already passes through the input boundary,
 * so a local title is private, deterministic and identical for every CLI.
 *
 * ⚠️ The tracker sits on the raw keystroke stream, which carries far more than
 * the prompt: cursor keys, mouse reports Codeman forwards to the CLI, bracketed
 * pastes, Alt chords, the bare Esc that interrupts a turn. Every one of those
 * once named a tab something wrong (a lone Esc ate the next prompt's first
 * character; a wheel tick mid-word dropped the first half of the prompt), so
 * the rules below are explicit per key. The model is a best-effort transcript:
 * keys whose effect on the composer is knowable are mirrored, keys that leave
 * the text alone are ignored, and keys that replace it with something the
 * tracker cannot see (history recall) TAINT the draft so that Enter submits
 * nothing rather than a fragment. A prompt that yields no title leaves the
 * session eligible for the next one.
 *
 * Only user-originated input is fed here; the Session decides that. Ralph
 * kick-starts, respawn `/clear`s, cron launches and approval answers all go
 * through the same write paths and must never become a tab title.
 *
 * @module session-auto-name
 */

import { MAX_SESSION_NAME_LENGTH } from './config/terminal-limits.js';

/**
 * Longest composer draft kept, in code points. The title is cut from the HEAD
 * of the prompt, so once the cap is reached further text is counted rather
 * than kept (backspaces consume that count first). Keeping the tail instead
 * would turn a long paste into a title made of its last line.
 */
const MAX_PROMPT_BUFFER_CODE_POINTS = 8_192;

/** Longest escape sequence collected before the tracker gives up on it. */
const MAX_ESCAPE_SEQUENCE_LENGTH = 64;

/** Longest title, in code points, before it is cut with an ellipsis. */
const MAX_AUTO_NAME_CODE_POINTS = 72;

/**
 * A sentence boundary is only honoured this far into the prompt, or "e.g. fix
 * this now" becomes "e.g." and "Ok. Fix the bug" becomes "Ok". Short enough
 * that a CJK sentence (a dozen code points is a full request) still cuts.
 */
const MIN_SENTENCE_CODE_POINTS = 8;

/** A CSI sequence ends at its first byte in this range. */
const CSI_FINAL_BYTE = /[\x40-\x7e]/;
/** CSI parameter and intermediate bytes; anything else mid-sequence is malformed. */
const CSI_BODY_BYTE = /[\x20-\x3f]/;

/**
 * `/clear`, `/model opus`, `/ralph-loop:ralph-loop`: a slash followed by a
 * command word and then whitespace or the end. A path (`/home/me/notes.txt
 * what is this`) has a second slash where the whitespace should be and so is a
 * prompt.
 */
const SLASH_COMMAND_PATTERN = /^\/[a-z][a-z0-9_:-]*(?:\s|$)/i;

// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE_PATTERN = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/g;
const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '。', '！', '？']);

/**
 * Reconstructs the composer draft from forwarded keystrokes and reports each
 * submitted prompt. Input arrives in arbitrary chunks (one keystroke, a paste,
 * an agent's whole prompt plus Enter), so all state lives across calls.
 */
export class SubmittedPromptTracker {
  private buffer = '';
  private bufferCodePoints = 0;
  /** Code points typed past the cap; backspaces eat these before real text. */
  private overflow = 0;
  /** Escape sequence in progress; a lone ESC means "just saw ESC". */
  private sequence = '';
  private inPaste = false;
  /** The composer holds text the tracker never saw (history recall); Enter submits nothing. */
  private tainted = false;

  feed(data: string): string[] {
    const submitted: string[] = [];
    for (const ch of data) {
      if (this.sequence) {
        this.continueSequence(ch);
        continue;
      }
      if (ch === '\x1b') {
        this.sequence = ch;
        continue;
      }
      this.handleKey(ch, submitted);
    }
    // A chunk that ENDS in a lone ESC is the Esc key, not the start of a
    // sequence: xterm hands each key's whole sequence to one write, and the
    // programmatic senders (an approval deny sends exactly `\x1b`) send it
    // alone. Leaving it pending would make the next prompt's first character
    // look like an Alt chord and swallow it.
    if (this.sequence === '\x1b') this.sequence = '';
    return submitted;
  }

  private continueSequence(ch: string): void {
    if (this.sequence === '\x1b') {
      if (ch === '[' || ch === 'O' || ch === ']' || ch === 'P') {
        this.sequence += ch;
        return;
      }
      this.sequence = ch === '\x1b' ? ch : '';
      // Alt+Enter inserts a newline in the composer; every other Alt chord
      // (word movement, Alt+B/F) leaves the text alone.
      if (ch === '\r' || ch === '\n') this.appendSeparator();
      return;
    }

    this.sequence += ch;
    if (this.sequence.length > MAX_ESCAPE_SEQUENCE_LENGTH) {
      // Not a sequence any terminal sends; what follows is unknowable, so the
      // draft is tainted rather than titled after the tail of the garbage.
      this.sequence = '';
      this.tainted = true;
      return;
    }

    const kind = this.sequence[1];
    if (kind === '[') {
      if (CSI_FINAL_BYTE.test(ch)) {
        const sequence = this.sequence;
        this.sequence = '';
        this.handleCsi(sequence);
      } else if (!CSI_BODY_BYTE.test(ch)) {
        // Malformed (an ESC [ followed by text): drop the sequence and let the
        // character count as typed rather than swallowing up to 64 of them.
        this.sequence = '';
        this.handleKeyOrEscape(ch);
      }
      return;
    }
    if (kind === 'O') {
      // SS3 carries exactly one byte (application-mode cursor keys).
      this.sequence = '';
      if (ch === 'A' || ch === 'B') this.tainted = true;
      return;
    }
    // OSC / DCS run to BEL or ST (ESC \).
    if (ch === '\x07' || this.sequence.endsWith('\x1b\\')) this.sequence = '';
  }

  private handleKeyOrEscape(ch: string): void {
    if (ch === '\x1b') {
      this.sequence = ch;
      return;
    }
    // Only reached mid-chunk from a malformed sequence, where no submission can
    // be reported; a stray Enter there resets the draft like any other Enter.
    this.handleKey(ch, []);
  }

  private handleCsi(sequence: string): void {
    if (sequence === '\x1b[200~') {
      this.inPaste = true;
      return;
    }
    if (sequence === '\x1b[201~') {
      this.inPaste = false;
      return;
    }
    const final = sequence[sequence.length - 1];
    // Up/Down (with or without modifiers) recall history: the composer now
    // holds a line this tracker never saw. Everything else leaves the text as
    // it is: Left/Right/Home/End, Delete (`3~`), Shift+Tab (`Z`), SGR mouse
    // reports (`<…M`/`m`, forwarded on every wheel tick), focus reports.
    if (final === 'A' || final === 'B') this.tainted = true;
  }

  private handleKey(ch: string, submitted: string[]): void {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (this.inPaste) {
      // Pasted newlines are newlines IN the composer, never Enter; they and
      // the other controls (tabs) become a single separator.
      if (codePoint < 0x20 || codePoint === 0x7f) this.appendSeparator();
      else this.append(ch);
      return;
    }
    switch (ch) {
      case '\r': {
        const prompt = this.tainted ? '' : this.buffer.trim();
        if (prompt) submitted.push(prompt);
        this.reset();
        return;
      }
      case '\n':
        // Ctrl+J, and the line feed the send-key route injects for Shift+Enter:
        // a newline inside the composer, so the lines join with a separator.
        this.appendSeparator();
        return;
      case '\x7f':
      case '\x08':
        this.backspace();
        return;
      case '\x17': // Ctrl+W: word rubout
        this.killWord();
        return;
      case '\x15': // Ctrl+U: line discard
      case '\x03': // Ctrl+C: clears the composer (or, empty, arms an exit)
        this.reset();
        return;
      case '\x10': // Ctrl+P
      case '\x0e': // Ctrl+N
      case '\x12': // Ctrl+R: history search
      case '\x1f': // Ctrl+_: undo
        this.tainted = true;
        return;
      default:
        // Tab (the @-mention completer, which only ever extends the token),
        // cursor chords (Ctrl+A/E/B/F) and the rest of C0 leave the text alone.
        if (codePoint < 0x20 || codePoint === 0x7f) return;
        this.append(ch);
    }
  }

  /** One space between lines, never a run of them, and none at the start. */
  private appendSeparator(): void {
    if (this.overflow > 0) return;
    if (!this.buffer || /\s$/.test(this.buffer)) return;
    this.append(' ');
  }

  private append(ch: string): void {
    if (this.bufferCodePoints >= MAX_PROMPT_BUFFER_CODE_POINTS) {
      this.overflow += 1;
      return;
    }
    this.buffer += ch;
    this.bufferCodePoints += 1;
  }

  private backspace(): void {
    if (this.overflow > 0) {
      this.overflow -= 1;
      return;
    }
    if (!this.buffer) return;
    const last = this.buffer.charCodeAt(this.buffer.length - 1);
    const units = last >= 0xdc00 && last <= 0xdfff && this.buffer.length >= 2 ? 2 : 1;
    this.buffer = this.buffer.slice(0, -units);
    this.bufferCodePoints -= 1;
  }

  private killWord(): void {
    this.overflow = 0;
    this.buffer = this.buffer.replace(/\S+\s*$/u, '');
    this.bufferCodePoints = Array.from(this.buffer).length;
  }

  private reset(): void {
    this.buffer = '';
    this.bufferCodePoints = 0;
    this.overflow = 0;
    this.tainted = false;
  }
}

/**
 * Turns a submitted prompt into a title, or null when the prompt is not a task:
 * empty, a slash command (`/clear`, `/model`), or a `!` shell escape.
 */
export function deriveAutoSessionName(prompt: string): string | null {
  const text = prompt.replace(CSI_SEQUENCE_PATTERN, '').replace(CONTROL_CHAR_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('!') || SLASH_COMMAND_PATTERN.test(text)) return null;
  return truncateCodePoints(firstSentence(text), MAX_AUTO_NAME_CODE_POINTS);
}

/**
 * The first sentence, provided it is long enough to be one; a trailing full
 * stop is dropped because a tab title is not a sentence.
 */
function firstSentence(text: string): string {
  const codePoints = Array.from(text);
  for (let i = MIN_SENTENCE_CODE_POINTS - 1; i < codePoints.length; i++) {
    if (!SENTENCE_TERMINATORS.has(codePoints[i])) continue;
    const next = codePoints[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    return codePoints
      .slice(0, i + 1)
      .join('')
      .replace(/[.。]+$/, '');
  }
  return text.replace(/[.。]+$/, '');
}

/** Cuts to `max` code points with an ellipsis, on a word boundary when one is near the end. */
function truncateCodePoints(text: string, max: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  let cut = codePoints.slice(0, max - 1).join('');
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= Math.floor(cut.length / 2)) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

/**
 * The name a placeholder becomes: `<prefix>: <title>`, so the tab keeps its
 * case identity and its `w<n>` counter (the tab strip already renders that
 * form as the title alone, prefix in the tooltip, and the next-session counter
 * still matches it). A session with no name at all just takes the title. The
 * result honours `maxLength` in UTF-16 units, the unit the rename route caps.
 */
export function composeAutoSessionName(
  currentName: string,
  title: string,
  maxLength = MAX_SESSION_NAME_LENGTH
): string {
  const prefix = currentName.trim();
  if (!prefix) return fitTitle(title, maxLength);
  const room = maxLength - prefix.length - 2;
  if (room <= 0) return prefix;
  return `${prefix}: ${fitTitle(title, room)}`;
}

/** Fits a title into `maxUnits` UTF-16 units, ellipsis included. */
function fitTitle(title: string, maxUnits: number): string {
  if (title.length <= maxUnits) return title;
  let units = 0;
  let keep = 0;
  for (const codePoint of Array.from(title)) {
    if (units + codePoint.length > maxUnits - 1) break;
    units += codePoint.length;
    keep += 1;
  }
  return truncateCodePoints(title, keep + 1);
}

/** Codeman's own `w<n>-<case>` / `s<n>-<case>` placeholders, the only names auto-naming replaces. */
export function isGeneratedSessionName(name: string): boolean {
  return /^[ws]\d+-[a-zA-Z0-9_-]+$/.test(name);
}
