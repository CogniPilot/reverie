/**
 * @fileoverview Agent profile images: `<data>/agent-avatars/<sessionId>.<ext>`, one per session.
 *
 * Only PNG, JPEG, GIF and WebP, at most MAX_AVATAR_BYTES. The type is read from the file's own
 * magic bytes, never from what the uploader declared, so an SVG or HTML file (which could carry
 * script) is refused whatever it claims to be. Files are written atomically with mode 0600. The
 * URL a client renders carries a version (`?v=<ms>`) so a new image is fetched at once while an
 * unchanged one stays cached.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const MAX_AVATAR_BYTES = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
/** A rendered avatar reference: only ever a URL of this route, never a client-chosen address. */
export const AVATAR_URL = /^\/api\/avatars\/[A-Za-z0-9][A-Za-z0-9-]{0,99}\?v=\d{1,16}$/;

export class AvatarError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The image type from its first bytes, or undefined for anything else (SVG, HTML, text...). */
export function sniffImage(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const head = data.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

/** Validate an upload before anything is stored; returns its real type. */
export function checkAvatar(data: unknown): string {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new AvatarError('Send the image as the raw request body', 400);
  if (data.length > MAX_AVATAR_BYTES)
    throw new AvatarError(`A profile image can be at most ${MAX_AVATAR_BYTES / 1024} KB`, 413);
  const type = sniffImage(data);
  if (!type) throw new AvatarError('A profile image is a PNG, JPEG, GIF or WebP file', 415);
  return type;
}

export function avatarUrl(sessionId: string, version: number): string {
  return `/api/avatars/${sessionId}?v=${version}`;
}

export class AvatarStore {
  constructor(private readonly root: string) {}

  private file(sessionId: string, ext: string): string {
    if (!SESSION_ID.test(sessionId)) throw new AvatarError('Invalid session id', 400);
    return join(this.root, `${sessionId}.${ext}`);
  }

  /** Store a checked image for a session, replacing any other format. */
  async put(sessionId: string, data: Buffer): Promise<void> {
    const type = checkAvatar(data);
    const target = this.file(sessionId, EXTENSIONS[type]);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, target);
    for (const ext of Object.values(EXTENSIONS)) {
      if (ext !== EXTENSIONS[type]) await fs.rm(this.file(sessionId, ext), { force: true });
    }
  }

  async remove(sessionId: string): Promise<void> {
    for (const ext of Object.values(EXTENSIONS)) await fs.rm(this.file(sessionId, ext), { force: true });
  }

  /** The stored image of a session, with its type (from the bytes again), or undefined. */
  async get(sessionId: string): Promise<{ data: Buffer; type: string } | undefined> {
    for (const ext of Object.values(EXTENSIONS)) {
      try {
        const data = await fs.readFile(this.file(sessionId, ext));
        const type = sniffImage(data);
        if (type) return { data, type };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return undefined;
  }
}
