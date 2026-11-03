import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import { PlanMoveError, type PlanMoves } from '../src/plan-move.js';
import type { AuthPort, AuthSessionRecord } from '../src/web/ports/auth-port.js';
import { planMoveExecutor, type PlanMoveRuntime } from '../src/plan-move-runtime.js';

describe('owner browser plan move API', () => {
  let app: FastifyInstance;
  const moves = { begin: vi.fn(), get: vi.fn(), cancel: vi.fn(), list: vi.fn(), resolve: vi.fn() };
  const headers = { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner' };
  const input = {
    id: 'move',
    employeeId: 'casey',
    sessionId: 'old',
    fromAccount: 'first',
    toAccount: 'second',
    handoff: 'Resume the task.',
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify();
    await app.register(cookie);
    const credentials = new Map<string, AuthSessionRecord>([
      ['owner', { ip: '127.0.0.1', ua: 'test', createdAt: 1, method: 'basic' }],
    ]);
    registerPlanMoveRoutes(app, moves as unknown as PlanMoves, {
      authSessions: credentials as unknown as AuthPort['authSessions'],
    });
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    '/api/plans/moves/force',
    '/api/plans/moves',
    '/api/plans/moves/preview',
    '/api/plans/moves/recent',
    '/api/plans/moves/move/status',
    '/api/plans/moves/move/cancel',
    '/api/plans/moves/move/resolve',
  ])('requires credentials on %s, even with no agent header', async (url) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { host: headers.host, origin: headers.origin },
      payload: input,
    });
    expect(response.statusCode).toBe(403);
    expect(moves.begin).not.toHaveBeenCalled();
    expect(moves.get).not.toHaveBeenCalled();
    expect(moves.cancel).not.toHaveBeenCalled();
  });

  it('returns recent moves only in the authenticated owner scope', async () => {
    moves.list.mockResolvedValue([{ id: 'move', phase: 'recovery-required' }]);
    const response = await app.inject({ method: 'POST', url: '/api/plans/moves/recent', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ id: 'move', phase: 'recovery-required' }]);
    expect(moves.list).toHaveBeenCalledWith(undefined);
  });

  it('refuses the legacy immediate move endpoint and directs owners to expert-approved requests', async () => {
    moves.begin.mockResolvedValue({ id: 'move', phase: 'waiting' });
    const response = await app.inject({ method: 'POST', url: '/api/plans/moves', headers, payload: input });
    expect(response.statusCode).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(moves.begin).not.toHaveBeenCalled();
    expect(response.json().error).toContain('expert');
    expect(response.body).not.toContain(input.handoff);
  });
  it('allows only the owner to force a move through the normal replacement transaction', async () => {
    await app.close(); app = Fastify(); await app.register(cookie);
    const executor = {snapshot: vi.fn(async () => ({sessionId: 'old', name: 'Casey', account: 'first', mode: 'codex', working: true}))} as never;
    const target = vi.fn(async () => 'claude' as const);
    registerPlanMoveRoutes(app, moves as unknown as PlanMoves, {
      authSessions: new Map([['owner', {ip: '127.0.0.1', ua: 'fixture', createdAt: 1, method: 'basic'}]]) as never,
    }, undefined, () => executor, target);
    moves.begin.mockResolvedValue({id: 'move', phase: 'creating'});
    const payload = {id: 'move', employeeId: 'casey', sessionId: 'old', toAccount: 'second', handoff: 'Owner checkpoint.'};
    const result = await app.inject({method: 'POST', url: '/api/plans/moves/force', headers, payload});
    expect(result.statusCode).toBe(202);
    expect(moves.begin).toHaveBeenCalledWith({...payload, fromAccount: 'first', forceBusy: true, targetMode: 'claude'}, undefined, executor);
    moves.begin.mockClear();
    for (const extra of [{'x-reverie-parent-session': 'source'}, {origin: 'https://other.test'}, {cookie: ''}]) {
      expect((await app.inject({method: 'POST', url: '/api/plans/moves/force', headers: {...headers,...extra}, payload})).statusCode).toBe(403);
    }
    expect(moves.begin).not.toHaveBeenCalled();
  });

  it('refuses spoofed agents and cross-site requests before transaction code', async () => {
    for (const extra of [{ 'x-reverie-parent-session': 'claimed-agent' }, { origin: 'https://other.test' }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/plans/moves',
            headers: { ...headers, ...extra },
            payload: input,
          })
        ).statusCode
      ).toBe(403);
    }
    expect(moves.begin).not.toHaveBeenCalled();
  });

  it('returns conflict errors and limits status to the current owner', async () => {
    moves.begin.mockRejectedValue(new PlanMoveError('Refresh stale allocation'));
    expect((await app.inject({ method: 'POST', url: '/api/plans/moves', headers, payload: input })).statusCode).toBe(
      409
    );
    moves.get.mockResolvedValue(undefined);
    expect((await app.inject({ method: 'POST', url: '/api/plans/moves/unknown/status', headers })).statusCode).toBe(
      404
    );
    expect(moves.get).toHaveBeenCalledWith('unknown', undefined);
  });

  it('cancels only a move owned by the signed-in caller', async () => {
    moves.cancel.mockResolvedValue(undefined);
    expect((await app.inject({ method: 'POST', url: '/api/plans/moves/move/cancel', headers })).json()).toEqual({
      success: true,
    });
    expect(moves.cancel).toHaveBeenCalledWith('move', undefined);
  });

  it('previews a valid owned move when General is the only channel, without auditing or launching', async () => {
    await app.close(); app = Fastify(); await app.register(cookie);
    const runtime: PlanMoveRuntime = {
      company: { view: () => ({ employees: [{ id: 'casey', sessionId: 'old' }] }) as never, rebind: vi.fn() },
      plans: { allocations: async () => ({ generatedAt: 1, accounts: [{ id: 'first', sessionIds: ['old'] }] }), account: vi.fn() },
      chat: { rooms: () => [{ id: 'general', name: 'general', members: [] }] as never, post: vi.fn(), auditEntry: vi.fn() },
      sessions: new Map([['old', { name: 'Casey', pid: 1, muxName: 'old', isWorking: false, toState: () => ({ mode: 'codex', codexConfig: { model: 'chosen-model' } }) } as never]]),
      mux: { getSession: vi.fn(), isPaneDead: () => false }, cleanup: vi.fn(), authorized: () => true, request: vi.fn(),
    };
    registerPlanMoveRoutes(app, moves as unknown as PlanMoves, {
      authSessions: new Map([['owner', { ip: '127.0.0.1', ua: 'test', createdAt: 1, method: 'basic' }]]) as unknown as AuthPort['authSessions'],
    }, undefined, () => planMoveExecutor(runtime));
    const response = await app.inject({ method: 'POST', url: '/api/plans/moves/preview', headers, payload: { employeeId: 'casey', sessionId: 'old' } });
    expect(response.statusCode).toBe(200); expect(response.json().data).toMatchObject({ sessionId: 'old', account: 'first' });
    expect(runtime.chat.auditEntry).not.toHaveBeenCalled(); expect(runtime.chat.post).not.toHaveBeenCalled(); expect(runtime.request).not.toHaveBeenCalled();
  });
});


