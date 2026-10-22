import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureOpenCodeSubscriptionAuth } from '../src/opencode-subscription-auth.js';
import type { SubscriptionProfile } from '../src/subscription-profiles.js';

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'opencode-login-'));
  const profile: SubscriptionProfile = { id: 'work', label: 'Work', provider: 'openai',
    configDir: join(root, 'native'), openCodeDataDir: join(root, 'data') };
  await fs.mkdir(profile.configDir);
  const native = join(profile.configDir, 'auth.json');
  const target = join(profile.openCodeDataDir, 'opencode/auth.json');
  const tokens = { account_id: 'synthetic-account', refresh_token: 'synthetic-refresh',
    access_token: 'header.' + Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url') + '.signature' };
  return { root, profile, native, target, tokens };
}

describe('OpenCode subscription login preparation', () => {
  it('imports only the selected native OAuth login into a new private store, once', async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.native, JSON.stringify({ tokens: f.tokens }));
      await Promise.all([ensureOpenCodeSubscriptionAuth(f.profile), ensureOpenCodeSubscriptionAuth(f.profile)]);
      expect(JSON.parse(await fs.readFile(f.target, 'utf8'))).toEqual({ openai: {
        type: 'oauth', access: f.tokens.access_token, refresh: f.tokens.refresh_token,
        accountId: f.tokens.account_id, expires: 2000000000000,
      } });
      expect((await fs.stat(f.target)).mode & 0o777).toBe(0o600);
      const before = await fs.readFile(f.target, 'utf8');
      await fs.writeFile(f.native, JSON.stringify({ tokens: { ...f.tokens, refresh_token: 'new-native-refresh' } }));
      await ensureOpenCodeSubscriptionAuth(f.profile);
      expect(await fs.readFile(f.target, 'utf8')).toBe(before);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a different account without modifying either login', async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.native, JSON.stringify({ tokens: f.tokens }));
      await fs.mkdir(join(f.profile.openCodeDataDir, 'opencode'), { recursive: true });
      const other = JSON.stringify({ openai: { type: 'oauth', accountId: 'other', access: 'other-access', refresh: 'other-refresh', expires: 0 } });
      await fs.writeFile(f.target, other);
      await expect(ensureOpenCodeSubscriptionAuth(f.profile)).rejects.toThrow('different accounts');
      expect(await fs.readFile(f.target, 'utf8')).toBe(other);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses missing OAuth credentials instead of permitting an unrelated free provider', async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.native, JSON.stringify({ tokens: { account_id: 'synthetic-account' } }));
      await expect(ensureOpenCodeSubscriptionAuth(f.profile)).rejects.toThrow('subscription sign-in');
      await expect(fs.stat(f.target)).rejects.toHaveProperty('code', 'ENOENT');
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it('preserves existing provider stores and malformed files rather than replacing them', async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.native, JSON.stringify({ tokens: f.tokens }));
      await fs.mkdir(join(f.profile.openCodeDataDir, 'opencode'), { recursive: true });
      for (const text of [JSON.stringify({ other: { type: 'api', key: 'synthetic-other-key' } }), '{broken']) {
        await fs.writeFile(f.target, text);
        await expect(ensureOpenCodeSubscriptionAuth(f.profile)).rejects.toThrow();
        expect(await fs.readFile(f.target, 'utf8')).toBe(text);
      }
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});
