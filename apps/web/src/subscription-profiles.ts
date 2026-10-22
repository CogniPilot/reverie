/** Named subscription profiles. Stores paths and labels only; credentials stay with each CLI. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDataDir } from './config/instance.js';
import { getCli, listClis } from './config/cli-registry/registry.js';

export const subscriptionProviderSchema = z.enum(['anthropic', 'openai']);
export type SubscriptionProvider = z.infer<typeof subscriptionProviderSchema>;
export const subscriptionProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(64),
    provider: subscriptionProviderSchema,
    configDir: z.string().refine(isAbsolute, 'Account directory must be absolute'),
    openCodeDataDir: z.string().refine(isAbsolute, 'OpenCode data directory must be absolute'),
  })
  .strict();
export type SubscriptionProfile = z.infer<typeof subscriptionProfileSchema>;
export type SubscriptionSelection = Pick<SubscriptionProfile, 'id' | 'label' | 'provider'>;

export function defaultSubscriptionProfiles(): SubscriptionProfile[] {
  const h = homedir();
  const openCodeDataDir = process.env.XDG_DATA_HOME || join(h, '.local/share');
  return [
    {
      id: 'anthropic-default',
      label: 'Default Claude',
      provider: 'anthropic',
      configDir: process.env.CLAUDE_CONFIG_DIR || join(h, '.claude'),
      openCodeDataDir,
    },
    {
      id: 'openai-default',
      label: 'Default Codex',
      provider: 'openai',
      configDir: process.env.CODEX_HOME || join(h, '.codex'),
      openCodeDataDir,
    },
  ];
}

export async function readSubscriptionProfiles(): Promise<SubscriptionProfile[]> {
  try {
    const text = await fs.readFile(join(getDataDir(), 'subscription-profiles.json'), 'utf8');
    const profiles = z.array(subscriptionProfileSchema).max(32).parse(JSON.parse(text));
    if (new Set(profiles.map((p) => p.id)).size !== profiles.length) throw new Error('Duplicate account profile IDs');
    return profiles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Empty directories made by startup are not configured plans. Only discover
      // legacy default logins with actual credential files; never inspect tokens.
      const legacy = await Promise.all(defaultSubscriptionProfiles().map(async profile => {
        try {
          const file = join(profile.configDir, profile.provider === 'anthropic' ? '.credentials.json' : 'auth.json');
          const stat = await fs.stat(file);
          return stat.isFile() && stat.size > 0 ? profile : null;
        } catch { return null; }
      }));
      const discovered = legacy.filter((profile): profile is SubscriptionProfile => profile !== null);
      const realDirs = new Set(await Promise.all(discovered.map(async profile => `${profile.provider}:${await fs.realpath(profile.configDir).catch(() => resolve(profile.configDir))}`)));
      for (const [provider, directory] of [['anthropic', '.claude-accounts'], ['openai', '.codex-accounts']] as const) {
        const base = join(homedir(), directory);
        const names = await fs.readdir(base).catch(() => [] as string[]);
        for (const name of names.sort()) {
          if (!/^[A-Za-z0-9._-]{1,48}$/.test(name)) continue;
          const configDir = join(base, name);
          try {
            const credential = await fs.stat(join(configDir, provider === 'anthropic' ? '.credentials.json' : 'auth.json'));
            if (!credential.isFile() || !credential.size) continue;
            const key = `${provider}:${await fs.realpath(configDir)}`;
            if (realDirs.has(key)) continue;
            realDirs.add(key);
            const id = `acct-${provider}-${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
            discovered.push(subscriptionProfileSchema.parse({ id, label: name, provider, configDir, openCodeDataDir: process.env.XDG_DATA_HOME || join(homedir(), '.local/share') }));
          } catch { /* Missing legacy login is not a plan. */ }
        }
      }
      return discovered;
    }
    throw new Error('Subscription profile file is invalid; it has not been changed', { cause: error });
  }
}

let writing: Promise<unknown> = Promise.resolve();

/** Thrown when another profile already has the label (compared ignoring case), so two plans never share a name. */
export class DuplicateLabelError extends Error {}

function refuseDuplicateLabel(others: SubscriptionProfile[], label: string): void {
  const key = label.trim().toLowerCase();
  if (others.some((p) => p.label.trim().toLowerCase() === key)) throw new DuplicateLabelError('Another account already has that name');
}

export function addSubscriptionProfile(input: {
  label: string;
  provider: SubscriptionProvider;
  configDir?: string;
}): Promise<SubscriptionProfile> {
  const result = writing.then(async () => {
    const profiles = await readSubscriptionProfiles();
    if (profiles.length >= 32) throw new Error('At most 32 account profiles are supported');
    refuseDuplicateLabel(profiles, input.label);
    const id = `${input.provider}-${randomUUID().slice(0, 8)}`;
    const configDir = input.configDir || join(getDataDir(), 'accounts', id);
    const profile = subscriptionProfileSchema.parse({
      ...input,
      id,
      configDir,
      openCodeDataDir: join(getDataDir(), 'accounts', id, 'opencode-data'),
    });
    if (profiles.some((p) => p.provider === profile.provider && resolve(p.configDir) === resolve(profile.configDir)))
      throw new Error('That login directory already has a profile');
    const path = join(getDataDir(), 'subscription-profiles.json');
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify([...profiles, profile], null, 2) + '\n', { mode: 0o600 });
      await fs.rename(tmp, path);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return profile;
  });
  writing = result.catch(() => {});
  return result;
}

