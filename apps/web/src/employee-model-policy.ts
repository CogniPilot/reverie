/**
 * @fileoverview Pure decisions behind an employee's Claude model (employee-model-service.ts).
 *
 * Everything here reads a captured pane frame or plain values and returns DATA; nothing types, waits or
 * stores. Three questions are answered:
 *
 * - Is this pane safe to type a slash command into right now (`paneRefusesCommand`)? Only an idle
 *   composer that reads empty, with no dialog, menu, first-run screen or running turn on screen.
 * - Does the pane show a PER-MODEL usage limit (`readModelLimit`), and on which surface: Claude's
 *   "What do you want to do?" menu, its "Continuing automatically at … · Esc to cancel" footer, or
 *   only the notice above an idle composer? An account-wide limit (5-hour, weekly) names no model and
 *   is not one: switching models does not lift it.
 * - What should happen next (`planEmployeeModel`): nothing, a switch to the recorded choice, a fallback
 *   off a limited model, or a restore once the stated reset time has passed.
 *
 * Model names: Claude's statusline reports a display name ("Opus 5.5"), a choice is an id
 * ("claude-opus-5-5") or a family alias ("opus"). `modelMatchesDisplay` compares their words.
 *
 * Tests: `test/employee-model-policy.test.ts`.
 *
 * @module employee-model-policy
 */

import { stripAnsi } from './utils/index.js';
import { detectUsageLimitPause } from './usage-limit-patterns.js';
import { paneDialogFooter } from './session-activity.js';
import { composerBody } from './session-submit-verifier.js';

/** Claude model families a per-model limit can name. */
export const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/** After a limit's stated reset time, wait this long before switching back. */
export const RESTORE_BUFFER_MS = 2 * 60_000;
/** A limit that stated no readable reset time is retried for a restore after this long. */
export const UNKNOWN_RESET_RESTORE_MS = 5 * 60 * 60_000;

/**
 * The words that identify a model: lower case, `claude` dropped, a bracketed suffix (`[1m]`) and a
 * trailing date stamp (`20250929`) dropped. `claude-opus-5-5` and `Opus 5.5` both give opus, 5, 5.
 */
export function modelWords(value: string): string[] {
  const words = value
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && word !== 'claude');
  while (words.length > 1 && /^\d{8}$/.test(words[words.length - 1])) words.pop();
  return words;
}

/** The family a model id or display name belongs to, when it names one. */
export function modelFamily(value: string | undefined): string | undefined {
  const first = value ? modelWords(value)[0] : undefined;
  return (MODEL_FAMILIES as readonly string[]).includes(first ?? '') ? first : undefined;
}

/**
 * Does the model the CLI reports (`display`) stand for the requested id or alias? An alias
 * (`opus`) matches any version of its family; a full id matches only its own family and version.
 * Words the display adds after them (`Opus 5.5 (1M context)`) are ignored.
 */
export function modelMatchesDisplay(id: string, display: string | undefined): boolean {
  if (!display) return false;
  const want = modelWords(id);
  const have = modelWords(display);
  return want.length > 0 && have.length >= want.length && want.every((word, i) => have[i] === word);
}

/** The id a plain display name stands for (`Fable 5.2` -> `claude-fable-5-2`), or undefined. */
export function modelIdForDisplay(display: string | undefined): string | undefined {
  const match = /^(fable|opus|sonnet|haiku)\s+(\d+)(?:\.(\d+))?(?:\s*\([^()]*\))?$/i.exec(display?.trim() ?? '');
  if (!match) return undefined;
  return ['claude', match[1].toLowerCase(), match[2], ...(match[3] ? [match[3]] : [])].join('-');
}

/** Non-blank rows of a frame, ANSI removed and right-trimmed. */
function rows(screen: string): string[] {
  return stripAnsi(screen)
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.trim() !== '');
}

