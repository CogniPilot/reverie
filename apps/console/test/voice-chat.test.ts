/**
 * Voice for every agent: where a mic press goes, what read-aloud says, and the
 * read-aloud queue (one at a time, held while recording, never stalled).
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
const get = (name: string) => vm.runInContext(name, context);
const chatMicRoute = get('chatMicRoute') as (o: {
  toVoiceMember: boolean;
  hasRecognition: boolean;
  hasRecorder: boolean;
}) => string | null;
const readAloudText = get('readAloudText') as (name: string, text: string) => string;
const ReadAloudQueue = get('ReadAloudQueue') as new (deps: unknown) => {
  push(t: string): void;
  mute(on: boolean): void;
  clear(): void;
};

describe('chatMicRoute', () => {
  it('sends the voice member through /turn, everyone else through dictation', () => {
    expect(chatMicRoute({ toVoiceMember: true, hasRecognition: true, hasRecorder: true })).toBe('turn');
    expect(chatMicRoute({ toVoiceMember: false, hasRecognition: true, hasRecorder: true })).toBe('local');
    expect(chatMicRoute({ toVoiceMember: false, hasRecognition: false, hasRecorder: true })).toBe('server');
  });
  it('offers nothing a browser cannot do', () => {
    expect(chatMicRoute({ toVoiceMember: true, hasRecognition: true, hasRecorder: false })).toBeNull();
    expect(chatMicRoute({ toVoiceMember: false, hasRecognition: false, hasRecorder: false })).toBeNull();
  });
});

describe('readAloudText', () => {
  it('names the speaker first', () => {
    expect(readAloudText('orchestrator', 'Build is green.')).toBe('orchestrator says: Build is green.');
  });
  it('announces a long reply instead of reading it', () => {
    expect(readAloudText('slam_web', 'word '.repeat(81))).toBe('Long reply from slam_web, see the panel.');
    expect(readAloudText('x', '   ')).toBe('');
  });
});

function harness() {
  const said: Array<{ text: string; onend?: () => void; onerror?: () => void }> = [];
  const timers: Array<() => void> = [];
  let cancels = 0;
  const q = new ReadAloudQueue({
    synth: { speak: (u: { text: string }) => said.push(u), cancel: () => cancels++ },
    createUtterance: (text: string) => ({ text }),
    setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
    clearTimeout: () => {},
  });
  return { q, said, timers, cancels: () => cancels };
}

describe('ReadAloudQueue', () => {
  it('speaks one item at a time, in order', () => {
    const { q, said } = harness();
    q.push('one');
    q.push('two');
    expect(said.map((u) => u.text)).toEqual(['one']);
    said[0].onend?.();
    expect(said.map((u) => u.text)).toEqual(['one', 'two']);
  });

  it('holds while the mic records and says an interrupted item again afterwards', () => {
    const { q, said, cancels } = harness();
    q.push('first');
    q.mute(true);
    expect(cancels()).toBe(1);
    q.push('second');
    expect(said).toHaveLength(1);
    q.mute(false);
    expect(said.map((u) => u.text)).toEqual(['first', 'first']);
    said[1].onend?.();
    expect(said.at(-1)?.text).toBe('second');
  });

  it('moves on when onend never comes (a stuck synthesizer)', () => {
    const { q, said, timers } = harness();
    q.push('stuck');
    q.push('next');
    timers[0]();
    expect(said.map((u) => u.text)).toEqual(['stuck', 'next']);
  });

  it('clear drops everything', () => {
    const { q, said } = harness();
    q.push('a');
    q.push('b');
    q.clear();
    said[0].onend?.();
    expect(said).toHaveLength(1);
  });
});


describe('cumulative browser speech results', () => {
  const snapshot = (results: unknown[]) => (get('chatSpeechSnapshot') as (r: unknown[]) => { text: string; final: string })(results);
  const result = (text: string, isFinal: boolean) => Object.assign([{ transcript: text }], { isFinal });
  it('rebuilds growing Android finals without stacking every prefix', () => {
    const words = ['can', 'can you', 'can you hear', 'can you hear me', 'can you hear me okay'];
    const results = words.map((text) => result(text, true));
    expect(snapshot(results).text).toBe('can you hear me okay');
    expect(snapshot(results).text).toBe('can you hear me okay');
    expect(snapshot([result('first sentence', true), result('second sentence', false)]).text).toBe('first sentence second sentence');
  });
  it('updates local dictation from real callbacks and submits the snapshot once on end', () => {
    const instances: Recognition[] = [];
    class Recognition {
      onresult!: (event: unknown) => void;
      onend!: () => void;
      constructor() { instances.push(this); }
      start() {}
    }
    const sandbox = vm.createContext({ CodemanApp: class {}, window: { SpeechRecognition: Recognition } });
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), sandbox);
    const app = vm.runInContext('new CodemanApp()', sandbox);
    const posted: string[] = [];
    Object.assign(app, { _setChatRecording() {}, _chatVoiceStatus() {}, _chatToLabel: () => 'everyone', _dictationDone: (text: string) => posted.push(text) });
    app._startLocalDictation();
    const rec = instances[0];
    rec.onresult({ resultIndex: 0, results: [result('can you', true)] });
    rec.onresult({ resultIndex: 0, results: [result('can you', true), result('can you hear me', true)] });
    rec.onend();
    rec.onend();
    expect(posted).toEqual(['can you hear me']);
  });
});

describe('owner-directed room read-aloud', () => {
  const addressed = (message: unknown, names: string[], messages?: unknown[]) => (get('chatReadAloudAddressed') as (m: unknown, n: string[], ms?: unknown[]) => boolean)(message, names, messages);
  it('accepts an exact owner mention in a room-wide reply, not a prefix or unrelated chat', () => {
    expect(addressed({ to: 'all', text: '@James yes, I hear you' }, ['James'])).toBe(true);
    expect(addressed({ to: 'all', text: '@Jameson yes' }, ['James'])).toBe(false);
    expect(addressed({ to: 'all', text: '@everyone hello' }, ['James'])).toBe(false);
    expect(addressed({ to: 'all', text: 'foo@James yes' }, ['James'])).toBe(false);
    expect(addressed({ to: 'all', text: '@Jämeson yes' }, ['Jämes'])).toBe(false);
    expect(addressed({ to: 'all', text: '@A+B yes' }, ['A+B'])).toBe(true);
    expect(addressed({ to: 'all', text: 'build is green' }, ['James'])).toBe(false);
    expect(addressed({ to: ['user'], text: 'yes' }, [])).toBe(true);
  });
  it('accepts an actual reply to an owner spoken message only', () => {
    const original = { id: 'owner-spoken', from: { kind: 'user' }, spoken: true };
    expect(addressed({ to: 'all', replyTo: original.id }, [], [original])).toBe(true);
    expect(addressed({ to: 'all', replyTo: 'missing' }, [], [original])).toBe(false);
    expect(addressed({ to: 'all', replyTo: original.id }, [], [{ ...original, from: { kind: 'agent' } }])).toBe(false);
  });
});


it('speaks an owner-directed broadcast via the actual message callback, not unrelated chatter', () => {
  const proto = vm.runInContext('CodemanApp.prototype', context);
  const said: string[] = [];
  const app = { _voiceSetting: () => true, _chatRoomId: 'voice', _chatOwnerNames: ['James'], _chatRoom: { messages: [] }, _readAloudQueue: () => ({ push: (s: string) => said.push(s) }) };
  const data = { roomId: 'voice', message: { id: 'reply', from: { kind: 'agent', name: 'Burt' }, to: 'all', text: '@James yes, I hear you' } };
  proto._readAloudOnMessage.call(app, data);
  proto._readAloudOnMessage.call(app, { ...data, message: { ...data.message, text: 'unrelated build chat' } });
  proto._readAloudOnMessage.call(app, { ...data, roomId: 'other' });
  expect(said).toEqual(['Burt says: @James yes, I hear you']);
});
