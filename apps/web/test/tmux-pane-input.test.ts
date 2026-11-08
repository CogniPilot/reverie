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

  it('quotes text so the shell running tmux sees it as one literal argument', () => {
    expect(paneSendKeysArgs("it's $(x)")).toEqual(["-l 'it'\\''s $(x)'"]);
  });
});
