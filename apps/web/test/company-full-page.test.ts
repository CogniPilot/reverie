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

describe('Company is one page for plans and people', () => {
  it('keeps plans and people together without duplicate headings or tabs', async () => {
    const { handle, boardRead } = await fixture();
    await handle.shell.openCompany();
    const page = handle.document.querySelector('.ca-page')!;
    expect(page.contains(handle.document.querySelector('.ca-side'))).toBe(false);
    expect(handle.document.querySelector('dialog.ca-company')).toBeNull();
    expect(handle.document.querySelector('[role="tablist"]')).toBeNull();
    expect(handle.document.querySelector('.ca-company-head h2')).toBeNull();
    expect((handle.document.querySelector('#ca-company-people') as HTMLElement).hidden).toBe(false);
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
    expect(handle.document.querySelector('#ca-company-plans iframe')!.getAttribute('src')).toBe('/company/plans');
    expect(handle.document.querySelector('.ca-company-nav')!.getAttribute('aria-current')).toBe('page');
    expect(handle.document.querySelector('.ca-root')!.classList.contains('is-page')).toBe(true);
    expect(boardRead).toHaveBeenCalledOnce();
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

  it('opens old People bookmarks on the same unified Company page without duplicating frames', async () => {
    const { handle } = await fixture();
    handle.shell.openPage('company-people');
    await handle.flush();
    expect(handle.window.location.hash).toBe('#company');
    expect((handle.document.querySelector('#ca-company-people') as HTMLElement).hidden).toBe(false);
    expect((handle.document.querySelector('#ca-company-plans') as HTMLElement).hidden).toBe(false);
    const frame = handle.document.querySelector('#ca-company-plans iframe');
    await handle.shell.openCompany('plans');
    expect(handle.document.querySelector('#ca-company-plans iframe')).toBe(frame);
    handle.window.history.replaceState({}, '', '#board');
    handle.shell.openPage('company-people', { push: false });
    expect(handle.window.location.hash).toBe('#board');
  });

  it('accepts height only from its own same-origin plans frame and removes the listener on close', async () => {
    const { handle } = await fixture();
    await handle.shell.openCompany();
    const frame = handle.document.querySelector('iframe') as HTMLIFrameElement;
    const plans = handle.document.querySelector('#ca-company-plans') as HTMLElement;
    const send = (height: unknown, source: Window | null = frame.contentWindow, origin = handle.window.location.origin) => handle.window.dispatchEvent(new handle.window.MessageEvent('message', { data: { type: 'company-plans-height', height }, source, origin }));
    send(450); expect(plans.style.height).toBe('450px');
    send(200, handle.window); expect(plans.style.height).toBe('450px');
    send(200, frame.contentWindow, 'https://elsewhere.example'); expect(plans.style.height).toBe('450px');
    send('200'); send(Infinity); expect(plans.style.height).toBe('450px');
    send(1); expect(plans.style.height).toBe('120px');
    send(12000); expect(plans.style.height).toBe('10000px');
    const listener = handle.shell._companyResize;
    const remove = vi.spyOn(handle.window, 'removeEventListener');
    handle.shell.closePage();
    expect(remove).toHaveBeenCalledWith('message', listener);
    expect(handle.shell._companyResize).toBeNull();
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

  it('refreshes visible people without repainting and pauses for a hidden document', async () => {
    const { handle, board, boardRead } = await fixture();
    await handle.shell.openCompany('people');
    await handle.flush();
    const card = handle.document.querySelector('.ca-company-person');
    board.agents['employee-one'].focus = 'New focus';
    await handle.shell._companyRefresh();
    expect(handle.document.querySelector('.ca-company-person')).toBe(card);
    expect(handle.document.querySelector('.ca-company-focus')!.textContent).toBe('New focus');
    expect(boardRead).toHaveBeenCalledTimes(2);
    Object.defineProperty(handle.document, 'hidden', { value: true, configurable: true });
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
    expect(board).not.toContain('href="/#company" target="_top"');
    expect(board).toContain("location.hash === '#sec-agents'");
    expect(plans).not.toContain('id="planKpis"');
    expect(plans).not.toContain('function planKpis()');
    expect(plans).toContain('function bankedStat(p)');
    expect(plans).toContain("fetch('/api/plans/allocations'");
  });
  it('owner-only People controls save an explicit recovery capability, with no title-based default', async () => {
    const { handle, employee, company } = await fixture();
    company.canManage = true;
    employee.position = 'CTO';
    let owner = true;
    const previous = handle.app._chatApi.bind(handle.app);
    const writes: Array<{ path: string; options: any }> = [];
    handle.app._chatApi = async (path: string, options: any) => {
      if (path === '/api/company') return { ok: true, data: company };
      if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : employee.sessionId, canSetOwn: owner } };
      if (path === '/api/company/employees/' + employee.id) {
        writes.push({ path, options });
        return { ok: true, data: {} };
      }
      return previous(path, options);
    };
    await handle.shell.openCompany('people');
    await handle.flush();
    const checkbox = handle.document.querySelector<HTMLInputElement>('[aria-label="Recovery permission for Reviewer"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    const sleep = handle.document.querySelector<HTMLInputElement>('[aria-label="Sleep"]')!;
    const dream = handle.document.querySelector<HTMLInputElement>('[aria-label="Dream"]')!;
    expect(sleep.checked).toBe(false); expect(dream.checked).toBe(false);
    expect(sleep.title).toContain('Gantt'); expect(sleep.title).toContain('not connected');
    expect(dream.title).toContain('ideas, not facts');
    checkbox.checked = true;
    handle.document.querySelector<HTMLButtonElement>('[aria-label="Save preferences for Reviewer"]')!.click();
    await handle.flush();
    expect(writes).toEqual([{
      path: '/api/company/employees/' + employee.id,
      options: { method: 'PUT', body: { sleepEnabled: false, dreamEnabled: false, permissions: { recoverEmployees: true, moveOwnPlan: false, managePlans: false } } },
    }]);
    owner = false;
    handle.shell.closePage();
    await handle.shell.openCompany('people');
    await handle.flush();
    expect(handle.document.querySelector('[aria-label="Recovery permission for Reviewer"]')).toBeNull();
    expect(handle.document.querySelector('[aria-label="Automatic recovery"]')).toBeNull();
  });

});

async function recoveryFixture(settings: object = {}, extras: object[] = []) {
  const result = await fixture(extras);
  const { handle, company } = result;
  company.canManage = true;
  Object.assign(company.settings, settings);
  const previous = handle.app._chatApi.bind(handle.app);
  const writes: any[] = [];
  handle.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company/settings') {
      writes.push(options);
      return { ok: true, data: { settings: options.body } };
    }
    return previous(path, options);
  };
  await handle.shell.openCompany('people');
  await handle.flush();
  return { ...result, writes };
}

describe('owner chooses one crash recovery expert', () => {
  it('allows selecting a report and saving the choice without a title privilege', async () => {
    const { handle, writes } = await recoveryFixture({}, [{ id: 'report', name: '<Reviewer>', reportsTo: 'employee-one', position: 'Expert' }]);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.options[0].textContent).toBe('Automatic: Reviewer');
    expect([...select.options].map(option => option.value)).toEqual(['', 'employee-one', 'report']);
    select.value = 'report';
    handle.document.querySelector<HTMLButtonElement>('.ca-company-recovery button')!.click();
    await handle.flush();
    expect(writes).toEqual([{ method: 'PUT', body: { ownerName: 'Owner name', autoWakeEnabled: true, crashWakeEmployeeId: 'report' } }]);
    expect(handle.document.querySelector('.ca-company-recovery img')).toBeNull();
  });

  it('uses the configured coordinator as the default root for older unspecified reporting lines', async () => {
    const { handle } = await recoveryFixture({ coordinatorEmployeeId: 'employee-one' }, [{ id: 'legacy-report', name: 'Legacy report' }]);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.options[0].textContent).toBe('Automatic: Reviewer');
    expect(select.value).toBe('');
  });

  it('keeps the selected expert while disabling automatic recovery', async () => {
    const { handle, writes } = await recoveryFixture({ autoWakeEnabled: true, crashWakeEmployeeId: 'employee-one' });
    const enabled = handle.document.querySelector<HTMLInputElement>('[aria-label="Automatic recovery"]')!;
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.value).toBe('employee-one');
    enabled.checked = false;
    enabled.dispatchEvent(new handle.window.Event('change'));
    expect(select.disabled).toBe(true);
    handle.document.querySelector<HTMLButtonElement>('.ca-company-recovery button')!.click();
    await handle.flush();
    expect(writes[0].body.autoWakeEnabled).toBe(false);
    expect(writes[0].body.crashWakeEmployeeId).toBe('employee-one');
  });

  it('requires a choice for multiple roots and omits a cleared selection', async () => {
    const { handle, writes } = await recoveryFixture({ crashWakeEmployeeId: 'employee-one' }, [{ id: 'second-root', name: 'Another expert', reportsTo: 'owner' }]);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.options[0].textContent).toBe('Choose an expert');
    select.value = '';
    handle.document.querySelector<HTMLButtonElement>('.ca-company-recovery button')!.click();
    await handle.flush();
    expect(writes[0].body).not.toHaveProperty('crashWakeEmployeeId');
  });

  it('shows an unavailable stored choice without silently selecting another expert', async () => {
    const { handle } = await recoveryFixture({ autoWakeEnabled: false, crashWakeEmployeeId: 'retired' });
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.value).toBe('retired');
    expect(select.selectedOptions[0].textContent).toBe('Unavailable expert');
    expect(select.disabled).toBe(true);
  });
});