describe('explicit owner recovery endpoint', () => {
  it('uses the authenticated scoped executor and exact target without permitting agent callers', async () => {
    const app = Fastify(); await app.register(cookie);
    const resolve = vi.fn(async () => ({id: 'move', phase: 'completed'}));
    const executor = {} as never;
    registerPlanMoveRoutes(app, {resolve} as unknown as PlanMoves, {
      authSessions: new Map([['owner', {ip: '127.0.0.1', ua: 'test', createdAt: 1, method: 'basic'}]]) as never,
    }, undefined, () => executor);
    const headers = {host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner'};
    const payload = {action: 'adopt-existing', oldSession: 'old', newSession: 'new', toAccount: 'second'};
    const accepted = await app.inject({method: 'POST', url: '/api/plans/moves/move/resolve', headers, payload});
    expect(accepted.statusCode).toBe(200); expect(resolve).toHaveBeenCalledWith('move', payload, undefined, executor);
    resolve.mockClear();
    for (const extra of [{'x-reverie-parent-session': 'agent'}, {origin: 'https://evil.test'}, {cookie: ''}]) {
      expect((await app.inject({method: 'POST', url: '/api/plans/moves/move/resolve', headers: {...headers, ...extra}, payload})).statusCode).toBe(403);
    }
    expect(resolve).not.toHaveBeenCalled(); await app.close();
  });
});

describe('purpose-authenticated delegated recovery routes',()=>{
  async function setup() {
    const app=Fastify(); const moves={get:vi.fn(async()=>({id:'held',employeeId:'expert',oldSession:'old',newSession:'new',toAccount:'plan'})),
      cancel:vi.fn(async(_id,_owner,check)=>{check?.();}),resolve:vi.fn(async()=>({phase:'completed'})),begin:vi.fn(),list:vi.fn()};
    let valid=true; const actor={employeeId:'manager',sessionId:'manager-session',owner:undefined,
      assertCurrent:()=>{if(!valid)throw new PlanMoveError('grant revoked',403);},inspect:vi.fn(()=>({verifyRecovery:vi.fn()}))};
    const auth=vi.fn(async()=>actor);
    registerPlanMoveRoutes(app,moves as any,{authSessions:new Map() as any},undefined,()=>({}) as any,undefined,undefined,undefined,auth);
    const send=(action:string,payload:unknown={employeeId:'expert'},headers={ 'x-reverie-recovery-assertion':'synthetic-proof'})=>
      app.inject({method:'POST',url:'/api/plans/moves/held/'+action,headers,payload});
    return{app,moves,actor,auth,send,revoke:()=>{valid=false;}};
  }
  it('exposes only the named same-owner record and rechecks permission after journal reads',async()=>{
    const f=await setup();try{
      expect((await f.send('status')).statusCode).toBe(200);
      f.moves.get.mockImplementationOnce(async()=>{f.revoke();return{id:'held',employeeId:'expert'} as any;});
      expect((await f.send('status')).statusCode).toBe(403);
      expect(f.moves.resolve).not.toHaveBeenCalled();expect(f.moves.cancel).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });
  it('does not treat raw parent headers or an invalid proof as recovery authority',async()=>{
    const f=await setup();try{
      expect((await f.send('status',{employeeId:'expert'},{'x-reverie-parent-session':'manager-session'} as any)).statusCode).toBe(403);
      f.auth.mockResolvedValueOnce(undefined as any);expect((await f.send('cancel')).statusCode).toBe(403);
      expect(f.moves.cancel).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });
  it('rejects another employee journal and passes exact adoption tuple to native-only executor',async()=>{
    const f=await setup();try{
      expect((await f.send('status',{employeeId:'other'})).statusCode).toBe(404);
      const input={employeeId:'expert',action:'adopt-existing',oldSession:'old',newSession:'new',toAccount:'plan'};
      expect((await f.send('resolve',input)).statusCode).toBe(200);
      expect(f.actor.inspect).toHaveBeenCalledOnce();expect(f.moves.resolve).toHaveBeenCalledWith('held',
        {action:'adopt-existing',oldSession:'old',newSession:'new',toAccount:'plan'},undefined,expect.any(Object));
    }finally{await f.app.close();}
  });
  it('rechecks authority inside asynchronous cancellation and preserves the hold on revocation',async()=>{
    const f=await setup();try{
      f.moves.cancel.mockImplementationOnce(async(_id,_owner,check)=>{f.revoke();check();});
      expect((await f.send('cancel')).statusCode).toBe(403);
    }finally{await f.app.close();}
  });
});
