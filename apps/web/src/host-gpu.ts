/**
 * @fileoverview GPU load published by the host.
 *
 * The console runs where it cannot see the GPU, so a host-side publisher writes a small read-only JSON file and the console only
 * reads it: `{ "updatedAt": <epoch ms>, "gpus": [ { "name": "...", "utilization": 0-100, "memoryUsedMb": n, "memoryTotalMb": n } ] }`
 * (a single GPU may also be given as those fields at the top level). A file older than GPU_STALE_MS, from the future, missing or
 * malformed means "no GPU reading": the page hides the readout rather than show a number nobody is updating. The file is opened without
 * following links and without blocking, and read through the open handle, so nothing placed at that path can stall the console.
 */
import { constants, promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { getDataDir } from './config/instance.js';

/** A reading older than this is not shown (the host publishes about every 30 s). */
export const GPU_STALE_MS = 60_000;
/** A timestamp this far ahead of the clock cannot be trusted. */
const FUTURE_SLACK_MS = 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_GPUS = 64;

/** What the route answers: numbers only. The publisher's GPU name and timestamp are used here but never passed on. */
export interface HostGpu {
  available: boolean;
  utilization: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  count: number;
}

const NONE: HostGpu = { available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null, count: 0 };

/** The directory the host mounts read-only into the container, and the file in it. */
export const HOST_PUBLISHED_GPU_FILE = '/host-published/gpu.json';

/**
 * Where to look, in order: REVERIE_GPU_STATUS_FILE alone when set; otherwise the read-only host mount, then `host/gpu.json` next to
 * the console's data directory (the location used until the mount exists).
 */
export function gpuStatusFiles(env: Record<string, string | undefined> = process.env): string[] {
  const chosen = env.REVERIE_GPU_STATUS_FILE?.trim();
  return chosen ? [chosen] : [HOST_PUBLISHED_GPU_FILE, resolve(getDataDir(), '..', 'host', 'gpu.json')];
}

/** The first place that has a fresh reading wins; none means no reading. */
export async function readHostGpuFrom(files: string[], now = Date.now()): Promise<HostGpu> {
  for (const file of files) {
    const reading = await readHostGpu(file, now);
    if (reading.available) return reading;
  }
  return NONE;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function readHostGpu(file: string, now = Date.now()): Promise<HostGpu> {
  let raw: string;
  let mtime: number;
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    // O_NOFOLLOW: a link at that path is ignored. O_NONBLOCK: a FIFO or device put there cannot hang the open. The type is checked
    // on the open file, not on the path, so it cannot be swapped between the check and the read.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return NONE;
    // Read at most one byte more than the limit, so a file that grows after the check is still bounded.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) return NONE;
    raw = buffer.subarray(0, bytesRead).toString('utf-8');
    mtime = stat.mtimeMs;
  } catch {
    return NONE;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NONE;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NONE;
  const doc = parsed as Record<string, unknown>;
  // The publisher's own time wins (seconds are accepted too); the file's modification time is the fallback.
  let at = finite(doc.updatedAt);
  if (at !== null && at < 1e11) at *= 1000;
  const updatedAt = at ?? mtime;
  if (now - updatedAt > GPU_STALE_MS || updatedAt - now > FUTURE_SLACK_MS) return NONE;
  const list = Array.isArray(doc.gpus) ? doc.gpus.slice(0, MAX_GPUS) : [doc];
  const gpus = list.filter((g): g is Record<string, unknown> => !!g && typeof g === 'object' && finite((g as Record<string, unknown>).utilization) !== null);
  if (gpus.length === 0) return NONE;
  const sum = (key: string): number | null => {
    const values = gpus.map((g) => finite(g[key]));
    return values.every((v) => v !== null && v >= 0) ? (values as number[]).reduce((a, b) => a + b, 0) : null;
  };
  return {
    available: true,
    // The busiest GPU is the one that limits you.
    utilization: Math.max(0, Math.min(100, Math.max(...gpus.map((g) => finite(g.utilization) as number)))),
    memoryUsedMb: sum('memoryUsedMb'),
    memoryTotalMb: sum('memoryTotalMb'),
    count: gpus.length,
  };
}
