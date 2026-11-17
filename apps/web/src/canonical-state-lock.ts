/** Shared kernel-backed lock for canonical application state writers.
 * The retained parent descriptor owns flock after the child exits and until its
 * one consuming close. Native callers may inspect that exact descriptor first. */
import { promises as fs, constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export async function withCanonicalStateLock<T>(
  file: string,
  body: () => Promise<T>,
  inspect?: (handle: FileHandle) => Promise<void>
): Promise<T> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(
    file + '.lock',
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600
  );
  try {
    if (inspect) await inspect(handle);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--wait', '5', '--conflict-exit-code', '75', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        env: { PATH: process.env.PATH },
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(Error('Canonical state transaction lock unavailable; nothing committed'))
      );
    });
    if (inspect) await inspect(handle);
    return await body();
  } finally {
    await handle.close();
  }
}
