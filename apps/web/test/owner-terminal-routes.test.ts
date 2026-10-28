import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerTerminalRoutes } from '../src/web/routes/owner-terminal-routes.js';
import type { OwnerLedgerBridge } from '../src/owner-ledger-bridge.js';
import type { OwnerLaptopTerminalAuthority } from '../src/owner-laptop-terminal-authority.js';
import type { TerminalRequest } from '../src/owner-terminal-runtime.js';
import type { FastifyRequest } from 'fastify';

const employee = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let directory: string, app: FastifyInstance, auth: OfficeAuthService, token: string, oneTimePassword: string;
const headers = (value = token) => ({host: 'localhost', origin: 'http://localhost', ...(value ? {cookie: 'reverie_owner='+value} : {})});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'owner-terminal-route-'));
  const store = new OwnerAuthStore(join(directory, 'owner.json'));
  const initial = await bootstrap(store, 'fixture-owner', {enforce: true});
  oneTimePassword = initial.oneTimePassword;
  auth = new OfficeAuthService({store, auditFile: join(directory, 'audit.jsonl')});
  app = Fastify(); await app.register(cookie); await app.register(websocket);
  registerOwnerRoutes(app, auth, false);
});
afterEach(async () => { await app.close(); await rm(directory, {recursive: true, force: true}); });
async function register(runtime = false) {
  // A controlled final bridge port only. Owner authentication is the actual
  // store/service; H process acceptance is covered separately, not claimed here.
  const issue = vi.fn(async (..._args: unknown[]) => ({shellId: '11111111-1111-4111-8111-111111111111',
    authorizationRef: '22222222-2222-4222-8222-222222222222', expiresAtEpochMs: Date.now()+30000}));
  const ctx = {sessions: new Map()};
  registerOwnerTerminalRoutes(app, ownerVerifier({service: auth, ctx}), (_req, id) => id === employee, auth,
    runtime ? {authority: {shutdown: vi.fn()} as unknown as OwnerLaptopTerminalAuthority<FastifyRequest & TerminalRequest>,
      bridge: {issue, close: vi.fn()} as unknown as OwnerLedgerBridge<FastifyRequest & TerminalRequest>} : undefined);
  const login = await app.inject({method: 'POST', url: '/api/owner/login', headers: headers(''),
    payload: {username: 'fixture-owner', password: oneTimePassword}});
  token = login.cookies.find(row => row.name === 'reverie_owner')!.value;
  const changed = await app.inject({method: 'POST', url: '/api/owner/password', headers: headers(),
    payload: {current: oneTimePassword, next: 'Synthetic-owner-terminal-only-42!'}});
  expect(changed.statusCode).toBe(200);
  token = changed.cookies.find(row => row.name === 'reverie_owner')!.value;
  return issue;
}
const request = (extra: Record<string, string> = {}, body: unknown = {cols: 80, rows: 24}) => app.inject({method: 'POST',
  url: '/api/company/employees/'+employee+'/human-terminal', headers: {...headers(), ...extra}, payload: body as object});

it('stays unavailable without an installed protected channel even for a genuine current owner', async () => {
  await register(); const result = await request(); expect(result.statusCode).toBe(503);
});
it('rejects anonymous, agent/service headers, cross-origin and logged-out sessions before bridge access', async () => {
  const issue = await register(true);
  for (const changed of [{cookie:''}, {'x-reverie-parent-session':employee}, {'x-reverie-service-token':'fixture'},
    {origin:'https://foreign.test'}]) expect((await request(changed)).statusCode).toBe(403);
  auth.logout(token); expect((await request()).statusCode).toBe(403); expect(issue).not.toHaveBeenCalled();
});
it('passes only the real request, fixed employee and bounded dimensions; rejects command and identity fields', async () => {
  const issue = await register(true);
  for (const extra of [{command:'id'}, {sessionId:employee}, {owner:true}, {cols:301}])
    expect((await request({}, {cols:80,rows:24,...extra})).statusCode).toBe(400);
  const response = await request(); expect(response.statusCode).toBe(200);
  expect(Object.keys(response.json().data).sort()).toEqual(['authorizationRef','expiresAtEpochMs','shellId']);
  expect(issue).toHaveBeenCalledOnce(); expect(issue.mock.calls[0]?.slice(1)).toEqual([employee,80,24,300]);
});
