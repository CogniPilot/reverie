// Real Office power controls with a synthetic owner API; no personal instance data.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = resolve(import.meta.dirname, '../..');
const modules = process.env.REVERIE_BROWSER_NODE_MODULES || join(repo, 'apps/web/node_modules');
const { chromium } = await import(pathToFileURL(join(modules, 'playwright/index.mjs')).href);
const publicDir = join(repo, 'apps/web/src/web/public');
const harness = await readFile(join(repo, 'apps/web/test/helpers/chat-app-harness.mjs'), 'utf8');
const stub = harness.match(/window\.eval\(`([\s\S]*?class ReverieApp[\s\S]*?)`\);/)[1];
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/chat-app.css"></head><body><div class="app" id="legacy"><header id="legacyHeader"><span id="chatroomBadge" hidden>0</span></header><main id="legacyMain">legacy</main></div><script>
window.calls=[];window.__approvals=false;window.ReverieUrlSession={sessionIdFromFragment:()=>null};
window.__server={handle:async(path,options)=>{window.calls.push({path,options});const data=path==='/api/system/laptops'?{available:true,runningLaptops:2}:path==='/api/company'?{canManage:true,employees:[],settings:{ownerName:'Owner'}}:path==='/api/chatrooms/phone-status'?{self:'owner',canSetOwn:true}:path==='/api/chatrooms'?{self:null,rooms:[],features:{}}:path==='/api/office/me'?{person:{id:'fixture-owner',role:'owner',primary:true}}:{};return new Response(JSON.stringify({success:true,data}),{status:200});}};
${stub}
</script><script src="/chatroom-ui.js"></script><script src="/chat-media.js"></script><script src="/settings-ui.js"></script><script>window.app=new ReverieApp();</script><script src="/chat-app.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end(fixture); }
    else if (['/settings-ui.js','/styles.css','/chat-app.css','/chatroom-ui.js','/chat-media.js','/chat-app.js'].includes(req.url)) { res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css'); res.end(await readFile(join(publicDir,req.url.slice(1)))); }
    else { res.statusCode=404;res.end(); }
  } catch { res.statusCode=500;res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({ executablePath: process.env.REVERIE_BROWSER_EXECUTABLE || '/run/current-system/sw/bin/microsoft-edge', headless:true,chromiumSandbox:true });
try {
  const page = await browser.newPage({viewport:{width:1100,height:850}});
  const nativeDialogs=[];
  page.on('dialog',async dialog => {nativeDialogs.push(dialog.type());await dialog.dismiss();});
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.reverieChat?.built);
  await page.evaluate(()=>window.reverieChat.openPage('office'));
  const office=page.getByRole('region',{name:'Office settings',exact:true});
  const output=process.env.REVERIE_BROWSER_ARTIFACTS;
  if(output)await mkdir(output,{recursive:true});
  for (const [device,viewport] of [['desktop',{width:1100,height:850}],['mobile',{width:390,height:844}]]) {
    await page.setViewportSize(viewport);
    const start=await page.evaluate(()=>window.calls.filter(c=>c.options?.method==='POST' && c.path.startsWith('/api/system/')).length);
    // Cancel is a visible UI action, and must never send the power POST.
    await office.getByRole('button',{name:'Shut down Reverie',exact:true}).click();
    await page.getByRole('alertdialog',{name:'Shut down Reverie?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ca-office-page > [role="status"]').textContent==='Cancelled. No power action was requested.');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.options?.method==='POST' && c.path.startsWith('/api/system/')).length),start);
    for (const [label,confirmation] of [['Shut down Reverie','Shut down Reverie'],['Stop all agents','Stop all laptops'],['Restart website','Restart website']]) {
      const button=office.getByRole('button',{name:label,exact:true});
      assert.equal(await button.isVisible(),true);
      const before=await page.evaluate(()=>window.calls.filter(c=>c.options?.method==='POST' && c.path.startsWith('/api/system/')).length);
      await button.click();
      const dialog=page.getByRole('alertdialog',{name:confirmation+'?',exact:true});
      await dialog.waitFor();
      assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.options?.method==='POST' && c.path.startsWith('/api/system/')).length),before);
      const message=await dialog.textContent();
      if(label==='Restart website') {
        assert.match(message,/2 laptop.*keep working.*continue using their plans/);
        assert.match(message,/Chat will briefly go offline/);
        assert.match(message,/stop after 10 minutes if the office API does not return/);
        if(output)await page.screenshot({path:join(output,`laptop-power-${device}-confirmation.png`),fullPage:true});
      } else {
        assert.match(message,/2 laptop.*agent CLIs/);
        assert.match(message,/Active work is interrupted without a fresh handoff/);
        assert.match(message,/Saved conversations, memory and files will be preserved/);
        assert.match(message,label==='Shut down Reverie'?/will stop before the website shuts down/:/website will stay open/);
      }
      await dialog.getByRole('button',{name:confirmation,exact:true}).click();
      const expected = label === 'Shut down Reverie' ? 'All laptops stopped. Reverie is shutting down.' : label === 'Stop all agents' ? 'All laptops stopped. The website is still open.' : 'Website restarting. Your agents are continuing on their laptops.';
      await page.waitForFunction(expected => document.querySelector('.ca-office-page > [role="status"]').textContent === expected, expected);
      assert.equal(await page.getByRole('alertdialog').count(),0);
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(output)await page.screenshot({path:join(output,`laptop-power-${device}.png`),fullPage:true});
  }
  // The full shell also records harmless presence; assert every system power POST.
  const calls=await page.evaluate(()=>window.calls.filter(c=>c.options?.method==='POST' && c.path.startsWith('/api/system/')).map(c=>({path:c.path,method:c.options.method,body:c.options.body})));
  const paths=['/api/system/shutdown','/api/system/stop-laptops','/api/system/restart-website'];
  assert.deepEqual(calls.map(c=>c.path),[...paths,...paths]);
  assert.ok(calls.every(c=>c.method==='POST'));
  for(const call of calls)assert.deepEqual(call.body,{confirmed:true});
  assert.deepEqual(nativeDialogs,[]);
  console.log('PASS desktop/mobile in-page confirmations and cancellation, explicit running-work/offline/10-minute/plan-use implications, and distinct confirmed API actions');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
