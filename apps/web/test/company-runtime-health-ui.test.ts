import { readFileSync } from 'node:fs';
import { encodeDockerProviderPlacement } from '../src/docker-provider-health-placement.js';
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
 expect(card.querySelector('.ca-company-state[role="status"]').textContent).toBe('Agent exited');
 expect(card.classList.contains('is-tone-alert')).toBe(true);
 expect(card.querySelector('.ca-company-reason').textContent).toBe('Process ended (exit 137)');
 expect(card.querySelector('.ca-company-state[role="status"]').getAttribute('aria-label')).toContain('agent has exited');
 expect(card.querySelector('.ca-company-state[role="status"]').title).toContain('137');
 const row=h.document.querySelector('.ca-member');expect(row.classList.contains('is-state-dead')).toBe(true);
 expect(row.getAttribute('aria-label')).toContain('dead pane');expect(row.textContent).not.toContain('Working…');
 h.document.querySelector('[aria-label="Edit profile for Alex"]').click();await h.flush();
 expect(h.document.querySelector('.ca-expert-profile .ca-runtime-health.is-dead').textContent).toBe('Dead pane');
});

it('shows the last boxed recovery check only for the current employee binding', async () => {
 const {h,employee}=await fixture();
 Object.assign(employee,{dockerBinding:{operationId:'original'},sessionGeneration:3});
 const report={employeeId:employee.id,sessionId:SID,sessionGeneration:3,operationId:'original',
  state:'held',code:'DOCKER_CONTINUATION_DESTINATION_STOPPED'};
 h.shell.company.boxedViewRestorations=[report];
 h.shell.renderMembers();
 expect(h.document.querySelector('.ca-member').textContent).toContain('worker container stopped');
 expect(h.document.querySelector('.ca-member').getAttribute('aria-label')).toContain('worker container stopped');
 report.operationId='prior';
 h.shell.renderMembers();
 expect(h.document.querySelector('.ca-member').textContent).not.toContain('worker container stopped');
});

it('puts a held recovery check on the card in plain words and keeps its raw code in the tooltip', async () => {
 const {h,employee}=await fixture();
 Object.assign(employee,{dockerBinding:{operationId:'original'},sessionGeneration:3});
 h.shell.company.boxedViewRestorations=[{employeeId:employee.id,sessionId:SID,sessionGeneration:3,operationId:'original',
  state:'held',code:'DOCKER_CONTINUATION_DESTINATION_STOPPED'}];
 await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]'),reason=card.querySelector('.ca-company-reason');
 expect(card.querySelector('.ca-company-state').textContent).toBe('Agent exited');
 expect(reason.textContent).toBe('Worker container stopped');expect(card.textContent).not.toContain('DOCKER_');
 expect(reason.title).toContain('Last check found the worker container stopped (DOCKER_CONTINUATION_DESTINATION_STOPPED)');
 expect(card.classList.contains('has-status-reason')).toBe(true);
});

it('puts the office supervisor’s reading on the card, with what it will do next in the tooltip', async () => {
 const shown=async(supervisor?:unknown)=>{
  const {h,employee}=await fixture();
  Object.assign(employee,{dockerBinding:{operationId:'original'},sessionGeneration:3,...(supervisor?{supervisor}:{})});
  // The supervisor reads more than the last attach attempt, so its sentence wins over that one.
  h.shell.company.boxedViewRestorations=[{employeeId:employee.id,sessionId:SID,sessionGeneration:3,operationId:'original',
   state:'held',code:'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING'}];
  await h.shell.openCompany();
  const card=h.document.querySelector('[data-employee-id="expert"]');
  return {card,reason:card.querySelector('.ca-company-reason'),controls:card.querySelectorAll('button,a,input,select').length};
 };
 const plain=await shown();
 expect(plain.reason.textContent).toBe('Recovery still pending');
 const next=await shown({condition:'held-needs-rebuild',sentence:"The helper that sets Alex's laptop limits failed.",
  code:'DOCKER_RESOURCE_HELPER_FAILED',next:{action:'rebuild-laptop',at:1}});
 expect(next.reason.textContent).toBe('Laptop held; rebuilding');expect(next.card.textContent).not.toContain('DOCKER_');
 expect(next.reason.title).toContain("The helper that sets Alex's laptop limits failed (DOCKER_RESOURCE_HELPER_FAILED). The office will try “rebuild laptop” next.");
 const needs=await shown({condition:'held-needs-rebuild',sentence:"Alex's laptop container cannot be found.",
  needsHuman:'An agent is running in a laptop of this employee. That needs the owner.'});
 expect(needs.reason.textContent).toBe('Needs you');
 expect(needs.reason.title).toContain("Alex's laptop container cannot be found (held-needs-rebuild). An agent is running in a laptop of this employee. That needs the owner.");
 // A start-up screen is the office's own to clear: the card says what it is doing, and asks for a person only for
 // the one thing it cannot do, signing a plan in.
 const stuck=await shown({condition:'stuck-first-run-screen',sentence:"Alex is stuck at Claude's theme chooser, which the office could not answer.",
  code:'first-run-screen',next:{action:'rebuild-laptop',at:1}});
 expect(stuck.reason.textContent).toBe('Stuck at start-up; restarting');
 const signIn=await shown({condition:'needs-sign-in',sentence:"Alex is waiting at Claude's sign-in screen.",code:'sign-in-screen',
  next:{action:'replace-sign-in',at:1}});
 expect(signIn.reason.textContent).toBe('At a sign-in screen; repairing');
 const signedOut=await shown({condition:'needs-sign-in',sentence:"Alex is waiting at Claude's sign-in screen.",code:'plan-signed-out',
  needsHuman:'The plan “Max” is not signed in at the office. Only the account holder can sign a plan in (Plans).'});
 expect(signedOut.reason.textContent).toBe('Needs a sign-in');
 expect(signedOut.reason.title).toContain('Only the account holder can sign a plan in (Plans).');
 // A sentence and a tooltip only: the card gains no control.
 expect([next.controls,needs.controls]).toEqual([plain.controls,plain.controls]);
 // A healthy reading and a condition this page does not know leave the card as it was.
 expect((await shown({condition:'healthy',sentence:'Alex is running.'})).reason.textContent).toBe('Recovery still pending');
 expect((await shown({condition:'something-new',sentence:'x'})).reason.textContent).toBe('Recovery still pending');
});

