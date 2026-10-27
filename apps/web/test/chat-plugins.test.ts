import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const load = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
async function page(options: { canManage?: boolean; saved?: Record<string, boolean>; legacy?: boolean } = {}) {
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
  let saved = { latex: false, python: false, modelica: false, ...options.saved };
  if (options.legacy) window.localStorage.setItem('reverie:chat-plugins:v1', '{"python":true,"latex":true}');
  window.fetch = vi.fn(async (_url: string, init?: any) => {
    if (init?.method === 'PUT') saved = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          enabled: saved,
          available: { python: true, modelica: true },
          canManage: options.canManage !== false,
        },
      }),
    };
  });
  window.eval(load('chat-plugins.js'));
  window.eval(load('chat-language-plugins.js'));
  await settle();
  window.fetch.mockClear();
  return { window, doc: window.document, host: window.ReverieChatPlugins, close: () => window.close() };
}
describe('shared owner-controlled chat plugins', () => {
  it('ignores old browser choices and never inserts a room header button', async () => {
    const p = await page({ legacy: true });
    try {
      expect(p.host.isEnabled('python')).toBe(false);
      expect(p.host.isEnabled('latex')).toBe(false);
      expect(p.doc.querySelector('.ca-plugins-open')).toBeNull();
      expect(p.doc.querySelector('.ca-head').children.length).toBe(0);
    } finally {
      p.close();
    }
  });
  it('reads shared math state but hides owner controls and refuses writes for limited readers', async () => {
    const p = await page({ canManage: false, saved: { python: true, latex: true } });
    try {
      expect(p.host.isEnabled('latex')).toBe(true);
      expect(p.host.isEnabled('python')).toBe(false);
      expect(p.doc.querySelector('.chat-plugin-actions')).toBeNull();
      await expect(p.host.openSettings()).rejects.toThrow('Owner');
      await expect(p.host.setEnabled('python', false)).rejects.toThrow('Owner');
      expect(p.doc.querySelector('dialog')).toBeNull();
      expect(p.window.fetch.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
    } finally {
      p.close();
    }
  });
  it('reflects failed saves honestly and persists confirmed changes through the server API', async () => {
    const p = await page();
    try {
      await p.host.openSettings();
      const checkbox = p.doc.querySelector('input');
      p.window.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Disk full' }) });
      checkbox.click();
      await settle();
      expect(checkbox.checked).toBe(false);
      expect(p.doc.querySelector('[role=status]').textContent).toBe('Disk full');
      checkbox.click();
      await settle();
      expect(checkbox.checked).toBe(true);
      expect(p.doc.querySelector('[role=status]').textContent).toContain('Saved');
      expect(p.host.isEnabled('python')).toBe(true);
    } finally {
      p.close();
    }
  });
  it('leaves code unchanged and performs no network requests while disabled or just enabled', async () => {
    const p = await page();
    try {
      const original = p.doc.querySelector('pre').outerHTML;
      expect(p.doc.querySelector('.chat-plugin-actions')).toBeNull();
      expect(p.window.fetch).not.toHaveBeenCalled();
      await p.host.setEnabled('python', true);
      p.window.fetch.mockClear();
      await settle();
      expect(p.doc.querySelector('pre').outerHTML).toBe(original);
      expect(p.doc.querySelectorAll('.chat-plugin-actions').length).toBe(1);
      expect(p.window.fetch.mock.calls.every((call: any) => call[1]?.method === 'PUT')).toBe(true);
      await p.host.setEnabled('python', false);
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
      await p.host.setEnabled('modelica', true);
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
      await p.host.setEnabled('python', true);
      await settle();
      p.window.fetch.mockClear();
      p.doc.querySelector('.chat-plugin-actions button').click();
      const editor = p.doc.querySelector('textarea');
      editor.value = 'private_draft = "secret"';
      editor.selectionStart = 2;
      expect(p.window.fetch).not.toHaveBeenCalled();
      const settingsFetch = p.window.fetch.getMockImplementation();
      p.window.fetch.mockImplementation((url: string, init: any) =>
        url.endsWith('/lsp')
          ? Promise.resolve({
              ok: true,
              json: async () => ({ success: true, data: { hover: '<img src=x onerror=alert(1)>' } }),
            })
          : settingsFetch(url, init)
      );
      [...p.doc.querySelectorAll('.chat-language-editor button')]
        .find((button: any) => button.textContent === 'Hover')
        .click();
      await settle();
      expect(JSON.parse(p.window.fetch.mock.calls[0][1].body).source).toBe(editor.value);
      expect(p.doc.querySelector('.chat-plugin-output img')).toBeNull();
      expect(p.doc.querySelector('.chat-plugin-output').textContent).toContain('<img');
      expect(p.window.localStorage.getItem('reverie:chat-plugins:v1')).toBeNull();
      await p.host.setEnabled('python', false);
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
      await p.host.setEnabled('latex', true);
      await p.host.setEnabled('latex', true);
      await p.host.setEnabled('latex', false);
      expect(enable).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      await p.host.setEnabled('python', true);
      await settle();
      p.doc.querySelector('.chat-plugin-actions button').click();
      p.window.fetch.mockClear();
      const settingsFetch = p.window.fetch.getMockImplementation();
      p.window.fetch.mockImplementation((url: string, init: any) =>
        url.endsWith('/lsp') ? new Promise(() => {}) : settingsFetch(url, init)
      );
      p.doc.querySelector('.chat-language-editor button').click();
      const signal = p.window.fetch.mock.calls[0][1].signal;
      expect(signal.aborted).toBe(false);
      await p.host.setEnabled('python', false);
      expect(signal.aborted).toBe(true);
    } finally {
      p.close();
    }
  });
});
