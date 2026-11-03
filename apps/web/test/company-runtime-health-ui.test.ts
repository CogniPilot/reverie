/** Real company/member/profile DOM and existing owner restart/WS affordances. */
import {afterEach,expect,it,vi} from 'vitest';
import {createHarness,member,room} from './helpers/chat-app-harness.mjs';
const SID='11111111-1111-4111-8111-111111111111';
const opened:any[]=[];
afterEach(()=>{for(const h of opened.splice(0))h.dom.window.close();vi.restoreAllMocks();});
async function fixture({health='dead',scope='provider',off=false,vacation=false,owner=true,working=true}={}){
 const employee={id:'expert',sessionId:SID,name:'Alex',available:true,desiredRunning:!off,onVacation:vacation,runtimeHealth:health,runtimeHealthScope:scope};
 const session={id:SID,name:'Alex',mode:'codex',pid:123,status:working?'busy':'idle',isWorking:working,runtimeHealth:health,runtimeHealthScope:scope,
  ...(['dead','disconnected'].includes(health)?{paneExit:{status:137}}:{})};
 const company={canManage:owner,employees:[employee],settings:{}};
 const h=await createHarness({company,sessions:[session],rooms:[room('r1','Office',[member(SID,'Alex',{working})])]});opened.push(h);
 h.app.sessions.set(SID,session);h.app._mobileOverviewState=()=> working?'working':'idle';h.shell.company=company;
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
 const badge=h.document.querySelector('.ca-company-state');expect(badge.textContent).toBe('Viewer unavailable');
 expect(badge.title).toContain('unconfirmed');expect(badge.classList.contains('is-dead')).toBe(false);
 session.runtimeHealth='unknown';delete(session as any).paneExit;employee.runtimeHealth='unknown';
 h.shell.syncSessionPresence(SID);await h.flush();
 expect(badge.textContent).toBe('Connected');expect(badge.title).toContain('Agent health has not been confirmed');
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-working')).toBe(true);
});

it.each([true,false])('keeps known transport presence and existing activity when provider health is unknown (working=%s)',async working=>{
 const{h,employee,session,posts}=await fixture({health:'unknown',scope:'terminal',working});await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 const badge=card.querySelector('.ca-company-state');
 expect(badge.textContent).toBe('Connected');expect(badge.title).toContain('Agent health has not been confirmed');
 expect(h.shell.presenceOf(member(SID,'Alex',{working}))).toBe(working?'working':'idle');
 expect(h.document.querySelector('.ca-member').classList.contains(`is-state-${working?'working':'idle'}`)).toBe(true);
 expect(card.textContent).not.toContain('Health unknown');expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 expect(employee.runtimeHealth).toBe('unknown');expect(session.runtimeHealth).toBe('unknown');expect(posts).toHaveLength(0);
});

it('retains the unknown diagnostic when neither session nor member nor company reports transport presence',async()=>{
 const{h,employee}=await fixture({health:'unknown'});
 delete (employee as any).available;h.app.sessions.delete(SID);
 const state=h.shell.employeeHealth(employee);
 expect(state.state).toBe('unknown');expect(state.label).toBe('Health unknown');
 expect(state.detail).toContain('not been confirmed');
 await h.shell.openCompany();expect(h.document.querySelector('.ca-company-state').textContent).toBe('Health unknown');
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
 expect(card.querySelector('.ca-company-state').textContent).toBe('Viewer unavailable');
 expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 card.querySelector('.ca-reconnect-viewer').click();
 expect(h.app._connectWs).toHaveBeenCalledExactlyOnceWith(SID);
 expect(h.app._onSessionNeedsRefresh).toHaveBeenCalledExactlyOnceWith({id:SID});expect(posts).toHaveLength(0);
 // Browser-only repair requires evidence that the server viewer is connected.
 employee.runtimeHealth='unknown';Object.assign(h.app.sessions.get(SID),{runtimeHealth:'unknown',viewerHealth:'unknown',pid:null});
 h.shell.reconnectEmployeeViewer(employee);expect(h.app._connectWs).toHaveBeenCalledTimes(1);
});

