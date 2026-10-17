/** Per-profile quotas. Codex is polled through its own app-server; Claude rows come from Claude Code's statusline. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { SubscriptionProfile } from './subscription-profiles.js';
import type { StatusTelemetry } from './usage-telemetry.js';
import { readCodexProfilePlanUsage, resolveCodexBinaryPath } from './utils/codex-cli-resolver.js';

export interface SubscriptionUsage {
  id: string;
  label: string;
  provider: SubscriptionProfile['provider'];
  status: 'ready' | 'signed-out' | 'unavailable';
  updatedAt: number;
  usage: StatusTelemetry | null;
}

export class SubscriptionUsageReader {
  private cache = new Map<string, { stamp: string; result: SubscriptionUsage }>();
  private inFlight = new Map<string, Promise<SubscriptionUsage>>();
  constructor(private readonly version: string) {}

  async read(profile: SubscriptionProfile): Promise<SubscriptionUsage> {
    let mtime = 0;
    try {
      mtime = (
        await fs.stat(join(profile.configDir, profile.provider === 'anthropic' ? '.credentials.json' : 'auth.json'))
      ).mtimeMs;
    } catch {
      /* Not signed in yet. */
    }
    const stamp = JSON.stringify(profile) + ':' + mtime;
    const cached = this.cache.get(profile.id);
    // A five-minute cache also bounds manual Refresh and bounds how often Codex is polled.
    if (cached?.stamp === stamp && Date.now() - cached.result.updatedAt < 300_000) return cached.result;
    const pending = this.inFlight.get(profile.id);
    if (pending) return pending;
    const promise = this.collect(profile)
      .then((result) => {
        this.cache.set(profile.id, { stamp, result });
        return result;
      })
      .finally(() => this.inFlight.delete(profile.id));
    this.inFlight.set(profile.id, promise);
    return promise;
  }

  private async collect(profile: SubscriptionProfile): Promise<SubscriptionUsage> {
    const base = { id: profile.id, label: profile.label, provider: profile.provider, updatedAt: Date.now() };
    try {
      if (profile.provider === 'openai') {
        await fs.access(join(profile.configDir, 'auth.json'));
        const binary = resolveCodexBinaryPath();
        const usage = binary ? await readCodexProfilePlanUsage(binary, this.version, profile.configDir) : null;
        return { ...base, status: usage ? 'ready' : 'unavailable', usage };
      }
      // Claude Code reports its own usage through its statusline; nothing is fetched on its behalf.
      // The login file is only checked for existence, never read.
      await fs.access(join(profile.configDir, '.credentials.json'));
      return { ...base, status: 'ready', usage: null };
    } catch (error) {
      return {
        ...base,
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'signed-out' : 'unavailable',
        usage: null,
      };
    }
  }
}
