import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (path: string) => readFileSync(resolve(PUBLIC, path), 'utf8');
const A = '00000026-002d-4000-8000-00000000003c';
const open: any[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    h.window.ReverieChatPlugins?.setEnabled('latex', false);
    for (const observer of h.observers) observer.disconnect();
    await h.flush();
    h.dom.window.close();
  }
});

async function setup(raw = 'Explain **this**: $x^2 + y^2$\n$$\\frac{1}{2}$$\n```tex\n$x$\n```') {
  const h = await createHarness({
    sessions: [{ id: A, name: 'alpha', mode: 'claude' }],
    rooms: [
      room('r1', 'General', [member(A, 'alpha')], { messages: [message('m1', 'r1', agent(A, 'alpha'), raw, 1000)] }),
    ],
  });
  const observers: any[] = [];
  const NativeObserver = h.window.MutationObserver;
  h.window.MutationObserver = class extends NativeObserver {
    constructor(callback: any) {
      super(callback);
      observers.push(this);
    }
  };
  open.push({ ...h, observers });
  const requests: string[] = [];
  const append = h.document.head.append.bind(h.document.head);
  h.document.head.append = (...nodes: any[]) => {
    append(...nodes);
    for (const node of nodes)
      if (node.src || node.href) {
        const path = new URL(node.src || node.href).pathname.slice(1);
        requests.push(path);
        if (node.tagName === 'SCRIPT')
          h.window.queueMicrotask(() => {
            h.window.eval(read(path));
            node.dispatchEvent(new h.window.Event('load'));
          });
      }
  };
  h.window.eval(read('vendor/dompurify.min.js'));
  h.window.eval(read('chat-plugins.js'));
  h.window.eval(read('chat-math-plugin.js'));
  await h.flush();
  return { ...h, requests, host: h.window.ReverieChatPlugins };
}
const click = (scope: any, text: string) => {
  const node = [...scope.querySelectorAll('button')].find(
    (item: any) => item.textContent === text
  ) as HTMLButtonElement;
  expect(node, text).toBeTruthy();
  node.click();
};

describe('optional math source and preview', () => {
  it('defaults off, leaves ordinary messages intact and requests no renderer assets', async () => {
    const h = await setup('$x$');
    expect(h.host.isEnabled('latex')).toBe(false);
    expect(h.document.querySelector('.chatroom-msg-text')!.textContent).toBe('$x$');
    expect(h.document.querySelector('.chat-math-toolbar')).toBeNull();
    expect(h.requests).toEqual([]);
  });

  it('can disable while local assets are loading without mounting late controls', async () => {
    const h = await setup('$x$');
    h.host.setEnabled('latex', true);
    h.host.setEnabled('latex', false);
    await h.flush();
    expect(h.document.querySelector('.chat-math-toolbar')).toBeNull();
    expect(h.document.querySelector('.chatroom-msg-text')!.textContent).toBe('$x$');
    h.host.setEnabled('latex', true);
    await h.flush();
    expect(h.document.querySelectorAll('.chat-math-message-preview .katex')).toHaveLength(1);
  });

  it('renders real KaTeX, toggles to exact original source and keeps code literal', async () => {
    const raw = '  **Proof** $x^2$\n$$\\frac{1}{2}$$\n```tex\n$x$\n```\n`$y$`  ';
    const h = await setup(raw);
    const msg = h.document.querySelector('.chatroom-msg-text')!;
    const initial = msg.innerHTML;
    h.host.setEnabled('latex', true);
    await h.flush();
    expect(msg.querySelectorAll('.katex')).toHaveLength(2);
    expect(msg.querySelector('pre code')!.textContent).toBe('$x$');
    expect(msg.querySelector('pre code .katex')).toBeNull();
    expect(msg.querySelector('code.chatroom-inline-code .katex')).toBeNull();
    for (let n = 0; n < 3; n++) {
      click(msg, 'Show source');
      expect(msg.querySelector('.chat-math-message-source')!.textContent).toBe(raw);
      click(msg, 'Show rendered');
    }
    h.host.setEnabled('latex', false);
    expect(msg.innerHTML).toBe(initial);
    expect(h.requests.every((path) => !path.includes('://'))).toBe(true);
  });

  it('keeps textarea source exact across preview/edit and appends message source to a draft', async () => {
    const h = await setup('Please solve $x^2=2$.');
    h.host.setEnabled('latex', true);
    await h.flush();
    const input = h.document.querySelector('textarea.chatroom-input') as HTMLTextAreaElement;
    const raw = '  $\\alpha_1$\n$$a  + b$$\n<&>  ';
    input.value = raw;
    const form = input.parentElement!;
    for (let n = 0; n < 3; n++) {
      click(form, 'Preview math');
      expect(input.hidden).toBe(true);
      click(form, 'Edit source');
      expect(input.value).toBe(raw);
    }
    click(form, 'Preview math');
    click(h.document.querySelector('.chatroom-msg-text'), 'Use in composer');
    expect(input.value).toBe(raw + '\nPlease solve $x^2=2$.');
    expect(input.hidden).toBe(false);
    expect(h.server.posts).toHaveLength(0);
    h.host.setEnabled('latex', false);
    expect(input.value).toBe(raw + '\nPlease solve $x^2=2$.');
    expect(input.hidden).toBe(false);
  });

  it('edits and sends the source, while the preview stays derived and fenced text stays literal', async () => {
    const h = await setup();
    h.host.setEnabled('latex', true);
    await h.flush();
    const input = h.document.querySelector('textarea.chatroom-input') as HTMLTextAreaElement;
    const form = input.parentElement!;
    input.value = 'x + y';
    input.setSelectionRange(0, 5);
    click(form, 'Inline math');
    expect(input.value).toBe('$x + y$');
    input.value = 'Changed $x^3$\n```tex\n$literal$\n```';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    click(form, 'Preview math');
    expect(form.querySelectorAll('.chat-math-composer-preview .katex')).toHaveLength(1);
    expect(form.querySelector('.chat-math-composer-preview')!.textContent).toContain('$literal$');
    const exact = input.value;
    form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
    expect(h.server.posts.at(-1).text).toBe(exact);
  });

  it('enhances dynamic message editors and removes controls on disable', async () => {
    const h = await setup();
    h.host.setEnabled('latex', true);
    await h.flush();
    const input = h.document.createElement('textarea');
    input.className = 'ca-edit-input';
    input.value = '$a$';
    const box = h.document.createElement('section');
    box.append(input);
    h.document.body.append(box);
    await h.flush();
    click(box, 'Preview math');
    expect(box.querySelector('.katex')).toBeTruthy();
    click(box, 'Edit source');
    input.value = '$b$';
    click(box, 'Preview math');
    h.host.setEnabled('latex', false);
    expect(input.hidden).toBe(false);
    expect(input.value).toBe('$b$');
    expect(h.document.querySelector('.chat-math-toolbar')).toBeNull();
    h.host.setEnabled('latex', true);
    await h.flush();
    expect(box.querySelectorAll('.chat-math-toolbar')).toHaveLength(1);
  });
});

