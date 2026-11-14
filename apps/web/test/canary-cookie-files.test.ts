/** Closed fixture-cookie selectors only; no credential/API/provider effects. */
import { describe, expect, it } from 'vitest';
import { validCanaryCookieName } from './helpers/docker-continuation-auth-canary.js';
import { validCanaryCookieName as browserName } from './fixtures/boxed-canary-browser-proof.mjs';
describe('immutable canary cookie filenames', () => {
  it.each([
    'owner-session.json',
    'owner-session-after-control1.json',
    'owner-session-control-' + 'a'.repeat(64) + '.json',
  ])('accepts the explicitly issued closed basename %s', (name) => {
    expect(validCanaryCookieName(name)).toBe(true);
    expect(browserName(name)).toBe(true);
  });
  it.each([
    '../owner-session.json',
    '/tmp/owner-session.json',
    'owner-session-control-' + 'a'.repeat(63) + '.json',
    'owner-session-control-' + 'A'.repeat(64) + '.json',
    'owner-session-control-' + 'a'.repeat(64) + '.json/extra',
    'owner-session-control-' + 'a'.repeat(64) + '.json\0',
    'other.json',
    'owner-session-after-control2.json',
  ])('refuses unrestricted or malformed selector %s', (name) => {
    expect(validCanaryCookieName(name)).toBe(false);
    expect(browserName(name)).toBe(false);
  });
});
