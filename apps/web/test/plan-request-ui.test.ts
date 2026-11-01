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
  const methods = runInNewContext(`${source}; ({openPlanMove, renderPlanMembers, planRequestStatus, showPlanMoveProgress, showPlanRequestProgress, forcePlanMove, openPlanMoveHistory})`, context);
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

describe('held plan move recovery navigation', () => {
  const reply = (data: unknown) => ({ok: true, status: 200, json: async () => ({success: true, data})});
  it('shows the canonical move rather than its same-id request and adopts only on explicit action', async () => {
    const h = harness();
    const move = {id:'held',employeeId:'alex',name:'Alex',phase:'recovery-required',oldSession:'old',newSession:'new',toAccount:'second',sourceCleanupVerified:true};
    h.fetch.mockImplementation(async (path:string) => reply(path.endsWith('/requests/recent')
      ? [{id:'held',employeeId:'alex',name:'Alex',phase:'recovery-required',newSession:'new'}]
      : path.endsWith('/moves/recent') ? [move] : path.endsWith('/status') ? move : {...move,phase:'completed'}));
    await h.methods.openPlanMoveHistory('alex');
    expect(h.dialog.querySelector('[data-moves]')).toBeNull();
    const adopt=h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!;
    expect(adopt.hidden).toBe(false);expect(adopt.disabled).toBe(false);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve'))).toBe(false);
    adopt.click();
    await vi.waitFor(()=>expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve'))).toBe(true));
    const sent=h.fetch.mock.calls.find(([path])=>path.endsWith('/resolve'))!;
    expect(JSON.parse(sent[1]!.body)).toEqual({action:'adopt-existing',oldSession:'old',newSession:'new',toAccount:'second'});
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/force')||path.endsWith('/cancel'))).toBe(false);
  });
  it('links a rejected new request to employee-filtered history without retrying or mutating the journal', async () => {
    const h=harness();await h.methods.openPlanMove('alex','second');
    const held={id:'held',employeeId:'alex',name:'Alex',phase:'recovery-required'};
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'
      ? {ok:false,status:409,json:async()=>({success:false,error:'This employee already has a move in progress or requiring recovery'})}
      : reply(path.endsWith('/moves/recent') ? [{...held,id:'other',employeeId:'someone-else',name:'Other'},held] : held));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('[data-refresh]')).not.toBeNull());
    expect(h.dialog.textContent).toContain('Alex');
    expect(h.dialog.textContent).not.toContain('Other');
    expect(h.fetch.mock.calls.filter(([path])=>path==='/api/plans/requests')).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/force')||path.endsWith('/resolve')||path.endsWith('/cancel'))).toBe(false);
  });
  it.each([
    {newSession:'new',sourceCleanupVerified:false,explanation:'Source cleanup was not durably verified',hidden:false},
    {newSession:undefined,sourceCleanupVerified:false,explanation:'No destination session was recorded',hidden:true},
    {newSession:'new',sourceCleanupVerified:true,resourceIntent:{operationId:'resource'},explanation:'protected native recovery',hidden:true},
  ])('explains unavailable recovery without creating an unlock action (%j)', record=>{
    const h=harness();h.dialog.showModal();h.methods.showPlanMoveProgress(h.dialog,{id:'held',phase:'recovery-required',...record},'Alex');
    expect(h.dialog.querySelector('[data-recovery-info]')!.textContent).toContain(record.explanation);
    const adopt=h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!;
    expect(adopt.hidden).toBe(record.hidden);
    if(!record.hidden)expect(adopt.disabled).toBe(true);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve')||path.endsWith('/force')||path.endsWith('/cancel')||path==='/api/plans/requests')).toBe(false);
  });
});


