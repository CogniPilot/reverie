import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'workspace-files.html'), 'utf8');
const script = readFileSync(resolve(publicDir, 'workspace-files.js'), 'utf8');
let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());
const item = (name: string, kind = 'file', path = name) => ({
  name,
  path,
  kind,
  size: 8,
  modified: new Date(0).toISOString(),
});
const listing = (entries = [item('report.txt')], enabled = true, limited = false) =>
  new Response(
    JSON.stringify({
      success: true,
      data: { entries, limited, upload: { enabled, reason: enabled ? '' : 'Uploads go to the root only.' } },
    })
  );
function setup(fetcher: (input: string, options?: RequestInit) => Promise<Response>, configure?: (win: any) => void) {
  dom = new JSDOM(html, { url: 'http://localhost/prefix/workspace', runScripts: 'outside-only' });
  const win = dom.window;
  win.fetch = fetcher as never;
  win.TextDecoder = TextDecoder as never;
  win.matchMedia = (() => ({ matches: false })) as never;
  configure?.(win);
  win.eval(script);
  return { win, doc: win.document, button: (id: string) => win.document.getElementById(id) as HTMLButtonElement };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('starts without an empty preview, waits for upload authority, and searches literal names without another request', async () => {
  const first = deferred<Response>();
  const fetcher = vi.fn(() => first.promise);
  const { win, doc, button } = setup(fetcher);
  expect(button('upload').disabled).toBe(true);
  expect(doc.getElementById('preview')!.hidden).toBe(true);
  first.resolve(listing([item('project', 'directory'), item('literal <img>.txt'), item('other.txt')]));
  await vi.waitFor(() => expect(doc.querySelectorAll('#files button')).toHaveLength(3));
  expect(button('upload').disabled).toBe(false);
  const search = doc.getElementById('search') as HTMLInputElement;
  search.value = '<IMG>';
  search.dispatchEvent(new win.Event('input'));
  expect(doc.querySelectorAll('#files button')).toHaveLength(1);
  expect(doc.querySelector('#files button')!.textContent).toContain('literal <img>.txt');
  expect(doc.querySelectorAll('img')).toHaveLength(0);
  expect(doc.getElementById('status')!.textContent).toBe('1 of 3 items');
  expect(fetcher).toHaveBeenCalledTimes(1);
  search.value = 'absent';
  search.dispatchEvent(new win.Event('input'));
  expect(doc.getElementById('empty-state')!.textContent).toContain('No matching files');
  search.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(doc.querySelectorAll('#files button')).toHaveLength(3);
});

it('opens a selected file, renders inert preview text, and restores the full list and focus when closed', async () => {
  const { doc } = setup(async (input) =>
    input.includes('/file?')
      ? new Response('<img src=x onerror="window.executed=true">', { headers: { 'content-type': 'text/plain' } })
      : listing()
  );
  await vi.waitFor(() => expect(doc.querySelector('#files button')).not.toBeNull());
  const file = doc.querySelector('#files button') as HTMLButtonElement;
  file.click();
  await vi.waitFor(() => expect(doc.querySelector('#preview pre')?.textContent).toContain('<img'));
  expect(doc.querySelectorAll('img')).toHaveLength(0);
  expect(file.getAttribute('aria-pressed')).toBe('true');
  expect(doc.getElementById('layout')!.classList.contains('preview-open')).toBe(true);
  const link = doc.querySelector('#preview a') as HTMLAnchorElement;
  expect(link.href).toBe('http://localhost/prefix/api/workspace/file?path=report.txt');
  (doc.querySelector('[aria-label="Close preview"]') as HTMLButtonElement).click();
  expect(doc.getElementById('preview')!.hidden).toBe(true);
  expect(doc.getElementById('layout')!.classList.contains('preview-open')).toBe(false);
  expect(doc.activeElement).toBe(file);
  expect(file.getAttribute('aria-pressed')).toBe('false');
});

it('does not reopen a preview when an earlier request finishes after close', async () => {
  const pending = deferred<Response>();
  const { doc } = setup(async (input) => (input.includes('/file?') ? pending.promise : listing()));
  await vi.waitFor(() => expect(doc.querySelector('#files button')).not.toBeNull());
  (doc.querySelector('#files button') as HTMLButtonElement).click();
  (doc.querySelector('[aria-label="Close preview"]') as HTMLButtonElement).click();
  pending.resolve(new Response('late contents', { headers: { 'content-type': 'text/plain' } }));
  await new Promise<void>((done) => setTimeout(done, 0));
  await vi.waitFor(() => expect(doc.getElementById('preview')!.hidden).toBe(true));
  expect(doc.getElementById('preview')!.textContent).toBe('');
});

it('keeps nested-folder uploads disabled and identifies the current breadcrumb', async () => {
  const fetcher = vi.fn(async (input: string) =>
    new URL(input, 'http://localhost/').searchParams.get('path')
      ? listing([item('report.txt', 'file', 'project/report.txt')], false)
      : listing([item('project', 'directory')])
  );
  const { doc, button } = setup(fetcher);
  await vi.waitFor(() => expect(doc.querySelector('#files button')).not.toBeNull());
  (doc.querySelector('#files button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(doc.querySelector('[aria-current="location"]')!.textContent).toBe('project'));
  expect(button('upload').disabled).toBe(true);
  expect(doc.getElementById('uploadHint')!.textContent).toContain('Open Workspace');
  expect(doc.getElementById('uploadReason')!.textContent).toContain('root only');
  expect(fetcher.mock.calls[1][0]).toBe('api/workspace/files?path=project');
  button('up').click();
  await vi.waitFor(() => expect(button('upload').disabled).toBe(false));
});

it('retains a refused upload state after an upload settles and a root refresh loses authority', async () => {
  const upload = deferred<Response>();
  let reads = 0;
  const fetcher = vi.fn(async (_input: string, options?: RequestInit) => {
    if (options?.method === 'POST') return upload.promise;
    return listing([item('report.txt')], ++reads === 1);
  });
  const { win, button } = setup(fetcher);
  await vi.waitFor(() => expect(button('upload').disabled).toBe(false));
  const input = button('upload') as unknown as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new win.File(['local fixture'], 'upload.txt')], configurable: true });
  input.dispatchEvent(new win.Event('change'));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  upload.resolve(new Response(JSON.stringify({ success: true })));
  await vi.waitFor(() => expect(reads).toBe(2));
  await vi.waitFor(() => expect(button('upload').disabled).toBe(true));
  expect(input.closest('label')!.getAttribute('aria-disabled')).toBe('true');
  expect(fetcher.mock.calls[1][0]).toBe('api/workspace/files?path=&name=upload.txt');
});

