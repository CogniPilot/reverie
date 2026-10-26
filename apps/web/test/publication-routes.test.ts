/** Real owner cookies/classification and owned private files; no GitHub or live credential operations. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, readFile, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { callerOf, OWNER_COOKIE, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { PublicationCredentialVault, type PublicationCredentialAudit } from '../src/publication-credentials.js';
import { registerPublicationRoutes, type PublicationEmployee } from '../src/web/routes/publication-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAT = 'ghp_synthetic_private_publication_0123456789';
const NEXT = 'github_pat_synthetic_rotation_9876543210';
const PASSWORD = 'Synthetic!owner-only-publication-482';

describe('owner-managed PAT metadata and self-scoped material', () => {
  let root: string;
  let app: FastifyInstance;
  let vault: PublicationCredentialVault;
  let service: OwnerAuthService;
  let token: string;
  let serviceToken: string;
  let employee: PublicationEmployee;
  let session: { id: string; pid: number | null; owner: undefined; paneExit?: { code: number } };
  let audit: PublicationCredentialAudit[];
  let auditHook: (() => void | Promise<void>) | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(realpathSync(tmpdir()), 'publication-routes-'));
    const store = new OwnerAuthStore(join(root, 'owner-auth.json'));
    const firstPassword = (await bootstrap(store, 'synthetic-owner')).oneTimePassword;
    serviceToken = await issueServiceToken(store, 'synthetic-service');
    service = new OwnerAuthService({ store, auditFile: join(root, 'owner-audit.jsonl') });
    employee = { id: 'employee-one', sessionId: SID, sessionGeneration: 1, desiredRunning: true,
      onVacation: false, permissions: { publicationTokenIds: [] } };
    session = { id: SID, pid: 123, owner: undefined };
    const ctx = { sessions: new Map([[SID, session], [OTHER, { id: OTHER, pid: 456, owner: undefined }]]) } as unknown as SessionPort;
    audit = []; auditHook = undefined;
    vault = new PublicationCredentialVault(join(root, 'vault'), { audit: async row => { audit.push({ ...row }); await auditHook?.(); } });
    app = Fastify(); await app.register(fastifyCookie);
    registerOwnerRoutes(app, service, false);
    registerPublicationRoutes(app, ctx, {
      vault, verifiedOwner: ownerVerifier({ service, ctx }),
      agentSession: request => { const caller = callerOf(request, { service, ctx }); return caller.kind === 'agent' ? caller.session : undefined; },
      company: () => ({ employees: [employee, { id: 'employee-two', sessionId: OTHER, sessionGeneration: 1,
        desiredRunning: true, onVacation: false, permissions: { publicationTokenIds: [] } }] }),
    });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: 'synthetic-owner', password: firstPassword } });
    const changed = await app.inject({ method: 'POST', url: '/api/owner/password', cookies: { [OWNER_COOKIE]: login.cookies.find(cookie => cookie.name === OWNER_COOKIE)!.value },
      headers: { origin: 'http://localhost' }, payload: { current: firstPassword, next: PASSWORD } });
    expect(changed.statusCode).toBe(200);
    token = changed.cookies.find(cookie => cookie.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => { vi.restoreAllMocks(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  const owner = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { [OWNER_COOKIE]: token }, headers: { origin: 'http://localhost' } });
  const agent = (method: 'GET' | 'POST', url: string, sid = SID, payload?: object) =>
    app.inject({ method, url, payload, headers: { 'x-reverie-parent-session': sid } });
  const create = async () => {
    const response = await owner('POST', '/api/publication/tokens', { name: 'release', token: PAT, repositories: ['example/project'] });
    expect(response.statusCode).toBe(200); return response.json().data.token as { id: string; name: string };
  };

  it('accepts genuine owner writes and never echoes PATs in metadata, audit or validation errors', async () => {
    const meta = await create();
    const list = await owner('GET', '/api/publication/tokens');
    expect(list.json().data.tokens).toHaveLength(1); expect(list.body).not.toContain(PAT);
    expect(list.headers['cache-control']).toBe('no-store');
    const rotated = await owner('PUT', '/api/publication/tokens/' + meta.id, { token: NEXT });
    expect(rotated.statusCode).toBe(200); expect(rotated.body).not.toContain(PAT); expect(rotated.body).not.toContain(NEXT);
    expect(JSON.stringify(audit)).not.toContain(PAT); expect(JSON.stringify(audit)).not.toContain(NEXT);
    const invalid = await owner('POST', '/api/publication/tokens', { name: 'release-two', token: PAT + '\n' });
    expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain(PAT);
    const malformed = await app.inject({ method: 'POST', url: '/api/publication/tokens', cookies: { [OWNER_COOKIE]: token },
      headers: { 'content-type': 'application/json' }, payload: '{"token":"' + PAT + '" INVALID}' });
    expect(malformed.statusCode).toBe(400); expect(malformed.body).not.toContain(PAT);
    expect((await owner('DELETE', '/api/publication/tokens/' + meta.id)).json().data).toEqual({ id: meta.id, deleted: true });
  });

  it('rejects agent, service, anonymous and owner-cookie-plus-agent-header material impersonation', async () => {
    const meta = await create(); employee.permissions!.publicationTokenIds = [meta.id];
    for (const response of [
      await agent('GET', '/api/publication/tokens'),
      await agent('POST', '/api/publication/tokens', SID, { name: 'forged', token: NEXT }),
      await app.inject({ url: '/api/publication/tokens', headers: { [SERVICE_HEADER]: serviceToken } }),
      await app.inject({ url: '/api/publication/tokens' }),
      await owner('POST', '/api/publication/credentials/' + meta.id + '/material'),
      await app.inject({ method: 'POST', url: '/api/publication/credentials/' + meta.id + '/material', cookies: { [OWNER_COOKIE]: token }, headers: { 'x-reverie-parent-session': SID } }),
      await app.inject({ method: 'POST', url: '/api/publication/credentials/' + meta.id + '/material', headers: { [SERVICE_HEADER]: serviceToken, 'x-reverie-parent-session': SID } }),
    ]) { expect(response.statusCode).toBe(403); expect(response.body).not.toContain(PAT); expect(response.body).not.toContain(NEXT); }
    expect(await vault.metadata(undefined)).toHaveLength(1);
  });

  it('lists only current self grants and deliberately releases raw material with exact binding headers', async () => {
    const meta = await create();
    expect((await agent('GET', '/api/publication/credentials')).json().data.credentials).toEqual([]);
    expect((await agent('POST', '/api/publication/credentials/' + meta.id + '/material')).statusCode).toBe(403);
    employee.permissions!.publicationTokenIds = [meta.id];
    const listed = await agent('GET', '/api/publication/credentials');
    expect(listed.json().data).toMatchObject({ employeeId: employee.id, sessionId: SID, credentials: [{ id: meta.id, name: 'release' }] });
    expect(listed.body).not.toContain(PAT);
    const material = await agent('POST', '/api/publication/credentials/' + meta.id + '/material');
    expect(material.statusCode).toBe(200); expect(material.rawPayload).toEqual(Buffer.from(PAT));
    expect(material.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
      'content-length': String(PAT.length), 'x-reverie-employee-id': employee.id, 'x-reverie-session-id': SID, 'x-reverie-credential-id': meta.id });
    expect((await agent('POST', '/api/publication/credentials/' + meta.id + '/material', OTHER)).statusCode).toBe(403);
    expect((await agent('GET', '/api/publication/credentials', SID.slice(0, 16))).statusCode).toBe(403);
    expect((await agent('POST', '/api/publication/credentials/' + meta.id + '/material', SID, { employeeId: 'employee-two' })).statusCode).toBe(400);
  });

  it.each(['desired-off', 'vacation', 'stopped', 'exited', 'migration'])(
    'refuses %s current employee material without a fallback identity', async mode => {
      const meta = await create(); employee.permissions!.publicationTokenIds = [meta.id];
      if (mode === 'desired-off') employee.desiredRunning = false;
      if (mode === 'vacation') employee.onVacation = true;
      if (mode === 'stopped') session.pid = null;
      if (mode === 'exited') session.paneExit = { code: 0 };
      if (mode === 'migration') employee.bindingMigration = { pending: true };
      expect((await agent('GET', '/api/publication/credentials')).statusCode).toBe(403);
      const response = await agent('POST', '/api/publication/credentials/' + meta.id + '/material');
      expect(response.statusCode).toBe(403); expect(response.body).not.toContain(PAT);
    }
  );

  it('rechecks revocation and generation changes after material IO before releasing bytes', async () => {
    const meta = await create(); employee.permissions!.publicationTokenIds = [meta.id];
    const original = vault.material.bind(vault);
    vi.spyOn(vault, 'material').mockImplementation(async (...args) => {
      const result = await original(...args); employee.permissions!.publicationTokenIds = []; return result;
    });
    const revoked = await agent('POST', '/api/publication/credentials/' + meta.id + '/material');
    expect(revoked.statusCode).toBe(403); expect(revoked.body).not.toContain(PAT);
    vi.restoreAllMocks(); employee.permissions!.publicationTokenIds = [meta.id];
    vi.spyOn(vault, 'material').mockImplementation(async (...args) => {
      const result = await original(...args); employee.sessionGeneration = 2; return result;
    });
    const moved = await agent('POST', '/api/publication/credentials/' + meta.id + '/material');
    expect(moved.statusCode).toBe(403); expect(moved.body).not.toContain(PAT);
  });

  it('filters revoked list entries and denies a changed employee binding after metadata IO', async () => {
    const meta = await create(); employee.permissions!.publicationTokenIds = [meta.id];
    const original = vault.metadata.bind(vault);
    vi.spyOn(vault, 'metadata').mockImplementation(async owner => {
      const result = await original(owner); employee.permissions!.publicationTokenIds = []; return result;
    });
    expect((await agent('GET', '/api/publication/credentials')).json().data.credentials).toEqual([]);
    vi.restoreAllMocks(); employee.permissions!.publicationTokenIds = [meta.id];
    vi.spyOn(vault, 'metadata').mockImplementation(async owner => {
      const result = await original(owner); employee.sessionId = OTHER; return result;
    });
    expect((await agent('GET', '/api/publication/credentials')).statusCode).toBe(403);
  });

  it('does not commit a credential when current owner authority disappears during audit', async () => {
    auditHook = () => service.logout(token);
    const result = await owner('POST', '/api/publication/tokens', { name: 'release', token: PAT });
    expect(result.statusCode).toBe(403); expect(result.body).not.toContain(PAT);
    expect(await vault.metadata(undefined)).toEqual([]);
  });

  it('deletion revokes future material despite stale employee grant IDs and file custody errors stay private', async () => {
    const meta = await create(); employee.permissions!.publicationTokenIds = [meta.id];
    await chmod(join(root, 'vault/tokens.json'), 0o644);
    const invalid = await agent('POST', '/api/publication/credentials/' + meta.id + '/material');
    expect(invalid.statusCode).toBe(503); expect(invalid.body).not.toContain(PAT); expect(invalid.body).not.toContain(root);
    await chmod(join(root, 'vault/tokens.json'), 0o600);
    expect((await readFile(join(root, 'vault/tokens.json'), 'utf8'))).toContain(PAT);
    await owner('DELETE', '/api/publication/tokens/' + meta.id);
    expect((await agent('GET', '/api/publication/credentials')).json().data.credentials).toEqual([]);
    expect((await agent('POST', '/api/publication/credentials/' + meta.id + '/material')).statusCode).toBe(403);
  });
});