it.each([
 {state:'needs',label:'Needs you',why:'Waiting on your answer',tone:'alert'},
 {state:'waiting',label:'Waiting for you',why:'Done; waiting for input',tone:'wait'},
 {state:'working',label:'Working',why:'',tone:'ok'},
 {state:'idle',label:'Idle',why:'',tone:'idle'},
])('names what a connected employee is doing the way the roster does (%j)',async({state,label,why,tone})=>{
 const{h,posts}=await fixture({health:'unknown',scope:'provider',working:false});
 h.app._mobileOverviewState=()=>state;await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]'),reason=card.querySelector('.ca-company-reason');
 expect(card.querySelector('.ca-company-state').textContent).toBe(label);expect(reason.textContent).toBe(why);
 expect(reason.hidden).toBe(!why);expect(card.classList.contains('has-status-reason')).toBe(!!why);
 expect([...card.classList].filter(name=>name.startsWith('is-tone-'))).toEqual([`is-tone-${tone}`]);
 // Nothing is wrong with the session itself, so the card offers no repair.
 expect(card.querySelector('.ca-company-status-actions').hidden).toBe(true);
 expect(card.querySelector('.ca-company-status-actions').children).toHaveLength(0);expect(posts).toHaveLength(0);
});

it('offers the canonical owner restart for a dead pane without requiring stalled recovery or changing intent',async()=>{
 const{h,employee,posts}=await fixture();await h.shell.openCompany();
 const button=h.document.querySelector('.ca-company-person .ca-dead-pane-restart');expect(button.disabled).toBe(false);
 // The card's one next step for a dead agent is this button, named for the employee it restarts.
 expect([...h.document.querySelectorAll('.ca-company-status-actions > button')]).toEqual([button]);
 expect(button.getAttribute('aria-label')).toBe('Restart session for Alex');expect(button.textContent).toBe('Restart');
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
 const badge=h.document.querySelector('.ca-company-state'),reason=h.document.querySelector('.ca-company-reason');
 expect(badge.textContent).toBe('Unknown');expect(reason.textContent).toBe('Terminal viewer lost');
 expect(badge.title).toContain('unconfirmed');expect(badge.classList.contains('is-dead')).toBe(false);
 session.runtimeHealth='unknown';delete(session as any).paneExit;employee.runtimeHealth='unknown';
 h.shell.syncSessionPresence(SID);await h.flush();
 expect(badge.textContent).toBe('Unknown');expect(reason.textContent).toBe('Health not confirmed');
 expect(badge.title).toContain('terminal viewer is connected');
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-unknown')).toBe(true);
});

it.each([true,false])('keeps connected worker transport separate from unknown provider health despite saved activity (working=%s)',async working=>{
 const{h,employee,session,posts}=await fixture({health:'unknown',scope:'terminal',working});await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 const badge=card.querySelector('.ca-company-state');
 expect(badge.textContent).toBe('Unknown');expect(badge.title).toContain('terminal viewer is connected');
 expect(card.querySelector('.ca-company-reason').textContent).toBe('Health not confirmed');
 expect(card.classList.contains('is-tone-unknown')).toBe(true);expect(card.classList.contains('is-tone-ok')).toBe(false);
 expect(badge.classList.contains('is-connected')).toBe(false);expect(card.classList.contains('is-health-unknown')).toBe(true);
 expect(h.shell.presenceOf(member(SID,'Alex',{working}))).toBe('unknown');
 const row=h.document.querySelector('.ca-member');expect(row.classList.contains('is-state-unknown')).toBe(true);
 expect(row.classList.contains('is-online')).toBe(false);expect(row.classList.contains('is-offline')).toBe(false);
 expect(row.textContent).not.toContain('Working…');expect(row.title).toContain('terminal viewer is connected');
 expect(h.document.querySelector('.ca-members').textContent).toContain('Availability unknown — 1');
 expect(h.document.querySelector('.ca-head-members').title).toContain('0 online');
 expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 h.document.querySelector('[aria-label="Edit profile for Alex"]').click();await h.flush();
 expect(h.document.querySelector('.ca-expert-profile .ca-runtime-health.is-unknown').textContent).toBe('Agent health unknown');
 expect(employee.runtimeHealth).toBe('unknown');expect(session.runtimeHealth).toBe('unknown');expect(posts).toHaveLength(0);
});

