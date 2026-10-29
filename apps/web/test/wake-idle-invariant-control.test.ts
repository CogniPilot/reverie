import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../src/types.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

it('invariant: idle-only wake refuses when a turn begins during the route prewrite await', async () => {
  const app=Fastify({logger:false});await app.register(fastifyCookie);
  const ctx=createMockRouteContext();
  const mux={capturePaneText:()=> '›\n  gpt-6.1-sol high · /owned/fixture\n? for shortcuts',sendInput:vi.fn(async()=>true)};
  const session=new Session({id:'test-session-1',workingDir:'/tmp',mode:'codex',useMux:true,mux:mux as never,
    muxSession:{muxName:'reverie-owned-review',sessionId:'test-session-1',pid:42} as never});
  ctx.sessions.set(session.id,session as never);
  const remoteWake={hasWakeTarget:vi.fn(async()=>{Object.assign(session,{_isWorking:true,_status:'busy'});return false;})};
  registerSessionRoutes(app,ctx as never,{verifiedOwner:trustedFixtureOwner,remoteWake:remoteWake as never});
  installRouteErrorHandler(app);
  app.addHook('preSerialization',(_req,reply,payload:unknown,done)=>{
    if(payload===null||typeof payload!=='object')return done(null,payload);
    const value=payload as {success?:unknown;errorCode?:unknown};
    if(value.success===false){
      if(reply.statusCode===200&&typeof value.errorCode==='string')reply.code(httpStatusForErrorCode(value.errorCode as ApiErrorCode));
      return done(null,payload);
    }
    if(value.success===true)return done(null,payload);
    return done(null,{success:true,data:payload});
  });
  await app.ready();
  try {
    expect(session.isWorking).toBe(false);
    const response=await app.inject({method:'POST',url:'/api/sessions/test-session-1/input',payload:{input:'wake\r',ifIdle:true,clientId:'review',seq:1}});
    expect(remoteWake.hasWakeTarget).toHaveBeenCalledOnce();
    expect(session.isWorking).toBe(true);
    expect([200,409]).toContain(response.statusCode);
    if(response.statusCode===200)expect(response.json().data?.delivered).toBe(false);
    expect(mux.sendInput).not.toHaveBeenCalled();
  } finally {
    Object.assign(session,{ptyProcess:null,_muxSession:null});await session.stop(false);await app.close();
  }
});
