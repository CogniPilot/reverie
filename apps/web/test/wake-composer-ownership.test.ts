/**
 * An idle-only write (an agent wake, a capacity retry) presses Enter only while the composer holds exactly its own text, in
 * every harness. Codex already had this; Claude Code did not, so a person typing between the wake text and its Enter had
 * their keys submitted with it.
 */
import { describe, expect, it } from 'vitest';
import { typeAndSubmit } from '../src/submit-settle.js';

const CLAUDE = { glyph: '❯', workingLine: '[Ee]sc to interrupt' };
const WAKE = 'Check your rooms: you have unread messages.';
const claude = (body: string) => [
  '● earlier answer',
  '────────────────────────────────────────────',
  `❯ ${body}`.trimEnd(),
  '────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:0 out:0',
].join('\n');

/** A fake pane: empty before typing, then `afterTyping` until the first Enter, then `afterEnter`. */
function pane(afterTyping: string, afterEnter: string) {
  let typed = false;
  let enters = 0;
  const io = {
    typeText: async () => { typed = true; },
    sendEnter: async () => { enters++; },
    capture: () => (!typed ? claude('') : enters === 0 ? afterTyping : afterEnter),
    sleep: async () => {},
    log: () => {},
  };
  return { io, enters: () => enters };
}

describe('idle-only writes own the Claude Code composer before Enter', () => {
  it('a wake whose text is exactly in the composer is submitted', async () => {
    const p = pane(claude(WAKE), claude(''));
    expect(await typeAndSubmit(p.io, WAKE, CLAUDE, 'wake', true, () => true)).toBe('started');
    expect(p.enters()).toBe(1);
  });

  it('a person typing after the wake text keeps their draft: no Enter is pressed', async () => {
    const p = pane(claude(`${WAKE} and also please look at`), claude(''));
    expect(await typeAndSubmit(p.io, WAKE, CLAUDE, 'wake', true, () => true)).toBe('unverified');
    expect(p.enters()).toBe(0);
  });

  it('the retry Enter also requires the composer to still hold exactly the wake text', async () => {
    let enters = 0;
    let typed = false;
    const io = {
      typeText: async () => { typed = true; },
      sendEnter: async () => { enters++; },
      // Enter is ignored (the composer still shows the wake), then a person adds text before the retry.
      capture: () => (!typed ? claude('') : enters === 0 ? claude(WAKE) : claude(`${WAKE} hold on`)),
      sleep: async () => {},
      log: () => {},
    };
    expect(await typeAndSubmit(io, WAKE, CLAUDE, 'wake', true, () => true)).toBe('unverified');
    expect(enters).toBe(1);
  });

  it('an ordinary (not idle-only) send keeps its old behaviour', async () => {
    const p = pane(claude(`${WAKE} and more`), claude(''));
    // No ownership check for an ordinary send: Enter is pressed as before (outcome reporting is unchanged too).
    expect(await typeAndSubmit(p.io, WAKE, CLAUDE, 'send')).not.toBe('unverified');
    expect(p.enters()).toBeGreaterThanOrEqual(1);
  });
});
