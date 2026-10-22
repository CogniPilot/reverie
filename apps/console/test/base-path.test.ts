/**
 * @fileoverview Unit tests for the pure reverse-proxy base-path helpers
 * (src/config/base-path.ts). These back the server ingress strip (rewriteUrl),
 * the egress Location rewrite (onSend), and the frontend route builder, so their
 * correctness is what makes a sub-path mount work end to end.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeBasePath,
  isValidBasePath,
  assertValidBasePath,
  joinBasePath,
  stripBasePath,
} from '../src/config/base-path.js';

describe('normalizeBasePath', () => {
  it('treats root / and empty as no prefix', () => {
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath(null)).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
  });

  it('adds a leading slash and drops trailing slashes', () => {
    expect(normalizeBasePath('reverie')).toBe('/reverie');
    expect(normalizeBasePath('/reverie')).toBe('/reverie');
    expect(normalizeBasePath('/reverie/')).toBe('/reverie');
    expect(normalizeBasePath('reverie///')).toBe('/reverie');
  });

  it('collapses duplicate slashes and keeps nested segments', () => {
    expect(normalizeBasePath('//a//b//')).toBe('/a/b');
    expect(normalizeBasePath('/tools/reverie')).toBe('/tools/reverie');
  });
});

describe('isValidBasePath / assertValidBasePath', () => {
  it('accepts root and well-formed segments', () => {
    expect(isValidBasePath('')).toBe(true);
    expect(isValidBasePath('/reverie')).toBe(true);
    expect(isValidBasePath('/tools/reverie-2')).toBe(true);
    expect(isValidBasePath('/a_b.c~d')).toBe(true);
  });

  it('rejects segments with unsafe characters', () => {
    expect(isValidBasePath('/a b')).toBe(false);
    expect(isValidBasePath('/a?b')).toBe(false);
    expect(isValidBasePath('/a#b')).toBe(false);
    expect(isValidBasePath('/a%2f')).toBe(false);
  });

  it('assertValidBasePath normalizes valid input and throws on bad', () => {
    expect(assertValidBasePath('/reverie/')).toBe('/reverie');
    expect(assertValidBasePath('/')).toBe('');
    expect(() => assertValidBasePath('/a b')).toThrow(/Invalid --base-url/);
    expect(() => assertValidBasePath('?x')).toThrow(/Invalid --base-url/);
  });
});

describe('joinBasePath (frontend/egress route builder)', () => {
  it('is a no-op at root', () => {
    expect(joinBasePath('', '/api/x')).toBe('/api/x');
    expect(joinBasePath('', '/')).toBe('/');
  });

  it('prefixes root-absolute app paths', () => {
    expect(joinBasePath('/reverie', '/api/x')).toBe('/reverie/api/x');
    expect(joinBasePath('/reverie', '/')).toBe('/reverie/');
    expect(joinBasePath('/reverie', '/ws/sessions/1/terminal')).toBe('/reverie/ws/sessions/1/terminal');
  });

  it('leaves absolute, protocol-relative, and relative URLs alone', () => {
    expect(joinBasePath('/reverie', 'https://x/y')).toBe('https://x/y');
    expect(joinBasePath('/reverie', 'ws://x/y')).toBe('ws://x/y');
    expect(joinBasePath('/reverie', '//host/y')).toBe('//host/y');
    expect(joinBasePath('/reverie', 'app.js')).toBe('app.js');
    expect(joinBasePath('/reverie', '#frag')).toBe('#frag');
    expect(joinBasePath('/reverie', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('is idempotent — never double-prefixes', () => {
    expect(joinBasePath('/reverie', '/reverie/api/x')).toBe('/reverie/api/x');
    expect(joinBasePath('/reverie', '/reverie')).toBe('/reverie');
    expect(joinBasePath('/reverie', '/reverie?y=1')).toBe('/reverie?y=1');
  });

  it('does not treat a same-named sibling path as already-prefixed', () => {
    // /reverie-docs must NOT be mistaken for the /reverie mount.
    expect(joinBasePath('/reverie', '/reverie-docs/x')).toBe('/reverie/reverie-docs/x');
  });
});

describe('stripBasePath (server ingress)', () => {
  it('is a no-op at root', () => {
    expect(stripBasePath('', '/api/x')).toBe('/api/x');
  });

  it('strips the prefix from proxied requests', () => {
    expect(stripBasePath('/reverie', '/reverie/api/x')).toBe('/api/x');
    expect(stripBasePath('/reverie', '/reverie')).toBe('/');
    expect(stripBasePath('/reverie', '/reverie/')).toBe('/');
    expect(stripBasePath('/reverie', '/reverie?y=1')).toBe('/?y=1');
  });

  it('leaves un-prefixed requests unchanged (direct-to-port: hooks, health, docker bridge)', () => {
    expect(stripBasePath('/reverie', '/api/x')).toBe('/api/x');
    expect(stripBasePath('/reverie', '/api/hook-event')).toBe('/api/hook-event');
    // A same-named sibling is not the mount.
    expect(stripBasePath('/reverie', '/reverie-docs/x')).toBe('/reverie-docs/x');
  });

  it('round-trips with joinBasePath', () => {
    const base = '/tools/reverie';
    for (const p of ['/', '/api/x', '/ws/y', '/session/abc']) {
      expect(stripBasePath(base, joinBasePath(base, p))).toBe(p);
    }
  });
});
