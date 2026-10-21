/**
 * Car mode, server engine, hands-free (hands-free.js + car-mode.js): talk, and a pause sends
 * the take to the car's voice member, on a phone too; the screen shows what it hears;
 * a tap pauses listening (the mic is released) and the next tap listens again. A member
 * that cannot take a spoken turn, or the speech engine, leaves the mic closed.
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
vm.runInContext('globalThis.CodemanApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js', 'hands-free.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('CodemanApp.prototype', context);
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
    run,
    start,
    asked: () => asked,
    state: () => btn().dataset.state,
    close: () => (open = false),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The car screen over the panel: phone (mic hidden), server engine, Worker as the voice. */
function car(opts: Parameters<typeof setup>[0] = {}, member: { sessionId: string; name: string; voice?: boolean } = WORKER) {
  const h = setup({ micHidden: true, ...opts });
  const screen = doc.createElement('div');
  for (const c of ['car-status', 'car-detail', 'car-hint']) screen.appendChild(doc.createElement('div')).className = c;
  h.a._carScreen = screen;
  h.a._carEngine = 'server';
  h.a._carVoiceMember = () => member;
  h.a._chatEls.to.value = '';
  const view = () => ({
    state: screen.dataset.state,
    detail: screen.querySelector('.car-detail')!.textContent,
    hint: screen.querySelector('.car-hint')!.textContent,
  });
  return { ...h, screen, view };
}

describe('car mode hands-free (server engine)', () => {
  it('on a phone, even with the desktop toggle off: speech is shown as heard and a pause sends it to the voice member', async () => {
    const h = car();
    dom.window.localStorage.setItem('codeman:handsFreeOff', '1');
    await h.start();
    expect(h.asked()).toBe(1);
    h.run(900, 0.002);
    expect(h.view()).toMatchObject({ state: 'listening', hint: 'Just talk, pause to send. Tap anywhere to pause.' });
    h.run(600, 0.2);
    expect(h.view()).toMatchObject({ state: 'listening', detail: 'Hearing you… pause to send to Worker' });
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ how: 'turn', to: 'worker-id' });
    expect(h.a._chatEls.to.value).toBe('worker-id');
  });

  it('a tap pauses: the mic is released and speech is not sent; the next tap listens again', async () => {
    const h = car();
    await h.start();
    h.run(900, 0.002);
    h.a._carTap();
    expect(h.tracks.stopped).toBe(1);
    expect(h.view()).toMatchObject({ state: 'paused', hint: 'Tap anywhere to listen' });
    h.run(1500, 0.2);
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.asked()).toBe(1);
    h.a._carTap();
    await settle();
    expect(h.asked()).toBe(2);
    h.run(900, 0.002);
    expect(h.view().state).toBe('listening');
    h.run(600, 0.2);
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toHaveLength(1);
  });

  it('a tap mid-take drops the take', async () => {
    const h = car();
    await h.start();
    h.run(900, 0.002);
    h.run(600, 0.2);
    h.a._carTap();
    h.run(1500, 0.002);
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.view().state).toBe('paused');
  });

  it('listening again after an answer keeps the answer on screen', async () => {
    const h = car();
    await h.start();
    h.run(900, 0.002);
    h.a._chatVoiceTurnFor = 'worker-id';
    h.run(120, 0.002);
    h.a._renderCarState('paused', 'hello from Worker');
    h.a._chatVoiceTurnFor = null;
    h.run(900, 0.002);
    expect(h.view()).toMatchObject({ state: 'listening', detail: 'hello from Worker' });
  });

  it('the speech engine, or a member that cannot take a spoken turn, leaves the mic closed and taps push-to-talk as before', async () => {
    const speech = car();
    speech.a._carEngine = 'speech';
    await speech.start();
    speech.run(600, 0.2);
    expect(speech.asked()).toBe(0);
    const dm = car({}, { sessionId: 'dm-id', name: 'Tester' });
    await dm.start();
    dm.run(600, 0.2);
    expect(dm.asked()).toBe(0);
    expect(dm.a._carHandsFree()).toBe(false);
  });

  it('a refused mic falls back to tap-to-talk', async () => {
    const h = car({ refuse: true });
    await h.start();
    h.run(120, 0.002);
    expect(h.view()).toMatchObject({ state: 'paused', detail: 'The microphone was refused: tap to talk instead' });
    expect(h.view().hint).toBe('Tap anywhere to talk, tap again to send');
  });
});