describe('blocked move contextual recovery', () => {
  const reply = (data: unknown) => ({ok:true,status:200,json:async()=>({success:true,data})});
  const held = {id:'held',employeeId:'alex',name:'Alex',phase:'recovery-required',oldSession:'old',newSession:'new',toAccount:'second',sourceStopRequested:true,sourceCleanupVerified:true};
  const conflict = () => ({ok:false,status:409,json:async()=>({success:false,error:'This employee already has a move in progress or requiring recovery',blocker:{id:'held',action:'inspect-existing'}})});
  it('takes the blocked form straight to its exact current move and recovers once only after a fresh check', async () => {
    const h=harness();await h.methods.openPlanMove('alex','second');
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'?conflict():reply(path.endsWith('/resolve')?{...held,phase:'completed'}:held));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('[data-resolve]')).not.toBeNull());
    expect(h.dialog.textContent).toContain('Alex');expect(h.dialog.querySelector('form')).toBeNull();
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/recent'))).toHaveLength(0);
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/resolve'))).toHaveLength(0);
    const recover=h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!;recover.click();recover.click();
    await vi.waitFor(()=>expect(h.dialog.open).toBe(false));
    expect(h.fetch.mock.calls.filter(([path])=>path==='/api/plans/moves/held/status')).toHaveLength(2);
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/resolve'))).toHaveLength(1);
    expect(h.fetch.mock.calls.filter(([path])=>path==='/api/plans/requests')).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/force')||path.endsWith('/cancel'))).toBe(false);
  });
  it('refuses a blocker status for another employee rather than resolving or choosing a new move', async()=>{
    const h=harness();await h.methods.openPlanMove('alex','second');
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'?conflict():reply({...held,employeeId:'other'}));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('.err')!.textContent).toContain('changed'));
    expect(h.dialog.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
    expect(h.dialog.querySelector<HTMLButtonElement>('[data-force]')!.disabled).toBe(true);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve'))).toBe(false);
  });
  it('checks exact recovery binding again before adoption and refuses changed destinations',async()=>{
    const h=harness();h.dialog.showModal();h.methods.showPlanMoveProgress(h.dialog,held,'Alex');
    h.fetch.mockImplementation(async()=>reply({...held,newSession:'other-destination'}));
    h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.click();
    await vi.waitFor(()=>expect(h.dialog.querySelector('.status')!.textContent).toContain('changed'));
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/resolve'))).toHaveLength(0);
  });
  it('refreshes a recovery hold without launching, resolving or submitting another request',async()=>{
    const h=harness();h.dialog.showModal();h.methods.showPlanMoveProgress(h.dialog,{...held,sourceCleanupVerified:false},'Alex');
    h.fetch.mockImplementation(async()=>reply(held));
    h.dialog.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await vi.waitFor(()=>expect(h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(false));
    expect(h.fetch.mock.calls.filter(([path])=>path.includes('/moves/')).map(([path])=>path)).toEqual(['/api/plans/moves/held/status']);
    expect(h.fetch.mock.calls.some(([path])=>path==='/api/plans/requests'||path.endsWith('/resolve')||path.endsWith('/force')||path.endsWith('/cancel'))).toBe(false);
  });
  it('keeps a lost recovery response held and reads status without automatically replaying adoption',async()=>{
    const h=harness();h.dialog.showModal();h.methods.showPlanMoveProgress(h.dialog,held,'Alex');let completed=false;
    h.fetch.mockImplementation(async(path:string)=>{if(path.endsWith('/resolve')){completed=true;throw new Error('Connection lost');}return reply({...held,phase:completed?'completed':'recovery-required'});});
    h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.click();
    await vi.waitFor(()=>expect(h.dialog.querySelector('.status')!.textContent).toContain('unconfirmed'));
    expect(h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(true);
    h.dialog.querySelector<HTMLButtonElement>('[data-refresh]')!.click();await vi.waitFor(()=>expect(h.dialog.open).toBe(false));
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/resolve'))).toHaveLength(1);
  });
  it('uses the exact blocker for force conflicts without forcing a second move', async()=>{
    const h=harness();vi.spyOn(h.dom.window,'confirm').mockReturnValue(true);await h.methods.openPlanMove('alex','second');
    h.fetch.mockImplementation(async(path:string)=>path.endsWith('/force')?conflict():reply(held));
    h.dialog.querySelector<HTMLButtonElement>('[data-force]')!.click();
    await vi.waitFor(()=>expect(h.dialog.querySelector('[data-resolve]')).not.toBeNull());
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/force'))).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve')||path.endsWith('/cancel')||path==='/api/plans/requests')).toBe(false);
  });
  it('does not auto-select ambiguous legacy holds or re-enable the blocked form',async()=>{
    const h=harness();await h.methods.openPlanMove('alex','second');
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'
      ?{ok:false,status:409,json:async()=>({success:false,error:'Move in progress or requiring recovery'})}
      :reply([{...held,id:'first-held'},{...held,id:'second-held'}]));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('.err')!.textContent).toContain('ambiguous'));
    expect(h.dialog.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/status')||path.endsWith('/resolve'))).toBe(false);
  });
  it('keeps active canonical moves held and never offers adoption',async()=>{
    const h=harness();await h.methods.openPlanMove('alex','second');
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'?conflict():reply({...held,phase:'checking'}));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('[data-resolve]')).not.toBeNull());
    expect(h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.hidden).toBe(true);
    expect(h.dialog.textContent).toContain('checking');
    expect(h.fetch.mock.calls.filter(([path])=>path==='/api/plans/requests')).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve')||path.endsWith('/cancel'))).toBe(false);
  });
  it('ignores a late blocker lookup after the owner closes and opens another dialog',async()=>{
    const h=harness();await h.methods.openPlanMove('alex','second');let finish!:(value:ReturnType<typeof reply>)=>void;
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'?conflict():new Promise(resolve=>{finish=resolve;}));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));h.dialog.close();
    h.fetch.mockImplementation(async()=>reply({account:'first',mode:'codex',sessionId:'source'}));
    await h.methods.openPlanMove('alex','second');const current=h.dialog.innerHTML;
    finish(reply(held));await new Promise(resolve=>setImmediate(resolve));
    expect(h.dialog.innerHTML).toBe(current);expect(h.dialog.querySelector('[data-resolve]')).toBeNull();
  });
  it('does not repeat a request after a lost creation response',async()=>{
    const h=harness();await h.methods.openPlanMove('alex','second');h.fetch.mockRejectedValue(new Error('Connection lost'));
    const form=h.dialog.querySelector('form')!;form.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('.err')!.textContent).toContain('unconfirmed'));
    form.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    expect(h.dialog.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
    expect(h.dialog.querySelector<HTMLButtonElement>('[data-force]')!.disabled).toBe(true);
    expect(h.fetch.mock.calls.filter(([path])=>path==='/api/plans/requests')).toHaveLength(1);
  });

  it('uses the unique employee hold on older conflict responses without selecting someone else',async()=>{
    const h=harness();await h.methods.openPlanMove('alex','second');
    h.fetch.mockImplementation(async(path:string)=>path==='/api/plans/requests'
      ?{ok:false,status:409,json:async()=>({success:false,error:'Move in progress or requiring recovery'})}
      :reply(path.endsWith('/recent')?[{...held,id:'foreign',employeeId:'other'},held]:held));
    h.dialog.querySelector('form')!.dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(h.dialog.querySelector('[data-resolve]')).not.toBeNull());
    expect(h.fetch.mock.calls.filter(([path])=>path.endsWith('/status')).map(([path])=>path)).toEqual(['/api/plans/moves/held/status']);
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/resolve'))).toBe(false);
  });
  it('ignores an older status answer after an explicit refresh checks the same move',async()=>{
    const h=harness();let finish!:(value:ReturnType<typeof reply>)=>void;
    h.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));h.dialog.showModal();
    h.methods.showPlanMoveProgress(h.dialog,{...held,phase:'checking'},'Alex');
    h.fetch.mockImplementation(async()=>reply(held));h.dialog.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await vi.waitFor(()=>expect(h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(false));
    finish(reply({...held,phase:'checking'}));await new Promise(resolve=>setImmediate(resolve));
    expect(h.dialog.querySelector('.status')!.textContent).toContain('recovery-required');
    expect(h.dialog.querySelector<HTMLButtonElement>('[data-resolve]')!.disabled).toBe(false);
  });

  it('leaves multiple employee holds in inspection instead of choosing one for recovery',async()=>{
    const h=harness();h.fetch.mockImplementation(async(path:string)=>reply(path.endsWith('/moves/recent')?[held,{...held,id:'another'}]:[]));
    await h.methods.openPlanMoveHistory('alex');
    expect(h.dialog.querySelector('.status')!.textContent).toContain('Multiple unresolved moves');
    expect(h.dialog.querySelectorAll('[data-moves] button')).toHaveLength(2);
    expect(h.dialog.querySelector('[data-resolve]')).toBeNull();
    expect(h.fetch.mock.calls.some(([path])=>path.endsWith('/status')||path.endsWith('/resolve'))).toBe(false);
  });

});
