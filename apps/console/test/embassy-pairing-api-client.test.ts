import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('marks every owner pairing method while preserving JSON and excluding unrelated or foreign routes', async () => {
  class App {}
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  runInNewContext(readFileSync(new URL('../src/web/public/api-client.js', import.meta.url), 'utf8'), { CodemanApp: App, fetch });
  const app = new App() as App & { _api(path: string, opts?: object): Promise<unknown> };
  for (const path of ['/api/embassy-host', '/api/embassy-host/posts?after=1', '/api/embassy-pairing', '/api/embassy-pairing/abc/reconnect']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const body = method === 'POST' ? { text: 'hello' } : undefined;
      await app._api(path, { method, body });
      const opts = fetch.mock.calls.at(-1)![1];
      expect(opts.headers['X-Reverie-CSRF']).toBe('1');
      if (body) {
        expect(opts.headers['Content-Type']).toBe('application/json');
        expect(opts.body).toBe(JSON.stringify(body));
      }
    }
  }
  for (const path of ['/api/embassy-guest/abc', '/api/sessions', 'https://foreign.example/api/embassy-host', '/api/embassy-hostile']) {
    await app._api(path);
    expect(fetch.mock.calls.at(-1)![1].headers).toBeUndefined();
  }
});