it('shows saved Sleep/Dream preferences and lets the owner change them during vacation without changing recovery grants', async () => {
  const { handle, employee, company } = await fixture();
  company.canManage = true;
  Object.assign(employee, { onVacation: true, sleepEnabled: true, dreamEnabled: false });
  const original = handle.app._chatApi.bind(handle.app);
  const writes: unknown[] = [];
  handle.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company/employees/' + employee.id) { writes.push(options.body); return { ok: true, data: {} }; }
    return original(path, options);
  };
  await handle.shell.openCompany('people'); await handle.flush();
  const sleep = handle.document.querySelector<HTMLInputElement>('[aria-label="Sleep"]')!;
  const dream = handle.document.querySelector<HTMLInputElement>('[aria-label="Dream"]')!;
  const save = handle.document.querySelector<HTMLButtonElement>('[aria-label="Save preferences for Reviewer"]')!;
  expect(sleep.checked).toBe(true); expect(dream.checked).toBe(false);
  expect(handle.document.querySelector<HTMLInputElement>('[aria-label="Recovery permission for Reviewer"]')!.disabled).toBe(true);
  expect(save.disabled).toBe(false);
  sleep.checked = false; dream.checked = true; save.click(); await handle.flush();
  expect(writes).toEqual([{ sleepEnabled: false, dreamEnabled: true }]);
});
