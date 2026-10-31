import { describe, expect, it } from 'vitest';
import { KEYSTONE_CHARS, MEMORY_BRIEF_MAX, MEMORY_BRIEF_NEWEST, renderMemoryBrief } from '../src/memory-brief.js';

const entry = (entryId: number, extra: Record<string, unknown> = {}) => ({
  entryId, committedAt: '2026-10-27T14:02:31.000Z', tags: ['decision'], text: 'James merges; agents never merge.', ...extra,
});

describe('memory brief', () => {
  it('says who the agent is, that its memory outlives a model change, how to use it, and lists its top entries as data', () => {
    const text = renderMemoryBrief('Maple', { total: 3, entries: [entry(7, { importance: 'keystone' }), entry(9)] });
    expect(text).toContain('you are Maple, a persistent Reverie employee');
    expect(text).toContain('The model and runtime running you can change');
    expect(text).toContain('reverie agent journal recall "<topic>"');
    expect(text).toContain('--importance keystone');
    expect(text).toContain('Your journal has 3 entries.');
    expect(text).toContain('- #7 keystone, 2026-10-27 14:02 UTC [decision]: James merges; agents never merge.');
    expect(text).toContain('1 more: reverie agent journal map.');
    expect(text).not.toMatch(/read the rules/i);
  });

  it('works with no entries and stays within budget with long, hostile entries', () => {
    expect(renderMemoryBrief('Rowan', { total: 0, entries: [] })).toContain('Your journal has no entries yet.');
    const long = Array.from({ length: 20 }, (_, i) => entry(i + 1, { text: 'x'.repeat(900) + '‮', tags: ['a'.repeat(80)] }));
    const text = renderMemoryBrief('N'.repeat(500) + '\n', { total: 20, entries: long });
    expect(text.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX);
    expect(text).not.toContain('‮');
    expect(text).toMatch(/\d+ more: reverie agent journal map\.$/);
  });

  it('carries the clock, keeps keystone and important entries ahead of a short newest tail, and marks a cut entry', () => {
    const now = Date.parse('2026-10-31T07:45:30Z');
    const text = renderMemoryBrief('Maple', {
      total: 7,
      entries: [entry(1, { importance: 'keystone' }), entry(2, { importance: 'important' }), entry(3, { importance: 'important' }),
        entry(4, { importance: 'notable' }), entry(5), entry(6), entry(7)],
    }, now);
    expect(text.split('\n')[0]).toContain('It is now 2026-10-31 07:45 UTC.');
    expect(text.startsWith('Your memory:')).toBe(true);
    // Every keystone and important entry, then only the newest MEMORY_BRIEF_NEWEST of the rest.
    expect(MEMORY_BRIEF_NEWEST).toBe(2);
    expect([...text.matchAll(/^- #(\d+)/gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5]);
    expect(text).toContain('2 more: reverie agent journal map.');
    const cut = renderMemoryBrief('Maple', { total: 1, entries: [entry(9, { text: 'z'.repeat(400) })] }, now);
    const line = cut.split('\n').find((l) => l.startsWith('- #9'))!;
    expect(line.endsWith('…')).toBe(true);
    expect(line.split(': ').pop()!.length).toBe(160);
    expect(renderMemoryBrief('Maple', { total: 1, entries: [entry(9, { text: 'short note' })] }, now)).not.toContain('…');
    // A keystone (a standing rule or decision with its provenance) keeps more of its text before the cut.
    const keystone = renderMemoryBrief('Maple', { total: 1, entries: [entry(9, { importance: 'keystone', text: 'k'.repeat(400) })] }, now);
    const kline = keystone.split('\n').find((l) => l.startsWith('- #9'))!;
    expect(KEYSTONE_CHARS).toBe(320);
    expect(kline.split(': ').pop()!.length).toBe(KEYSTONE_CHARS);
    expect(kline.endsWith('…')).toBe(true);
  });
});
