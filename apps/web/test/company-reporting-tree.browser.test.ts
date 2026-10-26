import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

it.each([
  { label: 'desktop', width: 1580, height: 900, shape: 'current', styles: ['styles.css', 'chat-app.css'] },
  { label: 'desktop-reverse-css', width: 1580, height: 900, shape: 'current', styles: ['chat-app.css', 'styles.css'] },
  { label: 'owner-screen', width: 1863, height: 956, shape: 'current', styles: ['styles.css', 'chat-app.css'] },
  { label: 'stress-wide-deep', width: 1440, height: 1000, shape: 'stress', styles: ['styles.css', 'chat-app.css'] },
  { label: 'mobile', width: 390, height: 844, shape: 'current', styles: ['styles.css', 'chat-app.css'] },
])('draws a real top-down 12-person tree with compact current-company geometry and working fit/zoom ($label)', async ({ label, width, height, shape, styles }) => {
  const publicDir = resolve(import.meta.dirname, '../src/web/public');
  const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
  const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
  const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width, height } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().resourceType() === 'script'
      ? route.fulfill({ contentType: 'application/javascript', body: '' })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-skin="daylight-blue"><head></head><body></body></html>' }));
    await page.goto('https://company-tree-fixture.test/');
    for (const name of styles) await page.addStyleTag({ content: read(name) });
    await page.addScriptTag({ content: `
      ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
      const user={kind:'user',name:'Owner'};window.ReverieUrlSession={sessionIdFromFragment:()=>null};
      window.__server=createServer([room('general','General',[])]);
      window.__server.company={canManage:true,settings:{ownerName:'Owner',ownerTitle:'Office owner'},employees:Array.from({length:12},(_,i)=>({
        id:'person-'+i,sessionId:'runtime-'+i,sessionGeneration:1,name:'Person '+(i+1),position:i<2?'Coordinator':'Engineer',
        icon:i===0?'🦊':i===1?'🦉':'🧑',available:i!==11,onVacation:i===11,
        reportsTo:${shape === 'current' ? "['owner','owner','person-1','person-2','person-1','person-1','person-1','person-5','person-6','person-1','person-5','person-1'][i]" : "i===0?'owner':i===1?'person-0':i===11?'person-2':'person-1'"},permissions:{}
      }))};
      const original=window.__server.handle;window.__server.handle=async(path,opts={})=>{
        const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});
        if(path==='/api/chatrooms/phone-status')return ok({self:'owner',canSetOwn:true});
        if(path==='/api/publication/tokens')return ok({tokens:[]});return original(path,opts)};
      window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});${appStub}
    ` });
    for (const name of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(name) });
    await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
    await page.addScriptTag({ content: read('chat-app.js') });
    await page.waitForSelector('.ca-rail', { state: 'attached' });
    await page.evaluate(() => (window as any).reverieChat.openCompany('people'));
    await page.waitForFunction(() => Boolean(document.querySelector<HTMLElement>('.ca-company-map-viewport')?.dataset.scale));
    const initial = await page.evaluate(() => { const v=document.querySelector('.ca-company-map-viewport')!.getBoundingClientRect(), o=document.querySelector('.ca-company-owner')!.getBoundingClientRect(); return {left:v.left,right:v.right,ownerCenter:(o.left+o.right)/2}; });
    expect(initial.ownerCenter).toBeGreaterThan(initial.left); expect(initial.ownerCenter).toBeLessThan(initial.right);
    await page.locator('[aria-label="Show reporting chart at 100%"]' ).click();
    const viewportHandle = page.locator('.ca-company-map-viewport');
    const bounds = (await viewportHandle.boundingBox())!;
    const beforePan = await viewportHandle.evaluate(element => element.scrollLeft);
    await page.mouse.move(bounds.x + 80, bounds.y + 12); await page.mouse.down();
    await page.mouse.move(bounds.x - 20, bounds.y + 12, { steps: 5 }); await page.mouse.up();
    if (await viewportHandle.evaluate(element => element.scrollWidth > element.clientWidth)) expect(await viewportHandle.evaluate(element => element.scrollLeft)).toBeGreaterThan(beforePan);
    const geometry = await page.evaluate(() => {
      const viewport = document.querySelector('.ca-company-map-viewport') as HTMLElement;
      const nodes = [...document.querySelectorAll('.ca-company-map-node')].map(element => {
        const rect = element.getBoundingClientRect(); const avatar = element.querySelector('.ca-company-icon')!.getBoundingClientRect();
        return { id: (element as HTMLElement).dataset.employeeId!, depth: Number((element as HTMLElement).dataset.depth),
          x: rect.x, y: rect.y, width: rect.width, height: rect.height, avatarWidth: avatar.width };
      });
      const edges = [...document.querySelectorAll('.ca-company-map-links path')].map(element => {
        const path = element as SVGPathElement, from = path.getPointAtLength(0), to = path.getPointAtLength(path.getTotalLength());
        const start = new DOMPoint(from.x, from.y).matrixTransform(path.getScreenCTM()!);
        const end = new DOMPoint(to.x, to.y).matrixTransform(path.getScreenCTM()!);
        return { parent: path.dataset.parentId!, child: path.dataset.childId!, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
      });
      return { nodes, edges, pageWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflowInsideViewport: viewport.scrollWidth > viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight };
    });
    expect(geometry.nodes).toHaveLength(13); expect(geometry.edges).toHaveLength(12);
    expect(geometry.scrollWidth).toBe(geometry.pageWidth);
    expect(Math.max(...geometry.nodes.map(node => node.depth))).toBe(shape === 'current' ? 3 : 4);
    if (shape === 'stress') { const siblings = geometry.nodes.filter(node => node.depth === 3); expect(siblings).toHaveLength(9); expect(new Set(siblings.map(node => node.y)).size).toBe(1); }
    for (const node of geometry.nodes) { expect(node.avatarWidth).toBeCloseTo(96, 0); expect(node.width).toBeCloseTo(144, 0); expect(node.height).toBeLessThanOrEqual(160); }
    for (const edge of geometry.edges) {
      const parent = geometry.nodes.find(node => node.id === edge.parent)!, child = geometry.nodes.find(node => node.id === edge.child)!;
      expect(child.y).toBeGreaterThan(parent.y + parent.height);
      expect(edge.start.x).toBeCloseTo(parent.x + parent.width / 2, 0); expect(edge.start.y).toBeCloseTo(parent.y + parent.height, 0);
      expect(edge.end.x).toBeCloseTo(child.x + child.width / 2, 0); expect(edge.end.y).toBeCloseTo(child.y, 0);
    }
    for (let i = 0; i < geometry.nodes.length; i++) for (let j = i + 1; j < geometry.nodes.length; j++) {
      const a = geometry.nodes[i], b = geometry.nodes[j];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    const output = process.env.TEST_REPORTING_SCREENSHOT_DIRECTORY;
    if (output) { mkdirSync(output, { recursive: true }); await page.screenshot({ path: resolve(output, `${label}-100.png`), fullPage: true }); }
    await page.getByRole('button', { name: 'Fit company at readable zoom', exact: true }).click();
    const fit = await page.evaluate(() => {
      const viewport = document.querySelector('.ca-company-map-viewport')!.getBoundingClientRect();
      const element = document.querySelector('.ca-company-map-viewport')!;
      return { gearAvatarDelta: Math.abs(document.querySelector('.ca-office-gear')!.getBoundingClientRect().left - document.querySelector('.ca-user-btn .chatroom-avatar')!.getBoundingClientRect().left), scale: Number((element as HTMLElement).dataset.scale), nameFont: parseFloat(getComputedStyle(document.querySelector('.ca-company-person-title strong')!).fontSize), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, viewport: { x: viewport.x, y: viewport.y, right: viewport.right, bottom: viewport.bottom }, nodes: [...document.querySelectorAll('.ca-company-map-node')].map(node => {
        const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }) };
    });
    expect(fit.nameFont * fit.scale).toBeGreaterThanOrEqual(12);
    if (width > 700) expect(fit.gearAvatarDelta).toBeLessThanOrEqual(6);
    if (shape === 'current' && width > 700) {
      expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 2); expect(fit.scrollHeight).toBeLessThanOrEqual(fit.clientHeight + 2);
      for (const node of fit.nodes) { expect(node.x).toBeGreaterThanOrEqual(fit.viewport.x); expect(node.y).toBeGreaterThanOrEqual(fit.viewport.y); expect(node.right).toBeLessThanOrEqual(fit.viewport.right); expect(node.bottom).toBeLessThanOrEqual(fit.viewport.bottom); }
    }
    if (output) { await page.screenshot({ path: resolve(output, `${label}-fit.png`), fullPage: true }); writeFileSync(resolve(output, `${label}-geometry.json`), JSON.stringify({ geometry, fit, errors }, null, 2)); }
    await page.locator('[data-employee-id="person-11"] [aria-label="Edit profile for Person 12"]').click();
    await page.locator('.ca-expert-profile').waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
