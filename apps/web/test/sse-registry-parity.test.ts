/**
 * SSE event registry parity — backend ⇄ frontend.
 *
 * CLAUDE.md mandates that the backend SSE registry (src/web/sse-events.ts) and the
 * frontend SSE_EVENTS object (src/web/public/constants.js) stay in sync. They are
 * hand-maintained in two files with no build-time link, so this asserts the set of
 * event-string VALUES matches exactly — a drift here means the UI silently ignores
 * (or never receives) an event.
 *
 * No port needed (pure file/module comparison).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as SseEvents from '../src/web/sse-events.js';

/** Every `export const X = '...' as const` in sse-events.ts is an event string. */
function backendEventValues(): Set<string> {
  return new Set(Object.values(SseEvents).filter((v): v is string => typeof v === 'string'));
}

/** Extract the string values from the `const SSE_EVENTS = { ... }` block in constants.js. */
function frontendEventValues(): Set<string> {
  const file = resolve(import.meta.dirname, '..', 'src', 'web', 'public', 'constants.js');
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('const SSE_EVENTS = {');
  expect(start, 'SSE_EVENTS object not found in constants.js').toBeGreaterThanOrEqual(0);
  // The object is closed by the first line that is exactly "};" after the declaration.
  const after = src.slice(start);
  const end = after.indexOf('\n};');
  expect(end, 'SSE_EVENTS closing "};" not found').toBeGreaterThan(0);
  const block = after.slice(0, end);

  const values = new Set<string>();
  // Match `KEY: 'value'` / `KEY: "value"` pairs (skip commented lines).
  for (const line of block.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    const m = code.match(/:\s*['"]([^'"]+)['"]/);
    if (m) values.add(m[1]);
  }
  return values;
}

describe('SSE event registry parity (backend ⇄ frontend)', () => {
  const backend = backendEventValues();
  const frontend = frontendEventValues();

  it('extracts a non-trivial number of events from both sources', () => {
    // Guard against a parsing regression silently making this test vacuous.
    expect(backend.size).toBeGreaterThan(100);
    expect(frontend.size).toBeGreaterThan(100);
  });

  it('has no backend events missing from the frontend SSE_EVENTS registry', () => {
    const missing = [...backend].filter((e) => !frontend.has(e)).sort();
    expect(missing, `events in sse-events.ts but not constants.js SSE_EVENTS: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no frontend events missing from the backend sse-events.ts registry', () => {
    const extra = [...frontend].filter((e) => !backend.has(e)).sort();
    expect(extra, `events in constants.js SSE_EVENTS but not sse-events.ts: ${extra.join(', ')}`).toEqual([]);
  });

  it('the two registries are exactly equal in size', () => {
    expect(frontend.size).toBe(backend.size);
  });
});
