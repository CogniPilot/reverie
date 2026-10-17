/**
 * POST /api/system/span-displays (multi-monitor launcher) + resolveSpanUrl.
 *
 * The route shells out to scripts/span-codeman.sh, so we mock child_process.spawn
 * to avoid actually opening a browser (and to assert the sanitized URL passed to
 * it). process.platform is overridden per-case so the macOS-only guard is tested
 * deterministically regardless of where the suite runs.
 *
 * Port: N/A (app.inject).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes, resolveSpanUrl } from '../../src/web/routes/system-routes.js';

const REAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  setPlatform(REAL_PLATFORM);
  spawnMock.mockClear();
});

describe('resolveSpanUrl', () => {
  it('takes a digits-only port from the Host header, pinned to localhost', () => {
    expect(resolveSpanUrl('localhost:5000')).toBe('http://localhost:5000');
    // Hostname is discarded — always localhost (same machine).
    expect(resolveSpanUrl('attacker.example.com:3000')).toBe('http://localhost:3000');
  });

  it('falls back to the default port for missing / non-numeric ports', () => {
    expect(resolveSpanUrl(undefined)).toBe('http://localhost:3000');
    expect(resolveSpanUrl('localhost')).toBe('http://localhost:3000');
    expect(resolveSpanUrl('localhost:99;rm -rf /')).toBe('http://localhost:3000');
    expect(resolveSpanUrl('localhost:80abc')).toBe('http://localhost:3000');
    expect(resolveSpanUrl('x', '5000')).toBe('http://localhost:5000');
  });
});

describe('POST /api/system/span-displays', () => {
  it('returns 400 (macOS-only) on non-darwin and never spawns', async () => {
    setPlatform('linux');
    const { app } = await createRouteTestHarness(registerSystemRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/system/span-displays' });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/macOS/i);
    expect(spawnMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('spawns the launcher with the sanitized localhost URL on darwin', async () => {
    setPlatform('darwin');
    const { app } = await createRouteTestHarness(registerSystemRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/span-displays',
      headers: { host: 'localhost:5000' },
    });
    expect(res.statusCode).toBe(200);
    // Handler returns a bare { url } on success; the uniform envelope wraps it to
    // { success:true, data:{ url } } in production. At the route-handler layer the
    // harness sees the bare return, so we assert on body.url directly.
    expect(res.json()).toMatchObject({ url: 'http://localhost:5000' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('bash');
    expect(args[0]).toMatch(/span-codeman\.sh$/);
    expect(args[1]).toBe('http://localhost:5000');
    await app.close();
  });
});
