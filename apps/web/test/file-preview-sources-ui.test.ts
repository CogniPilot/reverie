import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const pub = resolve(import.meta.dirname, '../src/web/public');
const file = (name: string) => readFileSync(resolve(pub, name), 'utf8');
const markup = file('index.html').split('<!-- File Preview Overlay -->')[1].split('<!-- Folder Grid:')[0];
const handle: (() => void)[] = [];
afterEach(() => {
  for (const close of handle.splice(0)) close();
});
function cjs(name: string) {
  const exported = {};
  const sandbox = vm.createContext({ module: { exports: exported }, exports: exported });
  vm.runInContext(file(name), sandbox);
  return sandbox.module.exports as any;
}
function fixture(
  answer: (url: string, options: any) => Promise<Response> = async () => new Response('# Heading\n\nText')
) {
  const dom = new JSDOM(`<div id="under"><button id="trigger">Open file</button></div>${markup}`, {
    url: 'http://localhost/prefix/',
  });
  const { document } = dom.window;
  const listen = document.addEventListener.bind(document);
  document.addEventListener = ((kind: string, ...args: any[]) => {
    if (kind !== 'DOMContentLoaded') return (listen as any)(kind, ...args);
  }) as any;
  const calls: { url: string; options: any }[] = [];
  const urls = new Map<string, Blob>();
  const revoked: string[] = [];
  const sanitize = cjs('sanitize-html.js').createMarkdownSanitizer(cjs('vendor/dompurify.min.js')(dom.window));
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class {},
    document,
    NodeFilter: dom.window.NodeFilter,
    localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    confirm: () => true,
    window: {
      __REVERIE_BASE__: '/prefix',
      ReverieBase: { url: (path: string) => '/prefix' + path },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      sanitizeMarkdownHtml: sanitize,
    },
    sanitizeMarkdownHtml: sanitize,
    marked: cjs('vendor/marked.min.js'),
    MobileDetection: {},
    Uint8Array,
    TextDecoder,
    btoa,
    AbortController,
    Blob,
    URL: {
      createObjectURL: (blob: Blob) => {
        const key = `blob:fixture-${urls.size}`;
        urls.set(key, blob);
        return key;
      },
      revokeObjectURL: (key: string) => {
        revoked.push(key);
      },
    },
    ReverieBase: { url: (path: string) => '/prefix' + path },
    fetch: async (url: string, options: any) => {
      calls.push({ url, options });
      return answer(url, options);
    },
  });
  vm.runInContext(
    `${file('constants.js')}\n${file('app.js')}\n${file('panels-ui.js')}\nglobalThis.App=ReverieApp;`,
    context
  );
  const app: any = Object.create((context as any).App.prototype);
  app._elemCache = {};
  app.sessions = new Map();
  app.activeSessionId = 'SHOULD-NEVER-BE-USED';
  app._copyText = vi.fn(async () => true);
  const trigger = document.getElementById('trigger') as HTMLButtonElement;
  trigger.focus();
  handle.push(() => {
    app.closeFilePreview();
    dom.window.close();
  });
  return { dom, document, app, calls, urls, revoked, trigger, context };
}
const source = (name = 'notes.md') => ({ kind: 'room-attachment', roomId: 'room-a', attachmentId: 'file-a', name });

function splitFixture() {
  const f = fixture();
  f.document.documentElement.dataset.reverieView = 'chat';
  const chat = f.document.createElement('div');
  chat.className = 'ca-root';
  chat.innerHTML = '<textarea class="chatroom-input"></textarea><button>Send</button>';
  f.document.body.prepend(chat);
  const listeners = new Set<() => void>();
  const media = { matches: true, addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn) };
  f.context.window.matchMedia = vi.fn(() => media);
  f.context.window.innerWidth = 1280;
  const viewportListeners = new Set<() => void>();
  f.context.window.addEventListener = vi.fn((kind: string, fn: () => void) => {
    if (kind === 'resize') viewportListeners.add(fn);
  });
  f.context.window.removeEventListener = vi.fn((kind: string, fn: () => void) => {
    if (kind === 'resize') viewportListeners.delete(fn);
  });
  return { ...f, chat, media, listeners, viewportListeners, changeWidth(width: number) {
    f.context.window.innerWidth = width;
    media.matches = width >= 1100;
    for (const fn of listeners) fn();
  } };
}

