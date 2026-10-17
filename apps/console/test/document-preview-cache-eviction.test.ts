import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { pruneDocumentPreviewCache } from '../src/document-preview-cache.js';

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
    rm: vi.fn(async () => undefined),
  },
}));

const mockedReaddir = vi.mocked(fs.readdir);
const mockedStat = vi.mocked(fs.stat);
const mockedRm = vi.mocked(fs.rm);

describe('pruneDocumentPreviewCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mtime encoded in the filename (f0 oldest ... f101 newest)
    mockedStat.mockImplementation(async (p) => {
      const m = /f(\d+)\.pdf$/.exec(String(p));
      return { mtimeMs: m ? Number(m[1]) : 0, isFile: () => true } as never;
    });
  });

  it('evicts the oldest *.pdf files once the cache exceeds the cap (default 100)', async () => {
    const names = Array.from({ length: 102 }, (_, i) => `f${i}.pdf`);
    mockedReaddir.mockResolvedValue(names as never);

    await pruneDocumentPreviewCache('/tmp/codeman-document-preview-cache');

    // 102 - 100 = 2 oldest removed
    expect(mockedRm).toHaveBeenCalledTimes(2);
    const removed = mockedRm.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.endsWith('f0.pdf'))).toBe(true);
    expect(removed.some((p) => p.endsWith('f1.pdf'))).toBe(true);
    expect(removed.some((p) => p.endsWith('f101.pdf'))).toBe(false); // newest kept
  });

  it('ignores non-pdf entries (e.g. transient work-* dirs) when counting', async () => {
    const names = [...Array.from({ length: 50 }, (_, i) => `f${i}.pdf`), 'work-abc', 'work-def'];
    mockedReaddir.mockResolvedValue(names as never);

    await pruneDocumentPreviewCache('/tmp/codeman-document-preview-cache');

    expect(mockedRm).not.toHaveBeenCalled(); // 50 pdfs <= cap
  });

  it('never throws when the cache dir cannot be read', async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'));
    await expect(pruneDocumentPreviewCache('/tmp/missing')).resolves.toBeUndefined();
    expect(mockedRm).not.toHaveBeenCalled();
  });
});
