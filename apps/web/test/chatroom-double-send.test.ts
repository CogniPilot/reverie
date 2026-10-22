/**
 * Composer: a double tap (or Enter plus the button) while the first send is still in flight must not post the text again.
 * The box is only emptied once the server answers, so without a guard every extra tap re-sent the same words.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chatroom-ui.js'), 'utf8'), context);
afterAll(() => dom.window.close());

type Answer = { ok: boolean; status?: number; errorCode?: string; error?: string; data?: unknown };
// A stored send's answer carries the stored message (without it the page cannot confirm the send).
const stored = (): Answer => ({ ok: true, data: { message: { id: 'p1', text: 'I ran it' } } });

function composer(api: (url: string, o: unknown) => Promise<Answer>) {
  const self = vm.runInContext('Object.create(ReverieApp.prototype)', context) as Record<string, unknown>;
  const input = { value: 'I ran it', focus() {} };
  Object.assign(self, {
    _chatEls: { input, to: { value: '' }, send: { disabled: false } },
    _chatRoomId: 'r1',
    _chatApi: api,
    showToast() {},
  });
  return { self: self as { _sendChatMessage(): Promise<void> }, input };
}

describe('_sendChatMessage', () => {
  it('posts once however many times it is triggered before the answer', async () => {
    const posts: unknown[] = [];
    let answer!: (v: Answer) => void;
    const { self, input } = composer((_u, o) => {
      posts.push(o);
      return new Promise((r) => (answer = r));
    });
    const sends = [self._sendChatMessage(), self._sendChatMessage(), self._sendChatMessage()];
    answer(stored());
    await Promise.all(sends);
    expect(posts).toHaveLength(1);
    expect(input.value).toBe('');
  });

  it('sends again after the first has finished, and after a failure', async () => {
    // A documented refusal: the text stays to send again. A lost answer is held instead (chatroom-send-feedback.test.ts).
    let calls = 0;
    const { self, input } = composer(async () => (++calls > 1 ? stored() : { ok: false, status: 400, errorCode: 'INVALID_INPUT', error: 'No' }));
    await self._sendChatMessage(); // fails: text stays
    expect(input.value).toBe('I ran it');
    await self._sendChatMessage();
    expect(calls).toBe(2);
    expect(input.value).toBe('');
  });
});
