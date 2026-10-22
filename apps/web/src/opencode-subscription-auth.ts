/** Bridge an explicitly selected Codex plan into its private OpenCode login store. */
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SubscriptionProfile } from './subscription-profiles.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

async function readAccount(path: string): Promise<RecordValue | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid login file');
    return record(JSON.parse(await fs.readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Account login data could not be read. Sign in again.');
  }
}

function expiry(token: string): number {
  try {
    // Only an expiry hint; this does not authenticate a JWT or establish identity.
    const claims = record(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()));
    return typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp * 1000) && claims.exp > 0
      ? claims.exp * 1000 : 0;
  } catch { return 0; }
}

/**
 * Both pinned CLIs use the same public OAuth client. Import only into a missing
 * store, never overwrite another login or refresh tokens maintained by OpenCode.
 * Credentials stay in the selected plan's private directory, never session state.
 */
export async function ensureOpenCodeSubscriptionAuth(profile: SubscriptionProfile): Promise<void> {
  const native = await readAccount(join(profile.configDir, 'auth.json'));
  const tokens = record(native?.tokens);
  const path = join(profile.openCodeDataDir, 'opencode/auth.json');
  const validExisting = (account: RecordValue | null): boolean => {
    const auth = record(account?.openai);
    if (nonempty(tokens.account_id) && nonempty(auth.accountId) && tokens.account_id !== auth.accountId)
      throw new Error('Codex CLI and OpenCode are signed into different accounts for this profile. Sign both into the same account.');
    if (!nonempty(tokens.account_id) && !nonempty(auth.accountId)) return false;
    return auth.type === 'oauth' && nonempty(auth.access) && nonempty(auth.refresh) &&
      typeof auth.expires === 'number' && Number.isFinite(auth.expires) && auth.expires >= 0 &&
      nonempty(auth.accountId);
  };
  const existing = await readAccount(path);
  if (validExisting(existing)) return;
  if (existing !== null)
    throw new Error('This plan is not signed into OpenCode. Sign into the same account in OpenCode before selecting this harness.');
  if (!nonempty(tokens.account_id) || !nonempty(tokens.access_token) || !nonempty(tokens.refresh_token))
    throw new Error('This plan needs a ChatGPT subscription sign-in before it can run with OpenCode.');
  const auth = { openai: { type: 'oauth', access: tokens.access_token, refresh: tokens.refresh_token,
    accountId: tokens.account_id, expires: expiry(tokens.access_token) } };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.auth-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(auth) + '\n', { flag: 'wx', mode: 0o600 });
    // Publish a complete file without replacing a concurrent CLI sign-in.
    await fs.link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new Error('The selected plan could not be prepared for OpenCode. Check its private login directory.');
    if (!validExisting(await readAccount(path)))
      throw new Error('The OpenCode login changed while preparing this plan. Check its sign-in and try again.');
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
