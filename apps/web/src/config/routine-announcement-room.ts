/** Owner/operator-selected routine audit audience. No room creation or fallback on bad configuration. */
import type { ChatRoom } from '../chatroom-store.js';

type NoticeRoom = Pick<ChatRoom, 'id' | 'name' | 'kind' | 'owner' | 'archivedAt'>;

/** Undefined configuration retains the legacy General audience, scoped to the request owner.
 * An explicitly configured ID must exist uniquely and be active, ordinary and same-owner.
 * Blank/malformed/unknown configuration refuses; it never selects another audience. */
export function routineAnnouncementRoomId(
  rooms: readonly NoticeRoom[],
  owner: string | undefined,
  configuredId: string | undefined
): string | undefined {
  if (configuredId !== undefined && !/^[A-Za-z0-9_.:-]{1,100}$/.test(configuredId)) return undefined;
  if (configuredId?.includes('\n') || configuredId?.includes('\r')) return undefined;
  const matches = rooms.filter((room) =>
    configuredId === undefined
      ? room.owner === owner && room.name.trim().toLowerCase() === 'general'
      : room.id === configuredId
  );
  if (matches.length !== 1) return undefined;
  const room = matches[0]!;
  return room.owner === owner && room.kind !== 'dm' && room.archivedAt === undefined ? room.id : undefined;
}