it.each([true,false])('preserves local provider-scoped transport and activity behavior (working=%s)',async working=>{
 const{h}=await fixture({health:'unknown',scope:'provider',working});await h.shell.openCompany();
 expect(h.document.querySelector('.ca-company-state').textContent).toBe(working?'Working':'Idle');
 expect(h.document.querySelector('.ca-company-state').title).toContain('Agent health has not been confirmed');
 expect(h.document.querySelector('.ca-company-reason').hidden).toBe(true);
 expect(h.shell.presenceOf(member(SID,'Alex',{working}))).toBe(working?'working':'idle');
 expect(h.document.querySelector('.ca-members').textContent).toContain('Online — 1');
});

it('retains the unknown diagnostic when neither session nor member nor company reports transport presence',async()=>{
 const{h,employee}=await fixture({health:'unknown'});
 delete (employee as any).available;h.app.sessions.delete(SID);
 const state=h.shell.employeeHealth(employee);
 expect(state.state).toBe('unknown');expect(state.label).toBe('Health unknown');
 expect(state.detail).toContain('not been confirmed');
 // The roster member still looks busy; the card's own health is the ceiling for its status.
 await h.shell.openCompany();expect(h.document.querySelector('.ca-company-state').textContent).toBe('Unknown');
 expect(h.document.querySelector('.ca-company-reason').textContent).toBe('Health not confirmed');
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
 expect(card.querySelector('.ca-company-state').textContent).toBe('Agent exited');
 expect(card.querySelector('.ca-company-reason').textContent).toBe('Process ended (signal 9)');
 expect(card.querySelector('.ca-company-status-actions > .ca-dead-pane-restart')).not.toBeNull();
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-dead')).toBe(true);
});

it('reconnects only a bound viewer for a positively healthy provider using the existing websocket protocol',async()=>{
 const{h,employee,posts}=await fixture({health:'healthy'});
 h.app.activeSessionId=SID;h.app._wsSessionId=SID;h.app._wsState='disconnected';
 h.app._connectWs=vi.fn();h.app._onSessionNeedsRefresh=vi.fn(async()=>{});
 await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.querySelector('.ca-company-state').textContent).toBe('Unknown');
 expect(card.querySelector('.ca-company-reason').textContent).toBe('Terminal viewer lost');
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
 // "Offline" needs no second line; the title keeps that room and the tooltip keeps the full sentence.
 expect(card.querySelector('.ca-company-reason').hidden).toBe(true);expect(card.classList.contains('has-status-reason')).toBe(false);
 expect(card.classList.contains('is-tone-off')).toBe(true);
 expect(card.querySelector('.ca-company-state').title).toContain('health has not been confirmed');
 expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
 // Waking is the one next step the card offers; nothing is sent until it is pressed.
 expect([...card.querySelectorAll('.ca-company-status-actions > button')].map((b:any)=>b.textContent)).toEqual([]);
 card.querySelector('[aria-label="Edit profile for Alex"]').click();await h.flush();
 expect(h.document.querySelector('.ca-expert-profile').getAttribute('aria-label')).toBe('Edit profile: Alex');
 expect(employee.desiredRunning).toBe(true);expect(employee.onVacation).toBe(false);expect(posts).toHaveLength(0);
});

it.each([
 {health:'dead',scope:'provider',label:'Agent exited',why:'Process ended (exit 137)'},
 {health:'disconnected',scope:'terminal',label:'Unknown',why:'Terminal viewer lost'},
])('keeps provider death red and viewer loss separate even when the employee is unavailable (%j)',async({health,scope,label,why})=>{
 const{h,employee,posts}=await fixture({health,scope});employee.available=false;
 await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-offline')).toBe(false);
 expect(card.classList.contains(`is-health-${scope==='terminal'?'viewer-unavailable':health}`)).toBe(true);
 if(scope==='terminal')expect(card.classList.contains('is-health-dead')).toBe(false);
 expect(card.querySelector('.ca-company-state').textContent).toBe(label);
 expect(card.querySelector('.ca-company-reason').textContent).toBe(why);
 expect(card.classList.contains('is-tone-alert')).toBe(scope==='provider');
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
 // The card offers one next step in one place; the viewer check stays on the roster row.
 expect([...h.document.querySelectorAll('.ca-company-person button:not(.ca-company-profile-trigger)')]).toEqual([button]);
 expect(button.parentElement.className).toBe('ca-company-status-actions');expect(button.textContent).toBe('Reconnect');
 expect(h.document.querySelector('.ca-member-with-actions .ca-viewer-status')).not.toBeNull();
 expect(h.document.querySelector('.ca-member-with-actions .ca-reconnect-viewer')).not.toBeNull();
 expect(h.document.querySelector('.ca-company-person .ca-dead-pane-restart')).toBeNull();
 button.click();button.click();await h.flush();
 expect(reconnects).toEqual([{path:'/api/company/employees/expert/reconnect',method:'POST',body:{sessionId:SID,sessionGeneration:2}}]);
 expect(posts).toHaveLength(0);expect(employee.desiredRunning).toBe(true);
 finish({ok:true,data:{state:'viewer-connected'}});await h.flush();
 // An HTTP acknowledgement cannot manufacture the canonical reconnect observation.
 expect(h.document.querySelector('.ca-company-state').textContent).toBe('Unknown');
 expect(h.document.querySelector('.ca-company-reason').textContent).toBe('Terminal viewer lost');
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
 expect(calls).toBe(1);expect(h.document.querySelector('.ca-company-state').textContent).toBe('Unknown');
 expect(h.document.querySelector('.ca-company-reason').textContent).toBe('Terminal viewer lost');
 expect(h.app.toasts.at(-1).text).toContain('Connection not confirmed');
 expect(h.app.toasts.some((t:any)=>t.text.includes('Terminal reconnected'))).toBe(false);
});

