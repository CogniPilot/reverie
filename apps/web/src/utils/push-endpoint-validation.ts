/**
 * @fileoverview SSRF guard for web-push subscription endpoints (security review M7).
 *
 * A push `endpoint` is an attacker-suppliable URL that the server fetches via
 * `webpush.sendNotification`. On the no-auth loopback default a local page (or any
 * non-browser client) could register an endpoint pointing at the cloud metadata
 * service (169.254.169.254) or an internal host, turning the server into an SSRF
 * proxy. We require https and reject IP-literal hosts in private/loopback/
 * link-local/reserved ranges. DNS-named hosts are allowed (every real push service
 * — FCM, Mozilla, Apple, WNS — uses a public DNS name); this is checked both at
 * subscribe time (schema) and again at send time (defense-in-depth).
 *
 * Note: a hostname that *resolves* to an internal IP (DNS rebinding) is not caught
 * here without async resolution; the realistic, documented vector (a direct
 * internal IP literal) is closed.
 */
import { isIP } from 'node:net';

/** True if `host` is an IP literal in a private, loopback, link-local, or reserved range. */
function isPrivateOrReservedIp(host: string): boolean {
  const kind = isIP(host);
  if (kind === 0) return false; // not an IP literal — a DNS name

  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
    if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
    if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
    return false;
  }

  // IPv6
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback, unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  // IPv4-mapped (::ffff:a.b.c.d). URL/Node may normalize the dotted tail to hex
  // (::ffff:7f00:1), so handle both forms and re-check the embedded IPv4.
  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isPrivateOrReservedIp(mappedDotted[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateOrReservedIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  return false;
}

/**
 * Validate a web-push endpoint URL is safe to fetch server-side.
 * Requires an https URL whose host is not an internal/reserved IP literal.
 */
export function isSafePushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  // URL.hostname wraps IPv6 literals in brackets ([::1]); strip them for isIP().
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return !isPrivateOrReservedIp(host);
}
