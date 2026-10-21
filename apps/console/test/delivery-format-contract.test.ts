/**
 * The delivered-line format is a contract with the agent harnesses (cto/plugins parse it to find the room, whether the
 * owner spoke, and whether the turn is a private DM). This renders the canonical cases with the real renderer and
 * compares them to test/fixtures/delivery-lines.json; the harness tests parse the same fixture. Changing the format
 * fails this test until the fixture is regenerated (UPDATE_DELIVERY_FIXTURE=1) and the harness parsers follow.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDeliveryBatch, deliveryRoomName, renderForRecipient } from '../src/chatroom-delivery.js';
import { USER_RECIPIENT } from '../src/chatroom-store.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'delivery-lines.json');
const ME = '0000002d-0035-4000-8000-000000000047';
const PEER = '00000038-0043-4000-8000-000000000060';
const DM_ID = '00000043-0053-4000-8000-00000000007e';
const AT = Date.UTC(2026, 9, 17, 14, 31);

type Room = { id: string; name: string; kind?: 'dm'; dm?: string[]; members: Array<{ sessionId: string; role: string }>; messages: [] };
const room = (id: string, name: string, extra: Partial<Room> = {}): Room => ({
  id, name, members: [{ sessionId: ME, role: 'agent' }, { sessionId: PEER, role: 'agent' }], messages: [], ...extra,
});
const fromUser = { kind: 'user', name: 'owner' } as const;
const fromPeer = { kind: 'agent', name: 'beta', sessionId: PEER } as const;
const msg = (from: object, text: string, to: 'all' | string[] = 'all') => ({ id: 'm-' + text.length, from, text, to, at: AT });
const nameOf = (id: string) => (id === ME ? 'alpha' : id === PEER ? 'beta' : id);

function line(entries: Array<{ r: Room; m: ReturnType<typeof msg> }>): string {
  const pending = entries.map(({ r, m }) => ({
    roomId: r.id, roomName: deliveryRoomName(r), text: renderForRecipient(r as never, m as never, ME, nameOf), at: AT,
  }));
  return buildDeliveryBatch(pending as never).line;
}

function cases() {
  const news = room('r-news', 'news');
  const dm = room(DM_ID, '', { kind: 'dm', dm: [USER_RECIPIENT, ME] });
  const rules = room('r-rules', 'rules');
  return [
    { case: 'owner to the whole room', line: line([{ r: news, m: msg(fromUser, 'headline?') }]),
      expect: { rooms: ['news'], ownerRooms: ['news'], channel: 'work' } },
    { case: 'owner addressed to the agent', line: line([{ r: news, m: msg(fromUser, 'you there?', [ME]) }]),
      expect: { rooms: ['news'], ownerRooms: ['news'], channel: 'work' } },
    { case: 'owner in a direct message', line: line([{ r: dm, m: msg(fromUser, 'a private question') }]),
      expect: { rooms: [DM_ID], ownerRooms: [DM_ID], channel: `private:${DM_ID}` } },
    { case: 'agents only', line: line([{ r: news, m: msg(fromPeer, 'chatter') }]),
      expect: { rooms: ['news'], ownerRooms: [], channel: 'work' } },
    { case: 'two rooms, owner in one', line: line([{ r: news, m: msg(fromPeer, 'fyi') }, { r: rules, m: msg(fromUser, 'a question') }]),
      expect: { rooms: ['news', 'rules'], ownerRooms: ['rules'], channel: 'work' } },
  ];
}

describe('delivered-line format contract', () => {
  it('renders exactly the fixture the harness parsers are tested against', () => {
    const now = cases();
    if (process.env.UPDATE_DELIVERY_FIXTURE === '1') writeFileSync(FIXTURE, JSON.stringify(now, null, 2) + '\n');
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });

  it('names a direct message by its id, never by its shared label', () => {
    const dm = room(DM_ID, '', { kind: 'dm', dm: [USER_RECIPIENT, ME] });
    expect(deliveryRoomName(dm)).toBe(`DM:${DM_ID}`);
    expect(deliveryRoomName(room('r1', 'news'))).toBe('news');
    expect(line([{ r: dm, m: msg(fromUser, 'x') }])).toMatch(new RegExp(`^\\[Reverie chat "DM:${DM_ID}"\\] USER: `));
  });
});
