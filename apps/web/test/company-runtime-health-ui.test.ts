/** Real company/member/profile DOM and existing owner restart/WS affordances. */
import {afterEach,expect,it,vi} from 'vitest';
import {createHarness,member,room} from './helpers/chat-app-harness.mjs';
const SID='11111111-1111-4111-8111-111111111111';
const opened:any[]=[];
afterEach(()=>{for(const h of opened.splice(0))h.dom.window.close();vi.restoreAllMocks();});
async function fixture({health='dead',scope='provider',off=false,vacation=false,owner=true}={}){
 const employee={id:'expert',sessionId:SID,name:'Alex',available:true,desiredRunning:!off,onVacation:vacation,runtimeHealth:health,runtimeHealthScope:scope};
 const session={id:SID,name:'Alex',mode:'codex',pid:123,status:'busy',isWorking:true,runtimeHealth:health,runtimeHealthScope:scope,
  ...(['dead','disconnected'].includes(health)?{paneExit:{status:137}}:{})};
 const company={canManage:owner,employees:[employee],settings:{}};
 const h=await createHarness({company,sessions:[session],rooms:[room('r1','Office',[member(SID,'Alex',{working:true})])]});opened.push(h);
 h.app.sessions.set(SID,session);h.app._mobileOverviewState=()=> 'working';h.shell.company=company;
 h.shell.humanSelf={role:owner?'owner':'basic'};h.shell.phoneStatus={self:owner?'owner':'human',canSetOwn:owner};
 const original=h.app._chatApi.bind(h.app),posts:any[]=[];
 h.app._chatApi=async(path:string,options?:any)=>{
  if(path==='/api/company')return{ok:true,data:company};
  if(path==='/api/chatrooms/phone-status')return{ok:true,data:{self:owner?'owner':'human',canSetOwn:owner}};
  if(path.endsWith('/restart')){posts.push({path,...options});return{ok:true,data:{employee,sessionId:SID,recovery:'normal-launch-requested'}};}
  return original(path,options);
 };
 h.shell.renderMembers();return{h,employee,session,posts};
}

it('shows confirmed provider death as red dead status on cards, members and profile despite stale busy',async()=>{
 const{h}=await fixture();await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-health-dead')).toBe(true);expect(card.classList.contains('is-offline')).toBe(false);
 expect(card.querySelector('.ca-company-state[role="status"]').textContent).toBe('Dead pane');
 expect(card.querySelector('.ca-company-state[role="status"]').getAttribute('aria-label')).toContain('agent has exited');
 expect(card.querySelector('.ca-company-state[role="status"]').title).toContain('137');
 const row=h.document.querySelector('.ca-member');expect(row.classList.contains('is-state-dead')).toBe(true);
 expect(row.getAttribute('aria-label')).toContain('dead pane');expect(row.textContent).not.toContain('Working…');
 h.document.querySelector('[aria-label="Edit profile for Alex"]').click();await h.flush();
 expect(h.document.querySelector('.ca-expert-profile .ca-runtime-health.is-dead').textContent).toBe('Dead pane');
});

it('offers the canonical owner restart for a dead pane without requiring stalled recovery or changing intent',async()=>{
 const{h,employee,posts}=await fixture();await h.shell.openCompany();
 const button=h.document.querySelector('.ca-company-person .ca-dead-pane-restart');expect(button.disabled).toBe(false);
 button.click();await h.flush();expect(posts).toHaveLength(0);
 expect(h.document.querySelector('.ca-employee-restart input').closest('label').hidden).toBe(true);
 const accept=h.document.querySelector('.ca-employee-restart .is-primary');expect(accept.disabled).toBe(false);
 accept.click();await h.flush();
 expect(posts).toEqual([{path:'/api/company/employees/expert/restart',method:'POST',body:{}}]);
 expect(employee.desiredRunning).toBe(true);expect(employee.onVacation).toBe(false);
 expect(h.app.toasts.some((toast:any)=>toast.text==='Restart requested for Alex. Reconnecting…')).toBe(true);
 expect(h.app.toasts.some((toast:any)=>toast.text==='Session restarted for Alex.')).toBe(false);
});

it('does not call a worker transport exit provider death or claim that an unknown provider is healthy',async()=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal'});await h.shell.openCompany();
 const badge=h.document.querySelector('.ca-company-state');expect(badge.textContent).toBe('Disconnected');
 expect(badge.title).toContain('not been confirmed');expect(badge.classList.contains('is-dead')).toBe(false);
 session.runtimeHealth='unknown';delete(session as any).paneExit;employee.runtimeHealth='unknown';
 h.shell.syncSessionPresence(SID);await h.flush();
 expect(badge.textContent).toBe('Health unknown');expect(h.document.querySelector('.ca-member').getAttribute('aria-label')).toContain('health unknown');
});

it.each([{off:true},{vacation:true}])('keeps explicit stopped/vacation intent grey and cannot restart implicitly (%j)',async choice=>{
 const{h,employee,posts}=await fixture(choice);await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-offline')).toBe(true);expect(card.classList.contains('is-health-dead')).toBe(false);
 expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();expect(h.shell.presenceOf(member(SID,'Alex'))).toBe('gone');
 await h.shell.openEmployeeRestart(employee);await h.flush();
 expect(h.document.querySelector('.ca-employee-restart .is-primary').disabled).toBe(true);
 expect(h.document.querySelector('.ca-employee-restart [role="alert"]').textContent).toContain('into the office');
 expect(posts).toHaveLength(0);
});

it('updates an already open card when a session becomes dead without keeping stale working or replacing the profile',async()=>{
 const{h,employee,session}=await fixture({health:'unknown'});await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 session.runtimeHealth='dead';session.runtimeHealthScope='provider';(session as any).paneExit={signal:9};employee.runtimeHealth='dead';
 h.shell.syncSessionPresence(SID);await h.flush();
 expect(h.document.querySelector('[data-employee-id="expert"]')).toBe(card);
 expect(card.querySelector('.ca-company-state').textContent).toBe('Dead pane');
 expect(card.querySelector('.ca-dead-pane-restart')).not.toBeNull();
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-dead')).toBe(true);
});

it('reconnects only a bound viewer for a positively healthy provider using the existing websocket protocol',async()=>{
 const{h,employee,posts}=await fixture({health:'healthy'});
 h.app.activeSessionId=SID;h.app._wsSessionId=SID;h.app._wsState='disconnected';
 h.app._connectWs=vi.fn();h.app._onSessionNeedsRefresh=vi.fn(async()=>{});
 await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.querySelector('.ca-company-state').textContent).toBe('Viewer disconnected');
 expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 card.querySelector('.ca-reconnect-viewer').click();
 expect(h.app._connectWs).toHaveBeenCalledExactlyOnceWith(SID);
 expect(h.app._onSessionNeedsRefresh).toHaveBeenCalledExactlyOnceWith({id:SID});expect(posts).toHaveLength(0);
 employee.runtimeHealth='unknown';h.app.sessions.get(SID).runtimeHealth='unknown';
 h.shell.reconnectEmployeeViewer(employee);expect(h.app._connectWs).toHaveBeenCalledTimes(1);
});

it('never exposes restart to an ordinary viewer even when a pane is dead',async()=>{
 const{h,posts}=await fixture({owner:false});await h.shell.openCompany();
 expect(h.document.querySelector('.ca-dead-pane-restart')).toBeNull();expect(posts).toHaveLength(0);
});
