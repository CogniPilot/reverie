import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { runInNewContext } from 'node:vm';
import { registerPlansPageRoutes } from '../src/web/routes/plans-page-routes.js';
import { registerBoardPageRoutes } from '../src/web/routes/board-page-routes.js';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const publicDirectory = resolve(import.meta.dirname, '../src/web/public');
const companyHtml = readFileSync(resolve(publicDirectory, 'company-plans.html'), 'utf8');
const boardHtml = readFileSync(resolve(publicDirectory, 'board.html'), 'utf8');
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
const pages: JSDOM[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.window.close();
  for (const page of pages.splice(0)) page.window.close();
});

/** What the plans frame posts once its first load settled (the jsdom frame never loads by itself). */
const plansReady = (handle: any) => {
  const frame = handle.document.querySelector('#ca-company-plans iframe') as HTMLIFrameElement;
  handle.window.dispatchEvent(new handle.window.MessageEvent('message', { data: { type: 'company-plans-ready' }, source: frame.contentWindow, origin: handle.window.location.origin }));
};
const shell = async (hash = '') => {
  const handle = await createHarness({ hash, rooms: [room('room', 'General', [member('agent', 'Agent')])], sessions: [{ id: 'agent', name: 'Agent' }], company: { employees: [], settings: {} } });
  handles.push(handle);
  return handle;
};