const MODEL_LIMIT = /\b(?:hit|reached)\s+your\s+(fable|opus|sonnet|haiku)\s+limit\b/gi;
const LIMIT_MENU = /what do you want to do\?[\s\S]*\bstop and wait for limit to reset\b/i;
const LIMIT_FOOTER = /\bcontinuing automatically at\b[^\n]*\besc to cancel\b/i;

/** Where a per-model limit shows: the choice menu, the auto-continue footer, or only its notice. */
export type ModelLimitSurface = 'menu' | 'footer' | 'notice';

export interface ModelLimitReading {
  /** The limited family, lower case (`fable`). */
  family: string;
  /** Epoch ms of the stated reset, or null when the frame states none that parses. */
  resetAt: number | null;
  surface: ModelLimitSurface;
}

/**
 * Claude's own limit menu or auto-continue footer on screen, whatever limit it is for. Both take
 * keys of their own: nothing may be typed while either shows, and the only key the office ever
 * sends to one is Escape (never a digit or Enter, which could choose usage credits).
 */
export function limitPromptSurface(screen: string | null | undefined): 'menu' | 'footer' | null {
  if (!screen) return null;
  const text = rows(screen).slice(-24).join('\n');
  if (LIMIT_MENU.test(text)) return 'menu';
  if (LIMIT_FOOTER.test(text)) return 'footer';
  return null;
}

/**
 * A per-model limit on this frame (the LAST one named), or null. A frame that names no model
 * (`5-hour limit reached`, `You've hit your limit`) is an account limit and reads null.
 */
export function readModelLimit(screen: string | null | undefined, now: number): ModelLimitReading | null {
  if (!screen) return null;
  const text = rows(screen).join('\n');
  MODEL_LIMIT.lastIndex = 0;
  let family: string | undefined;
  for (const match of text.matchAll(MODEL_LIMIT)) family = match[1].toLowerCase();
  if (!family) return null;
  const reset = detectUsageLimitPause(text, now);
  return { family, resetAt: reset ? reset.resetAt : null, surface: limitPromptSurface(screen) ?? 'notice' };
}

/** Why a slash command may not be typed into this frame now, or null when it may. */
export type PaneRefusal = 'unreadable' | 'limit-prompt' | 'dialog' | 'working' | 'no-composer' | 'composer-not-empty';

const WORKING_FOOTER = /\besc to interrupt\b/i;

/**
 * Whether a slash command may be typed into this frame. Refuses an unreadable frame, a limit
 * menu or footer, any other dialog's key hints, a running turn (`esc to interrupt` in the bottom
 * rows), a screen with no composer (first-run screens, pickers) and a composer holding text.
 *
 * @param glyph the CLI's composer glyph (`capabilities.workDetect.promptGlyph`)
 */
export function paneRefusesCommand(screen: string | null | undefined, glyph: string): PaneRefusal | null {
  if (screen === null || screen === undefined) return 'unreadable';
  if (limitPromptSurface(screen)) return 'limit-prompt';
  if (paneDialogFooter(screen)) return 'dialog';
  if (
    rows(screen)
      .slice(-4)
      .some((row) => WORKING_FOOTER.test(row))
  )
    return 'working';
  const body = composerBody(screen, glyph);
  if (body === undefined) return 'no-composer';
  return body === '' ? null : 'composer-not-empty';
}

/** The model Claude's own reply to `/model` names (`Set model to Opus 5.5 …`), the newest one on screen. */
export function readModelConfirmation(screen: string | null | undefined): string | undefined {
  if (!screen) return undefined;
  let found: string | undefined;
  for (const row of rows(screen)) {
    const match = /\bSet model to (.+?)(?:\s+and saved\b.*|\s*$)/.exec(row);
    if (match) found = match[1].trim();
  }
  return found;
}

/** A switch off a limited model, kept until a restore. */
export interface ModelFallbackRecord {
  /** The model that reached its limit, as the CLI reported it. */
  from?: string;
  /** The family the limit named. */
  family: string;
  /** The model switched to. */
  to: string;
  /** What to switch back to once the limit resets; undefined when nothing could be named. */
  restore?: string;
  /** The stated reset, epoch ms, or null when none could be read. */
  resetAt: number | null;
  /** When the fallback began. */
  at: number;
}

