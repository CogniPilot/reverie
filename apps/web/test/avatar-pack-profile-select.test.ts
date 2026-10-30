/**
 * The office and accounts pages offer pack avatars in a profile select. The manifest's sources carry a version
 * (`?v=`), which the old filter never matched, so the select offered none; it now lists the manifest's offered set
 * (minus the "withheld" line) and stores each avatar's plain path, the form the server validates.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const manifest = JSON.parse(read('assets/avatars/pack-manifest.json'));

async function page(html: string, script: string, data: Record<string, unknown>) {
  const dom = new JSDOM(read(html).replace(/<script[\s\S]*?<\/script>/g, ''), { url: 'http://reverie.test/', runScripts: 'outside-only' });
  const w = dom.window as any;
  w.fetch = async (url: string) => {
    const path = new URL(url, 'http://reverie.test/').pathname;
    if (path === '/assets/avatars/pack-manifest.json') return { ok: true, status: 200, json: async () => manifest };
    const key = path.replace('/api/office/', '');
    return { ok: key in data, status: key in data ? 200 : 404, json: async () => ({ success: key in data, data: data[key], error: 'missing' }) };
  };
  w.setInterval = () => 0;
  w.eval(read(script));
  for (let i = 0; i < 50 && w.document.querySelectorAll('select[name="avatar"] option').length < 2; i++) await new Promise(r => setTimeout(r, 10));
  const options = [...w.document.querySelectorAll('select[name="avatar"] option')].map((o: any) => ({ value: o.value, text: o.textContent }));
  dom.window.close();
  return options;
}

const expectOffered = (options: Array<{ value: string; text: string }>) => {
  const packs = options.filter(o => o.value.startsWith('/assets/avatars/'));
  expect(packs).toHaveLength(100);
  expect(packs.every(o => /^\/assets\/avatars\/pack-[0-9]{2,3}\.png$/.test(o.value))).toBe(true);
  expect(packs.map(o => o.text)).toContain('Deadpan Rocket');
  expect(packs.map(o => o.text)).not.toContain('Sly Jester');
  expect(packs.map(o => o.text)).not.toContain('Star Navigator');
};

describe('profile avatar selects', () => {
  it('office page offers the manifest set as plain paths', async () => {
    expectOffered(await page('office.html', 'office.js', { me: { person: { name: 'Robin', avatar: '' } }, rooms: { rooms: [] } }));
  });
  it('accounts page offers the manifest set as plain paths', async () => {
    expectOffered(await page('people.html', 'people.js', {
      accounts: { people: [], rooms: [], self: { primary: false, name: 'Robin', avatar: '' } },
    }));
  });
});
