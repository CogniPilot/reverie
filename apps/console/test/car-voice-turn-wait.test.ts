/**
 * Car mode, server engine: the wait for a member's linked answer (/api/voice/turn) can be
 * minutes long. The screen says whom it waits for, a tap stops the wait (the request is
 * aborted, so the server releases the member), and the next tap talks again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
// The shell loader revalidates assets with fetch as chatroom-ui.js loads: keep it off the network.
vm.runInContext('globalThis.CodemanApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('CodemanApp.prototype', context);
const doc = dom.window.document;
afterAll(() => dom.window.close());

type Call = { url: string; signal: AbortSignal; answer: (r: unknown) => void; fail: (e: unknown) => void };
const WORKER = { sessionId: 'worker-id', name: 'Worker', voice: true };

function setup() {
  const calls: Call[] = [];
  context.fetch = (url: string, opts: { signal: AbortSignal }) =>
    new Promise((answer, fail) => {
      calls.push({ url, signal: opts.signal, answer, fail });
      opts.signal?.addEventListener('abort', () => fail(opts.signal.reason));
    });
  const screen = doc.createElement('div');
  for (const c of ['car-status', 'car-detail', 'car-hint']) screen.appendChild(doc.createElement('div')).className = c;
  const a = Object.create(Proto);
  a._carScreen = screen;
  a._carEngine = 'server';
  a._carVoiceMember = () => WORKER;
  a._chatRoomId = 'room-1';
  a._chatUrl = (u: string) => u;
  a._unlockChatAudio = () => {};
  a._syncChatMic = () => {};
  a._chatEls = { voiceStatus: doc.createElement('div'), to: { value: '' }, mic: doc.createElement('button') };
  let started = 0;
  a._startChatRecording = () => void started++;
  const view = () => ({
    state: screen.dataset.state,
    status: screen.querySelector('.car-status')!.textContent,
    detail: screen.querySelector('.car-detail')!.textContent,
    hint: screen.querySelector('.car-hint')!.textContent,
    voiceStatus: a._chatEls.voiceStatus.textContent,
  });
  return { a, calls, view, started: () => started };
}
const blob = { type: 'audio/webm;codecs=opus' };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('car mode: waiting for the linked answer', () => {
  it('says whom it waits for, and that a tap stops waiting', async () => {
    const { a, calls, view } = setup();
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/voice/turn?room=room-1&member=worker-id');
    expect(view()).toMatchObject({
      state: 'thinking',
      detail: "Waiting for Worker's answer",
      hint: 'Tap to stop waiting',
    });
    calls[0].answer({ ok: true, json: async () => ({ success: true, data: { heard: 'hi', reply: 'hello' } }) });
    await turn;
    expect(view()).toMatchObject({ state: 'paused', detail: 'hello' });
    expect(a._chatVoiceTurnStop).toBeNull();
  });

  it('a tap during the wait aborts the request, says the answer will show in the room, and the next tap talks', async () => {
    const { a, calls, view, started } = setup();
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    a._carTap();
    expect(calls[0].signal.aborted).toBe(true);
    expect(started()).toBe(0);
    await turn;
    expect(view()).toMatchObject({ state: 'paused', detail: "Stopped waiting; Worker's answer will show in the room" });
    expect(view().voiceStatus).toBe('');
    expect(a._chatVoiceTurnStop).toBeNull();
    a._carTap();
    expect(started()).toBe(1);
    expect(view().state).toBe('listening');
  });

  it('a tap while the answer body is still arriving also stops cleanly', async () => {
    const { a, calls, view } = setup();
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    let failBody: (e: unknown) => void = () => {};
    calls[0].answer({ ok: true, json: () => new Promise((_, f) => (failBody = f)) });
    await tick();
    a._carTap();
    failBody(new Error('body aborted'));
    await turn;
    expect(view()).toMatchObject({ state: 'paused', detail: "Stopped waiting; Worker's answer will show in the room" });
  });

  it('a real network failure is still an error, on the car screen too', async () => {
    const { a, calls, view } = setup();
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    calls[0].fail(new TypeError('fetch failed'));
    await turn;
    expect(view()).toMatchObject({ state: 'paused', detail: 'Network error: the recording was not sent' });
    expect(view().voiceStatus).toBe('Network error: the recording was not sent');
  });

  it('the server giving up (no linked answer) shows its message and frees the next tap', async () => {
    const { a, calls, view, started } = setup();
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    const error = 'No reply from Worker yet; the answer will show in the room';
    calls[0].answer({ ok: false, status: 504, json: async () => ({ success: false, error }) });
    await turn;
    expect(view()).toMatchObject({ state: 'paused', detail: error });
    a._carTap();
    expect(started()).toBe(1);
  });

  it('an answer without audio says so instead of going quiet', async () => {
    const { a, calls, view } = setup();
    const played: string[] = [];
    a._playChatAudio = (u: string) => void played.push(u);
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    calls[0].answer({
      ok: true,
      json: async () => ({ success: true, data: { heard: true, reply: 'hello', audioUrl: null } }),
    });
    await turn;
    expect(played).toEqual([]);
    expect(view().voiceStatus).toBe("Couldn't make audio for Worker's answer; its text is in the room");
  });

  it('an answer with audio plays it and leaves the status clear', async () => {
    const { a, calls, view } = setup();
    const played: string[] = [];
    a._playChatAudio = (u: string) => void played.push(u);
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    const audioUrl = '/api/voice/audio/abc';
    calls[0].answer({
      ok: true,
      json: async () => ({ success: true, data: { heard: true, reply: 'hello', audioUrl } }),
    });
    await turn;
    expect(played).toEqual([audioUrl]);
    expect(view().voiceStatus).toBe('');
  });

  it('the hint for talking is unchanged outside the wait', () => {
    const { a, view } = setup();
    a._renderCarState('paused', '');
    expect(view().hint).toBe('Tap anywhere to talk, tap again to send');
  });
});
