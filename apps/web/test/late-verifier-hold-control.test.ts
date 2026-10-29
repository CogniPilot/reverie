import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { typeAndSubmit } from '../src/submit-settle.js';
const FOOTER='  gpt-6.1-sol high · /owned/fixture';
let session: Session | undefined;
afterEach(async()=>{if(session){Object.assign(session,{ptyProcess:null,_muxSession:null});await session.stop(false);}vi.unstubAllEnvs();vi.useRealTimers();});
it('holds every later capacity Enter after PlanMove pauses during initial confirmation',async()=>{
 vi.useFakeTimers();vi.stubEnv('REVERIE_WORKER_SOCKET','/owned/inert/no-real-socket');
 const keys:string[]=[];let screen=`› earlier request\n■ Selected model is at capacity. Please try a different model.\n›\n${FOOTER}`;let release:(()=>void)|undefined;
 const io={capture:()=>screen,typeText:async(text:string)=>{keys.push(text);screen=`› ${text}\n${FOOTER}`;},sleep:async()=>{if(keys.includes('initialEnter'))release??=session!.pauseCapacityRetry();},sendEnter:async()=>{keys.push('initialEnter');/* initial Enter is ignored; composer retains exact owned text */}};
 const mux={capturePaneText:()=>screen,sendInput:vi.fn(async(_id:string,input:string,options:{requireEmptyComposer?:boolean}={})=>{
  if(input==='\r'){keys.push('lateVerifierEnter');return true;}
  return(await typeAndSubmit(io,input.replace(/\r/g,''),{glyph:'›',workingLine:'esc to interrupt'},'owned-control',options.requireEmptyComposer))!=='not-written';
 })};
 session=new Session({id:'test-session-1',workingDir:'/owned/fixture',mode:'codex',useMux:true,mux:mux as never,muxSession:{muxName:'reverie-owned-review',sessionId:'test-session-1',pid:42}as never});
 const retry=(session as unknown as{_capacityRetry:{deps:{delaysMs:number[]};check():void;paused:boolean}})._capacityRetry;retry.deps.delaysMs=[1,1,1];retry.check();await vi.advanceTimersByTimeAsync(1);
 expect(release).toBeTypeOf('function');expect(retry.paused).toBe(true);expect(keys).toEqual(['continue','initialEnter']);
 // Real Session._verifySubmitted + real SubmitVerifier owns this later timer.
 await vi.advanceTimersByTimeAsync(2100);
 expect(retry.paused).toBe(true);
 expect(keys).toEqual(['continue','initialEnter']); // MUST NOT send an Enter after the hold.
});
