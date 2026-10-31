/**
 * @fileoverview Plans: every subscription account on this machine, its usage pace, the
 * sessions running on it, and the local GPU, for the Plans view and `/api/plans`.
 *
 * Accounts come from two places, merged by the real login directory:
 * - Reverie's subscription profiles (`subscription-profiles.json`, the Run menu's picker);
 * - the `acct` tool's accounts (`~/.claude-accounts/<name>`, `~/.codex-accounts/<name>`),
 *   which `acct spawn` selects with a `CLAUDE_CONFIG_DIR` / `CODEX_HOME` override.
 * A profile and an `acct` account that resolve to the same directory are one account,
 * named by its `acct` name (e.g. `~/.claude` is "primary").
 *
 * A session's account is its profile, else its `CLAUDE_CONFIG_DIR`/`CODEX_HOME` override,
 * else the default account of its CLI. Usage samples are kept (8 days, one per 5 min per
 * account, `plan-usage-history.json`) for the burn rate. Credentials are never read here:
 * login state and quotas come from `SubscriptionUsageReader`.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { getDataDir } from './config/instance.js';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  defaultSubscriptionProfiles,
  subscriptionBinding,
  readSubscriptionProfiles,
  type SubscriptionProfile,
  type SubscriptionProvider,
} from './subscription-profiles.js';
import type { SubscriptionUsage } from './subscription-usage.js';
import { getLatestAccountPlanUsage } from './web/plan-usage-latest.js';
import type { BankedResets } from './usage-telemetry.js';
import { addSample, planPace, suggestAccount, toMs, type PlanPace, type UsageSample } from './plan-pace.js';
import { planAgentBurn, type PlanAgentBurn, type PlanCostTracker } from './plan-agent-burn.js';

export interface PlanAccount {
  /** The profile id when there is one, else `acct-<provider>-<name>`. */
  id: string;
  label: string;
  provider: SubscriptionProvider;
  configDir: string;
  realDir: string;
  profileId?: string;
  acctName?: string;
  isDefault: boolean;
  profile: SubscriptionProfile;
}

export interface PlanSession {
  id: string;
  name: string;
  mode: string;
  status: string;
}

/** Status-line numbers older than this are shown as stale, with their as-of time. */
export const USAGE_STALE_MS = 30 * 60 * 1000;

export interface PlanRow {
  id: string;
  label: string;
  provider: SubscriptionProvider;
  profileId: string | null;
  acctName: string | null;
  isDefault: boolean;
  authState?: SubscriptionUsage['authState'];
  usageError?: string;
  signedIn: boolean;
  status: SubscriptionUsage['status'];
  updatedAt: number;
  /** Where the usage numbers came from: Claude Code's status line, the last saved sample, or the provider read. */
  usageSource: 'statusline' | 'history' | 'provider' | null;
  /** When the numbers were reported (epoch ms); null when there are none. */
  usageAsOf: number | null;
  /** True when the numbers are older than `USAGE_STALE_MS`. */
  usageStale: boolean;
  pace: PlanPace;
  /** Codex banked resets; null when not read (shown as "unknown"), and always null for Claude. */
  bankedResets: BankedResets | null;
  sessions: PlanSession[];
  orchestrator: boolean;
  /** Each session's share of this plan's burn from its status-line cost, and the realtime rate; null without cost reports. */
  agentBurn: PlanAgentBurn | null;
}

export interface GpuStatus {
  available: boolean;
  utilization: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  models: string[];
  lastHolder: { role: string; ageS: number } | null;
}

export interface PlanSessionLike {
  id: string;
  name: string;
  mode: string;
  status: string;
  subscriptionProfile?: { id: string } | undefined;
  getEnvOverridesForPersist(): Record<string, string> | undefined;
}

const ACCT_DIRS: Array<[SubscriptionProvider, string]> = [
  ['anthropic', '.claude-accounts'],
  ['openai', '.codex-accounts'],
];

