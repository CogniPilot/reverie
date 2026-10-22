#!/usr/bin/env -S node --experimental-strip-types
/** Host display telemetry only. No device access or driver files enter the image. */
import { constants } from 'node:fs';
import { access, mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Gpu = { name: string; utilization: number; memoryUsedMb: number; memoryTotalMb: number };
export function parseReading(csv: string): Gpu[] | null {
  const lines = csv.trim().split(/\r?\n/);
  if (!csv.trim() || lines.length > 64) return null;
  const gpus: Gpu[] = [];
  for (const line of lines) {
    // Device names can contain commas: the final three fields are the numeric contract.
    const fields = line.split(',').map(field => field.trim());
    if (fields.length < 4) return null;
    const numeric = fields.splice(-3);
    if (numeric.some(value => !/^\d+(?:\.\d+)?$/.test(value))) return null;
    const [utilization, memoryUsedMb, memoryTotalMb] = numeric.map(Number);
    const name = fields.join(', ');
    if (!name || name.length > 256 || /[\u0000-\u001f]/.test(name) ||
        ![utilization, memoryUsedMb, memoryTotalMb].every(Number.isFinite) ||
        utilization < 0 || utilization > 100 || memoryUsedMb < 0 ||
        memoryTotalMb <= 0 || memoryTotalMb > 1_000_000_000 || memoryUsedMb > memoryTotalMb) return null;
    gpus.push({ name, utilization, memoryUsedMb, memoryTotalMb });
  }
  return gpus;
}
async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink(); }
  catch { return false; }
}
export async function findProvider(): Promise<string | null> {
  const selected = process.env.NVIDIA_SMI;
  if (selected) return await executable(selected) ? resolve(selected) : null;
  for (const directory of (process.env.PATH || '').split(':').filter(Boolean)) {
    const candidate = resolve(directory, 'nvidia-smi');
    if (await executable(candidate)) return candidate;
  }
  const nixosDriver = '/run/opengl-driver/bin/nvidia-smi';
  return await executable(nixosDriver) ? nixosDriver : null;
}
async function clearReading(output: string) {
  try { await unlink(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function publish(output: string): Promise<boolean> {
  const provider = await findProvider();
  let gpus: Gpu[] | null = null;
  if (provider) {
    const query = spawnSync(provider, ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
    if (!query.error && query.status === 0) gpus = parseReading(query.stdout);
  }
  if (!gpus) { await clearReading(output); return false; }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = output + '.' + randomBytes(12).toString('hex') + '.tmp';
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try { await handle.writeFile(JSON.stringify({ updatedAt: Date.now(), gpus }) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, output);
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return true;
}
async function main() {
  let output = join(process.env.REVERIE_ROOT || join(homedir(), 'reverie'), 'runtime', 'telemetry', 'gpu.json'), once = false;
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === '--once') { once = true; continue; }
    if (flag === '--output' && args.length) { output = resolve(args.shift()!); continue; }
    if (flag === '--help') { console.log('gpu-publisher [--output PATH] [--once]'); return; }
    throw new Error('Unknown or incomplete option: ' + flag);
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); wake?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  do {
    try { await publish(output); }
    catch (error) { console.error('gpu-publisher: ' + (error as Error).message); if (once) process.exitCode = 1; }
    if (once || stopped) break;
    await new Promise<void>(done => { wake = done; timer = setTimeout(done, 15_000); });
  } while (!stopped);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('gpu-publisher: ' + error.message); process.exitCode = 1; });
}
