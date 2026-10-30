import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

function render(blockers: object[]) {
  const html = readFileSync(new URL('../src/web/public/board.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const start = script.indexOf('/* ---------- Lists ---------- */');
  const end = script.indexOf('/* ---------- Waiting on you');
  const dom = new JSDOM('<ul id="wins"></ul><ul id="blockers"></ul><ul id="pins"></ul>');
  windows.push(dom);
  const context = vm.createContext({ document: dom.window.document, B: { wins: [], blockers, pins: [] },
    startOfDay: () => 0, hm: () => '09:00', dayLbl: () => 'Mon, 1 Jan', nameOf: (who: string) => who, css: (name: string) => `var(${name})` });
  new vm.Script(`${/const esc = .*/.exec(script)![0]}\n${script.slice(start, end)}\nlists();`).runInContext(context);
  return dom.window.document;
}

it('labels every blocker severity bar with text, not colour alone', () => {
  const doc = render([
    { text: 'Release key missing', sev: 'high', who: 'a', owner: 'b', since: 1 },
    { text: 'Slow CI', sev: 'low', who: 'a', owner: 'b', since: 1 },
    { text: 'Unrated', sev: '<img src=x>', who: 'a', owner: 'b', since: 1 },
  ]);
  const bars = [...doc.querySelectorAll('#blockers .sev')];
  expect(bars.map(bar => bar.getAttribute('role'))).toEqual(['img', 'img', 'img']);
  expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['High severity', 'Low severity', 'Severity not set']);
  expect(bars.map(bar => bar.getAttribute('title'))).toEqual(['High severity', 'Low severity', 'Severity not set']);
  expect(doc.querySelector('img')).toBeNull();
});

it('uses the fallback for inherited property names such as constructor', () => {
  const doc = render(['med', 'constructor', '__proto__', 'toString'].map(sev => ({ text: 'Held', sev, who: 'a', owner: 'b', since: 1 })));
  const bars = [...doc.querySelectorAll('#blockers .sev')];
  expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['Medium severity', 'Severity not set', 'Severity not set', 'Severity not set']);
  expect(bars.map(bar => bar.getAttribute('title'))).toEqual(['Medium severity', 'Severity not set', 'Severity not set', 'Severity not set']);
  expect(bars.map(bar => bar.getAttribute('style'))).toEqual(['background:var(--warn)', 'background:var(--plan)', 'background:var(--plan)', 'background:var(--plan)']);
});