it('never exposes restart to an ordinary viewer even when a pane is dead',async()=>{
 const{h,posts}=await fixture({owner:false});await h.shell.openCompany();
 expect(h.document.querySelector('.ca-dead-pane-restart')).toBeNull();expect(posts).toHaveLength(0);
});


it.each([
 {health:'unknown',missingSession:false},
 {health:'unknown',missingSession:true},
 {health:undefined,missingSession:true},
])('keeps unavailable, unconfirmed employees grey and editable (%j)',async({health,missingSession})=>{
 const{h,employee,session,posts}=await fixture({health:'unknown'});
 employee.available=false;
 if(health===undefined){delete (employee as any).runtimeHealth;delete (session as any).runtimeHealth;}
 if(missingSession)h.app.sessions.delete(SID);
 await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-offline')).toBe(true);
 expect(card.classList.contains('is-health-dead')).toBe(false);
 expect(card.classList.contains('is-health-disconnected')).toBe(false);
 expect(card.querySelector('.ca-company-state').textContent).toBe('Offline');
 expect(card.querySelector('.ca-company-state').title).toContain('health has not been confirmed');
 expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 card.querySelector('[aria-label="Edit profile for Alex"]').click();await h.flush();
 expect(h.document.querySelector('.ca-expert-profile').getAttribute('aria-label')).toBe('Edit profile: Alex');
 expect(employee.desiredRunning).toBe(true);expect(employee.onVacation).toBe(false);expect(posts).toHaveLength(0);
});

it.each([
 {health:'dead',scope:'provider',label:'Dead pane'},
 {health:'disconnected',scope:'terminal',label:'Viewer unavailable'},
])('keeps provider death red and viewer loss separate even when the employee is unavailable (%j)',async({health,scope,label})=>{
 const{h,employee,posts}=await fixture({health,scope});employee.available=false;
 await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-offline')).toBe(false);
 expect(card.classList.contains(`is-health-${scope==='terminal'?'viewer-unavailable':health}`)).toBe(true);
 if(scope==='terminal')expect(card.classList.contains('is-health-dead')).toBe(false);
 expect(card.querySelector('.ca-company-state').textContent).toBe(label);
 expect(!!card.querySelector('.ca-dead-pane-restart')).toBe(scope==='provider');expect(posts).toHaveLength(0);
});

it('offers a neutral owner Reconnect for viewer failure and sends only the current binding once',async()=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal'});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 let finish!:(value:any)=>void;const reconnects:any[]=[];const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:any)=>{
  if(path.endsWith('/reconnect')){reconnects.push({path,...options});return new Promise(resolve=>{finish=resolve;});}
  return original(path,options);
 };
 h.shell.renderMembers();await h.shell.openCompany();
 const button=h.document.querySelector('.ca-company-person .ca-reconnect-viewer');
 expect(button).not.toBeNull();expect(button.classList.contains('is-danger')).toBe(false);
 expect(h.document.querySelector('.ca-member-with-actions .ca-reconnect-viewer')).not.toBeNull();
 expect(h.document.querySelector('.ca-company-person .ca-dead-pane-restart')).toBeNull();
 button.click();button.click();await h.flush();
 expect(reconnects).toEqual([{path:'/api/company/employees/expert/reconnect',method:'POST',body:{sessionId:SID,sessionGeneration:2}}]);
 expect(posts).toHaveLength(0);expect(employee.desiredRunning).toBe(true);
 finish({ok:true,data:{state:'viewer-connected'}});await h.flush();
 // An HTTP acknowledgement cannot manufacture the canonical reconnect observation.
 expect(h.document.querySelector('.ca-company-state').textContent).toBe('Viewer unavailable');
 expect(h.app.toasts.some((t:any)=>t.text==='Terminal reconnected for Alex.')).toBe(true);
});

it.each([{off:true},{vacation:true},{owner:false}])('offers no worker reconnect that could bypass %j',async choice=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal',...choice});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 h.shell.renderMembers();await h.shell.openCompany();
 expect(h.document.querySelector('.ca-reconnect-viewer')).toBeNull();expect(posts).toHaveLength(0);
});

