/** Per-profile quotas. Codex uses its app-server; Claude uses read-only quota metadata. */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export type ProviderAuthState = 'signed-in' | 'signed-out' | 'unavailable' | 'error';
export async function providerAuthState(profile: SubscriptionProfile): Promise<ProviderAuthState> {
  try {
    if (profile.provider === 'anthropic') {
      const { stdout } = await run('claude', ['auth', 'status', '--json'], { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir } });
      return JSON.parse(stdout).loggedIn === true ? 'signed-in' : 'signed-out';
    }
    const { stdout, stderr } = await run(resolveCodexBinaryPath() || 'codex', ['login', 'status'], { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, CODEX_HOME: profile.configDir } });
    return /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr) ? 'signed-in' : 'signed-out';
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') return 'unavailable';
    if (profile.provider === 'anthropic' && e.stdout) {
      try { const status = JSON.parse(e.stdout); if (status.loggedIn === false) return 'signed-out'; } catch { /* No structured status. */ }
    }
    if (/not logged in/i.test((e.stdout || '') + (e.stderr || ''))) return 'signed-out';
    return 'error';
  }
}

import { join } from 'node:path';
import type { SubscriptionProfile } from './subscription-profiles.js';
import type { StatusTelemetry } from './usage-telemetry.js';
import { readCodexProfilePlanUsage, resolveCodexBinaryPath } from './utils/codex-cli-resolver.js';
import { readClaudePlanUsage } from './claude-plan-usage.js';

export interface SubscriptionUsage {
  id: string;
  label: string;
  provider: SubscriptionProfile['provider'];
  status: 'ready' | 'signed-out' | 'unavailable';
  authState?: ProviderAuthState;
  updatedAt: number;
  usage: StatusTelemetry | null;
  usageError?: string;
}

export class SubscriptionUsageReader {
  private cache = new Map<string, { stamp: string; result: SubscriptionUsage }>();
  private inFlight = new Map<string, Promise<SubscriptionUsage>>();
  constructor(private readonly version: string, private readonly auth = providerAuthState) {}

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
    // Credential changes invalidate immediately; briefly cache provider status commands.
    const cacheMs = profile.provider === 'anthropic' ? 5 * 60_000 : 15_000;
    if (cached?.stamp === stamp && Date.now() - cached.result.updatedAt < cacheMs) return cached.result;
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
    const authState = await this.auth(profile);
    const authenticated = { ...base, authState };
    try {
      if (profile.provider === 'openai') {
        await fs.access(join(profile.configDir, 'auth.json'));
        const binary = resolveCodexBinaryPath();
        const usage = binary ? await readCodexProfilePlanUsage(binary, this.version, profile.configDir) : null;
        return { ...authenticated, status: usage ? 'ready' : 'unavailable', usage };
      }
      await fs.access(join(profile.configDir, '.credentials.json'));
      if (authState !== 'signed-in') return { ...authenticated, status: authState === 'signed-out' ? 'signed-out' : 'unavailable', usage: null };
      const result = await readClaudePlanUsage(profile.configDir);
      return { ...authenticated, status: result.usage ? 'ready' : 'unavailable', ...result };
    } catch (error) {
      return {
        ...authenticated,
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'signed-out' : 'unavailable',
        usage: null,
      };
    }
  }
}
