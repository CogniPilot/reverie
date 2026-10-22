import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';

const publicDirectory = new URL('../src/web/public/', import.meta.url);
const styles = readFileSync(new URL('company-board.css', publicDirectory), 'utf8');

it('centers Board button links without an underline or a global Plans style change', () => {
  const declarations = new Map<string, string>();
  postcss.parse(styles).walkRules(rule => {
    if (rule.selector !== '.board-page a.btn') return;
    rule.walkDecls(declaration => { declarations.set(declaration.prop, declaration.value); });
  });
  expect(declarations.get('text-decoration')).toBe('none');
  expect(declarations.get('display')).toBe('inline-flex');
  expect(declarations.get('align-items')).toBe('center');
});

it('uses safe-area-aware 24px Board gutters without widening standalone Plans', () => {
  const rules = postcss.parse(styles);
  const scoped = new Map<string, string>();
  let defaultWidth = '';
  rules.walkRules(rule => {
    if (rule.selector === '.board-page .wrap') {
      rule.walkDecls(declaration => { scoped.set(declaration.prop, declaration.value); });
    }
    if (rule.selector === '.wrap') {
      rule.walkDecls('max-width', declaration => { defaultWidth = declaration.value; });
    }
  });
  expect(defaultWidth).toBe('1400px');
  expect(scoped.get('max-width')).toBe('none');
  expect(scoped.get('margin-inline')).toBe('0');
  expect(scoped.get('padding-left')).toBe('max(24px,env(safe-area-inset-left,0px))');
  expect(scoped.get('padding-right')).toBe('max(24px,env(safe-area-inset-right,0px))');
});

it.each([
  ['company-plans.html', '', '1400px'],
  ['board.html', '', 'none'],
  ['company-plans.html', 'ca-company-plans-frame', 'none'],
  ['company-plans.html', 'unrelated-frame', '1400px'],
])('uses the intended content-width cap on %s inside %s', (page, frameClass, width) => {
  const html = readFileSync(new URL(page, publicDirectory), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/company/plans', runScripts: 'outside-only' });
  try {
    if (frameClass) {
      const frame = dom.window.document.createElement('iframe');
      frame.className = frameClass;
      Object.defineProperty(dom.window, 'frameElement', { value: frame });
    }
    if (page === 'company-plans.html') {
      const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
      dom.window.eval(script.slice(0, script.indexOf('const H =')));
    }
    const style = dom.window.document.createElement('style');
    style.textContent = styles;
    dom.window.document.head.append(style);
    expect(dom.window.getComputedStyle(dom.window.document.querySelector('.wrap')!).maxWidth).toBe(width);
    expect(dom.window.getComputedStyle(dom.window.document.querySelector('.grid2')!).gridTemplateColumns).toContain(frameClass === 'ca-company-plans-frame' ? '360px' : '300px');
    expect(dom.window.document.documentElement.dataset.companyPlansEmbedded).toBe(frameClass === 'ca-company-plans-frame' ? 'true' : undefined);
  } finally { dom.window.close(); }
});