describe('bounded renderer and escaping', () => {
  it('uses untrusted settings, fresh macro state and safe failure text', async () => {
    const h = await setup('$x$');
    h.host.setEnabled('latex', true);
    await h.flush();
    const katex = h.window.katex;
    const spy = vi.spyOn(katex, 'renderToString');
    for (const math of ['x', 'y']) h.window.ReverieChatMath.mathNode({ math, raw: '$' + math + '$' });
    for (const [, options] of spy.mock.calls as any)
      expect(options).toMatchObject({
        trust: false,
        strict: 'error',
        throwOnError: true,
        maxExpand: 1000,
        maxSize: 10,
        globalGroup: false,
      });
    expect((spy.mock.calls[0][1] as any).macros).not.toBe((spy.mock.calls[1][1] as any).macros);
    spy.mockImplementationOnce(() => {
      throw new Error('<img src=x onerror=alert(1)>');
    });
    expect(h.window.ReverieChatMath.mathNode({ math: 'x', raw: '$x$' }).textContent).toBe('$x$');
    spy.mockRestore();
  });

  it.each([
    String.raw`\href{javascript:alert(1)}{x}`,
    String.raw`\includegraphics{https://outside.invalid/x}`,
    String.raw`\def\a{\includegraphics}\a{https://outside.invalid/x}`,
    String.raw`\htmlStyle{background:url(x)}{x}`,
    String.raw`\def\a{\a}\a`,
    String.raw`\invalid{<img src=x onerror=alert(1)>}`,
  ])('keeps hostile/unsupported content visible without resource markup: %s', async (math) => {
    const h = await setup('$' + math + '$');
    h.host.setEnabled('latex', true);
    await h.flush();
    const node = h.window.ReverieChatMath.mathNode({ math, raw: '$' + math + '$' });
    expect(node.textContent).toBe('$' + math + '$');
    expect(node.querySelector('a,img,script,style,iframe,object,embed,math,foreignObject,use')).toBeNull();
    for (const element of node.querySelectorAll('*'))
      for (const attr of element.attributes) {
        expect(attr.name).not.toMatch(/^on|^(?:href|src|id|name)$/i);
      }
  });

  it('sanitizes generated HTML without allowing URLs, executable attributes or arbitrary CSS', async () => {
    const h = await setup();
    h.host.setEnabled('latex', true);
    await h.flush();
    const fragment = h.window.sanitizeChatMathHtml(
      '<span id="app" onclick="alert(1)" style="height:2em;position:fixed;background:url(x)">x</span><svg><foreignObject><img src=x></foreignObject><path d="M0 0L1 1" onload="alert(1)"/></svg>'
    );
    expect(fragment.querySelector('img,foreignObject')).toBeNull();
    expect(fragment.querySelector('span').style.height).toBe('2em');
    for (const node of fragment.querySelectorAll('*'))
      for (const attr of node.attributes) {
        expect(attr.name).not.toMatch(/^on|^(?:href|src|id|name)$/i);
        expect(attr.value).not.toMatch(/url\(|position|javascript:/i);
      }
  });

  it('bounds math work and preserves all malformed and oversized source', async () => {
    const h = await setup();
    h.host.setEnabled('latex', true);
    await h.flush();
    for (const raw of ['$' + 'x'.repeat(4097) + '$', 'unclosed $$x', '$x + 1', Array(40).fill('$x$').join(' ')]) {
      const parts = h.window.ReverieChatMath.mathSegments(raw);
      expect(parts.map((p: any) => p.raw ?? p.text).join('')).toBe(raw);
      expect(parts.filter((p: any) => p.math !== undefined).length).toBeLessThanOrEqual(32);
    }
    const manifest = JSON.parse(read('vendor/chat-math.json'));
    for (const [path, expected] of Object.entries(manifest.hashes)) {
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(PUBLIC, 'vendor', path)))
          .digest('hex'),
        path
      ).toBe(expected);
    }
  });
});
