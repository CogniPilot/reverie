/**
 * The long-press hint is about chat messages: it never appears over the terminal view, and it waits for the chat.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, room } from './helpers/chat-app-harness.mjs';

const touch = (h: Awaited<ReturnType<typeof createHarness>>) => {
  (h.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({ matches: q === '(hover: none)' });
};
const hints = (h: Awaited<ReturnType<typeof createHarness>>) => h.app.toasts.filter((t: { text: string }) => /Press and hold/.test(t.text));

describe('touchHint', () => {
  it('stays quiet in the terminal view, then shows once when the chat is shown', async () => {
    const h = await createHarness({ rooms: [room('r1', 'General', [], {})], sessionStored: { 'reverie:view': 'debug' } });
    touch(h);
    h.app._chatApp.touchHint();
    expect(hints(h)).toHaveLength(0);
    expect(h.window.localStorage.getItem('reverie:chat:hint')).toBeNull();
    h.app._chatApp.showChat();
    expect(hints(h)).toHaveLength(1);
    h.app._chatApp.showChat();
    expect(hints(h)).toHaveLength(1);
  });
});