it('does not infer native viewer authority from a title, target permission or company JSON flag',async()=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal',owner:false});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2,position:'CTO',permissions:{recoverEmployees:true}});
 Object.assign(session,{workerViewerReconnect:true});
 h.shell.renderMembers();expect(h.document.querySelector('.ca-reconnect-viewer')).toBeNull();
 h.shell.company.canReconnectViewers=true;h.shell.renderMembers();
 expect(h.document.querySelector('.ca-reconnect-viewer')).toBeNull();
 expect(h.document.querySelector('.ca-dead-pane-restart')).toBeNull();expect(posts).toHaveLength(0);
 h.shell.company.canReconnectViewers=false;h.shell.renderMembers();
 expect(h.document.querySelector('.ca-reconnect-viewer')).toBeNull();
});

it('reads bounded viewer reason/backoff on demand without repairing or changing activity',async()=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal'});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 const calls:any[]=[];const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:any)=>{
  if(path.endsWith('/reconnect/status')){calls.push({path,...options});return{ok:true,data:{reconnect:{state:'blocked',reason:'native-health-unavailable',attempts:2,retryAfterMs:5000}}};}
  return original(path,options);
 };
 await h.shell.openCompany();h.shell.renderMembers();h.document.querySelector('.ca-member-with-actions .ca-viewer-status').click();await h.flush(80);
 expect(calls).toEqual([{path:'/api/company/employees/expert/reconnect/status',method:'POST',body:{sessionId:SID,sessionGeneration:2}}]);
 expect(h.document.querySelector('.ca-viewer-status-report').textContent).toContain('native health is unconfirmed');
 expect(h.document.querySelector('.ca-viewer-status-report').textContent).toContain('Retry the viewer connection in 5s');
 expect(session.isWorking).toBe(true);expect(session.runtimeHealth).toBe('disconnected');
 // The card keeps one short pill and reason; the checked viewer explanation is their tooltip, not more badge text.
 expect(h.document.querySelector('.ca-company-state').textContent).toBe('Unknown');
 const reason=h.document.querySelector('.ca-company-reason');
 expect(reason.textContent).toBe('Terminal viewer lost');expect(reason.title).toContain('native health is unconfirmed');
});

it('shows a refused reconnect status without replaying or treating it as provider health',async()=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal'});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 const calls:any[]=[];const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:any)=>{
  if(path.endsWith('/reconnect')){calls.push({path,...options});return{ok:false,status:409,reconnect:{state:'blocked',reason:'backoff',attempts:3,retryAfterMs:5000}};}
  return original(path,options);
 };
 await h.shell.openCompany();h.document.querySelector('.ca-company-person .ca-reconnect-viewer').click();await h.flush(80);
 expect(calls).toEqual([{path:'/api/company/employees/expert/reconnect',method:'POST',body:{sessionId:SID,sessionGeneration:2}}]);
 expect(h.app.toasts.at(-1).text).toContain('waiting before another reconnect attempt');
 expect(h.app.toasts.at(-1).text).toContain('Retry the viewer connection in 5s');expect(session.runtimeHealth).toBe('disconnected');
 expect(h.app.toasts.at(-1).text).not.toContain('..');
 expect(h.app.toasts.some((t:any)=>t.text.includes('Terminal reconnected'))).toBe(false);
});

