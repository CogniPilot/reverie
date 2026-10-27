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


it.each([
  { name: 'dark Company skin on a light system', skin: 'daylight-blue', systemDark: false, expected: 'dark' },
  { name: 'green Company skin', skin: 'daylight-green', systemDark: false, expected: 'dark' },
  { name: 'original dark Company skin', skin: 'og', systemDark: false, expected: 'dark' },
  ...['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn'].map(skin => ({ name: skin, skin, systemDark: true, expected: 'light' })),
  { name: 'explicit saved light overrides dark Company skin', skin: 'daylight-blue', saved: 'light', systemDark: true, expected: 'light' },
  { name: 'explicit saved dark overrides light Company skin', skin: 'paper-gray', saved: 'dark', systemDark: false, expected: 'dark' },
  { name: 'disabled storage retains Company theme', skin: 'daylight-blue', blocked: true, systemDark: false, expected: 'dark' },
  { name: 'invalid saved theme is ignored', skin: 'paper-gray', saved: 'invalid', systemDark: true, expected: 'light' },
  { name: 'standalone dark system', standalone: true, systemDark: true, expected: 'dark' },
  { name: 'standalone saved dark on light system', standalone: true, saved: 'dark', systemDark: false, expected: 'dark' },
  { name: 'standalone storage unavailable', standalone: true, blocked: true, systemDark: false, expected: 'light' },
])('resolves first-paint state before the body script: $name', (input: any) => {
  const html = readFileSync(new URL('company-plans.html', publicDirectory), 'utf8');
  // Stop the response before the existing body script: the visible header has already parsed.
  const prefix = html.slice(0, html.indexOf('<script>'));
  let writes = 0;
  const dom = new JSDOM(prefix, {
    url: 'http://localhost/company/plans', runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'frameElement', { value: input.standalone ? null : {
        classList: { contains: (name: string) => name === 'ca-company-plans-frame' },
        ownerDocument: { documentElement: { dataset: { skin: input.skin } } },
      } });
      Object.defineProperty(window, 'localStorage', { value: {
        getItem: () => { if (input.blocked) throw new Error('storage disabled'); return input.saved || null; },
        setItem: () => { writes++; },
      } });
      window.matchMedia = (() => ({ matches: !!input.systemDark })) as any;
    },
  });
  try {
    expect(dom.window.document.documentElement.dataset.theme).toBe(input.expected);
    expect(dom.window.document.documentElement.dataset.companyPlansEmbedded).toBe(input.standalone ? undefined : 'true');
    expect(writes).toBe(0);
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).colorScheme).toBe(input.expected);
    const external = dom.window.document.createElement('style'); external.textContent = styles; dom.window.document.head.append(external);
    expect(dom.window.getComputedStyle(dom.window.document.querySelector('.wrap > header')!).display).toBe(input.standalone ? 'flex' : 'none');
  } finally { dom.window.close(); }
});


it('retains one height reporter and a working Theme button after the early bootstrap', async () => {
  const html = readFileSync(new URL('company-plans.html', publicDirectory), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/company/plans', runScripts: 'outside-only', pretendToBeVisual: true });
  let observers = 0;
  try {
    const frame = dom.window.document.createElement('iframe'); frame.className = 'ca-company-plans-frame';
    Object.defineProperty(dom.window, 'frameElement', { value: frame });
    Object.assign(dom.window, {
      ResizeObserver: class { constructor() { observers++; } observe() {} },
      matchMedia: () => ({ matches: false }),
      setInterval: () => 1,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { built: Date.now(), issues: [], company: {}, timeZone: 'UTC' } }) }),
    });
    dom.window.localStorage.setItem('board-theme', 'dark');
    for (const script of dom.window.document.querySelectorAll('script')) dom.window.eval(script.textContent!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observers).toBe(1);
    (dom.window.document.querySelector('#theme') as HTMLButtonElement).click();
    expect(dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(dom.window.localStorage.getItem('board-theme')).toBe('light');
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).colorScheme).toBe('light');
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).backgroundColor).toBe('rgb(244, 243, 239)');
  } finally { dom.window.close(); }
});
