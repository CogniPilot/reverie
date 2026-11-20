import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

type SettingsFile =
  | { path: string; raw: undefined }
  | { path: string; target: string; raw: string; original: BigIntStats };

export async function readOfficeSettings(path: string): Promise<SettingsFile> {
  let target: string;
  try {
    target = await fs.realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, raw: undefined };
    throw error;
  }
  const handle = await fs.open(target, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const original = await handle.stat({ bigint: true });
    if (!original.isFile() || original.nlink !== 1n)
      throw new Error('Atomic settings updates require a regular file with a single hard link.');
    return { path, target, original, raw: await handle.readFile('utf8') };
  } finally {
    await handle.close();
  }
}

/** Publish from the same directory. A failed write leaves the prior contents readable. */
export async function replaceOfficeSettings(file: SettingsFile, text: string): Promise<void> {
  const target = file.raw === undefined ? file.path : file.target;
  const temporary = join(dirname(target), `.reverie-settings-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text);
      if (file.raw !== undefined) {
        const staged = await handle.stat({ bigint: true });
        const { uid, gid, mode } = file.original;
        if (staged.uid !== uid || staged.gid !== gid) await handle.chown(Number(uid), Number(gid));
        await handle.chmod(Number(mode & 0o777n));
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (file.raw === undefined) {
      await fs.link(temporary, target); // Exclusive publication also preserves dangling symlinks.
    } else {
      const now = await fs.stat(file.path, { bigint: true });
      if (
        now.dev !== file.original.dev ||
        now.ino !== file.original.ino ||
        now.ctimeNs !== file.original.ctimeNs ||
        (await fs.realpath(file.path)) !== target
      )
        throw new Error('Settings changed during the update. Read the current settings and try again.');
      await fs.rename(temporary, target);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