it('DS-1: refreshes effective separator range within a breakpoint and removes resize listeners', async () => {
  const f = splitFixture();
  await f.app.openReadOnlyFilePreview(source());
  const body = f.document.getElementById('filePreviewBody')!;
  f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!.click();
  let divider = f.document.querySelector<HTMLElement>('.file-preview-split-divider')!;
  divider.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(divider.getAttribute('aria-valuenow')).toBe('640');
  const resize = (width: number) => {
    f.context.window.innerWidth = width;
    // No matchMedia change: both widths remain in the desktop range.
    for (const fn of f.viewportListeners) fn();
  };
  expect(f.viewportListeners.size).toBe(1);
  resize(1150);
  expect(divider.getAttribute('aria-valuemax')).toBe('510');
  expect(divider.getAttribute('aria-valuenow')).toBe('510');
  expect(f.document.documentElement.style.getPropertyValue('--file-preview-split-width')).toBe('510px');
  expect(f.app._filePreviewSplitPreferred).toBe(true);
  expect(f.app._filePreviewSplitWidth).toBe(640);
  expect(f.document.getElementById('filePreviewBody')).toBe(body);
  expect(f.calls).toHaveLength(1);
  resize(1280);
  expect(divider.getAttribute('aria-valuenow')).toBe('640');
  const oldCallback = [...f.viewportListeners][0];
  await f.app.openReadOnlyFilePreview(source('second.md'));
  expect(f.viewportListeners.size).toBe(1);
  expect(f.viewportListeners.has(oldCallback)).toBe(false);
  divider = f.document.querySelector<HTMLElement>('.file-preview-split-divider')!;
  expect(divider.getAttribute('aria-valuemax')).toBe('640');
  f.app.closeFilePreview();
  expect(f.viewportListeners.size).toBe(0);
  resize(1150); oldCallback();
  expect(f.document.documentElement.style.getPropertyValue('--file-preview-split-width')).toBe('');
});

it('splits the existing document beside live chat without re-fetching or trapping chat keys', async () => {
  const f = splitFixture();
  await f.app.openReadOnlyFilePreview(source(), f.trigger);
  const body = f.document.getElementById('filePreviewBody')!;
  const overlay = f.document.getElementById('filePreviewOverlay')!;
  const button = f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!;
  expect(button.hidden).toBe(false);
  expect(f.chat.inert).toBe(true);
  button.click();
  expect(button.textContent).toBe('Expand document');
  expect(f.chat.inert).not.toBe(true);
  expect(overlay.getAttribute('role')).toBe('complementary');
  expect(overlay.hasAttribute('aria-modal')).toBe(false);
  expect(f.document.documentElement.classList.contains('file-preview-chat-split')).toBe(true);
  const input = f.chat.querySelector<HTMLTextAreaElement>('textarea')!;
  input.focus(); input.value = 'Discuss the open document';
  const send = vi.fn(); f.chat.querySelector('button')!.onclick = send;
  f.chat.querySelector<HTMLButtonElement>('button')!.click();
  expect(send).toHaveBeenCalledOnce();
  for (const key of ['Escape', 'Tab']) {
    const event = new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(overlay.classList.contains('visible')).toBe(true);
  expect(body.textContent).toContain('Heading');
  expect(f.calls).toHaveLength(1);
  button.click();
  expect(button.textContent).toBe('Split with chat');
  expect(f.chat.inert).toBe(true);
  expect(overlay.getAttribute('aria-modal')).toBe('true');
  expect(f.document.getElementById('filePreviewBody')).toBe(body);
  expect(f.calls).toHaveLength(1);
});

it('resizes the split document by keyboard and pointer within readable chat/document bounds', async () => {
  const f = splitFixture();
  await f.app.openReadOnlyFilePreview(source());
  f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!.click();
  const divider = f.document.querySelector<HTMLElement>('.file-preview-split-divider')!;
  const overlay = f.document.getElementById('filePreviewOverlay')!;
  overlay.getBoundingClientRect = () => ({ width: 500 } as DOMRect);
  const key = (key: string) => divider.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  key('ArrowLeft'); expect(divider.getAttribute('aria-valuenow')).toBe('532');
  key('ArrowRight'); expect(divider.getAttribute('aria-valuenow')).toBe('468');
  key('Home'); expect(divider.getAttribute('aria-valuenow')).toBe('360');
  key('End'); expect(divider.getAttribute('aria-valuenow')).toBe('640');
  divider.setPointerCapture = vi.fn();
  divider.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true }));
  divider.dispatchEvent(new f.dom.window.MouseEvent('pointermove', { clientX: 800, bubbles: true }));
  expect(divider.getAttribute('aria-valuenow')).toBe('480');
  divider.dispatchEvent(new f.dom.window.MouseEvent('pointercancel', { bubbles: true }));
  divider.dispatchEvent(new f.dom.window.MouseEvent('pointermove', { clientX: 100, bubbles: true }));
  expect(divider.getAttribute('aria-valuenow')).toBe('480');
  expect(f.document.documentElement.style.getPropertyValue('--file-preview-split-width')).toBe('480px');
});

