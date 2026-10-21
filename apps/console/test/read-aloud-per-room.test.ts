/**
 * Read aloud is chosen per room (Off, Replies to me, Everyone): turning it on in one room
 * reads nothing from another, leaving a room silences what it queued, and markdown stars
 * are never said aloud ("asterisk").
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost/',
});
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.CodemanApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('CodemanApp.prototype', context);
const carModeSpeakable = vm.runInContext('carModeSpeakable', context) as (t: string) => string;
const doc = dom.window.document;
const storage = dom.window.localStorage;
afterAll(() => dom.window.close());

/** Which rooms have a voice (chat-app.js caSpeaks). Read aloud does not depend on it: 'work' has none. */
let speaking = new Set<string>();
context.caSpeaks = (room: { id: string } | null) => !!room && speaking.has(room.id);

function setup(roomId = 'voice') {
  storage.clear();
  speaking = new Set(['voice', 'voice-2']);
  const a = Object.create(Proto);
  const pushed: unknown[][] = [];
  let clears = 0;
  a._readAloud = { clear: () => void clears++ };
  a._readAloudQueue = () => ({ push: (...args: unknown[]) => pushed.push(args) });
  a._chatRoomId = roomId;
  a._chatRoom = { id: roomId, kind: 'room', members: [], messages: [] };
  a._chatOwnerNames = ['Owner'];
  return { a, pushed, clears: () => clears };
}

const msg = (text: string, roomId = 'voice') => ({
  roomId,
  message: {
    id: `m-${text}`,
    from: { kind: 'agent', name: 'Workspace: Reviewer', sessionId: 'reviewer-id' },
    text,
    mentions: ['user'],
    to: ['user'],
  },
});

