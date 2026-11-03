/** Synthetic DOM/fetch only; no owner session, real preview service or exposure. */
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHarness } from './helpers/chat-app-harness.mjs';
const SID = '11111111-2222-4333-8444-555555555555';
const OTHER = '22222222-3333-4444-8555-666666666666';
const doms: JSDOM[] = [];
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });
const settle = () => new Promise(resolve => setImmediate(resolve));
const source = readFileSync(new URL('../src/web/public/previews.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/web/public/previews.html', import.meta.url), 'utf8');
const params = (values: Record<string,string>) => new URLSearchParams(values).toString();
// As the server sends them: the console wraps every /api payload without its own envelope (the preview route's, errors
// included) as {success: true, data}; a console error is {success: false, error, errorCode} (preview-envelope test).
const response = (data: unknown, ok = true) => ({ ok, json: async () => ({ success: true, data }) });
const consoleError = (error: string) => ({ ok: false, json: async () => ({ success: false, error, errorCode: 'OPERATION_FAILED' }) });
async function page(suffix = '', previews = Promise.resolve(response({ previews: [] })), company = Promise.resolve(response({ employees: [{ sessionId: OTHER, name: 'Other laptop' }, { sessionId: SID, name: 'Fixture laptop' }] }))) {
 const dom = new JSDOM(html, { url: 'https://office.test/previews' + suffix, runScripts: 'outside-only' }); doms.push(dom);
 const calls: {url:string;method:string}[] = [];
 Object.assign(dom.window, { AbortSignal, fetch: (url: URL, options: RequestInit) => {
  calls.push({ url: String(url), method: options.method! });
  if (new URL(url).pathname === '/api/company') return company;
  if (new URL(url).pathname === '/api/previews') return previews;
  throw Error('Unexpected fixture endpoint');
 }});
 dom.window.eval(source); await settle();
 const form = dom.window.document.getElementById('expose') as HTMLFormElement;
 return { dom, calls, form, selected: () => (form.elements.namedItem('sessionId') as HTMLSelectElement),
  port: () => (form.elements.namedItem('port') as HTMLInputElement).value,
  path: () => (form.elements.namedItem('path') as HTMLInputElement).value,
  status: () => dom.window.document.getElementById('status')!.textContent! };
}
const setupError = 'HTTPS preview service is not configured or is unavailable. See the laptop previews setup guide.';
it('keeps the laptop roster and requested fields when preview listing reports setup failure', async () => {
 const p = await page('?' + params({ sessionId: SID, port: '8742', path: '/guide/example.html' }), Promise.resolve(response({ error: setupError }, false)));
 expect(p.selected().options).toHaveLength(2); expect(p.selected().value).toBe(SID);
 expect(p.port()).toBe('8742'); expect(p.path()).toBe('/guide/example.html'); expect(p.status()).toBe(setupError);
 expect(p.status()).not.toContain('No laptop ports'); expect(p.calls.every(c => c.method === 'GET')).toBe(true);
});
it('populates laptops before a slow preview-list request finishes', async () => {
 let finish!: (r: ReturnType<typeof response>) => void;
 const p = await page('', new Promise(resolve => { finish = resolve; }));
 expect(p.selected().options).toHaveLength(2);
 finish(response({ error: setupError }, false)); await settle(); expect(p.status()).toBe(setupError);
});
it('does not describe a roster failure as an empty successful laptop list', async () => {
 const p = await page('', Promise.resolve(response({ previews: [] })), Promise.resolve(consoleError('Company unavailable.')));
 expect(p.selected().options).toHaveLength(0); expect(p.status()).toContain('Could not load laptops. Company unavailable.');
});
it('retains successful listing and laptop labels when both sources succeed', async () => {
 const p = await page('', Promise.resolve(response({ previews: [{ id: 'a'.repeat(32), sessionId: SID, port: 8742, expiresIn: 60 }] })));
 expect(p.dom.window.document.querySelector('article h2')!.textContent).toBe('Fixture laptop · port 8742');
 expect(p.status()).toBe('Exposed ports are listed below.'); expect(p.calls).toHaveLength(2);
});
it.each(['?', '#previews?'])('accepts validated %s deep-link fields without automatically exposing a port', async prefix => {
 const p = await page(prefix + params({ sessionId: SID, port: '8742', path: '/guide/example.html?mode=phone&name=a b' }));
 expect(p.selected().value).toBe(SID); expect(p.port()).toBe('8742'); expect(p.path()).toBe('/guide/example.html?mode=phone&name=a b');
 expect(p.calls.every(c => c.method === 'GET')).toBe(true);
});
it('lets explicit normal query fields take precedence over hash fields', async () => {
 const p = await page('?port=8742#previews?' + params({ sessionId: SID, port: '8735', path: '/guide/example.html' }));
 expect(p.port()).toBe('8742'); expect(p.path()).toBe('/guide/example.html'); expect(p.selected().value).toBe(SID);
});
it.each(['80', '65536', '8092', '8093', '8742.5', '8742#other'])('does not prefill invalid/reserved port %s', async port => {
 const p = await page('#previews?' + params({ port })); expect(p.port()).toBe('8734'); expect(p.status()).toContain('preview link fields were invalid');
});
it.each(['//other.test/', '/x\\y', '/x#other', '/x\u0000y', 'relative', '/' + 'x'.repeat(4096)])('rejects an invalid path without submitting it', async path => {
 const p = await page('#previews?' + params({ path })); expect(p.path()).toBe('/'); expect(p.status()).toContain('preview link fields were invalid');
 expect(p.calls.every(c => c.method === 'GET')).toBe(true);
});
it.each(['not-a-session', '33333333-4444-4555-8666-777777777777'])('never substitutes another laptop for requested unavailable identity %s', async sessionId => {
 const p = await page('#previews?' + params({ sessionId })); expect(p.selected().value).toBe(''); expect(p.selected().checkValidity()).toBe(false);
});
it('ignores fragments for unrelated pages', async () => {
 const p = await page('#board?port=8742&path=%2Fguide%2Fexample.html'); expect(p.port()).toBe('8734'); expect(p.path()).toBe('/');
});
describe('actual shell preview URL forwarding', () => {
 it('opens a hash-only preview link and preserves only the three preview fields through the mounted shell', async () => {
  const hash = '#previews?' + params({ sessionId: SID, port: '8742', path: '/guide/example.html?x=1&y=two', token: 'not-forwarded' });
  const h = await createHarness({ hash, loadShell: false }); doms.push(h.dom); h.window.__REVERIE_BASE__ = '/office'; await h.startShell(); await h.flush(80);
  expect(h.window.reverieChat.embed).toBe('previews');
  const frame = h.document.querySelector('iframe.ca-page-frame')! as HTMLIFrameElement;
  const url = new URL(frame.src); expect(url.pathname).toBe('/office/previews');
  expect(Object.fromEntries(url.searchParams)).toEqual({ sessionId: SID, port: '8742', path: '/guide/example.html?x=1&y=two' });
  expect(h.window.location.hash).toBe(hash);
 });
 it('forwards normal query parameters, handles a replacement preview link, and keeps other page hashes exact', async () => {
  const h = await createHarness({ hash: '?port=8742#previews', loadShell: false }); doms.push(h.dom); await h.startShell(); await h.flush(80);
  const frame = h.document.querySelector('iframe.ca-page-frame')! as HTMLIFrameElement; expect(new URL(frame.src).searchParams.get('port')).toBe('8742');
  h.window.history.replaceState(null, '', '/#previews?port=8743'); h.window.reverieChat.openPage('previews', { push: false });
  expect(new URL(frame.src).searchParams.get('port')).toBe('8743');
  h.window.history.replaceState(null, '', '/#board?port=8742'); h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  expect(h.window.reverieChat.embed).toBeNull();
 });
});
