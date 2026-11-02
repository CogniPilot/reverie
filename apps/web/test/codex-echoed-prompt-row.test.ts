/**
 * Codex 0.163.0 can draw the user's echoed prompt (bold and faint) at column zero with no transcript row before its live
 * composer (bold only, with the dim placeholder). Composer reads took that pair as ambiguous and returned unknown, so chat to
 * the seat waited. Exactly that styled pair now reads the lower row as the composer; every other variant stays unknown.
 * The fixture is a privacy-reviewed capture with all text replaced by filler (glyph rows 14 and 26, footer row 28).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { composerBody, composerIsEmpty, promptStillInComposer } from '../src/session-submit-verifier.js';
import { typeAndSubmit } from '../src/submit-settle.js';
import { Session } from '../src/session.js';

const FRAME = readFileSync(resolve(import.meta.dirname, 'fixtures/codex-0.163-ambiguous-echo.ansi'), 'utf8');
const ESC = '\x1b';
const ECHO = `${ESC}[1;2m› ${ESC}[0m`;
const COMPOSER = `${ESC}[0;1m›${ESC}[0m `;
const rows = FRAME.split('\n');
/** The fixture with its echo row's or composer row's glyph styling replaced. */
const restyle = (row: 14 | 26, lead: string) => rows.map((line, i) => i === row ? line.replace(row === 14 ? ECHO : COMPOSER, lead) : line).join('\n');
/** The fixture with the composer row's text replaced (styles before the glyph kept). */
const composerText = (text: string) => rows.map((line, i) => i === 26 ? `${COMPOSER}${text}` : line).join('\n');
const CODEX = { glyph: '›', workingLine: 'esc to interrupt' };

describe('Codex echoed prompt above the composer', () => {
  it('reads the reported frame: the composer is the lower row, and it is empty', () => {
    expect(rows[14]!.startsWith(ECHO)).toBe(true);
    expect(rows[26]!.startsWith(COMPOSER)).toBe(true);
    expect(composerBody(FRAME, '›')).toBe('');
    expect(composerIsEmpty(FRAME, '›')).toBe(true);
  });

  it('reads typed text in that composer as text, even when it matches a hint word for word', () => {
    expect(composerBody(composerText('please rerun the suite'), '›')).toBe('please rerun the suite');
    expect(promptStillInComposer(composerText('please rerun the suite'), 'please rerun the suite', '›')).toBe(true);
    // The placeholder is only dropped when it is drawn dim; undimmed it is the person's text.
    const hint = /\x1b\[2m([^\x1b]*)\x1b\[0m/u.exec(rows[26]!)![1]!;
    expect(composerIsEmpty(composerText(hint), '›')).toBe(false);
  });

  it('reads styles as the terminal does: a reset before the glyph clears what came earlier on the row', () => {
    expect(composerIsEmpty(restyle(26, `${ESC}[2;7m${ESC}[0;1m›${ESC}[0m `), '›')).toBe(true);
    expect(composerIsEmpty(restyle(26, `${ESC}[1;2m${ESC}[22;1m›${ESC}[0m `), '›')).toBe(true);
    expect(composerBody(restyle(26, `${ESC}[0;1m${ESC}[2m›${ESC}[0m `), '›')).toBeUndefined();
  });

  it('keeps unknown for any other styling of the echo row', () => {
    for (const lead of [`${ESC}[1m› ${ESC}[0m`, `${ESC}[2m› ${ESC}[0m`, '› ', `${ESC}[1;2;7m› ${ESC}[0m`, `${ESC}[1;2;38;5;8m› ${ESC}[0m`])
      expect(composerBody(restyle(14, lead), '›')).toBeUndefined();
  });

  it('keeps unknown for a composer row drawn disabled, hidden, inverse, coloured, mixed or plain', () => {
    for (const lead of [`${ESC}[0;1;2m›${ESC}[0m `, `${ESC}[2m›${ESC}[0m `, `${ESC}[1;8m›${ESC}[0m `, `${ESC}[1;7m›${ESC}[0m `,
      `${ESC}[1;38;2;2;2;2m›${ESC}[0m `, `${ESC}[1;4m›${ESC}[0m `, '› ', `${ESC}[0m›${ESC}[0m `])
      expect(composerBody(restyle(26, lead), '›')).toBeUndefined();
  });

  it('keeps unknown without styles, without the footer, or with a second footer', () => {
    const plain = FRAME.replace(/\x1b\[[0-9;]*m/gu, '');
    expect(composerBody(plain, '›')).toBeUndefined();
    expect(composerBody(rows.filter((_, i) => i !== 28).join('\n'), '›')).toBeUndefined();
    expect(composerBody([...rows.slice(0, 29), rows[28], ...rows.slice(29)].join('\n'), '›')).toBeUndefined();
  });

  it('still refuses a genuine multiline draft whose own line starts with the glyph', () => {
    const draft = readFileSync(resolve(import.meta.dirname, 'fixtures/codex-0.163-multiline-draft.ansi'), 'utf8');
    expect(composerIsEmpty(draft, '›')).toBe(false);
    const literal = rows.map((line, i) => i === 14 ? `${ESC}[1m› ${ESC}[0mfirst line of a draft` : line).join('\n');
    expect(composerBody(literal, '›')).toBeUndefined();
  });

  it('keeps the empty-composer write fence: types only into that frame, never into a variant', async () => {
    const attempt = async (screen: string) => {
      const typeText = vi.fn(async () => false);
      return { outcome: await typeAndSubmit({ capture: () => screen, typeText, sendEnter: async () => undefined, sleep: async () => {} }, 'next', CODEX, 'chat', true), typed: typeText.mock.calls.length };
    };
    expect(await attempt(FRAME)).toEqual({ outcome: 'not-written', typed: 1 });
    expect(await attempt(restyle(14, `${ESC}[1m› ${ESC}[0m`))).toEqual({ outcome: 'not-written', typed: 0 });
    expect(await attempt(composerText('a person typing'))).toEqual({ outcome: 'not-written', typed: 0 });
  });

  it('lets an actual Session accept chat on the reported frame, and refuses the variants', () => {
    const session = new Session({ workingDir: '/owned/fixture', mode: 'codex' });
    let screen = FRAME;
    Object.assign(session, { _mux: { sendInput: vi.fn(), capturePaneText: () => screen }, _muxSession: { muxName: 'owned-fixture' } });
    expect(session.canAcceptChatInput()).toBe(true);
    for (const variant of [restyle(14, `${ESC}[1m› ${ESC}[0m`), restyle(26, `${ESC}[2m›${ESC}[0m `), composerText('a person typing')]) {
      screen = variant;
      expect(session.canAcceptChatInput()).toBe(false);
    }
  });
});
