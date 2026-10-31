import { describe, expect, it } from 'vitest';
import { MEMORY_BRIEF_MAX, renderMemoryBrief } from '../src/memory-brief.js';

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
});
