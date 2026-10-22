import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const A='0000002d-0035-4000-8000-000000000047', B='00000038-0043-4000-8000-000000000060';
const opened:any[]=[];afterEach(()=>{for(const h of opened.splice(0))h.dom.window.close();});
async function setup(verified=true){
 const data:any={canManage:true,settings:{ownerName:'Owner'},employees:[{id:'lead',name:'Inspector',icon:'🦊',position:'Security',sessionId:A,available:true,reportsTo:'owner',expertise:['Review']}]};
 const h=await createHarness({sessions:[{id:A,name:'Inspector',mode:'codex'},{id:B,name:'Writer',mode:'codex'}],rooms:[room('r1','Office',[member(A,'Inspector')])],company:data});opened.push(h);
 const previous=h.app._chatApi.bind(h.app);let finish:any;const calls:any[]=[];
 h.app._chatApi=async(path:string,opts:any)=>{
  if(path==='/api/chatrooms/phone-status')return {ok:verified,data:{canSetOwn:verified,canSetAgents:verified,self:'owner'}};
  if(path==='/api/company'&&!opts)return {ok:true,data};
  if(path==='/api/company/employees'){calls.push(opts);return await new Promise(resolve=>{finish=resolve;});}
  return previous(path,opts);
 };
 return {h,data,calls,resolve:(value:any)=>finish(value)};
}
function fill(h:any){
 const doc=h.document;const field=(name:string)=>doc.querySelector(`.ca-company [name="${name}"]`) as HTMLInputElement;
 field('sessionId').value=B;field('sessionId').dispatchEvent(new h.window.Event('change',{bubbles:true}));
 field('icon').value='📜';field('position').value='Flight-stack reviewer';field('expertise').value='Code review, Flight systems';field('reportsTo').value='lead';
 return field;
}
function submit(h:any){h.document.querySelector('.ca-company form').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));}
it('opens Company directly from the sidebar without the legacy settings window',async()=>{
 const {h}=await setup();const link=h.document.querySelector('.ca-company-nav');expect(link?.textContent).toBe('Company');link.click();await h.flush();
 expect(h.document.querySelector('.ca-page .ca-company')).not.toBeNull();expect(h.document.querySelector('dialog.ca-company')).toBeNull();h.document.querySelector('[data-section="people"]').click();expect(h.document.querySelector('.ca-company').textContent).toContain('Inspector');expect(h.document.querySelector('.ca-company form')).not.toBeNull();
 expect(h.document.querySelector('.reverie-company-dialog')).toBeNull();expect(h.document.querySelector('.ca-company-chart').textContent).toContain('Reporting structure');expect(h.document.querySelector('.ca-company-hire').hidden).toBe(true);h.document.querySelector('[aria-label="Hire"]').click();expect(h.document.querySelector('.ca-company-hire').hidden).toBe(false);expect(h.document.querySelector('.ca-company [name="sessionId"]').textContent).toContain('Writer');
 expect(h.document.querySelector('.ca-company [name="sessionId"]').textContent).not.toContain('Inspector');
});
it('uses named session/reporting dropdowns; sends one object and suppresses double submit',async()=>{
 const {h,data,calls,resolve}=await setup();await h.shell.openCompany('people');const fields=fill(h);expect(fields('name').value).toBe('Writer');submit(h);submit(h);
 expect(calls).toHaveLength(1);expect(calls[0]).toEqual({method:'POST',body:{sessionId:B,name:'Writer',icon:'📜',position:'Flight-stack reviewer',expertise:['Code review','Flight systems'],reportsTo:'lead',researchEnabled:false}});
 expect(h.document.querySelector('.ca-company button[type="submit"]').disabled).toBe(true);
 data.employees.push({id:'new-writer',...calls[0].body,available:true});resolve({ok:true,data:{employee:data.employees.at(-1)}});await h.flush();
 expect(h.document.querySelector('.ca-company [role="status"]').textContent).toBe('Hired Writer.');expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(2);
});
it('server refusal preserves form values and shows the real error without adding an employee',async()=>{
 const {h,calls,resolve}=await setup();await h.shell.openCompany('people');const fields=fill(h);submit(h);expect(calls).toHaveLength(1);resolve({ok:false,error:'Owner sign-in required'});await h.flush();
 expect(h.document.querySelector('.ca-company [role="alert"]').textContent).toBe('Owner sign-in required');expect(fields('name').value).toBe('Writer');expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(1);
});
it('unverified owner does not get hiring controls, even if the legacy company response says canManage',async()=>{
 const {h}=await setup(false);await h.shell.openCompany('people');expect(h.document.querySelector('.ca-company form')).toBeNull();expect(h.document.querySelector('.ca-company-signin')).not.toBeNull();
});
it('company helper and real API client serialize hiring payload exactly once',async()=>{
 class App{}const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({success:true,data:{employee:{id:'new'}}})});
 const context={ReverieApp:App,fetch,window:{}};
 runInNewContext(readFileSync(new URL('../src/web/public/api-client.js',import.meta.url),'utf8'),context);
 runInNewContext(readFileSync(new URL('../src/web/public/company-ui.js',import.meta.url),'utf8'),context);
 const app=new App() as any;const body={name:'Writer',expertise:['Review']};await app._companyApi('/employees','POST',body);
 const call=fetch.mock.calls[0];expect(call[0]).toBe('/api/company/employees');expect(JSON.parse(call[1].body)).toEqual(body);expect(typeof JSON.parse(call[1].body)).toBe('object');
});
it('legacy settings Company button delegates to the native surface when chat is mounted',async()=>{
 class App{}runInNewContext(readFileSync(new URL('../src/web/public/company-ui.js',import.meta.url),'utf8'),{ReverieApp:App,window:{}});
 const app=new App() as any;const openCompany=vi.fn();app._chatApp={built:true,openCompany};await app.openCompany();expect(openCompany).toHaveBeenCalledOnce();
});