it('keeps an unknown reconnect acknowledgement unconfirmed and does not automatically resend',async()=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal'});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 const original=h.app._chatApi.bind(h.app);let calls=0;
 h.app._chatApi=async(path:string,options:any)=>{
  if(path.endsWith('/reconnect')){calls++;return{ok:false};}return original(path,options);
 };
 await h.shell.openCompany();h.document.querySelector('.ca-company-person .ca-reconnect-viewer').click();await h.flush(80);
 expect(calls).toBe(1);expect(h.document.querySelector('.ca-company-state').textContent).toBe('Viewer unavailable');
 expect(h.app.toasts.at(-1).text).toContain('Connection not confirmed');
 expect(h.app.toasts.some((t:any)=>t.text.includes('Terminal reconnected'))).toBe(false);
});

function nativeProof(employee:any,state='healthy',extra={}){
 return {binding:JSON.stringify([employee.id,employee.owner,employee.sessionId,employee.sessionGeneration??1,employee.desiredRunning,employee.onVacation,employee.bindingMigration,employee.runtimeRecipe,employee.permissions],(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value),employeeId:employee.id,sessionId:employee.sessionId,sessionGeneration:employee.sessionGeneration??1,
  state,observedAtEpochMs:Date.now(),reason:state==='healthy'?'LIVE_NATIVE_COMMAND':'COMMAND_EXITED',...extra};
}
it('keeps a native-confirmed agent Online when its optional viewer is unavailable, without clearing the viewer or input hold',async()=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true,providerHealth:nativeProof(employee)});
 Object.assign(session,{pid:null,providerHealth:employee.providerHealth,viewerHealth:'disconnected',workerViewerReconnect:true});
 for(const m of h.shell.room.members)m.alive=false;
 await h.shell.openCompany();h.shell.renderMembers();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-offline')).toBe(false);expect(card.querySelector('.ca-company-state').textContent).toContain('Online');
 expect(card.querySelector('.ca-viewer-warning').textContent).toBe('Viewer unavailable');expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 expect(card.querySelector('.ca-reconnect-viewer')).not.toBeNull();
 const member=h.document.querySelector(`[data-key="member:${SID}"]`);expect(member.classList.contains('is-online')).toBe(true);expect(member.classList.contains('is-offline')).toBe(false);
 expect(h.document.querySelector('.ca-members').textContent).toContain('Online — 1');expect(h.document.querySelector('.ca-head-members').title).toContain('1 online');
 expect(session.runtimeHealth).toBe('disconnected');expect((session as any).paneExit).toEqual({status:137});expect(session.pid).toBeNull();expect(posts).toHaveLength(0);
 h.shell.openProfile(h.shell.room.members[0],member);await h.flush();expect(h.document.querySelector('.ca-profile .ca-runtime-health').textContent).toContain('Online');
});
it('keeps viewer-only loss neutral and unconfirmed rather than classifying the employee Offline or Online',async()=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true});Object.assign(session,{pid:null,workerViewerReconnect:true});
 for(const m of h.shell.room.members)m.alive=false;
 h.shell.renderMembers();await h.shell.openCompany();
 const row=h.document.querySelector(`[data-key="member:${SID}"]`);expect(row.classList.contains('is-offline')).toBe(false);expect(row.classList.contains('is-state-viewer-unavailable')).toBe(true);
 expect(row.textContent).toContain('agent availability unknown');expect(h.document.querySelector('.ca-members').textContent).toContain('Availability unknown — 1');
 expect(h.document.querySelector('.ca-head-members').title).toContain('0 online');expect(h.document.querySelector('.ca-company-state').textContent).toBe('Viewer unavailable');
});
it.each(['expired','future','wrong-generation'] as const)('does not use %s provider metadata to mark a detached agent Online',async change=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal',working:false});Object.assign(employee,{sessionGeneration:1});
 const proof=nativeProof(employee,'healthy',change==='expired'?{observedAtEpochMs:Date.now()-25001}:change==='future'?{observedAtEpochMs:Date.now()+60_000}:{sessionGeneration:2});
 Object.assign(employee,{providerHealth:proof});Object.assign(session,{providerHealth:proof,pid:null});
 await h.shell.openCompany();expect(h.document.querySelector('.ca-company-state').textContent).toBe('Viewer unavailable');expect(h.document.querySelector('.ca-company-state').textContent).not.toContain('Online');
});
it('keeps native-confirmed command death red even while the old viewer says it is busy',async()=>{
 const{h,employee,session}=await fixture({health:'unknown',scope:'terminal'});Object.assign(employee,{sessionGeneration:1,providerHealth:nativeProof(employee,'dead')});
 Object.assign(session,{providerHealth:employee.providerHealth});await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');expect(card.classList.contains('is-health-dead')).toBe(true);expect(card.querySelector('.ca-company-state').textContent).toBe('Agent runtime stopped');
 expect(h.shell.presenceOf(member(SID,'Alex',{working:true}))).toBe('dead');
});
it.each([{off:true},{vacation:true}])('never lets positive native metadata override owner choice %j',async choice=>{
 const{h,employee,session}=await fixture({...choice,health:'disconnected',scope:'terminal'});Object.assign(employee,{sessionGeneration:1,providerHealth:nativeProof(employee)});Object.assign(session,{providerHealth:employee.providerHealth});
 await h.shell.openCompany();expect(h.document.querySelector('[data-employee-id="expert"]').classList.contains('is-offline')).toBe(true);expect(h.document.querySelector('.ca-company-state').textContent).not.toContain('Online');
});

