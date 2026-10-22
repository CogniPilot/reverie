/**
 * Hands-free voice in the chat panel (hands-free.js): on by default on a computer, speech
 * starts a take and a pause sends it the way a mic press would; listening holds while a
 * reply plays, an answer is awaited, push-to-talk records or the box has text; the mic
 * is released when the panel closes, the tab hides, car mode opens or it is switched off.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  runScripts: 'outside-only',
  url: 'https://console.test/',
  pretendToBeVisual: true,
});
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js', 'hands-free.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('ReverieApp.prototype', context);
const Detector = vm.runInContext('HandsFreeDetector', context);
const doc = dom.window.document;
afterAll(() => dom.window.close());

const WORKER = { sessionId: 'worker-id', name: 'Worker', voice: true };
let hidden = false;
Object.defineProperty(doc, 'hidden', { configurable: true, get: () => hidden });

/** What the recorders hand over: chunks tagged with the recorder that made them. */
class FakeBlob {
  size: number;
  constructor(
    public parts: { size: number; tag: string }[],
    public opts?: { type?: string }
  ) {
    this.size = parts.reduce((n, p) => n + p.size, 0);
  }
  text() {
    return this.parts.map((p) => p.tag).join('+');
  }
}

type Rec = { id: number; state: string; stop: () => void; ondataavailable: (e: unknown) => void; onstop: () => void };

