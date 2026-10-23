// Real settings controls with a synthetic owner API; no personal instance data.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = resolve(import.meta.dirname, '../..');
const modules = process.env.REVERIE_BROWSER_NODE_MODULES || join(repo, 'apps/web/node_modules');
const { chromium } = await import(pathToFileURL(join(modules, 'playwright/index.mjs')).href);
const publicDir = join(repo, 'apps/web/src/web/public');
const source = await readFile(join(publicDir, 'index.html'), 'utf8');
const group = source.slice(source.indexOf('<div class="set-group" id="laptopPowerGroup">'), source.indexOf('<div class="set-group" id="doctorGroup">'));
assert.ok(group.includes('Stop Reverie'));
const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main id="appSettingsModal" style="padding:24px;max-width:900px">${group}</main><script>
window.calls=[];window.ReverieApp=class {async _api(path,options){window.calls.push({path,options});return new Response(JSON.stringify(path==='/api/system/laptops'?{success:true,data:{available:true,runningLaptops:2}}:{success:true}),{status:200});}};
</script><script src="/settings-ui.js"></script><script>window.app=new ReverieApp();</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end(fixture); }
    else if (['/settings-ui.js','/styles.css'].includes(req.url)) { res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css'); res.end(await readFile(join(publicDir,req.url.slice(1)))); }
    else { res.statusCode=404;res.end(); }
  } catch { res.statusCode=500;res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({ executablePath: process.env.REVERIE_BROWSER_EXECUTABLE || '/run/current-system/sw/bin/microsoft-edge', headless:true,chromiumSandbox:true });
try {
  const page = await browser.newPage({viewport:{width:1100,height:850}});
  const dialogs=[];
  page.on('dialog',async dialog => {dialogs.push(dialog.message());await dialog.accept();});
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
  for (const label of ['Stop Reverie','Stop all agents','Restart website']) {
    const button=page.getByRole('button',{name:label,exact:true});
    assert.equal(await button.isVisible(),true);
    await button.click();
    const expected = label === 'Stop Reverie' ? 'All laptops stopped. Reverie is shutting down.' : label === 'Stop all agents' ? 'All laptops stopped. The website is still open.' : 'Website restarting. Your agents are continuing on their laptops.';
    await page.waitForFunction(expected => document.getElementById('officePowerResult').textContent === expected, expected);
  }
  assert.match(dialogs[0],/All 2 laptop.*will stop before the website/);
  assert.match(dialogs[2],/keep working.*continue using their plans/);
  assert.match(dialogs[2],/10 minutes/);
  const calls=await page.evaluate(()=>window.calls.filter(c=>c.options).map(c=>({path:c.path,body:JSON.parse(c.options.body)})));
  assert.deepEqual(calls.map(c=>c.path),['/api/system/shutdown','/api/system/stop-laptops','/api/system/restart-website']);
  assert.ok(calls.every(c=>c.body.confirmed===true));
  const output=process.env.REVERIE_BROWSER_ARTIFACTS;
  if(output){await mkdir(output,{recursive:true});await page.screenshot({path:join(output,'laptop-power-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(output,'laptop-power-mobile.png'),fullPage:true});}
  console.log('PASS visible desktop/mobile controls, explicit running-work and plan-use confirmation, and distinct API actions');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
