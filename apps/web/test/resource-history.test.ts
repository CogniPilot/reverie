import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { callerOf, OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { isCapabilityRequest, registerAuthMiddleware } from '../src/web/middleware/auth.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { historyArguments, registerResourceHistoryRoutes } from '../src/resource-history.js';

const QUERY = '/api/resource-history?start=100&end=400&resolution=five-minute';
const BASIC = 'Basic ' + Buffer.from('fixture:synthetic-history-password').toString('base64');

describe('owner-only path-free resource history', () => {
  let app: FastifyInstance, directory: string, owner: OwnerAuthService, token: string;
  let read: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.stubEnv('REVERIE_PASSWORD', 'synthetic-history-password'); vi.stubEnv('REVERIE_USERNAME', 'fixture');
    directory = await mkdtemp(join(await realpath(tmpdir()), 'resource-history-'));
    app = Fastify(); await app.register(cookie);
    owner = new OwnerAuthService({ store: new OwnerAuthStore(join(directory, 'owner.json')), auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
    const ctx = { sessions: new Map() } as unknown as SessionPort;
    registerAuthMiddleware(app, false, '', owner);
    registerOwnerPolicy(app, { service: owner, ctx, isCapabilityRequest: req => isCapabilityRequest(req, ''),
      relations: { known: () => false, related: () => false, coordinated: () => false, upward: () => false, keeper: () => false, admin: () => false } });
    registerOwnerRoutes(app, owner, false);
    read = vi.fn(async () => ({ version: 1, scope: 'shared-host-unattributed-observations', effectAuthority: false, points: [] }));
    registerResourceHistoryRoutes(app, req => callerOf(req, { service: owner, ctx }).kind === 'owner',
      { cli: '/nix/store/synthetic-observations/bin/reverie-resource-history', config: '/owner-selected/config.json' }, read);
    await app.ready();
    const setup = await app.inject({ method: 'POST', url: '/api/owner/setup', headers: { host: 'localhost', origin: 'http://localhost' },
      payload: { username: 'fixture-owner', password: 'Synthetic-History-42!Ocean', confirmation: 'Synthetic-History-42!Ocean' } });
    expect(setup.statusCode).toBe(200); token = OWNER_COOKIE + '=' + setup.cookies.find(c => c.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => { await app.close(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
  it('composes actual normal owner authentication and returns only observations', async () => {
    const result = await app.inject({ url: QUERY, headers: { cookie: token } });
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ config: '/owner-selected/config.json' }), ['--start', '100', '--end', '400', '--resolution', 'five-minute']);
    expect(result.json().effectAuthority).toBe(false);
    for (const headers of [{}, { authorization: BASIC }, { authorization: BASIC, 'x-reverie-parent-session': 'synthetic-member' }, { cookie: 'reverie_owner=invalid' }]) {
      expect([401, 403]).toContain((await app.inject({ url: QUERY, headers })).statusCode);
    }
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('refuses request-selected paths, commands, duplicate values and oversized ranges', async () => {
    for (const suffix of ['&path=/private', '&command=id', '&start=200', '&gpu=../../private', '&resolution=second'])
      expect((await app.inject({ url: QUERY + suffix, headers: { cookie: token } })).statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
    for (const q of [{ start: '0', end: '999999999999' }, { start: true, end: '400' }, { start: ['100'], end: '400' }]) expect(() => historyArguments(q)).toThrow();
  });
  it('bounds concurrency and revokes a pending response after genuine logout', async () => {
    let release!: () => void;
    read.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ version: 1, effectAuthority: false }); }));
    const pending = app.inject({ url: QUERY, headers: { cookie: token } });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect((await app.inject({ url: QUERY, headers: { cookie: token } })).statusCode).toBe(429);
    const logout = await app.inject({ method: 'POST', url: '/api/owner/logout', headers: { host: 'localhost', origin: 'http://localhost', cookie: token } });
    expect(logout.statusCode).toBe(200); release(); expect((await pending).statusCode).toBe(403);
  });
  it('does not leak private CLI diagnostics or claim missing service health', async () => {
    read.mockRejectedValueOnce(new Error('/private/fixture must never reach response'));
    const response = await app.inject({ url: QUERY, headers: { cookie: token } });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('/private');
  });
});
