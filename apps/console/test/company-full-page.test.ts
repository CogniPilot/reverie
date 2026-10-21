import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.window.close();
});

async function fixture(extraEmployees: object[] = []) {
  const employee = { id: 'employee-one', sessionId: 'current-session', name: 'Reviewer', position: 'Engineer', available: true, reportsTo: 'owner', icon: 'R' };
  const company = { employees: [employee, ...extraEmployees], settings: { ownerName: 'Owner name' }, canManage: false };
  const handle = await createHarness({ rooms: [room('room', 'General', [member(employee.sessionId, employee.name)])], sessions: [{ id: employee.sessionId, name: employee.name }], company });
  handles.push(handle);
  const now = Date.now();
  const board = {
    roster: [{ id: employee.id, sessionId: 'retired-session', state: 'running' }],
    agents: { [employee.id]: { focus: '<img src=x onerror=alert(1)> Reviewing the map', receipts: ['tests passed'] } },
    issues: [
      { id: 'done', owner: employee.id, status: 'done', end: now },
      { id: 'planned', owner: employee.id, status: 'todo', end: now },
      { id: 'refused', owner: employee.id, status: 'wontdo', end: now },
      { id: 'other-owner', owner: 'someone-else', status: 'done', end: now },
    ],
    timeZone: 'UTC',
    pace: { owners: { [employee.id]: { overdue: 2, overdueHours: 3.2, early: 4, verdict: 'behind' } } },
  };
  const previous = handle.app._chatApi.bind(handle.app);
  const boardRead = vi.fn(async () => ({ ok: true, data: board }));
  handle.app._chatApi = (path: string, options: unknown) => path === '/api/board' ? boardRead() : previous(path, options);
  return { handle, employee, company, board, boardRead };
}

