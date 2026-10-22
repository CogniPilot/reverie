import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8');
const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.ReverieApp = class {};', context);
vm.runInContext(source, context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), context);
const clean = vm.runInContext('readAloudClean', context) as (text: string, names?: string[], emojis?: boolean) => string;
const limit = vm.runInContext('readAloudLimit', context) as (text: string, seconds: number) => string;
const estimate = vm.runInContext('readAloudSeconds', context) as (text: string) => number;
const chunks = vm.runInContext('readAloudChunks', context) as (text: string) => string[];
const Proto = vm.runInContext('ReverieApp.prototype', context);
afterAll(() => dom.window.close());

describe('speech-only normalization', () => {
  it('speaks known mention names without changing unknown names or email addresses', () => {
    expect(clean('@Casey, ask @River. Email casey@example.com or @Casey.example, not @Casey-two or @Unknown.', ['Casey', 'River']))
      .toBe('Casey, ask River. Email casey@example.com or @Casey.example, not @Casey-two or @Unknown.');
    expect(clean('Hello @Zoë and @River Stone!', ['Zoë', 'River Stone'])).toBe('Hello Zoë and River Stone!');
    expect(clean('@All: hello @owner and @here.')).toBe('All: hello owner and here.');
  });

  it('removes emoji sequences only when disabled, without eating ordinary numbers', () => {
    const text = '🎲 Roll 17 + 4, family 👨‍👩‍👧‍👦 flag 🇬🇧 hand 👍🏽 key 1️⃣.';
    expect(clean(text, [], true)).toBe(text);
    expect(clean(text, [], false)).toBe('Roll 17 + 4, family flag hand key .');
    expect(clean('🎲 👩🏽‍💻 ❤︎', [], false)).toBe('');
    expect(clean('Room 123 costs $20, 2 + 3 = 5.', [], false)).toBe('Room 123 costs $20, 2 + 3 = 5.');
  });
});

