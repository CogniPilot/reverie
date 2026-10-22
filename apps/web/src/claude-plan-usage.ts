/** Read-only account quota metadata. Credentials stay inside this provider adapter. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { StatusTelemetry } from './usage-telemetry.js';

export interface ClaudePlanUsage {
  usage: StatusTelemetry | null;
  usageError?: string;
}

/** The provider response is untrusted; expose only the two numeric quota windows. */
export function parseClaudePlanUsage(value: unknown): StatusTelemetry | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const usage: StatusTelemetry = {};
  for (const [key, target] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay']] as const) {
    const window = data[key] as { utilization?: unknown; resets_at?: unknown } | null;
    if (!window || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) continue;
    const resetAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    if (!Number.isFinite(resetAt) || resetAt <= 0) continue;
    usage[target] = { usedPercentage: Math.min(100, Math.max(0, window.utilization)), resetAt };
  }
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

export async function readClaudePlanUsage(configDir: string): Promise<ClaudePlanUsage> {
  let login: { accessToken?: unknown; expiresAt?: unknown; scopes?: unknown } | undefined;
  try {
    const file = await fs.readFile(join(configDir, '.credentials.json'), 'utf8');
    login = JSON.parse(file)?.claudeAiOauth;
  } catch {
    return { usage: null, usageError: 'Claude login could not be read. Sign in again.' };
  }
  if (typeof login?.accessToken !== 'string' || !login.accessToken || /[\r\n]/.test(login.accessToken)) {
    return { usage: null, usageError: 'Claude subscription login is missing. Sign in again.' };
  }
  if (typeof login.expiresAt !== 'number' || !Number.isFinite(login.expiresAt) || login.expiresAt <= Date.now()) {
    return { usage: null, usageError: 'Claude login expired. Sign in again to refresh usage.' };
  }
  if (Array.isArray(login.scopes) && !login.scopes.includes('user:profile')) {
    return { usage: null, usageError: 'Claude login cannot read plan usage. Sign in again with your subscription account.' };
  }
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: { Authorization: `Bearer ${login.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    // Never surface a provider body: it may contain identifying account information.
    if (!response.ok) {
      await response.body?.cancel();
      const usageError = response.status === 401 || response.status === 403
        ? 'Claude refused the usage login. Sign in again.'
        : response.status === 429
          ? 'Claude usage is rate limited. Reverie will retry in five minutes.'
          : 'Claude usage is temporarily unavailable. Reverie will retry in five minutes.';
      return { usage: null, usageError };
    }
    // Quota metadata is small; cap the body independently of the request timeout.
    let length = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 64 * 1024) throw new Error('Quota response too large');
      chunks.push(chunk);
    }
    const usage = parseClaudePlanUsage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return usage ? { usage } : { usage: null, usageError: 'Claude returned no plan usage windows. Check your subscription account.' };
  } catch {
    return { usage: null, usageError: 'Claude usage could not be read. Check the connection; Reverie will retry in five minutes.' };
  }
}
