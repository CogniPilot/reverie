import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const opened: JSDOM[] = [];
afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function setup() {
  const dom = new JSDOM('<div id="car"><div class="car-voice-notice" hidden></div></div>', {
    url: 'https://console.test/',
    runScripts: 'outside-only',
  });
  opened.push(dom);
  const { window } = dom;
  const context = dom.getInternalVMContext();
  context.setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
  context.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  context.ReverieApp = class {};
  context.SpeechSynthesisUtterance = class {
    constructor(public text: string) {}
  };
  for (const file of ['voice-chat.js', 'car-mode.js'])
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8'), context);
  const a = Object.create(vm.runInContext('ReverieApp.prototype', context));
  const audio = Object.assign(new window.EventTarget(), {
    currentTime: 0,
    duration: 20,
    paused: false,
    src: '',
    play: () => Promise.resolve(),
    pause: () => {
      audio.paused = true;
    },
  });
  const voices = [
    { name: 'India Female', lang: 'en-IN', default: true },
    { name: 'US Other', lang: 'en-US' },
    { name: 'US Default', lang: 'en-US', default: true },
  ];
  const spoken: Array<{
    text: string;
    voice: { name: string; lang: string };
    onend: () => void;
    onerror: (error: Error) => void;
  }> = [];
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => voices,
    cancel: () => {},
    speak: (u: unknown) => spoken.push(u as (typeof spoken)[number]),
  };
  a._chatAudioEl = () => audio;
  a._chatAudio = audio;
  a._chatUrl = (url: string) => url;
  a._carScreen = window.document.querySelector('#car');
  a._carSavedVoice = () => null;
  a._carVoiceMember = () => ({ sessionId: 'worker', name: 'Worker', pronouns: 'he/him' });
  a._chatRoomId = 'room';
  a._chatApi = async () => ({
    ok: true,
    data: { audioUrl: '/audio', engine: 'kokoro', voice: { provider: 'kokoro', id: 'am_michael' } },
  });
  const team = a._carTeamSynth(synth, () => {});
  return {
    a,
    team,
    audio,
    voices,
    spoken,
    window,
    pick: vm.runInContext('carModeFallbackVoice', context),
    notice: () => a._carScreen.querySelector('.car-voice-notice'),
  };
}

it('replays the whole reply in one qualified US default voice after the second Kokoro line fails, with a visible notice', async () => {
  const h = setup();
  let requests = 0;
  h.a._chatApi = async () =>
    ++requests === 1
      ? { ok: true, data: { audioUrl: '/first', engine: 'kokoro', voice: { provider: 'kokoro', id: 'am_michael' } } }
      : { ok: false, error: 'Unavailable' };
  h.team.speakReply([{ text: 'First sentence.' }, { text: 'Second sentence.' }]);
  await flush();
  h.audio.currentTime = h.audio.duration = 3;
  h.audio.dispatchEvent(new h.window.Event('ended'));
  await flush();
  expect(h.spoken[0].text).toBe('First sentence.');
  expect(h.spoken[0].voice.name).toBe('US Default');
  expect(h.notice().hidden).toBe(false);
  expect(h.notice().textContent).toContain('Replaying this reply from the start');
  expect(h.notice().textContent).toContain('US Default');
  h.voices.reverse();
  h.spoken[0].onend();
  await flush();
  expect(h.spoken[1].text).toBe('Second sentence.');
  expect(h.spoken[1].voice).toBe(h.spoken[0].voice);
  h.spoken[1].onerror(new Error('device failed'));
  await flush();
  expect(h.notice().textContent).toContain('Reply interrupted');
});

it('does not cut off normal audio at ten seconds, including after waiting clears to playing', async () => {
  vi.useFakeTimers();
  const h = setup();
  let ended = false;
  const playing = h.team.deps.play('/long').then(() => {
    ended = true;
  });
  h.audio.dispatchEvent(new h.window.Event('waiting'));
  h.audio.dispatchEvent(new h.window.Event('playing'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(ended).toBe(false);
  expect(h.audio.paused).toBe(false);
  h.audio.currentTime = 20;
  h.audio.dispatchEvent(new h.window.Event('ended'));
  await playing;
  expect(ended).toBe(true);
});

it('does not treat a stale waiting event as a stall if playback progressed without timeupdate', async () => {
  vi.useFakeTimers();
  const h = setup();
  const playing = h.team.deps.play('/long');
  h.audio.dispatchEvent(new h.window.Event('waiting'));
  h.audio.currentTime = 12;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.audio.paused).toBe(false);
  h.audio.currentTime = 20;
  h.audio.dispatchEvent(new h.window.Event('ended'));
  await playing;
});

it('detects a genuine ten-second stall and silences the stalled audio', async () => {
  vi.useFakeTimers();
  const h = setup();
  const result = h.team.deps.play('/stalled').catch((error: Error) => error);
  h.audio.dispatchEvent(new h.window.Event('waiting'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await result).message).toContain('stalled');
  expect(h.audio.paused).toBe(true);
});

it('rejects ended before the media duration so the reply batch can restart instead of silently truncating', async () => {
  const h = setup();
  const result = h.team.deps.play('/clipped').catch((error: Error) => error);
  h.audio.currentTime = 10;
  h.audio.duration = 20;
  h.audio.dispatchEvent(new h.window.Event('ended'));
  expect((await result).message).toContain('ended early');
});

it('selects a deterministic matching-locale default rather than the first system voice', () => {
  const h = setup();
  const pick = h.pick;
  expect(pick(h.voices, null).name).toBe('US Default');
  expect(pick([...h.voices].reverse(), null).name).toBe('US Default');
  expect(pick([{ name: 'UK default', lang: 'en-GB', default: true }, ...h.voices], null, 'en-GB').name).toBe(
    'UK default'
  );
  expect(pick([{ name: 'French', lang: 'fr-FR' }], null, 'en-US')).toBeNull();
});

it('names the actual explicitly configured browser voice in the fallback notice and pins it for the batch', async () => {
  const h = setup();
  const french = { name: 'French selected', lang: 'fr-FR', default: false };
  h.voices.push(french);
  h.a._chatApi = async () => ({
    ok: true,
    data: { engine: 'browser', voice: { provider: 'browser', id: french.name } },
  });
  h.team.speakReply([{ text: 'Bonjour.' }, { text: 'Encore.' }]);
  await flush();
  expect(h.spoken[0].voice).toBe(french);
  expect(h.notice().textContent).toContain('French selected');
  expect(h.notice().textContent).not.toContain('unavailable');
  h.spoken[0].onend();
  await flush();
  expect(h.spoken[1].voice).toBe(french);
  h.spoken[1].onend();
  await flush();
});

it('ignores a stale play rejection after stop, so it cannot detach the next playback cancellation', async () => {
  const h = setup();
  let rejectFirst: (error: Error) => void = () => {};
  h.audio.play = () =>
    new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
  const first = h.team.deps.play('/first');
  h.team.deps.stop();
  await first;
  h.audio.play = () => Promise.resolve();
  let stopped = false;
  const second = h.team.deps.play('/second').then(() => {
    stopped = true;
  });
  rejectFirst(new Error('late refusal'));
  await flush();
  h.team.deps.stop();
  await flush();
  expect(stopped).toBe(true);
  await second;
});
