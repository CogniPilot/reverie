/**
 * @fileoverview `DELETE /api/cases/:name` on a real cases directory: an employee's case and a
 * case with a live session are refused with 409 and left in place, and a removed case is moved
 * to the trash and audited.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';

// The cases and data directories are read when the route module loads, so they are set before
// any import runs.
const dirs = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/case-delete-guard-${process.pid}-${Date.now()}`;
  const saved = { cases: process.env.REVERIE_CASES_PATH, data: process.env.REVERIE_DATA_DIR };
  process.env.REVERIE_CASES_PATH = `${base}/cases`;
  process.env.REVERIE_DATA_DIR = `${base}/data`;
  return { base, cases: `${base}/cases`, data: `${base}/data`, saved };
});

afterAll(async () => {
  for (const [key, value] of [
    ['REVERIE_CASES_PATH', dirs.saved.cases],
    ['REVERIE_DATA_DIR', dirs.saved.data],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dirs.base, { recursive: true, force: true });
});

let app: FastifyInstance;
let ctx: MockRouteContext;
const employees = [{ name: 'Robin' }];

beforeEach(async () => {
  await fs.rm(dirs.base, { recursive: true, force: true });
  await fs.mkdir(dirs.cases, { recursive: true });
  await fs.mkdir(dirs.data, { recursive: true });
  app = Fastify({ logger: false });
  ctx = createMockRouteContext();
  ctx.sessions.clear();
  registerCaseRoutes(app, ctx as never, { employees: () => employees });
  await app.ready();
});

async function makeCase(name: string): Promise<string> {
  const dir = path.join(dirs.cases, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'work.md'), 'unique work');
  return dir;
}

const remove = (name: string) => app.inject({ method: 'DELETE', url: `/api/cases/${name}` });

describe('DELETE /api/cases/:name guard', () => {
  it('refuses an employee case with no session open and keeps it', async () => {
    const dir = await makeCase('expert-robin');
    const res = await remove('expert-robin');
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ success: false });
    await expect(fs.readFile(path.join(dir, 'work.md'), 'utf8')).resolves.toBe('unique work');
  });

  it('refuses an encoded nested name inside an employee case and keeps it', async () => {
    const dir = await makeCase('expert-robin/work');
    await fs.mkdir(path.join(dirs.data, 'case-trash', 'expert-robin'), { recursive: true });
    const res = await remove('expert-robin%2Fwork');
    expect(res.statusCode).toBe(400);
    await expect(fs.readFile(path.join(dir, 'work.md'), 'utf8')).resolves.toBe('unique work');
  });

  it('refuses a case with a live session and keeps it', async () => {
    const dir = await makeCase('busy');
    const session = createMockRouteContext({ sessionId: 'live' }).sessions.get('live')!;
    session.workingDir = dir;
    ctx.sessions.set('live', session);
    const res = await remove('busy');
    expect(res.statusCode).toBe(409);
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it('refuses a symlinked case and leaves its target', async () => {
    const outside = path.join(dirs.base, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(dirs.cases, 'link'));
    const res = await remove('link');
    expect(res.statusCode).toBe(400);
    await expect(fs.stat(outside)).resolves.toBeTruthy();
  });

  it('moves a removed case to the trash intact and audits it', async () => {
    const dir = await makeCase('proj');
    const res = await remove('proj');
    expect(res.statusCode).toBe(200);
    await expect(fs.stat(dir)).rejects.toThrow();
    const trash = path.join(dirs.data, 'case-trash');
    const [entry] = await fs.readdir(trash);
    expect(entry.startsWith('proj-')).toBe(true);
    await expect(fs.readFile(path.join(trash, entry, 'work.md'), 'utf8')).resolves.toBe('unique work');
    const audit = () => fs.readFile(path.join(dirs.data, 'admin-audit.jsonl'), 'utf8').catch(() => '');
    await expect.poll(audit).toContain('"case.delete"');
  });

  it('404s a missing case', async () => {
    const res = await remove('ghost');
    expect(res.statusCode).toBe(404);
  });
});
