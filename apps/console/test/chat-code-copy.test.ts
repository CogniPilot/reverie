/**
 * A fenced code block in a message is drawn as a block with a Copy button, and the long-press sheet can turn text
 * selection on for one message (selection is off on messages on a touch screen).
 */
import { describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const A = 'a1111111-0000-4000-8000-000000000001';
const text = 'run this:\n```sh\nsudo nixos-rebuild build\n```\nthen say done';
const rooms = () => [room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' })], { messages: [message('m1', 'r1', agent(A, 'alpha'), text, 1000)] })];
const sessions = [{ id: A, name: 'alpha', mode: 'claude' }];

describe('code blocks in messages', () => {
  it('draw the fenced command in its own block, and Copy puts exactly it on the clipboard', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const written: string[] = [];
    Object.defineProperty(h.window.navigator, 'clipboard', { value: { writeText: async (t: string) => void written.push(t) }, configurable: true });
    const block = h.document.querySelector('.chatroom-codeblock') as HTMLElement;
    expect(block.querySelector('pre')!.textContent).toBe('sudo nixos-rebuild build');
    expect(h.document.querySelector('.chatroom-msg-text')!.textContent).toContain('run this:');
    (block.querySelector('.chatroom-code-copy') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(written).toEqual(['sudo nixos-rebuild build']);
  });
});

describe('code blocks never take markup from message text', () => {
  it('keeps a fenced <img onerror> payload as plain text in the pre (no element is created)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const msg = message('m1', 'r1', agent(A, 'alpha'), `look:\n\`\`\`sh\n${payload}\n\`\`\`\nend`, 1000);
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' })], { messages: [msg] })] });
    const block = h.document.querySelector('.chatroom-codeblock') as HTMLElement;
    expect(block.querySelector('pre')!.textContent).toBe(payload);
    expect(block.querySelector('img')).toBeNull();
    expect(h.document.querySelector('.ca-msg img[src="x"]')).toBeNull();
  });
});

describe('Select text', () => {
  it('is in the message sheet and makes that one message selectable', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const el = h.document.querySelector('.ca-msg') as HTMLElement;
    el.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const item = [...h.document.querySelectorAll('.ca-popmenu button')].find((b) => b.textContent === 'Select text') as HTMLButtonElement;
    expect(item).toBeTruthy();
    expect(el.classList.contains('is-selectable')).toBe(false);
    item.click();
    expect(el.classList.contains('is-selectable')).toBe(true);
  });
});