describe('Company is a page with one People home', () => {
  it('keeps the sidebar outside the page, defaults to Plans, and creates no Company dialog', async () => {
    const { handle, boardRead } = await fixture();
    await handle.shell.openCompany();
    const page = handle.document.querySelector('.ca-page')!;
    expect(page.contains(handle.document.querySelector('.ca-side'))).toBe(false);
    expect(handle.document.querySelector('dialog.ca-company')).toBeNull();
    expect(handle.document.querySelector('[aria-label="Company sections"]')!.firstElementChild!.getAttribute('data-section')).toBe('plans');
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
    expect(handle.document.querySelector('#ca-company-plans iframe')!.getAttribute('src')).toBe('/company/plans');
    expect(handle.document.querySelector('.ca-company-nav')!.getAttribute('aria-current')).toBe('page');
    expect(handle.document.querySelector('.ca-root')!.classList.contains('is-page')).toBe(true);
    expect(boardRead).not.toHaveBeenCalled();
  });

  it('merges employee identity, reporting, ring, current work and pace by employee id, not session', async () => {
    const { handle, boardRead } = await fixture();
    await handle.shell.openCompany('people');
    await handle.flush();
    const cards = handle.document.querySelectorAll('.ca-company-person');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.ca-company-role')!.textContent).toBe('Engineer');
    expect(cards[0].querySelector('.ca-company-parent')!.textContent).toBe('Owner name');
    expect(cards[0].querySelector('.ca-company-live-state')!.textContent).toBe('Working');
    expect(cards[0].querySelector('.ca-company-ring')!.getAttribute('aria-label')).toBe('Today: 1 of 2 planned issues done');
    expect(cards[0].querySelector('.ca-company-ring')!.textContent).toBe('1/2');
    expect(cards[0].querySelector('.ca-company-pace')!.textContent).toBe('Behind');
    expect(cards[0].querySelector('.ca-company-counts')!.textContent).toBe('2 overdue (3h) · 4 early · 1/2 2-wk items');
    expect(cards[0].querySelector('.ca-company-focus')!.textContent).toContain('<img src=x');
    expect(cards[0].querySelector('.ca-company-focus img')).toBeNull();
    expect(cards[0].querySelector('.ca-company-receipts')!.textContent).toBe('tests passed');
    expect(boardRead).toHaveBeenCalledOnce();
  });

  it('renders each employee exactly once in reporting order, including cycles and missing managers', async () => {
    const { handle } = await fixture([
      { id: 'child', name: 'Child', reportsTo: 'employee-one' },
      { id: 'orphan', name: 'Missing manager', reportsTo: 'missing' },
      { id: 'cycle-one', name: 'Cycle one', reportsTo: 'cycle-two' },
      { id: 'cycle-two', name: 'Cycle two', reportsTo: 'cycle-one' },
    ]);
    await handle.shell.openCompany('people');
    const cards = [...handle.document.querySelectorAll('.ca-company-person')] as HTMLElement[];
    expect(cards).toHaveLength(5);
    expect(new Set(cards.map(card => card.dataset.employeeId)).size).toBe(5);
    expect(cards[0].closest('li')!.querySelector(':scope > ul > li > .ca-company-person')!.getAttribute('data-employee-id')).toBe('child');
    expect(handle.document.querySelectorAll('.ca-company-chart .ca-company-person')).toHaveLength(5);
  });

  it('honors the company People bookmark and tab history without an overlay', async () => {
    const { handle } = await fixture();
    handle.shell.openPage('company-people');
    await handle.flush();
    expect(handle.window.location.hash).toBe('#company-people');
    expect((handle.document.querySelector('#ca-company-people') as HTMLElement).hidden).toBe(false);
    (handle.document.querySelector('[data-section="plans"]') as HTMLElement).click();
    expect(handle.window.location.hash).toBe('#company');
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
    (handle.document.querySelector('[data-section="people"]') as HTMLElement).click();
    expect(handle.window.location.hash).toBe('#company-people');
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(true);
    handle.window.history.replaceState({}, '', '#board');
    handle.shell.openPage('company-people', { push: false });
    expect(handle.window.location.hash).toBe('#board');
  });

  it('keeps Company keyboard Home on Plans and End on People', async () => {
    const { handle } = await fixture();
    await handle.shell.openCompany();
    const plans = handle.document.querySelector('[data-section="plans"]')!;
    plans.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(handle.document.activeElement!.id).toBe('ca-company-tab-people');
    handle.document.activeElement!.dispatchEvent(new handle.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(handle.document.activeElement!.id).toBe('ca-company-tab-plans');
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
  });

  it('shows unavailable rather than invented work values after an authorization refusal', async () => {
    const { handle, boardRead } = await fixture();
    boardRead.mockResolvedValue({ ok: false, data: undefined as never });
    await handle.shell.openCompany('people');
    await handle.flush();
    expect(handle.document.querySelector('.ca-company-person')!.textContent).toContain('Engineer');
    expect(handle.document.querySelector('.ca-company-work')!.textContent).toContain('Work status unavailable');
    expect(handle.document.querySelector('.ca-company-ring')).toBeNull();
    expect(handle.document.querySelector('.ca-company-counts')).toBeNull();
  });

  it('refreshes visible People without repainting the hire form and pauses on Plans or a hidden document', async () => {
    const { handle, board, boardRead } = await fixture();
    await handle.shell.openCompany('people');
    await handle.flush();
    const card = handle.document.querySelector('.ca-company-person');
    board.agents['employee-one'].focus = 'New focus';
    await handle.shell._companyRefresh();
    expect(handle.document.querySelector('.ca-company-person')).toBe(card);
    expect(handle.document.querySelector('.ca-company-focus')!.textContent).toBe('New focus');
    expect(boardRead).toHaveBeenCalledTimes(2);
    (handle.document.querySelector('[data-section="plans"]') as HTMLElement).click();
    await handle.shell._companyRefresh();
    expect(boardRead).toHaveBeenCalledTimes(2);
    Object.defineProperty(handle.document, 'hidden', { value: true, configurable: true });
    (handle.document.querySelector('[data-section="people"]') as HTMLElement).click();
    await handle.shell._companyRefresh();
    expect(boardRead).toHaveBeenCalledTimes(2);
    Object.defineProperty(handle.document, 'hidden', { value: false, configurable: true });
    await handle.shell._companyRefresh();
    expect(boardRead).toHaveBeenCalledTimes(3);
  });

  it('clears its refresh interval when returning to chat or switching to Board', async () => {
    const { handle } = await fixture();
    const clear = vi.spyOn(handle.window, 'clearInterval');
    await handle.shell.openCompany();
    const first = handle.shell._companyTimer;
    handle.shell.closePage();
    expect(clear).toHaveBeenCalledWith(first);
    expect(handle.shell.companyPage).toBeNull();
    expect(handle.shell._companyRefresh).toBeNull();
    expect(handle.document.querySelector('.ca-company')).toBeNull();
    expect(handle.window.location.hash).toBe('');
    await handle.shell.openCompany();
    const second = handle.shell._companyTimer;
    handle.shell.openPage('board');
    expect(clear).toHaveBeenCalledWith(second);
    expect(handle.document.querySelector('.ca-page iframe')!.getAttribute('src')).toBe('/board');
  });

  it('ignores a late company response after navigation and never arms its interval', async () => {
    const { handle, company } = await fixture();
    const previous = handle.app._chatApi.bind(handle.app);
    let complete!: (result: unknown) => void;
    handle.app._chatApi = (path: string, options: unknown) => path === '/api/company' ? new Promise(resolve => { complete = resolve; }) : previous(path, options);
    const pending = handle.shell.openCompany('people');
    handle.shell.openPage('board');
    complete({ ok: true, data: company });
    await pending;
    expect(handle.document.querySelector('.ca-company')).toBeNull();
    expect(handle.shell._companyTimer).toBeNull();
    expect(handle.shell._companyRefresh).toBeNull();
    expect(handle.document.querySelector('.ca-page iframe')!.getAttribute('src')).toBe('/board');
  });

  it('does not duplicate an in-flight work read or update a detached page', async () => {
    const { handle, boardRead, board } = await fixture();
    let complete!: (result: unknown) => void;
    boardRead.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await handle.shell.openCompany('people');
    const pending = handle.shell._companyRefresh();
    expect(boardRead).toHaveBeenCalledOnce();
    const work = handle.document.querySelector('.ca-company-work')!;
    handle.shell.closePage();
    complete({ ok: true, data: board });
    await pending;
    await handle.flush();
    expect(work.textContent).toContain('Loading work status');
    expect(handle.shell._companyRefresh).toBeNull();
  });

  it('has no duplicate Board People section or top-of-Plans risk/banked counters', () => {
    const board = readFileSync(new URL('../src/web/public/board.html', import.meta.url), 'utf8');
    const plans = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
    expect(board).not.toContain('id="sec-agents"');
    expect(board).not.toContain('function agents()');
    expect(board).not.toContain("'people up'");
    expect(board).toContain('href="/#company" target="_top"');
    expect(board).toContain("location.hash === '#sec-agents'");
    expect(plans).not.toContain('id="planKpis"');
    expect(plans).not.toContain('function planKpis()');
    expect(plans).toContain('function bankedStat(p)');
    expect(plans).toContain("fetch('/api/plans/allocations'");
  });
});
