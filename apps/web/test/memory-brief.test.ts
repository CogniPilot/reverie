import { describe, expect, it } from 'vitest';
import { KEYSTONE_CHARS, MEMORY_BRIEF_MAX, MEMORY_BRIEF_NEWEST, PROMISE_BRIEF_CHARS, renderMemoryBrief } from '../src/memory-brief.js';

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
    expect(text).toContain('reverie agent journal save --reason "<why now>"');
    expect(text).toContain('a message from someone else in that room');
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

  it('places open promises only in what keystone and important entries leave, never pushing one out, and says what it left out', () => {
    const now = Date.parse('2026-11-02T18:00:00Z');
    const open = [1, 2, 3].map((i) => ({ entryId: 100 + i, committedAt: '2026-10-27T14:02:31.000Z', text: 'p'.repeat(900),
      due: `2026-11-0${i}T20:00:00.000Z`, overdue: i === 1 }));
    const lines = (text: string) => text.split('\n').filter((line) => line.startsWith('- #'));
    // Four long keystones already fill the brief: promises get no room, and every keystone line the brief showed
    // without promises is still there, unchanged.
    const keystones = [1, 2, 3, 4].map((i) => entry(i, { importance: 'keystone', text: 'k'.repeat(400) }));
    const without = renderMemoryBrief('Maple', { total: 12, entries: keystones }, now);
    const crowded = renderMemoryBrief('Maple', { total: 12, entries: keystones, open, openTotal: 5 }, now);
    expect(lines(crowded)).toEqual(lines(without));
    expect(crowded.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX);
    expect(crowded).not.toContain('Open promises');
    expect(crowded).toMatch(/\d+ more \(5 open promises\): reverie agent journal map\.$/);
    // One short keystone leaves room: a capped block, soonest due first, rows cut, the overdue one marked, then the
    // newest other entry, and the promises it could not fit counted in the last line.
    const roomy = renderMemoryBrief('Maple', { total: 9, entries: [entry(1, { importance: 'keystone' }), entry(2)], open, openTotal: 5 }, now);
    const all = roomy.split('\n');
    const start = all.indexOf('Open promises (your own notes, unverified):');
    const rows = all.slice(start + 1).filter((line) => line.startsWith('- #10'));
    expect(start).toBeGreaterThan(all.findIndex((line) => line.startsWith('- #1 keystone')));
    expect([all[start], ...rows].join('\n').length).toBeLessThanOrEqual(PROMISE_BRIEF_CHARS);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatch(/^- #101 due 2026-11-01 20:00 UTC, overdue: p+…$/);
    expect(rows[0]!.split(': ').pop()!.length).toBe(80);
    expect(all.findIndex((line) => line.startsWith('- #2,'))).toBeGreaterThan(start);
    expect(roomy).toContain(`${9 - 2 - rows.length} more (${5 - rows.length} open promises): reverie agent journal map.`);
    expect(roomy.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX);
  });
});
