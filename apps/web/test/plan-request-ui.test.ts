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
  const methods = runInNewContext(`${source}; ({openPlanMove, renderPlanMembers, planRequestStatus, showPlanMoveProgress, showPlanRequestProgress, forcePlanMove})`, context);
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


describe('completed plan progress dialogs', () => {
  function response(data: unknown) {
    return { ok: true, status: 200, json: async () => ({ success: true, data }) };
  }
  function progress(kind: 'move' | 'request', initial: Record<string, unknown>, h = harness()) {
    h.dialog.showModal();
    if (kind === 'move') h.methods.showPlanMoveProgress(h.dialog, initial, 'Alex');
    else h.methods.showPlanRequestProgress(h.dialog, { name: 'Alex', ...initial });
    return h;
  }
  for (const kind of ['move', 'request'] as const) {
    it(`${kind} closes once its current status reports successful completion`, async () => {
      const h = harness();
      h.fetch.mockImplementationOnce(async () => response({ id: 'progress', phase: 'completed' }));
      const close = vi.spyOn(h.dialog, 'close');
      progress(kind, { id: 'progress', phase: 'executing' }, h);
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(h.dialog.open).toBe(false);
      expect(h.context.setTimeout.mock.calls.filter(([, delay]) => delay === 1000 || delay === 1500)).toHaveLength(0);
      expect(h.fetch.mock.calls.every(([path]) => !path.endsWith('/cancel') && !path.endsWith('/resolve'))).toBe(true);
    });
    for (const phase of ['failed', 'recovery-required']) {
      it(`${kind} keeps ${phase} visible without further polling`, async () => {
        const h = harness();
        h.fetch.mockImplementationOnce(async () => response({ id: 'progress', phase, error: 'Inspect the retained move', newSession: 'destination', sourceCleanupVerified: true }));
        progress(kind, { id: 'progress', phase: 'executing' }, h);
        await vi.waitFor(() => expect(h.dialog.querySelector('.status')!.textContent).toContain(phase));
        expect(h.dialog.open).toBe(true);
        expect(h.dialog.textContent).toContain('Inspect the retained move');
        expect(h.context.setTimeout.mock.calls.filter(([, delay]) => delay === 1000 || delay === 1500)).toHaveLength(0);
        if (kind === 'move' && phase === 'recovery-required') expect(h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.hidden).toBe(false);
      });
    }
    it(`${kind} ignores an old successful response after another progress dialog replaces it`, async () => {
      const h = harness();
      let finish!: (value: ReturnType<typeof response>) => void;
      h.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      progress(kind, { id: 'old', phase: 'executing' }, h);
      const other = kind === 'move' ? 'request' : 'move';
      progress(other, { id: 'new', phase: 'failed', error: 'New dialog stays' }, h);
      const currentHTML = h.dialog.innerHTML;
      finish(response({ id: 'old', phase: 'completed' }));
      await new Promise(resolve => setImmediate(resolve));
      expect(h.dialog.open).toBe(true);
      expect(h.dialog.innerHTML).toBe(currentHTML);
      expect(h.context.setTimeout.mock.calls.filter(([, delay]) => delay === 1000 || delay === 1500)).toHaveLength(0);
    });
    it(`${kind} does not repaint or poll after progress is hidden`, async () => {
      const h = harness();
      let finish!: (value: ReturnType<typeof response>) => void;
      h.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      progress(kind, { id: 'old', phase: 'executing' }, h);
      h.dialog.querySelector<HTMLButtonElement>('[data-close]')!.click();
      const hiddenHTML = h.dialog.innerHTML;
      finish(response({ id: 'old', phase: 'failed', error: 'Late failure' }));
      await new Promise(resolve => setImmediate(resolve));
      expect(h.dialog.open).toBe(false);
      expect(h.dialog.innerHTML).toBe(hiddenHTML);
      expect(h.context.setTimeout.mock.calls.filter(([, delay]) => delay === 1000 || delay === 1500)).toHaveLength(0);
    });
  }
  for (const kind of ['move', 'request'] as const) {
    it(`${kind} stops a queued poll after native dialog close without cancelling the move`, async () => {
      const h = harness();
      h.fetch.mockImplementationOnce(async () => response({ id: 'progress', phase: 'executing' }));
      progress(kind, { id: 'progress', phase: 'executing' }, h);
      await vi.waitFor(() => expect(h.context.setTimeout.mock.calls.some(([, delay]) => delay === (kind === 'move' ? 1000 : 1500))).toBe(true));
      const callback = h.context.setTimeout.mock.calls.find(([, delay]) => delay === (kind === 'move' ? 1000 : 1500))![0];
      const calls = h.fetch.mock.calls.length;
      h.dialog.close();
      await callback();
      expect(h.fetch).toHaveBeenCalledTimes(calls);
      expect(h.dialog.open).toBe(false);
    });
  }
  it('immediate owner-forced success closes the progress dialog without another move', async () => {
    const h = harness();
    vi.spyOn(h.dom.window, 'confirm').mockReturnValue(true);
    await h.methods.openPlanMove('alex', 'second');
    h.dialog.querySelector<HTMLButtonElement>('[data-force]')!.click();
    await vi.waitFor(() => expect(h.dialog.open).toBe(false));
    expect(h.fetch.mock.calls.filter(([path]) => path === '/api/plans/moves/force')).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(false);
  });
});


