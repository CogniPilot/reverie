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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSubscriptionProfiles();
    throw new Error('Subscription profile file is invalid; it has not been changed', { cause: error });
  }
}

let writing: Promise<unknown> = Promise.resolve();
export function addSubscriptionProfile(input: {
  label: string;
  provider: SubscriptionProvider;
  configDir?: string;
}): Promise<SubscriptionProfile> {
  const result = writing.then(async () => {
    const profiles = await readSubscriptionProfiles();
    if (profiles.length >= 32) throw new Error('At most 32 account profiles are supported');
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
