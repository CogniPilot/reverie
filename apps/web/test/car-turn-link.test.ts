/** Car conversations speak one exact linked answer, with real controller/glue and fake browser APIs. */
import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  vi.useFakeTimers();
  const dom = new JSDOM('<div id="car"></div>', { url: 'https://console.test/', runScripts: 'outside-only' });
  cleanups.push(() => dom.window.close());
  const ctx = dom.getInternalVMContext();
  ctx.ReverieApp = class {};
  ctx.Date = Date;
  for (const file of ['voice-chat.js', 'car-mode.js'])
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8'), ctx);
  const get = (name: string) => vm.runInContext(name, ctx);
  const a = Object.create(get('ReverieApp').prototype);
  a._chatRoomId = 'room';
  a._carOpenGeneration = 1;
  a._carScreen = dom.window.document.querySelector('#car');
  a._chatRoom = { id: 'room', members: [{ sessionId: 'voice', name: 'Voice', voice: true }], messages: [] };
  a._roomVoiceMode = () => 'car';
  const traces: Array<{ kind: string; data: unknown }> = [];
  const states: Array<[string, string]> = [];
  a._diag = (kind: string, data: unknown) => traces.push({ kind, data });
  const batches: Array<Array<{ text: string; onend?: () => void }>> = [];
  const synth = {
    speaking: false,
    pending: false,
    cancel: () => {},
    speakReply: (batch: (typeof batches)[number]) => batches.push(batch),
  };
  const requests: Array<{
    path: string;
    options: { body: { text: string; to: string[]; spoken: boolean } };
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  a._chatApi = (path: string, options: (typeof requests)[number]['options']) =>
    new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
  const controller = () =>
    new (get('CarModeController'))({
      createRecognition: () => ({ start() {}, abort() {} }),
      createUtterance: (text: string) => ({ text }),
      synth,
      voice: () => null,
      send: (text: string) => a._carSend(text),
      onState: (state: string, detail: string) => states.push([state, detail]),
      now: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout,
    });
  a._car = controller();
  cleanups.push(() => a._car?.stop());
  const begin = (text = 'A private spoken question') => {
    a._car.start();
    return a._car._final(text);
  };
  const ack = (id = 'q1', n = requests.length - 1, extra = {}) =>
    requests[n].resolve({
      ok: true,
      data: {
        message: { id, roomId: 'room', from: { kind: 'user', name: 'Owner' }, to: ['voice'], spoken: true, ...extra },
      },
    });
  const event = (id: string, replyTo: string | undefined, text = 'A linked answer.', extra = {}) => ({
    roomId: 'room',
    message: {
      id,
      roomId: 'room',
      from: { kind: 'agent', sessionId: 'voice', name: 'Voice' },
      text,
      to: ['user'],
      ...(replyTo ? { replyTo } : {}),
      ...extra,
    },
  });
  return { a, batches, requests, traces, states, begin, ack, event, controller };
}

it('does not let an unrelated aside displace the answer to the acknowledged spoken question', async () => {
  const h = fixture();
  const sending = h.begin();
  h.ack();
  await sending;
  h.a._carModeOnMessage(h.event('aside', undefined, 'An unrelated long status.'));
  h.a._carModeOnMessage(h.event('old', 'earlier', 'An old answer.'));
  expect(h.batches).toHaveLength(0);
  expect(h.a._car.state).toBe('thinking');
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.batches.map((batch) => batch.map((u) => u.text))).toEqual([['A linked answer.']]);
});

it('holds a linked answer that arrives before HTTP acknowledgement and plays it once after identity is confirmed', async () => {
  const h = fixture();
  const sending = h.begin();
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.batches).toHaveLength(0);
  h.ack();
  await sending;
  expect(h.batches).toHaveLength(1);
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.batches).toHaveLength(1);
});

it('speaks equal valid answers to different questions while rejecting duplicate events for either question', async () => {
  const h = fixture();
  let sending = h.begin('Question one');
  h.ack('q1');
  await sending;
  h.a._carModeOnMessage(h.event('a1', 'q1', 'Yes.'));
  h.batches[0].at(-1)?.onend?.();
  sending = h.begin('Question two');
  h.ack('q2');
  await sending;
  h.a._carModeOnMessage(h.event('a1', 'q1', 'Yes.'));
  h.a._carModeOnMessage(h.event('a2', 'q2', 'Yes.'));
  expect(h.batches.map((batch) => batch.map((u) => u.text))).toEqual([['Yes.'], ['Yes.']]);
});

