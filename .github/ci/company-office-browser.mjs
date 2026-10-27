// Browser acceptance against synthetic owner data; never touches a personal instance.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve(import.meta.dirname,'../..');
const modules=process.env.REVERIE_BROWSER_NODE_MODULES || join(root,'apps/web/node_modules');
const {chromium}=await import(pathToFileURL(join(modules,'playwright/index.mjs')).href);
const pub=join(root,'apps/web/src/web/public');
const {tsImport}=await import(pathToFileURL(join(modules,'tsx/dist/esm/api/index.mjs')).href);
const {registerHandbookRoutes}=await tsImport(pathToFileURL(join(root,'apps/web/src/web/routes/handbook-routes.ts')).href,import.meta.url);
const {default:Fastify}=await import(pathToFileURL(join(modules,'fastify/fastify.js')).href);
const handbook=Fastify();registerHandbookRoutes(handbook,join(pub,'handbook'));
const harness=await readFile(join(root,'apps/web/test/helpers/chat-app-harness.mjs'),'utf8');
const stub=harness.match(/window\.eval\(`([\s\S]*?class ReverieApp[\s\S]*?)`\);/)[1];
const employee=(id,name)=>({id,sessionId:id,name,icon:name[0],reportsTo:'owner',available:true,onVacation:false,permissions:{},sleepEnabled:false,dreamEnabled:false});
const company={canManage:true,employees:[employee('first','River'),employee('second','Lake')],settings:{ownerName:'Owner'}};
const endpoint={id:'local-qwen',label:'Qwen · RTX 3090',baseUrl:'http://127.0.0.1:8092',models:['qwen-local'],defaultModelId:'qwen-local',apiKeySet:true};
const board={built:Date.now(),issues:[],agents:{},roster:[],ownerIds:{},pace:{owners:{},milestones:{}},timeZone:'UTC',planBurn:[{id:'paid',name:'Paid plan',used:null}],company:{name:'Office'}};
const fixture=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/chat-app.css"></head><body><div class="app" id="legacy"><header id="legacyHeader"><span id="chatroomBadge" hidden>0</span></header><main id="legacyMain">legacy</main></div><script>window.__approvals=false;window.ReverieUrlSession={sessionIdFromFragment:()=>null};window.__server={handle:(path,opts={})=>fetch(path,{method:opts.method||'GET',headers:{'content-type':'application/json'},...(opts.body?{body:JSON.stringify(opts.body)}:{})})};${stub}</script><script src="/chatroom-ui.js"></script><script src="/chat-media.js"></script><script>window.app=new ReverieApp();</script><script src="/chat-app.js"></script></body></html>`;
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/handbook'||path.startsWith('/handbook/')||path.startsWith('/api/handbook')){
   const result=await handbook.inject({method:req.method,url:req.url});res.writeHead(result.statusCode,result.headers);res.end(result.body);return;
  }
  if(path.startsWith('/api/')){
   let body='';for await(const part of req)body+=part;
   const target=company.employees.find(e=>path==='/api/company/employees/'+e.id);
   if(target && req.method==='PUT'){const {permissions,...rest}=JSON.parse(body);Object.assign(target,rest);if(permissions)target.permissions={...target.permissions,...permissions};}
   const leaving=company.employees.find(e=>path==='/api/company/employees/'+e.id+'/vacation');
   if(leaving && req.method==='POST'){leaving.onVacation=JSON.parse(body).enabled;leaving.desiredRunning=!leaving.onVacation;}
   const data=target && req.method==='PUT'?{employee:target}:leaving && req.method==='POST'?{employee:leaving}:path==='/api/company'?company:path==='/api/board'?board:path==='/api/chatrooms'?{self:null,rooms:[],features:{}}:path==='/api/chatrooms/phone-status'?{self:'owner',canSetOwn:true}:path==='/api/model-endpoints'?[endpoint]:path==='/api/system/gpu'?{available:true,utilization:18,memoryUsedMb:18000,memoryTotalMb:24576}:path==='/api/sessions'?[{id:'first',customModel:{endpointId:endpoint.id}}]:path==='/api/company/hire-options'?{sources:[{...endpoint,kind:'local',modes:['opencode'],defaultMode:'opencode'}],harnesses:[{id:'opencode',label:'OpenCode',efforts:[]}]}:path==='/api/plans/allocations'?{accounts:[],employees:company.employees}:path==='/api/voice/options'?{voices:[]}:{};
   res.setHeader('content-type','application/json');res.end(JSON.stringify(['/api/model-endpoints','/api/system/gpu','/api/sessions'].includes(path)?data:{success:true,data}));return;
  }
  const file=path==='/'?null:path==='/company/plans'?'company-plans.html':path.slice(1);
  if(file?.includes('..'))throw Error('bad path');
  res.setHeader('content-type',file?.endsWith('.js')?'text/javascript':file?.endsWith('.css')?'text/css':'text/html');res.end(file?await readFile(join(pub,file)):fixture);
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.REVERIE_BROWSER_EXECUTABLE||'/run/current-system/sw/bin/microsoft-edge',headless:true,chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:950}});
 const out=process.env.REVERIE_BROWSER_ARTIFACTS;
 if(out)await mkdir(out,{recursive:true});
 const profileFor=async name=>{
  await page.getByRole('button',{name:'Edit profile for '+name,exact:true}).click();
  const profile=page.getByRole('dialog',{name:'Edit profile: '+name,exact:true});
  await profile.waitFor();return profile;
 };
 await page.goto(origin,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.reverieChat?.built);
 await page.evaluate(()=>window.reverieChat.openCompany());
 for(const {id,name} of company.employees){
  const card=page.locator(`.ca-company-person[data-employee-id="${id}"]`);
  assert.equal(await card.getByRole('checkbox').count(),0);
  let profile=await profileFor(name);
  await profile.getByRole('tab',{name:'Profile',exact:true}).click();
  await profile.getByRole('checkbox',{name:'Sleep',exact:true}).check();
  await profile.getByRole('checkbox',{name:'Dream',exact:true}).check();
  assert.equal(company.employees.find(employee=>employee.id===id).sleepEnabled,false);
  assert.equal(company.employees.find(employee=>employee.id===id).dreamEnabled,false);
  await profile.getByRole('button',{name:'Save profile',exact:true}).click();
  await profile.waitFor({state:'hidden'});
  profile=await profileFor(name);
  await profile.getByRole('tab',{name:'Permissions',exact:true}).click();
  for(const label of ['Recovery permission for '+name,'Move own plan for '+name,'Manage team plans for '+name]){
   const saved=page.waitForResponse(response=>response.url()===origin+'/api/company/employees/'+id && response.request().method()==='PUT');
   await profile.getByRole('checkbox',{name:label,exact:true}).check();
   const response=await saved;assert.equal(response.ok(),true);
   assert.deepEqual(Object.keys(response.request().postDataJSON()),['permissions']);
   await profile.getByText('Preferences saved.',{exact:true}).waitFor();
  }
  assert.equal(await profile.getByRole('button',{name:'Save preferences',exact:true}).count(),0);
  const retirement=profile.getByRole('button',{name:'Retire '+name,exact:true,includeHidden:true});
  assert.equal(await retirement.count(),1);
  assert.equal(await retirement.isVisible(),false);
  if(out && id==='first')await page.screenshot({path:join(out,'company-profile-desktop.png'),fullPage:true});
  await profile.getByRole('button',{name:'Close profile for '+name,exact:true}).click();
 }
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.reverieChat?.built);await page.evaluate(()=>window.reverieChat.openCompany());
 for(const {id,name} of company.employees){
  const profile=await profileFor(name);
  await profile.getByRole('tab',{name:'Profile',exact:true}).click();
  assert.equal(await profile.getByRole('checkbox',{name:'Sleep',exact:true}).isChecked(),true);
  assert.equal(await profile.getByRole('checkbox',{name:'Dream',exact:true}).isChecked(),true);
  await profile.getByRole('tab',{name:'Permissions',exact:true}).click();
  for(const label of ['Recovery permission for '+name,'Move own plan for '+name,'Manage team plans for '+name])assert.equal(await profile.getByRole('checkbox',{name:label,exact:true}).isChecked(),true);
  await profile.getByRole('button',{name:'Close profile for '+name,exact:true}).click();
 }
 const lake=await profileFor('Lake');
 await lake.getByRole('tab',{name:'Permissions',exact:true}).click();
 await lake.getByRole('switch',{name:'Leave office: Lake',exact:true}).uncheck();
 const leave=page.getByRole('dialog',{name:'Leave office: Lake',exact:true});
 assert.match(await leave.textContent(),/Active work is interrupted.*saved conversation, memory, files/);
 await leave.getByRole('button',{name:'Leave office',exact:true}).click();
 await lake.getByRole('switch',{name:'Enter office: Lake',exact:true}).waitFor();
 assert.equal(company.employees[1].desiredRunning,false);
 await lake.getByRole('switch',{name:'Enter office: Lake',exact:true}).check();
 const enter=page.getByRole('dialog',{name:'Enter office: Lake',exact:true});
 assert.match(await enter.textContent(),/starts their laptop and resumes their agent/);
 await enter.getByRole('button',{name:'Enter office',exact:true}).click();
 await lake.getByRole('switch',{name:'Leave office: Lake',exact:true}).waitFor();
 assert.equal(company.employees[1].desiredRunning,true);
 assert.equal(company.employees[1].onVacation,false);
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(out)await page.screenshot({path:join(out,'company-profile-mobile.png'),fullPage:true});
 await lake.getByRole('button',{name:'Close profile for Lake',exact:true}).click();
 await page.setViewportSize({width:1200,height:950});
 await page.goto(origin+'/company/plans',{waitUntil:'domcontentloaded'});
 const local=page.locator('#plans > .plan-local');await local.waitFor();
 assert.equal(await page.locator('#plans > .plan').count(),2);
 assert.ok((await local.textContent()).includes('Qwen · RTX 3090'));
 assert.ok((await local.textContent()).includes('18%'));
 assert.equal(await local.locator('svg,[data-sign-in],[data-rename]').count(),0);
 assert.equal(await local.getByLabel('River',{exact:true}).count(),1);
 if(out)await page.screenshot({path:join(out,'company-local-plan-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(out)await page.screenshot({path:join(out,'company-local-plan-mobile.png'),fullPage:true});
 await page.goto(origin+'/handbook',{waitUntil:'domcontentloaded'});
 await page.getByRole('link',{name:'Recover a stuck expert',exact:true}).last().click();
 assert.ok((await page.locator('article').textContent()).includes('recoverEmployees'));
 const docs=await (await page.request.get(origin+'/api/handbook/recovery')).json();assert.ok(docs.data.markdown.includes('recovery.skipped'));
 await page.getByLabel('Search handbook',{exact:true}).fill('scratch');
 await page.getByRole('button',{name:'Search',exact:true}).click();assert.ok((await page.locator('article').textContent()).includes('Work and scratch'));
 if(out)await page.screenshot({path:join(out,'handbook-mobile.png'),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1200,height:950});if(out)await page.screenshot({path:join(out,'handbook-desktop.png'),fullPage:true});
 console.log('PASS handbook human navigation/search and agent Markdown; tabbed profiles save Sleep/Dream explicitly and permissions immediately, all persist across reload; confirmed leave/enter office; retirement hidden; distinct local plan card, GPU numbers, members, desktop/mobile layout.');
}finally{await handbook.close();await browser.close();await new Promise(r=>server.close(r));}