export interface ModelPlanInput {
  /** The recorded choice for this employee, if any. */
  preferred?: string;
  /** A fallback in force, if any. */
  fallback?: ModelFallbackRecord;
  /** The company's fallback model, or null when the owner turned the switch off. */
  fallbackModel: string | null;
  /** What the running CLI reports now, if anything. */
  display?: string;
  /** A per-model limit read off the current frame. */
  limit: ModelLimitReading | null;
  now: number;
}

export type ModelPlan =
  | { kind: 'none'; reason: 'nothing-to-do' | 'model-unknown' | 'fallback-limited' }
  /** Leave a limited model: Escape first when its menu or footer shows, then `/model`, then the nudge. */
  | { kind: 'fallback'; record: ModelFallbackRecord; escape: boolean }
  | { kind: 'switch'; model: string; reason: 'preference' | 'fallback' | 'restore' }
  /** The restore is done (or nothing can be restored): forget the fallback. */
  | { kind: 'clear-fallback'; restored: boolean };

/** When a fallback may be undone. */
export function fallbackRestoreAt(record: ModelFallbackRecord): number {
  return record.resetAt === null ? record.at + UNKNOWN_RESET_RESTORE_MS : record.resetAt + RESTORE_BUFFER_MS;
}

/**
 * The next step for one employee's model. Pure; the caller still checks the pane before typing.
 *
 * A limit is acted on only when the switch is on, the fallback is not the limited family, and the
 * limit is live: its menu or footer is on screen, or the CLI reports the limited family (a notice
 * left in the transcript after a switch is not). A limit on the fallback model itself is left alone.
 */
export function planEmployeeModel(input: ModelPlanInput): ModelPlan {
  const { limit, fallbackModel, display, fallback, preferred, now } = input;
  if (
    limit &&
    fallbackModel &&
    modelFamily(fallbackModel) !== limit.family &&
    !modelMatchesDisplay(fallbackModel, display)
  ) {
    const live = limit.surface !== 'notice' || modelFamily(display) === limit.family;
    if (live && !fallback)
      return {
        kind: 'fallback',
        escape: limit.surface !== 'notice',
        record: {
          ...(display ? { from: display } : {}),
          family: limit.family,
          to: fallbackModel,
          restore: preferred ?? modelIdForDisplay(display) ?? limit.family,
          resetAt: limit.resetAt,
          at: now,
        },
      };
  }
  if (fallback) {
    if (now >= fallbackRestoreAt(fallback)) {
      if (!fallback.restore) return { kind: 'clear-fallback', restored: false };
      if (modelMatchesDisplay(fallback.restore, display)) return { kind: 'clear-fallback', restored: true };
      return { kind: 'switch', model: fallback.restore, reason: 'restore' };
    }
    if (limit && modelFamily(fallback.to) === limit.family) return { kind: 'none', reason: 'fallback-limited' };
    if (!display) return { kind: 'none', reason: 'model-unknown' };
    return modelMatchesDisplay(fallback.to, display)
      ? { kind: 'none', reason: 'nothing-to-do' }
      : { kind: 'switch', model: fallback.to, reason: 'fallback' };
  }
  if (!preferred) return { kind: 'none', reason: 'nothing-to-do' };
  if (!display) return { kind: 'none', reason: 'model-unknown' };
  return modelMatchesDisplay(preferred, display)
    ? { kind: 'none', reason: 'nothing-to-do' }
    : { kind: 'switch', model: preferred, reason: 'preference' };
}

/** The one line typed after a fallback, so the agent's stopped turn resumes. Fixed, trusted text. */
export function fallbackNudge(to: string, family: string, resetText: string | undefined): string {
  return `Reverie: your ${family} usage limit was reached, so you now run on ${to}${resetText ? ` until about ${resetText}` : ''}. Continue where you left off.`;
}
