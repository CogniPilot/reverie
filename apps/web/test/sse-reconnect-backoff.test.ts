/**
 * @fileoverview The SSE reconnect backoff restarts only after a stream has
 * stayed open.
 *
 * `onopen` used to zero `reconnectAttempts`, so a stream that opened and was
 * cut again at once retried every 200ms for as long as that lasted. Every
 * retry re-runs handleInit (approvals, tab layout, teams, a terminal capture),
 * and one tab in that state kept an office's main thread busy for hours.
 *
 * Real code: the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectGridStream, makeGridApp, resetGridHarness, type GridApp } from './mocks/tile-grid-vm.js';

interface FakeSource {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
}

function makeApp(): GridApp {
  const app = makeGridApp(['s-a']);
  app._clientId = 'client-1';
  app.maxReconnectAttempts = 10;
  app._updateConnectionLossUi = vi.fn();
  return app;
}

/** Fail the current stream, run its retry timer, and open the replacement. Returns the delay it waited. */
function dropAndReopen(app: GridApp): number {
  const before: FakeSource = app.eventSource;
  // The page code runs in its own realm (its Date is not the faked one), so the delay is read from the timer it set.
  const timers = vi.spyOn(globalThis, 'setTimeout');
  before.onerror?.();
  const delay = timers.mock.calls.at(-1)?.[1] as number;
  timers.mockRestore();
  vi.advanceTimersByTime(delay);
  const next: FakeSource = app.eventSource;
  expect(next).not.toBe(before);
  next.readyState = 1;
  next.onopen?.();
  return delay;
}

beforeEach(() => {
  resetGridHarness();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SSE reconnect backoff', () => {
  it('keeps backing off while each new stream is cut right after it opens', () => {
    const app = makeApp();
    connectGridStream(app);
    const delays = Array.from({ length: 9 }, () => dropAndReopen(app));
    expect(delays).toEqual([200, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('starts over once a stream has stayed open', () => {
    const app = makeApp();
    connectGridStream(app);
    dropAndReopen(app);
    dropAndReopen(app);
    expect(app.reconnectAttempts).toBe(2);
    vi.advanceTimersByTime(9_999);
    expect(app.reconnectAttempts).toBe(2);
    vi.advanceTimersByTime(1);
    expect(app.reconnectAttempts).toBe(0);
    expect(dropAndReopen(app)).toBe(200);
  });

  it('does not let a replaced stream restart the backoff', () => {
    const app = makeApp();
    connectGridStream(app);
    dropAndReopen(app);
    dropAndReopen(app);
    // The stream fails again before it has stayed open: its pending "stable" timer must not fire later.
    (app.eventSource as FakeSource).onerror?.();
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(10_000);
    expect(app.reconnectAttempts).toBeGreaterThanOrEqual(3);
  });
});
