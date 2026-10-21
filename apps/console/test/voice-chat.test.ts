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
    app._startLocalDictation();
    const repeated = instances[1];
    repeated.onresult({ resultIndex: 0, results: [result('yes', true), result('yes', true)] });
    repeated.onend();
    app._startLocalDictation();
    const shorter = instances[2];
    shorter.onresult({ resultIndex: 0, results: [result('go now', true), result('go', true)] });
    shorter.onend();
    expect(posted).toEqual(['can you hear me', 'yes yes', 'go now go']);
    app._startLocalDictation();
    const growing = instances[3];
    const phrases = ['you', 'you', 'you guys', 'you guys give', 'you guys give me', 'you guys give me an', 'you guys give me an', 'you guys give me an update'];
    const results: unknown[] = [];
    phrases.forEach((text, i) => {
      results.push(result(text, true));
      growing.onresult({ resultIndex: i, results: [...results] });
    });
    growing.onend();
    expect(posted.at(-1)).toBe('you guys give me an update');
    // Repeated/shorter final segments without a later strict extension remain intact.
    expect(snapshot([result('yes', true), result('yes', true)]).text).toBe('yes yes');
    expect(snapshot([result('go now', true), result('go', true)]).text).toBe('go now go');
    expect(snapshot([result('hello', true), result('you', true), result('you', true), result('you guys', true)]).text).toBe('hello you guys');
    expect(snapshot([result('you', true), result('you', true), result('you guys', false)]).text).toBe('you guys');

  });
});

describe('owner-directed room read-aloud', () => {
  const addressed = (message: unknown, names: string[], messages?: unknown[]) => (get('chatReadAloudAddressed') as (m: unknown, n: string[], ms?: unknown[]) => boolean)(message, names, messages);
  it('accepts an exact owner mention in a room-wide reply, not a prefix or unrelated chat', () => {
    expect(addressed({ to: 'all', text: '@Owner yes, I hear you' }, ['Owner'])).toBe(true);
    expect(addressed({ to: 'all', text: '@Jameson yes' }, ['Owner'])).toBe(false);
    expect(addressed({ to: 'all', text: '@everyone hello' }, ['Owner'])).toBe(false);
    expect(addressed({ to: 'all', text: 'foo@Owner yes' }, ['Owner'])).toBe(false);
    expect(addressed({ to: 'all', text: '@Jämeson yes' }, ['Jämes'])).toBe(false);
    expect(addressed({ to: 'all', text: '@A+B yes' }, ['A+B'])).toBe(true);
    expect(addressed({ to: 'all', text: 'build is green' }, ['Owner'])).toBe(false);
    expect(addressed({ to: ['user'], text: 'yes' }, [])).toBe(true);
  });
  it('accepts an actual reply to an owner message, typed or spoken', () => {
    const original = { id: 'owner-spoken', from: { kind: 'user' }, spoken: true };
    expect(addressed({ to: 'all', replyTo: original.id }, [], [original])).toBe(true);
    // Owner 10-20: Worker's linked replies to his typed general messages were never read.
    const typed = { id: 'owner-typed', from: { kind: 'user' } };
    expect(addressed({ to: 'all', replyTo: typed.id }, [], [typed])).toBe(true);
    expect(addressed({ to: 'all', replyTo: 'missing' }, [], [original])).toBe(false);
    expect(addressed({ to: 'all', replyTo: original.id }, [], [{ ...original, from: { kind: 'agent' } }])).toBe(false);
  });
});


it('speaks an owner-directed broadcast via the actual message callback, not unrelated chatter', () => {
  const proto = vm.runInContext('CodemanApp.prototype', context);
  const said: string[] = [];
  const app = { _speakRepliesMode: (id: string) => (id === 'voice' ? 'mine' : 'off'), _chatRoomId: 'voice', _chatOwnerNames: ['Owner'], _chatRoom: { messages: [] }, _readAloudQueue: () => ({ push: (s: string) => said.push(s) }) };
  const data = { roomId: 'voice', message: { id: 'reply', from: { kind: 'agent', name: 'Reviewer' }, to: 'all', text: '@Owner yes, I hear you' } };
  Object.setPrototypeOf(app, proto);
  proto._readAloudOnMessage.call(app, data);
  proto._readAloudOnMessage.call(app, { ...data, message: { ...data.message, text: 'unrelated build chat' } });
  proto._readAloudOnMessage.call(app, { ...data, roomId: 'other' });
  expect(said).toEqual(['Reviewer says: Owner yes, I hear you']);
});

