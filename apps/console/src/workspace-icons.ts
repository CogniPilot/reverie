/**
 * @fileoverview Workspace (server) pictures: `<data>/workspace-icons/<key>.<ext>` plus an index of which workspace each belongs to.
 *
 * A workspace is only a name that channels carry, so its picture is keyed by a hash of the owner and the lowercased name. Like the
 * agent profile images, only PNG, JPEG, GIF and WebP are accepted, by their own bytes, at most 256 KB, written atomically with mode
 * 0600; what a client renders is a versioned URL of this store's route, never an address it chose.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AvatarError, MAX_AVATAR_BYTES, checkAvatar, sniffImage } from './agent-avatars.js';

export { AvatarError as WorkspaceIconError };

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const KEY = /^[0-9a-f]{32}$/;
/** A workspace name: the default workspace is the empty one; otherwise one printable line. */
const MAX_NAME = 60;
/** The most pictures one instance keeps, and the most bytes they may take together: each upload is at most 256 KB. */
export const MAX_ICONS = 200;
export const MAX_ICON_BYTES = 32 * 1024 * 1024;
/** A rendered picture reference. */
export const WORKSPACE_ICON_URL = /^\/api\/workspace-icons\/[0-9a-f]{32}\?v=\d{1,16}$/;

interface IndexEntry {
  owner: string;
  name: string;
  /** Version (ms) of the stored picture, for cache busting. */
  v: number;
  /** Size of the stored picture in bytes (for the total cap). */
  size?: number;
}

