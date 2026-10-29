/**
 * Session-file SVG previews render from a data: URL, never a same-origin blob: one, so "Open image in new tab"
 * cannot run the SVG's script on the Reverie origin.
 * Same vm harness as file-preview-detach.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const panelsJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');

it('renders a session SVG from a data: URL and creates no blob: URL', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>sentinel()</script></svg>';
  const createObjectURL = vi.fn(() => 'blob:fixture');
  const ReverieApp = function ReverieApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const context = vm.createContext({
    ReverieApp,
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escapeHtml: (s: string) => String(s).replace(/"/g, '&quot;'),
    ReverieBase: { base: '', url: (p: string) => p },
    rendersAsPage: () => false,
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), open: vi.fn() },
    URL: { createObjectURL, revokeObjectURL: vi.fn() },
    btoa,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: async () => new Response(svg),
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });
  const body = { innerHTML: '', querySelectorAll: () => [] as unknown[], querySelector: () => null };
  const elements: Record<string, unknown> = {
    filePreviewBody: body,
    filePreviewOverlay: { classList: { add: () => {}, remove: () => {}, contains: () => true } },
    filePreviewTitle: { textContent: '' },
    filePreviewFooter: { textContent: '' },
    filePreviewDetachBtn: { hidden: true },
  };
  const app = new ReverieApp();
  app.$ = (id: string) => elements[id] ?? null;
  app._resetFilePreviewEdit = () => {};
  app._isExternalPreviewPath = () => false;
  app.showToast = vi.fn();
  app.filePreviewContent = '';
  await app.openFilePreview('/ws/figure.svg', 's1');
  const src = /src="([^"]+)"/.exec(body.innerHTML)![1];
  expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  expect(Buffer.from(src.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')).toBe(svg);
  expect(createObjectURL).not.toHaveBeenCalled();
});
