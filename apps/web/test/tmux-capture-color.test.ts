import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tmux styled pane capture', () => {
  it('requests SGR style escapes for canonical browser replay frames', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');
    const captureMethod = source.indexOf('capturePaneBuffer(muxName: string');
    const captureCommand = source.indexOf("'capture-pane', '-p', '-e'", captureMethod);

    expect(captureMethod).toBeGreaterThan(-1);
    expect(captureCommand).toBeGreaterThan(captureMethod);
  });
});