it('does not let a late failed send change a stopped controller back to paused', async () => {
  const h = fixture();
  const sending = h.begin();
  h.a._car.stop();
  h.requests[0].reject(new Error('late network failure'));
  await sending;
  expect(h.a._car.state).toBe('off');
  expect(h.batches).toHaveLength(0);
});

it('does not speak unsolicited voice posts before any spoken question', () => {
  const h = fixture();
  h.a._car.start();
  h.a._carModeOnMessage(h.event('broadcast', undefined, 'A routine status.'));
  expect(h.batches).toHaveLength(0);
  expect(h.a._car.state).toBe('listening');
});

it('ignores wrong-room, wrong-author, deleted and other-recipient replies', async () => {
  const h = fixture();
  const sending = h.begin();
  h.ack();
  await sending;
  const wrongRoom = h.event('foreign', 'q1');
  wrongRoom.roomId = 'another-room';
  for (const event of [
    wrongRoom,
    h.event('other-author', 'q1', 'No', { from: { kind: 'agent', sessionId: 'other', name: 'Other' } }),
    h.event('deleted', 'q1', 'No', { deleted: { at: 1, by: 'user' } }),
    h.event('private', 'q1', 'No', { to: ['someone-else'] }),
    h.event('server', 'q1', 'No', { voice: true }),
  ])
    h.a._carModeOnMessage(event);
  expect(h.batches).toHaveLength(0);
  h.a._carModeOnMessage(h.event('correct', 'q1'));
  expect(h.batches).toHaveLength(1);
});

it.each([{ id: '' }, { roomId: 'other' }, { from: { kind: 'agent' } }, { spoken: false }, { to: ['other'] }])(
  'treats a mismatched HTTP confirmation as unconfirmed without resending: %j',
  async (extra) => {
    const h = fixture();
    const sending = h.begin();
    h.ack('q1', 0, extra);
    await sending;
    h.a._carModeOnMessage(h.event('answer', 'q1'));
    expect(h.a._car.state).toBe('paused');
    expect(h.requests).toHaveLength(1);
    expect(h.batches).toHaveLength(0);
  }
);

it('shows an unknown network outcome without an automatic duplicate post or late playback', async () => {
  const h = fixture();
  const sending = h.begin();
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  h.requests[0].resolve({ ok: false, error: 'Network error' });
  await sending;
  expect(h.a._car.state).toBe('paused');
  expect(h.states.at(-1)?.[1]).toContain('Not confirmed');
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.requests).toHaveLength(1);
  expect(h.batches).toHaveLength(0);
});

it.each(['room', 'member', 'off', 'embassy', 'generation'])(
  'drops pending replies across a %s transition',
  async (transition) => {
    const h = fixture();
    const sending = h.begin();
    h.a._carModeOnMessage(h.event('answer', 'q1'));
    if (transition === 'room') h.a._chatRoomId = 'other';
    if (transition === 'member') h.a._chatRoom.members = [{ sessionId: 'other', voice: true }];
    if (transition === 'off') h.a._roomVoiceMode = () => 'off';
    if (transition === 'embassy') h.a._chatApp = { embassy: { selected: true } };
    if (transition === 'generation') h.a._carOpenGeneration++;
    h.ack();
    await sending;
    h.a._carModeOnMessage(h.event('answer', 'q1'));
    expect(h.batches).toHaveLength(0);
  }
);

it('closing and reopening cannot replay a reply from the old controller', async () => {
  const h = fixture();
  const sending = h.begin();
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  h.a.closeCarMode();
  h.a._carScreen.hidden = false;
  h.a._car = h.controller();
  h.a._car.start();
  h.ack();
  await sending;
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.batches).toHaveLength(0);
  expect(h.a._car.state).toBe('listening');
});

