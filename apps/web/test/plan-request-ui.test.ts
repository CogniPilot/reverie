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
  const methods = runInNewContext(`${source}; ({openPlanMove, renderPlanMembers})`, context);
  const dialog = dom.window.document.querySelector('dialog')!;
  return { dom, context, methods, fetch, dialog };
}
afterEach(() => pages.splice(0).forEach((page) => page.window.close()));
describe('owner plan request presentation', () => {
  it('requests only immutable destination intent, leaves source avatar, and displays a grey destination ghost until resolution', async () => {
    const h = harness();
    await h.methods.openPlanMove('alex', 'second');
    expect(h.dialog.textContent).toContain('prepares a handoff and approves');
    expect(h.dialog.querySelector('textarea, input[name=model], input[name=force]')).toBeNull();
    const form = h.dialog.querySelector('form')!;
    form.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('Queued until'));
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
    expect(ghost?.getAttribute('aria-label')).toBe('Alex: pending move request');
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
