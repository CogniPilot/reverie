import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const root = new URL('../src/web/public/', import.meta.url);
const html = readFileSync(new URL('command-failures.html', root), 'utf8');
const source = readFileSync(new URL('command-failures.js', root), 'utf8');
const script = new vm.Script(source.replace('export function validFailureReport', 'function validFailureReport')
  .replace('export class CommandFailureView', 'class CommandFailureView') + '\nglobalThis.fixture = {CommandFailureView, validFailureReport};');
type View = { load(): Promise<void>; render(report: unknown): void; close(): void; select: HTMLSelectElement };
type Fixture = { CommandFailureView: new (doc: Document, request: unknown) => View; validFailureReport(report: unknown): boolean };
const context = vm.createContext({ AbortController }); script.runInContext(context);
const api = context.fixture as Fixture;
const windows: JSDOM[] = [];
afterEach(() => { for (const window of windows.splice(0)) window.window.close(); });
const row = (id = A) => ({ employee_id: id, harness: 'hands', status: 'ready',
  counts: [{ tool: 'zip', category: 'COMMAND_NOT_FOUND', exit: 127, count: 2 }],
  truncated: false, evicted: 0, expired: 0, dropped: 0 });
const report = (id = A) => ({ v: 1, enabled: true, provenance: 'SELF_REPORTED_RESULT',
  harness_support: { hands: 'self_reported', claude: 'unavailable', codex: 'unavailable' },
  employees: [row(id)], top_repeats: [{ tool: 'zip', category: 'COMMAND_NOT_FOUND', exit: 127, count: 2, employee_count: 1 }], truncated: false });
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => ({ success: true, data }) });
function fixture(request?: (path: string, options: { signal: AbortSignal; cache: string; credentials: string }) => Promise<unknown>) {
  const dom = new JSDOM(html, { url: 'http://localhost/base/command-failures' }); windows.push(dom);
  const doc = dom.window.document;
  const fetcher = request ?? (async (path: string) => response(path === 'api/company' ? { employees: [{ id: A, name: 'Example employee' }] } : report()));
  const view = new api.CommandFailureView(doc, fetcher);
  return { dom, doc, view };
}

describe('command failure owner view', () => {
  it('renders fixed counts, per-agent names and explicit producer coverage', async () => {
    const { doc, view } = fixture(); await view.load();
    expect(doc.getElementById('employees')!.textContent).toContain('Example employee');
    expect(doc.getElementById('employees')!.textContent).toContain('zip');
    expect(doc.getElementById('repeats')!.textContent).toContain('Not found');
    expect(doc.getElementById('coverage')!.textContent).toContain('Claude and Codex logging is not installed');
    expect(doc.querySelectorAll('table')).toHaveLength(2);
    expect(doc.querySelectorAll('button')).toHaveLength(1);
  });
  it('only sends same-origin no-store GET reads, never a write or enablement action', async () => {
    const calls: string[] = [];
    const { view } = fixture(async (path, options) => {
      calls.push(path); expect(options.cache).toBe('no-store'); expect(options.credentials).toBe('same-origin');
      expect(Object.hasOwn(options, 'method')).toBe(false);
      return response(path === 'api/company' ? { employees: [{ id: A, name: 'Example' }] } : report());
    });
    await view.load(); expect(calls).toEqual(['api/company', 'api/company/command-failures']);
  });
  it('distinguishes disabled, empty and unavailable without an active enable button', () => {
    const { doc, view } = fixture();
    const disabled = { ...report(), enabled: false, top_repeats: [], employees: [{ ...row(), status: 'disabled', counts: [] }] };
    view.render(disabled); expect(doc.getElementById('status')!.textContent).toContain('Logging is off');
    view.render({ ...report(), top_repeats: [], employees: [{ ...row(), status: 'no_data', counts: [] }] });
    expect(doc.getElementById('employees')!.textContent).toContain('No failure log has been recorded');
    view.render({ ...report(), top_repeats: [], employees: [{ ...row(), status: 'unavailable', counts: [] }] });
    expect(doc.getElementById('status')!.textContent).toContain('unavailable');
    expect(doc.getElementById('employees')!.textContent).not.toContain('No failures within retention');
  });
  it('discards stale report responses after selection changes', async () => {
    let firstResolve!: (value: unknown) => void;
    let reads = 0;
    const { doc, view } = fixture(async path => {
      if (path === 'api/company') return response({ employees: [{ id: A, name: 'Example A' }, { id: B, name: 'Example B' }] });
      reads++;
      if (reads === 1) return new Promise(resolve => { firstResolve = resolve; });
      return response(report(B));
    });
    const first = view.load();
    await vi.waitFor(() => expect(reads).toBe(1));
    view.select.value = B;
    const second = view.load(); await second;
    expect(doc.getElementById('employees')!.textContent).toContain('Example B');
    firstResolve(response(report(A))); await first;
    expect(doc.getElementById('employees')!.textContent).not.toContain('Example A');
  });
  it('does not repaint after caller close/abort even if the fetch ignores cancellation', async () => {
    let resolve!: (value: unknown) => void;
    const { doc, view } = fixture(async path => path === 'api/company' ? response({ employees: [{ id: A, name: 'Example' }] }) : new Promise(done => { resolve = done; }));
    const loading = view.load();
    await vi.waitFor(() => expect(typeof resolve).toBe('function'));
    view.close(); resolve(response(report())); await loading;
    expect(doc.getElementById('employees')!.textContent).toBe('');
    expect(doc.getElementById('repeats')!.textContent).toBe('');
    expect(view.select.options).toHaveLength(1);
  });
  it('clears data and names on owner refusal and never renders response error text', async () => {
    const { doc, view } = fixture(async path => path === 'api/company' ? response({ employees: [{ id: A, name: 'Example' }] }) :
      { ok: false, status: 403, json: async () => ({ error: 'SYNTHETIC_PRIVATE' }) });
    await view.load();
    expect(doc.getElementById('status')!.textContent).toContain('Sign in as the owner');
    expect(doc.body.textContent).not.toContain('SYNTHETIC_PRIVATE');
    expect(view.select.options).toHaveLength(1);
    expect(view.select.textContent).not.toContain('Example');
  });
  it('refuses unknown tools, extra fields and arbitrary counter strings before rendering', async () => {
    const cases = [{ ...report(), argv: 'SYNTHETIC_PRIVATE' },
      { ...report(), employees: [{ ...row(), counts: [{ ...row().counts[0], tool: 'SYNTHETIC_PRIVATE' }] }] },
      { ...report(), employees: [{ ...row(), dropped: 'SYNTHETIC_PRIVATE' }] }];
    for (const bad of cases) {
      expect(api.validFailureReport(bad)).toBe(false);
      const { doc, view } = fixture(async path => response(path === 'api/company' ? { employees: [{ id: A, name: 'Example' }] } : bad));
      await view.load(); expect(doc.body.textContent).not.toContain('SYNTHETIC_PRIVATE');
      expect(doc.getElementById('status')!.textContent).toContain('unavailable');
    }
  });
  it('keeps canonical display names as text instead of executable markup', async () => {
    const { doc, view } = fixture(async path => response(path === 'api/company' ? { employees: [{ id: A, name: '<img src=x onerror=alert(1)>' }] } : report()));
    await view.load(); expect(doc.querySelectorAll('img')).toHaveLength(0);
    expect(doc.getElementById('employees')!.textContent).toContain('<img');
  });
});
