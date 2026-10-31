/**
 * The session-start memory brief (GET /api/agent/memory-brief) is an agent route like the journal routes beside it: the
 * handler answers the calling agent's own brief only, so the owner-auth policy must let agent callers reach it. It was
 * missing from the agent list, so an agent calling it fell to the owner-only default.
 */
import { expect, it } from 'vitest';
import { allowed, classify } from '../src/owner-auth/policy.js';

it('lets agents read their own memory brief, as they read their journal', () => {
  for (const route of ['/api/agent/memory-brief', '/api/agent/journal/map', '/api/agent/journal/recall']) {
    expect(classify('GET', route, route), route).toBe('agent');
    expect(allowed(classify('GET', route, route), 'agent'), route).toBe(true);
  }
  expect(allowed(classify('GET', '/api/agent/memory-brief', '/api/agent/memory-brief'), 'anonymous')).toBe(false);
});
