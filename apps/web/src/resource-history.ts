/** Owner-only, path-free observation reads; no collector/service/effect control. */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type HistorySelection = { cli: string; config: string };

export function historyArguments(query: unknown): string[] {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('query');
  const q = query as Record<string, unknown>;
  if (Object.keys(q).some(key => !['start', 'end', 'resolution', 'gpu'].includes(key))) throw new Error('query');
  const integer = (value: unknown): number => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,11})$/.test(value)) throw new Error('query');
    return Number(value);
  };
  const start = integer(q.start), end = integer(q.end);
  if (start >= end || end - start > 400 * 86400 || end > Math.floor(Date.now() / 1000) + 5) throw new Error('range');
  const args = ['--start', String(start), '--end', String(end)];
  if (q.resolution !== undefined) {
    if (typeof q.resolution !== 'string' || !['auto', 'minute', 'five-minute', 'hour', 'day'].includes(q.resolution)) throw new Error('query');
    args.push('--resolution', q.resolution);
  }
  if (q.gpu !== undefined) {
    if (typeof q.gpu !== 'string' || !/^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(q.gpu)) throw new Error('query');
    args.push('--gpu', q.gpu);
  }
  return args;
}

export async function readResourceHistory(selection: HistorySelection, args: string[]): Promise<unknown> {
  if (!isAbsolute(selection.config) || basename(selection.cli) !== 'reverie-resource-history' ||
      !selection.cli.startsWith('/nix/store/') || await realpath(selection.cli) !== selection.cli)
    throw new Error('selection');
  const s = await lstat(selection.cli);
  if (!s.isFile() || s.uid !== 0 || (s.mode & 0o222) || !(s.mode & 0o111)) throw new Error('selection');
  const output = await new Promise<string>((resolve, reject) => {
    execFile(selection.cli, ['--config', selection.config, ...args], {
      timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 2 << 20, encoding: 'utf8',
      env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: '/unavailable' },
    }, (error, stdout) => error ? reject(new Error('unavailable')) : resolve(stdout));
  });
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1 ||
      (value as { scope?: unknown }).scope !== 'shared-host-unattributed-observations' ||
      (value as { effectAuthority?: unknown }).effectAuthority !== false) throw new Error('projection');
  return value;
}

export function registerResourceHistoryRoutes(
  app: FastifyInstance,
  owner: (req: FastifyRequest) => boolean,
  selection: HistorySelection | undefined = process.env.REVERIE_RESOURCE_HISTORY_CLI && process.env.REVERIE_RESOURCE_HISTORY_CONFIG
    ? { cli: process.env.REVERIE_RESOURCE_HISTORY_CLI, config: process.env.REVERIE_RESOURCE_HISTORY_CONFIG } : undefined,
  read: typeof readResourceHistory = readResourceHistory,
): void {
  let busy = false;
  app.get('/api/resource-history', async (req, reply) => {
    // Explicit check also applies when the general owner policy is configured off.
    if (!owner(req)) return reply.code(403).send({ error: 'Owner authentication required' });
    let args: string[];
    try { args = historyArguments(req.query); }
    catch { return reply.code(400).send({ error: 'Invalid bounded history query' }); }
    if (!selection) return reply.code(503).send({ error: 'Resource history is not configured' });
    if (busy) return reply.code(429).send({ error: 'Resource history read already active' });
    busy = true;
    try {
      const value = await read(selection, args);
      if (!owner(req)) return reply.code(403).send({ error: 'Owner authentication expired' });
      reply.header('Cache-Control', 'no-store');
      return value;
    } catch { return reply.code(503).send({ error: 'Resource history unavailable' }); }
    finally { busy = false; }
  });
}
