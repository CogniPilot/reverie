import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createHarness } from './helpers/chat-app-harness.mjs';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const open: JSDOM[] = [];
afterEach(() => open.splice(0).forEach((dom) => dom.window.close()));

function renderer() {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
  open.push(dom);
  for (const file of [
    'vendor/dompurify.min.js',
    'sanitize-html.js',
    'vendor/highlight-11.12.0.min.js',
    'modelica-highlight.js',
    'chat-code-highlighting.js',
  ])
    dom.window.eval(read(file));
  return dom.window as any;
}

describe('offline labelled chat code', () => {
  it.each([
    ['python', 'def hello():\n    return "λ" # hello', '.hljs-keyword'],
    ['py', 'print("hello")', '.hljs-string'],
    ['modelica', 'model Ball\n  Real x = 1;\nend Ball;', '.hljs-type'],
    ['mo', 'model Ball\n  Real x;\nend Ball;', '.hljs-keyword'],
  ])('colors %s without changing a character', (language, code, token) => {
    const window = renderer();
    const node = window.ReverieChatCode.highlight(code, language);
    expect(node.querySelector(token)).not.toBeNull();
    expect(node.textContent).toBe(code);
  });

  it('keeps unknown, unlabelled, oversized and unavailable-renderer source literal', () => {
    const window = renderer();
    for (const [code, language] of [
      ['print("hello")', ''],
      ['<img src=x onerror=alert(1)>', 'unknown'],
      ['x'.repeat(50001), 'python'],
      ['print(1)', 'python\" onclick=bad'],
    ]) {
      const node = window.ReverieChatCode.highlight(code, language);
      expect(node.textContent).toBe(code);
      expect(node.children).toHaveLength(0);
    }
    window.hljs = undefined;
    expect(window.ReverieChatCode.highlight('print(1)', 'python').textContent).toBe('print(1)');
  });

  it('treats markup in real Python and Modelica snippets as text', () => {
    const window = renderer();
    const code = '<img src=x onerror=alert(1)> <script>alert(1)</script>';
    for (const language of ['python', 'modelica']) {
      const node = window.ReverieChatCode.highlight(code, language);
      expect(node.textContent).toBe(code);
      expect(node.querySelector('img, script, iframe, svg')).toBeNull();
      expect(node.querySelector('[onerror], [onclick]')).toBeNull();
    }
  });

  it('preserves Copy and language-assistance input in the real chat renderer', async () => {
    const h = await createHarness();
    open.push(h.dom);
    for (const file of [
      'vendor/dompurify.min.js',
      'sanitize-html.js',
      'vendor/highlight-11.12.0.min.js',
      'modelica-highlight.js',
      'chat-code-highlighting.js',
    ])
      h.window.eval(read(file));
    const source = 'print("λ <script> $x$")\n# original spacing  ';
    const writes: string[] = [];
    Object.defineProperty(h.window.navigator, 'clipboard', {
      value: { writeText: async (text: string) => void writes.push(text) },
      configurable: true,
    });
    const block = h.app._chatCodeBlock(source, 'python');
    expect(block.querySelector('code.language-python .hljs-string')).not.toBeNull();
    expect(block.querySelector('code')!.textContent).toBe(source);
    block.querySelector('button')!.click();
    await h.flush();
    expect(writes).toEqual([source]);
    h.dom.window.close();
    open.pop();
  });

  it('ships the exact reviewed vendor bytes and loads helpers before the chat renderer', () => {
    const manifest = JSON.parse(read('vendor/chat-highlighting.json'));
    for (const [file, sha] of Object.entries(manifest.hashes))
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(PUBLIC, 'vendor', file)))
          .digest('hex')
      ).toBe(sha);
    const html = read('index.html');
    expect(html.indexOf('src="vendor/highlight-11.12.0.min.js"')).toBeLessThan(
      html.indexOf('src="modelica-highlight.js"')
    );
    expect(html.indexOf('src="modelica-highlight.js"')).toBeLessThan(html.indexOf('src="chat-code-highlighting.js"'));
    expect(html.indexOf('src="chat-code-highlighting.js"')).toBeLessThan(html.indexOf('src="chat-media.js"'));
  });
});
