/**
 * @fileoverview childrenSettled (test/helpers/settle-children.ts), which the shared teardown waits on before it
 * removes a test file's temp directories: a child still writing into them must have finished first.
 *
 * Port: N/A (no server needed)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childrenSettled, liveChildren } from './helpers/settle-children.js';

describe('childrenSettled', () => {
  it('has nothing to wait for when no test spawned a child', async () => {
    expect(await childrenSettled(1000)).toEqual([]);
  });

  it('returns only after a child still writing into a directory has finished, so the directory removes cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settle-'));
    // Keeps creating files for a while, then exits: removing the directory meanwhile would race it.
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');let n=0;const t=setInterval(()=>{fs.writeFileSync(${JSON.stringify(dir)}+'/f'+(n++),'x');if(n===20){clearInterval(t);fs.writeFileSync(${JSON.stringify(dir)}+'/done','x');}},10);`,
      ],
      { stdio: 'ignore' }
    );
    expect(liveChildren()).toContain(writer.pid);
    expect(await childrenSettled(10000)).toEqual([]);
    expect(existsSync(join(dir, 'done'))).toBe(true);
    expect(readdirSync(dir)).toHaveLength(21);
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('names a child that outlives the bound', async () => {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      expect(await childrenSettled(100)).toEqual([sleeper.pid]);
    } finally {
      sleeper.kill('SIGKILL');
    }
    expect(await childrenSettled(5000)).toEqual([]);
  });
});