export function workspaceIconKey(owner: string | undefined, name: string): string {
  return createHash('sha256').update(`${owner ?? '@single'}\0${name.normalize('NFC').trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

export function checkWorkspaceName(name: unknown): string {
  if (typeof name !== 'string') throw new AvatarError('Name the workspace', 400);
  const clean = name.normalize('NFC').trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (clean.length > MAX_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(clean)) throw new AvatarError('Not a workspace name', 400);
  return clean;
}

export class WorkspaceIconStore {
  /** Writes run one at a time so the index never loses an update. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private file(key: string, ext: string): string {
    if (!KEY.test(key)) throw new AvatarError('Invalid workspace picture', 400);
    return join(this.root, `${key}.${ext}`);
  }

  /**
   * The index of pictures. Only a MISSING file is an empty index: any other read failure (a transient EIO, too many open files)
   * throws, so a failed read can never be mistaken for "nothing stored" and written over the real one. A file that is not valid
   * JSON is set aside (index.json.corrupt-<ms>) rather than overwritten, and the store starts again from an empty index.
   */
  private async readIndex(): Promise<Record<string, IndexEntry>> {
    const file = join(this.root, 'index.json');
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, IndexEntry>;
    } catch {
      /* fall through: not JSON */
    }
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
    return {};
  }

  private async writeIndex(index: Record<string, IndexEntry>): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, 'index.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
    await fs.rename(temporary, target);
  }

  private async removeFiles(key: string): Promise<void> {
    for (const ext of Object.values(EXTENSIONS)) await fs.rm(this.file(key, ext), { force: true });
  }

  /** Store a checked picture for an owner's workspace; returns its URL. */
  put(owner: string | undefined, rawName: string, data: unknown): Promise<string> {
    const name = checkWorkspaceName(rawName);
    const type = checkAvatar(data);
    return this.serial(async () => {
      const key = workspaceIconKey(owner, name);
      const index = await this.readIndex();
      // A new picture must fit under both caps before anything is written; replacing one only has to fit the bytes.
      const entries = Object.values(index);
      if (!index[key] && entries.length >= MAX_ICONS) throw new AvatarError(`At most ${MAX_ICONS} workspace pictures`, 409);
      const others = entries.reduce((n, e) => n + (e.size ?? MAX_AVATAR_BYTES), 0) - (index[key] ? (index[key].size ?? MAX_AVATAR_BYTES) : 0);
      if (others + (data as Buffer).length > MAX_ICON_BYTES) throw new AvatarError('The workspace pictures take too much space together', 413);
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const target = this.file(key, EXTENSIONS[type]);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, data as Buffer, { mode: 0o600 });
      await fs.rename(temporary, target);
      for (const ext of Object.values(EXTENSIONS)) if (ext !== EXTENSIONS[type]) await fs.rm(this.file(key, ext), { force: true });
      const v = Math.max(Date.now(), (index[key]?.v ?? 0) + 1);
      index[key] = { owner: owner ?? '@single', name, v, size: (data as Buffer).length };
      await this.writeIndex(index);
      return `/api/workspace-icons/${key}?v=${v}`;
    });
  }

  remove(owner: string | undefined, rawName: string): Promise<void> {
    const name = checkWorkspaceName(rawName);
    return this.serial(async () => {
      const key = workspaceIconKey(owner, name);
      await this.removeFiles(key);
      const index = await this.readIndex();
      if (index[key]) {
        delete index[key];
        await this.writeIndex(index);
      }
    });
  }

  /**
   * The picture follows a renamed workspace (a name that already has one keeps its own). A rename that only changes the case or
   * spacing keeps the picture and updates the name it is listed under. Returns the new URL, if there was a picture.
   * Order: the new file is written whole (temporary file, then rename), then the index, and only then is the old file removed, so a
   * crash never leaves an index entry without its file.
   */
  rename(owner: string | undefined, rawFrom: string, rawTo: string): Promise<string | undefined> {
    const from = checkWorkspaceName(rawFrom);
    const to = checkWorkspaceName(rawTo);
    return this.serial(async () => {
      const index = await this.readIndex();
      const fromKey = workspaceIconKey(owner, from);
      const toKey = workspaceIconKey(owner, to);
      const entry = index[fromKey];
      if (!entry) return undefined;
      if (fromKey === toKey) {
        if (entry.name === to) return undefined;
        index[fromKey] = { ...entry, name: to };
        await this.writeIndex(index);
        return `/api/workspace-icons/${fromKey}?v=${entry.v}`;
      }
      if (index[toKey]) return undefined;
      const stored = await this.readFile(fromKey);
      if (!stored) return undefined;
      const ext = EXTENSIONS[stored.type];
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const target = this.file(toKey, ext);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, stored.data, { mode: 0o600 });
      await fs.rename(temporary, target);
      for (const other of Object.values(EXTENSIONS)) if (other !== ext) await fs.rm(this.file(toKey, other), { force: true });
      const v = Math.max(Date.now(), entry.v + 1);
      delete index[fromKey];
      index[toKey] = { owner: owner ?? '@single', name: to, v, size: stored.data.length };
      await this.writeIndex(index);
      await this.removeFiles(fromKey);
      return `/api/workspace-icons/${toKey}?v=${v}`;
    });
  }

  /** Workspace name -> picture URL, for one owner. */
  async list(owner: string | undefined): Promise<Record<string, string>> {
    const index = await this.readIndex();
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(index)) {
      if (entry.owner === (owner ?? '@single') && KEY.test(key)) out[entry.name] = `/api/workspace-icons/${key}?v=${entry.v}`;
    }
    return out;
  }

  private async readFile(key: string): Promise<{ data: Buffer; type: string } | undefined> {
    for (const ext of Object.values(EXTENSIONS)) {
      try {
        const data = await fs.readFile(this.file(key, ext));
        const type = sniffImage(data);
        if (type) return { data, type };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return undefined;
  }

  /** The stored picture, only for the owner it belongs to. */
  async get(owner: string | undefined, key: string): Promise<{ data: Buffer; type: string } | undefined> {
    if (!KEY.test(key)) return undefined;
    const entry = (await this.readIndex())[key];
    if (!entry || entry.owner !== (owner ?? '@single')) return undefined;
    return this.readFile(key);
  }
}