it('returns to a modal on narrow screens and restores split mode without losing the document', async () => {
  const f = splitFixture();
  await f.app.openReadOnlyFilePreview(source());
  const body = f.document.getElementById('filePreviewBody')!;
  const button = f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!;
  button.click();
  f.chat.querySelector<HTMLTextAreaElement>('textarea')!.focus();
  f.changeWidth(393);
  expect(button.hidden).toBe(true);
  expect(f.chat.inert).toBe(true);
  expect(f.document.getElementById('filePreviewOverlay')!.contains(f.document.activeElement)).toBe(true);
  expect(f.document.documentElement.classList.contains('file-preview-chat-split')).toBe(false);
  f.changeWidth(1440);
  expect(button.hidden).toBe(false);
  expect(f.chat.inert).not.toBe(true);
  expect(f.document.documentElement.classList.contains('file-preview-chat-split')).toBe(true);
  expect(f.document.getElementById('filePreviewBody')).toBe(body);
  expect(f.calls).toHaveLength(1);
});

it('closes the workspace page when explicitly splitting so the conversation is reachable', async () => {
  const f = splitFixture();
  const closePage = vi.fn(() => f.trigger.remove());
  f.context.window.reverieChat = { embed: 'workspace', closePage };
  await f.app.openReadOnlyFilePreview(source());
  expect(closePage).not.toHaveBeenCalled();
  f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!.click();
  expect(closePage).toHaveBeenCalledOnce();
  expect(f.document.getElementById('filePreviewBody')!.textContent).toContain('Heading');
  f.app.closeFilePreview();
  expect(f.document.activeElement).toBe(f.chat.querySelector('textarea'));
});

it('cleans up split state, media listeners and divider when closing or replacing a document', async () => {
  const f = splitFixture();
  await f.app.openReadOnlyFilePreview(source('first.md'));
  f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!.click();
  const old = f.document.querySelector('.file-preview-split-divider')!;
  await f.app.openReadOnlyFilePreview(source('second.md'));
  expect(old.isConnected).toBe(false);
  expect(f.listeners.size).toBe(1);
  expect(f.document.querySelectorAll('.file-preview-split-divider')).toHaveLength(1);
  expect(f.document.documentElement.classList.contains('file-preview-chat-split')).toBe(true);
  const overlay = f.document.getElementById('filePreviewOverlay')!;
  overlay.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(overlay.classList.contains('visible')).toBe(true);
  f.app.closeFilePreview();
  expect(f.listeners.size).toBe(0);
  expect(f.document.querySelector('.file-preview-split-divider')).toBeNull();
  expect(f.document.documentElement.classList.contains('file-preview-chat-split')).toBe(false);
  expect(f.document.documentElement.style.getPropertyValue('--file-preview-split-width')).toBe('');
  expect(f.chat.inert).not.toBe(true);
});

