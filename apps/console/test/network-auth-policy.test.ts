import { describe, expect, it } from 'vitest';
import { isExplicitlyEnabled, isLoopbackBindHost } from '../src/web/network-auth-policy.js';

describe('network auth policy', () => {
  it.each(['localhost', '127.0.0.1', '127.42.0.9', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackBindHost(host)).toBe(true);
    }
  );

  it.each(['0.0.0.0', '192.168.1.10', '10.0.0.1', 'example.com', '::', '[::]', '::ffff:192.168.1.10'])(
    'treats %s as non-loopback',
    (host) => {
      expect(isLoopbackBindHost(host)).toBe(false);
    }
  );

  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('treats %s as an explicit opt-in', (value) => {
    expect(isExplicitlyEnabled(value)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'no', 'off', 'enabled'])('does not treat %s as an explicit opt-in', (value) => {
    expect(isExplicitlyEnabled(value)).toBe(false);
  });
});