function setup({ route = 'turn' as string | null, micHidden = false, refuse = false, ctxState = 'running' } = {}) {
  hidden = false;
  delete context.SpeechRecognition;
  delete context.webkitSpeechRecognition;
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  dom.window.localStorage.clear();
  const recs: Rec[] = [];
  const tracks = { stopped: 0 };
  let asked = 0;
  const ctx = { state: ctxState, resumed: 0, closed: 0 };
  class FakeRecorder {
    static isTypeSupported = () => true;
    id = recs.length;
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: (e: unknown) => void = () => {};
    onstop: () => void = () => {};
    constructor() {
      recs.push(this as unknown as Rec);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: { size: 2000, tag: `rec${this.id}` } });
      this.onstop();
    }
  }
  class FakeContext {
    get state() {
      return ctx.state;
    }
    createAnalyser() {
      return { fftSize: 0, getFloatTimeDomainData() {} };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    resume() {
      ctx.resumed++;
      ctx.state = 'running';
      return Promise.resolve();
    }
    close() {
      ctx.closed++;
      return Promise.resolve();
    }
  }
  context.MediaRecorder = FakeRecorder;
  context.Blob = FakeBlob;
  context.AudioContext = FakeContext;
  Object.defineProperty(dom.window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => {
        asked++;
        if (refuse) return Promise.reject(new Error('Permission denied'));
        return Promise.resolve({ getTracks: () => [{ stop: () => tracks.stopped++ }] });
      },
    },
  });
  const a = Object.create(Proto);
  let open = true;
  a.isChatroomOpen = () => open;
  const row = doc.createElement('div');
  const mic = doc.createElement('button');
  mic.hidden = micHidden;
  row.append(mic);
  const input = doc.createElement('textarea');
  a._chatEls = { mic, input, voiceStatus: doc.createElement('div'), to: { value: 'worker-id' } };
  a._chatRoom = { members: [WORKER] };
  a._chatApi = async () => ({
    ok: true,
    data: { available: true, message: 'Whisper/Piper speech service at 127.0.0.1:8090 is ready' },
  });
  a._chatMicRoute = () => route;
  a._chatToLabel = () => 'everyone';
  a._diag = () => {};
  a._unlockChatAudio = () => {};
  const sent: { how: string; text: string; to?: string }[] = [];
  a._sendChatVoice = async (blob: FakeBlob, t: { sessionId: string }) =>
    void sent.push({ how: 'turn', text: blob.text(), to: t.sessionId });
  a._transcribeOnServer = async (blob: FakeBlob) => void sent.push({ how: 'stt', text: blob.text() });
  let now = 0;
  let level = 0;
  a._hfNow = () => now;
  a._hfLevel = () => level;
  a._buildHandsFree(mic);
  dom.window.clearInterval(a._hfTimer);
  const btn = () => a._hfButton as HTMLButtonElement;
  /** Advance `ms` at mic level `lvl`, one tick at a time. */
  const run = (ms: number, lvl: number) => {
    for (let t = 0; t < ms; t += 60) {
      now += 60;
      level = lvl;
      a._hfTick();
    }
  };
  const start = async () => {
    a._hfTick();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    a,
    recs,
    tracks,
    ctx,
    sent,
    btn,
    choose: (value: string) => {
      btn().value = value;
      btn().dispatchEvent(new dom.window.Event('change'));
    },
    toggle: () => {
      btn().value = a._roomVoiceMode() === 'off' ? 'panel' : 'off';
      btn().dispatchEvent(new dom.window.Event('change'));
    },
    run,
    start,
    asked: () => asked,
    state: () => btn().dataset.state,
    close: () => (open = false),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('voice service availability and shared Voice control', () => {
  it('does not start capture if the user switches off while health is pending', async () => {
    const h = setup();
    let finish: (v: unknown) => void = () => {};
    h.a._chatApi = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await h.start();
    h.choose('off');
    finish({ ok: true, data: { available: true, message: 'service ready' } });
    await settle();
    expect(h.asked()).toBe(0);
    expect(h.state()).toBe('off');
    expect(h.a._roomVoiceMode()).toBe('off');
  });

  it('shows the selected engine and its reason in diagnostics, and includes them in the upload', async () => {
    const h = setup();
    let metadata: unknown;
    const notices: string[] = [];
    h.a.showToast = (text: string) => notices.push(text);
    h.a._chatApi = async (_path: string, opts: { body: { meta: unknown } }) => {
      metadata = opts.body.meta;
      return { ok: true, data: { file: 'diagnostics.json' } };
    };
    h.a._hfService = { state: 'unavailable', message: 'Whisper/Piper at 127.0.0.1:8090 unavailable' };
    await h.a.sendChatDiagnostics();
    expect(metadata).toMatchObject({ voiceEngine: { engine: 'server', server: 'unavailable', recognition: false } });
    expect(notices.at(-1)).toContain('Engine: server');
    expect(notices.at(-1)).toContain('SpeechRecognition is unavailable');
    expect(h.a._chatEls.voiceStatus.textContent).toContain('127.0.0.1:8090');
  });

  it('hides Voice when neither an audio engine nor a voice member exists', async () => {
    const h = setup({ route: null });
    delete context.MediaRecorder;
    h.a._chatRoom = { members: [] };
    Object.defineProperty(dom.window.navigator, 'mediaDevices', { configurable: true, value: undefined });
    await h.start();
    expect(h.btn().hidden).toBe(true);
    expect(h.asked()).toBe(0);
  });

  it('does not open the mic during a pending probe or issue duplicate probes', async () => {
    const h = setup();
    let finish: (v: unknown) => void = () => {};
    let probes = 0;
    h.a._chatApi = () => {
      probes++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    await h.start();
    h.run(3000, 0.2);
    expect(h.asked()).toBe(0);
    expect(probes).toBe(1);
    expect(h.state()).toBe('checking');
    expect(h.a._chatEls.mic.title).toContain('Checking');
    finish({ ok: true, data: { available: true, message: 'Whisper/Piper at 8090 is ready' } });
    await settle();
    expect(h.asked()).toBe(1);
  });

  it('stays off when unavailable, exposes service/port and Retry, preserves preference and does not poll', async () => {
    const h = setup();
    let probes = 0;
    h.a._chatApi = async () => {
      probes++;
      return {
        ok: true,
        data: { available: false, message: 'Whisper/Piper speech service at 127.0.0.1:8090 is unavailable' },
      };
    };
    await h.start();
    h.run(6000, 0.2);
    expect(h.asked()).toBe(0);
    expect(h.btn().value).toBe('off');
    expect(h.btn().getAttribute('aria-pressed')).toBe('false');
    expect(h.a._chatEls.mic.title).toContain('127.0.0.1:8090');
    expect(h.btn().textContent).toContain('Retry speech service');
    expect(dom.window.localStorage.length).toBe(0);
    expect(probes).toBe(1);
    h.a._chatApi = async () => ({ ok: true, data: { available: true, message: 'service ready' } });
    h.choose('retry');
    await settle();
    expect(h.asked()).toBe(1);
  });

  it('pauses capture after a failed take and sends nothing again until Retry', async () => {
    const h = setup();
    let sends = 0;
    h.a._sendChatVoice = async () => {
      sends++;
      h.a._chatVoiceStatus('Whisper/Piper at 8090 could not be reached', 'error');
      return false;
    };
    await h.start();
    h.run(900, 0.002);
    h.run(600, 0.2);
    h.run(1500, 0.002);
    await settle();
    expect(h.tracks.stopped).toBe(1);
    h.run(6000, 0.2);
    h.run(2000, 0.002);
    await settle();
    expect(sends).toBe(1);
    expect(h.asked()).toBe(1);
    expect(h.state()).toBe('unavailable');
  });

  it('offers browser dictation on Android-like touch devices with no voice member and no service', async () => {
    const h = setup({ route: 'local', micHidden: true });
    Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 2 });
    let starts = 0;
    context.SpeechRecognition = class {
      start() {
        starts++;
      }
    };
    h.a._chatRoom = { members: [] };
    h.a._chatApi = async () => ({ ok: true, data: { available: false, message: 'Whisper/Piper at 8090 unavailable' } });
    await h.start();
    expect(h.btn().hidden).toBe(false);
    expect(h.btn().textContent).toContain('Browser dictation');
    expect(h.btn().textContent).not.toContain('Car screen');
    expect(starts).toBe(0);
    h.choose('dictate');
    expect(starts).toBe(1);
    expect(h.asked()).toBe(0);
    expect(h.a._voiceEngineInfo()).toMatchObject({ engine: 'speech', recognition: true });
  });

  it('offers car by default on touch only, and keeps room choices separate', async () => {
    const h = setup();
    await h.start();
    expect(h.btn().textContent).not.toContain('Car screen');
    Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 2 });
    h.run(60, 0.002);
    expect(h.btn().textContent).toContain('Car screen');
    h.a._chatRoomId = 'first';
    h.choose('off');
    h.a._chatRoomId = 'second';
    expect(h.a._roomVoiceMode()).toBe('off'); // touch default
    h.choose('panel');
    h.a._chatRoomId = 'first';
    expect(h.a._roomVoiceMode()).toBe('off');
  });

  it('rejects empty browser transcripts before any posting request', async () => {
    const h = setup();
    let posts = 0;
    h.a._chatApi = async () => {
      posts++;
      return { ok: true };
    };
    await expect(h.a._carSend(' \n\t ')).rejects.toThrow('nothing was posted');
    expect(posts).toBe(0);
  });
});