it('keeps the existing modal in debug mode even on a wide screen', async () => {
  const f = splitFixture();
  f.document.documentElement.dataset.reverieView = 'debug';
  f.app._filePreviewSplitPreferred = true;
  await f.app.openReadOnlyFilePreview(source());
  expect(f.document.querySelector<HTMLButtonElement>('.file-preview-source-split')!.hidden).toBe(true);
  expect(f.document.getElementById('filePreviewOverlay')!.getAttribute('aria-modal')).toBe('true');
  expect(f.document.documentElement.classList.contains('file-preview-chat-split')).toBe(false);
});
const binding = 'a'.repeat(64);
const metadata = {
  kind: 'workspace',
  path: 'reports/notes.md',
  name: 'notes.md',
  absolutePath: '/drive/reports/notes.md',
  binding,
  crumbs: [
    { name: '/drive', path: '' },
    { name: 'reports', path: 'reports' },
  ],
};

it('renders snapshots through the shipping Markdown sanitizer with no session or fabricated location', async () => {
  const f = fixture(
    async () =>
      new Response(
        '# Heading\n\n[relative](other.md)\n\n![tracker](https://outside.invalid/p.png)\n\n<script>window.pwned=true</script>'
      )
  );
  await f.app.openReadOnlyFilePreview(source(), f.trigger);
  expect(
    f.document.querySelector('#filePreviewBody h1')?.textContent,
    f.document.getElementById('filePreviewBody')?.innerHTML
  ).toBe('Heading');
  expect(f.document.querySelector('#filePreviewBody script')).toBeNull();
  expect(f.document.querySelector('#filePreviewBody img')).toBeNull();
  expect(f.document.querySelector('#filePreviewBody a[href]')).toBeNull();
  expect(f.document.querySelector('.file-preview-source-path')?.textContent).toBe('Saved attachment · notes.md');
  expect(f.document.getElementById('filePreviewEditBtn')?.hidden).toBe(true);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].url).toBe('/prefix/api/chatrooms/room-a/files/file-a');
  expect(f.document.querySelector<HTMLAnchorElement>('.file-preview-source-download')?.download).toBe('notes.md');
});
it('shows code as exact inert text and keeps code-block copy independent of session interaction handlers', async () => {
  const f = fixture(async () => new Response('```python\nprint("<script>")\n```'));
  await f.app.openReadOnlyFilePreview(source());
  const button = f.document.querySelector<HTMLButtonElement>('.rv-copy-btn')!;
  button.click();
  await vi.waitFor(() => expect(f.app._copyText).toHaveBeenCalledWith('print("<script>")\n'));
  expect(f.document.querySelector('#filePreviewBody script')).toBeNull();
  expect(f.calls).toHaveLength(1);
});
it('renders safe plain text and exposes line/wrap toggles without an editor target', async () => {
  const f = fixture(async () => new Response('<img src=x onerror=sentinel()>\nplain'));
  await f.app.openReadOnlyFilePreview(source('log.txt'));
  expect(f.document.querySelector('#filePreviewBody pre')?.textContent).toContain('<img');
  expect(f.document.querySelector('#filePreviewBody img')).toBeNull();
  expect(f.app.filePreviewEditTarget).toBeNull();
  f.app.toggleFilePreviewLines();
  f.app.toggleFilePreviewWrap();
  expect(f.document.querySelector('#filePreviewBody pre')?.textContent).toContain('plain');
});
it('isolates static HTML and removes scripts, forms, meta/base, handlers, navigation and remote resources', async () => {
  const html =
    '<base href="https://outside.invalid/"><meta http-equiv="refresh" content="0;url=https://outside.invalid">' +
    '<script>parent.pwned=true</script><form action="/api/action"><input></form><iframe src="/api/owner/status"></iframe>' +
    '<h1 onclick="sentinel()">Title</h1><img src="https://outside.invalid/x" onerror="sentinel()"><a href="/workspace">Navigate</a>';
  const f = fixture(async () => new Response(html));
  await f.app.openReadOnlyFilePreview(source('index.html'));
  const frame = f.document.querySelector<HTMLIFrameElement>('#filePreviewBody iframe')!;
  expect(frame.getAttribute('sandbox')).toBe('');
  const inner = new JSDOM(frame.srcdoc).window.document;
  expect(inner.querySelector('h1')?.textContent).toBe('Title');
  expect(inner.querySelector('script,form,base,iframe,img,a[href],[onclick],[onerror]')).toBeNull();
  expect(inner.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  expect(inner.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain(
    "default-src 'none'"
  );
  (f.document.querySelector('#filePreviewFooter button') as HTMLButtonElement).click();
  expect(f.document.querySelector('#filePreviewBody pre')?.textContent).toBe(html);
  inner.defaultView?.close();
});
it('mounts authorized PDF bytes with cancellation and keeps Download secondary', async () => {
  const f = fixture(async () => new Response('%PDF-1.7\n'));
  const destroy = vi.fn();
  let pdfSignal: AbortSignal;
  f.app._mountReadOnlyPdf = vi.fn(async (bytes: Uint8Array, body: HTMLElement, state: any) => {
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7\n');
    pdfSignal = state.controller.signal;
    body.textContent = 'PDF component fixture';
    state.pdf = { destroy };
  });
  await f.app.openReadOnlyFilePreview(source('report.pdf'), f.trigger);
  expect(f.app._mountReadOnlyPdf).toHaveBeenCalledOnce();
  expect(f.document.querySelector('#filePreviewBody')?.textContent).toBe('PDF component fixture');
  expect(f.document.querySelector('.file-preview-source-download')).not.toBeNull();
  expect(f.document.getElementById('under')!.inert).toBe(true);
  (f.document.querySelector('.file-preview-source-back') as HTMLButtonElement).click();
  expect(destroy).toHaveBeenCalledOnce();
  expect(pdfSignal!.aborted).toBe(true);
  expect(f.document.activeElement).toBe(f.trigger);
  expect(f.document.getElementById('under')!.inert).not.toBe(true);
});
it('renders a raster using a typed blob and revokes it on replacement', async () => {
  const f = fixture(async () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])));
  await f.app.openReadOnlyFilePreview(source('image.png'));
  expect(f.document.querySelector<HTMLImageElement>('#filePreviewBody img')?.alt).toBe('image.png');
  expect(f.urls.get('blob:fixture-0')?.type).toBe('image/png');
  const zoom = f.document.querySelector<HTMLButtonElement>('#filePreviewFooter button')!;
  zoom.click();
  expect(zoom.textContent).toBe('Fit image');
  expect(f.document.querySelector('#filePreviewBody img')?.classList.contains('file-preview-image-actual')).toBe(true);
  zoom.click();
  expect(zoom.textContent).toBe('Actual size');
  await f.app.openReadOnlyFilePreview({ ...source(), attachmentId: 'new-file', name: 'second.png' });
  expect(f.revoked).toContain('blob:fixture-0');
});
it('renders an SVG from a data: URL, never a same-origin blob: that could run its script in a new tab', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>sentinel()</script></svg>';
  const f = fixture(async () => new Response(svg));
  await f.app.openReadOnlyFilePreview(source('figure.svg'));
  const src = f.document.querySelector<HTMLImageElement>('#filePreviewBody img')!.getAttribute('src')!;
  expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  expect(Buffer.from(src.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')).toBe(svg);
  expect([...f.urls.keys()]).toEqual([]);
});
it('resolves actual Workspace crumbs before a binding-checked read and navigates the selected folder', async () => {
  const f = fixture(async (url) =>
    url.includes('/resolve?')
      ? Response.json({ success: true, data: metadata })
      : new Response('# Workspace', { headers: { 'X-Reverie-File-Binding': binding } })
  );
  const frame = f.document.createElement('iframe'),
    page = f.document.createElement('section');
  page.append(frame);
  f.document.body.append(page);
  const shell = {
    embed: '',
    els: { page },
    openPage: vi.fn(function (this: any, kind: string) {
      this.embed = kind;
    }),
  };
  f.app._chatApp = shell;
  await f.app.openWorkspaceFilePreview(metadata.absolutePath, f.trigger);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0].url).toContain('/api/workspace/resolve?path=%2Fdrive%2Freports%2Fnotes.md');
  expect(f.calls[1].url).toContain(`path=reports%2Fnotes.md&binding=${binding}&preview=1`);
  const crumbs = f.document.querySelectorAll<HTMLAnchorElement>('.file-preview-source-path a');
  expect([...crumbs].map((a) => a.textContent)).toEqual(['/drive', 'reports']);
  crumbs[1].click();
  expect(shell.openPage).toHaveBeenCalledWith('workspace');
  expect(frame.src).toBe('http://localhost/prefix/workspace?path=reports');
});
it('refuses metadata identity mismatch and owner denial without falling back to a session reader', async () => {
  for (const answer of [
    () => Response.json({ success: true, data: { ...metadata, absolutePath: '/other/file.md' } }),
    () => new Response('denied', { status: 403 }),
  ]) {
    const f = fixture(async () => answer());
    await f.app.openWorkspaceFilePreview(metadata.absolutePath);
    expect(f.calls).toHaveLength(1);
    expect(f.document.getElementById('filePreviewBody')?.textContent).toContain('unavailable');
    expect(f.document.querySelector('#filePreviewBody h1')).toBeNull();
  }
});
it('never repaints closed or replaced content from a late fetch', async () => {
  let resolve!: (response: Response) => void;
  let n = 0;
  const f = fixture(async () =>
    ++n === 1
      ? new Promise<Response>((r) => {
          resolve = r;
        })
      : new Response('# New')
  );
  const old = f.app.openReadOnlyFilePreview(source());
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  await f.app.openReadOnlyFilePreview({ ...source(), name: 'new.md', attachmentId: 'new' });
  resolve(new Response('# Old'));
  await old;
  expect(f.document.querySelector('#filePreviewBody h1')?.textContent).toBe('New');
  const g = fixture(
    async () =>
      new Promise<Response>((r) => {
        resolve = r;
      })
  );
  const pending = g.app.openReadOnlyFilePreview(source());
  await vi.waitFor(() => expect(g.calls).toHaveLength(1));
  g.app.closeFilePreview();
  resolve(new Response('# Late'));
  await pending;
  expect(g.document.getElementById('filePreviewOverlay')?.classList.contains('visible')).toBe(false);
  expect(g.document.getElementById('filePreviewBody')?.textContent).toBe('');
});
it('offers explicit unsupported and stale-binding errors with Download, never fake successful content', async () => {
  const f = fixture();
  await f.app.openReadOnlyFilePreview(source('archive.zip'));
  expect(f.document.getElementById('filePreviewBody')?.textContent).toContain('format');
  expect(f.document.querySelector('.file-preview-source-download')).not.toBeNull();
  expect(f.calls).toHaveLength(0);
  const g = fixture(async (url) =>
    url.includes('/resolve?')
      ? Response.json({ success: true, data: metadata })
      : new Response('wrong', { headers: { 'X-Reverie-File-Binding': 'b'.repeat(64) } })
  );
  await g.app.openWorkspaceFilePreview(metadata.absolutePath);
  expect(g.document.getElementById('filePreviewBody')?.textContent).toContain('binding');
  expect(g.document.querySelector('#filePreviewBody pre,h1')).toBeNull();
});
it('closes on Escape, restores focus and traps Tab inside the active viewer', async () => {
  const f = fixture();
  await f.app.openReadOnlyFilePreview(source(), f.trigger);
  const last = f.document.querySelector<HTMLAnchorElement>('.file-preview-source-download')!;
  last.focus();
  last.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(f.document.getElementById('filePreviewOverlay')!.contains(f.document.activeElement)).toBe(true);
  f.document.dispatchEvent(
    new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
  expect(f.document.activeElement).toBe(f.trigger);
});
it('makes actual room attachment cards preview by default and retains modified-click download navigation', async () => {
  const f = fixture();
  // Use the real media mixin; only its ordinary DOM construction helper is supplied.
  const mediaContext = vm.createContext({ ReverieApp: class {}, URL });
  vm.runInContext(file('chat-media.js'), mediaContext);
  const proto = vm.runInContext('ReverieApp.prototype', mediaContext);
  f.app._chatEl = (tag: string, cls?: string, text?: string) => {
    const el = f.document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  f.app._chatUrl = (path: string) => '/prefix' + path;
  f.app._chatFileCard = proto._chatFileCard;
  const wrap = proto._chatAttachmentsEl.call(f.app, {
    roomId: 'room-a',
    attachments: [{ id: 'file-a', name: 'notes.md', type: 'text/markdown', size: 10 }],
  });
  f.document.getElementById('under')!.append(wrap);
  const card = wrap.querySelector('a');
  expect(card.hasAttribute('download')).toBe(false);
  const modified = new f.dom.window.MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true });
  card.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(f.calls).toHaveLength(0);
  card.click();
  await vi.waitFor(() => expect(f.document.querySelector('#filePreviewBody h1')?.textContent).toBe('Heading'));
  expect(f.calls[0].url).toBe('/prefix/api/chatrooms/room-a/files/file-a');
});
it('isolates pre-existing session and loopback click delegates and restores the original body afterward', async () => {
  const f = fixture(async () => new Response('[local service](http://localhost:9876/)'));
  const previous = f.document.getElementById('filePreviewBody');
  f.app.openLinkThroughWebTabIfLoopback = vi.fn(() => true);
  f.app._bindResponseViewerInteractions(previous);
  await f.app.openReadOnlyFilePreview(source());
  expect(f.document.getElementById('filePreviewBody')).not.toBe(previous);
  const anchor = f.document.querySelector<HTMLAnchorElement>('#filePreviewBody a')!;
  anchor.onclick = (event) => event.preventDefault();
  anchor.click();
  expect(f.app.openLinkThroughWebTabIfLoopback).not.toHaveBeenCalled();
  f.app.closeFilePreview();
  expect(f.document.getElementById('filePreviewBody')).toBe(previous);
});
it('does not let a late legacy HTML mint replace the explicit-source preview or its text state', async () => {
  const f = fixture();
  let resolve!: (value: string) => void;
  f.app._mintHtmlViewUrl = vi.fn(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      })
  );
  const old = f.app.openFilePreview('legacy.html', 'session-other');
  await vi.waitFor(() => expect(f.app._mintHtmlViewUrl).toHaveBeenCalled());
  await f.app.openReadOnlyFilePreview(source());
  resolve('/legacy-rendered-page');
  await old;
  expect(f.document.querySelector('#filePreviewBody h1')?.textContent).toBe('Heading');
  expect(f.document.querySelector('#filePreviewBody iframe')).toBeNull();
  expect(f.app.filePreviewText.readOnlySource).toBe(true);
});

