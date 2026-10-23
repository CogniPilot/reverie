/**
 * Read aloud ("Speak replies aloud") in each member's own server voice: every line asks
 * /api/voice/speak for the member who wrote it, in the room it came from; a line the server
 * cannot make, or any line while the car screen is open, is spoken in the phone voice.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Utt {
  text: string;
  voice?: { voiceURI: string; name: string; lang: string };
  readAloud?: { room: string; member: string } | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

const phoneSaid: Utt[] = [];
const phone = {
  speaking: false,
  pending: false,
  cancels: 0,
  getVoices: () => [
    { voiceURI: 'voice://chosen', name: 'Chosen voice', lang: 'fr-FR' },
    { voiceURI: 'voice://english', name: 'English default', lang: 'en-US', default: true },
  ],
  speak(u: Utt) {
    phoneSaid.push(u);
  },
  cancel() {
    this.cancels++;
  },
};

class FakeUtterance {
  text: string;
  voice: unknown = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

const context = vm.createContext({
  ReverieApp: class {},
  window: { speechSynthesis: phone },
  SpeechSynthesisUtterance: FakeUtterance,
  AbortSignal,
  setTimeout,
  clearTimeout,
  localStorage: { getItem: () => '1', setItem() {}, removeItem() {} },
});
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), context);
const App = vm.runInContext('ReverieApp', context) as new () => Record<string, unknown>;
const READ_ALOUD_SERVER_SLACK_MS = vm.runInContext('READ_ALOUD_SERVER_SLACK_MS', context) as number;

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** An audio element the test ends by hand. */
function fakeAudio() {
  const listeners = new Map<string, Set<() => void>>();
  const el = {
    src: '',
    paused: true,
    played: [] as string[],
    addEventListener(t: string, fn: () => void) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener(t: string, fn: () => void) {
      listeners.get(t)?.delete(fn);
    },
    play() {
      el.paused = false;
      el.played.push(el.src);
      return Promise.resolve();
    },
    pause() {
      el.paused = true;
    },
    emit(t: string) {
      for (const fn of [...(listeners.get(t) || [])]) fn();
    },
  };
  return el;
}

type VoiceResult = { ok: boolean; data?: unknown };
function app(opts: { speak?: (body: Record<string, string>) => VoiceResult | Promise<VoiceResult> } = {}) {
  phoneSaid.length = 0;
  phone.cancels = 0;
  const asked: Record<string, string>[] = [];
  const audio = fakeAudio();
  const a = new App();
  Object.assign(a, {
    _chatRoomId: 'board',
    _chatOwnerNames: ['Owner'],
    _chatRoom: { id: 'board', kind: 'room', messages: [] },
    _carScreen: { hidden: true },
    _chatAudio: audio,
    _chatAudioEl: () => audio,
    _chatUrl: (p: string) => p,
    _carVoice: () => null,
    _carVoiceMember: () => ({ sessionId: 'worker-id' }),
    _diag: () => {},
    _chatApi: async (_url: string, init: { body: Record<string, string> }) => {
      asked.push(init.body);
      return (opts.speak || (() => ({ ok: true, data: { audioUrl: `/a/${asked.length}`, engine: 'kokoro' } })))(
        init.body
      );
    },
  });
  return { a, asked, audio };
}

const message = (from: string, sessionId: string, text: string, roomId = 'board') => ({
  roomId,
  message: { id: `m-${text}`, from: { kind: 'agent', name: from, sessionId }, text, mentions: ['user'], to: ['user'] },
});

