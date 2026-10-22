/**
 * Car mode: a message addressed to the user that the app does not play aloud (another room open,
 * read aloud off, cleared) or cuts short (audio failed, stopped, no end signal) is reported once,
 * so its author gets a private notice. Played to the end, or outside car mode, nothing is sent.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
vm.runInContext(
  `globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});
   globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
   globalThis.said = [];
   globalThis.speechSynthesis = { speaking: false, pending: false, speak(u) { said.push(u); }, cancel() {} };`,
  context,
);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('ReverieApp.prototype', context);
const said = vm.runInContext('said', context) as Array<{ onend: () => void; onerror: () => void }>;
const doc = dom.window.document;
afterAll(() => dom.window.close());

const WORKER = { sessionId: 'worker-id', name: 'Worker', voice: true };
const REVIEWER = { sessionId: 'reviewer-id', name: 'Reviewer' };

function setup({ car = true, mode = 'mine' } = {}) {
  said.length = 0;
  const screen = doc.createElement('div');
  screen.hidden = !car;
  const a = Object.create(Proto);
  a._carScreen = screen;
  a._carVoiceMember = () => WORKER;
  a._chatRoomId = 'room-1';
  a._chatRoom = { id: 'room-1', kind: 'channel', members: [WORKER, REVIEWER], messages: [] };
  a._chatOwnerNames = ['Owner'];
  a._speakRepliesMode = () => mode;
  a._readAloudTeamSynth = () => null;
  const sent: Array<{ path: string; body: unknown }> = [];
  a._chatApi = (path: string, opts: { body: unknown }) => {
    sent.push({ path, body: opts.body });
    return Promise.resolve({ ok: true });
  };
  return { a, sent };
}
let n = 0;
const msg = (from = REVIEWER, text = '@Owner the build is green', extra = {}) => ({
  id: `m${++n}`,
  from: { kind: 'agent', ...from },
  to: 'all',
  text,
  ...extra,
});
const on = (a: Record<string, (d: unknown) => void>, m: { id: string }, roomId = 'room-1') => a._readAloudOnMessage({ roomId, message: m });

describe('car mode: playback notices', () => {
  it('played to the end: nothing is reported', () => {
    const { a, sent } = setup();
    on(a, msg());
    expect(said).toHaveLength(1);
    said[0].onend();
    expect(sent).toEqual([]);
  });

  it('audio failed: reported once as interrupted', () => {
    const { a, sent } = setup();
    const m = msg();
    on(a, m);
    said[0].onerror();
    expect(sent).toEqual([
      { path: `/api/chatrooms/room-1/messages/${m.id}/playback`, body: { outcome: 'interrupted', reason: 'audio-failed' } },
    ]);
  });

  it('read aloud off in this room: not played', () => {
    const { a, sent } = setup({ mode: 'off' });
    const m = msg();
    on(a, m);
    expect(said).toHaveLength(0);
    expect(sent.map((s) => s.body)).toEqual([{ outcome: 'not-played', reason: 'read-aloud-off' }]);
    on(a, m); // the same message again (echo): still once
    expect(sent).toHaveLength(1);
  });

  it('another room open: not played, reported to that room', () => {
    const { a, sent } = setup();
    const m = msg(REVIEWER, 'for you', { to: ['user'] });
    on(a, m, 'room-2');
    expect(sent).toEqual([
      { path: `/api/chatrooms/room-2/messages/${m.id}/playback`, body: { outcome: 'not-played', reason: 'other-room' } },
    ]);
  });

  it('stopped: the line being said is interrupted, the waiting ones not played', () => {
    const { a, sent } = setup();
    const first = msg();
    const second = msg();
    on(a, first);
    on(a, second);
    a._readAloud.clear();
    expect(sent.map((s) => [s.path.split('/')[5], s.body])).toEqual([
      [first.id, { outcome: 'interrupted', reason: 'stopped' }],
      [second.id, { outcome: 'not-played', reason: 'stopped' }],
    ]);
  });

  it('muting puts the line back to be said again: nothing reported', () => {
    const { a, sent } = setup();
    on(a, msg());
    a._readAloud.mute(true);
    expect(sent).toEqual([]);
  });

  it('not addressed to the user, the car voice member, or outside car mode: nothing reported', () => {
    const { a, sent } = setup({ mode: 'off' });
    on(a, msg(REVIEWER, 'room chatter'));
    on(a, msg(WORKER));
    const off = setup({ car: false, mode: 'off' });
    on(off.a, msg());
    expect(sent).toEqual([]);
    expect(off.sent).toEqual([]);
  });
});
