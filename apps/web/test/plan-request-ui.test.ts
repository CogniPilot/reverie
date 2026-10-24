import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function planMemberHtml('), html.indexOf('// Codex banked resets:'));
const pages: JSDOM[] = [];
function harness() {
  const dom = new JSDOM(
    '<div data-plan-members="first"></div><div data-plan-members="second"></div><dialog id="moveDlg"></dialog>',
    { pretendToBeVisual: true }
  );
  pages.push(dom);
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const employee = { id: 'alex', name: 'Alex', sessionId: 'source', avatar: '/api/avatars/source?v=1' };
  let requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (path: string, options?: { body: string }) => {
    let data: unknown;
    if (path === '/api/plans/moves/preview')
      data = { account: 'first', mode: 'codex', sessionId: 'source', working: true };
    else if (path === '/api/plans/moves/force') data = {id: 'forced', phase: 'completed'};
    else if (path === '/api/plans/allocations') data = context.planAllocations;
    else if (path === '/api/plans/requests') {
      const input = JSON.parse(options!.body);
      data = { ...input, name: 'Alex', phase: 'pending', notified: false };
      requests = [data as Record<string, unknown>];
    } else if (path.endsWith('/cancel')) {
      requests = requests.map((record) => ({ ...record, phase: 'cancelled' }));
      data = requests[0];
    } else if (path.endsWith('/status')) data = requests[0];
    else data = requests;
    return { ok: true, status: 200, json: async () => ({ success: true, data }) };
  });
  const context = {
    document: dom.window.document,
    window: dom.window,
    crypto: webcrypto,
    fetch,
    AbortController,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    B: {
      planBurn: [
        { id: 'first', name: 'Gmail', provider: 'openai' },
        { id: 'second', name: 'Work', provider: 'openai' },
      ],
    },
    planAllocations: {
      employees: [employee],
      accounts: [
        { id: 'first', sessionIds: ['source'] },
        { id: 'second', sessionIds: [] },
      ],
    },
    pendingPlanRequests: [] as Record<string, unknown>[],
    planMembersBusy: false,
    planMembersError: false,
    esc: (value: unknown) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
      ),
  };
  const methods = runInNewContext(`${source}; ({openPlanMove, renderPlanMembers, planRequestStatus})`, context);
  const dialog = dom.window.document.querySelector('dialog')!;
  return { dom, context, methods, fetch, dialog };
}
afterEach(() => pages.splice(0).forEach((page) => page.window.close()));
describe('owner plan request presentation', () => {
  it('renders the same avatar and clickable profile control for a local-model employee', () => {
    const h = harness();
    const employee = h.context.planAllocations.employees[0];
    h.dom.window.document.body.insertAdjacentHTML('afterbegin', '<div data-local-members="local"></div>');
    Object.assign(h.context, {localSessions: [{id: 'source', customModel: {endpointId: 'local'}}], localEmployees: [employee]});
    h.methods.renderPlanMembers();
    const row = h.dom.window.document.querySelector('[data-local-members]')!;
    expect(row.querySelector('img')?.getAttribute('src')).toBe(employee.avatar);
    expect(row.querySelector('button[data-member="alex"]')).not.toBeNull();
    expect(row.querySelector('button')?.getAttribute('aria-label')).toBe('Alex');
  });
  it('opens runtime selection from the local card using the same-origin parent bridge', async () => {
    const h = harness();
    Object.assign(h.context, {localSessions: [{id: 'source', customModel: {endpointId: 'local'}}]});
    const postMessage = vi.fn();
    h.context.window = {parent: {postMessage}, location: {origin: 'https://console.test'}} as never;
    await h.methods.openPlanMove('alex');
    expect(postMessage).toHaveBeenCalledWith({type: 'company-open-runtime', employeeId: 'alex'}, 'https://console.test');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('offers an explicit owner force action without requiring expert approval', async () => {
    const h = harness();
    vi.spyOn(h.dom.window, 'confirm').mockReturnValue(true);
    await h.methods.openPlanMove('alex', 'second');
    h.dialog.querySelector<HTMLButtonElement>('[data-force]')!.click();
    await vi.waitFor(() => expect(h.fetch.mock.calls.some(([path]) => path === '/api/plans/moves/force')).toBe(true));
    const sent = h.fetch.mock.calls.find(([path]) => path === '/api/plans/moves/force')!;
    expect(JSON.parse(sent[1]!.body)).toMatchObject({employeeId: 'alex', sessionId: 'source', toAccount: 'second'});
    expect(h.fetch.mock.calls.some(([path]) => path === '/api/plans/requests')).toBe(false);
  });
  it('accepts a drop across providers and explains the automatically selected destination harness', async () => {
    const h = harness();
    h.context.B.planBurn.push({ id: 'claude', name: 'Claude Work', provider: 'anthropic' });
    h.context.planAllocations.accounts.push({ id: 'claude', sessionIds: [] });
    await h.methods.openPlanMove('alex', 'claude');
    expect(h.dialog.querySelector<HTMLSelectElement>('[name=target]')!.value).toBe('claude');
    expect(h.dialog.querySelector('[data-target-harness]')!.textContent).toContain('Harness: Claude');
    expect(h.dialog.textContent).toContain('destination provider’s model and effort defaults');
    const select = h.dialog.querySelector<HTMLSelectElement>('[name=target]')!;
    select.value = 'second'; select.dispatchEvent(new h.dom.window.Event('change'));
    expect(h.dialog.querySelector('[data-target-harness]')!.textContent).toContain('Harness: Codex');
    select.value = 'claude'; select.dispatchEvent(new h.dom.window.Event('change'));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.fetch.mock.calls.some(([path]) => path === '/api/plans/requests')).toBe(true));
    const request = h.fetch.mock.calls.find(([path]) => path === '/api/plans/requests')!;
    expect(JSON.parse(request[1]!.body)).toMatchObject({ employeeId: 'alex', sessionId: 'source', toAccount: 'claude' });
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('Waiting for idle'));
    expect(h.dom.window.document.querySelector('[data-plan-members=first] [data-member=alex]')).not.toBeNull();
  });
  it('requests only immutable destination intent, leaves source avatar, and displays a grey destination ghost until resolution', async () => {
    const h = harness();
    await h.methods.openPlanMove('alex', 'second');
    expect(h.dialog.textContent).toContain('prepares a handoff and approves');
    expect(h.dialog.querySelector('textarea, input[name=model], input[name=force]')).toBeNull();
    const form = h.dialog.querySelector('form')!;
    form.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('Waiting for idle'));
    const request = h.fetch.mock.calls.find(([path]) => path === '/api/plans/requests')!;
    expect(JSON.parse(request[1]!.body)).toEqual({
      id: expect.any(String),
      employeeId: 'alex',
      sessionId: 'source',
      toAccount: 'second',
    });
    expect(h.fetch.mock.calls.filter(([path]) => path === '/api/plans/requests')).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([path]) => path === '/api/plans/moves')).toBe(false);
    expect(h.dom.window.document.querySelector('[data-plan-members=first] [data-member=alex]')).not.toBeNull();
    const ghost = h.dom.window.document.querySelector('[data-plan-members=second] .plan-member-pending');
    expect(ghost?.getAttribute('aria-label')).toContain('Alex: Waiting for idle');
    expect(ghost?.hasAttribute('draggable')).toBe(false);
    h.dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    await vi.waitFor(() => expect(h.dom.window.document.querySelector('.plan-member-pending')).toBeNull());
    expect(h.dom.window.document.querySelector('[data-plan-members=first] [data-member=alex]')).not.toBeNull();
  });
  it('canceling the request form creates no intent and terminal/actual destination bindings have no ghost duplicates', async () => {
    const h = harness();
    await h.methods.openPlanMove('alex', 'second');
    h.dialog.querySelector<HTMLButtonElement>('[data-close]')!.click();
    expect(h.fetch.mock.calls.some(([path]) => path === '/api/plans/requests')).toBe(false);
    h.context.pendingPlanRequests = [
      { id: 'request', employeeId: 'alex', name: 'Alex', toAccount: 'second', phase: 'completed' },
    ];
    h.methods.renderPlanMembers();
    expect(h.dom.window.document.querySelector('.plan-member-pending')).toBeNull();
    h.context.pendingPlanRequests[0].phase = 'executing';
    h.context.planAllocations.accounts[0].sessionIds = [];
    h.context.planAllocations.accounts[1].sessionIds = ['source'];
    h.methods.renderPlanMembers();
    expect(h.dom.window.document.querySelector('.plan-member-pending')).toBeNull();
    expect(h.dom.window.document.querySelectorAll('[data-member=alex]')).toHaveLength(1);
  });
});

describe('plan request deadline display', () => {
  it('shows waiting-for-idle and a decreasing deadline without extending the request', () => {
    const h = harness(), r = { phase: 'pending', notified: false, expiresAt: 1_800_000 };
    expect(h.methods.planRequestStatus(r, 0)).toBe('Waiting for idle · queued message · 30:00 left');
    expect(h.methods.planRequestStatus(r, 65_000)).toContain('28:55 left');
    expect(h.methods.planRequestStatus({ ...r, notified: true }, 65_000)).toContain('Awaiting the expert');
    expect(h.methods.planRequestStatus(r, 1_800_000)).toContain('Expired');
    expect(r.expiresAt).toBe(1_800_000);
  });
});