/**
 * Label-only update. Materializes the built-in defaults on first use, like an addition does. Returns the
 * renamed profile with the label it replaced, read inside the write chain so a concurrent rename cannot skew it.
 */
export function renameSubscriptionProfile(
  id: string,
  label: string
): Promise<{ profile: SubscriptionProfile; from: string } | null> {
  const result = writing.then(async () => {
    const profiles = await readSubscriptionProfiles();
    const index = profiles.findIndex((p) => p.id === id);
    if (index < 0) return null;
    refuseDuplicateLabel(profiles.filter((_, i) => i !== index), label);
    const renamed = subscriptionProfileSchema.parse({ ...profiles[index], label });
    const next = profiles.map((p, i) => (i === index ? renamed : p));
    const path = join(getDataDir(), 'subscription-profiles.json');
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(tmp, path);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return { profile: renamed, from: profiles[index].label };
  });
  writing = result.catch(() => {});
  return result;
}

/**
 * Unlist a profile. Only the entry goes: the login directory and everything in it stay on disk (a
 * removed account can be listed again by pointing a new profile at the same directory), and the
 * default profiles can also be unlisted. Returns the removed profile, or null when there is no such id.
 */
/** Thrown for the one refusal that is bad input; any other error from a remove is a failure of ours. */

export function removeSubscriptionProfile(id: string): Promise<SubscriptionProfile | null> {
  const result = writing.then(async () => {
    const profiles = await readSubscriptionProfiles();
    const index = profiles.findIndex((p) => p.id === id);
    if (index < 0) return null;
    const next = profiles.filter((_, i) => i !== index);
    const path = join(getDataDir(), 'subscription-profiles.json');
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(tmp, path);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return profiles[index];
  });
  writing = result.catch(() => {});
  return result;
}

/** Resolve by existing registry capabilities, so custom CLI entries can take the same profiles. */
export function subscriptionBinding(mode: string, provider: SubscriptionProvider): 'native' | 'opencode' | null {
  const cap = getCli(mode)?.capabilities;
  const relocation = cap?.mcpConfig?.relocation?.envVar;
  if (
    (provider === 'anthropic' && relocation === 'CLAUDE_CONFIG_DIR') ||
    (provider === 'openai' && relocation === 'CODEX_HOME')
  )
    return 'native';
  const injection = cap?.customModelInjection;
  // A Claude subscription is only for Claude Code; OpenCode takes OpenAI accounts, API keys or local models.
  if (provider === 'openai' && injection?.kind === 'configContentEnv' && injection.envVar === 'OPENCODE_CONFIG_CONTENT')
    return 'opencode';
  return null;
}

export function subscriptionModes(provider: SubscriptionProvider): string[] {
  return listClis()
    .filter((c) => subscriptionBinding(c.id, provider))
    .map((c) => c.id);
}

export function subscriptionEnvironment(profile: SubscriptionProfile, mode: string): Record<string, string> {
  const binding = subscriptionBinding(mode, profile.provider);
  if (!binding) throw new Error('This agent does not support the selected account provider');
  // Leaving the default Claude directory unset preserves its existing ~/.claude.json.
  const defaults = defaultSubscriptionProfiles().find((p) => p.id === profile.id);
  const env: Record<string, string> = {};
  if (!defaults || resolve(defaults.configDir) !== resolve(profile.configDir)) {
    env[profile.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = profile.configDir;
  }
  if (binding === 'opencode') {
    env.XDG_DATA_HOME = profile.openCodeDataDir;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'openai/gpt-5.4' });
  }
  return env;
}

export async function selectedSubscription(
  id: string | undefined,
  mode: string
): Promise<{ selection?: SubscriptionSelection; env: Record<string, string> }> {
  if (!id) return { env: {} };
  const profile = (await readSubscriptionProfiles()).find((p) => p.id === id);
  if (!profile) throw new Error('The selected account profile no longer exists');
  if (profile.provider === 'openai' && subscriptionBinding(mode, profile.provider) === 'opencode') {
    const readAccount = async (path: string): Promise<unknown> => {
      try {
        return JSON.parse(await fs.readFile(path, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('Account login data could not be read. Sign in again.');
      }
    };
    const native = (await readAccount(join(profile.configDir, 'auth.json'))) as {
      tokens?: { account_id?: string };
    } | null;
    const openCode = (await readAccount(join(profile.openCodeDataDir, 'opencode/auth.json'))) as {
      openai?: { accountId?: string };
    } | null;
    if (
      native?.tokens?.account_id &&
      openCode?.openai?.accountId &&
      native.tokens.account_id !== openCode.openai.accountId
    ) {
      throw new Error(
        'Codex CLI and OpenCode are signed into different accounts for this profile. Sign both into the same account.'
      );
    }
  }
  return {
    selection: { id: profile.id, label: profile.label, provider: profile.provider },
    env: subscriptionEnvironment(profile, mode),
  };
}
