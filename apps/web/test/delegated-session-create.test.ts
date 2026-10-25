import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { withDelegatedSessionCreate, withDelegatedSessionStart } from '../src/owner-auth/delegated-session-create.js';

const id = '00000001-0001-4000-8000-000000000001';
const other = '00000002-0002-4000-8000-000000000002';
const payload = { mode: 'claude', workingDir: '/synthetic/project', parentSessionId: id, subscriptionProfileId: 'fixture-account' };
describe('private delegated session-create authority', () => {
  let app: FastifyInstance, handled: number;
  let authorized: boolean;
  let revokeOnParse: boolean;
  let sessions: Map<string, { id: string }>;
  let recordedCandidate: boolean;
  beforeEach(async () => {
    handled = 0; authorized = true; revokeOnParse = false; app = Fastify(); await app.register(cookie);
    sessions = new Map([[id, { id }], [other, { id: other }]]);
    recordedCandidate = false;
    registerOwnerPolicy(app, {
      service: { policy: () => 'enforce', session: () => undefined, service: () => false, audit: vi.fn(), closeEnded() {} } as any,
      ctx: { sessions } as any,
      isCapabilityRequest: () => false,
      relations: { known: () => true, related: (a: string, b: string) => a === b || (recordedCandidate && a === id && b === other), upward: () => false, keeper: () => false, admin: () => false },
    });
    app.addHook('preValidation', async () => { if (revokeOnParse) authorized = false; });
    app.post('/api/sessions', async () => { handled++; return { session: { id: 'child' } }; });
    app.post('/api/sessions/:id/interactive', async () => { handled++; return {}; });
    app.post('/api/settings', async () => { handled++; return {}; });
    await app.ready();
  });
  it('preserves the missing original actor only for one exact approved descendant start', async () => {
    sessions.delete(id); recordedCandidate = true;
    const start = (method = 'POST', url = `/api/sessions/${other}/interactive`, caller = id) => app.inject({ method: method as 'POST', url, headers: { 'x-reverie-parent-session': caller } });
    const scope = <T>(fn: () => Promise<T>) => withDelegatedSessionStart({ sessionId: id, owner: undefined, targetSessionId: other, authorized: () => authorized }, fn);
    expect((await start()).statusCode).toBe(403);
    for (const [method, url, caller] of [
      ['GET', `/api/sessions/${other}/interactive`, id],
      ['POST', '/api/settings', id],
      ['POST', `/api/sessions/${id}/interactive`, id],
      ['POST', `/api/sessions/${other}/interactive`, other],
    ]) expect((await scope(() => start(method, url, caller))).statusCode).not.toBe(200);
    expect(handled).toBe(0);
    await scope(async () => {
      expect((await start()).statusCode).toBe(200);
      expect((await start()).statusCode).toBe(403);
    });
    expect((await start()).statusCode).toBe(403);
    authorized = false;
    expect((await scope(() => start())).statusCode).toBe(403);
    expect(handled).toBe(1);
  });
  afterEach(async () => { await app.close(); });
  const request = (body: any = payload, caller = id, url = '/api/sessions') => app.inject({ method: 'POST', url, headers: { 'x-reverie-parent-session': caller }, payload: body });
  const grant = <T>(fn: () => Promise<T>, owner?: string) => withDelegatedSessionCreate({ sessionId: id, owner, payload, authorized: () => authorized }, fn);

  it('starts only the exact candidate inside a one-use private scope, never through a direct request', async () => {
    const start = (target = other) => app.inject({ method: 'POST', url: `/api/sessions/${target}/interactive`, headers: { 'x-reverie-parent-session': id } });
    const scope = <T>(fn: () => Promise<T>) => withDelegatedSessionStart({ sessionId: id, owner: undefined, targetSessionId: other, authorized: () => authorized }, fn);
    expect((await start()).statusCode).toBe(403);
    // A recorded descendant is required even with the private grant.
    const result = await scope(() => start()); expect(result.statusCode).toBe(403);
    expect((await scope(() => start(id))).statusCode).toBe(403);
    expect(handled).toBe(0);
  });
  it('allows exactly one matching request, preserving direct-request denial before and after', async () => {
    expect((await request()).statusCode).toBe(403);
    await grant(async () => { expect((await request()).statusCode).toBe(200); expect((await request()).statusCode).toBe(403); });
    expect((await request()).statusCode).toBe(403); expect(handled).toBe(1);
  });
  it('rejects changed body, account, parent, caller, owner and route without calling a handler', async () => {
    for (const body of [{ ...payload, subscriptionProfileId: 'different' }, { ...payload, parentSessionId: other }, { ...payload, envOverrides: { PRIVILEGED: 'yes' } }])
      expect((await grant(() => request(body))).statusCode).toBe(403);
    expect((await grant(() => request(payload, other))).statusCode).toBe(403);
    expect((await grant(() => request(), 'different-owner')).statusCode).toBe(403);
    expect((await grant(() => request(payload, id, '/api/settings'))).statusCode).toBe(403);
    expect(handled).toBe(0);
  });
  it('claims only one of two concurrent requests and never grants an unrelated concurrent request', async () => {
    let signal!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const active = grant(async () => { signal(); await held; return Promise.all([request(), request()]); });
    await started; expect((await request()).statusCode).toBe(403); release();
    expect((await active).map(res => res.statusCode).sort()).toEqual([200, 403]); expect(handled).toBe(1);
  });
  it('rechecks revocation at the parsed-body boundary and closes inherited async scopes after return', async () => {
    revokeOnParse = true;
    expect((await grant(() => request())).statusCode).toBe(403); expect(handled).toBe(0);
    authorized = true; revokeOnParse = false;
    let later!: () => void;
    let pending!: Promise<any>;
    await grant(async () => { pending = new Promise<void>(resolve => { later = resolve; }).then(() => request()); });
    later(); expect((await pending).statusCode).toBe(403); expect(handled).toBe(0);
  });
});
