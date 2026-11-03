/**
 * The avatar pack's manifest is the one list pickers offer from: every entry has its full image, a small WebP preview
 * and a provenance record, and the people set is held back by a single "withheld" line (so offering it is a one-line
 * change). Pickers show the preview and store the full image's path.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(import.meta.dirname, '../src/web/public/assets/avatars');
const read = (name: string) => readFileSync(resolve(DIR, name));
const sha = (name: string) => createHash('sha256').update(read(name)).digest('hex');
const text = read('pack-manifest.json').toString('utf8');
const manifest = JSON.parse(text) as { withheld: string[]; avatars: Array<{ id: string; name: string; src: string; thumb: string }> };
const provenance = new Set((JSON.parse(read('pack-provenance.json').toString('utf8')).assets as Array<{ id: string }>).map(a => a.id));
const num = (id: string) => Number(id.slice(5));

describe('avatar pack manifest', () => {
  it('lists every pack image once, each with its file and a provenance record', () => {
    const ids = manifest.avatars.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.map(num)).toEqual(Array.from({ length: 151 }, (_, i) => i + 1));
    for (const a of manifest.avatars) {
      expect(a.src.split('?')[0]).toBe(`/assets/avatars/${a.id}.png`);
      if (a.src.includes('?v=')) expect(a.src.split('?v=')[1]).toBe(sha(`${a.id}.png`));
      expect(provenance.has(a.id)).toBe(true);
      expect(a.name.trim()).not.toBe('');
    }
  });

  it('gives every entry a 256 px WebP preview whose version is its content hash', () => {
    for (const a of manifest.avatars) {
      expect(a.thumb).toMatch(new RegExp(`^/assets/avatars/thumbs/${a.id}\\.webp\\?v=[a-f0-9]{64}$`));
      const file = `thumbs/${a.id}.webp`;
      expect(a.thumb.split('?v=')[1]).toBe(sha(file));
      const data = read(file);
      expect(data.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(data.subarray(8, 12).toString('latin1')).toBe('WEBP');
      expect(data.length).toBeLessThan(64 * 1024);
    }
  });

  it('holds back exactly the people set (51-101) on one line, and offers the other 100', () => {
    expect(manifest.withheld).toEqual(Array.from({ length: 51 }, (_, i) => `pack-${51 + i}`));
    expect(text.split('\n').filter(line => line.includes('"withheld"'))).toHaveLength(1);
    expect(text.split('\n').find(line => line.includes('"withheld"'))).toContain('"pack-101"]');
    const offered = manifest.avatars.filter(a => !manifest.withheld.includes(a.id)).map(a => num(a.id));
    expect(offered).toEqual([...Array.from({ length: 50 }, (_, i) => i + 1), ...Array.from({ length: 50 }, (_, i) => i + 102)]);
  });

  it('every picker reads the withheld line rather than a hard-coded range', () => {
    const pub = resolve(import.meta.dirname, '../src/web/public');
    for (const file of ['chat-app.js', 'bots.js', 'office.js', 'people.js']) {
      const source = readFileSync(resolve(pub, file), 'utf8');
      expect(source, file).toContain('.withheld');
      expect(source, file).not.toContain('50|10[2-9]');
    }
  });
});
