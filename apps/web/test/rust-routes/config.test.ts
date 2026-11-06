/** The moved-route list is read once at startup and refuses anything it cannot serve exactly. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROUTE_MEDIA, ROUTE_STATUSES, rustRoutes } from '../../src/rust-routes/config.js';
import { MEDIA } from '../../src/rust-routes/frames.js';

const copied = resolve(import.meta.dirname, '../fixtures/route-frames-v1');
const source = resolve(import.meta.dirname, '../../../../crates/reverie-contracts/tests/fixtures/route-frames-v1');
const fixtures = existsSync(join(copied, 'cases.json')) ? copied : source;
const KEY = 'GET /api/subscription-profiles';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function handler(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rust-routes-config-'));
  dirs.push(dir);
  const path = join(dir, 'reverie-route-handler');
  writeFileSync(path, '');
  return path;
}

describe('rust route configuration', () => {
  it('is empty by default and moves exactly the named routes', () => {
    expect(rustRoutes({})).toBeUndefined();
    const path = handler();
    const config = rustRoutes({ REVERIE_RUST_ROUTES: KEY, REVERIE_RUST_ROUTE_HANDLER: path });
    expect([...(config?.moved ?? [])]).toEqual([KEY]);
    expect(config?.handlerPath).toBe(path);
  });

  it('refuses an unknown key or a handler that is not an absolute file', () => {
    const path = handler();
    for (const list of ['GET /api/elsewhere', `${KEY},`, ` ${KEY}`])
      expect(() => rustRoutes({ REVERIE_RUST_ROUTES: list, REVERIE_RUST_ROUTE_HANDLER: path }), list).toThrow(
        /unknown route/
      );
    for (const handlerPath of [undefined, 'relative/handler', join(path, '..'), `${path}.missing`])
      expect(() => rustRoutes({ REVERIE_RUST_ROUTES: KEY, REVERIE_RUST_ROUTE_HANDLER: handlerPath })).toThrow(
        /absolute path/
      );
  });

  it('serves the statuses and media of the shared route table', () => {
    const { routes } = JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as {
      routes: { key: string; statuses: number[]; media?: string[] }[];
    };
    expect(ROUTE_STATUSES).toEqual(Object.fromEntries(routes.map((route) => [route.key, route.statuses])));
    expect(
      Object.fromEntries(Object.entries(ROUTE_MEDIA).map(([key, media]) => [key, media.map((byte) => MEDIA[byte])]))
    ).toEqual(Object.fromEntries(routes.filter((route) => route.media).map((route) => [route.key, route.media])));
  });
});