describe('approximate sentence-safe duration', () => {
  it('keeps complete sentences while their estimate fits', () => {
    const first = 'The door is open.';
    const text = first + ' ' + 'The tide is coming back quickly and we should leave now.';
    expect(limit(text, 2)).toBe(first);
    expect(estimate(limit(text, 2))).toBeLessThanOrEqual(2);
    expect(limit('Only one sentence.', 30)).toBe('Only one sentence.');
  });

  it('stops the first overlong sentence at a whole word, never adding later sentences', () => {
    const text = 'We must walk across the cold wet mud before the returning tide traps us. Run.';
    const short = limit(text, 2);
    expect(text.startsWith(short)).toBe(true);
    expect(short).toBe('We must walk across the');
    expect(estimate(short)).toBeLessThanOrEqual(2);
    expect(limit('Supercalifragilisticexpialidocious', 1)).toBe('');
    expect(limit(text, 0)).toBe(text);
  });

  it('uses bounded chunks for Unlimited, preserving text and surrogate pairs', () => {
    const text = 'The tide rises. '.repeat(100).trim();
    const result = chunks(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(chunk => chunk.length <= 600 && chunk.length > 0)).toBe(true);
    expect(result.join(' ')).toBe(text);
    const unbroken = '🌊'.repeat(601);
    expect(chunks(unbroken).join('')).toBe(unbroken);
    expect(chunks(unbroken).every(chunk => chunk.length <= 600 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });

  it('keeps sentence and word boundaries when Intl.Segmenter is unavailable', () => {
    const original = context.Intl;
    context.Intl = {};
    try {
      expect(limit('The door is open. The tide will trap all of us unless we leave.', 2)).toBe('The door is open.');
      expect(limit('We must walk across the cold wet mud before the returning tide traps us.', 2)).toBe('We must walk across the');
    } finally { context.Intl = original; }
  });
});

describe('per-device, per-room settings and live message path', () => {
  const setup = () => {
    dom.window.localStorage.clear();
    const app = Object.create(Proto);
    app._chatRoomId = 'room-a';
    app._chatRoom = { id: 'room-a', members: [{ name: 'Casey' }], messages: [] };
    app._chatOwnerNames = ['Owner'];
    app._setSpeakReplies('room-a', 'all');
    const pushed: Array<{ text: string; meta: Record<string, unknown> }> = [];
    let cleared = 0;
    app._readAloud = { clear: () => cleared++ };
    app._readAloudQueue = () => ({ push: (text: string, meta: Record<string, unknown>) => pushed.push({ text, meta }) });
    return { app, pushed, cleared: () => cleared };
  };

  it('preserves legacy defaults and isolates settings between rooms and application reloads', () => {
    const { app, cleared } = setup();
    expect(app._readAloudOptions('room-a')).toEqual({ seconds: null, emojis: true });
    app._setReadAloudOptions('room-a', { seconds: 10, emojis: false });
    expect(cleared()).toBe(1);
    expect(app._readAloudOptions('room-b')).toEqual({ seconds: null, emojis: true });
    expect(Object.create(Proto)._readAloudOptions('room-a')).toEqual({ seconds: 10, emojis: false });
    dom.window.localStorage.setItem('reverie:readAloudOptions:room-a', '{bad');
    expect(app._readAloudOptions('room-a')).toEqual({ seconds: null, emojis: true });
    dom.window.localStorage.setItem('reverie:readAloudOptions:room-a', '{"seconds":-99,"emojis":"false"}');
    expect(app._readAloudOptions('room-a')).toEqual({ seconds: null, emojis: true });
  });

  it('applies the configured seconds instead of the old word gate, only to speech', () => {
    const { app, pushed } = setup();
    const text = '@Casey 🎲 ' + 'The tide rises slowly. '.repeat(40);
    const message = { id: 'message-one', from: { kind: 'agent', name: 'River', sessionId: 'river-session' }, to: 'all', text };
    app._setReadAloudOptions('room-a', { seconds: 5, emojis: false });
    app._readAloudOnMessage({ roomId: 'room-a', message });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].text).toContain('Casey');
    expect(pushed[0].text).not.toMatch(/Long reply|@|🎲/);
    expect(estimate(pushed[0].text)).toBeLessThanOrEqual(5);
    expect(message.text).toBe(text);
    app._setReadAloudOptions('room-a', { seconds: 0 });
    app._readAloudOnMessage({ roomId: 'room-a', message });
    expect(pushed[1].text).toContain('The tide rises slowly. '.repeat(39));
    expect(pushed[1].meta.text).not.toContain('River says:');
    expect(message.to).toBe('all');
    app._setReadAloudOptions('room-a', { seconds: null });
    app._readAloudOnMessage({ roomId: 'room-a', message });
    expect(pushed[2].text).toBe('Long reply from River, see the panel.');
  });

  it('keeps emoji options independent from duration and omits emoji-only messages when disabled', () => {
    const { app, pushed } = setup();
    app._setReadAloudOptions('room-a', { emojis: false });
    app._readAloudOnMessage({ roomId: 'room-a', message: { from: { kind: 'agent', name: 'River' }, text: '🎲', to: 'all' } });
    expect(pushed).toEqual([]);
    expect(app._readAloudOptions('room-a').seconds).toBeNull();
  });

  it('preserves line boundaries for the existing markdown, code and path speech filter', () => {
    const { app, pushed } = setup();
    app._setReadAloudOptions('room-a', { seconds: 0, emojis: false });
    app._readAloudOnMessage({ roomId: 'room-a', message: {
      from: { kind: 'agent', name: 'River' }, to: 'all',
      text: '@Casey\n## Check\n- **Ready**\n```js\nsecret();\n```\nUse /scratch/private/file.',
    } });
    expect(pushed[0].text).toBe('River says: Casey Check Ready (code in chat) Use a file path.');
  });

  it('exposes approximate duration choices and an emoji toggle in the real channel menu', async () => {
    const session = '0000002d-0035-4000-8000-000000000047';
    const harness = await createHarness({ rooms: [room('room-one', 'Harbor', [member(session, 'Casey')])] });
    try {
      harness.window.eval(source);
      const entries = harness.shell.channelEntries(harness.shell.room).find((entry: { label: string }) => entry.label === 'Read aloud').sub;
      const length = entries.find((entry: { label?: string }) => entry.label === 'Maximum spoken length (approx.)');
      expect(length.sub.map((entry: { label: string }) => entry.label)).toEqual(['Default (80-word limit)', '5 seconds', '10 seconds', '20 seconds', '30 seconds', 'Unlimited']);
      length.sub[2].run();
      entries.find((entry: { label?: string }) => entry.label === 'Speak emojis').run();
      expect(harness.app._readAloudOptions('room-one')).toEqual({ seconds: 10, emojis: false });
      expect(harness.app._readAloudOptions('other-room')).toEqual({ seconds: null, emojis: true });
    } finally { harness.dom.window.close(); }
  });
});