it('retains the native-health reason and connection retry delay even after an outer viewer response',async()=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal'});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 const calls:Array<{path:string;method:string;body:unknown}>=[], original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:{method:string;body:unknown})=>{
  if(path.endsWith('/reconnect/status')){calls.push({path,...options});return{ok:true,data:{reconnect:{state:'blocked',
   reason:'native-health-unavailable',observation:'outer-pane-responsive',attempts:2,retryAfterMs:4500}}};}
  return original(path,options);
 };
 await h.shell.openCompany();h.shell.renderMembers();h.document.querySelector('.ca-member-with-actions .ca-viewer-status').click();await h.flush(80);
 const report=h.document.querySelector('.ca-viewer-status-report').textContent;
 expect(report).toContain('native health is unconfirmed');expect(report).toContain('terminal viewer responded');
 expect(report).toContain('Retry the viewer connection in 5s');
 expect(report).not.toMatch(/pressure|provider (?:died|stopped)|native-health-unavailable|attempts 2/);
 expect(calls).toEqual([{path:'/api/company/employees/expert/reconnect/status',method:'POST',body:{sessionId:SID,sessionGeneration:2}}]);
 expect(session.isWorking).toBe(true);expect(session.runtimeHealth).toBe('disconnected');expect(posts).toHaveLength(0);
});

it('keeps every known viewer reason meaningful and unknown pressure-like or prototype keys unconfirmed',async()=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal'});
 const cases:Array<[string,RegExp]>=[
  ['native-health-unavailable',/native health is unconfirmed/],['backoff',/waiting before another reconnect attempt/],
  ['in-progress',/reconnect is already in progress/],['viewer-closing',/viewer is closing/],
  ['lifecycle-in-progress',/session action is already in progress/],['input-in-progress',/input is still being processed/],
  ['move-in-progress',/session move is in progress/],['binding-migration',/moving to another session/],
  ['readiness-unconfirmed',/connection was attempted.*readiness could not be confirmed/],
  ['diagnostic-requested-readiness-unconfirmed-input-held',/inspection was requested.*input remains paused/],
  ['pane-observation-unconfirmed',/viewer could not be checked/],['viewer-subject-changed',/original terminal viewer changed/],
  ['stale-binding',/employee's session changed/],['binding-or-health-changed',/session or native health evidence changed/],
  ['binding-or-authority-changed',/session or your recovery access changed/],['authority-changed',/recovery access changed/],
  ['admission-unavailable',/current session could not be verified/],['server-not-ready',/server is not ready/],
  ['not-running',/employee is not set to run/],['viewer-unavailable',/no current terminal viewer/],
  ['viewer-disconnected',/terminal viewer disconnected again/],
  ['not-attempted',/reconnect has not been attempted/],['viewer-not-disconnected',/not reported a disconnected viewer/],
  ['connected',/viewer connection was confirmed/],['viewer-endpoint-custody-unavailable',/original terminal connection could not be verified/],
  ['viewer-endpoint-configuration-invalid',/viewer configuration is invalid/],
 ];
 for(const[reason,expected]of cases){
  const status=h.shell.viewerReconnectStatus(employee,{state:'blocked',reason,attempts:2,retryAfterMs:0});
  expect(status).not.toBeNull();const description=h.shell.viewerReconnectDescription(status);expect(description).toMatch(expected);
  expect(description).not.toMatch(/blocked:|attempts 2/);
 }
 for(const reason of ['memory-pressure','kernel-pressure-timeout','unknown-native-failure','constructor','__proto__','toString']){
  const status=h.shell.viewerReconnectStatus(employee,{state:'blocked',reason,observation:'outer-pane-responsive',attempts:0,retryAfterMs:0});
  expect(status).not.toBeNull();expect(h.shell.viewerReconnectDescription(status)).toBe('The terminal viewer could not be confirmed. This viewer check does not measure employee or chat readiness.');
 }
 for(const[ms,seconds]of [[1,1],[4500,5],[60000,60]]){
  const status=h.shell.viewerReconnectStatus(employee,{state:'blocked',reason:'backoff',attempts:3,retryAfterMs:ms});
  expect(h.shell.viewerReconnectDescription(status)).toContain(`Retry the viewer connection in ${seconds}s`);
 }
 expect(session.runtimeHealth).toBe('disconnected');expect(session.isWorking).toBe(true);expect(posts).toHaveLength(0);
});

it('does not paint a stale status after the binding or browser permission changes during a read',async()=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal'});
 Object.assign(employee,{workerViewerReconnect:true,sessionGeneration:2});Object.assign(session,{workerViewerReconnect:true});
 let finish!:(value:any)=>void;const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:any)=>path.endsWith('/reconnect/status')?new Promise(resolve=>{finish=resolve;}):original(path,options);
 await h.shell.openCompany();h.shell.renderMembers();h.document.querySelector('.ca-member-with-actions .ca-viewer-status').click();await h.flush();
 h.shell.phoneStatus={self:'human',canSetOwn:false};employee.sessionGeneration=3;
 finish({ok:true,data:{reconnect:{state:'connected',reason:'connected',attempts:1,retryAfterMs:0}}});await h.flush(80);
 expect(h.document.querySelector('.ca-viewer-status-report').textContent).toContain('changed');
 expect(h.document.querySelector('.ca-viewer-status-report').textContent).not.toContain('connected:');
 expect(session.runtimeHealth).toBe('disconnected');
});