it('labels search results as a loaded subset when the server scan is limited', async () => {
  const { win, doc } = setup(async () => listing([item('report.txt')], true, true));
  await vi.waitFor(() => expect(doc.getElementById('status')!.textContent).toContain('limited'));
  const search = doc.getElementById('search') as HTMLInputElement;
  search.value = 'absent';
  search.dispatchEvent(new win.Event('input'));
  expect(doc.getElementById('status')!.textContent).toBe('0 of 1+ loaded items');
  expect(doc.getElementById('empty-state')!.textContent).toContain('Only the loaded files are searched');
});

it('sorts by date and size in either direction and offers a direct download for each file', async () => {
  const smallOld = { ...item('older.txt'), size: 4, modified: '2020-01-01T00:00:00Z' };
  const largeNew = { ...item('newer.txt'), size: 100, modified: '2026-01-01T00:00:00Z' };
  const { win, doc } = setup(async () => listing([smallOld, largeNew]));
  await vi.waitFor(() => expect(doc.querySelectorAll('#files button')).toHaveLength(2));
  const names = () => [...doc.querySelectorAll('#files .file-name')].map((node) => node.textContent);
  (doc.querySelector('[data-sort="modified"]') as HTMLButtonElement).click();
  expect(names()).toEqual(['newer.txt', 'older.txt']);
  (doc.querySelector('[data-sort="modified"]') as HTMLButtonElement).click();
  expect(names()).toEqual(['older.txt', 'newer.txt']);
  (doc.querySelector('[data-sort="size"]') as HTMLButtonElement).click();
  expect(names()).toEqual(['newer.txt', 'older.txt']);
  const sort = doc.getElementById('sort') as HTMLSelectElement;
  sort.value = 'size:1';
  sort.dispatchEvent(new win.Event('change'));
  expect(names()).toEqual(['older.txt', 'newer.txt']);
  const download = doc.querySelector('[aria-label="Download older.txt"]') as HTMLAnchorElement;
  expect(download.href).toBe('http://localhost/prefix/api/workspace/file?path=older.txt');
  expect(download.download).toBe('older.txt');
  expect(doc.getElementById('preview')!.hidden).toBe(true);
});

it('renders standalone Markdown and static HTML through the same sanitizer without remote/navigation authority', async () => {
  for(const name of ['notes.md','static.html']) {
    const content=name.endsWith('.md')?'# Heading\n\n![remote](https://outside.invalid/x)\n\n[link](https://outside.invalid)':'<h1>Heading</h1><script>sentinel()</script><form><input></form><img src="https://outside.invalid/x">';
    const {doc}=setup(async input=>input.includes('/file?')?new Response(content,{headers:{'content-type':'text/plain'}}):listing([item(name)]),win=>{
      win.eval(readFileSync(resolve(publicDir,'vendor/marked.min.js'),'utf8'));
      win.eval(readFileSync(resolve(publicDir,'vendor/dompurify.min.js'),'utf8'));
      win.eval(readFileSync(resolve(publicDir,'sanitize-html.js'),'utf8'));
    });
    await vi.waitFor(()=>expect(doc.querySelector('#files button')).not.toBeNull());(doc.querySelector('#files button') as HTMLButtonElement).click();
    if(name.endsWith('.md')) {await vi.waitFor(()=>expect(doc.querySelector('#preview h1')?.textContent).toBe('Heading'));expect(doc.querySelector('#preview img,#preview article a')).toBeNull();}
    else {await vi.waitFor(()=>expect(doc.querySelector('#preview iframe')).not.toBeNull());const frame=doc.querySelector('iframe')!;expect(frame.getAttribute('sandbox')).toBe('');expect(frame.srcdoc).not.toContain('<script');expect(frame.srcdoc).not.toContain('<form');}
    dom?.window.close();
  }
});
it('refuses standalone stale binding and over-budget streams while retaining Download', async () => {
  for(const failure of ['binding','size']) {
    const {doc}=setup(async input=>input.includes('/file?')?new Response(failure==='size'?'x'.repeat(256*1024+1):'stale',{headers:{'content-type':'text/plain','X-Reverie-File-Binding':failure==='binding'?'b'.repeat(64):'a'.repeat(64)}}):listing([{...item('notes.txt'),binding:'a'.repeat(64)}] as never));
    await vi.waitFor(()=>expect(doc.querySelector('#files button')).not.toBeNull());(doc.querySelector('#files button') as HTMLButtonElement).click();
    await vi.waitFor(()=>expect(doc.querySelector('#preview .preview-note')?.textContent).toContain(failure==='binding'?'changed':'too large'));
    expect(doc.querySelector('#preview a')?.textContent).toContain('Download');dom?.window.close();
  }
});
