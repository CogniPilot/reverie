/**
 * @fileoverview childrenSettled and tempTeardown (test/helpers/settle-children.ts), which the shared teardown uses
 * before it removes a test file's temp directories: a child still writing into them must have finished first, or be
 * stopped, and one that cannot be stopped keeps them.
 *
 * Port: N/A (no server needed)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TeardownLifecycleError, childrenSettled, liveChildren, tempTeardown } from './helpers/settle-children.js';

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

describe('tempTeardown', () => {
  // Keeps creating files in `dir`, recreating it if it was removed, until it is stopped: a removal under it shows.
  const writer = (dir: string) =>
    `const fs=require('fs');let n=0;setInterval(()=>{fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});fs.writeFileSync(${JSON.stringify(dir)}+'/f'+(n++),'x')},10);`;
  const writeForever = (dir: string) => spawn(process.execPath, ['-e', writer(dir)], { stdio: 'ignore' });
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('stops a child still writing after the bound and removes the directory only once it is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teardown-'));
    const writer = writeForever(dir);
    const warnings: string[] = [];
    await tempTeardown([dir], { waitMs: 100, warn: (message) => warnings.push(message) }).finish();
    expect(warnings).toEqual([`[test setup] stopped child processes still running at teardown: ${writer.pid}`]);
    expect(liveChildren()).toEqual([]);
    await settle(80);
    expect(existsSync(dir)).toBe(false);
  });

  it("stops a child's own children too, so none is left writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teardown-'));
    // A child that starts the writer as its own child, prints its pid, and stays.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const g=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer(dir))}],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const grandchild = Number(await new Promise<string>((resolve) => parent.stdout.once('data', resolve)));
    try {
      const warnings: string[] = [];
      await tempTeardown([dir], { waitMs: 100, warn: (message) => warnings.push(message) }).finish();
      expect(warnings).toEqual([
        `[test setup] stopped child processes still running at teardown: ${grandchild}, ${parent.pid}`,
      ]);
      await settle(80);
      expect(existsSync(dir)).toBe(false);
    } finally {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        // stopped by the teardown
      }
    }
  });

  it('keeps the directories and fails by name when a child cannot be stopped, and the exit backstop keeps them too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teardown-'));
    const writer = writeForever(dir);
    try {
      const teardown = tempTeardown([dir], { waitMs: 100, stopWaitMs: 100, kill: () => {}, warn: () => {} });
      const failure = await teardown.finish().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TeardownLifecycleError);
      expect((failure as Error).message).toBe(
        `[test setup] child processes ${writer.pid} still running; keeping ${dir} rather than delete under them`
      );
      teardown.backstop();
      expect(existsSync(dir)).toBe(true);
    } finally {
      writer.kill('SIGKILL');
    }
    expect(await childrenSettled(5000)).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  it('as the exit backstop, keeps the directories while a child is live and removes them once none is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teardown-'));
    const writer = writeForever(dir);
    const warnings: string[] = [];
    try {
      tempTeardown([dir], { warn: (message) => warnings.push(message) }).backstop();
      expect(existsSync(dir)).toBe(true);
      expect(warnings).toEqual([
        `[test setup] at exit: child processes ${writer.pid} still running; keeping ${dir} rather than delete under them`,
      ]);
    } finally {
      writer.kill('SIGKILL');
    }
    expect(await childrenSettled(5000)).toEqual([]);
    tempTeardown([dir]).backstop();
    expect(existsSync(dir)).toBe(false);
  });
});