function nativeProof(employee:any,state='healthy',extra={}){
 return {binding:JSON.stringify([employee.id,employee.owner,employee.sessionId,employee.sessionGeneration??1,employee.desiredRunning,employee.onVacation,employee.bindingMigration,employee.runtimeRecipe,employee.permissions],(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value),employeeId:employee.id,sessionId:employee.sessionId,sessionGeneration:employee.sessionGeneration??1,
  state,observedAtEpochMs:Date.now(),reason:state==='healthy'?'LIVE_NATIVE_COMMAND':'COMMAND_EXITED',...extra};
}
it('does not turn a viewer-only status check into a claim that an independently healthy employee is unconfirmed', async () => {
 const {h,employee,session,posts}=await fixture({health:'unknown',scope:'terminal',working:true});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true});
 const proof=nativeProof(employee);
 Object.assign(employee,{providerHealth:proof});
 Object.assign(session,{providerHealth:proof,viewerHealth:'connected',workerViewerReconnect:true});
 const original=h.app._chatApi.bind(h.app),checks:any[]=[];
 h.app._chatApi=async(path:string,options:any)=>{
  if(path.endsWith('/reconnect/status')){
   checks.push({path,...options});
   return{ok:true,data:{reconnect:{state:'idle',reason:'viewer-not-disconnected',attempts:0,retryAfterMs:0,observation:'outer-pane-responsive'}}};
  }
  return original(path,options);
 };
 await h.shell.openCompany();
 await h.shell.showEmployeeViewerStatus(employee);await h.flush(80);
 const report=h.document.querySelector('.ca-viewer-status-report').textContent;
 expect(report).toContain('The terminal viewer responded.');
 expect(report).toContain('This viewer check does not measure employee or chat readiness.');
 expect(report).not.toContain('Employee and chat readiness are still unconfirmed');
 expect(h.document.querySelector('.ca-company-state').textContent).toBe('Working');
 expect(h.document.querySelector('.ca-company-state').title).toContain('recently confirmed running');
 expect(h.document.querySelector('.ca-company-reason').hidden).toBe(true);
 expect(h.shell.presenceOf(member(SID,'Alex',{working:true}))).toBe('working');
 expect(checks).toHaveLength(1);expect(posts).toHaveLength(0);
 expect(session.isWorking).toBe(true);expect(session.runtimeHealth).toBe('unknown');
});
it('clears stale saved Working and green presence when connected worker proof expires',async()=>{
 const{h,employee,session,posts}=await fixture({health:'unknown',scope:'terminal'});
 let epoch=100000,mono=0;vi.spyOn(h.window.Date,'now').mockImplementation(()=>epoch);vi.spyOn(h.window.performance,'now').mockImplementation(()=>mono);
 Object.assign(employee,{sessionGeneration:1,providerHealth:nativeProof(employee,'healthy',{observedAtEpochMs:epoch})});
 Object.assign(session,{providerHealth:employee.providerHealth,viewerHealth:'connected'});
 await h.shell.openCompany();h.shell.renderMembers();
 h.shell._presenceSig=h.shell.presenceSignature();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.querySelector('.ca-company-state').textContent).toBe('Working');
 expect(card.classList.contains('is-tone-ok')).toBe(true);
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-working')).toBe(true);
 epoch+=25001;mono+=25001;h.shell.schedulePresence();await h.flush(60);
 expect(h.document.querySelector('[data-employee-id="expert"]')).toBe(card);
 expect(card.querySelector('.ca-company-state').textContent).toBe('Unknown');
 expect(card.querySelector('.ca-company-reason').textContent).toBe('Health not confirmed');
 expect(card.classList.contains('is-tone-ok')).toBe(false);expect(card.classList.contains('is-tone-unknown')).toBe(true);
 expect(card.querySelector('.ca-company-state').classList.contains('is-connected')).toBe(false);
 expect(h.document.querySelector('.ca-member').classList.contains('is-state-unknown')).toBe(true);
 expect(h.document.querySelector('.ca-member').textContent).not.toContain('Working…');
 expect(h.document.querySelector('.ca-members').textContent).toContain('Availability unknown — 1');
 expect(h.document.querySelector('.ca-head-members').title).toContain('0 online');
 expect(session.status).toBe('busy');expect(session.isWorking).toBe(true);
 expect(h.shell.room.members[0].working).toBe(true);expect(posts).toHaveLength(0);
});
it('keeps a native-confirmed agent Online when its optional viewer is unavailable, without clearing the viewer or input hold',async()=>{
 const{h,employee,session,posts}=await fixture({health:'disconnected',scope:'terminal',working:false});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true,providerHealth:nativeProof(employee)});
 Object.assign(session,{pid:null,providerHealth:employee.providerHealth,viewerHealth:'disconnected',workerViewerReconnect:true});
 for(const m of h.shell.room.members)m.alive=false;
 await h.shell.openCompany();h.shell.renderMembers();
 const card=h.document.querySelector('[data-employee-id="expert"]');
 expect(card.classList.contains('is-offline')).toBe(false);expect(card.querySelector('.ca-company-state').textContent).toBe('Idle');
 expect(card.querySelector('.ca-company-state').title).toContain('recently confirmed running');
 expect(card.querySelector('.ca-company-reason.ca-viewer-warning').textContent).toBe('Viewer unavailable');expect(card.querySelector('.ca-dead-pane-restart')).toBeNull();
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
 expect(h.document.querySelector('.ca-head-members').title).toContain('0 online');expect(h.document.querySelector('.ca-company-state').textContent).toBe('Unknown');
 expect(h.document.querySelector('.ca-company-reason').textContent).toBe('Terminal viewer lost');
 expect(h.document.querySelector('.ca-company-person').classList.contains('is-tone-unknown')).toBe(true);
});
it.each(['expired','future','wrong-generation'] as const)('does not use %s provider metadata to mark a detached agent Online',async change=>{
 const{h,employee,session}=await fixture({health:'disconnected',scope:'terminal',working:false});Object.assign(employee,{sessionGeneration:1});
 const proof=nativeProof(employee,'healthy',change==='expired'?{observedAtEpochMs:Date.now()-25001}:change==='future'?{observedAtEpochMs:Date.now()+60_000}:{sessionGeneration:2});
 Object.assign(employee,{providerHealth:proof});Object.assign(session,{providerHealth:proof,pid:null});
 await h.shell.openCompany();expect(h.document.querySelector('.ca-company-state').textContent).toBe('Unknown');expect(h.document.querySelector('.ca-company-reason').textContent).toBe('Terminal viewer lost');
 expect(h.document.querySelector('.ca-company-person').className).not.toMatch(/is-tone-(?:ok|idle)/);
});
it('keeps native-confirmed command death red even while the old viewer says it is busy',async()=>{
 const{h,employee,session}=await fixture({health:'unknown',scope:'terminal'});Object.assign(employee,{sessionGeneration:1,providerHealth:nativeProof(employee,'dead')});
 Object.assign(session,{providerHealth:employee.providerHealth});await h.shell.openCompany();
 const card=h.document.querySelector('[data-employee-id="expert"]');expect(card.classList.contains('is-health-dead')).toBe(true);expect(card.querySelector('.ca-company-state').textContent).toBe('Agent exited');
 expect(card.querySelector('.ca-company-state').title).toContain('The agent runtime has exited');expect(card.classList.contains('is-tone-alert')).toBe(true);
 expect(h.shell.presenceOf(member(SID,'Alex',{working:true}))).toBe('dead');
});
it.each([{off:true},{vacation:true}])('never lets positive native metadata override owner choice %j',async choice=>{
 const{h,employee,session}=await fixture({...choice,health:'disconnected',scope:'terminal'});Object.assign(employee,{sessionGeneration:1,providerHealth:nativeProof(employee)});Object.assign(session,{providerHealth:employee.providerHealth});
 await h.shell.openCompany();expect(h.document.querySelector('[data-employee-id="expert"]').classList.contains('is-offline')).toBe(true);expect(h.document.querySelector('.ca-company-state').textContent).toBe(choice.vacation?'Out of office':'Stopped');
 expect(h.document.querySelector('.ca-company-reason').hidden).toBe(true);expect(h.document.querySelector('.ca-company-person').classList.contains('is-tone-off')).toBe(true);
 expect(h.document.querySelector('.ca-company-state').title).toContain('Stopped by owner choice');
 expect([...h.document.querySelectorAll('.ca-company-status-actions > button')].map((b:any)=>b.textContent)).toEqual([]);
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

it('reports diagnostic request readiness unconfirmed and input held instead of green saved working',async()=>{
 const {h,employee,session}=await fixture({health:'unknown',scope:'terminal',working:true});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true});
 Object.assign(session,{viewerHealth:'disconnected',viewerInspectionRequested:true,viewerInputHeld:true,workerViewerReconnect:true});
 await h.shell.openCompany();
 const badge=h.document.querySelector('.ca-company-state');expect(badge.textContent).toBe('Unknown');
 expect(h.document.querySelector('.ca-company-reason').textContent).toBe('Terminal viewer lost');
 expect(badge.title).toContain('Readiness is unconfirmed; automated input is held');
 const row=h.document.querySelector('.ca-member');expect(row.classList.contains('is-state-working')).toBe(false);
 expect(row.textContent).not.toContain('Working…');expect(h.shell.canReconnectEmployee(employee)).toBe(true);
 expect(h.document.querySelector('.ca-company-person .ca-reconnect-viewer')).not.toBeNull();
});

