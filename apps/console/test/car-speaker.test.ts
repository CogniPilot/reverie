/**
 * Car mode shows who is speaking, as on a video call: the avatar and name of the member whose
 * line is being read aloud, of the car's voice member while it answers, or of the member whose
 * spoken-turn answer is playing. Nobody speaking, nothing shown. Read aloud on the car screen
 * drops "Name says:" since the screen already says who it is.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
// The shell loader revalidates assets with fetch as chatroom-ui.js loads: keep it off the network.
vm.runInContext(
  `globalThis.CodemanApp = class {}; globalThis.fetch = () => new Promise(() => {});
   globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
   globalThis.speechSynthesis = { speaking: false, pending: false, speak() {}, cancel() {} };`,
  context,
);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('CodemanApp.prototype', context);
const doc = dom.window.document;
afterAll(() => dom.window.close());

const WORKER = { sessionId: 'worker-id', name: 'Worker', voice: true };
const REVIEWER = { sessionId: 'reviewer-id', name: 'Reviewer', voice: true };

function setup() {
  const screen = doc.createElement('div');
  const speaker = screen.appendChild(doc.createElement('span'));
  speaker.className = 'car-speaker';
  speaker.hidden = true;
  const a = Object.create(Proto);
  a._carScreen = screen;
  a._carVoiceMember = () => WORKER;
  a._chatRoom = { members: [WORKER, REVIEWER], messages: [] };
  const view = () => ({
    shown: !speaker.hidden && speaker.style.display === 'flex',
    name: speaker.querySelector('.car-speaker-name')?.textContent ?? null,
    avatar: !!speaker.querySelector('.chatroom-avatar'),
  });
  return { a, view };
}
const playing = (paused = false) => ({ paused, ended: false });

describe('car mode: who is speaking', () => {
  it('shows nothing while nobody speaks', () => {
    const { a, view } = setup();
    a._renderCarSpeaker();
    expect(view()).toEqual({ shown: false, name: null, avatar: false });
  });

  it("shows the author of the line being read aloud", () => {
    const { a, view } = setup();
    a._readAloud = { current: { item: { text: 'hi', meta: { member: 'reviewer-id' } } } };
    a._renderCarSpeaker();
    expect(view()).toEqual({ shown: true, name: 'Reviewer', avatar: true });
  });

  it("shows the car's voice member while the car speaks its answer", () => {
    const { a, view } = setup();
    a._car = { state: 'speaking' };
    a._renderCarSpeaker();
    expect(view()).toEqual({ shown: true, name: 'Worker', avatar: true });
    a._car = { state: 'listening' };
    a._renderCarSpeaker();
    expect(view().shown).toBe(false);
  });

  it("shows the member whose spoken-turn answer is playing, only while it plays", () => {
    const { a, view } = setup();
    a._chatAudio = playing();
    a._chatAudioFrom = 'reviewer-id';
    a._renderCarSpeaker();
    expect(view()).toEqual({ shown: true, name: 'Reviewer', avatar: true });
    a._chatAudio = playing(true);
    a._renderCarSpeaker();
    expect(view()).toEqual({ shown: false, name: null, avatar: false });
  });

  it('a car line on the chat audio (no member) shows nobody', () => {
    const { a, view } = setup();
    a._chatAudio = playing();
    a._chatAudioFrom = null;
    a._renderCarSpeaker();
    expect(view().shown).toBe(false);
  });

  it('_playChatAudio records whose audio it plays', () => {
    const { a } = setup();
    const audio = { play: () => Promise.resolve(), pause() {}, src: '' };
    a._chatAudio = audio;
    a._chatUrl = (u: string) => u;
    a._chatEls = { voiceStatus: doc.createElement('div') };
    a._playChatAudio('/api/voice/audio/x', 'reviewer-id');
    expect(a._chatAudioFrom).toBe('reviewer-id');
    a._playChatAudio('/api/voice/audio/y');
    expect(a._chatAudioFrom).toBeNull();
  });

  it('a hidden car screen shows nobody', () => {
    const { a, view } = setup();
    a._readAloud = { current: { item: { text: 'hi', meta: { member: 'reviewer-id' } } } };
    a._carScreen.hidden = true;
    a._renderCarSpeaker();
    expect(view().shown).toBe(false);
  });
});

describe('car mode: read aloud without "Name says:"', () => {
  function utterance(carOpen: boolean) {
    const { a } = setup();
    a._carScreen.hidden = !carOpen;
    a._readAloudTeamSynth = () => null;
    const q = a._readAloudQueue();
    return q.deps.createUtterance('Reviewer says: the build is green', { member: 'reviewer-id', text: 'the build is green' });
  }

  it('on the car screen the line is said without the name', () => {
    expect(utterance(true).text).toBe('the build is green');
  });

  it('off the car screen the name stays', () => {
    expect(utterance(false).text).toBe('Reviewer says: the build is green');
  });
});
