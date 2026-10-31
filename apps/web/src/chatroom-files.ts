/**
 * @fileoverview Chatroom attachments and custom emotes, stored under the data dir.
 *
 * Attachments: `<data>/chatroom-files/<roomId>/<fileId>-<safe name>`, indexed per room in
 * `index.json`. Limits: MAX_FILE_BYTES per file, MAX_ROOM_BYTES per room. The stored path
 * is absolute and readable by the agents on this machine, which is how an attachment
 * reaches a member's pane (chatroom-delivery.ts appends the path to the delivered line).
 *
 * Emotes: `<data>/chatroom-emotes/<scope>/<name>.<ext>`, scope `global` or a room id,
 * indexed in `<data>/chatroom-emotes/index.json`. Small images only (MAX_EMOTE_BYTES).
 *
 * Only raster images in INLINE_IMAGE_TYPES, and MP4/QuickTime/WebM video whose bytes really are that container (inlineVideoType), are
 * ever served inline; everything else (SVG and HTML included) is served as a download (see the routes). Writes are tmp+rename
 * and every index write is serialized per store.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sharedAttachmentsRoot } from './shared-attachments.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROOM_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_EMOTE_BYTES = 256 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** An upload no message references is kept this long (a message may still be on its way). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
/** Raster types a browser may show inline; nothing else is ever rendered from the store. */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EMOTE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};
export const EMOTE_NAME = /^[a-z0-9_]{2,32}$/;

export interface ChatFile {
  id: string;
  name: string;
  size: number;
  type: string;
  at: number;
  /** 'user' or the uploading session id. */
  by: string;
  /** File name on disk inside the room directory; empty for a linked file. */
  stored: string;
  /** A linked file: its path on the shared drive. Nothing is copied; it never counts against the room and is never removed. */
  link?: string;
}

export interface ChatEmote {
  name: string;
  /** 'global' or a room id. */
  scope: string;
  type: string;
  file: string;
  at: number;
}

export class ChatFileError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** A display/disk-safe file name: no path parts, no control characters, bounded. */
export function safeFileName(raw: string): string {
  const base = String(raw || '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'file';
}

/** Is this content type shown inline (raster images only)? */
export function isInlineImage(type: string): boolean {
  return INLINE_IMAGE_TYPES.has(type.toLowerCase());
}

/** Top-level atoms a QuickTime file can open on (the same set the session upload check accepts for `.mov`). */
const QUICKTIME_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);

/** Bytes a video player needs before it can show a first frame and a play button. */
export const VIDEO_SNIFF_BYTES = 12;

/**
 * The video type to serve inline for a chat attachment, or null to keep it a download. The uploader declares the type, so
 * it is only trusted when the file starts like that container: an MP4 `ftyp` box, a QuickTime top-level atom (iPhone
 * `.mov` clips open on `ftyp`; older QuickTime files can open on another atom) or the WebM/EBML magic. Movies then play
 * in the chat like Discord's instead of forcing a download. Whether a QuickTime clip decodes is the
 * browser's: Safari plays iPhone HEVC, other browsers may not, and the chat falls back to the download card.
 */
