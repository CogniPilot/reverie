/** Test FIRST: the explicit enrollment route is intentionally absent from
 * this checkpoint. Uses only an actual private legacy owner/session; no B
 * connection, nomination, controller or host permission is created. */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { PoolInstallationController, registerPoolInstallationRoutes } from '../src/pool-installation-controller.js';

it('explicitly enrolls only the current legacy owner, preserving the account and granting no installation', async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  const directory = await mkdtemp(join(tmpdir(), 'pool-enrollment-'));
  const store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  const auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  const password = 'Synthetic-pool-enrollment-fixture-42!';
  let token = await auth.setup('fixture-owner', password, password, '127.0.0.1');
  const app = Fastify();
  const controller = new PoolInstallationController(auth, undefined);
  try {
    await store.update((account) => {
      delete account.accountId;
    });
    auth.logout(token);
    token = (await auth.login('fixture-owner', password, '127.0.0.1')).session!;
    const before = JSON.parse(await readFile(store.file, 'utf8'));
    await app.register(cookie);
    registerPoolInstallationRoutes(app, controller);
    const response = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/installation/enroll',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
      payload: { enroll: true },
    });
    expect(response.statusCode).toBe(200);
    const principal = auth.registrationIdentity(token);
    expect(principal.accountId).toMatch(/^[a-f0-9-]{36}$/);
    expect(principal.accountId).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(response.json()).toEqual({ success: true, data: principal });
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual({ ...before, accountId: principal.accountId });
    expect(() => controller.result({} as never, '10000000-0000-4000-8000-000000000001')).toThrow();
  } finally {
    controller.close();
    auth.logout(token);
    await app.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
