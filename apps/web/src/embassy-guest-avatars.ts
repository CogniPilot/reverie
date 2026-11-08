/**
 * @fileoverview Pictures the hosting owner sets for embassy guests, shown in the host's own console only.
 *
 * A picture is keyed by the guest's approved pairing `requestId`, never by the company or identity labels the guest
 * chose (they are neither unique nor the owner's). The image goes through AvatarStore: PNG, JPEG, GIF or WebP by its
 * own magic bytes, at most 256 KB, written atomically with mode 0600. Each version is its own file,
 * `guest-<requestId>-<version>`, and a small private map file names the version each guest's URL serves.
 *
 * Every change keeps the map and the files consistent across a failure:
 * - a new picture is written first, then the map, then the old version is deleted, so a failed map write leaves the
 *   old URL serving the old bytes;
 * - removal deletes files first and drops a guest from the map only once its file is gone, so a failed removal is
 *   still listed and a retry finishes it.
 *
 * Revoking the guest or closing the room deletes the picture (see EmbassyHost). An upload checks the guest with the
 * embassy before it writes, so it carries a lifecycle token taken before that check: revoking that guest or closing
 * the room meanwhile makes the token stale, and the write refuses rather than bring a picture back.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { AvatarStore, checkAvatar } from './agent-avatars.js';
import { writePrivate } from './embassy-guest-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Versions = z
  .object({ v: z.literal(2), versions: z.record(z.string().regex(UUID), z.number().int().min(0)) })
  .strict();

/** A rendered guest picture reference: only ever a URL of the host route, with its version. */
export const EMBASSY_GUEST_AVATAR_URL = /^\/api\/embassy-host\/guests\/[0-9a-f-]{36}\/avatar\?v=\d{1,16}$/;

export function embassyGuestAvatarUrl(requestId: string, version: number): string {
  return `/api/embassy-host/guests/${requestId}/avatar?v=${version}`;
}

/** Thrown when a guest was revoked, or the room closed, between an upload's guest check and its write. */
export class GuestLifecycleError extends Error {}

/** Taken before an upload checks its guest; a revoke of that guest or a close since then makes it stale. */
export interface GuestAvatarToken {
  readonly requestId: string;
  readonly epoch: number;
  readonly generation: number;
}

export class EmbassyGuestAvatars {
  private chain: Promise<unknown> = Promise.resolve();
  /** Advanced by every close. */
  private epoch = 0;
  /** Advanced by every revoke, per guest. */
  private readonly generations = new Map<string, number>();

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

  private check(requestId: string): void {
    if (!UUID.test(requestId)) throw new Error('Invalid guest request id');
  }

  private key(requestId: string, version: number): string {
    return `guest-${requestId}-${version}`;
  }

  /** Every guest's picture URL, by request id. */
  async urls(): Promise<Record<string, string>> {
    const versions = await this.versions();
    return Object.fromEntries(Object.entries(versions).map(([id, v]) => [id, embassyGuestAvatarUrl(id, v)]));
  }

  /** Take before checking the guest with the embassy; pass to `set` (which checks the id). */
  token(requestId: string): GuestAvatarToken {
    return { requestId, epoch: this.epoch, generation: this.generations.get(requestId) ?? 0 };
  }

  /** Make every upload token taken so far stale, without deleting anything: for a revoke whose guest is unknown. */
  fenceAll(): void {
    this.epoch += 1;
  }

  /** Store a checked picture for a guest checked under `token`, and return its new URL. Refuses when that guest was
   * revoked, or the room closed, since the token was taken. */
  async set(token: GuestAvatarToken, data: unknown): Promise<string> {
    const { requestId } = token;
    this.check(requestId);
    checkAvatar(data);
    return this.locked(async () => {
      if (token.epoch !== this.epoch || token.generation !== (this.generations.get(requestId) ?? 0))
        throw new GuestLifecycleError('The guest was revoked or the room closed while the picture was uploading');
      const versions = await this.versions();
      const previous = versions[requestId];
      const version = Math.max(this.now(), (previous ?? 0) + 1);
      await this.store.put(this.key(requestId, version), data as Buffer);
      try {
        await writePrivate(this.mapFile, { v: 2, versions: { ...versions, [requestId]: version } });
      } catch (error) {
        // The map still names the previous version, whose file is untouched: the old URL keeps its old bytes.
        await this.store.remove(this.key(requestId, version));
        throw error;
      }
      if (previous !== undefined) await this.store.remove(this.key(requestId, previous)).catch(() => {});
      return embassyGuestAvatarUrl(requestId, version);
    });
  }

  /** Revoke a guest: later writes under an earlier token refuse, and its picture is deleted. True when it had one. */
  async revoke(requestId: string): Promise<boolean> {
    this.check(requestId);
    this.generations.set(requestId, (this.generations.get(requestId) ?? 0) + 1);
    return this.remove(requestId);
  }

  /** Delete a guest's picture; true when there was one. The file goes first, then the map entry. */
  async remove(requestId: string): Promise<boolean> {
    this.check(requestId);
    return this.locked(async () => {
      const versions = await this.versions();
      if (!(requestId in versions)) return false;
      await this.store.remove(this.key(requestId, versions[requestId]));
      const { [requestId]: _removed, ...rest } = versions;
      await writePrivate(this.mapFile, { v: 2, versions: rest });
      return true;
    });
  }

  /** Close the room: later writes under any earlier token refuse, and every picture is deleted. Returns how many were
   * deleted. A picture whose file could not be deleted stays listed, so a retry finishes it, and the call fails. */
  async removeAll(): Promise<number> {
    this.epoch += 1;
    return this.locked(async () => {
      const versions = await this.versions();
      const kept: Record<string, number> = {};
      let removed = 0;
      let failure: unknown;
      for (const [id, version] of Object.entries(versions)) {
        try {
          await this.store.remove(this.key(id, version));
          removed += 1;
        } catch (error) {
          kept[id] = version;
          failure ??= error;
        }
      }
      if (removed > 0) await writePrivate(this.mapFile, { v: 2, versions: kept });
      if (failure !== undefined) throw failure;
      return removed;
    });
  }

  /** A guest's stored picture: only the version the map names. */
  async get(requestId: string): Promise<{ data: Buffer; type: string } | undefined> {
    if (!UUID.test(requestId)) return undefined;
    const version = (await this.versions())[requestId];
    return version === undefined ? undefined : this.store.get(this.key(requestId, version));
  }
}
