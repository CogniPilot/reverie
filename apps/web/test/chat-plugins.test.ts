import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const load = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
async function page() {
  const dom = new JSDOM(
    '<body><header class="ca-head"></header><pre><code class="language-python">print(&quot;λ&quot;)</code></pre><pre><code class="language-modelica">model X end X;</code></pre></body>',
    { url: 'https://reverie.test/', runScripts: 'outside-only' }
  );
  const window = dom.window as any;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  window.fetch = vi.fn();
  window.eval(load('chat-plugins.js'));
  window.eval(load('chat-language-plugins.js'));
  await settle();
  return { window, doc: window.document, host: window.ReverieChatPlugins, close: () => window.close() };
}
describe('optional browser chat plugins', () => {
  it('leaves code unchanged and performs no network requests while disabled or just enabled', async () => {
    const p = await page();
    try {
      const original = p.doc.querySelector('pre').outerHTML;
      expect(p.doc.querySelector('.chat-plugin-actions')).toBeNull();
      expect(p.window.fetch).not.toHaveBeenCalled();
      p.host.setEnabled('python', true);
      await settle();
      expect(p.doc.querySelector('pre').outerHTML).toBe(original);
      expect(p.doc.querySelectorAll('.chat-plugin-actions').length).toBe(1);
      expect(p.window.fetch).not.toHaveBeenCalled();
      p.host.setEnabled('python', false);
      await settle();
      expect(p.doc.querySelector('.chat-plugin-actions')).toBeNull();
      expect(p.doc.querySelector('pre').outerHTML).toBe(original);
    } finally {
      p.close();
    }
  });
  it('mounts only matching labelled blocks once, including late render and cleans detached blocks', async () => {
    const p = await page();
    try {
      p.host.setEnabled('modelica', true);
      await settle();
      p.host.scan();
      p.host.scan();
      expect(p.doc.querySelectorAll('.chat-plugin-actions').length).toBe(1);
      const pre = p.doc.createElement('pre');
      const code = p.doc.createElement('code');
      code.className = 'language-mo';
      code.textContent = 'model λ end λ;';
      pre.append(code);
      p.doc.body.append(pre);
      await settle();
      expect(p.doc.querySelectorAll('.chat-plugin-actions').length).toBe(2);
      pre.remove();
      await settle();
      expect(p.doc.querySelectorAll('.chat-plugin-actions').length).toBe(1);
    } finally {
      p.close();
    }
  });
  it('stores boolean preferences only and never sends drafts before an explicit action', async () => {
    const p = await page();
    try {
      p.host.setEnabled('python', true);
      await settle();
      p.doc.querySelector('.chat-plugin-actions button').click();
      const editor = p.doc.querySelector('textarea');
      editor.value = 'private_draft = "secret"';
      editor.selectionStart = 2;
      expect(p.window.fetch).not.toHaveBeenCalled();
      p.window.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { hover: '<img src=x onerror=alert(1)>' } }),
      });
      [...p.doc.querySelectorAll('.chat-language-editor button')]
        .find((button: any) => button.textContent === 'Hover')
        .click();
      await settle();
      expect(JSON.parse(p.window.fetch.mock.calls[0][1].body).source).toBe(editor.value);
      expect(p.doc.querySelector('.chat-plugin-output img')).toBeNull();
      expect(p.doc.querySelector('.chat-plugin-output').textContent).toContain('<img');
      expect(p.window.localStorage.getItem('reverie:chat-plugins:v1')).toBe('{"python":true,"modelica":false}');
      p.host.setEnabled('python', false);
      await settle();
      expect(p.doc.querySelector('.chat-language-editor')).toBeNull();
      expect(p.doc.querySelector('pre code').textContent).toBe('print("λ")');
    } finally {
      p.close();
    }
  });
  it('aborts an active request on disable and invokes optional plugin lifecycle exactly once', async () => {
    const p = await page();
    try {
      const cleanup = vi.fn(),
        enable = vi.fn(() => cleanup);
      p.host.register({ id: 'latex', label: 'LaTeX', description: 'math', enable });
      p.host.setEnabled('latex', true);
      p.host.setEnabled('latex', true);
      p.host.setEnabled('latex', false);
      expect(enable).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      p.host.setEnabled('python', true);
      await settle();
      p.doc.querySelector('.chat-plugin-actions button').click();
      p.window.fetch.mockImplementation(() => new Promise(() => {}));
      p.doc.querySelector('.chat-language-editor button').click();
      const signal = p.window.fetch.mock.calls[0][1].signal;
      expect(signal.aborted).toBe(false);
      p.host.setEnabled('python', false);
      expect(signal.aborted).toBe(true);
    } finally {
      p.close();
    }
  });
});