it('routes actual shared-file text links to the explicit Workspace resolver on ordinary clicks', async () => {
  const f = fixture();
  const source = file('chat-app.js');
  const method = source.slice(source.indexOf('  decorateWorkspaceFiles(root) {'), source.indexOf('  /** Mark `@name`'));
  const Shell = vm.runInNewContext('class Shell { ' + method + ' }; Shell');
  const shell = new Shell(); shell.doc = f.document; shell.app = {openWorkspaceFilePreview:vi.fn()};
  shell.el = (tag:string, cls:string, text:string) => {const el=f.document.createElement(tag);el.className=cls;el.textContent=text;return el;};
  const root=f.document.createElement('div');root.innerHTML='<p>See <code>/reverie_workspace/reports/notes.md</code>.</p>';
  shell.decorateWorkspaceFiles(root);
  const link=root.querySelector<HTMLAnchorElement>('a')!;
  const event=new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(shell.app.openWorkspaceFilePreview).toHaveBeenCalledWith('/reverie_workspace/reports/notes.md',link);
  expect(link.href).toContain('/api/filesystem/download?path=');
});
it('keeps document fragments inside the preview without changing the application hash', async () => {
  const f=fixture(async()=>new Response('[Jump](#section)\n\n<h2 id="section">Section</h2>'));
  await f.app.openReadOnlyFilePreview(source());
  const target=f.document.querySelector<HTMLElement>('#filePreviewBody h2')!;target.scrollIntoView=vi.fn();
  f.document.querySelector<HTMLAnchorElement>('#filePreviewBody a')!.click();
  expect(target.scrollIntoView).toHaveBeenCalledOnce();expect(f.dom.window.location.hash).toBe('');
});

