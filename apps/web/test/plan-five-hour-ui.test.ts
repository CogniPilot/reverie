import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
const html=readFileSync(new URL('../src/web/public/company-plans.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('function burnChart(svg, p)'),html.indexOf("document.getElementById('refresh').onclick"));
const NOW=Date.UTC(2026,9,26,20),DAY=864e5,HOUR=36e5,START=NOW-DAY,END=NOW+6*DAY;
function render(reading?:unknown,extra:Record<string,unknown>={}) {
 const draw=runInNewContext(helper+';burnChart',{Date:{now:()=>NOW},Number,Math,css:(x:string)=>x,fmt:(t:number)=>new Intl.DateTimeFormat('en-US',{dateStyle:'short',timeStyle:'short',timeZone:'UTC'}).format(t),esc:(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)),planRisk:()=> 'good',startOfDay:(t:number)=>Math.floor(t/DAY)*DAY,D:DAY,H:HOUR});
 const dom=new JSDOM('<div><svg></svg><div class="plan-five-hour-status"></div></div>');const doc=dom.window.document;
 draw(doc.querySelector('svg'),{fiveHour:reading,used:95,rate:.1,at:NOW,weekStart:START,reset:END,points:[{t:NOW-HOUR,used:90},{t:NOW,used:95}],...extra});return doc;
}
it.each([0,40,100])('plots actual %s%% reading plus horizontal cap and real reset time on the weekly chart',used=>{
 const reset=NOW+2*HOUR,asOf=NOW-60000,doc=render({used,reset,asOf,stale:false});const svg=doc.querySelector('svg')!;
 const cap=svg.querySelector('.five-hour-cap')!,line=svg.querySelector('.five-hour-reset')!,point=svg.querySelector('.five-hour-reading')!;
 expect(Number(cap.getAttribute('y1'))).toBeCloseTo(8+(1-100/110)*94);expect(cap.getAttribute('y1')).toBe(cap.getAttribute('y2'));
 expect(Number(line.getAttribute('x1'))).toBeCloseTo(28+(reset-START)/(END-START)*284);expect(line.getAttribute('x1')).toBe(line.getAttribute('x2'));
 expect(Number(point.getAttribute('cx'))).toBeCloseTo(28+(asOf-START)/(END-START)*284);expect(Number(point.getAttribute('cy'))).toBeCloseTo(8+(1-used/110)*94);
 expect(doc.body.textContent).toContain(`${100-used}% remaining`);expect(svg.getAttribute('aria-label')).toContain('100% cap');expect(svg.getAttribute('aria-label')).toContain('percentages of their own window limits');
 expect(svg.querySelectorAll('.five-hour-markers polyline,.five-hour-markers polygon,.five-hour-markers rect')).toHaveLength(0);expect(svg.querySelectorAll('polyline')).toHaveLength(1);expect(svg.querySelector('polyline')!.getAttribute('points')).toContain('68.6');
 expect(doc.querySelectorAll('svg')).toHaveLength(1);
});
it.each([undefined,{used:null},{used:-1},{used:101},{used:Infinity},{used:'40'}])('does not substitute weekly use or fabricated 5h history for unavailable data %j',reading=>{
 const doc=render(reading);expect(doc.querySelector('.plan-five-hour-status')!.textContent).toContain('usage unavailable');expect(doc.querySelector('.five-hour-reading')).toBeNull();expect(doc.querySelector('.five-hour-markers')).toBeNull();expect(doc.querySelector('polyline')).not.toBeNull();
});
it('retains expired readings at their actual time and dims them without assuming a refill',()=>{
 const doc=render({used:80,reset:NOW-1,asOf:NOW-HOUR,stale:false});expect(doc.body.textContent).toContain('80% used');expect(doc.body.textContent).toContain('Last reported; refresh required');expect(doc.querySelector('.five-hour-markers')!.getAttribute('opacity')).toBe('.5');expect(doc.querySelector('.five-hour-reading')).not.toBeNull();
});
it('does not invent a reading position when only its timestamp is unavailable',()=>{
 const doc=render({used:10,reset:null,asOf:null,stale:true});expect(doc.body.textContent).toContain('Reset time unavailable');expect(doc.body.textContent).toContain('Reading time unavailable');expect(doc.querySelector('.five-hour-cap')).not.toBeNull();expect(doc.querySelector('.five-hour-reading')).toBeNull();expect(doc.querySelector('.five-hour-reset')).toBeNull();
});
it.each([START-HOUR,END+HOUR])('reports reset outside the plotted interval without clamping a fake vertical line (%s)',reset=>{
 const doc=render({used:25,reset,asOf:NOW});expect(doc.body.textContent).toContain('outside plotted week');expect(doc.querySelector('.five-hour-reset')).toBeNull();expect(doc.querySelector('.five-hour-reset-outside')).toBeNull();
});
it.each([1e20,1e308,Infinity,NaN])('rejects invalid Date-range reset/as-of without breaking real formatting (%s)',invalid=>{
 const doc=render({used:25,reset:invalid,asOf:invalid,stale:false});expect(doc.body.textContent).toContain('25% used');expect(doc.body.textContent).toContain('Reset time unavailable');expect(doc.body.textContent).toContain('Reading time unavailable');expect(doc.querySelector('.five-hour-reset')).toBeNull();expect(doc.querySelector('.five-hour-reading')).toBeNull();
});
it('accepts the maximum ECMAScript timestamp as out of view without a formatter exception',()=>{
 const doc=render({used:25,reset:8.64e15,asOf:8.64e15,stale:false});expect(doc.body.textContent).toContain('25% used');expect(doc.body.textContent).not.toContain('Reset time unavailable');expect(doc.querySelector('.five-hour-reading')).toBeNull();
});
it('keeps the real reading visible as text when the weekly time range is unavailable',()=>{
 const doc=render({used:25,reset:NOW+HOUR,asOf:NOW},{weekStart:null,reset:null});expect(doc.body.textContent).toContain('Weekly time range unavailable');expect(doc.body.textContent).toContain('25% used');expect(doc.querySelector('.five-hour-reset')).toBeNull();expect(doc.querySelector('.five-hour-reading')).toBeNull();
});
it('keeps weekly history and projection byte-identical when a five-hour snapshot is added',()=>{
 const absent=render(),present=render({used:25,reset:NOW+HOUR,asOf:NOW});for(const selector of ['polyline','polygon','.projection','.nominal'])expect(present.querySelector(selector)!.outerHTML).toBe(absent.querySelector(selector)!.outerHTML);
});
