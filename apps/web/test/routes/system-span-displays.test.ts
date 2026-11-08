import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * POST /api/system/span-displays (multi-monitor launcher) + resolveSpanUrl.
 *
 * The route calls src/span-displays.ts, mocked here so no browser opens; the
 * module itself is covered in test/span-displays.test.ts. process.platform is
 * overridden per-case so the macOS-only guard is tested deterministically
 * regardless of where the suite runs.
 *
 * Port: N/A (app.inject).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const span = vi.hoisted(() => ({
  spanDisplays: vi.fn(async (url: string) => ({
    url,
    union: { x: 0, y: 0, width: 10, height: 10 },
    bin: '/b',
    pid: 1,
  })),
  systemSpanHost: vi.fn(() => ({ marker: 'system host' })),
}));
vi.mock('../../src/span-displays.js', () => span);

import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes, resolveSpanUrl } from '../../src/web/routes/system-routes.js';

const REAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  setPlatform(REAL_PLATFORM);
  span.spanDisplays.mockClear();
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
    const { app } = await createRouteTestHarness((app, ctx) => registerSystemRoutes(app, ctx, trustedFixtureOwner));
    const res = await app.inject({ method: 'POST', url: '/api/system/span-displays' });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/macOS/i);
    expect(span.spanDisplays).not.toHaveBeenCalled();
    await app.close();
  });

  it('launches the spanning window at the sanitized localhost URL on darwin', async () => {
    setPlatform('darwin');
    const { app } = await createRouteTestHarness((app, ctx) => registerSystemRoutes(app, ctx, trustedFixtureOwner));
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
    expect(span.spanDisplays).toHaveBeenCalledTimes(1);
    expect(span.spanDisplays.mock.calls[0]).toEqual(['http://localhost:5000', { marker: 'system host' }]);
    await app.close();
  });

  it('reports a failed launch instead of claiming the window opened', async () => {
    setPlatform('darwin');
    span.spanDisplays.mockRejectedValueOnce(new Error("No Chrome-family browser found (BROWSER='')"));
    const { app } = await createRouteTestHarness((app, ctx) => registerSystemRoutes(app, ctx, trustedFixtureOwner));
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/span-displays',
      headers: { host: 'localhost:5000' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('No Chrome-family browser found');
    await app.close();
  });
});
