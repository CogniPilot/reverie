import { it, expect } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const A='00000026-002d-4000-8000-00000000003c';
it('owner phone control changes immediately, persists and rolls back refusal',async()=>{
 const h=await createHarness({}); let finish:any; let payload:any;
 h.app._chatApi=async(path:string,opts:any)=>{
  if(!opts)return {ok:true,data:{canSetOwn:true,canSetAgents:true,self:'owner',alertMode:null}};
  payload={path,...opts};return await new Promise(resolve=>{finish=resolve;});
 };
 await h.shell.loadPhoneStatus();
 (h.document.querySelector('.ca-phone-status') as HTMLElement).click();
 expect(h.document.querySelector('.ca-own-alert')?.getAttribute('data-alert-mode')).toBe('vibrate');
 expect(payload).toMatchObject({path:'/api/chatrooms/phone-status/owner',method:'PUT',body:{mode:'vibrate'}});
 finish({ok:false});await h.flush();
 expect(h.document.querySelector('.ca-own-alert')?.getAttribute('data-alert-mode')).toBe('ring');
 (h.document.querySelector('.ca-phone-status') as HTMLElement).click();finish({ok:true,data:{alertMode:{mode:'vibrate',until:Date.now()+3600000}}});await h.flush();
 expect(h.document.querySelector('.ca-own-alert')?.getAttribute('data-alert-mode')).toBe('vibrate');
});
it('owner can click agent mode; member self permission only; no profile click propagation',async()=>{
 const h=await createHarness({sessions:[{id:A,name:'alpha',mode:'codex'}],rooms:[room('r1','General',[member(A,'alpha')])]});
 h.shell.phoneStatus={canSetAgents:true,self:'owner'};h.shell.renderMembers();
 let called:any;h.app._chatApi=async(path:string,opts:any)=>{called={path,...opts};return {ok:true,data:{alertMode:null}};};
 const badge=h.document.querySelector('.ca-member-alert') as HTMLElement;
 expect(badge.getAttribute('role')).toBe('button');badge.click();await h.flush();
 expect(called.path).toBe(`/api/chatrooms/phone-status/${A}`);
 h.shell.phoneStatus={canSetAgents:false,self:'other'};h.shell.renderMembers();
 expect(h.document.querySelector('.ca-member-alert')?.getAttribute('role')).toBeNull();
 h.shell.phoneStatus={canSetAgents:false,self:A};h.shell.renderMembers();
 expect(h.document.querySelector('.ca-member-alert')?.getAttribute('role')).toBe('button');
});
