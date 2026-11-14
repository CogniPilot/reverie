/** Actual shipped navigation handlers and read-only served-byte checks; no Engine or keyboard. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createHarness, room, member } from './helpers/chat-app-harness.mjs';
import { selectCanaryDebugChannel, verifyCanaryServedGui } from './fixtures/boxed-canary-browser-proof.mjs';
const roots: string[] = [];
const windows: Array<{ close(): void }> = [];
afterEach(() => {
  for (const w of windows.splice(0)) w.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
function hash(b: Buffer) {
  return createHash('sha256').update(b).digest('hex');
}
function gui() {
  const root = mkdtempSync(join(tmpdir(), 'canary-gui-'));
  roots.push(root);
  const body = Buffer.from('const providerInputHeld = false; // controlled new source DATA');
  const target = '/nix/store/controlled-console/lib/reverie/dist/web/public/app.1234abcd.js';
  const modules = [
    ['', body],
    ['.br', brotliCompressSync(body)],
    ['.gz', gzipSync(body)],
  ].map(([suffix, data], i) => {
    const bytes = data as Buffer;
    const file = join(root, i + '.js');
    writeFileSync(file, bytes);
    return {
      source: 'apps/web/src/web/public/app.js',
      target: target + suffix,
      generatedFile: file,
      sha256: hash(bytes),
      inContainerSha: hash(bytes),
      readOnly: true,
    };
  });
  const page = { locator: () => ({ evaluateAll: async () => ['/app.1234abcd.js'] }) };
  const canary = { endpoint: new URL('http://127.0.0.1:32123'), cookie: 'synthetic-issued-cookie', proof: { modules } };
  return { body, modules, page, canary };
}
it('selects the actual default company workspace then prepared post-only channel through normal DOM clicks', async () => {
  const sid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const h = await createHarness({
    rooms: [room('canary-room', 'Boxed terminal canary', [{ ...member(sid, 'Synthetic'), postOnly: true }])],
    sessions: [{ id: sid, name: 'Synthetic' }],
  });
  windows.push(h.window);
  (h.document.querySelector('[data-key="ws:home"]') as HTMLButtonElement).click();
  await h.flush();
  const locator = (nodes: () => Element[]) => ({
    count: async () => nodes().length,
    click: async (options: object) => {
      expect(options).not.toHaveProperty('force');
      const found = nodes();
      expect(found).toHaveLength(1);
      (found[0] as HTMLElement).click();
      await h.flush();
    },
    locator: (selector: string) => locator(() => nodes().flatMap((n) => [...n.querySelectorAll(selector)])),
  });
  const page = {
    getByRole: (role: string, options: { name: string | RegExp }) =>
      locator(() =>
        [...h.document.querySelectorAll(role === 'navigation' ? 'nav' : 'button')].filter((el) => {
          const name = el.getAttribute('aria-label') || el.textContent || '';
          return typeof options.name === 'string' ? name === options.name : options.name.test(name);
        })
      ),
  };
  await selectCanaryDebugChannel(page);
  expect(h.shell.workspace).toBe('');
  expect(h.shell.roomId).toBe('canary-room');
  expect(h.document.querySelector('[data-key="member:' + sid + '"]')).not.toBeNull();
});
it('refuses missing navigation before any member menu or input action', async () => {
  const click = vi.fn();
  const page = { getByRole: () => ({ locator: () => ({ count: async () => 0, click }) }) };
  await expect(selectCanaryDebugChannel(page)).rejects.toThrow('Exactly one default company workspace required');
  expect(click).not.toHaveBeenCalled();
});
it('checks decoded actual HTTP bytes against raw plus both exact compressed overlay forms', async () => {
  const f = gui();
  const request = vi.fn(async (url: URL, options: RequestInit) => {
    expect(url.origin).toBe(f.canary.endpoint.origin);
    expect(url.pathname).toBe('/app.1234abcd.js');
    expect(options.redirect).toBe('manual');
    expect(options.headers).toMatchObject({ cookie: f.canary.cookie });
    return new Response(f.body, { headers: { 'content-encoding': 'br' } });
  });
  vi.stubGlobal('fetch', request);
  await expect(verifyCanaryServedGui(f.page, f.canary)).resolves.toEqual({
    path: '/app.1234abcd.js',
    sha256: hash(f.body),
    encoding: 'br',
  });
  expect(request).toHaveBeenCalledOnce();
});
it('verifies the served app with the complete seventeen-module startup recovery census', async () => {
  const f = gui();
  for (let index = 3; index < 17; index++)
    f.modules.push({
      ...f.modules[0],
      source: 'apps/web/src/fixture-' + index + '.ts',
      target: '/nix/store/controlled-console/lib/reverie/dist/fixture-' + index + '.js',
    });
  const request = vi.fn(async () => new Response(f.body));
  vi.stubGlobal('fetch', request);
  await expect(verifyCanaryServedGui(f.page, f.canary)).resolves.toMatchObject({ sha256: hash(f.body) });
  expect(request).toHaveBeenCalledOnce();
});
it('accepts the real relative hashed app URL with its exact content cache buster', async () => {
  const f = gui(),
    expected = hash(f.body).slice(0, 16);
  f.page.locator = () => ({ evaluateAll: async () => ['app.1234abcd.js?v=' + expected] });
  const fetch = vi.fn(async (url: URL) => {
    expect(url.search).toBe('?v=' + expected);
    return new Response(f.body);
  });
  vi.stubGlobal('fetch', fetch);
  await expect(verifyCanaryServedGui(f.page, f.canary)).resolves.toMatchObject({ sha256: hash(f.body) });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(['wrong-v', 'duplicate', 'extra', 'unknown', 'fragment', 'encoded-key'] as const)(
  'refuses %s app cache-buster before credential transport',
  async (kind) => {
    const f = gui(),
      v = hash(f.body).slice(0, 16),
      request = vi.fn();
    const query = {
      'wrong-v': '?v=' + '0'.repeat(16),
      duplicate: '?v=' + v + '&v=' + v,
      extra: '?v=' + v + '&other=1',
      unknown: '?other=' + v,
      fragment: '?v=' + v + '#fragment',
      'encoded-key': '?%76=' + v,
    }[kind];
    f.page.locator = () => ({ evaluateAll: async () => ['app.1234abcd.js' + query] });
    vi.stubGlobal('fetch', request);
    await expect(verifyCanaryServedGui(f.page, f.canary)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  }
);
it('refuses the formerly unused source-tree app overlay before any HTTP request', async () => {
  const f = gui(),
    request = vi.fn();
  vi.stubGlobal('fetch', request);
  f.modules[0].target = '/nix/store/controlled-console/lib/reverie/src/web/public/app.js';
  await expect(verifyCanaryServedGui(f.page, f.canary)).rejects.toThrow(
    'Actual served app overlay descriptor required'
  );
  expect(request).not.toHaveBeenCalled();
});
it.each(['wrong-http', 'wrong-br', 'wrong-gz', 'missing-compression', 'oversize-http'] as const)(
  'refuses %s before keyboard dispatch',
  async (kind) => {
    const f = gui();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            kind === 'oversize-http'
              ? Buffer.alloc(1024 * 1024 + 1)
              : kind === 'wrong-http'
                ? Buffer.from('old dispatch GUI')
                : f.body
          )
      )
    );
    if (kind === 'wrong-br' || kind === 'wrong-gz') {
      const i = kind === 'wrong-br' ? 1 : 2;
      const bytes = kind === 'wrong-br' ? brotliCompressSync(Buffer.from('old GUI')) : gzipSync(Buffer.from('old GUI'));
      writeFileSync(f.modules[i].generatedFile, bytes);
      f.modules[i].sha256 = f.modules[i].inContainerSha = hash(bytes);
    }
    if (kind === 'missing-compression') f.modules.pop();
    await expect(verifyCanaryServedGui(f.page, f.canary)).rejects.toThrow();
  }
);
it.each([[], ['http://other.invalid/app.1234abcd.js'], ['/app.1234abcd.js', '/app.ffff1234.js']])(
  'refuses absent/foreign/ambiguous app scripts without credential transport %#',
  async (sources) => {
    const f = gui(),
      request = vi.fn();
    vi.stubGlobal('fetch', request);
    f.page.locator = () => ({ evaluateAll: async () => sources });
    await expect(verifyCanaryServedGui(f.page, f.canary)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  }
);