describe('plan move create and preview dialog ownership', () => {
  function response(data: unknown) { return {ok: true, status: 200, json: async () => ({success: true, data})}; }
  for (const action of ['force', 'request', 'preview'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`ignores late ${action} ${outcome} after close and a new form opens`, async () => {
        const h = harness();
        vi.spyOn(h.dom.window, 'confirm').mockReturnValue(true);
        let finish!: (value: ReturnType<typeof response>) => void;
        let fail!: (error: Error) => void;
        if (action !== 'preview') await h.methods.openPlanMove('alex', 'second');
        h.fetch.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
        let preview: Promise<void> | undefined;
        if (action === 'preview') preview = h.methods.openPlanMove('alex', 'second');
        else if (action === 'force') h.dialog.querySelector<HTMLButtonElement>('[data-force]')!.click();
        else h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit', {bubbles: true, cancelable: true}));
        // Native Escape and a fresh owner action: no move/cancel request from hiding.
        h.dialog.close();
        await h.methods.openPlanMove('alex', 'second');
        const newForm = h.dialog.querySelector('form');
        const currentHTML = h.dialog.innerHTML;
        if (outcome === 'failure') fail(new Error('Old request failed'));
        else finish(response(action === 'preview'
          ? {account: 'first', mode: 'codex', sessionId: 'source'}
          : {id: 'old', name: 'Alex', employeeId: 'alex', toAccount: 'second', phase: action === 'force' ? 'completed' : 'pending'}));
        await preview;
        await new Promise(resolve => setImmediate(resolve));
        expect(h.dialog.open).toBe(true);
        expect(h.dialog.querySelector('form')).toBe(newForm);
        expect(h.dialog.innerHTML).toBe(currentHTML);
        expect(h.fetch.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(false);
        if (action === 'request' && outcome === 'success') expect(h.dom.window.document.querySelector('.plan-member-pending')).not.toBeNull();
      });
    }
  }
  it('retains existing forced-request cleanup while refusing to close a newer form', async () => {
    const h = harness();
    vi.spyOn(h.dom.window, 'confirm').mockReturnValue(true);
    await h.methods.openPlanMove('alex', 'second');
    let finish!: (value: ReturnType<typeof response>) => void;
    h.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const force = h.methods.forcePlanMove(h.dialog, h.context.planAllocations.employees[0], 'second', 'approved-request');
    h.dialog.close();
    await h.methods.openPlanMove('alex', 'second');
    const currentHTML = h.dialog.innerHTML;
    finish(response({id: 'old-forced', phase: 'completed'}));
    await force;
    expect(h.fetch.mock.calls.filter(([path]) => path === '/api/plans/requests/approved-request/cancel')).toHaveLength(1);
    expect(h.dialog.open).toBe(true);
    expect(h.dialog.innerHTML).toBe(currentHTML);
  });
});
