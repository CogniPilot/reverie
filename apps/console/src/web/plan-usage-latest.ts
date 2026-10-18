/**
 * @fileoverview Process-wide last-known plan-usage telemetry (account-global).
 *
 * The Claude status-telemetry route and host Codex poll merge their latest
 * values here. The SSE init snapshot (`getLightState`) replays the combined
 * value so the header "Plan Usage Limits" chip shows immediately on a fresh
 * page load / SSE reconnect — before either source emits another sample, and
 * without relying on per-browser localStorage.
 *
 * Null until the first telemetry of the process; cleared naturally on restart.
 *
 * @module plan-usage-latest
 */

import type { SubscriptionUsage } from '../subscription-usage.js';

let latest: Record<string, unknown> | null = null;
const accounts = new Map<string, SubscriptionUsage>();

export function setLatestPlanUsage(value: Record<string, unknown>): Record<string, unknown> {
  const codex = latest?.codex;
  latest = {
    ...value,
    ...(codex !== undefined ? { codex } : {}),
    ...(accounts.size && { accounts: [...accounts.values()] }),
  };
  return latest;
}

export function setLatestCodexPlanUsage(value: object | null): Record<string, unknown> {
  latest = { ...(latest ?? {}), codex: value };
  return latest;
}

export function getLatestPlanUsage(): Record<string, unknown> | null {
  return latest;
}

/** Each saved profile has its own slot; one account can never replace another. */
export function setLatestAccountPlanUsage(value: SubscriptionUsage): Record<string, unknown> {
  const previous = accounts.get(value.id);
  // A successful statusline sample can be newer than a cached polling failure.
  if (!previous || value.updatedAt >= previous.updatedAt) accounts.set(value.id, value);
  latest = { ...(latest ?? {}), accounts: [...accounts.values()] };
  return latest;
}

/** The newest status-line report for one account, or undefined before the first report of this process. */
export function getLatestAccountPlanUsage(id: string): SubscriptionUsage | undefined {
  return accounts.get(id);
}

/** Test hook: forget every account report. */
export function resetLatestAccountPlanUsage(): void {
  accounts.clear();
}
