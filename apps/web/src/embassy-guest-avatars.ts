/**
 * @fileoverview Pictures the hosting owner sets for embassy guests, shown in the host's own console only.
 *
 * A picture is keyed by the guest's approved pairing `requestId`, never by the company or identity labels the guest
 * chose (they are neither unique nor the owner's). The image goes through AvatarStore as `guest-<requestId>`: PNG,
 * JPEG, GIF or WebP by its own magic bytes, at most 256 KB, written atomically with mode 0600. A small private map
 * file holds each picture's version, so its URL changes whenever the picture does. Revoking the guest or closing the
 * room deletes the picture (see EmbassyHost).
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { AvatarStore, checkAvatar } from './agent-avatars.js';
import { writePrivate } from './embassy-guest-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Versions = z
  .object({ v: z.literal(1), versions: z.record(z.string().regex(UUID), z.number().int().min(0)) })
  .strict();

/** A rendered guest picture reference: only ever a URL of the host route, with its version. */
export const EMBASSY_GUEST_AVATAR_URL = /^\/api\/embassy-host\/guests\/[0-9a-f-]{36}\/avatar\?v=\d{1,16}$/;

export function embassyGuestAvatarUrl(requestId: string, version: number): string {
  return `/api/embassy-host/guests/${requestId}/avatar?v=${version}`;
}

export class EmbassyGuestAvatars {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: AvatarStore,
    /** `<console data>/embassy-host/guest-avatars.json`. */
    private readonly mapFile: string,
    private readonly now: () => number = Date.now
  ) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  private async versions(): Promise<Record<string, number>> {
    try {
      return Versions.parse(JSON.parse(await fs.readFile(this.mapFile, 'utf8'))).versions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Cannot load embassy guest pictures; refusing to reset them');
    }
  }

  private key(requestId: string): string {
    if (!UUID.test(requestId)) throw new Error('Invalid guest request id');
    return `guest-${requestId}`;
  }

  /** Every guest's picture URL, by request id. */
  async urls(): Promise<Record<string, string>> {
    const versions = await this.versions();
    return Object.fromEntries(Object.entries(versions).map(([id, v]) => [id, embassyGuestAvatarUrl(id, v)]));
  }

  /** Store a checked picture for a guest (the caller has checked the guest) and return its new URL. */
  async set(requestId: string, data: unknown): Promise<string> {
    const key = this.key(requestId);
    checkAvatar(data);
    return this.locked(async () => {
      const versions = await this.versions();
      const previous = versions[requestId];
      await this.store.put(key, data as Buffer);
      versions[requestId] = Math.max(this.now(), (previous ?? 0) + 1);
      try {
        await writePrivate(this.mapFile, { v: 1, versions });
      } catch (error) {
        if (previous === undefined) await this.store.remove(key);
        throw error;
      }
      return embassyGuestAvatarUrl(requestId, versions[requestId]);
    });
  }

  /** Delete a guest's picture; true when there was one. */
  async remove(requestId: string): Promise<boolean> {
    const key = this.key(requestId);
    return this.locked(async () => {
      const versions = await this.versions();
      const had = requestId in versions;
      delete versions[requestId];
      if (had) await writePrivate(this.mapFile, { v: 1, versions });
      await this.store.remove(key);
      return had;
    });
  }

  /** Delete every guest's picture (the room closed); returns how many there were. */
  async removeAll(): Promise<number> {
    return this.locked(async () => {
      const ids = Object.keys(await this.versions());
      await writePrivate(this.mapFile, { v: 1, versions: {} });
      for (const id of ids) await this.store.remove(this.key(id));
      return ids.length;
    });
  }

  /** A guest's stored picture, only while the map lists it. */
  async get(requestId: string): Promise<{ data: Buffer; type: string } | undefined> {
    if (!UUID.test(requestId) || !(requestId in (await this.versions()))) return undefined;
    return this.store.get(this.key(requestId));
  }
}
