import { expect, it } from 'vitest';
import { OwnedProcessError, runOwnedProcess } from '../scripts/lib/owned-process.js';

it('drains stdout and stderr beyond pipe capacity before child exit', async () => {
  const result = await runOwnedProcess(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('y'.repeat(2*1024*1024));"],
    { timeout: 5000, outputLimit: 3 * 1024 * 1024 }
  );
  expect(result.stdout.length).toBe(2 * 1024 * 1024);
  expect(result.stderr.length).toBe(2 * 1024 * 1024);
});
it('retains a non-success outcome when output exceeds the bounded capture', async () => {
  const start = Date.now();
  await expect(
    runOwnedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(2*1024*1024));"], {
      timeout: 5000,
      outputLimit: 4096,
    })
  ).rejects.toThrow('output limit');
  expect(Date.now() - start).toBeLessThan(3000);
});
it('bounds exited-parent descendants holding inherited output pipes', async () => {
  const start = Date.now();
  const error = await runOwnedProcess(
    process.execPath,
    [
      '-e',
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});process.exit(0);",
    ],
    { timeout: 200 }
  ).catch((error) => error as unknown);
  expect(error).toBeInstanceOf(OwnedProcessError);
  expect(error).toHaveProperty('message', expect.stringContaining('deadline'));
  expect(Date.now() - start).toBeLessThan(3000);
});
it('returns a nonzero allowed exit only after child and pipes have settled', async () => {
  const result = await runOwnedProcess(process.execPath, ['-e', 'process.exitCode=1'], { allowed: [0, 1] });
  expect(result.code).toBe(1);
});
