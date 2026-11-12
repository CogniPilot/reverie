/** Prepare an explicitly selected local Claude account without touching its credentials. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { ClaudeMode } from './types.js';
import {startupAccountProfile} from './utils/startup-account-profile.js';
import { readSubscriptionProfiles, type SubscriptionSelection } from './subscription-profiles.js';

interface Preparation {
  selection?: SubscriptionSelection;
  mode: string;
  configDir?: string;
  workingDir: string;
  claudeMode: ClaudeMode;
  remote?: unknown;
  docker?: unknown;
  customModel?: unknown;
}

const pending = new Map<string, Promise<void>>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function readConfig(path: string, name: string): Promise<Record<string, unknown>> {
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid config');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!object(value)) throw new Error('Invalid config');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Selected Claude account ${name} is unreadable or malformed. Repair that account's configuration before starting the expert.`);
  } finally { await handle?.close(); }
}

async function writeConfig(path: string, value: Record<string, unknown>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, path);
  } catch {
    throw new Error('Selected Claude account configuration could not be saved. Check its directory permissions before starting the expert.');
  } finally { await fs.rm(temp, { force: true }); }
}

export async function prepareSelectedClaudeProfile(options: Preparation): Promise<void> {
  // Legacy default accounts intentionally leave CLAUDE_CONFIG_DIR unset and use
  // ~/.claude.json. Never change that global file or another runtime's profile.
  const selected = startupAccountProfile(options.mode)?.selectedAccount;
  if (!selected || options.selection?.provider !== selected.provider || !options.configDir ||
      options.remote || options.docker || options.customModel) return;
  const profile = (await readSubscriptionProfiles()).find(p => p.id === options.selection!.id);
  if (!profile || profile.provider !== selected.provider || resolve(profile.configDir) !== resolve(options.configDir)) {
    throw new Error('Selected Claude account does not match the launch directory. Select the account again before starting the expert.');
  }
  const dir = profile.configDir;
  const previous = pending.get(dir) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid directory');
    } catch {
      throw new Error('Selected Claude account directory is unavailable. Sign in to that account again before starting the expert.');
    }
    const configPath = join(dir, selected.configFile);
    const settingsPath = join(dir, selected.settingsFile);
    // Validate both before changing either. The pure codec preserves explicit choices.
    const config = await readConfig(configPath, selected.configFile);
    const settings = await readConfig(settingsPath, selected.settingsFile);
    const prepared = selected.prepare(config, settings, options.workingDir, options.claudeMode);
    if (JSON.stringify(prepared.config) !== JSON.stringify(config)) await writeConfig(configPath, prepared.config);
    if (JSON.stringify(prepared.settings) !== JSON.stringify(settings)) await writeConfig(settingsPath, prepared.settings);
  });
  pending.set(dir, work);
  try { await work; } finally { if (pending.get(dir) === work) pending.delete(dir); }
}