describe('Company owns plans and burn rate', () => {
  it.each([
    { name: 'weekly rate with over a day left', rate: 4.1, hours: 48, sustainable: 3.2, period: 168, label: '688.8%/week', alternate: '4.1%/hr', multiple: '1.3×', tone: 'bad' },
    { name: 'hourly rate in the last day', rate: 4.1, hours: 24, sustainable: 3.2, period: 168, label: '4.1%/hr', alternate: '688.8%/week', multiple: '1.3×', tone: 'bad' },
    { name: 'exact landing pace', rate: 2, hours: 12, sustainable: 2, period: 168, label: '2%/hr', alternate: '336%/week', multiple: '1.0×', tone: 'good' },
    { name: 'slower than landing', rate: 1, hours: 72, sustainable: 2, period: 168, label: '168%/week', alternate: '1%/hr', multiple: '0.5×', tone: 'good' },
    { name: 'non-weekly period', rate: 1, hours: 72, sustainable: 2, period: 336, label: '336%/period', alternate: '1%/hr', multiple: '0.5×', tone: 'good' },
    { name: 'spent budget', rate: 2, hours: 0, sustainable: 0, period: 168, label: '2%/hr', alternate: '336%/week', multiple: '–', tone: 'muted' },
    { name: 'missing usage rate', rate: null, hours: 48, sustainable: null, period: 168, label: '–', alternate: 'No alternate-period rate available', multiple: '–', tone: 'muted' },
    { name: 'zero burn', rate: 0, hours: 48, sustainable: 2, period: 168, label: '0%/week', alternate: '0%/hr', multiple: '0.0×', tone: 'good' },
    { name: 'just over the day boundary', rate: 1, hours: 24.001, sustainable: 1, period: 168, label: '168%/week', alternate: '1%/hr', multiple: '1.0×', tone: 'good' },
    { name: 'missing period', rate: 1, hours: 48, sustainable: null, period: 0, label: '1%/hr', alternate: 'No alternate-period rate available', multiple: '–', tone: 'muted' },
    { name: 'non-finite rate', rate: Infinity, hours: 48, sustainable: 1, period: 168, label: '–', alternate: 'No alternate-period rate available', multiple: '–', tone: 'muted' },
  ])('shows landing units and sustainable-rate multiple: $name', ({ rate, hours, sustainable, period, label, alternate, multiple, tone }) => {
    const script = companyHtml.match(/<script>([\s\S]*)<\/script>/)![1];
    const helper = script.slice(script.indexOf('const num ='), script.indexOf('function planRisk('));
    const landing = runInNewContext(`${helper}; planLanding`, { H: 3600000 }) as (plan: object) => { rateLabel: string; rateTooltip: string; multipleLabel: string; tone: string };
    const result = landing({ rate, hoursToReset: hours, sustainablePctPerHour: sustainable, weekStart: 1000, reset: 1000 + period * 3600000 });
    expect(result.rateLabel).toBe(label);
    expect(result.rateTooltip).toContain(alternate);
    expect(result.multipleLabel).toBe(multiple);
    expect(result.tone).toBe(tone);
  });

  it('serves the page, aliases and shared stylesheet without caching', async () => {
    const app = Fastify();
    registerBoardPageRoutes(app, publicDirectory);
    registerPlansPageRoutes(app, publicDirectory);
    try {
      for (const url of ['/company/plans', '/company-plans.html', '/company-board.css']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-type']).toContain(url.endsWith('.css') ? 'text/css' : 'text/html');
      }
      for (const url of ['/plans', '/plans.html']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/#company-plans');
      }
    } finally { await app.close(); }
  });

  it('returns a clear uncached failure when the new page or styles are absent', async () => {
    const app = Fastify();
    registerBoardPageRoutes(app, resolve(publicDirectory, 'does-not-exist'));
    registerPlansPageRoutes(app, resolve(publicDirectory, 'does-not-exist'));
    try {
      for (const url of ['/company/plans', '/company-board.css']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    } finally { await app.close(); }
  });

  it('removes the Board plan UI and polling and header Company link while retaining the old anchor redirect', () => {
    expect(boardHtml).not.toContain('id="sec-burn"');
    expect(boardHtml).not.toContain('function planActions(');
    expect(boardHtml).not.toContain("fetch('/api/plans/allocations'");
    expect(boardHtml).not.toContain('href="/#company" target="_top"');
    expect(boardHtml).toContain("location.hash === '#sec-burn'");
    expect(companyHtml).toContain('id="sec-burn"');
    expect(companyHtml).toContain('setInterval(refreshPlanMembers, 5e3)');
    expect(companyHtml).toContain("'/api/plans/requests'");
  });

  it('keeps one Company entry and displays plans and people together beside the sidebar', async () => {
    const handle = await shell();
    expect(handle.document.querySelectorAll('.ca-office-nav')).toHaveLength(0);
    expect(handle.document.querySelector('.ca-user-org')).toBeNull();
    await handle.shell.openCompany();
    plansReady(handle);
    const page = handle.document.querySelector('.ca-company')!;
    expect(page.tagName).toBe('SECTION');
    expect(page.closest('.ca-page')).not.toBeNull();
    expect(page.querySelector('[role="tab"]')).toBeNull();
    expect((page.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
    expect((page.querySelector('#ca-company-people') as HTMLElement).hidden).toBe(false);
    expect(page.querySelector('#ca-company-plans iframe')!.getAttribute('src')).toBe('/company/plans');
  });

  it('opens old Company plans bookmarks on the unified page', async () => {
    const handle = await shell('#company-plans');
    await handle.flush(30);
    plansReady(handle);
    expect(handle.document.querySelector('iframe')!.getAttribute('src')).toBe('/company/plans');
    expect((handle.document.querySelector('#ca-company-people') as HTMLElement).hidden).toBe(false);
    expect(handle.document.querySelector('[role="tablist"]')).toBeNull();
  });

  it('keeps owner-only plan controls unavailable when the feed has no plan visibility', async () => {
    const page = new JSDOM(companyHtml, { url: 'http://localhost/company/plans', runScripts: 'outside-only', pretendToBeVisual: true });
    pages.push(page);
    const calls: string[] = [];
    Object.assign(page.window, {
      fetch: async (path: string) => {
        calls.push(path);
        return { ok: true, status: 200, json: async () => ({ success: true, data: { built: Date.now(), issues: [], company: {}, timeZone: 'UTC' } }) };
      },
      matchMedia: () => ({ matches: false }),
      setInterval: () => 1,
    });
    page.window.eval(companyHtml.match(/<script>([\s\S]*)<\/script>/)![1]);
    await new Promise((done) => setTimeout(done, 10));
    expect(page.window.document.getElementById('plans')!.textContent).toContain('owner only');
    expect(page.window.document.getElementById('addAcct')!.hidden).toBe(true);
    expect(page.window.document.getElementById('planMoveHistory')!.hidden).toBe(true);
    expect(calls).toEqual(['/api/board']);
  });

  it('redraws burn charts immediately when the Company theme changes', async () => {
    const page = new JSDOM(companyHtml, { url: 'http://localhost/company/plans', runScripts: 'outside-only', pretendToBeVisual: true });
    pages.push(page);
    const now = Date.now();
    const errors: string[] = [];
    page.window.addEventListener('error', event => { errors.push(event.message); event.preventDefault(); });
    Object.assign(page.window, {
      fetch: async (path: string) => ({ ok: true, status: 200, json: async () => ({ success: true, data: path === '/api/board' ? {
        built: now, issues: [], company: {}, timeZone: 'UTC',
        planBurn: [{ id: 'plan-one', name: 'Test plan', used: 20, rate: 0.5, proj: 70, sustainablePctPerHour: 0.4, hoursToReset: 144, runsOut: now + 3600000, weekStart: now - 86400000, reset: now + 6 * 86400000, points: [{ t: now, used: 20 }] }],
      } : { accounts: [], employees: [] } }) }),
      matchMedia: () => ({ matches: false }),
      setInterval: () => 1,
    });
    page.window.eval(companyHtml.match(/<script>([\s\S]*)<\/script>/)![1]);
    await new Promise(done => setTimeout(done, 10));
    const previousChart = page.window.document.getElementById('burn0');
    expect(previousChart?.querySelector('polyline')).not.toBeNull();
    expect(page.window.document.querySelector('.stats')!.firstElementChild!.className).toBe('plan-projection');
    expect(page.window.document.querySelector('.stats')!.children[1].className).toBe('plan-runout');
    expect(page.window.document.querySelector('.plan-landing b')!.textContent).toBe('1.3×');
    expect(page.window.document.querySelector('.plan-rate b')!.textContent).toBe('84%/week');
    (page.window.document.getElementById('theme') as HTMLButtonElement).click();
    expect(errors).toEqual([]);
    expect(page.window.document.documentElement.dataset.theme).toBe('dark');
    expect(page.window.localStorage.getItem('board-theme')).toBe('dark');
    const currentChart = page.window.document.getElementById('burn0');
    expect(currentChart).not.toBe(previousChart);
    expect(currentChart?.querySelector('polyline')).not.toBeNull();
    (page.window.document.getElementById('theme') as HTMLButtonElement).click();
    expect(errors).toEqual([]);
    expect(page.window.document.documentElement.dataset.theme).toBe('light');
    expect(page.window.document.getElementById('burn0')).not.toBe(currentChart);
  });

  it.each([true, false])('does not refresh usage when the document or Company frame is hidden (document=%s)', async (hidden) => {
    const calls: string[] = [];
    const body = companyHtml.slice(companyHtml.indexOf('async function load() {'), companyHtml.indexOf('function renderPlansPage() {'));
    const load = runInNewContext(`${body}; load`, {
      B: { issues: [] }, TZ: 'UTC', failures: 0,
      document: { hidden, getElementById: () => ({}) },
      window: { frameElement: hidden ? null : { getClientRects: () => [] } },
      fetch: async (path: string) => { calls.push(path); return { ok: true, json: async () => ({ issues: [] }) }; },
      renderPlansPage: () => {}, refreshPlanMembers: () => {},
    }) as () => Promise<void>;
    await load();
    expect(calls).toEqual([]);
  });

  it('keeps plans visible while company data loads and adds people without a tab switch', async () => {
    const handle = await shell();
    const previous = handle.app._chatApi.bind(handle.app);
    let complete!: (value: unknown) => void;
    handle.app._chatApi = async (path: string, options: unknown) => path === '/api/company' ? new Promise(resolve => { complete = resolve; }) : previous(path, options);
    const pending = handle.shell.openCompany();
    const frame = handle.document.querySelector('#ca-company-plans iframe');
    expect(frame).not.toBeNull();
    complete({ ok: true, data: { employees: [], settings: {} } });
    await pending;
    plansReady(handle);
    expect(handle.document.querySelector('#ca-company-plans iframe')).toBe(frame);
    expect((handle.document.querySelector('#ca-company-people') as HTMLElement).hidden).toBe(false);
  });

  it('keeps Hire available alongside plans and scrolls the revealed form into view', async () => {
    const handle = await shell();
    const previous = handle.app._chatApi.bind(handle.app);
    handle.app._chatApi = async (path: string, options: unknown) => {
      if (path === '/api/company') return { ok: true, data: { canManage: true, employees: [], settings: {} } };
      if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
      if (path === '/api/company/hire-options') return { ok: true, data: {
        sources: [{ kind: 'subscription', id: 'work', label: 'Work', modes: ['codex'], defaultMode: 'codex' }],
        harnesses: [{ id: 'codex', label: 'Codex', efforts: [] }],
      } };
      return previous(path, options);
    };
    await handle.shell.openCompany();
    const hire = handle.document.querySelector('[aria-controls="ca-company-hire"]') as HTMLButtonElement;
    expect(hire.hidden).toBe(false);
    hire.click();
    expect((handle.document.querySelector('.ca-company-hire') as HTMLElement).hidden).toBe(false);
    expect(handle.document.activeElement).toBe(handle.document.querySelector('.ca-company-hire [name="roleTemplate"]'));
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
  });

});