it('a newer spoken question supersedes a cancelled send and ignores its late acknowledgement and answer', async () => {
  const h = fixture();
  const first = h.begin('First question');
  h.a._car.tap();
  const second = h.begin('Second question');
  h.a._carModeOnMessage(h.event('old-answer', 'q1', 'Old answer.'));
  h.a._carModeOnMessage(h.event('new-answer', 'q2', 'New answer.'));
  h.ack('q1', 0);
  await first;
  h.ack('q2', 1);
  await second;
  expect(h.batches.map((batch) => batch.map((u) => u.text))).toEqual([['New answer.']]);
});

it('bounds early replies and reports an unconfirmed answer instead of guessing or reposting', async () => {
  const h = fixture();
  const sending = h.begin();
  for (let i = 0; i < 40; i++) h.a._carModeOnMessage(h.event('reply-' + i, 'older-' + i));
  expect(h.a._carTurn.early.length).toBeLessThanOrEqual(32);
  h.ack();
  await sending;
  expect(h.a._car.state).toBe('paused');
  expect(h.batches).toHaveLength(0);
  expect(h.requests).toHaveLength(1);
});

it('does not lose a matching answer already in the bounded early buffer', async () => {
  const h = fixture();
  const sending = h.begin();
  h.a._carModeOnMessage(h.event('correct', 'q1'));
  for (let i = 0; i < 40; i++) h.a._carModeOnMessage(h.event('reply-' + i, 'older-' + i));
  h.ack();
  await sending;
  expect(h.batches).toHaveLength(1);
});

it('records turn-linked post, reply and synthesis timings without transcript text', async () => {
  const h = fixture();
  const sending = h.begin('private microphone words');
  h.ack();
  await sending;
  h.a._carModeOnMessage(h.event('answer', 'q1', 'Private reply.'));
  expect(h.batches[0][0]).toMatchObject({ turnId: 'q1', replyMessageId: 'answer' });
  const diag = (kind: string, data: unknown) => h.traces.push({ kind, data });
  const team = h.a._carTeamSynth({ speaking: false, pending: false, getVoices: () => [] }, diag);
  const audio = team.deps.fetchAudio('Private reply.', h.batches[0][0]);
  h.requests.at(-1)!.resolve({
    ok: true,
    data: { audioUrl: '/api/voice/speech/clip', engine: 'kokoro', voice: { provider: 'kokoro', id: 'am_michael' } },
  });
  await audio;
  expect(h.traces.find((item) => item.kind === 'voice:post-confirmed')?.data).toMatchObject({ messageId: 'q1' });
  expect(h.traces.find((item) => item.kind === 'voice:linked-reply')?.data).toMatchObject({
    replyTo: 'q1',
    messageId: 'answer',
  });
  expect(h.traces.find((item) => item.kind === 'team:request')?.data).toMatchObject({
    turnId: 'q1',
    messageId: 'answer',
  });
  expect(h.traces.find((item) => item.kind === 'team:speak')?.data).toMatchObject({
    turnId: 'q1',
    voice: 'am_michael',
    audioUrl: '/api/voice/speech/clip',
  });
  expect(JSON.stringify(h.traces)).not.toContain('private microphone words');
  expect(JSON.stringify(h.traces)).not.toContain('Private reply.');
  await flush();
});

it('keeps an explicit HTTP refusal separate from an unknown delivery outcome', async () => {
  const h = fixture();
  const sending = h.begin();
  h.requests[0].resolve({ ok: false, status: 403, error: 'Voice posting was refused' });
  await sending;
  expect(h.a._car.state).toBe('paused');
  expect(h.states.at(-1)?.[1]).toContain('Not sent');
  expect(h.states.at(-1)?.[1]).toContain('Voice posting was refused');
  expect(h.requests).toHaveLength(1);
});

it('bounds message confirmation without reposting or playing a late answer', async () => {
  const h = fixture();
  const sending = h.begin();
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.a._car.state).toBe('paused');
  expect(h.states.at(-1)?.[1]).toContain('Not confirmed');
  expect(h.requests).toHaveLength(1);
  expect(h.batches).toHaveLength(0);
  h.ack();
  await sending;
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.a._car.state).toBe('paused');
  expect(h.batches).toHaveLength(0);
});

it('does not apply the confirmation deadline to an acknowledged question waiting for its answer', async () => {
  const h = fixture();
  const sending = h.begin();
  h.ack();
  await sending;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.a._car.state).toBe('thinking');
  h.a._carModeOnMessage(h.event('answer', 'q1'));
  expect(h.batches).toHaveLength(1);
});
