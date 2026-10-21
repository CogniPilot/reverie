import { afterEach, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const opened: JSDOM[] = [];
afterEach(() => { for (const dom of opened.splice(0)) dom.window.close(); });
function fixture(userAgent: string, mobile?: boolean, width = 390) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' }); opened.push(dom);
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: userAgent });
  if (mobile !== undefined) Object.defineProperty(dom.window.navigator, 'userAgentData', { value: { mobile } });
  Object.defineProperty(dom.window, 'innerWidth', { value: width });
  const context = dom.getInternalVMContext();
  vm.runInContext('globalThis.CodemanApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chatroom-ui.js'), 'utf8'), context);
  const app = vm.runInContext('Object.create(CodemanApp.prototype)', context);
  const mic = dom.window.document.createElement('button'), car = dom.window.document.createElement('button');
  Object.assign(app, { _chatEls: { mic }, _chatroomPanel: { querySelector: () => car }, _chatRoom: { members: [{ voice: true }] }, _chatVoiceTarget: () => ({ name: 'Worker' }), _chatMicRoute: () => 'local' });
  return { app, mic, car };
}
describe('phone composer mic policy', () => {
  it.each([390, 915])('hides Android dictation while preserving Car mode at width %i', width => {
    const { app, mic, car } = fixture('Mozilla/5.0 (Linux; Android 10; K) Chrome/155 Mobile', true, width);
    app._syncChatMic(); expect(mic.hidden).toBe(true); expect(car.hidden).toBe(false);
    app._chatMicRoute = () => 'turn'; app._syncChatMic(); expect(mic.hidden).toBe(true); expect(car.hidden).toBe(false);
  });
  it('recognizes iPhone without client hints', () => {
    const { app, mic, car } = fixture('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    app._syncChatMic(); expect(mic.hidden).toBe(true); expect(car.hidden).toBe(false);
  });
  it('keeps desktop dictation even in a narrow window', () => {
    const { app, mic, car } = fixture('Mozilla/5.0 (X11; Linux x86_64) Chrome/155', false, 390);
    app._syncChatMic(); expect(mic.hidden).toBe(false); expect(car.hidden).toBe(false);
    app._chatMicRoute = () => null; app._syncChatMic(); expect(mic.hidden).toBe(true);
  });
});
