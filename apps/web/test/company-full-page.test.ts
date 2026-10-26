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

async function openProfile(handle: any, name: string) {
  handle.document.querySelector('.ca-expert-profile')?.close();
  handle.document.querySelector(`[aria-label="Edit profile for ${name}"]`)!.click();
  await handle.flush();
  return handle.document.querySelector('.ca-expert-profile') as HTMLDialogElement;
}

async function saveProfile(handle: any) {
  const profile = handle.document.querySelector('.ca-expert-profile')!;
  [...profile.querySelectorAll('button')].find((button: any) => button.textContent === 'Save profile')!.click();
  await handle.flush();
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
    expect(handle.document.querySelector('.ca-office-gear')!.getAttribute('aria-current')).toBe('page');
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
    const work = handle.document.querySelector('.ca-company-work')!;
    expect(cards[0].querySelector('.ca-company-work')).toBeNull();
    expect(work.querySelector('.ca-company-live-state')!.textContent).toBe('Working');
    expect(work.querySelector('.ca-company-ring')!.getAttribute('aria-label')).toBe('Today: 1 of 2 planned issues done');
    expect(work.querySelector('.ca-company-ring')!.textContent).toBe('1/2');
    expect(work.querySelector('.ca-company-pace')!.textContent).toBe('Behind');
    expect(work.querySelector('.ca-company-counts')!.textContent).toBe('2 overdue (3h) · 4 early · 1/2 2-wk items');
    expect(work.querySelector('.ca-company-focus')!.textContent).toContain('<img src=x');
    expect(work.querySelector('.ca-company-focus img')).toBeNull();
    expect(work.querySelector('.ca-company-receipts')!.textContent).toBe('tests passed');
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
        return { ok: true, data: { employee: { ...employee, ...options.body, permissions: { ...(employee as any).permissions, ...options.body.permissions } } } };
      }
      return previous(path, options);
    };
    await handle.shell.openCompany('people');
    await handle.flush();
    const profile = await openProfile(handle, employee.name);
    const checkbox = profile.querySelector<HTMLInputElement>('[aria-label="Recovery permission for Reviewer"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    const sleep = profile.querySelector<HTMLInputElement>('[aria-label="Sleep"]')!;
    const dream = profile.querySelector<HTMLInputElement>('[aria-label="Dream"]')!;
    expect(sleep.checked).toBe(false); expect(dream.checked).toBe(false);
    expect(sleep.title).toContain('Gantt'); expect(sleep.title).toContain('not connected');
    expect(dream.title).toContain('ideas, not facts');
    checkbox.click();
    await handle.flush();
    expect(writes).toEqual([{
      path: '/api/company/employees/' + employee.id,
      options: { method: 'PUT', body: { permissions: { recoverEmployees: true } }, signal: expect.anything() },
    }]);
    owner = false;
    handle.document.querySelector<HTMLDialogElement>('.ca-expert-profile')!.close();
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

async function recoverySettingsFixture(settings: object = {}, extras: object[] = []) {
  const result = await recoveryFixture(settings, extras);
  result.handle.document.querySelector<HTMLButtonElement>('[aria-label="Company settings"]')!.click();
  await result.handle.flush();
  return result;
}

describe('owner chooses one crash recovery expert', () => {
  it('allows selecting a report and saving the choice without a title privilege', async () => {
    const { handle, writes } = await recoverySettingsFixture({}, [{ id: 'report', name: '<Reviewer>', reportsTo: 'employee-one', position: 'Expert' }]);
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
    const { handle } = await recoverySettingsFixture({ coordinatorEmployeeId: 'employee-one' }, [{ id: 'legacy-report', name: 'Legacy report' }]);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.options[0].textContent).toBe('Automatic: Reviewer');
    expect(select.value).toBe('');
  });

  it('keeps the selected expert while disabling automatic recovery', async () => {
    const { handle, writes } = await recoverySettingsFixture({ autoWakeEnabled: true, crashWakeEmployeeId: 'employee-one' });
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
    const { handle, writes } = await recoverySettingsFixture({ crashWakeEmployeeId: 'employee-one' }, [{ id: 'second-root', name: 'Another expert', reportsTo: 'owner' }]);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.options[0].textContent).toBe('Choose an expert');
    select.value = '';
    handle.document.querySelector<HTMLButtonElement>('.ca-company-recovery button')!.click();
    await handle.flush();
    expect(writes[0].body).not.toHaveProperty('crashWakeEmployeeId');
  });

  it('shows an unavailable stored choice without silently selecting another expert', async () => {
    const { handle } = await recoverySettingsFixture({ autoWakeEnabled: false, crashWakeEmployeeId: 'retired' });
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Wake after a crash"]')!;
    expect(select.value).toBe('retired');
    expect(select.selectedOptions[0].textContent).toBe('Unavailable expert');
    expect(select.disabled).toBe(true);
  });
});