export function inlineVideoType(type: string, head: Uint8Array): string | null {
  const declared = type.toLowerCase();
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (declared === 'video/mp4' && head.length >= 12 && ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (declared === 'video/quicktime' && head.length >= 12 && QUICKTIME_ATOMS.has(ascii(4, 8))) return 'video/quicktime';
  if (declared === 'video/webm' && head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
    return 'video/webm';
  return null;
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, path);
}

export class ChatFileStore {
  private chain: Promise<unknown> = Promise.resolve();

  private readonly maxFile: number;
  private readonly maxRoom: number;

  constructor(
    private readonly root: string,
    limits: { maxFile?: number; maxRoom?: number } = {}
  ) {
    this.maxFile = limits.maxFile ?? MAX_FILE_BYTES;
    this.maxRoom = limits.maxRoom ?? MAX_ROOM_BYTES;
  }

  /** Import legacy uploads once before serving, preserving originals for rollback. */
  async initializeShared(): Promise<void> {
    const shared = sharedAttachmentsRoot();
    if (!shared) return;
    await fs.mkdir(shared, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(shared)).isSymbolicLink()) throw new Error('Shared attachment root may not be a symlink');
    const marker = join(shared, '.reverie-upload-imported');
    try { await fs.access(marker); return; } catch { /* first boot or resumable import */ }
    const legacy = join(this.root, 'chatroom-files');
    let rooms: import('node:fs').Dirent[];
    try { rooms = await fs.readdir(legacy, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      rooms = [];
    }
    for (const entry of rooms) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9-]{1,64}$/.test(entry.name)) continue;
      const source = join(legacy, entry.name), target = this.roomDir(entry.name);
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Shared attachment room may not be a symlink');
      let index: ChatFile[];
      try { index = JSON.parse(await fs.readFile(join(source, 'index.json'), 'utf8')); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!Array.isArray(index)) throw new Error('Invalid legacy upload index');
      for (const file of index) {
        if (basename(file.stored) !== file.stored || !file.stored.startsWith(file.id + '-')) throw new Error('Invalid legacy upload filename');
        const destination = join(target, file.stored);
        try {
          const present = await fs.lstat(destination);
          if (!present.isFile() || present.size !== file.size) throw new Error('Conflicting shared upload');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const original = await fs.lstat(join(source, file.stored));
          if (!original.isFile() || original.size !== file.size) throw new Error('Invalid legacy upload');
          const temporary = destination + '.' + randomUUID() + '.tmp';
          await fs.copyFile(join(source, file.stored), temporary);
          await fs.rename(temporary, destination);
          await fs.chmod(destination, 0o444);
        }
      }
      await writeAtomic(join(target, 'index.json'), JSON.stringify(index));
    }
    await writeAtomic(marker, 'Legacy uploads imported; originals retained for rollback.\n');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  roomDir(roomId: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(roomId)) throw new ChatFileError('Bad room id', 400);
    return join(sharedAttachmentsRoot() ?? join(this.root, 'chatroom-files'), roomId);
  }

  async list(roomId: string): Promise<ChatFile[]> {
    try {
      return JSON.parse(await fs.readFile(join(this.roomDir(roomId), 'index.json'), 'utf8')) as ChatFile[];
    } catch {
      return [];
    }
  }

  async get(roomId: string, fileId: string): Promise<(ChatFile & { path: string }) | undefined> {
    const file = (await this.list(roomId)).find((f) => f.id === fileId);
    return file ? { ...file, path: this.pathOf(roomId, file) } : undefined;
  }

  /** Absolute on-disk path of a stored file (what an agent reads); a linked file's own shared-drive path. */
  pathOf(roomId: string, file: Pick<ChatFile, 'stored' | 'link'>): string {
    return file.link ?? join(this.roomDir(roomId), file.stored);
  }

  add(roomId: string, input: { name: string; type: string; data: Buffer; by: string }): Promise<ChatFile> {
    return this.serial(async () => {
      if (input.data.length === 0) throw new ChatFileError('Empty file', 400);
      if (input.data.length > this.maxFile) {
        throw new ChatFileError(`A file can be at most ${Math.round(this.maxFile / 1024 / 1024)} MB`, 413);
      }
      const dir = this.roomDir(roomId);
      const index = await this.list(roomId);
      const used = index.reduce((n, f) => n + (f.link ? 0 : f.size), 0);
      if (used + input.data.length > this.maxRoom) {
        throw new ChatFileError('This room has used its 2 GB of attachments; delete the room or older files', 413);
      }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const name = safeFileName(input.name);
      const stored = `${id}-${name}`;
      await writeAtomic(join(dir, stored), input.data);
      if (sharedAttachmentsRoot()) await fs.chmod(join(dir, stored), 0o444);
      const file: ChatFile = {
        id,
        name,
        size: input.data.length,
        type: String(input.type || 'application/octet-stream')
          .toLowerCase()
          .slice(0, 100),
        at: Date.now(),
        by: input.by,
        stored,
      };
      index.push(file);
      await writeAtomic(join(dir, 'index.json'), JSON.stringify(index));
      return file;
    });
  }

  /** Record a reference to a checked shared-drive file (chat-linked-files.ts): no copy, no size limit. */
  addLink(roomId: string, input: { path: string; name: string; size: number; type: string; by: string }): Promise<ChatFile> {
    return this.serial(async () => {
      const dir = this.roomDir(roomId);
      const index = await this.list(roomId);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file: ChatFile = {
        id: randomUUID(),
        name: safeFileName(input.name),
        size: input.size,
        type: String(input.type || 'application/octet-stream').toLowerCase().slice(0, 100),
        at: Date.now(),
        by: input.by,
        stored: '',
        link: input.path,
      };
      index.push(file);
      await writeAtomic(join(dir, 'index.json'), JSON.stringify(index));
      return file;
    });
  }

  /** Remove a room's whole attachment folder (the room was deleted). */
  /**
   * A deleted room's attachments are moved aside (not destroyed) so the audit log's copy of the room still has its files;
   * its room-scoped emotes are removed.
   */
  async removeRoom(roomId: string): Promise<void> {
    await this.serial(async () => {
      const dir = this.roomDir(roomId);
      try {
        await fs.mkdir(join(this.root, 'chatroom-files-deleted'), { recursive: true });
        const archive = join(this.root, 'chatroom-files-deleted', `${roomId}-${Date.now()}`);
        try { await fs.rename(dir, archive); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          await fs.cp(dir, archive, { recursive: true, errorOnExist: true, force: false });
          await fs.rm(dir, { recursive: true });
        }
      } catch {
        /* no files for this room */
      }
      const all = await this.emotes();
      const kept = all.filter((e) => e.scope !== roomId);
      if (kept.length !== all.length) {
        await fs.rm(join(this.emoteDir(), roomId), { recursive: true, force: true });
        await writeAtomic(join(this.emoteDir(), 'index.json'), JSON.stringify(kept));
      }
    });
  }

  /**
   * Drop uploads no message references once they are older than `graceMs`: a paste or
   * drop that was cancelled, a send that failed, or a client that uploaded and went away
   * must not hold the room's budget forever. Run before each add.
   */
  pruneUnreferenced(
    roomId: string,
    referenced: Set<string>,
    now = Date.now(),
    graceMs = ORPHAN_GRACE_MS
  ): Promise<number> {
    return this.serial(async () => {
      const dir = this.roomDir(roomId);
      const index = await this.list(roomId);
      const stale = index.filter((f) => !referenced.has(f.id) && now - f.at > graceMs);
      if (!stale.length) return 0;
      // A linked file is only forgotten: its target belongs to the shared drive, not to the room.
      for (const f of stale) if (!f.link) await fs.rm(join(dir, f.stored), { force: true });
      const gone = new Set(stale.map((f) => f.id));
      await writeAtomic(join(dir, 'index.json'), JSON.stringify(index.filter((f) => !gone.has(f.id))));
      return stale.length;
    });
  }

  // ─── Emotes ─────────────────────────────────────────────────────────────────

  private emoteDir(): string {
    return join(this.root, 'chatroom-emotes');
  }

  async emotes(): Promise<ChatEmote[]> {
    try {
      return JSON.parse(await fs.readFile(join(this.emoteDir(), 'index.json'), 'utf8')) as ChatEmote[];
    } catch {
      return [];
    }
  }

  /** Emotes visible in a room: its own first, then global ones not shadowed by them. */
  async emotesFor(roomId: string): Promise<ChatEmote[]> {
    const all = await this.emotes();
    const own = all.filter((e) => e.scope === roomId);
    const names = new Set(own.map((e) => e.name));
    return [...own, ...all.filter((e) => e.scope === 'global' && !names.has(e.name))];
  }

  emotePath(emote: ChatEmote): string {
    return join(this.emoteDir(), emote.file);
  }

  addEmote(input: { name: string; scope: string; type: string; data: Buffer }): Promise<ChatEmote> {
    return this.serial(async () => {
      if (!EMOTE_NAME.test(input.name)) {
        throw new ChatFileError('An emote name is 2-32 lowercase letters, digits or underscores', 400);
      }
      const ext = EMOTE_TYPES[input.type.toLowerCase()];
      if (!ext) throw new ChatFileError('An emote is a PNG, GIF, WebP or JPEG image', 415);
      if (input.data.length === 0 || input.data.length > MAX_EMOTE_BYTES) {
        throw new ChatFileError(`An emote image can be at most ${MAX_EMOTE_BYTES / 1024} KB`, 413);
      }
      if (input.scope !== 'global') this.roomDir(input.scope); // validates the room id
      const dir = join(this.emoteDir(), input.scope);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(input.scope, `${input.name}.${ext}`);
      const all = (await this.emotes()).filter((e) => !(e.name === input.name && e.scope === input.scope));
      for (const old of (await this.emotes()).filter((e) => e.name === input.name && e.scope === input.scope)) {
        await fs.rm(join(this.emoteDir(), old.file), { force: true });
      }
      await writeAtomic(join(this.emoteDir(), file), input.data);
      const emote: ChatEmote = {
        name: input.name,
        scope: input.scope,
        type: input.type.toLowerCase(),
        file,
        at: Date.now(),
      };
      all.push(emote);
      await writeAtomic(join(this.emoteDir(), 'index.json'), JSON.stringify(all));
      return emote;
    });
  }

  removeEmote(name: string, scope: string): Promise<boolean> {
    return this.serial(async () => {
      const all = await this.emotes();
      const hit = all.find((e) => e.name === name && e.scope === scope);
      if (!hit) return false;
      await fs.rm(join(this.emoteDir(), hit.file), { force: true });
      await writeAtomic(join(this.emoteDir(), 'index.json'), JSON.stringify(all.filter((e) => e !== hit)));
      return true;
    });
  }
}
