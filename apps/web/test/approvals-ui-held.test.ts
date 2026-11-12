/** Real approval renderers and actions in an owned DOM; API replies are synthetic, no providers exist. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';

type Approval = {
  id: string;
  sessionId: string;
  sessionName: string;
  kind: 'idle' | 'permission' | 'question';
  createdAt: number;
  answerState?: 'current' | 'held';
  heldReason?: string;
  options?: Array<{ n: number; label: string }>;
  answerInTerminal?: boolean;
};
type Api = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
interface App {
  approvals: Map<string, Approval>;
  sessions: Map<string, unknown>;
  _approvalDrafts?: Map<string, string>;
  _approvalReadChanges?: Map<string, unknown>;
  _approvalReadSessions?: Map<string, number>;
  _apiJson: Api;
  showToast: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  loadAppSettingsFromStorage: () => { approvalsInboxEnabled: boolean };
  setPendingHook: ReturnType<typeof vi.fn>;
  clearPendingHooks: ReturnType<typeof vi.fn>;
  renderApprovals(): void;
  renderSessionTabs: ReturnType<typeof vi.fn>;
  seedApprovals(): Promise<void>;
  answerApproval(id: string, action: string, option?: number): Promise<void>;
  answerApprovalIdleText(id: string): Promise<void>;
  _onApprovalPending(item: Approval): void;
  _onApprovalUpdated(item: Approval): void;
  _onApprovalResolved(info: { id: string; sessionId: string; kind: string }): void;
  _buildMobileOverviewApprovalStrip(item: Approval, row: unknown): HTMLElement;
  toggleApprovalsInbox(): void;
  closeApprovalsInbox(): void;
}
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const item = (extra: Partial<Approval> = {}): Approval => ({
  id,
  sessionId: sid,
  sessionName: 'Synthetic employee',
  kind: 'idle',
  createdAt: Date.now(),
  answerState: 'current',
  ...extra,
});
type OwnedDOM = { window: Pick<Window, 'document' | 'close'> & { eval: (source: string) => unknown } };
const jsdom: unknown = createRequire(import.meta.url)('jsdom');
if (!jsdom || typeof jsdom !== 'object') throw new Error('JSDOM module unavailable');
const constructor: unknown = Reflect.get(jsdom, 'JSDOM');
const domSchema = z.object({
  window: z.custom<OwnedDOM['window']>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      typeof Reflect.get(value, 'eval') === 'function' &&
      typeof Reflect.get(value, 'close') === 'function' &&
      typeof Reflect.get(value, 'document') === 'object'
  ),
});
const windows: OwnedDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
  vi.useRealTimers();
});
function fixture(api: Api = async () => ({ approvals: [] })) {
  if (typeof constructor !== 'function') throw new Error('JSDOM constructor unavailable');
  const constructed: unknown = Reflect.construct(constructor, [
    '<button class="btn-approvals"><span id="approvalsBadge"></span></button><aside id="approvalsDrawer" class="open"><div class="approvals-list"></div></aside>',
    { runScripts: 'dangerously', url: 'http://synthetic.test' },
  ]);
  const dom = domSchema.parse(constructed);
  windows.push(dom);
  dom.window.eval('class ReverieApp {}\nwindow.ReverieApp=ReverieApp;');
  for (const file of ['constants.js', 'approvals-ui.js', 'mobile-overview.js'])
    dom.window.eval(readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8'));
  const raw: unknown = dom.window.eval('new ReverieApp()');
  if (!raw || typeof raw !== 'object') throw new Error('Owned approval harness did not initialize');
  const app = raw as App;
  app.approvals = new Map();
  app.sessions = new Map();
  app._apiJson = api;
  app.showToast = vi.fn();
  app.selectSession = vi.fn();
  app.setPendingHook = vi.fn();
  app.clearPendingHooks = vi.fn();
  app.renderSessionTabs = vi.fn();
  app.loadAppSettingsFromStorage = () => ({ approvalsInboxEnabled: true });
  Reflect.set(dom.window, 'app', app);
  const render = (approval: Approval) => {
    app.approvals.set(approval.id, approval);
    app.renderApprovals();
  };
  const input = () => dom.window.document.querySelector<HTMLInputElement>('.approval-text-input')!;
  return { app, window: dom.window, document: dom.window.document, render, input };
}

it.each(['permission', 'question', 'idle'] as const)(
  'shows the held reason and disables %s answer controls',
  async (kind) => {
    const api = vi.fn<Api>(async () => ({})),
      h = fixture(api);
    h.render(
      item({
        kind,
        answerState: 'held',
        heldReason: 'Provider changed; do not replay <img src=x onerror=alert(1)>',
        ...(kind === 'question' ? { options: [{ n: 1, label: 'Continue' }] } : {}),
      })
    );
    expect(h.document.querySelector('[role="status"]')?.textContent).toContain('Provider changed; do not replay <img');
    expect(h.document.querySelector('.approval-held img')).toBeNull();
    expect(
      [...h.document.querySelectorAll<HTMLButtonElement>('.approval-actions button')].every((button) => button.disabled)
    ).toBe(true);
    await h.app.answerApproval(id, 'approve');
    await h.app.answerApproval(id, 'deny');
    await h.app.answerApproval(id, 'option', 1);
    if (kind === 'idle') {
      h.input().value = 'kept draft';
      await h.app.answerApprovalIdleText(id);
      expect(h.input().value).toBe('kept draft');
    }
    expect(api).not.toHaveBeenCalled();
    expect(h.app.showToast).toHaveBeenCalledWith(expect.stringContaining('Provider changed'), 'warning');
  }
);

it('fails closed for missing readiness and a known held item replaced by an unprojected update', async () => {
  const api = vi.fn<Api>(async () => ({})),
    h = fixture(api);
  h.render(item({ answerState: 'held', heldReason: 'Current provider is not confirmed' }));
  h.app._onApprovalUpdated(item({ answerState: undefined }));
  expect(h.document.querySelector<HTMLButtonElement>('.approval-actions button')?.disabled).toBe(true);
  expect(h.document.querySelector('.approval-held')?.textContent).toContain('not confirmed');
  await h.app.answerApproval(id, 'approve');
  expect(api).not.toHaveBeenCalled();
});

it('preserves an editable draft through current/held/current updates without replaying it', async () => {
  const api = vi.fn<Api>(async () => ({})),
    h = fixture(api);
  h.render(item());
  h.input().value = 'draft with "quotes" <markup>';
  h.input().focus();
  h.input().setSelectionRange(3, 7);
  h.app._onApprovalUpdated(item({ answerState: 'held', heldReason: 'Provider not current' }));
  expect(h.input().value).toBe('draft with "quotes" <markup>');
  expect(h.input().disabled).toBe(false);
  expect(h.document.activeElement).toBe(h.input());
  expect([h.input().selectionStart, h.input().selectionEnd]).toEqual([3, 7]);
  h.app._onApprovalUpdated(item());
  expect(h.input().value).toBe('draft with "quotes" <markup>');
  expect(h.document.querySelector<HTMLButtonElement>('.approval-actions button')?.disabled).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

it('retains a failed physical-dispatch draft and refreshes truth once without replay', async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  const h = fixture(async (path, options) => {
    calls.push({ path, options });
    return options?.method === 'POST'
      ? null
      : { approvals: [item({ answerState: 'held', heldReason: 'Delivery is unconfirmed; do not replay it' })] };
  });
  h.render(item());
  h.input().value = 'my unsent or unconfirmed draft';
  await h.app.answerApprovalIdleText(id);
  expect(calls.map((call) => call.options?.method || 'GET')).toEqual(['POST', 'GET']);
  expect(calls[0].options?.body).toEqual({ action: 'text', text: 'my unsent or unconfirmed draft' });
  expect(h.input().value).toBe('my unsent or unconfirmed draft');
  expect(h.document.querySelector('.approval-held')?.textContent).toContain('unconfirmed; do not replay');
  expect(h.app.showToast).toHaveBeenCalledWith('Answer was not confirmed. No automatic retry was made.', 'warning');
  await h.app.answerApprovalIdleText(id);
  expect(calls).toHaveLength(2);
});

it('keeps drafts and holds answers when the read-only refresh fails', async () => {
  const api = vi.fn<Api>(async () => null),
    h = fixture(api);
  h.render(item());
  h.input().value = 'keep on network failure';
  await h.app.seedApprovals();
  expect(h.input().value).toBe('keep on network failure');
  expect(h.document.querySelector<HTMLButtonElement>('.approval-actions button')?.disabled).toBe(true);
  expect(h.document.querySelector('.approval-held')?.textContent).toContain('could not be refreshed');
  await h.app.answerApprovalIdleText(id);
  expect(api).toHaveBeenCalledTimes(1);
});

it('bounds a hanging read, aborts it, exposes held timeout diagnostics and clears reconciliation logs without POST', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [],
    api = vi.fn<Api>(async (_path, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => {});
    });
  const h = fixture(api);
  Reflect.set(h.window, 'setTimeout', globalThis.setTimeout);
  Reflect.set(h.window, 'clearTimeout', globalThis.clearTimeout);
  h.render(item());
  h.input().value = 'preserved during timeout';
  const pending = h.app.seedApprovals();
  h.app._onApprovalUpdated(item({ answerState: 'held', heldReason: 'Provider unknown' }));
  await vi.advanceTimersByTimeAsync(10000);
  await pending;
  expect(signals[0].aborted).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0][0]).toBe('/api/approvals');
  expect(api.mock.calls[0][1]?.method).toBeUndefined();
  expect(h.document.querySelector('.approval-held')?.textContent).toContain('refresh timed out');
  expect(h.input().value).toBe('preserved during timeout');
  expect(h.app._approvalReadChanges?.size).toBe(0);
  expect(h.app._approvalReadSessions?.size).toBe(0);
  expect(h.app.showToast).toHaveBeenCalledWith(expect.stringContaining('refresh timed out'), 'warning');
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let an older timed-out read overwrite a newer successful snapshot', async () => {
  vi.useFakeTimers();
  let count = 0;
  const signals: AbortSignal[] = [],
    api = vi.fn<Api>(async (_path, options) => {
      if (options?.signal) signals.push(options.signal);
      return ++count === 1 ? new Promise(() => {}) : { approvals: [item()] };
    });
  const h = fixture(api);
  Reflect.set(h.window, 'setTimeout', globalThis.setTimeout);
  Reflect.set(h.window, 'clearTimeout', globalThis.clearTimeout);
  const old = h.app.seedApprovals();
  await h.app.seedApprovals();
  await vi.advanceTimersByTimeAsync(10000);
  await old;
  expect(h.app.approvals.get(id)?.answerState).toBe('current');
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  expect(h.app.showToast).not.toHaveBeenCalled();
  expect(api.mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
});

it('does not let a late list response re-enable an item after a held SSE update', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  h.render(item());
  const pending = h.app.seedApprovals();
  h.app._onApprovalUpdated(item({ answerState: 'held', heldReason: 'Provider changed during refresh' }));
  finish?.({ approvals: [item()] });
  await pending;
  expect(h.document.querySelector<HTMLButtonElement>('.approval-actions button')?.disabled).toBe(true);
  expect(h.document.querySelector('.approval-held')?.textContent).toContain('changed during refresh');
});

it('merges an untouched second approval from an initial list while preserving a held SSE update', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const second = item({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  });
  const pending = h.app.seedApprovals();
  h.app._onApprovalUpdated(item({ answerState: 'held', heldReason: 'Provider changed during initial read' }));
  finish?.({ approvals: [item(), second] });
  await pending;
  expect(h.app.approvals.get(id)?.answerState).toBe('held');
  expect(h.app.approvals.get(second.id)).toEqual(second);
  expect(h.document.querySelectorAll('.approval-card')).toHaveLength(2);
  expect(h.app.setPendingHook).toHaveBeenCalledWith(second.sessionId, 'idle_prompt');
  expect(h.app._approvalReadChanges?.size).toBe(0);
  expect(h.app._approvalReadSessions?.size).toBe(0);
});

it('keeps resolved tombstones absent while merging unrelated list items', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const second = item({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  });
  const pending = h.app.seedApprovals();
  h.app._onApprovalResolved({ id, sessionId: sid, kind: 'idle' });
  finish?.({ approvals: [item(), second] });
  await pending;
  expect([...h.app.approvals.keys()]).toEqual([second.id]);
  expect(h.app.setPendingHook).not.toHaveBeenCalledWith(sid, 'idle_prompt');
});

it('preserves a fresh same-session prompt over a superseded list item without rebinding its draft', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  h.render(item());
  h.input().value = 'draft for superseded approval';
  const pending = h.app.seedApprovals();
  const fresh = item({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    answerState: 'held',
    heldReason: 'Fresh prompt requires current-provider proof',
  });
  h.app._onApprovalPending(fresh);
  h.app._onApprovalResolved({ id, sessionId: sid, kind: 'idle' });
  finish?.({ approvals: [item()] });
  await pending;
  expect([...h.app.approvals.values()]).toEqual([fresh]);
  expect(h.input().value).toBe('');
  expect(h.app._approvalDrafts?.has(id)).toBe(false);
});

it('does not hide a different fresh prompt from the snapshot when only its predecessor resolved', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = h.app.seedApprovals();
  h.app._onApprovalResolved({ id, sessionId: sid, kind: 'idle' });
  const fresh = item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', answerState: 'held', heldReason: 'New prompt' });
  finish?.({ approvals: [fresh] });
  await pending;
  expect([...h.app.approvals.values()]).toEqual([fresh]);
});

it('shows an ambiguous different same-session snapshot held after pending then resolved events and requires explicit refresh', async () => {
  let finish: ((value: unknown) => void) | undefined,
    reads = 0;
  const fresh = item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  const api = vi.fn<Api>(async () =>
    ++reads === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { approvals: [fresh] }
  );
  const h = fixture(api),
    pending = h.app.seedApprovals();
  h.app._onApprovalPending(item());
  h.app._onApprovalResolved({ id, sessionId: sid, kind: 'idle' });
  finish?.({ approvals: [fresh] });
  await pending;
  expect([...h.app.approvals.keys()]).toEqual([fresh.id]);
  expect(h.app.approvals.get(fresh.id)?.answerState).toBe('held');
  expect(h.document.querySelector('.approval-held')?.textContent).toContain('may be stale; reopen the inbox');
  expect(h.document.querySelector<HTMLButtonElement>('.approval-actions button')?.disabled).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
  await h.app.seedApprovals();
  expect(h.app.approvals.get(fresh.id)?.answerState).toBe('current');
  expect(api.mock.calls).toEqual([
    ['/api/approvals', expect.objectContaining({ signal: expect.anything() })],
    ['/api/approvals', expect.objectContaining({ signal: expect.anything() })],
  ]);
});

it('does not resurrect a known superseded predecessor if its replacement also resolves during the read', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const h = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  h.render(item());
  const pending = h.app.seedApprovals();
  const fresh = item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  h.app._onApprovalPending(fresh);
  h.app._onApprovalResolved({ id: fresh.id, sessionId: sid, kind: 'idle' });
  finish?.({ approvals: [item()] });
  await pending;
  expect(h.app.approvals.size).toBe(0);
});

it('lets the latest overlapping list reconcile SSE updates without a later old response dropping other items', async () => {
  const finishers: Array<(value: unknown) => void> = [];
  const h = fixture(() => new Promise((resolve) => finishers.push(resolve)));
  const first = h.app.seedApprovals(),
    second = h.app.seedApprovals();
  const other = item({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
  h.app._onApprovalUpdated(item({ answerState: 'held', heldReason: 'Newer provider state' }));
  finishers[1]({ approvals: [item(), other] });
  await second;
  finishers[0]({ approvals: [item()] });
  await first;
  expect(h.app.approvals.get(id)?.answerState).toBe('held');
  expect(h.app.approvals.get(other.id)).toEqual(other);
});

it('sends exactly one explicit current answer and never submits while opening the inbox', async () => {
  const api = vi.fn<Api>(async (_path, options) =>
      options?.method === 'POST' ? { sent: true } : { approvals: [item({ kind: 'permission' })] }
    ),
    h = fixture(api);
  h.render(item({ kind: 'permission' }));
  await h.app.answerApproval(id, 'approve');
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith(expect.stringContaining('/answer'), { method: 'POST', body: { action: 'approve' } });
  h.app.closeApprovalsInbox();
  h.app.toggleApprovalsInbox();
  await Promise.resolve();
  expect(api).toHaveBeenCalledTimes(2);
  expect(api.mock.calls[1]).toEqual(['/api/approvals', expect.objectContaining({ signal: expect.anything() })]);
});

it('disables actual mobile answer buttons on held/unknown updates while keeping terminal navigation available', async () => {
  const api = vi.fn<Api>(async () => ({})),
    h = fixture(api);
  const renderMobile = (approval: Approval) => {
    h.app.approvals.set(id, approval);
    const strip = h.app._buildMobileOverviewApprovalStrip(approval, {});
    h.document.body.append(strip);
    return strip;
  };
  const held = renderMobile(
    item({ kind: 'permission', answerState: 'held', heldReason: 'Current provider is unavailable' })
  );
  expect(held.textContent).toContain('provider is unavailable');
  for (const button of held.querySelectorAll<HTMLButtonElement>('button')) {
    expect(button.disabled).toBe(true);
    button.click();
  }
  const unknown = renderMobile(
    item({ kind: 'question', answerState: undefined, options: [{ n: 1, label: 'Continue' }] })
  );
  expect(unknown.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  const current = renderMobile(item({ kind: 'permission' }));
  current.querySelector<HTMLButtonElement>('button')!.click();
  await Promise.resolve();
  expect(api).toHaveBeenCalledTimes(1);
  const terminal = renderMobile(item({ kind: 'permission', answerState: 'held', answerInTerminal: true }));
  const open = terminal.querySelector<HTMLButtonElement>('button')!;
  expect(open.disabled).toBe(false);
  open.click();
  expect(h.app.selectSession).toHaveBeenCalledWith(sid);
  expect(api).toHaveBeenCalledTimes(1);
});

it('discards resolved or superseded drafts instead of transferring them to another approval', () => {
  const h = fixture();
  h.render(item());
  h.input().value = 'private draft for original';
  h.app._onApprovalPending(item({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }));
  expect(h.input().value).toBe('');
  expect(h.app._approvalDrafts?.has(id)).toBe(false);
});