describe('read aloud in the team voices', () => {
  it('asks the server for the member who wrote the line, in the room it came from, and plays it', async () => {
    const { a, asked, audio } = app();
    const q = (a._readAloudQueue as () => { push(t: string, m: unknown): void })();
    q.push('Reviewer says: Voices are live.', { room: 'board', member: 'reviewer-id' });
    await flush();
    expect(asked).toEqual([{ room: 'board', member: 'reviewer-id', text: 'Reviewer says: Voices are live.' }]);
    expect(audio.played).toEqual(['/a/1']);
    expect(phoneSaid).toEqual([]);
  });

  it('gives each line its own speaker, one at a time', async () => {
    const { a, asked, audio } = app();
    const q = (a._readAloudQueue as () => { push(t: string, m: unknown): void })();
    q.push('Reviewer says: one.', { room: 'board', member: 'reviewer-id' });
    q.push('Coordinator says: two.', { room: 'board', member: 'coordinator-id' });
    await flush();
    expect(asked.map((b) => b.member)).toEqual(['reviewer-id']);
    expect(audio.played).toEqual(['/a/1']);
    audio.emit('ended');
    await flush();
    expect(asked.map((b) => b.member)).toEqual(['reviewer-id', 'coordinator-id']);
    expect(audio.played).toEqual(['/a/1', '/a/2']);
  });

  it('falls back to the phone voice when the server cannot make the line', async () => {
    const { a, audio } = app({ speak: () => ({ ok: false }) });
    const q = (a._readAloudQueue as () => { push(t: string, m: unknown): void })();
    q.push('Reviewer says: hi.', { room: 'board', member: 'reviewer-id' });
    await flush();
    expect(audio.played).toEqual([]);
    expect(phoneSaid.map((u) => u.text)).toEqual(['Reviewer says: hi.']);
  });

  it('speaks a persisted browser choice exactly, including a non-English voice', async () => {
    const { a, audio } = app({
      speak: () => ({
        ok: true,
        data: {
          engine: 'browser',
          fallback: 'browser',
          voice: { provider: 'browser', id: 'voice://chosen' },
        },
      }),
    });
    const q = (a._readAloudQueue as () => { push(t: string, m: unknown): void })();
    q.push('Reviewer says: Bonjour.', { room: 'board', member: 'reviewer-id' });
    await flush();
    expect(audio.played).toEqual([]);
    expect(phoneSaid[0]?.voice?.voiceURI).toBe('voice://chosen');
  });

  it('uses the phone voice while the car screen is open (the car owns the audio element)', async () => {
    const { a, asked, audio } = app();
    (a._carScreen as { hidden: boolean }).hidden = false;
    const q = (a._readAloudQueue as () => { push(t: string, m: unknown): void })();
    q.push('Reviewer says: hi.', { room: 'board', member: 'reviewer-id' });
    await flush();
    expect(asked).toEqual([]);
    expect(audio.played).toEqual([]);
    expect(phoneSaid.map((u) => u.text)).toEqual(['Reviewer says: hi.']);
  });

  it('a line with no speaker goes to the phone voice, not the server', async () => {
    const { a, asked } = app();
    const q = (a._readAloudQueue as () => { push(t: string): void })();
    q.push('Someone says: hi.');
    await flush();
    expect(asked).toEqual([]);
    expect(phoneSaid.map((u) => u.text)).toEqual(['Someone says: hi.']);
  });

  it('clear() silences the line being played and drops the rest', async () => {
    const { a, asked, audio } = app();
    const q = (a._readAloudQueue as () => { push(t: string, m: unknown): void; clear(): void })();
    q.push('Reviewer says: one.', { room: 'board', member: 'reviewer-id' });
    q.push('Coordinator says: two.', { room: 'board', member: 'coordinator-id' });
    await flush();
    expect(audio.paused).toBe(false);
    q.clear();
    await flush();
    expect(audio.paused).toBe(true);
    audio.emit('ended');
    await flush();
    expect(asked.map((b) => b.member)).toEqual(['reviewer-id']);
  });

  it('a room message is queued with its room and sender', async () => {
    const { a, asked } = app();
    const pushed: unknown[][] = [];
    a._readAloudQueue = () => ({ push: (...args: unknown[]) => pushed.push(args) });
    (a._readAloudOnMessage as (d: unknown) => void)(message('Workspace: Reviewer', 'reviewer-id', 'Voices are live.'));
    expect(pushed).toEqual([
      ['Reviewer says: Voices are live.', { room: 'board', member: 'reviewer-id', text: 'Voices are live.' }],
    ]);
    expect(asked).toEqual([]);
  });

  it('their own voice says the line without "Name says:"; the phone backup keeps the name', async () => {
    const { a, asked, audio } = app();
    (a._readAloudOnMessage as (d: unknown) => void)(message('Workspace: Worker', 'worker-id', 'Voices are live.'));
    await flush();
    expect(asked).toEqual([{ room: 'board', member: 'worker-id', text: 'Voices are live.' }]);
    expect(audio.played).toEqual(['/a/1']);
    expect(phoneSaid).toEqual([]);
    const failed = app({ speak: () => ({ ok: false }) });
    (failed.a._readAloudOnMessage as (d: unknown) => void)(
      message('Workspace: Worker', 'worker-id', 'Voices are live.')
    );
    await flush();
    expect(failed.asked.map((b) => b.text)).toEqual(['Voices are live.']);
    expect(phoneSaid.map((u) => u.text)).toEqual(['Worker says: Voices are live.']);
  });

  it('allows a server line time to be fetched before the stall guard', () => {
    const { a } = app();
    const q = (a._readAloudQueue as () => { deps: { slackMs: number } })();
    expect(q.deps.slackMs).toBe(READ_ALOUD_SERVER_SLACK_MS);
  });

  it('plays a long message through bounded server chunks without interleaving speakers', async () => {
    const { a, asked, audio } = app();
    const queue = (
      a._readAloudQueue as () => { push(text: string, meta: unknown): void; current: unknown; clear(): void }
    )();
    const text = 'The tide rises. '.repeat(90).trim();
    queue.push('Casey says: ' + text, { room: 'board', member: 'casey-session', text });
    queue.push('River says: Wait.', { room: 'board', member: 'river-session', text: 'Wait.' });
    await flush();
    for (let count = 0; count < 100 && queue.current; count++) {
      audio.emit('ended');
      await flush();
    }
    expect(queue.current).toBeNull();
    expect(asked.every((body) => body.text.length <= 600)).toBe(true);
    const first = asked.filter((body) => body.member === 'casey-session');
    expect(first.length).toBeGreaterThan(1);
    expect(first.map((body) => body.text).join(' ')).toBe(text);
    expect(asked.at(-1)?.member).toBe('river-session');
    expect(phoneSaid).toEqual([]);
    queue.clear();
  });
});

