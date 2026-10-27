/**
 * @fileoverview Local output boundary for explicit chat attachment downloads.
 * A new basename only, relative to the process's current directory: no parent
 * resolution, directory creation, server-supplied name, symlink or overwrite.
 * Bytes arrive completely and bounded before this helper is called. Filesystem
 * operations themselves cannot promise cancellation on a stalled kernel mount.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export function chatAttachmentDestinationRefusal(name: string): string | undefined {
  // A deliberately portable filename subset; choose the directory with `cd`.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) || name === '.' || name === '..') {
    return '--output must be a new filename in the current directory (letters, digits, dot, underscore, hyphen; no paths)';
  }
  return undefined;
}

export async function saveChatAttachment(name: string, bytes: Buffer): Promise<void> {
  const refusal = chatAttachmentDestinationRefusal(name);
  if (refusal) throw new Error(refusal);
  const file = await open(
    name,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  // A local write/close failure leaves its exclusively-created file for inspection,
  // never deletes a path that another process might have replaced. No success is
  // reported, and another invocation cannot overwrite the partial file.
}
