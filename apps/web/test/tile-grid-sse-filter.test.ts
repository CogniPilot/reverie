/**
 * @fileoverview While the tile grid owns the terminal, the page's SSE filter
 * names TILE_GRID_SSE_FILTER (constants.js), which no session matches.
 *
 * The SSE filter gates only session:terminal batches (server side, pinned by
 * test/sse-tile-grid-filter.test.ts). With the grid open those frames were for
 * the focused tile alone and were only parsed to be dropped: the main terminal
 * is parked and the tiles carry their own output over their own sockets. Both
 * places that set the filter ask `_sseFilterSessionId()`: the live re-subscribe
 * (`_updateSseSubscription`, run by every tile focus) and the connect URL
 * (`connectSSE`, rebuilt by every SSE reconnect with the grid still open).
 * Leaving the grid gives the filter back to the session shown.
 *
 * Real code: the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectGridStream,
  fetchSpy,
  makeGridApp,
  resetGridHarness,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];
const FILTER = (windowStub.ReverieTileGrid as { TILE_GRID_SSE_FILTER: string }).TILE_GRID_SSE_FILTER;

/** The app with the REAL _updateSseSubscription, and the filters it posted, in order. */
function makeApp(active: string | null = IDS[0]): GridApp {
  const app = makeGridApp(IDS);
  delete app._updateSseSubscription;
  app._clientId = 'client-1';
  app.activeSessionId = active;
  connectGridStream(app);
  return app;
}
const posted = () =>
  fetchSpy.mock.calls
    .filter(([url]) => url === '/api/events/subscribe')
    .map(([, init]) => JSON.parse((init as { body: string }).body).sessions);

beforeEach(() => {
  resetGridHarness();
  fetchSpy.mockClear();
});

describe('the SSE filter while tiles own the terminal', () => {
  it('is a fixed id no session can take', () => {
    expect(FILTER).toBe('tile-grid');
    // Session ids are UUIDs.
    expect(FILTER).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('opening the grid subscribes with its fixed filter and repeated tile focus keeps it without redundant writes', async () => {
    const app = makeApp();
    app.openTileGrid(IDS);
    delete app.selectSession;
    await app.selectSession('s-b');
    await app.selectSession('s-c');
    await app._updateSseSubscription(app.activeSessionId);
    expect(posted()).toEqual([[FILTER]]);
    const subscription = fetchSpy.mock.calls.find(([url]) => url === '/api/events/subscribe');
    expect(subscription).toBeDefined();
    expect(JSON.parse((subscription![1] as { body: string }).body)).toEqual({
      clientId: 'grid-page-key',
      streamNonce: new URL(app.eventSource.url, 'http://reverie.test').searchParams.get('streamNonce'),
      sessions: [FILTER],
    });
  });

  it('leaving the grid gives the filter back to the session shown', async () => {
    const app = makeApp();
    app.openTileGrid(IDS);
    expect(app._sseFilterSessionId('s-a')).toBe(FILTER);
    app.closeTileGrid({ keepStored: true, reselect: false });
    // What the single view's selectSession (app.js) then posts.
    await app._updateSseSubscription('s-a');
    expect(posted().at(-1)).toEqual(['s-a']);
    expect(app._sseFilterSessionId('s-b')).toBe('s-b');
  });

  it('a page with no grid open filters on the session as before', async () => {
    const app = makeApp(null);
    expect(app._sseFilterSessionId('s-a')).toBe('s-a');
    expect(app._sseFilterSessionId(null)).toBe(null);
    await app._updateSseSubscription('s-a');
    expect(posted()).toEqual([['s-a']]);
  });

  it('the connect URL asks the same question, so an SSE reconnect with the grid open keeps the filter', () => {
    const app = makeApp(),
      original = app.eventSource;
    const before = new URL(original.url, 'http://reverie.test');
    expect(before.searchParams.get('sessions')).toBe('s-a');
    app.openTileGrid(IDS);
    const successor = connectGridStream(app),
      after = new URL(successor.url, 'http://reverie.test');
    expect(original.readyState).toBe(2);
    expect(after.searchParams.get('sessions')).toBe(FILTER);
    expect(after.searchParams.get('clientId')).toBe(before.searchParams.get('clientId'));
    expect(after.searchParams.get('streamNonce')).not.toBe(before.searchParams.get('streamNonce'));
  });
});
