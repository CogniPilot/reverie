// Route suites emulate the disk with their existing read/write spies.
// The real file transaction is exercised in office-settings-file.test.ts.
import fs from 'node:fs/promises';

export async function readOfficeSettings(path: string) {
  try {
    return { path, raw: await fs.readFile(path, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, raw: undefined };
  }
}

export function replaceOfficeSettings(file: { path: string }, text: string) {
  return fs.writeFile(file.path, text);
}