it('uses canonical server Reconnect when browser loss and a held server viewer occur together',async()=>{
 const{h,employee,session}=await fixture({health:'unknown',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true,providerHealth:nativeProof(employee)});
 Object.assign(session,{providerHealth:employee.providerHealth,viewerHealth:'disconnected',viewerInputHeld:true,workerViewerReconnect:true});
 h.app.activeSessionId=SID;h.app._wsSessionId=SID;h.app._wsState='disconnected';h.app._connectWs=vi.fn();
 const calls:any[]=[];const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:any)=>{if(path.endsWith('/reconnect')){calls.push({path,...options});return{ok:true,data:{state:'viewer-connected'}};}return original(path,options);};
 await h.shell.openCompany();const button=h.document.querySelector('.ca-company-person .ca-reconnect-viewer');
 expect(button.title).toBe('Reconnect');expect(button.getAttribute('aria-label')).toBe('Reconnect');expect(button.querySelector('svg')).not.toBeNull();
 button.click();await h.flush();expect(calls).toHaveLength(1);expect(h.app._connectWs).not.toHaveBeenCalled();
 expect((session as any).viewerInputHeld).toBe(true);expect(h.document.querySelector('.ca-viewer-warning')).not.toBeNull();
});
it('updates member warning and Reconnect through schedulePresence without changing Online or replacing buttons on timestamp refresh',async()=>{
 const{h,employee,session}=await fixture({health:'unknown',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true,providerHealth:nativeProof(employee)});
 Object.assign(session,{providerHealth:employee.providerHealth,viewerHealth:'connected',workerViewerReconnect:true});
 h.shell.renderMembers();h.shell._presenceSig=h.shell.presenceSignature();
 expect(h.document.querySelector('.ca-member-with-actions .ca-reconnect-viewer')).toBeNull();
 (session as any).viewerHealth='disconnected';h.shell.schedulePresence();await h.flush(60);
 const reconnect=h.document.querySelector('.ca-member-with-actions .ca-reconnect-viewer');expect(reconnect).not.toBeNull();
 expect(h.document.querySelector('.ca-member .ca-viewer-warning')).not.toBeNull();expect(h.shell.presenceOf(h.shell.room.members[0])).toBe('idle');
 (session as any).providerHealth={...employee.providerHealth,observedAtEpochMs:Date.now()};h.shell.schedulePresence();await h.flush(60);
 expect(h.document.querySelector('.ca-member-with-actions .ca-reconnect-viewer')).toBe(reconnect);
 (session as any).viewerHealth='connected';h.shell.schedulePresence();await h.flush(60);
 expect(h.document.querySelector('.ca-member-with-actions .ca-reconnect-viewer')).toBeNull();expect(h.document.querySelector('.ca-member .ca-viewer-warning')).toBeNull();
});
it.each(['move','owner','generation','session','recipe','permissions','removed'] as const)('invalidates stale session and member proof after canonical company %s update',async change=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true,providerHealth:nativeProof(employee)});
 Object.assign(session,{providerHealth:employee.providerHealth,viewerHealth:'disconnected',pid:null,workerViewerReconnect:true});
 for(const member of h.shell.room.members){member.alive=false;member.providerHealth=employee.providerHealth;}
 h.shell.renderMembers();expect(h.document.querySelector('.ca-member').classList.contains('is-online')).toBe(true);
 const current:any={...employee};delete current.providerHealth;
 if(change==='move')current.bindingMigration={state:'moving'};if(change==='owner')current.owner='different';if(change==='generation')current.sessionGeneration++;
 if(change==='session')current.sessionId='22222222-2222-4222-8222-222222222222';if(change==='recipe')current.runtimeRecipe={cwd:'/different'};
 if(change==='permissions')current.permissions={recoverEmployees:true};
 const original=h.app._chatApi.bind(h.app);h.app._chatApi=async(path:string,opts:any)=>path==='/api/company'?{ok:true,data:{canManage:true,employees:change==='removed'?[]:[current],settings:{}}}:original(path,opts);
 await h.shell.loadOwner();h.shell.schedulePresence();await h.flush(60);
 expect(h.shell.presenceOf(h.shell.room.members[0])).not.toBe('idle');expect(h.document.querySelector('.ca-member').classList.contains('is-online')).toBe(false);
 expect((session as any).providerHealth).toBeUndefined();expect(h.shell.room.members[0].providerHealth).toBeUndefined();
 // A delayed old SSE/member event must not resurrect proof after the canonical update.
 (session as any).providerHealth=employee.providerHealth;h.shell.room.members[0].providerHealth=employee.providerHealth;
 h.shell.schedulePresence();await h.flush(60);expect(h.shell.presenceOf(h.shell.room.members[0])).not.toBe('idle');
 if(change==='move')expect(h.shell.employeeHealth(current).label).toBe('Moving');
});

