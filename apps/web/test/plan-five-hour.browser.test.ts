import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
it.each([{label:'desktop',width:1440,height:900},{label:'mobile',width:390,height:844}])('keeps actual current 5-hour quota in a separate vertical inset beside weekly history ($label)',async({label,width,height})=>{
 const html=readFileSync(resolve(import.meta.dirname,'../src/web/public/company-plans.html'),'utf8');const css=readFileSync(resolve(import.meta.dirname,'../src/web/public/company-board.css'),'utf8');const now=Date.now();
 const rows=[25,0,100,null].map((used,i)=>({id:'p'+i,name:['Current','Empty window','Limit reached','Unavailable'][i],provider:'anthropic',signedIn:true,used:70,rate:.5,proj:90,weekStart:now-864e5,reset:now+6*864e5,at:now,points:[{t:now,used:70}],fiveHour:{used,reset:now+2*3600e3,asOf:now-60000,stale:false}}));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 try {
  const page=await browser.newPage({viewport:{width,height}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/'))return route.fulfill({json:{success:true,data:path==='/api/board'?{built:now,issues:[],company:{},timeZone:'UTC',planBurn:rows}:{accounts:[],employees:[]}}});return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/html',body:path.endsWith('.css')?css:html});});
  await page.goto('https://owned-plans-fixture.test/company/plans');await page.waitForSelector('.five-hour-used');
  expect(await page.locator('.plan-five-hour').count()).toBe(4);expect(await page.locator('.five-hour-used').first().getAttribute('fill')).not.toBe('');expect(await page.locator('.five-hour-used').count()).toBe(3);
  const geometry=await page.evaluate(()=>[...document.querySelectorAll('.plan')].map(plan=>{const box=plan.getBoundingClientRect(),weekly=plan.querySelector('.plan-weekly-plot')!.getBoundingClientRect(),meter=plan.querySelector('.plan-five-hour')!.getBoundingClientRect(),svg=plan.querySelector('.plan-five-hour svg');return {left:box.left,right:box.right,weeklyRight:weekly.right,meterLeft:meter.left,meterRight:meter.right,maximum:svg?.querySelector('.five-hour-maximum')?.getAttribute('y1'),current:svg?.querySelector('.five-hour-current')?.getAttribute('y1'),label:svg?.getAttribute('aria-label'),historyLines:svg?.querySelectorAll('polyline,.projection').length??0};}));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  for(const row of geometry){expect(row.left).toBeGreaterThanOrEqual(0);expect(row.right).toBeLessThanOrEqual(width);expect(row.weeklyRight).toBeLessThan(row.meterLeft);expect(row.meterRight).toBeLessThanOrEqual(width);expect(row.historyLines).toBe(0);}
  expect(geometry[0].label).toContain('25% used, 75% remaining; maximum 100%');expect(Number(geometry[0].current)).toBeGreaterThan(Number(geometry[0].maximum));expect(geometry[2].current).toBe(geometry[2].maximum);expect(geometry[3].label).toBeUndefined();
  expect(errors).toEqual([]);const output=process.env.TEST_FIVE_HOUR_SCREENSHOT_DIRECTORY;if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,label+'.png'),fullPage:true});writeFileSync(resolve(output,label+'-geometry.json'),JSON.stringify({geometry,errors},null,2));}
 } finally {await browser.close();}
});
