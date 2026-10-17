/**
 * SSRF guard for web-push endpoints (security review M7).
 */
import { describe, it, expect } from 'vitest';
import { isSafePushEndpoint } from '../src/utils/push-endpoint-validation.js';

describe('isSafePushEndpoint (SSRF guard, M7)', () => {
  it('accepts real https push-service endpoints (public DNS hosts)', () => {
    expect(isSafePushEndpoint('https://fcm.googleapis.com/fcm/send/abc123')).toBe(true);
    expect(isSafePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isSafePushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isSafePushEndpoint('https://foo.notify.windows.com/w/?token=x')).toBe(true);
  });

  it('accepts a public IP literal over https', () => {
    expect(isSafePushEndpoint('https://93.184.216.34/x')).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(isSafePushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isSafePushEndpoint('ftp://example.com/x')).toBe(false);
  });

  it('rejects the cloud-metadata IP and internal IPv4 ranges', () => {
    expect(isSafePushEndpoint('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafePushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isSafePushEndpoint('https://10.0.0.5/x')).toBe(false);
    expect(isSafePushEndpoint('https://192.168.1.10/x')).toBe(false);
    expect(isSafePushEndpoint('https://172.16.0.1/x')).toBe(false);
    expect(isSafePushEndpoint('https://100.64.0.1/x')).toBe(false);
    expect(isSafePushEndpoint('https://0.0.0.0/x')).toBe(false);
  });

  it('rejects internal IPv6 (incl. bracketed + IPv4-mapped)', () => {
    expect(isSafePushEndpoint('https://[::1]/x')).toBe(false);
    expect(isSafePushEndpoint('https://[fe80::1]/x')).toBe(false);
    expect(isSafePushEndpoint('https://[fd00::1]/x')).toBe(false);
    expect(isSafePushEndpoint('https://[::ffff:127.0.0.1]/x')).toBe(false);
  });

  it('rejects garbage / empty input', () => {
    expect(isSafePushEndpoint('not a url')).toBe(false);
    expect(isSafePushEndpoint('')).toBe(false);
  });
});
