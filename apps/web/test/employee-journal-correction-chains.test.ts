import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployeeJournalStore, type JournalMessage, type ReadVisibleMessage } from '../src/employee-journal.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true}); });
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'recall-chain-')); dirs.push(dir);
 let now=Date.parse('2026-10-01T00:00:00Z'); let n=0;
 const messages=new Map<string, JournalMessage>();
 const read: ReadVisibleMessage=(room,id)=>messages.get(`${room}/${id}`);
 const file=join(dir,'journal.sqlite'); let store=EmployeeJournalStore.open(file,()=>now);
 const save=(text:string, supersedes?:number[], owner='owner', employee='employee', room='room')=>{
  ++n; now+=3_600_000;
  const turn=`turn-${n}`;
  messages.set(`${room}/${turn}`,{id:turn,roomId:room,at:now,text:`Remember this: ${text}`,fromSelf:false});
  return store.save(owner,employee,{roomId:room,turnId:turn,draft:{text,tags:supersedes?['decision','correction']:['decision'],sources:[{roomId:room,id:turn,quote:text}],...(supersedes?{annotations:{supersedes,reason:'a later correction'}}:{})}},read).entryId;
 };
 return {save, recall:(query:string, owner='owner',employee='employee',room?:string)=>store.recall(owner,employee,query,read,room), restart:()=>{store.close();store=EmployeeJournalStore.open(file,()=>now);}, close:()=>store.close()};
}
it('positive control: eight correction links select the final entry after restart',()=>{
 const f=fixture();try { let latest=f.save('Uniqueeightanchor original statement.');
 for(let i=0;i<8;++i)latest=f.save(`Replacement ${i}.`,[latest]);
 f.restart();expect(f.recall('Uniqueeightanchor')[0]?.entryId).toBe(latest);
 } finally {f.close();}
});
it('nine correction links must not present an intermediate correction as the current answer',()=>{
 const f=fixture();try { let latest=f.save('Uniquenineanchor original statement.');
 for(let i=0;i<9;++i)latest=f.save(`Replacement ${i}.`,[latest]);
 f.restart();const result=f.recall('Uniquenineanchor');
 expect(result[0]?.entryId).toBe(latest);
 } finally {f.close();}
});
it('a replacement lookup never crosses owners even for the same employee id',()=>{
 const f=fixture();try { const root=f.save('Uniqueowneranchor original statement.');
 f.save('Secret other owner replacement.',undefined,'other-owner');
 const correction=f.save('Authorized replacement.',[root]);
 f.restart();expect(f.recall('Uniqueowneranchor').map(e=>e.entryId)).toEqual([correction,root]);
 expect(f.recall('Uniqueowneranchor','other-owner')).toEqual([]);
 }finally{f.close();}
});
it('a newer correction replaces an older branch even when only the original matches',()=>{
 const f=fixture();try { const root=f.save('Uniquebranchanchor original statement.');
 const first=f.save('First revision.',[root]);f.save('Second revision.',[root]);
 const latest=f.save('Latest update of first revision.',[first]);
 f.restart();const result=f.recall('Uniquebranchanchor');
 expect(result[0]?.entryId).toBe(latest);
 }finally{f.close();}
});
