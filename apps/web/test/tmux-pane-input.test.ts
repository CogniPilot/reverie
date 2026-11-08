/**
 * @fileoverview paneSendKeysArgs: how keystrokes typed in the teammate terminal reach a tmux pane.
 *
 * A terminal sends one chunk per keystroke (or per paste). Text goes in literally, spaces included;
 * each carriage return is its own Enter, in order; line feeds are dropped.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { paneSendKeysArgs } from '../src/tmux-manager.js';
import { MAX_INPUT_LENGTH, MAX_TEAMMATE_INPUT_ENTERS } from '../src/config/terminal-limits.js';

describe('paneSendKeysArgs', () => {
  it('sends a single typed character, including a space, literally', () => {
    expect(paneSendKeysArgs('a')).toEqual(["-l 'a'"]);
    expect(paneSendKeysArgs(' ')).toEqual(["-l ' '"]);
  });

  it('sends Enter alone for a carriage return', () => {
    expect(paneSendKeysArgs('\r')).toEqual(['Enter']);
  });

  it('keeps text and Enters in the order they were typed', () => {
    expect(paneSendKeysArgs('yes\r')).toEqual(["-l 'yes'", 'Enter']);
    expect(paneSendKeysArgs('\rno ')).toEqual(['Enter', "-l 'no '"]);
    expect(paneSendKeysArgs('a\r\rb')).toEqual(["-l 'a'", 'Enter', 'Enter', "-l 'b'"]);
  });

  it('drops line feeds, so a CRLF paste is one Enter per line', () => {
    expect(paneSendKeysArgs('one\r\ntwo\r\n')).toEqual(["-l 'one'", 'Enter', "-l 'two'", 'Enter']);
    expect(paneSendKeysArgs('\n')).toEqual([]);
  });

  it('refuses an input with too many line breaks whole, so nothing of it is sent', () => {
    // The largest input the route accepts, all carriage returns: 65536 tmux calls if it were planned.
    expect(paneSendKeysArgs('\r'.repeat(MAX_INPUT_LENGTH))).toBeUndefined();
    expect(paneSendKeysArgs('a\r'.repeat(MAX_TEAMMATE_INPUT_ENTERS + 1))).toBeUndefined();
    const most = paneSendKeysArgs('a\r'.repeat(MAX_TEAMMATE_INPUT_ENTERS));
    expect(most).toHaveLength(2 * MAX_TEAMMATE_INPUT_ENTERS);
    // Length alone is not the bound: a long line with no Enter is one call.
    expect(paneSendKeysArgs('x'.repeat(MAX_INPUT_LENGTH))).toHaveLength(1);
  });

  it('quotes text so the shell running tmux sees it as one literal argument', () => {
    expect(paneSendKeysArgs("it's $(x)")).toEqual(["-l 'it'\\''s $(x)'"]);
  });
});
