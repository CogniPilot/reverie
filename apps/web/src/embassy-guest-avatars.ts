/**
 * @fileoverview Pictures the hosting owner sets for embassy guests, shown in the host's own console only.
 *
 * A picture is keyed by the guest's approved pairing `requestId`, never by the company or identity labels the guest
 * chose (they are neither unique nor the owner's). The image goes through AvatarStore: PNG, JPEG, GIF or WebP by its
 * own magic bytes, at most 256 KB, written atomically with mode 0600. Each version is its own file,
 * `guest-<requestId>-<version>`. A small private inventory file lists, per guest, every version it owns a file for
 * and the one its URL serves.
 *
 * The inventory never loses a file across a failure:
 * - a new version is listed before its file is written, then made current, then older versions are deleted; a
 *   failure at any step leaves every written file listed, and a failed switch leaves the old URL serving the old bytes;
 * - removal deletes every listed version and drops only those whose file is gone, so a failed removal is still listed
 *   and a retry finishes it.
 *
 * Revoking the guest or closing the room deletes the picture (see EmbassyHost). An upload checks the guest with the
 * embassy before it writes, so it carries a lifecycle token taken before that check: revoking that guest or closing
 * the room meanwhile makes the token stale, and the write refuses rather than bring a picture back. A revoke whose
 * guest is not known yet holds a fence for its whole duration instead: no picture is written while it is open, and
 * every token taken before it closes is stale.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { AvatarStore, checkAvatar } from './agent-avatars.js';
import { writePrivate } from './embassy-guest-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Guest = z
  .object({ current: z.number().int().min(0).optional(), owned: z.array(z.number().int().min(0)) })
  .strict();
const Inventory = z.object({ v: z.literal(3), guests: z.record(z.string().regex(UUID), Guest) }).strict();
type Guest = z.infer<typeof Guest>;
type Guests = Record<string, Guest>;

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
  /** Advanced by every close, and when a fence opens and closes. */
  private epoch = 0;
  /** Fences open for revokes whose guest is not known yet; no picture is written while one is. */
  private fences = 0;
  /** Advanced by every revoke, per guest. */
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly store: AvatarStore,
    /** `<console data>/embassy-host/guest-avatars.json`. */
    private readonly mapFile: string,
    private readonly now: () => number = Date.now,
    private readonly writeInventory: (file: string, value: unknown) => Promise<void> = writePrivate
  ) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  private async guests(): Promise<Guests> {
    try {
      return Inventory.parse(JSON.parse(await fs.readFile(this.mapFile, 'utf8'))).guests;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Cannot load embassy guest pictures; refusing to reset them');
    }
  }

  private save(guests: Guests): Promise<void> {
    return this.writeInventory(this.mapFile, { v: 3, guests });
  }

  private check(requestId: string): void {
    if (!UUID.test(requestId)) throw new Error('Invalid guest request id');
  }

  private key(requestId: string, version: number): string {
    return `guest-${requestId}-${version}`;
  }

  /** Every guest's picture URL, by request id. */
  async urls(): Promise<Record<string, string>> {
    return Object.fromEntries(
      Object.entries(await this.guests()).flatMap(([id, { current }]) =>
        current === undefined ? [] : [[id, embassyGuestAvatarUrl(id, current)]]
      )
    );
  }

  /** Take before checking the guest with the embassy; pass to `set` (which checks the id). */
  token(requestId: string): GuestAvatarToken {
    return { requestId, epoch: this.epoch, generation: this.generations.get(requestId) ?? 0 };
  }

  /** Open a fence for a revoke whose guest is not known yet, and return its close: no picture is written until every
   * fence is closed, and every upload token taken before this one closes is stale. Close it when the revoke is done,
   * whether or not it succeeded. */
  fence(): () => void {
    this.epoch += 1;
    this.fences += 1;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.fences -= 1;
      this.epoch += 1;
    };
  }

  /** Store a checked picture for a guest checked under `token`, and return its new URL. Refuses when that guest was
   * revoked, or the room closed, since the token was taken, or while a fence is open. */
  async set(token: GuestAvatarToken, data: unknown): Promise<string> {
    const { requestId } = token;
    this.check(requestId);
    checkAvatar(data);
    return this.locked(async () => {
      if (this.fences > 0 || token.epoch !== this.epoch || token.generation !== (this.generations.get(requestId) ?? 0))
        throw new GuestLifecycleError('The guest was revoked or the room closed while the picture was uploading');
      const guests = await this.guests();
      const entry = guests[requestId] ?? { owned: [] };
      const version = Math.max(this.now(), ...entry.owned.map((owned) => owned + 1));
      const owned = [...entry.owned, version];
      // Listed before its file exists, so no file is ever written that the inventory does not name.
      await this.save({ ...guests, [requestId]: { ...entry, owned } });
      await this.store.put(this.key(requestId, version), data as Buffer);
      // A failed switch leaves the new version owned but not current: the old URL keeps its old bytes.
      await this.save({ ...guests, [requestId]: { current: version, owned } });
      // Older versions go best-effort; one whose file cannot be deleted stays owned, for the next removal.
      const kept = [version];
      for (const old of entry.owned) await this.store.remove(this.key(requestId, old)).catch(() => kept.push(old));
      await this.save({ ...guests, [requestId]: { current: version, owned: kept } }).catch(() => {});
      return embassyGuestAvatarUrl(requestId, version);
    });
  }

  /** Revoke a guest: later writes under an earlier token refuse, and its picture is deleted. True when it had one. */
  async revoke(requestId: string): Promise<boolean> {
    this.check(requestId);
    this.generations.set(requestId, (this.generations.get(requestId) ?? 0) + 1);
    return this.remove(requestId);
  }

  /** Delete every file a guest owns. Returns what stays listed (the versions whose file could not be deleted, still
   * current if its file is among them), if anything, with the first failure. */
  private async purge(requestId: string, entry: Guest): Promise<{ left?: Guest; failure?: unknown }> {
    const owned: number[] = [];
    let failure: unknown;
    for (const version of entry.owned) {
      try {
        await this.store.remove(this.key(requestId, version));
      } catch (error) {
        owned.push(version);
        failure ??= error;
      }
    }
    if (owned.length === 0) return {};
    const current = entry.current !== undefined && owned.includes(entry.current) ? entry.current : undefined;
    return { left: current === undefined ? { owned } : { current, owned }, failure };
  }

  /** Delete a guest's picture and every older file it owns; true when it had a picture. A file that could not be
   * deleted stays listed, so a retry finishes it, and the call fails. */
  async remove(requestId: string): Promise<boolean> {
    this.check(requestId);
    return this.locked(async () => {
      const guests = await this.guests();
      const entry = guests[requestId];
      if (!entry) return false;
      const { left, failure } = await this.purge(requestId, entry);
      const { [requestId]: _removed, ...rest } = guests;
      await this.save(left ? { ...rest, [requestId]: left } : rest);
      if (failure !== undefined) throw failure;
      return entry.current !== undefined;
    });
  }

  /** Close the room: later writes under any earlier token refuse, and every file is deleted. Returns how many
   * pictures were deleted. A file that could not be deleted stays listed, so a retry finishes it, and the call fails. */
  async removeAll(): Promise<number> {
    this.epoch += 1;
    return this.locked(async () => {
      const guests = await this.guests();
      const kept: Guests = {};
      let removed = 0;
      let failure: unknown;
      for (const [id, entry] of Object.entries(guests)) {
        const { left, failure: failed } = await this.purge(id, entry);
        if (left) kept[id] = left;
        failure ??= failed;
        if (entry.current !== undefined && left?.current === undefined) removed += 1;
      }
      if (Object.keys(guests).length > 0) await this.save(kept);
      if (failure !== undefined) throw failure;
      return removed;
    });
  }

  /** A guest's stored picture: only the version the map names. */
  async get(requestId: string): Promise<{ data: Buffer; type: string } | undefined> {
    if (!UUID.test(requestId)) return undefined;
    const version = (await this.guests())[requestId]?.current;
    return version === undefined ? undefined : this.store.get(this.key(requestId, version));
  }
}
