import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/web/public/panels-ui.js', import.meta.url), 'utf8');
const attachment = { kind: 'room-attachment', roomId: 'room-a', attachmentId: 'file-a', name: 'notes.md' };
const workspace = { kind: 'workspace', path: 'reports/notes.md', name: 'notes.md', binding: 'a'.repeat(64) };
function fixture(
  answer: any = () =>
    new Response('# Notes\n', { headers: { 'Content-Length': '8', 'X-Reverie-File-Binding': 'a'.repeat(64) } }),
  shortDeadline = false
) {
  class App {
    activeSessionId = 'WRONG-ACTIVE-SESSION';
  }
  const calls: { url: string; options: any }[] = [];
  const context = vm.createContext({
    ReverieApp: App,
    ReverieBase: { url: (path: string) => '/prefix' + path },
    Uint8Array,
    TextDecoder,
    AbortController,
    clearTimeout,
    setTimeout: shortDeadline ? (fn: () => void) => setTimeout(fn, 5) : setTimeout,
    fetch: (url: string, options: any) => {
      calls.push({ url, options });
      return answer(url, options);
    },
  });
  vm.runInContext(source, context);
  const app: any = new App();
  return { app, calls };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe('explicit non-session file preview reader', () => {
  it('loads a room snapshot without looking at the active session or inventing a path', async () => {
    const { app, calls } = fixture();
    const result = await app._readFilePreviewSource(attachment);
    expect(result.content).toBe('# Notes\n');
    expect(result.path).toBeNull();
    expect(result.sourceLabel).toBe('Saved attachment');
    expect(calls.map((c) => c.url)).toEqual(['/prefix/api/chatrooms/room-a/files/file-a']);
    expect(calls[0].options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(result.downloadUrl).toBe(calls[0].url);
  });
  it('uses the guarded Workspace preview route and preserves canonical folder identity', async () => {
    const { app, calls } = fixture();
    const result = await app._readFilePreviewSource(workspace);
    expect(result.path).toBe('reports/notes.md');
    expect(result.sourceLabel).toBe('Current workspace file');
    expect(calls[0].url).toBe(
      '/prefix/api/workspace/file?path=reports%2Fnotes.md&binding=' + 'a'.repeat(64) + '&preview=1'
    );
    expect(result.downloadUrl).toBe('/prefix/api/workspace/file?path=reports%2Fnotes.md&binding=' + 'a'.repeat(64));
  });
  it('refuses unknown sources, caller URLs, session IDs and malformed identities before any read', async () => {
    const { app, calls } = fixture();
    const invalid = [
      null,
      [],
      {},
      { ...attachment, url: 'https://example.org/x' },
      { ...attachment, sessionId: 'active' },
      { ...attachment, roomId: '../other' },
      { ...attachment, attachmentId: 'x?y' },
      { ...attachment, name: 'folder/a.md' },
      { ...attachment, kind: 'session' },
      { ...attachment, roomId: '' },
      { ...attachment, name: 'bad\0.md' },
    ];
    for (const candidate of invalid) await expect(app._readFilePreviewSource(candidate)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('refuses absolute, hidden, traversal, alias and mismatched-name Workspace paths', async () => {
    const { app, calls } = fixture();
    for (const path of [
      '/reports/notes.md',
      '../reports/notes.md',
      'reports/../notes.md',
      'reports//notes.md',
      './notes.md',
      '.private/notes.md',
      'reports\\notes.md',
      'reports/other.md',
      'reports/notes.md\0',
      'a/'.repeat(33) + 'notes.md',
    ]) {
      await expect(app._readFilePreviewSource({ ...workspace, path })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
  it('encodes legal Unicode and URL punctuation as path data', async () => {
    const { app, calls } = fixture();
    await app._readFilePreviewSource({ ...workspace, name: '笔记 #1?.md', path: '资料/笔记 #1?.md' });
    expect(calls[0].url).toContain(
      'path=%E8%B5%84%E6%96%99%2F%E7%AC%94%E8%AE%B0%20%231%3F.md&binding=' + 'a'.repeat(64) + '&preview=1'
    );
  });
  it('does not retry another authority or download route after owner/membership refusal', async () => {
    for (const status of [401, 403, 404, 415, 500]) {
      const { app, calls } = fixture(() => new Response('refused', { status }));
      await expect(app._readFilePreviewSource({ ...workspace, name: 'x.pdf', path: 'x.pdf' })).rejects.toThrow(
        `HTTP ${status}`
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('preview=1');
    }
  });
  it('rejects partial reads rather than portraying a truncated file as complete', async () => {
    const { app } = fixture(() => new Response('partial', { status: 206 }));
    await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('HTTP 206');
  });
  it('rejects redirected responses even when a faulty fetch implementation returns them', async () => {
    const response = new Response('x');
    Object.defineProperty(response, 'redirected', { value: true });
    const { app } = fixture(() => response);
    await expect(app._readFilePreviewSource(attachment)).rejects.toThrow();
  });
  it('bounds claimed length lexically and refuses oversize before consuming a body', async () => {
    for (const length of ['262145', '-1', 'not-a-number', '9'.repeat(5000)]) {
      const { app } = fixture(() => new Response('x', { headers: { 'Content-Length': length } }));
      await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('too large');
    }
  });
  it('bounds actual streaming bytes when the length is missing or dishonest and cancels the stream', async () => {
    for (const headers of [{}, { 'Content-Length': '1' }]) {
      let cancelled = 0;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(262145));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers }
      );
      const { app } = fixture(() => response);
      await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('too large');
      expect(cancelled).toBe(1);
    }
  });
  it('rejects incomplete transfers instead of returning a good-looking prefix', async () => {
    const { app } = fixture(() => new Response('x', { headers: { 'Content-Length': '2' } }));
    await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('incomplete');
  });
  it('refuses malformed UTF-8 or NUL in text despite a text MIME header', async () => {
    for (const data of [new Uint8Array([0xff]), bytes('a\0b')]) {
      const { app } = fixture(() => new Response(data, { headers: { 'Content-Type': 'text/plain' } }));
      await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('UTF-8');
    }
  });
  it('sniffs raster types and refuses extension/MIME claims without actual image bytes', async () => {
    const { app } = fixture(() => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])));
    expect((await app._readFilePreviewSource({ ...attachment, name: 'image.png' })).mediaType).toBe('image/png');
    const bad = fixture(() => new Response('<script>bad</script>', { headers: { 'Content-Type': 'image/png' } }));
    await expect(bad.app._readFilePreviewSource({ ...attachment, name: 'image.png' })).rejects.toThrow('raster');
  });
  it('recognizes bounded PDF bytes but does not infer that Workspace server PDF support exists', async () => {
    const { app } = fixture(() => new Response('%PDF-1.7\n'));
    const pdf = await app._readFilePreviewSource({ ...attachment, name: 'report.pdf' });
    expect(pdf.mediaType).toBe('application/pdf');
    expect(pdf.content).toBeNull();
    const bad = fixture(() => new Response('not a pdf'));
    await expect(bad.app._readFilePreviewSource({ ...attachment, name: 'report.pdf' })).rejects.toThrow('PDF');
  });
  it('returns HTML and SVG as text, never an executable or image URL', async () => {
    for (const name of ['index.html', 'figure.svg']) {
      const { app } = fixture(() => new Response('<script>sentinel()</script>'));
      const result = await app._readFilePreviewSource({ ...attachment, name });
      expect(result.mediaType).toBe('text/plain');
      expect(result.content).toContain('<script>');
      expect(result).not.toHaveProperty('sessionId');
    }
  });
  it('rejects an unsupported binary format before fetching', async () => {
    const { app, calls } = fixture();
    await expect(app._readFilePreviewSource({ ...attachment, name: 'archive.zip' })).rejects.toThrow('format');
    expect(calls).toHaveLength(0);
  });
  it('honors cancellation before a read and during response-body delivery', async () => {
    const before = new AbortController();
    before.abort();
    const first = fixture();
    await expect(first.app._readFilePreviewSource(attachment, before.signal)).rejects.toThrow('cancelled');
    expect(first.calls).toHaveLength(0);
    const during = new AbortController();
    const second = fixture(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              during.abort();
              controller.enqueue(bytes('x'));
            },
          })
        )
    );
    await expect(second.app._readFilePreviewSource(attachment, during.signal)).rejects.toThrow('cancelled');
  });
  it('sets a read deadline and aborts a stalled fetch', async () => {
    const { app, calls } = fixture(
      (_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('deadline abort')), { once: true });
        }),
      true
    );
    await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('deadline abort');
    expect(calls[0].options.signal.aborted).toBe(true);
  });
  it('retains the captured source identity when the caller changes its descriptor during HTTP', async () => {
    const selected = { ...attachment };
    const { app } = fixture(() => {
      selected.kind = 'workspace';
      selected.name = 'changed.md';
      return new Response('original');
    });
    const result = await app._readFilePreviewSource(selected);
    expect(result.kind).toBe('room-attachment');
    expect(result.name).toBe('notes.md');
    expect(result.path).toBeNull();
    expect(result.sourceLabel).toBe('Saved attachment');
  });
  it('keeps an actual stream failure when cancellation also rejects', async () => {
    const { app } = fixture(() => ({
      ok: true,
      status: 200,
      redirected: false,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error('read fault');
          },
          cancel: async () => {
            throw new Error('cancel fault');
          },
        }),
      },
    }));
    await expect(app._readFilePreviewSource(attachment)).rejects.toThrow('read fault');
  });
  it('accepts the exact UTF-8 byte cap without silently truncating the document', async () => {
    const data = 'x'.repeat(256 * 1024);
    const { app } = fixture(() => new Response(data, { headers: { 'Content-Length': String(data.length) } }));
    const result = await app._readFilePreviewSource(attachment);
    expect(result.content).toBe(data);
    expect(result.bytes.byteLength).toBe(256 * 1024);
  });
  it('recognizes JPEG, GIF and WebP signatures and keeps SVG on the text path', async () => {
    for (const [name, data, type] of [
      ['photo.jpg', new Uint8Array([255, 216, 255, 1]), 'image/jpeg'],
      ['anim.gif', bytes('GIF89a----'), 'image/gif'],
      ['pic.webp', bytes('RIFF0000WEBP'), 'image/webp'],
    ] as const) {
      const { app } = fixture(() => new Response(data));
      expect((await app._readFilePreviewSource({ ...attachment, name })).mediaType).toBe(type);
    }
  });

  it('requires a Workspace consistency binding and refuses a mismatched response without fallback', async () => {
    const before = fixture();
    await expect(
      before.app._readFilePreviewSource({ kind: 'workspace', path: workspace.path, name: workspace.name })
    ).rejects.toThrow();
    expect(before.calls).toHaveLength(0);
    const mismatch = fixture(() => new Response('x', { headers: { 'X-Reverie-File-Binding': 'b'.repeat(64) } }));
    await expect(mismatch.app._readFilePreviewSource(workspace)).rejects.toThrow('binding');
    expect(mismatch.calls).toHaveLength(1);
  });
});
