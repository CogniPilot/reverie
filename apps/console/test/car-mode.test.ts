/**
 * Car mode: the hands-free loop (listen -> send -> speak -> listen) with every browser
 * API faked, plus engine choice and the utterance splitter.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), context);
const get = (name: string) => vm.runInContext(name, context);
const carModeEngine = get('carModeEngine') as (w: unknown) => string;
const carModeUtterances = get('carModeUtterances') as (t: string, max?: number) => string[];
const carModePickVoice = get('carModePickVoice') as (v: unknown[], saved?: string) => { name: string } | null;
const CarModeController = get('CarModeController') as new (deps: unknown) => {
  state: string;
  start(): void;
  stop(): void;
  tap(): void;
  reply(text: string): boolean;
};

class FakeRecognition {
  static all: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  started = false;
  aborted = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    this.started = true;
  }
  abort() {
    this.aborted = true;
  }
  say(text: string, isFinal: boolean) {
    const result = Object.assign([{ transcript: text }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

function harness() {
  FakeRecognition.all = [];
  const spoken: Array<{ text: string; onend?: () => void; onerror?: () => void }> = [];
  const sent: string[] = [];
  const states: Array<[string, string]> = [];
  const timers: Array<() => void> = [];
  // Like the Web Speech API: cancel() fires onerror('interrupted') on every queued utterance.
  const synth = {
    speaking: false,
    pending: false,
    cancels: 0,
    speak: (u: { text: string }) => spoken.push(u),
    cancel: () => {
      synth.cancels++;
      const queued = spoken.splice(0);
      for (const u of queued) u.onerror?.();
    },
  };
  const clock = { now: 1_000_000 };
  const ctl = new CarModeController({
    createRecognition: () => new FakeRecognition(),
    createUtterance: (text: string) => ({ text }),
    synth,
    voice: () => null,
    send: async (text: string) => void sent.push(text),
    onState: (s: string, d: string) => states.push([s, d]),
    setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
    now: () => clock.now,
    clearTimeout: () => {},
  });
  const rec = () => FakeRecognition.all[FakeRecognition.all.length - 1];
  return { ctl, spoken, sent, states, timers, rec, synth, clock };
}

describe('car mode loop', () => {
  it('listens continuously in en-US, sends a final transcript, pauses while she speaks, then listens again', async () => {
    const { ctl, spoken, sent, rec } = harness();
    ctl.start();
    expect(ctl.state).toBe('listening');
    expect(rec()).toMatchObject({ continuous: true, interimResults: true, lang: 'en-US', started: true });
    rec().say('how is the', false);
    expect(sent).toEqual([]);
    const first = rec();
    first.say('how is the build going', true);
    await Promise.resolve();
    expect(sent).toEqual(['how is the build going']);
    expect(ctl.state).toBe('thinking');
    expect(first.aborted).toBe(true); // never transcribes her
    expect(ctl.reply('Still compiling. Patience, friend!')).toBe(true);
    expect(ctl.state).toBe('speaking');
    expect(spoken.map((u) => u.text)).toEqual(['Still compiling.', 'Patience, friend!']);
    spoken[spoken.length - 1].onend?.();
    expect(ctl.state).toBe('listening');
    expect(FakeRecognition.all.length).toBe(2);
    expect(rec().started).toBe(true);
  });

  it('restarts recognition when the browser ends it while listening', () => {
    const { ctl, rec } = harness();
    ctl.start();
    const first = rec();
    first.onend?.();
    expect(FakeRecognition.all.length).toBe(2);
    expect(ctl.state).toBe('listening');
  });

  it('a tap pauses and resumes; a tap while she speaks cuts her off and listens', async () => {
    const { ctl, spoken, rec } = harness();
    ctl.start();
    ctl.tap();
    expect(ctl.state).toBe('paused');
    expect(ctl.reply('ignored while paused')).toBe(false);
    ctl.tap();
    expect(ctl.state).toBe('listening');
    rec().say('tell me a story', true);
    await Promise.resolve();
    ctl.reply('Once upon a time.');
    expect(spoken).toHaveLength(1);
    ctl.tap();
    expect(spoken).toHaveLength(0);
    expect(ctl.state).toBe('listening');
  });

  it('goes back to listening if no reply comes', async () => {
    const { ctl, timers, rec } = harness();
    ctl.start();
    rec().say('hello?', true);
    await new Promise((r) => setImmediate(r));
    expect(ctl.state).toBe('thinking');
    timers[timers.length - 1]();
    expect(ctl.state).toBe('listening');
  });

  it('pauses with a reason when the microphone is refused', () => {
    const { ctl, states, rec } = harness();
    ctl.start();
    rec().onerror?.({ error: 'not-allowed' });
    expect(ctl.state).toBe('paused');
    expect(states[states.length - 1][1]).toContain('refused');
  });

  it('queues a second reply behind the one playing, and listens only after the last', async () => {
    const { ctl, spoken, rec } = harness();
    ctl.start();
    rec().say('what is new', true);
    await Promise.resolve();
    ctl.reply('First answer.');
    const before = FakeRecognition.all.length;
    ctl.reply('Second answer.');
    expect(ctl.state).toBe('speaking');
    expect(spoken.map((u) => u.text)).toEqual(['First answer.', 'Second answer.']);
    spoken[0].onend?.(); // the first batch finishing does not reopen the mic
    expect(ctl.state).toBe('speaking');
    expect(FakeRecognition.all.length).toBe(before);
    spoken[1].onend?.();
    expect(ctl.state).toBe('listening');
  });

  it('keeps the spoken batch referenced until it finishes', async () => {
    const { ctl, rec } = harness();
    ctl.start();
    rec().say('long one', true);
    await Promise.resolve();
    ctl.reply('One. Two. Three.');
    expect((ctl as unknown as { utterances: unknown[] }).utterances).toHaveLength(3);
  });

  it('backs off after a network error instead of restarting in a tight loop', () => {
    const { ctl, timers, rec } = harness();
    ctl.start();
    const first = rec();
    first.onerror?.({ error: 'network' });
    const restartAt = timers.length;
    first.onend?.();
    expect(FakeRecognition.all.length).toBe(1); // waiting, not restarted
    timers[restartAt]();
    expect(FakeRecognition.all.length).toBe(2);
    // Silence is not an error: restart at once.
    rec().onerror?.({ error: 'no-speech' });
    rec().onend?.();
    expect(FakeRecognition.all.length).toBe(3); // restarted at once, no backoff
  });

  it('does not reopen the mic on an early onend while the synthesizer is still speaking', async () => {
    const { ctl, spoken, rec, synth, timers } = harness();
    ctl.start();
    rec().say('tell me everything', true);
    await Promise.resolve();
    ctl.reply('One. Two. Three. Four. Five.');
    expect(spoken).toHaveLength(5);
    const count = FakeRecognition.all.length;
    synth.speaking = true;
    spoken[4].onend?.(); // Android fires it early
    expect(ctl.state).toBe('speaking');
    timers[timers.length - 1](); // poll: still speaking
    expect(ctl.state).toBe('speaking');
    expect(FakeRecognition.all.length).toBe(count);
    synth.speaking = false;
    timers[timers.length - 1](); // poll: quiet now
    expect(ctl.state).toBe('listening');
    expect(FakeRecognition.all.length).toBe(count + 1);
  });

  it('cancels only when something is playing, then speaks a moment later', async () => {
    const { ctl, spoken, rec, synth, timers } = harness();
    ctl.start();
    rec().say('hi', true);
    await Promise.resolve();
    ctl.reply('Idle synth.');
    expect(synth.cancels).toBe(0);
    expect(spoken.map((u) => u.text)).toEqual(['Idle synth.']);
    spoken[0].onend?.(); // the synthesizer is idle, so it listens again at once
    expect(ctl.state).toBe('listening');
    // Something else is playing (another tab, a stale utterance): cancel, then speak after a delay.
    rec().say('again', true);
    await Promise.resolve();
    synth.speaking = true;
    ctl.reply('After cancel.');
    expect(synth.cancels).toBe(1);
    expect(spoken).toHaveLength(0);
    timers[timers.length - 1]();
    expect(spoken.map((u) => u.text)).toEqual(['After cancel.']);
  });

  it('stops listening after 15 s of silence and releases the mic', () => {
    const { ctl, rec, timers, states } = harness();
    ctl.start();
    const r = rec();
    timers[0](); // the no-speech timeout
    expect(ctl.state).toBe('paused');
    expect(states[states.length - 1][1]).toBe('Tap to talk');
    expect(r.aborted).toBe(true);
    ctl.tap();
    expect(ctl.state).toBe('listening');
  });

  it('sends an utterance that never ends at the cap, as heard', async () => {
    const { ctl, rec, sent, clock } = harness();
    ctl.start();
    rec().say('I keep talking and', false);
    clock.now += 31_000;
    rec().say('I keep talking and talking', false);
    await Promise.resolve();
    expect(sent).toEqual(['I keep talking and talking']);
    expect(ctl.state).toBe('thinking');
  });

  it('gives up visibly after repeated recognition failures', () => {
    const { ctl, rec, states } = harness();
    ctl.start();
    for (let i = 0; i < 3; i++) {
      const r = rec();
      r.onerror?.({ error: 'network' });
      if (ctl.state === 'listening') {
        r.onend?.();
        (ctl as unknown as { backoffUntil: number }).backoffUntil = 0;
      }
    }
    expect(ctl.state).toBe('paused');
    expect(states[states.length - 1][1]).toContain('Tap to try again');
  });

  it('ignores a late result from a recognizer it already aborted', async () => {
    const { ctl, rec, sent } = harness();
    ctl.start();
    const first = rec();
    first.say('first thing', true);
    await Promise.resolve();
    ctl.reply('Answer.');
    first.say('my own voice echoing', true); // handlers were detached on abort
    await Promise.resolve();
    expect(sent).toEqual(['first thing']);
    expect(ctl.state).toBe('speaking');
  });

  it('keeps the 15 s silence deadline across the restarts Android makes every few seconds', () => {
    const { ctl, rec, timers } = harness();
    ctl.start();
    const deadline = timers.length - 1; // the no-speech timer armed by start()
    rec().onend?.(); // Android ends the silent session
    rec().onend?.(); // and again
    expect(FakeRecognition.all.length).toBe(3);
    expect(timers.length - 1).toBe(deadline); // not re-armed by the restarts
    timers[deadline]();
    expect(ctl.state).toBe('paused');
  });

  it('stops waiting on a stuck speaking flag after the reply could have been said, and cancels it', async () => {
    const { ctl, spoken, rec, synth, timers, clock } = harness();
    ctl.start();
    rec().say('quick one', true);
    await Promise.resolve();
    ctl.reply('Short answer.'); // 13 chars: the wait floor (4 s) applies
    synth.speaking = true; // Chrome never clears it
    spoken[0].onend?.();
    expect(ctl.state).toBe('speaking');
    clock.now += 5000;
    timers[timers.length - 1]();
    expect(synth.cancels).toBe(1);
    expect(ctl.state).toBe('listening');
  });
});

describe('car mode helpers', () => {
  it('uses the speech engine only with both recognition and synthesis', () => {
    expect(carModeEngine({ webkitSpeechRecognition: class {}, speechSynthesis: {} })).toBe('speech');
    expect(carModeEngine({ SpeechRecognition: class {}, speechSynthesis: {} })).toBe('speech');
    expect(carModeEngine({ speechSynthesis: {} })).toBe('server');
    expect(carModeEngine({ SpeechRecognition: class {} })).toBe('server');
  });

  it('splits long replies into sentences the synthesizer will finish', () => {
    expect(carModeUtterances('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
    expect(carModeUtterances('It took 1.5 s on v2.1.284. Done.')).toEqual(['It took 1.5 s on v2.1.284.', 'Done.']);
    const long = carModeUtterances(`${'word '.repeat(100)}end.`, 60);
    expect(long.length).toBeGreaterThan(5);
    expect(long.every((u) => u.length <= 60)).toBe(true);
    expect(carModeUtterances('')).toEqual([]);
  });

  it('prefers the saved voice, else an English female-sounding one', () => {
    const voices = [
      { name: 'Google Deutsch', lang: 'de-DE' },
      { name: 'Daniel', lang: 'en-GB' },
      { name: 'Google UK English Female', lang: 'en-GB' },
    ];
    expect(carModePickVoice(voices)?.name).toBe('Google UK English Female');
    expect(carModePickVoice(voices, 'Daniel')?.name).toBe('Daniel');
    expect(carModePickVoice([{ name: 'X', lang: 'fr-FR' }])).toBeNull();
  });
});
