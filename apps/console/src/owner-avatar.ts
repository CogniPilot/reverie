/**
 * @fileoverview The owner's profile picture, kept on the server so it shows on their messages for everyone.
 *
 * The file lives in an AvatarStore (PNG, JPEG, GIF or WebP by its bytes, at most 256 KB, mode 0600) under a key derived from the
 * owner. The link a page draws is `/api/owner-avatar/<key>?v=<ms>` and sits in the company settings the page already loads
 * (`ownerAvatar`), so nothing is fetched per message: a browser fetches the picture once per version and then revalidates by ETag.
 */
import { createHash } from 'node:crypto';

/** A rendered owner picture reference: only ever a link of this route. */
export const OWNER_AVATAR_URL = /^\/api\/owner-avatar\/[0-9a-f]{32}\?v=\d{1,16}$/;

export function ownerAvatarKey(owner: string | undefined): string {
  return createHash('sha256').update(`owner-avatar\0${owner ?? '@single'}`).digest('hex').slice(0, 32);
}

export function ownerAvatarUrl(owner: string | undefined, version: number): string {
  return `/api/owner-avatar/${ownerAvatarKey(owner)}?v=${version}`;
}
