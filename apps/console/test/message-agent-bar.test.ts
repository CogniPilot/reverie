/**
 * "Message <agent>" box under an agent terminal: opens the DM, posts the text as a chat message, clears the box,
 * sends only once at a time, and keeps the text when the server refuses.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const ui = readFileSync(resolve('src/web/public/session-ui.js'), 'utf8');

function load() {
  const body = ui.replace(/^[\s\S]*?(?=\n  async _sendMessageToAgent\()/, 'return {').replace(/\n  \/\*\* Footer chip[\s\S]*$/, '\n}');
  return vm.runInContext(`(function(){${body}})()`, vm.createContext({})) as Record<string, (...a: unknown[]) => Promise<void>>;
}

function bar(text: string) {
  const input = { value: text };
  return { input, el: { dataset: { sessionId: 's1' } as Record<string, string>, querySelector: () => input } };
}

describe('_sendMessageToAgent', () => {
  it('opens the DM, posts the text, and clears the box', async () => {
    const calls: Array<[string, unknown]> = [];
    const self = Object.assign(load(), {
      _chatApi: async (url: string, o: { body: unknown }) => (calls.push([url, o.body]), url.endsWith('/dms') ? { ok: true, data: { id: 'room 1' } } : { ok: true, data: {} }),
      showToast() {},
    });
    const { input, el } = bar('  hello Jinx ');
    await self._sendMessageToAgent(el);
    expect(calls).toEqual([
      ['/api/chatrooms/dms', { sessionId: 's1' }],
      ['/api/chatrooms/room%201/messages', { text: 'hello Jinx' }],
    ]);
    expect(input.value).toBe('');
  });

  it('keeps the text on a refusal and sends once while one is in flight', async () => {
    let posts = 0;
    let release!: () => void;
    const self = Object.assign(load(), {
      _chatApi: (url: string) => {
        if (url.endsWith('/dms')) return new Promise((r) => (release = () => r({ ok: true, data: { id: 'r' } })));
        posts++;
        return Promise.resolve({ ok: false, error: 'nope' });
      },
      showToast() {},
    });
    const { input, el } = bar('hi');
    const a = self._sendMessageToAgent(el);
    const b = self._sendMessageToAgent(el);
    release();
    await Promise.all([a, b]);
    expect(posts).toBe(1);
    expect(input.value).toBe('hi');
  });
});