describe('HandsFreeDetector', () => {
  const feed = (d: InstanceType<typeof Detector>, from: number, to: number, level: number) => {
    const events: [number, string][] = [];
    for (let t = from; t < to; t += 60) {
      const e = d.feed(level, t);
      if (e) events.push([t, e]);
    }
    return events;
  };

  it('starts after sound lasts onsetMs, and ends after quietMs of quiet', () => {
    const d = new Detector();
    feed(d, 0, 900, 0.002);
    expect(feed(d, 900, 960, 0.2)).toEqual([]);
    expect(feed(d, 960, 1800, 0.2)).toEqual([[1020, 'start']]);
    expect(d.speechAt).toBe(900);
    const out = feed(d, 1800, 3300, 0.002);
    expect(out).toEqual([[2940, 'end']]); // quietMs after the last loud tick (1740)
    expect(d.speechAt).toBeNull();
  });

  it('drops a short sound (a cough), and a blip below onsetMs never starts', () => {
    const d = new Detector();
    feed(d, 0, 900, 0.002);
    expect(feed(d, 900, 960, 0.3)).toEqual([]);
    expect(feed(d, 960, 1500, 0.002)).toEqual([]);
    expect(feed(d, 1500, 1680, 0.3)).toEqual([[1620, 'start']]);
    expect(feed(d, 1680, 3300, 0.002)).toEqual([[2820, 'discard']]);
  });

  it('learns a steady noise before listening; a take without a pause is cut at maxMs and its level learned', () => {
    const fan = new Detector();
    expect(feed(fan, 0, 9000, 0.03)).toEqual([]);
    expect(feed(fan, 9000, 9300, 0.25)).toEqual([[9120, 'start']]);
    const d = new Detector({ maxMs: 2000 });
    feed(d, 0, 900, 0.002);
    // A fan switched on later: one cut take, then it is the room's level.
    expect(feed(d, 900, 6000, 0.03)).toEqual([
      [1020, 'start'],
      [2940, 'end'],
    ]);
    expect(feed(d, 6000, 6300, 0.25)).toEqual([[6120, 'start']]);
  });
});

