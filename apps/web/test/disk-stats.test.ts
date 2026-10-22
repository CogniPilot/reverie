import { afterEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { createDiskStatsReader, diskTargets, parseScratchMounts, type DiskProbe } from '../src/disk-stats.js';

afterEach(() => vi.unstubAllEnvs());
const capacity = (device = 'one', availableBlocks = 20): DiskProbe => ({ device, blocks: 100, availableBlocks, blockSize: 1024 });
it('reports whole filesystem capacity minus available space and groups shared storage locations', async () => {
  const targets = [{ label: 'Company data', path: '/private/company' }, { label: 'Workspace', path: '/private/projects' }, { label: 'Scratch', path: '/private/scratch' }];
  const read = createDiskStatsReader(() => targets, { probe: async path => capacity(path.endsWith('scratch') ? 'two' : 'one', path.endsWith('scratch') ? 5 : 20) });
  const result = await read();
  expect(result).toEqual({ available: true, filesystems: [
    { labels: ['Company data', 'Workspace'], totalBytes: 102400, usedBytes: 81920, availableBytes: 20480, percentUsed: 80 },
    { labels: ['Scratch'], totalBytes: 102400, usedBytes: 97280, availableBytes: 5120, percentUsed: 95 },
  ] });
  expect(JSON.stringify(result)).not.toContain('/private'); expect(JSON.stringify(result)).not.toContain('device');
});
it('honors configured instance, workspace and scratch locations without returning those paths to the browser', () => {
  vi.stubEnv('REVERIE_ROOT', `${homedir()}/deployment`); vi.stubEnv('REVERIE_DATA_DIR', `${homedir()}/custom-data`);
  vi.stubEnv('REVERIE_CASES_PATH', `${homedir()}/projects/cases`); vi.stubEnv('REVERIE_SCRATCH', `${homedir()}/large-disk`); vi.stubEnv('TMPDIR', `${homedir()}/large-disk/tmp`);
  expect(diskTargets()).toEqual(expect.arrayContaining([
    { label: 'Company data', path: `${homedir()}/custom-data` }, { label: 'Workspace', path: `${homedir()}/projects/cases` },
    { label: 'Scratch', path: `${homedir()}/large-disk` }, { label: 'Temporary files', path: `${homedir()}/large-disk/tmp` },
  ]));
});
it('isolates inaccessible or invalid filesystems while retaining valid readings', async () => {
  const labels = ['good', 'denied', 'zero', 'negative', 'over-capacity', 'infinite'];
  const read = createDiskStatsReader(() => labels.map(label => ({ label, path: label })), { probe: async path => {
    if (path === 'denied') throw new Error('Permission denied');
    return { ...capacity(path), ...(path === 'zero' ? { blocks: 0 } : path === 'negative' ? { availableBlocks: -1 } : path === 'over-capacity' ? { availableBlocks: 101 } : path === 'infinite' ? { blockSize: Infinity } : {}) };
  } });
  expect((await read()).filesystems.map(fs => fs.labels)).toEqual([['good']]);
});
it('caches sampling for thirty seconds and coalesces simultaneous polling requests', async () => {
  let now = 0, finish!: (value: DiskProbe) => void;
  const probe = vi.fn(() => new Promise<DiskProbe>(resolve => { finish = resolve; }));
  const read = createDiskStatsReader(() => [{ label: 'Data', path: '/data' }], { probe, now: () => now });
  const first = read(), second = read(); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1), { interval: 1 });
  finish(capacity()); expect(await first).toEqual(await second); await read(); expect(probe).toHaveBeenCalledTimes(1);
  now = 30_001; const next = read(); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2), { interval: 1 }); finish(capacity('one', 10));
  expect((await next).filesystems[0].percentUsed).toBe(90); expect(probe).toHaveBeenCalledTimes(2);
});
it('bounds slow probes and never accumulates new operations on a stuck filesystem', async () => {
  const targets = Array.from({ length: 12 }, (_, index) => ({ label: `Location ${index}`, path: `path-${index}` }));
  const probe = vi.fn(() => new Promise<DiskProbe>(() => {}));
  const read = createDiskStatsReader(() => targets, { probe, cacheMs: 0, timeoutMs: 5 });
  expect(await read()).toEqual({ available: false, filesystems: [] }); expect(probe).toHaveBeenCalledTimes(8);
  expect(await read()).toEqual({ available: false, filesystems: [] }); expect(probe).toHaveBeenCalledTimes(8);
});
it('includes bounded extra scratch mounts without discovering unrelated private paths or using missing-parent fallback', async () => {
  const mounts = parseScratchMounts([
    '1 0 8:1 / /scratch3 rw - ext4 /dev/a rw', '2 0 8:2 / /scratch2 rw - ext4 /dev/b rw',
    '3 0 8:3 / /private/secret rw - ext4 /dev/c rw', '4 0 8:4 / /scratch20 rw - ext4 /dev/d rw',
  ].join('\n'), 2);
  expect(mounts).toEqual([{ label: 'Scratch 2', path: '/scratch2', requireExisting: true }, { label: 'Scratch 3', path: '/scratch3', requireExisting: true }]);
  const probe = vi.fn(async (_path: string, requireExisting?: boolean) => { expect(requireExisting).toBe(true); throw new Error('Removed mount'); });
  expect(await createDiskStatsReader(() => mounts, { probe })()).toEqual({ available: false, filesystems: [] });
});
