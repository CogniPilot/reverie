import { isAbsolute, join } from 'node:path';

/** Path budget only; the fixture and Office retain their existing custody checks. */
export function nativeHookCaseDirectory(root: string, index: number): string {
  if (!isAbsolute(root) || !Number.isSafeInteger(index) || index < 0)
    throw new Error('Invalid native hook fixture case selection');
  const directory = join(root, `c${index.toString(36)}`);
  // Linux pathname sockets reserve one byte of sun_path[108] for the terminator.
  if (Buffer.byteLength(join(directory, 'office', 'office.sock')) > 107)
    throw new Error('Native hook fixture root exceeds the Office Unix socket path budget; use a shorter owned TMPDIR');
  return directory;
}