describe('hands-free in the chat panel', () => {
  it('is on by default on a computer: the toggle shows pressed and the mic opens once', async () => {
    const h = setup();
    await h.start();
    h.run(120, 0.002);
    expect(h.btn().hidden).toBe(false);
    expect(h.btn().getAttribute('aria-pressed')).toBe('true');
    expect(h.state()).toBe('listening');
    expect(h.asked()).toBe(1);
  });

  it('speech then a pause sends a turn to the voice member, from a recorder that started before the speech', async () => {
    const h = setup();
    await h.start();
    h.run(6060, 0.002); // a second recorder starts at 6 s, overlapping the first
    expect(h.recs.filter((r) => r.state === 'recording')).toHaveLength(2);
    h.run(600, 0.2);
    expect(h.state()).toBe('hearing');
    expect(h.a._chatEls.voiceStatus.textContent).toContain('pause to send to Worker');
    h.run(1500, 0.002);
    await settle();
    // Speech began 60 ms after the second recorder started: the first one holds the first word.
    expect(h.sent).toEqual([{ how: 'turn', text: 'rec0', to: 'worker-id' }]);
    expect(h.a._chatEls.voiceStatus.textContent).toBe('');
    h.run(60, 0.002);
    expect(h.state()).toBe('listening');
  });

  it('when the newer recorder already has enough lead, the take uses it (less silence before the words)', async () => {
    const h = setup();
    await h.start();
    h.run(6060, 0.002); // recorder 1 starts at 6060 ms
    h.run(480, 0.002);
    h.run(600, 0.2); // speech from 6600 ms: 540 ms after recorder 1 started, recorder 0 still overlapping
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toEqual([{ how: 'turn', text: 'rec1', to: 'worker-id' }]);
    expect(h.recs[0].state).toBe('inactive');
  });

  it('dictation (no voice member) goes to the transcriber', async () => {
    const h = setup({ route: 'local' });
    await h.start();
    h.run(900, 0.002);
    h.run(600, 0.2);
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toEqual([{ how: 'stt', text: 'rec0' }]);
  });

  it('a reply playing holds listening and drops the unfinished take; it resumes after the hold-off', async () => {
    const h = setup();
    await h.start();
    h.run(900, 0.002);
    h.run(300, 0.2);
    h.a._chatAudio = { paused: false, ended: false, src: 'https://console.test/api/voice/speech/1' };
    h.run(120, 0.2);
    expect(h.state()).toBe('reply');
    h.run(2000, 0.002);
    h.a._chatAudio.ended = true;
    h.run(300, 0.2); // inside the 600 ms hold-off: the reply's tail is not heard
    expect(h.state()).toBe('listening');
    h.run(400, 0.002);
    await settle();
    expect(h.sent).toEqual([]);
    h.run(600, 0.2);
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toHaveLength(1);
  });

  it('the silent unlock clip is not a reply', async () => {
    const h = setup();
    await h.start();
    h.a._chatAudio = { paused: false, ended: false, src: 'https://console.test/silence.wav' };
    h.run(120, 0.002);
    expect(h.state()).toBe('listening');
  });

  it('read-aloud, a pending answer, sending, a dictation preview, typed text and push-to-talk each hold it', async () => {
    const h = setup();
    await h.start();
    const holds: [string, () => void, () => void][] = [
      ['reply', () => (h.a._readAloud = { current: {}, mute() {} }), () => (h.a._readAloud = null)],
      ['waiting', () => (h.a._chatVoiceTurnFor = 'worker-id'), () => (h.a._chatVoiceTurnFor = null)],
      ['busy', () => (h.a._hfSending = true), () => (h.a._hfSending = false)],
      ['preview', () => (h.a._dictationTimer = 1), () => (h.a._dictationTimer = null)],
      ['typing', () => (h.a._chatEls.input.value = 'half a thought'), () => (h.a._chatEls.input.value = '')],
      ['push-to-talk', () => (h.a._chatRecorder = {}), () => (h.a._chatRecorder = null)],
    ];
    for (const [state, on, off] of holds) {
      on();
      h.run(600, 0.2);
      expect(h.state()).toBe(state);
      off();
      h.run(800, 0.002);
      expect(h.state()).toBe('listening');
    }
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.asked()).toBe(1);
  });

  it('holds read-aloud while a take is recorded and releases it after', async () => {
    const h = setup();
    const muted: boolean[] = [];
    h.a._readAloud = { current: null, mute: (on: boolean) => muted.push(on) };
    await h.start();
    h.run(900, 0.002);
    h.run(600, 0.2);
    expect(muted).toEqual([true]);
    h.run(1500, 0.002);
    expect(muted).toEqual([true, false]);
  });

  it('switching off releases the mic and is remembered; switching on opens it again', async () => {
    const h = setup();
    await h.start();
    h.toggle();
    expect(h.tracks.stopped).toBe(1);
    expect(h.ctx.closed).toBe(1);
    expect(h.state()).toBe('off');
    expect(h.btn().getAttribute('aria-pressed')).toBe('false');
    expect(dom.window.localStorage.getItem('reverie:voiceMode:')).toBe('off');
    h.run(600, 0.2);
    expect(h.asked()).toBe(1);
    h.toggle();
    await settle();
    expect(dom.window.localStorage.getItem('reverie:voiceMode:')).toBe('panel');
    expect(h.asked()).toBe(2);
  });

  it('remembered off: a new page does not open the mic', async () => {
    const h = setup();
    dom.window.localStorage.setItem('reverie:handsFreeOff', '1');
    await h.start();
    h.run(600, 0.2);
    expect(h.asked()).toBe(0);
    expect(h.state()).toBe('off');
  });

  it('has a voice entry point on touch devices even when the composer mic is hidden', async () => {
    const h = setup({ micHidden: true });
    Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 2 });
    await h.start();
    h.run(600, 0.2);
    expect(h.btn().hidden).toBe(false);
    expect(h.asked()).toBe(0);
  });

  it('closing the panel, hiding the tab or opening car mode releases the mic', async () => {
    for (const leave of ['tab', 'car', 'panel']) {
      const h = setup();
      await h.start();
      h.run(600, 0.2);
      if (leave === 'tab') hidden = true;
      if (leave === 'car') h.a._carScreen = { hidden: false };
      if (leave === 'panel') h.close();
      h.run(120, 0.2);
      expect(h.tracks.stopped, leave).toBe(1);
      expect(
        h.recs.every((r) => r.state === 'inactive'),
        leave
      ).toBe(true);
      h.run(1500, 0.002);
      await settle();
      expect(h.sent, leave).toEqual([]);
    }
  });

  it('a refused mic is said once and not asked again until the toggle is clicked', async () => {
    const h = setup({ refuse: true });
    await h.start();
    h.run(600, 0.2);
    expect(h.asked()).toBe(1);
    expect(h.state()).toBe('blocked');
    expect(h.a._chatEls.voiceStatus.textContent).toContain('microphone blocked');
    h.choose('panel');
    await settle();
    expect(h.asked()).toBe(2);
    expect(dom.window.localStorage.getItem('reverie:voiceMode:')).toBe('panel');
  });

  it('before any click the audio is suspended: it says so, and the first click on the page starts it', async () => {
    const h = setup({ ctxState: 'suspended' });
    await h.start();
    h.run(600, 0.2);
    expect(h.state()).toBe('needs-click');
    expect(h.recs).toHaveLength(0);
    doc.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    await settle();
    expect(h.ctx.resumed).toBe(1);
    h.run(120, 0.002);
    expect(h.state()).toBe('listening');
  });
});

