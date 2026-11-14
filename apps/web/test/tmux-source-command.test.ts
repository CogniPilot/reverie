import { describe, expect, it } from 'vitest';
import { MAX_TMUX_ARGUMENT_BYTES, tmuxSourceCommands } from '../src/tmux-source-command.js';
describe('bounded tmux stdin program DATA', () => {
  it('rejects NUL and nonroundtripping UTF-8 before transport', () => {
    expect(() => tmuxSourceCommands([['display-message', 'bad\0argument']])).toThrow('exact UTF-8');
    expect(() => tmuxSourceCommands([['display-message', '\ud800']])).toThrow('exact UTF-8');
  });
  it('bounds arguments, batch bytes and command counts before transport', () => {
    expect(() => tmuxSourceCommands([['x'.repeat(MAX_TMUX_ARGUMENT_BYTES + 1)]])).toThrow('exact UTF-8');
    expect(() => tmuxSourceCommands([Array(65).fill('x')])).toThrow('argument count');
    expect(() => tmuxSourceCommands(Array(17).fill(['x']))).toThrow('command batch');
    expect(() => tmuxSourceCommands([Array(3).fill('x'.repeat(MAX_TMUX_ARGUMENT_BYTES))])).toThrow('batch size');
    expect(() => tmuxSourceCommands([])).toThrow('command batch');
    expect(() => tmuxSourceCommands([[]])).toThrow('argument count');
  });
});
