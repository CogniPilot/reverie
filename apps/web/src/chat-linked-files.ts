/**
 * Linked files: a chat attachment that is a reference to a file on the shared drive rather than an uploaded copy. The
 * shared drive is mounted at the same path in the website and in laptops, so the reference is the file's own path. Only a
 * regular file under the shared drive root qualifies: no symlink anywhere below the root, no hidden path, nothing the
 * sensitive-path guard blocks. The check runs when the link is made and again each time the file is read, so a file that is
 * later replaced by a symlink, moved out or deleted is refused instead of followed.
 */
import fs from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { sharedWorkspaceRoot } from './shared-attachments.js';
import { isSensitivePath } from './web/sensitive-path.js';

export class LinkedFileError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The type a linked file is shown with; the file route still sniffs images and movies before showing them inline. */
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', log: 'text/plain',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * The checked file behind a shared-drive path: the path as the website and laptops both see it (what is stored and what an
 * agent reads), the real path to open now, its name, current size and type.
 */
export async function checkLinkedFile(path: unknown, root: string | undefined = sharedWorkspaceRoot()): Promise<{ path: string; real: string; name: string; size: number; type: string }> {
  if (!root) throw new LinkedFileError('No shared drive is configured, so files cannot be linked. Attach a copy instead.', 409);
  // eslint-disable-next-line no-control-regex -- a path with control characters is refused, not interpreted.
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path))
    throw new LinkedFileError('Link a file by its absolute path on the shared drive.', 400);
  const configured = resolve(root);
  if (!inside(configured, path))
    throw new LinkedFileError(`Only files on the shared drive (${configured}) can be linked. Attach a copy of a laptop-local file instead.`, 403);
  if (relative(configured, path).split(sep).some((part) => part.startsWith('.')))
    throw new LinkedFileError('Hidden files and folders cannot be linked.', 403);
  let real: string, realRoot: string;
  try {
    [realRoot, real] = await Promise.all([fs.realpath(configured), fs.realpath(path)]);
  } catch {
    throw new LinkedFileError('That file does not exist on the shared drive.', 404);
  }
  // The path as written must be the file itself: a symlink anywhere below the root could point anywhere.
  if (real !== resolve(realRoot, relative(configured, path)) || !inside(realRoot, real))
    throw new LinkedFileError('Symlinks cannot be linked. Link the file itself.', 403);
  if (isSensitivePath(real)) throw new LinkedFileError('Access to this file is blocked.', 403);
  const stat = await fs.lstat(real);
  if (!stat.isFile()) throw new LinkedFileError('Only a file can be linked, not a folder.', 400);
  const ext = real.toLowerCase().split('.').pop() ?? '';
  return { path, real, name: basename(real), size: stat.size, type: Object.hasOwn(TYPES, ext) ? TYPES[ext] : 'application/octet-stream' };
}
