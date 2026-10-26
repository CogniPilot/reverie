import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
const html=readFileSync(new URL('../src/web/public/company-plans.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('function fiveHourCard(p)'),html.indexOf('function plans()'));
const NOW=Date.UTC(2026,9,26,20);
function render(reading?:unknown) {
 const draw=runInNewContext(helper+';fiveHourCard',{Date:{now:()=>NOW},Number,Math,css:()=> '#789',fmt:(t:number)=>new Intl.DateTimeFormat('en-US',{dateStyle:'short',timeStyle:'short',timeZone:'UTC'}).format(t),esc:(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))});
 const dom=new JSDOM(draw({fiveHour:reading,used:95,points:[{t:NOW,used:95}]}));return dom.window.document;
}
it.each([0,40,100])('shows actual %s%% five-hour use against its own 100%% maximum',used=>{
 const doc=render({used,reset:NOW+3600000,asOf:NOW-60000,stale:false});
 expect(Number(doc.querySelector('.five-hour-used')!.getAttribute('height'))).toBe(78*used/100);
 expect(doc.body.textContent).toContain(`${100-used}% remaining`);expect(doc.body.textContent).toContain('100% maximum');
 expect(doc.querySelector('svg')!.getAttribute('aria-label')).toContain('No five-hour usage history is shown');
 expect(doc.querySelectorAll('polyline,.projection')).toHaveLength(0);expect(doc.querySelector('.five-hour-maximum')!.getAttribute('y1')).toBe('26');
});
it.each([undefined,{used:null},{used:-1},{used:101},{used:Infinity},{used:'40'}])('does not substitute weekly history or a fabricated quota for unavailable data %j',reading=>{
 const doc=render(reading);expect(doc.body.textContent).toContain('Usage unavailable');expect(doc.querySelector('svg')).toBeNull();expect(doc.body.textContent).not.toContain('95%');
});
it('retains a past-reset reading visibly as historical rather than assuming a refill',()=>{
 const doc=render({used:80,reset:NOW-1,asOf:NOW-3600000,stale:false});
 expect(doc.body.textContent).toContain('80% used');expect(doc.body.textContent).toContain('Last reported');expect(doc.body.textContent).toContain('Refresh required');
});
it('keeps valid usage with unavailable reset and separately identifies a stale provider reading',()=>{
 const doc=render({used:10,reset:null,asOf:null,stale:true});expect(doc.body.textContent).toContain('Reset time unavailable');expect(doc.querySelector('svg')!.getAttribute('aria-label')).toContain('Reading time unavailable');expect(doc.querySelector('.five-hour-used')!.getAttribute('opacity')).toBe('.45');
});

it.each([1e20,1e308,Infinity,NaN])('keeps invalid Date-range reset/as-of values unavailable without breaking real formatting (%s)', invalid=>{
 const doc=render({used:25,reset:invalid,asOf:invalid,stale:false});
 expect(doc.body.textContent).toContain('25% used');expect(doc.body.textContent).toContain('Reset time unavailable');
 expect(doc.querySelector('svg')!.getAttribute('aria-label')).toContain('Reading time unavailable');
});
it('accepts the maximum finite ECMAScript timestamp without a date formatter exception',()=>{
 const doc=render({used:25,reset:8.64e15,asOf:8.64e15,stale:false});
 expect(doc.body.textContent).toContain('25% used');expect(doc.body.textContent).not.toContain('Reset time unavailable');
});