it('leaves only the linked answer of a pending spoken turn out of read-aloud, since the turn plays it', () => {
  const proto = vm.runInContext('CodemanApp.prototype', context);
  const said: string[] = [];
  const asked = { id: 'q1', from: { kind: 'user', name: 'Owner' }, to: ['worker'], text: 'status?', spoken: true };
  const typed = { id: 'q2', from: { kind: 'user', name: 'Owner' }, to: ['worker'], text: 'typed' };
  const app: Record<string, unknown> = { _speakRepliesMode: (id: string) => (id === 'voice' ? 'mine' : 'off'), _chatRoomId: 'voice', _chatOwnerNames: [], _chatRoom: { messages: [asked, typed] }, _readAloudQueue: () => ({ push: (s: string) => said.push(s) }), _chatVoiceTurnFor: 'worker' };
  const from = (sessionId: string, name: string, text: string, replyTo?: string) => ({ roomId: 'voice', message: { id: `${sessionId}-${text}`, from: { kind: 'agent', sessionId, name }, to: ['user'], text, ...(replyTo ? { replyTo } : {}) } });
  Object.setPrototypeOf(app, proto);
  proto._readAloudOnMessage.call(app, from('worker', 'Worker', 'linked', 'q1')); // the turn plays this one
  proto._readAloudOnMessage.call(app, from('worker', 'Worker', 'unlinked')); // an unrelated post is still read
  proto._readAloudOnMessage.call(app, from('worker', 'Worker', 'to typed', 'q2')); // a reply to a typed message is still read
  proto._readAloudOnMessage.call(app, from('reviewer', 'Reviewer', 'linked', 'q1')); // another member naming the id is still read
  app._chatVoiceTurnFor = null;
  proto._readAloudOnMessage.call(app, from('worker', 'Worker', 'late', 'q1')); // a late answer after the turn gave up is read
  expect(said).toEqual(['Worker says: unlinked', 'Worker says: to typed', 'Reviewer says: linked', 'Worker says: late']);
});

// Prefix boundaries reconstructed from two actual posted transcripts, not captured browser result events.
const reportedSpeechCases = [
  {
    "id": "00000034-003f-4000-8000-00000000005b",
    "segments": [
      "you",
      "you",
      "you guys",
      "you guys give",
      "you guys give me",
      "you guys give me an",
      "you guys give me an",
      "you guys give me an",
      "you guys give me an update",
      "you guys give me an update",
      "you guys give me an update",
      "you guys give me an update on",
      "you guys give me an update on",
      "you guys give me an update on the same",
      "you guys give me an update on the same",
      "you guys give me an update on the same weapon",
      "you guys give me an update on the same weapon remote car"
    ],
    "expected": "you guys give me an update on the same weapon remote car"
  },
  {
    "id": "00000006-0006-4000-8000-000000000006",
    "segments": [
      "I meant",
      "I meant",
      "I meant",
      "I meant",
      "I meant",
      "I meant the mocha",
      "I meant the mocha the",
      "I meant the mocha the compiler",
      "I meant the mocha the compiler",
      "I meant the mocha the compiler are",
      "I meant the mocha the compiler are",
      "I meant the mocha the compiler are you",
      "I meant the mocha the compiler are you",
      "I meant the mocha the compiler are you m",
      "I meant the mocha the compiler are you m o",
      "I meant the mocha the compiler are you m o c a"
    ],
    "expected": "I meant the mocha the compiler are you m o c a"
  }
];

it.each(reportedSpeechCases)('Car mode handles reconstructed reported sequence $id', ({ segments, expected }) => {
  const callbacks = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const sent: string[] = [];
  const recognition = {
    start() {}, abort() {},
    onresult: null as null | ((event: unknown) => void),
  };
  const sandbox = vm.createContext({ CodemanApp: class {}, deps: {
    createRecognition: () => recognition,
    send: async (text: string) => { sent.push(text); },
    onState() {}, now: () => 1000,
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; callbacks.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => callbacks.delete(id),
  } });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), sandbox);
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), sandbox);
  const controller = vm.runInContext('new CarModeController(deps)', sandbox);
  controller.start();
  const results: unknown[] = [];
  segments.forEach((transcript, resultIndex) => {
    results.push(Object.assign([{ transcript }], { isFinal: true }));
    recognition.onresult?.({ resultIndex, results: [...results] });
  });
  expect(sent).toEqual([]);
  const grace = [...callbacks.values()].find((timer) => timer.ms === 1500);
  expect(grace).toBeDefined();
  grace!.fn();
  expect(sent).toEqual([expected]);
});


it.each(reportedSpeechCases)('composer handles reconstructed reported sequence $id', ({ segments, expected }) => {
  const instances: object[] = [];
  class Recognition { constructor() { instances.push(this); } start() {} }
  const sandbox = vm.createContext({ CodemanApp: class {}, window: { SpeechRecognition: Recognition } });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), sandbox);
  const app = vm.runInContext('new CodemanApp()', sandbox);
  const sent: string[] = [];
  Object.assign(app, { _setChatRecording() {}, _chatVoiceStatus() {}, _chatToLabel: () => 'everyone', _dictationDone: (text: string) => sent.push(text) });
  app._startLocalDictation();
  const rec = instances[0] as { onresult: (event: unknown) => void; onend: () => void };
  const results: unknown[] = [];
  segments.forEach((transcript, resultIndex) => {
    results.push(Object.assign([{ transcript }], { isFinal: true }));
    rec.onresult({ resultIndex, results: [...results] });
  });
  rec.onend();
  expect(sent).toEqual([expected]);
});