type TeamSynth = { speak(u: Utt): void; cancel(): void };
const carSynth = (a: Record<string, unknown>) =>
  (a._carTeamSynth as (native: typeof phone, diag: () => void) => TeamSynth)(phone, () => {});

it('retains the queued utterance source while a cancelled car request drains and room state changes', async () => {
  let release!: (value: VoiceResult) => void;
  const old = new Promise<VoiceResult>((resolve) => {
    release = resolve;
  });
  const { a, asked, audio } = app({
    speak: (body) =>
      body.text === 'Old request.' ? old : { ok: true, data: { audioUrl: '/origin', engine: 'kokoro' } },
  });
  const car = carSynth(a);
  car.speak({ text: 'Old request.', onend: null, onerror: null });
  await flush();
  car.cancel();
  const q = (a._readAloudQueue as () => { push(t: string, meta: unknown): void; clear(): void })();
  const source = { room: 'origin-room', member: 'origin-member', text: 'Original content.' };
  q.push('Speaker says: Original content.', source);
  source.room = 'changed-room';
  source.member = 'changed-member';
  source.text = 'Changed content.';
  a._chatRoomId = 'unrelated-room';
  await flush();
  expect(asked).toHaveLength(1);
  release({ ok: true, data: { audioUrl: '/stale-car', engine: 'kokoro' } });
  await flush();
  expect(asked[1]).toEqual({ room: 'origin-room', member: 'origin-member', text: 'Original content.' });
  expect(audio.played).toEqual(['/origin']);
  expect(phoneSaid).toEqual([]);
  q.clear();
});

it('clears a read-aloud request waiting behind the car lane without posting or speaking it later', async () => {
  let release!: (value: VoiceResult) => void;
  const old = new Promise<VoiceResult>((resolve) => {
    release = resolve;
  });
  const { a, asked, audio } = app({ speak: () => old });
  const car = carSynth(a);
  car.speak({ text: 'Old request.', onend: null, onerror: null });
  await flush();
  car.cancel();
  const q = (a._readAloudQueue as () => { push(t: string, meta: unknown): void; clear(): void })();
  q.push('Never speak.', { room: 'room', member: 'member' });
  q.clear();
  release({ ok: true, data: { audioUrl: '/stale', engine: 'kokoro' } });
  await flush();
  expect(asked).toHaveLength(1);
  expect(audio.played).toEqual([]);
  expect(phoneSaid).toEqual([]);
});

it('passes only the remaining shared-lane budget to deferred read-aloud', async () => {
  let now = 0,
    release!: (value: null) => void;
  const Queue = vm.runInContext('CarSynthesisQueue', context);
  const lane = new Queue({ now: () => now, setTimeout, clearTimeout });
  const active = lane.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    {},
    () => true
  );
  await flush();
  const { a, asked } = app();
  a._carSynthesisQueue = lane;
  const timeouts: number[] = [];
  context.AbortSignal = {
    timeout: (ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    },
  };
  const q = (a._readAloudQueue as () => { push(t: string, meta: unknown): void; clear(): void })();
  try {
    q.push('Queued line.', { room: 'source-room', member: 'source-member' });
    now = 10_000;
    release(null);
    await active;
    await flush();
    expect(asked).toEqual([{ room: 'source-room', member: 'source-member', text: 'Queued line.' }]);
    expect(timeouts).toEqual([15_000]);
  } finally {
    q.clear();
    context.AbortSignal = AbortSignal;
  }
});