it('keeps independently confirmed provider death visible after a diagnostic viewer request',async()=>{
 const {h,employee,session}=await fixture({health:'unknown',scope:'terminal',working:true});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true,providerHealth:nativeProof(employee,'dead')});
 Object.assign(session,{viewerHealth:'disconnected',viewerInspectionRequested:true,viewerInputHeld:true,workerViewerReconnect:true,providerHealth:employee.providerHealth});
 expect(h.shell.employeeHealth(employee)).toMatchObject({state:'dead',label:'Agent runtime stopped'});
 expect(h.shell.employeeHealth(employee).detail).toContain('diagnostic viewer was requested');
 expect(h.shell.canReconnectEmployee(employee)).toBe(true);
});

it('announces a diagnostic request as unconfirmed without a terminal-reconnected success toast',async()=>{
 const {h,employee,session}=await fixture({health:'disconnected',scope:'terminal',working:true});
 Object.assign(employee,{sessionGeneration:1,workerViewerReconnect:true});Object.assign(session,{workerViewerReconnect:true});
 const calls:any[]=[];h.app._chatApi=async(path:string,options:any)=>{calls.push({path,...options});return{ok:true,data:{
  state:'viewer-inspection-requested',reconnect:{state:'blocked',reason:'diagnostic-requested-readiness-unconfirmed-input-held',attempts:0,retryAfterMs:0}}};};
 await h.shell.reconnectEmployeeViewer(employee);
 expect(calls).toEqual([{path:'/api/company/employees/expert/reconnect',method:'POST',body:{sessionId:SID,sessionGeneration:1}}]);
 expect(h.app.toasts.some((toast:any)=>toast.text==='Diagnostic viewer requested for Alex. Readiness is unconfirmed; automated input remains held.')).toBe(true);
 expect(h.app.toasts.some((toast:any)=>toast.text==='Terminal reconnected for Alex.')).toBe(false);
});