it('independent control: an existing server car screen cannot keep capturing in a room set to Voice Off', async () => {
  const h = setup();
  h.a._chatRoomId = 'room-with-voice-off';
  h.a._setRoomVoiceMode('off');
  h.a._hfService = { state: 'ready', message: 'fixture ready' };
  h.a._carScreen = { hidden: false };
  h.a._carEngine = 'server';
  h.a._carHfRender = () => {};
  await h.start();
  expect(h.asked()).toBe(0);
});

it('independent control: persisted car mode must not reopen while viewing an Embassy', async () => {
  const h = setup();
  h.a._setRoomVoiceMode('car');
  h.a._hfService = { state: 'ready', message: 'fixture ready' };
  h.a._chatApp = { embassy: { selected: 'external-fixture' } };
  let opened = 0;
  h.a.openCarMode = () => {
    opened++;
  };
  await h.start();
  expect(opened).toBe(0);
});

describe('voice capture follows room and view transitions', () => {
  for (const transition of ['off', 'room', 'embassy']) {
    it(`releases active capture and discards its take on ${transition}`, async () => {
      const h = setup();
      h.a._chatRoomId = 'original';
      h.a._setRoomVoiceMode('car');
      const screen = doc.createElement('div');
      h.a._carScreen = screen;
      h.a._carRoomId = 'original';
      h.a._carEngine = 'server';
      h.a._carHfRender = () => {};
      await h.start();
      h.run(900, 0.002);
      h.run(600, 0.2);
      expect(h.asked()).toBe(1);
      if (transition === 'off') h.a._setRoomVoiceMode('off');
      if (transition === 'room') {
        h.a._chatRoomId = 'another';
        h.a._setRoomVoiceMode('off');
      }
      if (transition === 'embassy') h.a._chatApp = { embassy: { selected: 'external' } };
      h.run(1500, 0.002);
      await settle();
      expect(h.tracks.stopped).toBe(1);
      expect(h.a._hfStream).toBeNull();
      expect(screen.hidden).toBe(true);
      expect(h.sent).toEqual([]);
    });

    it(`does not open a car screen after a pending health probe crosses ${transition}`, async () => {
      const h = setup();
      h.a._chatRoomId = 'original';
      let finish: (v: unknown) => void = () => {};
      h.a._chatApi = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      let built = 0;
      h.a._buildCarMode = () => {
        built++;
      };
      const pending = h.a.openCarMode();
      await settle();
      if (transition === 'off') h.a._setRoomVoiceMode('off');
      if (transition === 'room') {
        h.a._chatRoomId = 'another';
        h.a._setRoomVoiceMode('off');
      }
      if (transition === 'embassy') h.a._chatApp = { embassy: { selected: 'external' } };
      finish({ ok: true, data: { available: true } });
      await pending;
      expect(built).toBe(0);
      expect(h.asked()).toBe(0);
      if (transition !== 'embassy') expect(h.a._roomVoiceMode()).toBe('off');
    });
  }

  it('stops the browser recognizer when an active car screen leaves the local room', async () => {
    const h = setup();
    h.a._setRoomVoiceMode('car');
    h.a._carEngine = 'speech';
    h.a._carScreen = doc.createElement('div');
    let stopped = 0;
    h.a._car = {
      stop: () => {
        stopped++;
      },
    };
    h.a._chatApp = { embassy: { selected: 'external' } };
    await h.start();
    expect(stopped).toBe(1);
    expect(h.a._carScreen.hidden).toBe(true);
    expect(h.asked()).toBe(0);
  });

  it('releases a late microphone grant after switching to a different room', async () => {
    const h = setup();
    h.a._chatRoomId = 'original';
    let finish: (v: unknown) => void = () => {};
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    await h.start();
    h.a._chatRoomId = 'another';
    let stopped = 0;
    finish({
      getTracks: () => [
        {
          stop: () => {
            stopped++;
          },
        },
      ],
    });
    await settle();
    expect(stopped).toBe(1);
    expect(h.a._hfStream).toBeUndefined();
  });
});