async function real(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Reverie profiles plus `acct` accounts, one entry per real login directory. */
export async function planCatalogue(home = homedir()): Promise<PlanAccount[]> {
  const profiles = await readSubscriptionProfiles();
  const configured = await fs.access(join(getDataDir(), 'subscription-profiles.json')).then(() => true, () => false);
  const defaults = new Map<SubscriptionProvider, string>();
  for (const d of defaultSubscriptionProfiles()) defaults.set(d.provider, await real(d.configDir));
  const accounts: PlanAccount[] = [];
  for (const p of profiles) {
    const realDir = await real(p.configDir);
    accounts.push({
      id: p.id,
      label: p.label,
      provider: p.provider,
      configDir: p.configDir,
      realDir,
      profileId: p.id,
      isDefault: defaults.get(p.provider) === realDir,
      profile: p,
    });
  }
  const openCodeDataDir = process.env.XDG_DATA_HOME || join(home, '.local/share');
  for (const [provider, dirName] of ACCT_DIRS) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(join(home, dirName))).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) continue;
      const configDir = join(home, dirName, name);
      const realDir = await real(configDir);
      const same = accounts.find((a) => a.provider === provider && a.realDir === realDir);
      if (same) {
        // A label the owner set on the profile wins; the built-in default label and a missing profile
        // take the directory name, as before.
        same.acctName = name;
        const builtIn = defaultSubscriptionProfiles().some((d) => d.id === same.profileId && d.label === same.label);
        if (!same.profileId || builtIn) same.label = name;
        continue;
      }
      if (configured) continue; // An explicit registry, even [], suppresses rediscovery.
      try {
        const credential = await fs.stat(join(configDir, provider === 'anthropic' ? '.credentials.json' : 'auth.json'));
        if (!credential.isFile() || !credential.size) continue;
      } catch { continue; }
      const id = `acct-${provider}-${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      accounts.push({
        id,
        label: name,
        provider,
        configDir,
        realDir,
        acctName: name,
        isDefault: defaults.get(provider) === realDir,
        profile: { id, label: name, provider, configDir, openCodeDataDir },
      });
    }
  }
  return accounts;
}

/** Which account a session runs on (see the file overview), or undefined. */
export async function accountForSession(
  session: PlanSessionLike,
  accounts: PlanAccount[]
): Promise<PlanAccount | undefined> {
  const byProfile = session.subscriptionProfile?.id;
  if (byProfile) return accounts.find((a) => a.profileId === byProfile);
  const env = session.getEnvOverridesForPersist() ?? {};
  const provider = (['anthropic', 'openai'] as const).find(
    (candidate) => subscriptionBinding(session.mode, candidate) === 'native'
  );
  if (env.CLAUDE_CONFIG_DIR) {
    const dir = await real(env.CLAUDE_CONFIG_DIR);
    return accounts.find((a) => a.provider === 'anthropic' && a.realDir === dir);
  }
  if (env.CODEX_HOME) {
    const dir = await real(env.CODEX_HOME);
    return accounts.find((a) => a.provider === 'openai' && a.realDir === dir);
  }
  return provider ? accounts.find((a) => a.provider === provider && a.isDefault) : undefined;
}

/** What a new session needs to run on `account`: the profile id and/or the env override `acct spawn` uses. */
export function launchFor(account: PlanAccount): {
  subscriptionProfileId?: string;
  envOverrides: Record<string, string>;
} {
  const envOverrides: Record<string, string> = account.isDefault
    ? {}
    : { [account.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: account.configDir };
  return { ...(account.profileId ? { subscriptionProfileId: account.profileId } : {}), envOverrides };
}

const run = promisify(execFile);

/** nvidia-smi utilization and memory, the models the GPU processes serve, and the last lock holder. */
export async function gpuStatus(home = homedir()): Promise<GpuStatus> {
  const status: GpuStatus = {
    available: false,
    utilization: null,
    memoryUsedMb: null,
    memoryTotalMb: null,
    models: [],
    lastHolder: null,
  };
  if (process.env.VITEST) return status;
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000 }
    );
    const [util, used, total] = stdout
      .split('\n')[0]
      .split(',')
      .map((v) => Number(v.trim()));
    Object.assign(status, { available: true, utilization: util, memoryUsedMb: used, memoryTotalMb: total });
    const apps = await run('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader'], { timeout: 3000 });
    for (const pid of apps.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))) {
      try {
        const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
        const i = args.findIndex((a) => a === '-m' || a === '--model');
        const model = i >= 0 ? args[i + 1] : args.find((a) => /\.(gguf|safetensors|bin)$/.test(a));
        if (model) status.models.push(basename(model));
      } catch {
        /* the process ended */
      }
    }
  } catch {
    /* no NVIDIA GPU or driver */
  }
  try {
    const lines = (await fs.readFile(join(home, '.cache', 'gpu.activity'), 'utf8')).trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]) as { role?: string; at?: number };
    if (last.role && Number.isFinite(last.at)) {
      status.lastHolder = { role: last.role, ageS: Math.max(0, Math.round(Date.now() / 1000 - (last.at as number))) };
    }
  } catch {
    /* no GPU router activity recorded */
  }
  return status;
}

export interface PlanServiceDeps {
  reader: { read(profile: SubscriptionProfile): Promise<SubscriptionUsage> };
  sessions(): Iterable<PlanSessionLike>;
  /** Session ids that coordinate a chatroom: their accounts are marked as the orchestrator's. */
  coordinatorIds(): string[];
  historyFile: string;
  /** Per-session status-line cost samples (Claude Code only); without it no per-agent burn is computed. */
  costs?: PlanCostTracker;
  home?: string;
  now?: () => number;
  gpu?: () => Promise<GpuStatus>;
}

export class PlanService {
  private history: Record<string, UsageSample[]> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PlanServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async loadHistory(): Promise<Record<string, UsageSample[]>> {
    if (this.history) return this.history;
    try {
      this.history = JSON.parse(await fs.readFile(this.deps.historyFile, 'utf8')) as Record<string, UsageSample[]>;
    } catch {
      this.history = {};
    }
    if (await this.applyMarks(this.history)) this.saveHistory();
    return this.history;
  }

  /**
   * `plan-usage-marks.json` beside the history: a list of `{ account, at }` naming readings that were filed under the wrong
   * account. Read once, as the history loads; each exact match gets `misattributed: true` in memory and is saved through the
   * normal path. The file is never written here, a missing or unreadable one is ignored, and a second load changes nothing.
   * Returns whether any sample changed.
   */
  private async applyMarks(history: Record<string, UsageSample[]>): Promise<boolean> {
    let marks: unknown;
    try {
      marks = JSON.parse(await fs.readFile(join(dirname(this.deps.historyFile), 'plan-usage-marks.json'), 'utf8'));
    } catch {
      return false;
    }
    if (!Array.isArray(marks)) return false;
    let changed = false;
    for (const mark of marks as { account?: unknown; at?: unknown }[]) {
      if (!mark || typeof mark.account !== 'string' || typeof mark.at !== 'number' || !Array.isArray(history[mark.account])) continue;
      for (const sample of history[mark.account]) {
        if (sample && sample.at === mark.at && !sample.misattributed) {
          sample.misattributed = true;
          changed = true;
        }
      }
    }
    return changed;
  }

  private saveHistory(): void {
    const snapshot = JSON.stringify(this.history ?? {});
    this.saving = this.saving
      .then(async () => {
        const tmp = `${this.deps.historyFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.rename(tmp, this.deps.historyFile);
      })
      .catch(() => {});
  }

  private async sessionsByAccount(catalogue: PlanAccount[]): Promise<Map<string, PlanSession[]>> {
    const assigned = new Map<string, PlanSession[]>();
    for (const session of this.deps.sessions()) {
      const account = await accountForSession(session, catalogue);
      if (!account) continue;
      const members = assigned.get(account.id) ?? [];
      members.push({ id: session.id, name: session.name, mode: session.mode, status: session.status });
      assigned.set(account.id, members);
    }
    return assigned;
  }

  async allocations(): Promise<{ generatedAt: number; accounts: Array<{ id: string; sessionIds: string[] }> }> {
    const catalogue = await planCatalogue(this.deps.home);
    const assigned = await this.sessionsByAccount(catalogue);
    return {
      generatedAt: this.now(),
      accounts: catalogue.map((account) => ({
        id: account.id,
        sessionIds: (assigned.get(account.id) ?? []).map((session) => session.id),
      })),
    };
  }

  /** Every account with its pace and sessions; records one usage sample per account. */
  async rows(): Promise<{ accounts: PlanRow[]; catalogue: PlanAccount[] }> {
    const catalogue = await planCatalogue(this.deps.home);
    const history = await this.loadHistory();
    const now = this.now();
    const readings = await Promise.all(
      catalogue.map((a) =>
        this.deps.reader.read(a.profile).catch(
          (): SubscriptionUsage => ({
            id: a.id,
            label: a.label,
            provider: a.provider,
            status: 'unavailable',
            updatedAt: now,
            usage: null,
          })
        )
      )
    );
    const sessionsByAccount = await this.sessionsByAccount(catalogue);
    const coordinators = new Set(this.deps.coordinatorIds());
    const costs = this.deps.costs ? await this.deps.costs.snapshot() : null;
    let changed = false;
    const accounts = catalogue.map((a, i): PlanRow => {
      let reading = readings[i];
      let usageSource: PlanRow['usageSource'] = reading.usage ? 'provider' : null;
      let usageAsOf: number | null = reading.usage ? reading.updatedAt : null;
      let seeded = false;
      if (a.provider === 'anthropic' && !reading.usage && (reading.authState === 'signed-in' || reading.status === 'ready')) {
        // Claude Code reports its own limits through its status line; use the newest report from any
        // session on this account when polling is unavailable. After a restart, fall back to the last saved sample.
        const reported = getLatestAccountPlanUsage(a.id);
        if (reported?.usage) {
          reading = { ...reading, usage: reported.usage };
          usageSource = 'statusline';
          usageAsOf = reported.updatedAt;
        } else {
          const last = (history[a.id] ?? []).at(-1);
          if (last) {
            // The saved sample keeps its reset, so a restart does not blank the period; a reset already past means a new
            // period whose end is not known yet.
            const savedReset = last.resetAt !== undefined && last.resetAt > now ? last.resetAt : Number.NaN;
            reading = { ...reading, usage: { sevenDay: { usedPercentage: last.weekly, resetAt: savedReset } } };
            usageSource = 'history';
            usageAsOf = last.at;
            seeded = true;
          }
        }
      }
      const weekly = reading.usage?.sevenDay?.usedPercentage;
      const sampleReset = toMs(reading.usage?.sevenDay?.resetAt);
      const withReset = (weeklyValue: number): UsageSample => ({
        at: now,
        weekly: weeklyValue,
        ...(sampleReset !== null ? { resetAt: sampleReset } : {}),
      });
      if (
        !seeded &&
        usageSource !== 'provider' &&
        Number.isFinite(weekly) &&
        now - (usageAsOf ?? 0) <= USAGE_STALE_MS
      ) {
        history[a.id] = addSample(history[a.id] ?? [], withReset(weekly as number));
        changed = true;
      } else if (usageSource === 'provider' && Number.isFinite(weekly)) {
        history[a.id] = addSample(history[a.id] ?? [], withReset(weekly as number));
        changed = true;
      }
      const sessions = sessionsByAccount.get(a.id) ?? [];
      const agentBurn = costs && a.provider === 'anthropic'
        ? planAgentBurn({
            provider: a.provider,
            label: a.label,
            usage: history[a.id] ?? [],
            sessions: sessions.map((s) => ({ id: s.id, name: s.name, costs: costs[s.id] ?? [] })),
            weekReset: toMs(reading.usage?.sevenDay?.resetAt),
            now,
          })
        : null;
      return {
        id: a.id,
        label: a.label,
        provider: a.provider,
        profileId: a.profileId ?? null,
        acctName: a.acctName ?? null,
        isDefault: a.isDefault,
        signedIn: reading.authState ? reading.authState === 'signed-in' : reading.status === 'ready',
        status: reading.status,
        authState: reading.authState,
        usageError: reading.usageError,
        updatedAt: reading.updatedAt,
        usageSource,
        usageAsOf,
        usageStale: usageAsOf !== null && usageSource !== 'provider' && now - usageAsOf > USAGE_STALE_MS,
        pace: planPace({
          signedIn: reading.authState ? reading.authState === 'signed-in' : reading.status === 'ready',
          fiveHour: reading.usage?.fiveHour ?? null,
          sevenDay: reading.usage?.sevenDay ?? null,
          samples: history[a.id] ?? [],
          bankedResets: reading.usage?.bankedResets,
          now,
        }),
        bankedResets: reading.usage?.bankedResets ?? null,
        sessions,
        orchestrator: sessions.some((s) => coordinators.has(s.id)),
        agentBurn,
      };
    });
    if (changed) this.saveHistory();
    return { accounts, catalogue };
  }

  /** A copy of the per-account weekly usage samples (the board draws its burn lines from them). */
  async usageHistory(): Promise<Record<string, UsageSample[]>> {
    return structuredClone(await this.loadHistory());
  }

  async plans(): Promise<{ generatedAt: number; accounts: PlanRow[]; gpu: GpuStatus }> {
    const [{ accounts }, gpu] = await Promise.all([
      this.rows(),
      (this.deps.gpu ?? (() => gpuStatus(this.deps.home)))(),
    ]);
    return { generatedAt: this.now(), accounts, gpu };
  }

  /** One catalogue account by id (a Plans row id), or undefined. */
  async account(id: string): Promise<PlanAccount | undefined> {
    return (await planCatalogue(this.deps.home)).find((a) => a.id === id);
  }

  /** The account a new session should use, and how to launch on it; null when none fits. */
  async suggest(provider: SubscriptionProvider) {
    const { accounts, catalogue } = await this.rows();
    const pick = suggestAccount(accounts, provider);
    if (!pick) return null;
    const account = catalogue.find((a) => a.id === pick.id)!;
    return { account: pick, launch: launchFor(account) };
  }
}
