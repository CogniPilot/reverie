/**
 * The mock route context must offer everything the real one does.
 *
 * Route tests pass their context as `ctx as never`, and `tsconfig.json` includes
 * only `src/**`, so no type check ever compares the mock against the ports. A
 * port that gained a method left this mock missing it twice; both times the
 * route under test threw a TypeError inside its own catch, and the suite
 * reported a plausible-looking failure for an unrelated reason.
 *
 * So the comparison is made at runtime, against `WebServer.createRouteContext()`
 * rather than against the port types, which is what keeps it from drifting: the
 * server's own context object is the thing route modules are really given.
 */
import { describe, expect, it } from 'vitest';

import { WebServer } from '../../src/web/server.js';
import { createMockRouteContext } from './mock-route-context.js';

describe('the mock route context', () => {
  it('offers every member the real route context does', () => {
    const server = new WebServer(0, false, true);
    const real = (server as unknown as { createRouteContext(): Record<string, unknown> }).createRouteContext();
    const mock = createMockRouteContext() as unknown as Record<string, unknown>;

    const missing = Object.keys(real).filter((key) => !(key in mock));
    expect(missing, `mock-route-context.ts is missing: ${missing.join(', ')}`).toEqual([]);
  });
});
