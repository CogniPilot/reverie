/**
 * @fileoverview Per-instance shared hook secret (COD-54).
 *
 * Claude Code hooks POST to `/api/hook-event` with no Basic-Auth credentials,
 * relying on a localhost bypass in `web/middleware/auth.ts`. That bypass is safe
 * for loopback-only deploys, but a `cloudflared --url http://127.0.0.1:port`
 * tunnel proxies internet traffic INTO the loopback origin, so tunneled requests
 * arrive with `req.ip === 127.0.0.1` and would otherwise pass the bypass and
 * drive respawn/Ralph signals unauthenticated.
 *
 * To close that hole WITHOUT breaking the loop's own (credential-less) hook
 * channel, every locally-generated hook command now presents a per-instance
 * shared secret in the `X-Codeman-Hook-Secret` header. The middleware requires
 * a matching secret for the bypass WHEN A TUNNEL IS RUNNING. Tunneled internet
 * traffic can't know the secret; local hooks (which we generate) do.
 *
 * Storage mirrors the VAPID-key pattern in `push-store.ts`: a small file under
 * the instance data dir (`dataPath('hook-secret')`), read-if-present /
 * generate-if-missing, stable across restarts. 256 bits of hex.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getDataDir, dataPath } from './instance.js';

/** HTTP header local hooks use to present the shared secret. */
export const HOOK_SECRET_HEADER = 'X-Codeman-Hook-Secret';

/** Number of random bytes in the secret (256 bits → 64 hex chars). */
const SECRET_BYTES = 32;

let cachedSecret: string | null = null;

/**
 * Return this instance's hook secret, generating and persisting it on first use.
 * Stable across restarts. Cached in-process after the first read.
 */
export function getHookSecret(): string {
  if (cachedSecret) return cachedSecret;

  const secretFile = dataPath('hook-secret');

  if (existsSync(secretFile)) {
    try {
      const raw = readFileSync(secretFile, 'utf-8').trim();
      if (raw) {
        cachedSecret = raw;
        return cachedSecret;
      }
      // Empty/whitespace file — fall through and regenerate.
    } catch {
      // Unreadable — fall through and regenerate.
    }
  }

  const secret = randomBytes(SECRET_BYTES).toString('hex');
  try {
    mkdirSync(getDataDir(), { recursive: true });
    // Owner-only perms — the secret gates the hook bypass.
    writeFileSync(secretFile, secret, { mode: 0o600 });
  } catch {
    // Best-effort persistence: even if the write fails we still return a usable
    // secret for this process so hooks/middleware agree within this run.
  }
  cachedSecret = secret;
  return cachedSecret;
}
