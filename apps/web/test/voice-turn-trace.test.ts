/**
 * One id per spoken turn (push-to-talk, /api/voice/turn): the press, the recording, the request (X-Reverie-Voice-Turn),
 * the server's stage times and the reply's playback all appear in the client trace under the same id.
 */
import { afterAll, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('ReverieApp.prototype', context);
const doc = dom.window.document;
afterAll(() => dom.window.close());
dom.window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

const WORKER = { sessionId: 'worker-id', name: 'Worker', voice: true };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(answer: unknown) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  context.fetch = (url: string, opts: { headers: Record<string, string> }) => {
    sent.push({ url, headers: opts.headers });
    return Promise.resolve({ ok: true, status: 200, json: async () => answer });
  };
  // A recorder that hands over a recording as soon as it is stopped.
  context.MediaRecorder = class {
    static isTypeSupported() { return true; }
    mimeType = 'audio/webm';
    state = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new dom.window.Blob(['x'.repeat(2000)]) }); this.onstop?.(); }
  };
  Object.defineProperty(context.navigator, 'mediaDevices', { configurable: true,
    value: { getUserMedia: async () => ({ getAudioTracks: () => [{}], getTracks: () => [{ stop() {} }] }) } });
  const a = Object.create(Proto);
  a._chatRoomId = 'room-1';
  a._chatUrl = (u: string) => u;
  a._chatMicRoute = () => 'turn';
  a._chatVoiceTarget = () => WORKER;
  a._chatEls = { voiceStatus: doc.createElement('div'), mic: doc.createElement('button') };
  a._diagLines = [];
  const trace = (kind: string) => a._diagLines.filter((line: string) => line.split(' ')[1] === kind)
    .map((line: string) => JSON.parse(line.slice(line.indexOf('{'))));
  return { a, sent, trace };
}

it('carries one turn id from the press through the request, the server timings and the playback', async () => {
  const { a, sent, trace } = setup({ success: true, data: { heard: true, transcript: 'hi', reply: 'Hello.', audioUrl: '/api/voice/audio/r1.wav',
    messages: [{ id: 'asked-id' }, { id: 'answer-id' }], turnId: 'ignored-by-client', timing: { sttMs: 400, answerMs: 2100, ttsMs: 300 } } });
  await a._startChatRecording();
  const [start] = trace('voice:capture-start');
  expect(start.turnId).toMatch(/^[0-9a-f-]{32,36}$/);
  expect(start.member).toBe('worker-id');
  a._stopChatRecording();
  await tick(); await tick();
  const id = start.turnId;
  expect(trace('voice:capture-end')).toEqual([expect.objectContaining({ turnId: id, bytes: 2000 })]);
  expect(sent).toHaveLength(1);
  expect(sent[0].headers['X-Reverie-Voice-Turn']).toBe(id);
  expect(trace('voice:turn-sent')).toEqual([expect.objectContaining({ turnId: id })]);
  expect(trace('voice:turn-answered')).toEqual([expect.objectContaining({ turnId: id, status: 200, messageId: 'asked-id', answerId: 'answer-id',
    timing: { sttMs: 400, answerMs: 2100, ttsMs: 300 } })]);
  a._chatAudio.dispatchEvent(new dom.window.Event('playing'));
  a._chatAudio.dispatchEvent(new dom.window.Event('ended'));
  expect(trace('audio:playing')[0].turnId).toBe(id);
  expect(trace('audio:ended')[0].turnId).toBe(id);
});

it('keeps dictation and read-aloud out of turn tracing: no id, no header', async () => {
  const { a, sent, trace } = setup({ success: true, data: { heard: true, reply: 'Hi.', audioUrl: '/api/voice/audio/r2.wav', messages: [] } });
  await a._sendChatVoice({ type: 'audio/webm' }, WORKER);
  expect(sent[0].headers['X-Reverie-Voice-Turn']).toBeUndefined();
  expect(trace('voice:turn-sent')).toEqual([]);
  a._chatAudio.dispatchEvent(new dom.window.Event('playing'));
  expect(trace('audio:playing')[0].turnId).toBeUndefined();
});
