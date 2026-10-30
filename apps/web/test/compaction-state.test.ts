/** Compacting is shown only on the harness's own report and can never stick (Session + the tab dot). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { attachSessionListeners, createSessionListeners, detachSessionListeners } from '../src/web/session-listener-wiring.js';

afterEach(() => vi.useRealTimers());

it('records a compaction start and end, reports a change only once, and expires a lost end', () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const session = new Session({ workingDir: '/tmp', mode: 'claude', name: 'compact-fixture' });
  expect(session.compactingSince).toBeNull();
  expect(session.toState()).not.toHaveProperty('compactingSince');
  expect(session.noteCompaction(true)).toBe(true);
  expect(session.noteCompaction(true)).toBe(false); // a repeated start keeps its first time
  expect(session.toState().compactingSince).toBe(1_000_000);
  expect(session.noteCompaction(false)).toBe(true);
  expect(session.noteCompaction(false)).toBe(false);
  const changed = vi.fn();
  session.on('compactingChanged', changed);
  session.noteCompaction(true);
  vi.advanceTimersByTime(Session.COMPACTING_MAX_MS - 1);
  expect(session.compactingSince).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2); // the end hook was lost: cleared AND pushed, not only on the next read
  expect(session.compactingSince).toBeNull();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(session.toState()).not.toHaveProperty('compactingSince');
  session.noteCompaction(true);
  session.noteCompaction(false); // an end report cancels the expiry: nothing fires later
  vi.advanceTimersByTime(Session.COMPACTING_MAX_MS * 2);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('pushes the expiry through the real session listener wiring (broadcast + persist), and detaches it', () => {
  vi.useFakeTimers({ now: 2_000_000 });
  const session = new Session({ workingDir: '/tmp', mode: 'claude', name: 'compact-wiring-fixture' });
  const deps = { broadcastSessionStateDebounced: vi.fn(), persistSessionState: vi.fn() };
  const refs = createSessionListeners(session, deps as unknown as Parameters<typeof createSessionListeners>[1]);
  attachSessionListeners(session, refs);
  session.noteCompaction(true);
  vi.advanceTimersByTime(Session.COMPACTING_MAX_MS + 1);
  expect(deps.broadcastSessionStateDebounced).toHaveBeenCalledWith(session.id);
  expect(deps.persistSessionState).toHaveBeenCalledWith(session);
  detachSessionListeners(session, refs);
  expect(session.listenerCount('compactingChanged')).toBe(0);
});

it('draws the yellow compacting dot only while compacting and never for a stopped session', () => {
  const appJs = readFileSync(resolve(__dirname, '../src/web/public/app.js'), 'utf-8');
  const body = appJs.match(/\n  tabDotStatus\(session\) \{([\s\S]*?)\n  \}/)?.[1];
  expect(body).toBeTruthy();
  const tabDotStatus = new Function('session', body!) as (s: unknown) => string;
  expect(tabDotStatus({ status: 'busy', compactingSince: 5 })).toBe('compacting');
  expect(tabDotStatus({ status: 'idle', compactingSince: 5 })).toBe('compacting');
  expect(tabDotStatus({ status: 'stopped', compactingSince: 5 })).toBe('stopped');
  expect(tabDotStatus({ status: 'busy' })).toBe('busy');
  expect(tabDotStatus(undefined)).toBe('idle');
  const css = readFileSync(resolve(__dirname, '../src/web/public/styles.css'), 'utf-8');
  expect(css).toMatch(/\.session-tab \.tab-status\.compacting \{ background: var\(--yellow\); \}/);
});
