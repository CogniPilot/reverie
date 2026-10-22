/** Filesystem capacity for Reverie's configured storage locations; no directory scan or host paths in the DTO. */
import { open, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { getCasesDir } from './config/cases-dir.js';
import { getDataDir } from './config/instance.js';

export interface DiskTarget { label: string; path: string; requireExisting?: boolean }
export interface DiskProbe { device: string; blocks: number; availableBlocks: number; blockSize: number }
export interface DiskFilesystem {
  labels: string[];
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  percentUsed: number;
}
export interface DiskStats { available: boolean; filesystems: DiskFilesystem[] }
const MAX_TARGETS = 8;
const NONE: DiskStats = { available: false, filesystems: [] };

export function diskTargets(): DiskTarget[] {
  const home = homedir();
  const root = process.env.REVERIE_ROOT || join(home, 'reverie');
  return [
    { label: 'Company data', path: getDataDir() },
    { label: 'Workspace', path: process.env.REVERIE_WORKSPACE || getCasesDir() },
    { label: 'Scratch', path: process.env.REVERIE_SCRATCH || (process.env.REVERIE_CONTAINER === '1' ? '/scratch' : join(root, 'scratch')) },
    ...(process.env.TMPDIR ? [{ label: 'Temporary files', path: process.env.TMPDIR }] : []),
    { label: 'Home', path: home },
    { label: 'System', path: parse(home).root },
  ];
}

/** Only additional scratch mount destinations are discovered; arbitrary host mounts stay private. */
export function parseScratchMounts(mountinfo: string, limit: number): DiskTarget[] {
  const paths = new Set(mountinfo.split('\n').map(line => line.split(' ')[4]).filter(path => /^\/scratch(?:[2-9]|[1-9]\d+)$/.test(path || '')));
  return [...paths].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))).slice(0, Math.max(0, limit)).map(path => ({ label: `Scratch ${path.slice(8)}`, path, requireExisting: true }));
}

async function mountedScratchTargets(limit: number): Promise<DiskTarget[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open('/proc/self/mountinfo', 'r');
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseScratchMounts(buffer.subarray(0, bytesRead).toString('utf8'), limit);
  } catch { return []; }
  finally { await handle?.close().catch(() => undefined); }
}

async function probeFilesystem(path: string, requireExisting = false): Promise<DiskProbe> {
  // A not-yet-created configured folder uses its nearest existing parent filesystem.
  for (let depth = 0; depth < 32; depth++) {
    try {
      const info = await stat(path);
      const capacity = await statfs(path);
      return { device: String(info.dev), blocks: capacity.blocks, availableBlocks: capacity.bavail, blockSize: capacity.bsize };
    } catch (error) {
      if (requireExisting || (error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
  throw new Error('Storage location has too many missing ancestors');
}

/** At most eight probes remain outstanding, even if a configured network filesystem stops answering. */
export function createDiskStatsReader(targets: () => DiskTarget[] | Promise<DiskTarget[]>, {
  probe = probeFilesystem, now = Date.now, cacheMs = 30_000, timeoutMs = 1_000,
}: { probe?: (path: string, requireExisting?: boolean) => Promise<DiskProbe>; now?: () => number; cacheMs?: number; timeoutMs?: number } = {}): () => Promise<DiskStats> {
  let cached = NONE, at = -Infinity;
  let refresh: Promise<DiskStats> | undefined;
  const pending = new Map<string, Promise<DiskProbe | null>>();
  return async () => {
    if (now() - at < cacheMs) return cached;
    if (refresh) return refresh;
    refresh = (async () => {
      const readings = await Promise.all((await targets()).slice(0, MAX_TARGETS).map(async target => {
        let reading = pending.get(target.path);
        if (!reading) {
          if (pending.size >= MAX_TARGETS) return null;
          reading = Promise.resolve().then(() => probe(target.path, target.requireExisting)).catch(() => null).finally(() => pending.delete(target.path));
          pending.set(target.path, reading);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([reading, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
          return result ? { target, result } : null;
        } finally { clearTimeout(timer); }
      }));
      const devices = new Map<string, DiskFilesystem>();
      for (const reading of readings) {
        if (!reading) continue;
        const { target, result } = reading;
        const { blocks, availableBlocks, blockSize } = result;
        if (![blocks, availableBlocks, blockSize].every(Number.isFinite) || blocks <= 0 || blockSize <= 0 || availableBlocks < 0 || availableBlocks > blocks) continue;
        const totalBytes = blocks * blockSize, availableBytes = availableBlocks * blockSize;
        if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) continue;
        const existing = devices.get(result.device);
        if (existing) { if (!existing.labels.includes(target.label)) existing.labels.push(target.label); continue; }
        // Reserved blocks are unavailable to the application, so they count as used here.
        const usedBytes = totalBytes - availableBytes;
        devices.set(result.device, { labels: [target.label], totalBytes, usedBytes, availableBytes, percentUsed: Math.round(100 * usedBytes / totalBytes) });
      }
      cached = { available: devices.size > 0, filesystems: [...devices.values()] };
      at = now();
      return cached;
    })().finally(() => { refresh = undefined; });
    return refresh;
  };
}

export const getDiskStats = createDiskStatsReader(async () => {
  const core = diskTargets();
  return [...core, ...await mountedScratchTargets(MAX_TARGETS - core.length)];
});
