/** Real owner-cookie authentication and file routes, with only synthetic task-owned data. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OwnerAuthService } from '../../src/owner-auth/service.js';
import { bootstrap } from '../../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../../src/owner-auth/routes.js';
import { ownerVerifier } from '../../src/owner-auth/marks.js';
import { OWNER_COOKIE } from '../../src/owner-auth/policy.js';
import { WorkspaceFiles } from '../../src/workspace-files.js';
import { registerWorkspaceFileRoutes } from '../../src/web/routes/workspace-file-routes.js';

export async function workspaceServer(configure?: (app: FastifyInstance) => Promise<void>) {
  const task = await mkdtemp(join(tmpdir(), 'workspace-fixture-'));
  const root = join(task, 'drive');
  await mkdir(root);
  const store = new OwnerAuthStore(join(task, 'owner-auth.json'));
  const password = (await bootstrap(store, 'workspace-owner')).oneTimePassword;
  const service = new OwnerAuthService({ store, auditFile: join(task, 'audit.jsonl') });
  const app = Fastify();
  await app.register(cookie);
  registerOwnerRoutes(app, service, false);
  const verifier = ownerVerifier({ service, ctx: { sessions: new Map() } as never });
  const files = new WorkspaceFiles(
    () => root,
    120_000,
    async () => {
      /* Synthetic fixture authority; production defaults tested separately. */
    }
  );
  registerWorkspaceFileRoutes(app, verifier, files);
  if (configure) await configure(app);
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/owner/login',
    payload: { username: 'workspace-owner', password },
  });
  const restricted = login.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  const changed = await app.inject({
    method: 'POST',
    url: '/api/owner/password',
    cookies: { [OWNER_COOKIE]: restricted },
    payload: { current: password, next: 'Owned-synthetic-fixture-92!' },
  });
  const ownerCookie = changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  await mkdir(join(root, 'Projects'));
  await mkdir(join(root, 'Empty'));
  await writeFile(join(root, 'Projects', 'hello λ.txt'), 'Hello λ\n<img src=x onerror="window.executed=true">\n');
  await writeFile(
    join(root, 'picture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRd0AAAAASUVORK5CYII=',
      'base64'
    )
  );
  return {
    app,
    root,
    task,
    files,
    ownerCookie,
    restricted,
    cookies: { [OWNER_COOKIE]: ownerCookie },
    async close() {
      await app.close();
      await rm(task, { recursive: true, force: true });
    },
  };
}
