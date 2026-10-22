/**
 * The phone path: in the default chat view chat-app.js owns the feed, and its visualViewport handler must keep the newest
 * message in view through a keyboard open, close or resize, but only for a reader who was at the bottom.
 */
import { describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const rooms = () => [room('r1', 'General', [member(A, 'alpha')], { messages: [message('m1', 'r1', agent(A, 'alpha'), 'hello', 1000)] })];
const frame = () => new Promise((resolve) => setTimeout(resolve, 50));

async function phone() {
  const h = await createHarness({ rooms: rooms(), sessions: [{ id: A, name: 'alpha', mode: 'claude' }], viewport: { height: 800 } });
  const feed = h.document.querySelector('.chatroom-feed') as HTMLElement;
  // jsdom has no layout: give the feed a 2000 px list in a 400 px window.
  Object.defineProperty(feed, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(feed, 'clientHeight', { value: 400, configurable: true });
  const keyboard = async (height: number) => {
    (h.window as any).visualViewport.height = height;
    (h.window as any).visualViewport.dispatchEvent(new h.window.Event('resize'));
    await frame();
  };
  return { h, feed, keyboard };
}

describe('keyboard resize in the chat view', () => {
  it('keeps a reader at the bottom on the newest message when the keyboard opens, closes and resizes', async () => {
    const { feed, keyboard } = await phone();
    for (const height of [450, 800, 500]) {
      feed.scrollTop = 0;
      await keyboard(height);
      expect(feed.scrollTop).toBe(2000);
    }
  });

  it('leaves a reader who scrolled up into history where they are', async () => {
    const { h, feed, keyboard } = await phone();
    feed.scrollTop = 100;
    feed.dispatchEvent(new h.window.Event('scroll'));
    await keyboard(450);
    expect(feed.scrollTop).toBe(100);
  });

  it('follows again once the reader scrolls back to the bottom', async () => {
    const { h, feed, keyboard } = await phone();
    feed.scrollTop = 100;
    feed.dispatchEvent(new h.window.Event('scroll'));
    feed.scrollTop = 1580;
    feed.dispatchEvent(new h.window.Event('scroll'));
    feed.scrollTop = 0;
    await keyboard(450);
    expect(feed.scrollTop).toBe(2000);
  });
});
