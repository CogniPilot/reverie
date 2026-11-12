/** Actual owner authentication for HTTP suites, using only the runner's isolated state. */
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { getDataDir } from '../../src/config/instance.js';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OwnerAuthService } from '../../src/owner-auth/service.js';
import { OWNER_COOKIE } from '../../src/owner-auth/policy.js';

export async function prepareHttpOwner() {
  if (process.env.VITEST !== 'true') throw new Error('The HTTP owner fixture requires isolated Vitest state');
  const directory = getDataDir();
  const home = homedir();
  const withinHome = relative(home, directory);
  if (!basename(home).startsWith('reverie-vitest-') || isAbsolute(withinHome) || withinHome === '..' || withinHome.startsWith('..' + sep))
    throw new Error('The HTTP owner fixture requires the runner-owned temporary home');
  const credentials = { username: 'http-fixture-owner', password: 'Synthetic-only-owner!82-orbit' };
  const store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  const service = new OwnerAuthService({
    store,
    auditFile: join(directory, 'owner-auth-audit.jsonl'),
    setupEnabled: true,
  });
  const existing = store.read();
  if (existing && existing.username !== credentials.username) throw new Error('Unexpected pre-existing fixture owner');
  if (!existing) await service.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
  return async (origin: string) => {
    const endpoint = new URL(origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'http:' || !endpoint.port)
      throw new Error('The HTTP owner fixture requires an explicit loopback server port');
    const response = await fetch(`${origin}/api/owner/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(credentials),
    });
    if (!response.ok) throw new Error(`Fixture owner login failed: ${response.status}`);
    const cookie = response.headers.getSetCookie().find((item) => item.startsWith(OWNER_COOKIE + '='))?.split(';')[0];
    if (!cookie) throw new Error('Fixture owner login returned no owner cookie');
    return (url: Parameters<typeof fetch>[0], options: RequestInit = {}) => {
      const target = url instanceof Request ? url.url : String(url);
      if (new URL(target).origin !== endpoint.origin) throw new Error('Fixture credentials cannot leave the owned server');
      const headers = new Headers(options.headers);
      headers.set('cookie', cookie);
      headers.set('origin', origin);
      return fetch(url, { ...options, headers });
    };
  };
}
