import {afterEach, expect, it, vi} from 'vitest';
import {Session} from '../src/session.js';
const FOOTER='  gpt-6.1-sol high · /owned/fixture';
let session:Session|undefined;
let release:((value:boolean)=>void)|undefined;
let pending:Promise<boolean>|undefined;
afterEach(async()=>{release?.(false);await pending;if(session){Object.assign(session,{ptyProcess:null,_muxSession:null});await session.stop(false);}vi.useRealTimers();vi.unstubAllEnvs();});
it('a delayed gated Enter cannot spend the claim of a different ordinary write still in flight',async()=>{
 vi.useFakeTimers();vi.stubEnv('REVERIE_WORKER_SOCKET','/owned/inert/no-real-socket');
 let screen=`›\n${FOOTER}`;const calls:string[]=[];
 const mux={capturePaneText:()=>screen,sendInput:vi.fn(async(_id:string,input:string)=>{
  if(input==='wake\r'){calls.push('wakeTextAndInitialEnter');screen=`› wake\n${FOOTER}`;return true;}
  if(input==='ordinary\r'){calls.push('ordinaryWritePending');return await new Promise<boolean>(resolve=>{release=resolve;});}
  if(input==='\r'){calls.push('lateVerifierEnter');return true;}
  throw new Error('Unexpected key shape');
 })};
 session=new Session({id:'test-session-1',workingDir:'/owned/fixture',mode:'codex',useMux:true,mux:mux as never,
  muxSession:{muxName:'reverie-owned-writer',sessionId:'test-session-1',pid:42}as never});
 expect(await session.writeViaMux('wake\r',{requireIdle:true,requireEmptyComposer:true})).toBe(true);
 pending=session.writeViaMux('ordinary\r');
 await Promise.resolve();
 expect(release).toBeTypeOf('function');
 expect((session as unknown as {_muxWritesInFlight:number})._muxWritesInFlight).toBe(1);
 expect(calls).toEqual(['wakeTextAndInitialEnter','ordinaryWritePending']);
 await vi.advanceTimersByTimeAsync(2000);
 expect((session as unknown as {_muxWritesInFlight:number})._muxWritesInFlight).toBe(1);
 expect(calls).toEqual(['wakeTextAndInitialEnter','ordinaryWritePending']);
});
