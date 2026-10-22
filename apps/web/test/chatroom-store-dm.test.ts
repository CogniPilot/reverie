/**
 * Chatroom store: direct messages (two-participant rooms), per-kind limits, the
 * user's read cursor and unread counts, and loading rooms saved before these fields.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatroomStore,
  MAX_DMS,
  MAX_DM_PARTICIPANTS,
  MAX_ROOMS,
  dmPeer,
  isDm,
  loadChatrooms,
  messageRecipients,
  saveChatrooms,
  unreadFor,
  type ChatRoom,
} from '../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000046';
const B = '00000038-0043-4000-8000-00000000005f';
const C = '0000003e-004c-4000-8000-00000000006d';
const agent = (sessionId: string) => ({ kind: 'agent' as const, sessionId, name: sessionId.slice(0, 1) });
const user = { kind: 'user' as const, name: 'USER' };

describe('direct messages', () => {
  it('opens one DM per pair, in either order, with the sessions as members', () => {
    const store = new ChatroomStore();
    const { room, created } = store.openDm([B, A], undefined, { now: 10 });
    expect(created).toBe(true);
    expect(isDm(room)).toBe(true);
    expect(room.dm).toEqual([A, B]);
    expect(room.name).toBe('');
    expect(room.members.map((m) => m.sessionId)).toEqual([A, B]);
    expect(store.openDm([A, B], undefined, { now: 20 })).toEqual({ room, created: false });
    expect(store.findDm(B, A)).toBe(room);

    const withUser = store.openDm(['user', C], undefined).room;
    expect(withUser.dm).toEqual([C, 'user'].sort());
    expect(withUser.members.map((m) => m.sessionId)).toEqual([C]);
    expect(dmPeer(withUser, 'user')).toBe(C);
    expect(dmPeer(withUser, C)).toBe('user');
    expect(() => store.openDm([A, A], undefined)).toThrow(/two different/);
  });

  it('refuses a coordinator, a third member and a rename', () => {
    const store = new ChatroomStore();
    const { room } = store.openDm([A, B], undefined);
    expect(() => store.setCoordinator(room.id, A)).toThrow(/no coordinator/);
    expect(() => store.addMember(room.id, A, { role: 'coordinator' })).toThrow(/no coordinator/);
    expect(() => store.addMember(room.id, C)).toThrow(/stays between those two/);
    expect(() => store.rename(room.id, 'x')).toThrow(/cannot be renamed/);
    expect(() => store.place(room.id, { category: 'x' })).toThrow(/no workspace/);
    expect(() => store.archive(room.id, true)).toThrow(/cannot be archived/);
    // A participant can still update its own synopsis or voice flag there.
    expect(store.addMember(room.id, A, { voice: true }).added).toBe(false);
    expect(store.setCoordinator(room.id, null)).toBeUndefined();
  });

  it('delivers to the other participant and stops once one has left', () => {
    const store = new ChatroomStore();
    const { room } = store.openDm([A, B], undefined);
    const m = store.post(room.id, agent(A), 'hi');
    expect(messageRecipients(room, m)).toEqual([B]);
    expect(() => store.post(room.id, agent(C), 'intruding')).toThrow(/Only its participants/);
    // The user reads and may post into any DM.
    expect(messageRecipients(room, store.post(room.id, user, 'both of you'))).toEqual([A, B]);
    store.removeMember(room.id, B);
    expect(() => store.post(room.id, agent(A), 'anyone?')).toThrow(/has left/);
    expect(store.post(room.id, { kind: 'system', name: 'SYSTEM' }, 'B left').text).toBe('B left');
  });

  it('counts rooms and DMs against their own limits', () => {
    const store = new ChatroomStore();
    for (let i = 0; i < MAX_ROOMS; i++) store.create(`r${i}`, undefined);
    expect(() => store.create('one more', undefined)).toThrow(/At most/);
    expect(store.openDm([A, B], undefined).created).toBe(true);
    for (let i = 1; i < MAX_DMS; i++) store.openDm(['user', `s-${i}`], undefined);
    expect(() => store.openDm(['user', 's-extra'], undefined)).toThrow(/direct messages/);
  });
});

describe('group direct messages', () => {
  it('starts a new group every time, takes participants, names and leaving', () => {
    const store = new ChatroomStore();
    const g1 = store.openDm(['user', A, B], undefined, { name: '  planning  ' }).room;
    const g2 = store.openDm([B, 'user', A], undefined).room;
    expect(g1.id).not.toBe(g2.id);
    expect(g1).toMatchObject({ kind: 'dm', dm: [A, B, 'user'].sort(), name: 'planning' });
    expect(g2.name).toBe('');
    expect(store.addMember(g1.id, C).added).toBe(true);
    expect(g1.dm).toEqual([A, B, C, 'user'].sort());
    expect(store.rename(g1.id, '').name).toBe('');
    // One leaves: the group goes on without them.
    store.removeMember(g1.id, A);
    expect(g1.dm).toEqual([B, C, 'user'].sort());
    expect(messageRecipients(g1, store.post(g1.id, agent(B), 'still here'))).toEqual([C]);
    expect(() => store.post(g1.id, agent(A), 'back?')).toThrow(/Only its participants/);
    expect(() => store.setCoordinator(g1.id, B)).toThrow(/no coordinator/);
  });

  it('caps a group at MAX_DM_PARTICIPANTS', () => {
    const store = new ChatroomStore();
    const ids = Array.from({ length: MAX_DM_PARTICIPANTS }, (_, i) => `s-${i}`);
    const g = store.openDm(ids, undefined).room;
    expect(() => store.addMember(g.id, 'one-more')).toThrow(/at most/);
    expect(() => store.openDm([...ids, 'x'], undefined)).toThrow(/at most/);
  });
});

describe('workspaces, categories and archiving', () => {
  it('places rooms and archives them read-only', () => {
    const store = new ChatroomStore();
    const room = store.create('slam', undefined, 0, { workspace: 'rumoca', category: ' Working Groups ' });
    expect(room).toMatchObject({ workspace: 'rumoca', category: 'Working Groups' });
    store.place(room.id, { category: '' });
    expect(room.category).toBeUndefined();
    expect(room.workspace).toBe('rumoca');
    store.addMember(room.id, A);
    store.archive(room.id, true, 50);
    expect(room.archivedAt).toBe(50);
    expect(() => store.post(room.id, agent(A), 'hi')).toThrow(/archived/);
    expect(() => store.addMember(room.id, B)).toThrow(/archived/);
    expect(store.post(room.id, { kind: 'system', name: 'SYSTEM' }, 'archived').text).toBe('archived');
    store.archive(room.id, false);
    expect(room.archivedAt).toBeUndefined();
    expect(store.post(room.id, agent(A), 'hi again').text).toBe('hi again');
  });
});

describe('read cursor and unread counts', () => {
  it('counts agent messages after the cursor; mentions are those for the user', () => {
    const store = new ChatroomStore();
    const room = store.create('Reverie', undefined, 0);
    store.addMember(room.id, A, {}, 0);
    store.post(room.id, agent(A), 'to all', 'all', 10);
    store.post(room.id, agent(A), 'to you', ['user'], 20);
    store.post(room.id, user, 'mine', 'all', 30);
    store.post(room.id, { kind: 'system', name: 'SYSTEM' }, 'joined', 'all', 40);
    expect(unreadFor(room)).toEqual({ unread: 2, mentions: 1 });
    expect(store.markRead(room.id, 15)).toBe(15);
    expect(unreadFor(room)).toEqual({ unread: 1, mentions: 1 });
    expect(store.markRead(room.id, 5)).toBe(15); // never back
    store.markRead(room.id, 40);
    expect(unreadFor(room)).toEqual({ unread: 0, mentions: 0 });
  });

  it('every agent message in a DM with the user is a mention; agent-to-agent DMs only bold', () => {
    const store = new ChatroomStore();
    const mine = store.openDm(['user', A], undefined, { now: 0 }).room;
    store.post(mine.id, agent(A), 'psst', 'all', 5);
    expect(unreadFor(mine)).toEqual({ unread: 1, mentions: 1 });
    const theirs = store.openDm([A, B], undefined, { now: 0 }).room;
    store.post(theirs.id, agent(A), 'between us', 'all', 5);
    expect(unreadFor(theirs)).toEqual({ unread: 1, mentions: 0 });
  });

  it('loads rooms saved before DMs and cursors, read up to their newest message', async () => {
    const legacy = {
      id: 'r1',
      name: 'Reverie',
      createdAt: 1,
      members: [],
      messages: [{ id: 'm', roomId: 'r1', at: 99, from: agent(A), to: ['user'], text: 'old' }],
    };
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-dm-')), 'chatrooms.json');
    await saveChatrooms(file, [legacy as unknown as ChatRoom]);
    const store = new ChatroomStore(await loadChatrooms(file));
    const room = store.require('r1');
    expect(isDm(room)).toBe(false);
    expect(room.userReadAt).toBe(99);
    expect(unreadFor(room)).toEqual({ unread: 0, mentions: 0 });

    // A DM round-trips through the file with its participants and cursor.
    const { room: dm } = store.openDm(['user', A], undefined, { now: 200 });
    await saveChatrooms(file, store.toJSON());
    const again = new ChatroomStore(await loadChatrooms(file)).require(dm.id);
    expect(again).toMatchObject({ kind: 'dm', dm: [A, 'user'].sort(), userReadAt: 200, name: '' });
  });
});
