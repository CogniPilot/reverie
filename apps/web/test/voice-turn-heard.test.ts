/**
 * A spoken turn shows what was heard while it waits: the server posts the transcript to the
 * room before waiting for the answer, and the panel (or car screen) shows it with a way to stop.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
// The shell loader revalidates assets with fetch as chatroom-ui.js loads: keep it off the network.
vm.runInContext('globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
for (const f of ['chatroom-ui.js', 'voice-chat.js', 'car-mode.js'])
  vm.runInContext(readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8'), context);
const Proto = vm.runInContext('ReverieApp.prototype', context);
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
  a._readAloudOnMessage = () => {};
  a._chatShowMessage = () => {};
  a._chatEl = (tag: string, cls: string, text: string) => Object.assign(doc.createElement(tag), { className: cls, textContent: text });
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

const heard = (over: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => ({
  roomId: 'room-1',
  message: { id: 'm1', text: 'what time is it', spoken: true, from: { kind: 'user', name: 'Owner' }, to: ['worker-id'], ...msg },
  ...over,
});

describe('a spoken turn shows what it heard while it waits', () => {
  it('on the desktop panel: the transcript, whom it waits for, and a Stop waiting button that aborts', async () => {
    const { a, calls, view } = setup();
    a._carScreen.hidden = true;
    const turn = a._sendChatVoice(blob, WORKER);
    await tick();
    a._onChatroomMessage(heard());
    expect(view().voiceStatus).toContain('Heard \u201Cwhat time is it\u201D. Waiting for Worker');
    const button = a._chatEls.voiceStatus.querySelector('button');
    expect(button.textContent).toBe('Stop waiting');
    button.click();
    expect(calls[0].signal.aborted).toBe(true);
    await turn;
    expect(view().voiceStatus).toBe('');
  });

  it('in car mode: the big screen says what it heard and whom it waits for', async () => {
    const { a, view } = setup();
    a._sendChatVoice(blob, WORKER);
    await tick();
    a._onChatroomMessage(heard());
    expect(view()).toMatchObject({
      state: 'thinking',
      detail: 'You said \u201Cwhat time is it\u201D. Waiting for Worker',
      hint: 'Tap to stop waiting',
    });
  });

  it('ignores messages that are not this turn: typed, from an agent, to someone else, another room, or no turn', async () => {
    const { a, view } = setup();
    a._onChatroomMessage(heard());
    expect(view().detail).toBe('');
    a._sendChatVoice(blob, WORKER);
    await tick();
    const before = view().detail;
    for (const m of [
      heard({}, { spoken: undefined }),
      heard({}, { from: { kind: 'agent', name: 'Worker', sessionId: 'worker-id' } }),
      heard({}, { to: ['other-id'] }),
      heard({ roomId: 'room-2' }),
    ])
      a._onChatroomMessage(m);
    expect(view().detail).toBe(before);
  });
});