it('does not renew browser proof after repeated snapshots and partial wall-clock rollback',async()=>{
 const {h,employee,session}=await fixture({health:'disconnected',scope:'terminal',working:false});
 let epoch=100000,mono=0;vi.spyOn(h.window.Date,'now').mockImplementation(()=>epoch);vi.spyOn(h.window.performance,'now').mockImplementation(()=>mono);
 Object.assign(employee,{sessionGeneration:1,providerHealth:nativeProof(employee,'healthy',{observedAtEpochMs:epoch})});
 Object.assign(session,{pid:null,providerHealth:employee.providerHealth});
 expect(h.shell.employeeHealth(employee).label).toBe('Online');
 epoch=120000;mono=20000;expect(h.shell.employeeHealth(employee).label).toBe('Online');
 epoch=110000;mono=21000;expect(h.shell.employeeHealth(employee).label).toBe('Online');
 epoch=115000;mono=26000;expect(h.shell.employeeHealth(employee).label).toBe('Viewer unavailable');
});

it('reconnects only the browser when the server viewer is connected even without native health proof',async()=>{
 const {h,employee,session,posts}=await fixture({health:'unknown',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true});Object.assign(session,{viewerHealth:'connected',workerViewerReconnect:true});
 h.app.activeSessionId=SID;h.app._wsSessionId=SID;h.app._wsState='disconnected';h.app._connectWs=vi.fn();h.app._onSessionNeedsRefresh=vi.fn(async()=>{});
 await h.shell.openCompany();h.document.querySelector('.ca-company-person .ca-reconnect-viewer').click();await h.flush();
 expect(h.app._connectWs).toHaveBeenCalledExactlyOnceWith(SID);expect(posts).toHaveLength(0);
 expect(h.server.calls.filter((call:any)=>call.path.endsWith('/reconnect'))).toHaveLength(0);
});