describe('bounded chunk playback and watchdogs', () => {
  it('repeats only the interrupted chunk after mic mute, not already completed chunks', () => {
    const spoken: Array<{ text: string; onend: () => void }> = [];
    const Queue = vm.runInContext('ReadAloudQueue', context);
    const queue = new Queue({
      synth: { speak: (utterance: typeof spoken[number]) => spoken.push(utterance), cancel() {} },
      createUtterance: (text: string) => ({ text }),
      setTimeout: () => 1, clearTimeout() {},
    });
    queue.push('First sentence. ' + 'The tide rises. '.repeat(90));
    spoken[0].onend();
    const interrupted = spoken[1];
    queue.mute(true);
    queue.mute(false);
    expect(spoken[2].text).toBe(interrupted.text);
    expect(spoken[2].text).not.toContain('First sentence.');
    interrupted.onend();
    expect(spoken).toHaveLength(3);
    queue.clear();
  });

  it('finishes every chunk in order without interleaving the next message or repeating a completion notice', () => {
    const spoken: Array<{ text: string; onend: () => void; onerror: () => void; meta: Record<string, unknown> }> = [];
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const done: string[] = [];
    const Queue = vm.runInContext('ReadAloudQueue', context);
    const queue = new Queue({
      synth: { speak: (utterance: typeof spoken[number]) => spoken.push(utterance), cancel() {} },
      createUtterance: (text: string, meta: Record<string, unknown>) => ({ text, meta }),
      setTimeout: (callback: () => void, ms: number) => (timers.push({ callback, ms }), timers.length),
      clearTimeout() {}, onDone: (_item: unknown, how: string) => done.push(how),
    });
    const text = 'Casey says: ' + 'The tide rises. '.repeat(60).trim();
    queue.push(text, { text: text.slice(12) });
    queue.push('Next message.');
    const first = spoken[0];
    first.onend();
    first.onend();
    expect(done).toEqual([]);
    let cursor = 1;
    while (queue.current && done.length === 0) spoken[cursor++].onend();
    expect(done).toEqual(['ended']);
    expect(spoken.at(-1)?.text).toBe('Next message.');
    expect(spoken.slice(0, -1).map(utterance => utterance.text).join(' ')).toBe(text);
    expect(spoken[0].meta.text).not.toContain('Casey says:');
    expect(spoken.slice(0, -1).every(utterance => utterance.meta.text === utterance.text || utterance.meta.text === utterance.text.slice(12))).toBe(true);
    expect(timers.every(timer => timer.ms > 0 && timer.ms <= 60_000)).toBe(true);
    queue.clear();
  });

  it('cancels stalled chunk audio, drops its remaining chunks and advances safely', () => {
    const spoken: Array<{ text: string; onend: () => void }> = [];
    const timers: Array<() => void> = [];
    let cancelled = 0;
    const done: string[] = [];
    const Queue = vm.runInContext('ReadAloudQueue', context);
    const queue = new Queue({
      synth: { speak: (utterance: typeof spoken[number]) => spoken.push(utterance), cancel: () => cancelled++ },
      createUtterance: (text: string) => ({ text }),
      setTimeout: (callback: () => void) => (timers.push(callback), timers.length), clearTimeout() {},
      onDone: (_item: unknown, how: string) => done.push(how),
    });
    queue.push('The tide rises. '.repeat(100));
    queue.push('Next.');
    timers[0]();
    expect(cancelled).toBe(1);
    expect(done).toEqual(['timeout']);
    expect(spoken.map(utterance => utterance.text).at(-1)).toBe('Next.');
    spoken[0].onend();
    expect(done).toEqual(['timeout']);
    queue.clear();
  });
});
