/**
 * GPU load as the host publishes it: a small JSON file the console only reads. Anything missing, stale, from the future or
 * malformed is "no reading", so the page hides the GPU chip instead of showing a number nobody updates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GPU_STALE_MS, HOST_PUBLISHED_GPU_FILE, gpuStatusFiles, readHostGpu, readHostGpuFrom } from '../src/host-gpu.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { registerSystemRoutes } from '../src/web/routes/system-routes.js';

const NOW = 1_800_000_000_000;
const gpu = (extra: Record<string, unknown> = {}) => ({ name: 'RTX 4090', utilization: 63, memoryUsedMb: 4096, memoryTotalMb: 24576, ...extra });

describe('reading the host GPU file', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hostgpu-'));
    file = join(dir, 'gpu.json');
  });
  const write = (doc: unknown) => writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));

  it('reads one GPU, given in a list or as top-level fields, and answers numbers only (no name, no timestamp)', async () => {
    write({ updatedAt: NOW - 1000, gpus: [gpu()] });
    expect(await readHostGpu(file, NOW)).toEqual({ available: true, utilization: 63, memoryUsedMb: 4096, memoryTotalMb: 24576, count: 1 });
    write({ updatedAt: NOW - 1000, ...gpu({ name: undefined }) });
    expect(await readHostGpu(file, NOW)).toMatchObject({ available: true, utilization: 63, count: 1 });
  });

  it('with several GPUs shows the busiest and adds the memory up', async () => {
    write({ updatedAt: NOW, gpus: [gpu({ utilization: 20, memoryUsedMb: 1000, memoryTotalMb: 8000 }), gpu({ utilization: 95, memoryUsedMb: 2000, memoryTotalMb: 8000 })] });
    expect(await readHostGpu(file, NOW)).toMatchObject({ available: true, utilization: 95, memoryUsedMb: 3000, memoryTotalMb: 16000, count: 2 });
  });

  it('is hidden when the reading is older than 60 s, but still shown at exactly 60 s', async () => {
    write({ updatedAt: NOW - GPU_STALE_MS, gpus: [gpu()] });
    expect((await readHostGpu(file, NOW)).available).toBe(true);
    write({ updatedAt: NOW - GPU_STALE_MS - 1, gpus: [gpu()] });
    expect(await readHostGpu(file, NOW)).toMatchObject({ available: false, utilization: null, count: 0 });
  });

  it('does not trust a timestamp from the future, accepts seconds, and falls back to the file time', async () => {
    write({ updatedAt: NOW + 10 * 60_000, gpus: [gpu()] });
    expect((await readHostGpu(file, NOW)).available).toBe(false);
    write({ updatedAt: (NOW - 2000) / 1000, gpus: [gpu()] });
    expect((await readHostGpu(file, NOW)).available).toBe(true);
    write({ gpus: [gpu()] });
    utimesSync(file, (NOW - 5000) / 1000, (NOW - 5000) / 1000);
    expect((await readHostGpu(file, NOW)).available).toBe(true);
    utimesSync(file, (NOW - 120_000) / 1000, (NOW - 120_000) / 1000);
    expect((await readHostGpu(file, NOW)).available).toBe(false);
  });

  it('a missing, empty, malformed, oversized or wrongly shaped file is no reading', async () => {
    expect((await readHostGpu(join(dir, 'nope.json'), NOW)).available).toBe(false);
    for (const bad of ['', '{', '[]', '"x"', JSON.stringify({ updatedAt: NOW, gpus: [] }), JSON.stringify({ updatedAt: NOW, gpus: [{ utilization: 'high' }] }), JSON.stringify({ updatedAt: NOW, gpus: 'x' })]) {
      write(bad);
      expect((await readHostGpu(file, NOW)).available).toBe(false);
    }
    write(JSON.stringify({ updatedAt: NOW, gpus: [gpu()], pad: 'x'.repeat(70 * 1024) }));
    expect((await readHostGpu(file, NOW)).available).toBe(false);
  });

  it('clamps the utilization and ignores broken memory numbers', async () => {
    write({ updatedAt: NOW, gpus: [gpu({ utilization: 250, memoryUsedMb: -5 })] });
    expect(await readHostGpu(file, NOW)).toMatchObject({ utilization: 100, memoryUsedMb: null, memoryTotalMb: 24576 });
  });

  it('a FIFO, a directory or a file that grows past the limit is no reading, and a FIFO never hangs the open', async () => {
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    expect((await readHostGpu(fifo, NOW)).available).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await readHostGpu(dir, NOW)).available).toBe(false);
    // exactly the limit still reads; one byte over does not
    const pad = (n: number) => JSON.stringify({ updatedAt: NOW, gpus: [gpu()], pad: 'x'.repeat(n) });
    const base = Buffer.byteLength(pad(0));
    write(pad(64 * 1024 - base));
    expect((await readHostGpu(file, NOW)).available).toBe(true);
    write(pad(64 * 1024 - base + 1));
    expect((await readHostGpu(file, NOW)).available).toBe(false);
  });

  it('a link at that path is ignored, even to a good file', async () => {
    write({ updatedAt: NOW, gpus: [gpu()] });
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    expect((await readHostGpu(file, NOW)).available).toBe(true);
    expect((await readHostGpu(link, NOW)).available).toBe(false);
  });

  it('looks at the host mount first, then host/gpu.json beside the data directory, or only at REVERIE_GPU_STATUS_FILE when set', () => {
    expect(gpuStatusFiles({ REVERIE_GPU_STATUS_FILE: '/x/gpu.json' })).toEqual(['/x/gpu.json']);
    const files = gpuStatusFiles({});
    expect(files[0]).toBe(HOST_PUBLISHED_GPU_FILE);
    expect(HOST_PUBLISHED_GPU_FILE).toBe('/host-published/gpu.json');
    expect(files[1]).toMatch(/\/host\/gpu\.json$/);
    expect(files).toHaveLength(2);
  });

  it('the first place with a fresh reading wins: a missing or stale first file falls through to the next', async () => {
    const second = join(dir, 'second.json');
    writeFileSync(second, JSON.stringify({ updatedAt: NOW, gpus: [gpu({ utilization: 11 })] }));
    expect((await readHostGpuFrom([join(dir, 'nope.json'), second], NOW)).utilization).toBe(11);
    write({ updatedAt: NOW - GPU_STALE_MS - 1, gpus: [gpu({ utilization: 99 })] });
    expect((await readHostGpuFrom([file, second], NOW)).utilization).toBe(11);
    write({ updatedAt: NOW, gpus: [gpu({ utilization: 42 })] });
    expect((await readHostGpuFrom([file, second], NOW)).utilization).toBe(42);
    expect((await readHostGpuFrom([join(dir, 'a.json'), join(dir, 'b.json')], NOW)).available).toBe(false);
  });
});

describe('GET /api/system/gpu', () => {
  let h: RouteTestHarness;
  let file: string;
  beforeEach(async () => {
    file = join(mkdtempSync(join(tmpdir(), 'hostgpu-')), 'gpu.json');
    process.env.REVERIE_GPU_STATUS_FILE = file;
    h = await createRouteTestHarness(registerSystemRoutes);
  });
  afterEach(async () => {
    delete process.env.REVERIE_GPU_STATUS_FILE;
    await h.app.close();
  });

  it('answers with the fresh reading, and with available:false when nothing fresh is published', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/system/gpu' })).json()).toMatchObject({ available: false, utilization: null });
    writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), gpus: [gpu()] }));
    expect((await h.app.inject({ method: 'GET', url: '/api/system/gpu' })).json()).toMatchObject({ available: true, utilization: 63, memoryTotalMb: 24576 });
    writeFileSync(file, JSON.stringify({ updatedAt: Date.now() - 120_000, gpus: [gpu()] }));
    expect((await h.app.inject({ method: 'GET', url: '/api/system/gpu' })).json().available).toBe(false);
  });
});