describe('speak replies aloud, per room', () => {
  it('is off by default and on only in the room it was turned on in', () => {
    const { a } = setup();
    expect(a._speakRepliesIn('voice')).toBe(false);
    a._setSpeakReplies('voice', true);
    expect(a._speakRepliesIn('voice')).toBe(true);
    expect(a._speakRepliesIn('voice-2')).toBe(false);
    expect(a._speakRepliesIn('')).toBe(false);
    expect(a._speakRepliesIn(null)).toBe(false);
    expect(storage.getItem('codeman:speakReplies:voice')).toBe('1');
  });

  it('the old device-wide setting turns on no room', () => {
    const { a } = setup();
    storage.setItem('codeman:speakReplies', '1');
    expect(a._speakRepliesIn('voice')).toBe(false);
  });

  it('turning it off forgets the room and silences what was queued', () => {
    const { a, clears } = setup();
    a._setSpeakReplies('voice', true);
    expect(clears()).toBe(0);
    a._setSpeakReplies('voice', false);
    expect(a._speakRepliesIn('voice')).toBe(false);
    expect(storage.getItem('codeman:speakReplies:voice')).toBeNull();
    expect(clears()).toBe(1);
    a._setSpeakReplies('', true);
    expect(storage.length).toBe(0);
  });

  it('reads a reply only in a room where it is on', () => {
    const { a, pushed } = setup();
    a._setSpeakReplies('voice-2', true);
    a._readAloudOnMessage(msg('Not here.'));
    expect(pushed).toEqual([]);
    a._setSpeakReplies('voice', true);
    a._readAloudOnMessage(msg('Here.'));
    expect(pushed).toEqual([['Reviewer says: Here.', { room: 'voice', member: 'reviewer-id', text: 'Here.' }]]);
  });

  it('reads in any room it is turned on in, voice member or not', () => {
    const { a, pushed } = setup('work');
    a._readAloudOnMessage(msg('Not yet.', 'work'));
    a._setSpeakReplies('work', true);
    a._readAloudOnMessage(msg('Work room.', 'work'));
    expect(pushed.map((p) => p[0])).toEqual(['Reviewer says: Work room.']);
  });

  it('"Replies to me" skips team chatter; "Everyone" reads it, one post at a time', () => {
    const { a, pushed } = setup();
    const chatter = (text: string) => ({
      roomId: 'voice',
      message: { id: `c-${text}`, from: { kind: 'agent', name: 'Workspace: Coordinator', sessionId: 'coordinator-id' }, text, to: 'all' },
    });
    a._setSpeakReplies('voice', 'mine');
    expect(a._speakRepliesMode('voice')).toBe('mine');
    a._readAloudOnMessage(chatter('@Planner build is green'));
    expect(pushed).toEqual([]);
    a._setSpeakReplies('voice', 'all');
    expect(a._speakRepliesMode('voice')).toBe('all');
    expect(storage.getItem('codeman:speakReplies:voice')).toBe('all');
    a._readAloudOnMessage(chatter('@Planner build is green'));
    a._readAloudOnMessage(msg('And to you.'));
    expect(pushed.map((p) => p[0])).toEqual(['Coordinator says: @Planner build is green', 'Reviewer says: And to you.']);
  });

  it('"Everyone" still reads only agents, and never a voice clip', () => {
    const { a, pushed } = setup();
    a._setSpeakReplies('voice', 'all');
    const base = msg('x').message;
    a._readAloudOnMessage({
      roomId: 'voice',
      message: { ...base, from: { kind: 'user', name: 'Owner' }, text: 'mine' },
    });
    a._readAloudOnMessage({ roomId: 'voice', message: { ...base, voice: { url: '/v' }, text: 'clip' } });
    expect(pushed).toEqual([]);
  });

  it('an unknown mode is off, and so is a stored value it does not know', () => {
    const { a, clears } = setup();
    a._setSpeakReplies('voice', 'all');
    a._setSpeakReplies('voice', 'loud');
    expect(a._speakRepliesMode('voice')).toBe('off');
    expect(clears()).toBe(1);
    storage.setItem('codeman:speakReplies:voice', 'yes');
    expect(a._speakRepliesMode('voice')).toBe('off');
  });

  it('never reads a message from a room that is not open', () => {
    const { a, pushed } = setup();
    a._setSpeakReplies('voice', true);
    a._setSpeakReplies('voice-2', true);
    a._readAloudOnMessage(msg('Elsewhere.', 'voice-2'));
    expect(pushed).toEqual([]);
  });

  it('says no markdown stars', () => {
    const { a, pushed } = setup();
    a._setSpeakReplies('voice', true);
    a._readAloudOnMessage(msg('This is *really* **done**, see `x`.'));
    expect(pushed[0][0]).toBe('Reviewer says: This is really done, see x.');
    expect(carModeSpeakable('* one\n2 * 3 and a lone * star')).not.toContain('*');
    expect(carModeSpeakable('snake_case stays')).toBe('snake_case stays');
  });
});

describe('leaving a room silences its read-aloud', () => {
  function els() {
    const e: Record<string, HTMLElement> = {};
    for (const k of ['select', 'empty', 'members', 'feed', 'composer', 'to'])
      e[k] = doc.createElement(k === 'select' ? 'select' : 'div');
    return e;
  }
  const room = (id: string) => ({ id, kind: 'room', members: [], messages: [] });
  const quietApp = (a: Record<string, unknown>) =>
    Object.assign(a, {
      _chatEls: els(),
      _renderChatMembers() {},
      _renderChatTo() {},
      _renderChatFeed() {},
      _chatSyncedFrom() {},
    });

  it('switching rooms clears the queue; refreshing the same room does not', async () => {
    const { a, clears } = setup();
    quietApp(a);
    await a._applyChatRoom('voice', room('voice'), { quiet: true, switched: false });
    expect(clears()).toBe(0);
    await a._applyChatRoom('voice-2', room('voice-2'), { quiet: false, switched: true });
    expect(clears()).toBe(1);
    expect(a._chatRoomId).toBe('voice-2');
  });
});
