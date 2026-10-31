/**
 * Web pages beside the chat, with right-click still opening them in a new page. A plain click on an https link to
 * another site opens it in a sandboxed pane beside the conversation; a modified or middle click, the link's own right-click
 * menu and the pane's "Open in new tab" still open it outside. On a phone the pane covers the conversation until Back.
 */
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { registerSecurityHeaders } from '../src/web/middleware/auth.js';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const A = '0000002d-0035-4000-8000-0000000000b1';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); });
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(options: { narrow?: boolean } = {}) {
  const text = 'status https://status.example.com/roadmap?x=1 own http://localhost/board plain http://plain.example.com/ end';
  const rooms = [room('r1', 'General', [member(A, 'alpha')], { messages: [message('m1', 'r1', agent(A, 'alpha'), text, 1000)] })];
  const h = await createHarness({ sessions: [{ id: A, name: 'alpha', mode: 'claude' }], rooms, ...options });
  opened.push(h);
  const link = (start: string) =>
    [...h.document.querySelectorAll('.ca-msg a.chatroom-link')].find((a) => (a as HTMLAnchorElement).href.startsWith(start)) as HTMLAnchorElement;
  // dispatchEvent is false when the click was taken (preventDefault), true when the browser would follow the link.
  const click = (el: Element, init: MouseEventInit = {}) =>
    el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  const pane = () => h.document.querySelector('.ca-web') as HTMLElement;
  const frame = () => h.document.querySelector('.ca-web-frame') as HTMLIFrameElement;
  return { h, link, click, pane, frame };
}

it('a plain click opens an https page beside the chat, sandboxed, with its host and a new-tab link', async () => {
  const { h, link, click, pane, frame } = await setup();
  expect(pane().hidden).toBe(true);
  expect(frame()).toBeNull();
  expect(link('https://status.example.com').target).toBe('_blank');   // the link itself still names its new tab
  expect(click(link('https://status.example.com'))).toBe(false);
  expect(pane().hidden).toBe(false);
  expect(h.document.querySelector('.ca-root')!.classList.contains('ca-web-open')).toBe(true);
  expect(frame().getAttribute('src')).toBe('https://status.example.com/roadmap?x=1');
  expect(frame().referrerPolicy).toBe('no-referrer');
  const sandbox = frame().getAttribute('sandbox')!.split(' ');
  expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-popups-to-escape-sandbox']));
  expect(sandbox.some((token) => token.startsWith('allow-top-navigation'))).toBe(false);
  expect(h.document.querySelector('.ca-web-host')!.textContent).toBe('status.example.com');
  const external = h.document.querySelector('.ca-web-external') as HTMLAnchorElement;
  expect([external.href, external.target, external.rel]).toEqual(['https://status.example.com/roadmap?x=1', '_blank', 'noopener noreferrer']);
  // The pane sits beside the conversation, which stays usable.
  expect(pane().parentElement!.classList.contains('ca-body')).toBe(true);
  expect((h.document.querySelector('.ca-chat') as HTMLElement).inert).toBeFalsy();
  (h.document.querySelector('.ca-web-close') as HTMLButtonElement).click();
  expect(pane().hidden).toBe(true);
  // Closing unloads the page by removing its frame, so the page never holds an empty frame (only the pane's is ever made).
  expect(frame()).toBeNull();
  expect(h.document.querySelectorAll('iframe')).toHaveLength(0);
});

it('modified and middle clicks, right-click, this site and plain http keep the browser\'s own new tab', async () => {
  const { h, link, click, pane } = await setup();
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
    expect(click(link('https://status.example.com'), init), JSON.stringify(init)).toBe(true);
  expect(click(link('http://localhost/'))).toBe(true);
  expect(click(link('http://plain.example.com'))).toBe(true);
  expect(pane().hidden).toBe(true);
  // Right-click is the browser's link menu ("Open link in new tab"), not the message menu.
  const menu = link('https://status.example.com').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(menu).toBe(true);
  expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
});

it('on a phone the page covers the chat and Back returns to it without leaving the room', async () => {
  const { h, link, click, pane } = await setup({ narrow: true });
  const chat = h.document.querySelector('.ca-chat') as HTMLElement;
  const depth = h.window.history.length;
  click(link('https://status.example.com'));
  expect(pane().hidden).toBe(false);
  expect(chat.inert).toBe(true);
  expect(h.document.activeElement?.classList.contains('ca-web-close')).toBe(true);
  expect(h.window.history.length).toBe(depth + 1);
  click(link('https://status.example.com'));                         // tapping again does not stack Back steps
  expect(h.window.history.length).toBe(depth + 1);
  h.window.history.back();
  await settle();
  expect(pane().hidden).toBe(true);
  expect(chat.inert).toBe(false);
  expect(h.document.querySelector('.ca-msg')).not.toBeNull();
  expect(h.document.activeElement).not.toBe(h.document.querySelector('.chatroom-input'));  // no phone keyboard pops up
  // The pane's own Back button steps back over its entry too, so the next system Back leaves nothing behind.
  click(link('https://status.example.com'));
  expect(h.window.history.state?.reverieWeb).toBe(true);
  (h.document.querySelector('.ca-web-close') as HTMLButtonElement).click();
  await settle();
  expect(pane().hidden).toBe(true);
  expect(h.window.history.state?.reverieWeb).toBeFalsy();
});

it('the page policy lets the chat frame https sites and nothing else new', async () => {
  const app = Fastify();
  registerSecurityHeaders(app, true);
  app.get('/', async () => 'ok');
  const res = await app.inject({ method: 'GET', url: '/' });
  await app.close();
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toContain("frame-src 'self' https:;");
  expect(csp).toContain("default-src 'self';");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toMatch(/frame-src[^;]*http:/);
  expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
});