// Backdrop ownership belongs only to the currently mounted read-only viewer.
it('dismisses only the read-only backdrop and removes its handler before reuse', async () => {
  const f = fixture();
  await f.app.openReadOnlyFilePreview(source(), f.trigger);
  const overlay = f.document.getElementById('filePreviewOverlay')!;
  f.document.querySelector('.file-preview-window')!.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(overlay.classList.contains('visible')).toBe(true);
  overlay.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(overlay.classList.contains('visible')).toBe(false);
  expect(f.document.activeElement).toBe(f.trigger);
  const close = vi.spyOn(f.app, 'closeFilePreview');
  overlay.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(close).not.toHaveBeenCalled();
  await f.app.openReadOnlyFilePreview(source('second.md'), f.trigger);
  overlay.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(close).toHaveBeenCalledTimes(1);
});
it('keeps the existing dirty-edit confirmation before a read-only backdrop closes', async () => {
  const f = fixture();
  await f.app.openReadOnlyFilePreview(source(), f.trigger);
  f.app.filePreviewEdit = { dirty: true };
  const confirm = vi.fn(() => false);
  f.context.confirm = confirm;
  const overlay = f.document.getElementById('filePreviewOverlay')!;
  overlay.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(overlay.classList.contains('visible')).toBe(true);
  expect(f.document.getElementById('under')!.inert).toBe(true);
  confirm.mockReturnValue(true);
  overlay.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }));
  expect(overlay.classList.contains('visible')).toBe(false);
});
it('plays MP4/WebM attachments inline and falls back to the preview card when the file is not a playable video', () => {
  const f = fixture();
  const mediaContext = vm.createContext({ ReverieApp: class {}, URL });
  vm.runInContext(file('chat-media.js'), mediaContext);
  const proto = vm.runInContext('ReverieApp.prototype', mediaContext);
  f.app._chatEl = (tag: string, cls?: string, text?: string) => {
    const el = f.document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  f.app._chatUrl = (path: string) => '/prefix' + path;
  f.app._chatFileCard = proto._chatFileCard;
  const wrap = proto._chatAttachmentsEl.call(f.app, {
    roomId: 'room-a',
    attachments: [
      { id: 'clip', name: 'lap.mp4', type: 'video/mp4', size: 10 },
      { id: 'other', name: 'lap.mov', type: 'video/quicktime', size: 10 },
    ],
  });
  const video = wrap.querySelector('video') as HTMLVideoElement;
  expect(video.getAttribute('src')).toBe('/prefix/api/chatrooms/room-a/files/clip');
  expect(video.controls).toBe(true);
  expect(video.preload).toBe('metadata');
  expect(wrap.querySelectorAll('a.chatroom-file')).toHaveLength(1); // the .mov stays a card
  video.dispatchEvent(new f.dom.window.Event('error'));
  expect(wrap.querySelector('video')).toBeNull();
  expect(wrap.querySelectorAll('a.chatroom-file')).toHaveLength(2);
});
