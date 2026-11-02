import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmployeeJournalStore, type JournalMessage, type JournalAnnotations } from '../src/employee-journal.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
it('labels a room-filtered map state with its room-only scope',()=>{
 const dir=mkdtempSync(join(tmpdir(),'map-scope-'));roots.push(dir);
 let now=Date.parse('2026-11-01T12:00:00Z'),n=0;const messages=new Map<string,JournalMessage>();
 const store=EmployeeJournalStore.open(join(dir,'journal.sqlite'),()=>now);
 const save=(room:string,text:string,tags:string[],annotations?:JournalAnnotations)=>{
  now+=3600000;const id=`t-${++n}`;messages.set(`${room}/${id}`,{id,roomId:room,at:now,text:`Remember this: ${text}`,fromSelf:false});
  return store.save('owner','employee',{roomId:room,turnId:id,draft:{text,tags,sources:[{roomId:room,id,quote:text.slice(0,30)}],...(annotations?{annotations}:{})}},(r,m)=>messages.get(`${r}/${m}`)).entryId!;
 };
 try{
  const promise=save('room-a','I will archive the logs.',['promise']);
  save('room-b','Archived the logs.',['lesson'],{outcomeOf:{entry:promise,status:'done'}});
  const full=store.map('owner','employee').entries.find(x=>x.entryId===promise);
  const filtered=store.map('owner','employee',{roomId:'room-a'}).entries.find(x=>x.entryId===promise);
  expect(full?.state).toBe('done');expect(filtered?.state).toBe('open');
  expect(filtered).toHaveProperty('stateScope','room');
 }finally{store.close();}
});
