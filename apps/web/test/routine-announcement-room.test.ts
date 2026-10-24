import { describe, expect, it } from 'vitest';
import { routineAnnouncementRoomId } from '../src/config/routine-announcement-room.js';

const room = { id: 'room-office', name: 'Office', owner: undefined };
describe('routine announcement audience resolution', () => {
  it('uses an explicit existing room ID, never its name or array position', () => {
    expect(routineAnnouncementRoomId([room], undefined, room.id)).toBe(room.id);
    expect(routineAnnouncementRoomId([room], undefined, 'Office')).toBeUndefined();
    expect(routineAnnouncementRoomId([room], undefined, undefined)).toBeUndefined();
  });
  it('retains the unique owner-scoped General default only when configuration is absent', () => {
    const general = { ...room, id: 'legacy', name: ' General ' };
    expect(routineAnnouncementRoomId([general], undefined, undefined)).toBe('legacy');
    expect(routineAnnouncementRoomId([general, { ...general, id: 'other' }], undefined, undefined)).toBeUndefined();
    expect(routineAnnouncementRoomId([general, { ...general, owner: 'other' }], undefined, undefined)).toBe('legacy');
  });
  it.each(['', ' ', '../room', 'room\n', 'room\r', 'x'.repeat(101), 'unknown'])(
    'refuses configured%s without General fallback',
    (value) => {
      expect(routineAnnouncementRoomId([{ ...room, name: 'General' }], undefined, value)).toBeUndefined();
    }
  );
  it.each([
    { ...room, kind: 'dm' as const },
    { ...room, archivedAt: 1 },
    { ...room, archivedAt: 0 },
    { ...room, owner: 'other-owner' },
  ])('refuses a DM, archived or other-owner room', (value) => {
    expect(routineAnnouncementRoomId([value], undefined, value.id)).toBeUndefined();
    expect(routineAnnouncementRoomId([{ ...value, name: 'General' }], undefined, undefined)).toBeUndefined();
  });
  it('refuses duplicate IDs and requires exact owner scope even for explicit IDs', () => {
    expect(routineAnnouncementRoomId([room, room], undefined, room.id)).toBeUndefined();
    expect(routineAnnouncementRoomId([{ ...room, owner: 'alice' }], 'bob', room.id)).toBeUndefined();
    expect(routineAnnouncementRoomId([{ ...room, owner: 'alice' }], 'alice', room.id)).toBe(room.id);
  });
});