function boxedPlacementFixture() {
 return {version:1,operationId:'10000000-0000-4000-8000-000000000001',credentialId:'20000000-0000-4000-8000-000000000002',
  sessionId:SID,sessionGeneration:1,containerId:'a'.repeat(64),imageId:'sha256:'+'b'.repeat(64),originalDigest:'c'.repeat(64),policyDigest:'d'.repeat(64)};
}
it.each(['containerId','operationId','imageId','credentialId'])('rejects late old Docker %s health with unchanged public9 tuple and clears retained member/session facts',async field=>{
 const {h,employee,session,posts}=await fixture({health:'unknown',scope:'terminal',working:false});
 const binding=boxedPlacementFixture(),encode=encodeDockerProviderPlacement;
 Object.assign(employee,{sessionGeneration:1,dockerBinding:binding,dockerProviderPlacement:encode(binding)});
 const old=nativeProof(employee,'healthy',{dockerPlacement:encode(binding)});
 Object.assign(employee,{providerHealth:old});Object.assign(session,{providerHealth:old});
 h.shell.room.members[0].providerHealth=old;
 await h.shell.openCompany();h.shell.renderMembers();
 expect(h.document.querySelector('.ca-company-state').textContent).toBe('Idle');
 expect(h.document.querySelector('.ca-company-state').title).toContain('recently confirmed running');
 const nextBinding={...binding};
 if(field==='containerId')nextBinding.containerId='8'.repeat(64);
 if(field==='operationId')nextBinding.operationId='80000000-0000-4000-8000-000000000008';
 if(field==='imageId')nextBinding.imageId='sha256:'+'8'.repeat(64);
 if(field==='credentialId')nextBinding.credentialId='80000000-0000-4000-8000-000000000008';
 const next={...employee,dockerBinding:nextBinding,dockerProviderPlacement:encode(nextBinding),providerHealth:undefined};
 expect(nativeProof(next).binding).toBe(old.binding);
 const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:unknown)=>path==='/api/company'?{ok:true,data:{...h.shell.company,employees:[next]}}:original(path,options);
 await h.shell.loadOwner();
 expect(session).not.toHaveProperty('providerHealth');expect(h.shell.room.members[0]).not.toHaveProperty('providerHealth');
 Object.assign(session,{providerHealth:old});h.shell.room.members[0].providerHealth=old;
 expect(h.shell.employeeHealth(next,h.shell.room.members[0]).state).toBe('unknown');
 const fresh=nativeProof(next,'healthy',{dockerPlacement:encode(nextBinding)});Object.assign(next,{providerHealth:fresh});
 expect(h.shell.employeeHealth(next,h.shell.room.members[0]).label).toBe('Online');
 expect(posts).toHaveLength(0);
});
it('boxed health without current canonical employee/placement cannot become healthy from a connected terminal',async()=>{
 const {h,employee,session}=await fixture({health:'healthy',scope:'provider',working:true});
 const binding=boxedPlacementFixture(),encode=encodeDockerProviderPlacement;
 Object.assign(employee,{sessionGeneration:1,dockerBinding:binding,dockerProviderPlacement:encode(binding),providerHealth:nativeProof(employee)});
 expect(h.shell.employeeHealth(employee).state).toBe('unknown');
 Object.assign(session,{providerHealth:nativeProof(employee,'healthy',{dockerPlacement:encode(binding)})});
 h.shell.company.employees=[];
 expect(h.shell.employeeHealth({sessionId:SID},h.shell.room.members[0]).state).toBe('unknown');
});
it('keeps closed server placement without a new browser script dependency',()=>{
 const encode=encodeDockerProviderPlacement,binding=boxedPlacementFixture();
 const html=readFileSync(new URL('../src/web/public/index.html',import.meta.url),'utf8');
 expect(html).not.toContain('docker-provider-health-placement.js');
 expect(encode(binding)).toBe(JSON.stringify([1,binding.operationId,binding.containerId,binding.imageId,binding.credentialId,binding.sessionId,1,binding.originalDigest,binding.policyDigest]));
 for(const invalid of [{...binding,containerId:[binding.containerId]},{...binding,sessionGeneration:'1'},{...binding,imageId:'latest'},null])expect(encode(invalid)).toBeUndefined();
});