describe('reporting lines directly on company cards', () => {
  it('saves only the chosen manager, redraws the hierarchy and keeps it after reopening', async () => {
    const { handle, company, employee } = await recoveryFixture({}, [
      { id: 'lead', name: 'Project lead', reportsTo: 'owner' },
      { id: 'report', name: 'Specialist', reportsTo: 'employee-one' },
    ]);
    const previous = handle.app._chatApi.bind(handle.app);
    const writes: any[] = [];
    handle.app._chatApi = async (path: string, options: any) => {
      if (path === '/api/company/employees/' + employee.id && options?.method === 'PUT') {
        writes.push(options.body); Object.assign(employee, options.body);
        return { ok: true, data: { employee } };
      }
      return previous(path, options);
    };
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Reports to for Reviewer"]')!;
    expect([...select.options].map(option => option.value)).toEqual(['owner', 'lead']);
    select.value = 'lead'; select.dispatchEvent(new handle.window.Event('change'));
    await handle.flush();
    expect(writes).toEqual([{ reportsTo: 'lead' }]);
    expect(handle.document.querySelector('.ca-company > [role="status"]')!.textContent).toBe('Reporting line saved.');
    const lead = handle.document.querySelector('[data-employee-id="lead"].ca-company-person')!;
    expect(lead.closest('li')!.querySelector(':scope > ul > li > [data-employee-id="employee-one"]')).not.toBeNull();
    handle.shell.closePage(); await handle.shell.openCompany();
    expect(handle.document.querySelector<HTMLSelectElement>('[aria-label="Reports to for Reviewer"]')!.value).toBe('lead');
    expect(company.employees).toHaveLength(3);
  });

  it('restores the previous manager on a refused save and explains the failure', async () => {
    const { handle } = await recoveryFixture({}, [{ id: 'lead', name: 'Lead', reportsTo: 'owner' }]);
    const previous = handle.app._chatApi.bind(handle.app);
    handle.app._chatApi = async (path: string, options: any) => options?.method === 'PUT'
      ? { ok: false, error: 'Reporting hierarchy cannot contain a cycle' }
      : previous(path, options);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Reports to for Reviewer"]')!;
    select.value = 'lead'; select.dispatchEvent(new handle.window.Event('change')); await handle.flush();
    expect(select.value).toBe('owner'); expect(select.disabled).toBe(false);
    expect(select.closest('.ca-company-reporting')!.textContent).toContain('Could not save reporting line: Reporting hierarchy cannot contain a cycle');
  });

  it('shows inherited reporting lines under the actual coordinator', async () => {
    const { handle } = await recoveryFixture({ coordinatorEmployeeId: 'employee-one' }, [{ id: 'legacy', name: 'Legacy' }]);
    const select = handle.document.querySelector<HTMLSelectElement>('[aria-label="Reports to for Legacy"]')!;
    expect(select.selectedOptions[0].textContent).toBe('Company default (Reviewer)');
    const lead = handle.document.querySelector('[data-employee-id="employee-one"].ca-company-person')!;
    expect(lead.closest('li')!.querySelector(':scope > ul > li > [data-employee-id="legacy"]')).not.toBeNull();
  });

  it('keeps reporting controls owner-only', async () => {
    const { handle } = await fixture(); await handle.shell.openCompany();
    expect(handle.document.querySelector('[aria-label="Reports to for Reviewer"]')).toBeNull();
    expect(handle.document.querySelector('.ca-company-parent')!.textContent).toBe('Owner name');
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
    if (path === '/api/company/employees/' + employee.id) { writes.push(options.body); Object.assign(employee, options.body); return { ok: true, data: { employee } }; }
    return original(path, options);
  };
  await handle.shell.openCompany('people'); await handle.flush();
  const profile = await openProfile(handle, employee.name);
  const sleep = profile.querySelector<HTMLInputElement>('[aria-label="Sleep"]')!;
  const dream = profile.querySelector<HTMLInputElement>('[aria-label="Dream"]')!;
  expect(sleep.checked).toBe(true); expect(dream.checked).toBe(false);
  expect(handle.document.querySelector<HTMLInputElement>('[aria-label="Recovery permission for Reviewer"]')!.disabled).toBe(false);
  sleep.click(); await handle.flush(); dream.click(); await handle.flush();
  expect(writes).toEqual([]);
  await saveProfile(handle);
  expect(writes).toEqual([expect.objectContaining({ sleepEnabled: false, dreamEnabled: true })]);
  expect(writes[0]).not.toHaveProperty('permissions');
});

it('saves Sleep/Dream in each expert profile and restores saved values when Company is reopened', async () => {
  const { handle, company } = await fixture([{ id: 'second', sessionId: 'second-session', name: 'Second', reportsTo: 'owner' }]);
  company.canManage = true;
  const writes: any[] = [];
  handle.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    const target = company.employees.find(e => path === '/api/company/employees/' + e.id);
    if (target && options?.method === 'PUT') { writes.push(options.body); Object.assign(target, options.body); return { ok: true, data: { employee: target } }; }
    return { ok: true, data: {} };
  };
  await handle.shell.openCompany();
  for (const employee of company.employees) {
    const profile = await openProfile(handle, employee.name);
    for (const key of ['sleepEnabled', 'dreamEnabled']) {
      (profile.querySelector(`[name="${key}"]`) as HTMLInputElement).click();
      await handle.flush();
    }
    await saveProfile(handle);
  }
  expect(writes).toHaveLength(2);
  expect(writes.every(body => body.sleepEnabled === true && body.dreamEnabled === true && !('permissions' in body))).toBe(true);
  handle.shell.closePage(); await handle.shell.openCompany();
  for (const employee of company.employees) {
    const profile = await openProfile(handle, employee.name);
    expect(profile.querySelector<HTMLInputElement>('[name="sleepEnabled"]')!.checked).toBe(true);
    expect(profile.querySelector<HTMLInputElement>('[name="dreamEnabled"]')!.checked).toBe(true);
  }
});

it('keeps saved Sleep/Dream unchanged after a refused profile save and shows the error on that profile', async () => {
  const { handle, company } = await fixture(); company.canManage = true;
  handle.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    return options?.method === 'PUT' ? { ok: false, status: 403, error: 'Save refused' } : { ok: true, data: {} };
  };
  await handle.shell.openCompany();
  const profile = await openProfile(handle, 'Reviewer');
  const sleep = profile.querySelector<HTMLInputElement>('[name="sleepEnabled"]')!;
  sleep.click(); await handle.flush();
  await saveProfile(handle);
  expect(sleep.disabled).toBe(false);
  expect(profile.textContent).toContain('Save refused');
  const reopened = await openProfile(handle, 'Reviewer');
  expect(reopened.querySelector<HTMLInputElement>('[name="sleepEnabled"]')!.checked).toBe(false);
  expect(reopened.querySelector<HTMLInputElement>('[name="dreamEnabled"]')!.checked).toBe(false);
});
