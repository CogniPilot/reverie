/**
 * @fileoverview Shared regex patterns for terminal and token parsing.
 *
 * Pre-compiled patterns avoid re-compilation overhead on each use.
 * Import these patterns instead of defining them locally.
 *
 * @module utils/regex-patterns
 */

/**
 * Comprehensive ANSI escape pattern that handles:
 * - SGR (colors/styles): ESC [ params m
 * - CSI sequences (cursor, scroll, etc.): ESC [ params letter
 * - OSC sequences (title, etc.): ESC ] ... BEL or ESC ] ... ST
 * - Single-char escapes: ESC = or ESC >
 *
 * Use this when you need complete ANSI stripping including OSC sequences.
 * Note: Has global flag - reset lastIndex before exec() if reusing.
 */
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_PATTERN_FULL = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>])/g;

/**
 * Simple ANSI CSI-only pattern for basic escape code stripping.
 * Matches: ESC [ params letter (e.g., colors, cursor movement)
 *
 * Use this for faster stripping when OSC sequences aren't a concern.
 * Note: Has global flag - reset lastIndex before exec() if reusing.
 */
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_PATTERN_SIMPLE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Pattern to extract token count from Claude's status line.
 * Matches: "123.4k tokens", "5234 tokens", "1.2M tokens"
 *
 * Capture groups:
 * - Group 1: The numeric value (e.g., "123.4", "5234", "1.2")
 * - Group 2: Optional suffix (k, K, m, M) or undefined
 */
export const TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/;

/**
 * Strips ANSI escape codes from text using the comprehensive pattern.
 * @param text - Text containing ANSI escape codes
 * @returns Text with ANSI codes removed
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN_FULL, '');
}

/**
 * Escape sequences `stripAnsi` leaves behind, removed so the text this module MATCHES
 * against is what the pane visually shows.
 *
 * `ANSI_ESCAPE_PATTERN_FULL` covers three families — `ESC [ … letter`,
 * `ESC ] … (BEL|ST)`, and `ESC =` / `ESC >` — and nothing else. The gap is not
 * theoretical: a stock bash prompt emits `arkon@tnode\x1b(B\x1b[m:`, the CSI is removed
 * and the charset-select `ESC ( B` is not, so `match=tnode:` **fails on a prompt that
 * plainly reads `tnode:`** while `match=(B` succeeds. That is the single most likely
 * thing an orchestrating agent tries, and the failure is silent (a full-length timeout).
 *
 * Two branches, in order:
 * - `ESC P|X|^|_ … (BEL|ST)` — DCS / SOS / PM / APC string sequences. The terminator is
 *   REQUIRED, exactly as `stripAnsi`'s OSC branch requires one: matching an unterminated
 *   string type with a greedy run would delete every byte after it to the end of the
 *   window, which is real output an agent is waiting for.
 * - `ESC <0x20-0x2f>* <0x30-0x7e>` — the ECMA-48 escape-sequence grammar (zero or more
 *   intermediate bytes then a final byte). This is what covers `ESC ( B`, `ESC ) 0`,
 *   `ESC c`, `ESC 7` / `ESC 8`, `ESC # 8` and a stray `ESC \`.
 *
 * Linear-time by the same argument that holds for `stripAnsi`: every starred class is
 * disjoint from what follows it, and `ESC` is excluded from all of them, so two
 * candidate runs can never overlap and there is no backtracking to exploit.
 *
 */
// eslint-disable-next-line no-control-regex -- matching raw terminal control bytes is the point
const ANSI_ESCAPE_RESIDUE = /\x1b(?:[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x2f]*[\x30-\x7e])/g;

/**
 * The text this module matches against: ANSI-stripped, then residue-stripped.
 *
 * Everything downstream (the carry, the haystack, the snippet window) is derived from
 * the output of this function, so there is exactly one definition of "the matched
 * stream" and `findMatch` never sees an escape byte.
 */
export function normalizeTerminalMatchText(raw: string): string {
  return stripAnsi(raw).replace(ANSI_ESCAPE_RESIDUE, '');
}

/**
 * Regex to validate safe file paths (no shell metacharacters).
 * Shared by schemas.ts and tmux-manager.ts for consistent path validation.
 */
/**
 * Braille spinner characters used by Claude Code's Ink UI.
 * Matches any of: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧
 * Used on the hot path (every PTY chunk) — pre-compiled for performance.
 */
export const SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧]/;

/**
 * Claude Code's live working status line, e.g.
 *   `✻ Actualizing… (13m 23s · ↓ 47.5k tokens)`
 *   `✽ Herding… (3s · esc to interrupt)`
 *
 * Matched on the ELLIPSIS + elapsed timer, never on the leading glyph: the
 * animation cycles through `· ✢ ✳ ∗ ✻ ✽` (two of those are ordinary punctuation)
 * and the gerund is randomized per turn, while the finished line (`✻ Cooked for
 * 2m 49s`) carries the same glyph with no `…` and no parenthesis. Feed this
 * ANSI-STRIPPED data: tmux colours the timer separately, so the raw stream has
 * escape sequences sitting between the `…` and the `(`.
 *
 * A sighting is proof the pane is working; its ABSENCE proves nothing, because
 * tmux repaints partially and the whole line reaches the PTY only occasionally
 * (see `session-activity.ts` for what carries the idle decision instead).
 */
export const CLAUDE_WORKING_LINE_PATTERN = /…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b|esc to interrupt/;

export const SAFE_PATH_PATTERN = /^[\p{L}\p{N}_/\-. ~]+$/u;

/**
 * Execute a global regex pattern against data, calling the callback for each match.
 * Automatically resets lastIndex before execution.
 */
export function execPattern(pattern: RegExp, data: string, callback: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    callback(match);
  }
}
