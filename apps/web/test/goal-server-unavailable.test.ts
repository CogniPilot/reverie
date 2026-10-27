/** Real unconfigured WebServer route setup in an explicit owned scratch fixture. No listen/runtime/private state. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';
import type { CompanyService } from '../src/company-service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { Session } from '../src/session.js';

it('registers all exact Goal endpoints but refuses even a genuine owner with default unavailable auth/custody', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'goal-server-unavailable-'));
  const previous = process.env.REVERIE_DATA_DIR;
  process.env.REVERIE_DATA_DIR = directory;
  let server: WebServer | undefined;
  try {
    const service = new OwnerAuthService({
      store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
      auditFile: join(directory, 'synthetic-audit.jsonl'),
      setupEnabled: true,
    });
    const credentials = { username: 'SYNTHETIC_ONLY_OWNER', password: 'synthetic-Orbit!81-unavailable' };
    await service.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
    server = new WebServer(0, false, true, '127.0.0.1');
    const actual = server as unknown as {
      app: FastifyInstance;
      companyService: CompanyService;
      sessions: Map<string, Session>;
      setupRoutes(): Promise<void>;
    };
    await actual.setupRoutes();
    await actual.app.ready();
    expect(actual.companyService.store.file).toBe(join(directory, 'company.json'));
    const login = await actual.app.inject({
      method: 'POST',
      url: '/api/owner/login',
      headers: { host: 'localhost', origin: 'http://localhost' },
      payload: credentials,
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = 'reverie_owner=' + login.cookies.find((item) => item.name === 'reverie_owner')!.value;
    for (const [method, url] of [
      ['GET', '/api/goals'],
      ['GET', '/api/goals/synthetic'],
      ['GET', '/api/goal-metadata/worker'],
      ['POST', '/api/goals'],
      ['POST', '/api/goals/synthetic/transitions'],
      ['POST', '/api/goals/synthetic/adopt'],
      ['POST', '/api/goals/synthetic/unblock-proofs'],
      ['POST', '/api/goal-grants'],
      ['POST', '/api/goal-grants/synthetic/revoke'],
      ['POST', '/api/goal-unblock-proofs/synthetic/revoke'],
    ] as const) {
      const response = await actual.app.inject({
        method,
        url,
        headers: { host: 'localhost', origin: 'http://localhost', cookie },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(response.statusCode, method + ' ' + url + ': ' + response.body).toBe(403);
    }
    expect(actual.app.server.listening).toBe(false);
    expect(actual.companyService.store.snapshot().goals).toEqual([]);
    const id = '11111111-2222-3333-4444-555555555555';
    actual.sessions.set(id, new Session({ id, workingDir: directory, mode: 'shell', useMux: false }));
    try {
      const health = await actual.app.inject({
        method: 'GET',
        url: `/api/session-health/${id}/metadata`,
        headers: { host: 'localhost', origin: 'http://localhost', cookie },
      });
      expect(health.statusCode, health.body).toBe(503);
      expect(health.body).not.toMatch(/objective|generation|PRIVATE/);
    } finally {
      actual.sessions.delete(id);
    }
  } finally {
    await server?.stop();
    if (previous === undefined) delete process.env.REVERIE_DATA_DIR;
    else process.env.REVERIE_DATA_DIR = previous;
    if (directory.startsWith(join(tmpdir(), 'goal-server-unavailable-')))
      await fs.rm(directory, { recursive: true, force: true });
  }
}, 30000);
