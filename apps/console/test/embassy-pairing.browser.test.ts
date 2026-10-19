import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {startPairingPreview,qr,requestQr} from './helpers/embassy-pairing-preview.mjs';
let browser:Browser,page:Page,preview:any,errors:string[];
beforeAll(async()=>{preview=await startPairingPreview();browser=await chromium.launch({headless:true});});
afterAll(async()=>{await page?.close();await browser?.close();await preview.close();});
beforeEach(async()=>{await page?.close();page=await browser.newPage({viewport:{width:1280,height:800}});errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(preview.url);await page.waitForSelector('.eg-channel');await page.getByRole('button',{name:'Add embassy channel',exact:true}).click();await page.getByRole('button',{name:'Invite a company',exact:true}).waitFor();});
afterEach(()=>expect(errors).toEqual([]));
async function inputQR(value=qr){
 await page.getByRole('button',{name:'Join a company',exact:true}).click();await page.getByText('Paste an invitation instead',{exact:true}).click();await page.getByLabel('Invitation QR text',{exact:true}).fill(value);await page.getByRole('button',{name:'Request to join',exact:true}).click();await page.getByText('Waiting for host approval',{exact:true}).waitFor();await page.getByRole('button',{name:'Cancel request',exact:true}).waitFor();
}
async function decodeCanvas(){await page.addScriptTag({url:preview.url+'/vendor/embassy-qr-scan.min.js?v=1.4.0'});await page.waitForFunction(()=>{const c=document.querySelector('.eg-pair-qr');return c&&window.jsQR(c.getContext('2d').getImageData(0,0,c.width,c.height).data,c.width,c.height);});return page.locator('.eg-pair-qr').evaluate((c:any)=>window.jsQR(c.getContext('2d').getImageData(0,0,c.width,c.height).data,c.width,c.height).data);}
it('owner Invite displays a real local QR1 without plaintext token, storage or navigation',async()=>{
 await page.getByRole('button',{name:'Invite a company',exact:true}).click();await page.locator('.eg-pair-qr').waitFor();await page.waitForFunction(()=>document.querySelector('canvas')?.width>0);expect(await decodeCanvas()).toBe(qr);
 expect(await page.locator('.eg-pair-dialog').textContent()).not.toContain('A'.repeat(43));expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('A'.repeat(43));expect(new URL(page.url()).hash).toBe('');
});
it('actual QR image decode creates pending, renders only the public request QR and cannot show chat',async()=>{
 await page.getByRole('button',{name:'Invite a company',exact:true}).click();await page.locator('.eg-pair-qr').waitFor();await page.waitForFunction(()=>document.querySelector('.eg-pair-qr')?.width>0);
 await page.getByRole('button',{name:'Scan their confirmation',exact:true}).waitFor();
 const png=await page.locator('.eg-pair-qr').evaluate((c:any)=>c.toDataURL('image/png'));
 await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('button',{name:'Join a company',exact:true}).click();
 await page.locator('.eg-pair-dialog input[type=file]').setInputFiles({name:'synthetic-qr.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});await page.getByText('Waiting for host approval',{exact:true}).waitFor();await page.locator('.eg-pair-qr').waitFor();
 expect(await decodeCanvas()).toBe(requestQr);expect(await page.evaluate(()=>window.reverieChat.embassy.selected)).toBeNull();expect(await page.evaluate(()=>window.__pair.calls.filter(c=>c.path.endsWith('/approve')).length)).toBe(0);
 expect(await page.evaluate(()=>window.__server.posts.length)).toBe(0);expect(await page.locator('.eg-pair-confirm-code').textContent()).toBe('3BCD-5FGH');
});
it('typed public code resolves to guest/company and requires explicit approval',async()=>{
 await page.getByRole('button',{name:'Invite a company',exact:true}).click();await page.getByRole('button',{name:'Scan their confirmation',exact:true}).click();await page.getByText('Type the confirmation code instead',{exact:true}).click();
 await page.getByLabel('Confirmation code',{exact:true}).fill('3bcd5fgh');await page.getByRole('button',{name:'Look up confirmation',exact:true}).click();await page.getByText('Student from Student company',{exact:true}).waitFor();
 expect(await page.evaluate(()=>window.__pair.calls.filter(c=>c.path.endsWith('/approve')).length)).toBe(0);
 await page.getByRole('button',{name:'Approve connection',exact:true}).click();await page.getByText('Approved. The other company can now finish connecting.',{exact:true}).waitFor();
 expect(await page.evaluate(()=>window.__pair.calls.filter(c=>c.path.endsWith('/approve')).length)).toBe(1);
});
it('connected status opens the existing feed only after connection-store discovery',async()=>{
 await inputQR();await page.evaluate(()=>{window.__pair.state='connected';return window.reverieChat.embassy.pairing.poll();});await page.waitForFunction(()=>window.reverieChat.embassy.selected==='bd2161d7-0c0e-41f8-83d2-c6c720c22ac2');expect(await page.locator('.ca-head-title').textContent()).toContain('Paired room');
 expect(await page.locator('.eg-pair-dialog').count()).toBe(0);expect(await page.locator('.eg-input').isVisible()).toBe(true);expect(await page.locator('[data-key="page:embassies"]').count()).toBe(0);
});
it('desktop and390px pending screens keep QR/actions inside the dialog viewport',async()=>{
 await inputQR();for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});const box=await page.locator('.eg-pair-dialog').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);expect(box.height).toBeLessThanOrEqual(844);
  expect(await page.getByRole('button',{name:'Cancel request',exact:true}).isVisible()).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/pairing-pending-'+width+'.png'});
 }
});
it('camera denial keeps image/code alternatives usable and dialog close clears transient QR',async()=>{
 await page.getByRole('button',{name:'Join a company',exact:true}).click();await page.evaluate(()=>Object.defineProperty(navigator,'mediaDevices',{value:undefined,configurable:true}));await page.getByRole('button',{name:'Scan with camera',exact:true}).click();
 expect(await page.locator('.eg-pair-status').textContent()).toContain('Camera unavailable');expect(await page.locator('.eg-pair-dialog input[type=file]').isVisible()).toBe(true);
 await page.getByRole('button',{name:'Close',exact:true}).click();expect(await page.locator('.eg-pair-dialog').count()).toBe(0);expect(await page.evaluate(()=>window.reverieChat.embassy.pairing.record)).toBeNull();
});
it('cancelling keeps recovery visible across dialog restore and waits for confirmed Start over',async()=>{
 await inputQR();await page.evaluate(()=>{window.__pair.cancelState='cancelling';window.__pair.state='cancelling';});
 await page.getByRole('button',{name:'Cancel request',exact:true}).click();await page.getByText('Cancelling… (waiting for the host embassy to confirm)',{exact:true}).waitFor();
 expect(await page.getByRole('button',{name:'Start over',exact:true}).count()).toBe(0);expect(await page.locator('.eg-pair-confirm-code').count()).toBe(0);
 await page.locator('.eg-pair-dialog footer').getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(async()=>{const p=window.reverieChat.embassy.pairing;await p.open();p.handles=[{handle:'a'.repeat(32),state:'cancelling'}];p.home();});
 expect(await page.getByRole('button',{name:'Join a company',exact:true}).isDisabled()).toBe(true);
 await page.getByRole('button',{name:'Resume connection',exact:true}).click();await page.getByText('Cancelling… (waiting for the host embassy to confirm)',{exact:true}).waitFor();
 await page.evaluate(()=>{window.__pair.state='cancelled';return window.reverieChat.embassy.pairing.poll();});await page.getByRole('button',{name:'Start over',exact:true}).waitFor();
 expect(await page.evaluate(()=>window.__pair.calls.filter(c=>c.path==='/api/embassy-pairing'&&c.method==='POST').length)).toBe(1);
 await page.getByRole('button',{name:'Start over',exact:true}).click();await page.getByRole('button',{name:'Scan with camera',exact:true}).waitFor();
});
it('hosted view keeps its composer label and hides local typing on desktop and phone',async()=>{
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{const s=window.reverieChat;s.app.sessions.set('local-agent',{id:'local-agent',status:'idle',mode:'claude',name:'Local colleague'});s.noteTurn({roomId:s.roomId,sessionId:'local-agent'});});
 expect(await page.locator('.ca-typing').isVisible()).toBe(true);
 await page.evaluate(()=>{const s=window.reverieChat;s.embassy.open('__host__');s.syncComposer();s.noteTurn({roomId:s.roomId,sessionId:'local-agent'});});
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});expect(await page.locator('.eg-input').getAttribute('placeholder')).toBe('Message #Lab commons');
  expect(await page.locator('.ca-typing').isVisible()).toBe(false);
 }
 await page.evaluate(()=>window.reverieChat.embassy.close());expect(await page.locator('.ca-typing').isVisible()).toBe(true);
 expect(await page.evaluate(()=>window.reverieChat.app._chatEls.input.placeholder)).toBe('Message #General');
});
