import {it,expect,vi} from 'vitest';
import {Session} from '../src/session.js';
import {typeAndSubmit} from '../src/submit-settle.js';

it('invariant: a plan-move capacity hold forbids the pending retry Enter after text settled',async()=>{
 vi.useFakeTimers();
 const footer='  gpt-6.1-sol high · /owned/fixture';
 let screen=`› earlier request\n■ Selected model is at capacity. Please try a different model.\n›\n${footer}`;
 let held=false,release:(()=>void)|undefined,session:Session;
 const typed=vi.fn(),enterDuringHold=vi.fn();
 const io={capture:()=>screen,typeText:async(text:string)=>{typed(text);screen=`› ${text}\n${footer}`;},
  sleep:async()=>{if(!held){held=true;release=session.pauseCapacityRetry();}},
  sendEnter:async()=>{if(held)enterDuringHold();screen=`• Working (esc to interrupt)\n›\n${footer}`;}};
 const mux={capturePaneText:()=>screen,sendInput:async(_id:string,input:string,options:{requireEmptyComposer?:boolean})=>
  (await typeAndSubmit(io,input.replace(/\r/g,''),{glyph:'›',workingLine:'esc to interrupt'},'owned capacity control',options.requireEmptyComposer))!=='not-written'};
 session=new Session({workingDir:'/tmp',mode:'codex',useMux:true,mux:mux as never,
  muxSession:{muxName:'reverie-owned-review',sessionId:'owned-review',pid:42}as never});
 try{
  const retry=(session as any)._capacityRetry;expect(retry).toBeTruthy();retry.deps.delaysMs=[1];retry.check();
  await vi.advanceTimersByTimeAsync(1);
  expect(typed).toHaveBeenCalledExactlyOnceWith('continue');expect(held).toBe(true);
  expect(enterDuringHold).not.toHaveBeenCalled();
 }finally{release?.();Object.assign(session,{ptyProcess:null,_muxSession:null});await session.stop(false);vi.useRealTimers();}
});
