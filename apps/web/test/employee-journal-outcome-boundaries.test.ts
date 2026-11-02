import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmployeeJournalStore, type JournalAnnotations, type JournalMessage } from '../src/employee-journal.js';
const roots: string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'outcome-boundary-'));roots.push(dir);
 let now=Date.parse('2026-11-01T12:00:00Z'), seq=0;
 const store=EmployeeJournalStore.open(join(dir,'journal.sqlite'),()=>now);
 const messages=new Map<string,JournalMessage>();
 const read=(room:string,id:string)=>messages.get(`${room}/${id}`);
 const save=(text:string,tags=['decision'],annotations?:JournalAnnotations)=>{
  now+=3600000; const id=`turn-${++seq}`;
  messages.set(`room/${id}`,{id,roomId:'room',at:now,text:`Remember this: ${text}`,fromSelf:false});
  return store.save('owner','employee',{roomId:'room',turnId:id,draft:{text,tags,sources:[{roomId:'room',id,quote:text.slice(0,30)}],...(annotations?{annotations}:{})}},read).entryId!;
 };
 return {store,save,read,close:()=>store.close()};
}
describe('promise and outcome boundaries',()=>{
 it('finds a live promise after 500 older promises were closed',()=>{
  const f=fixture();try{
   const ids=Array.from({length:500},(_,i)=>f.save(`I will archive old batch ${i}.`,['promise']));
   for(const id of ids)f.save(`Batch ${id} archived.`,['lesson'],{outcomeOf:{entry:id,status:'done'}});
   const current=f.save('I will send the remaining urgent report.',['promise']);
   const brief=f.store.brief('owner','employee');
   expect(brief.openTotal).toBe(1);expect(brief.open.map(x=>x.entryId)).toEqual([current]);
  }finally{f.close();}
 });
 it('orders and counts an earlier-due promise beyond 500 undated open promises',()=>{
  const f=fixture();try{
   for(let i=0;i<500;i++)f.save(`I will document backlog item ${i}.`,['promise']);
   const urgent=f.save('I will send the urgent owner report.',['promise'],{due:'2026-11-02T12:00:00.000Z'});
   const brief=f.store.brief('owner','employee');
   expect(brief.openTotal).toBe(501);expect(brief.open[0]?.entryId).toBe(urgent);
  }finally{f.close();}
 });
 it('keeps a pulled result correction ahead of the superseded result',()=>{
  const f=fixture();try{
   const decision=f.save('We enable the nightly cleanup policy.');
   const old=f.save('The first execution freed forty gigabytes.',['lesson'],{outcomeOf:{entry:decision,status:'result'}});
   const correction=f.save('Correction: the measurement was only four gigabytes.',['lesson','correction'],{supersedes:[old],reason:'corrected measurement'});
   const result=f.store.recall('owner','employee','enable nightly cleanup policy',f.read);
   expect(result.map(x=>x.entryId)).toEqual([decision,correction]);
  }finally{f.close();}
 });
});
