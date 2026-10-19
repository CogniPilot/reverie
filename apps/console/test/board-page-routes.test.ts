import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { registerBoardPageRoutes } from '../src/web/routes/board-page-routes.js';

const SHIPPED = join(__dirname, '..', 'src', 'web', 'public', 'board.html');

describe('GET /board (page)', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-page-'));
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page from the console origin, never cached, on /board and /board.html', async () => {
    writeFileSync(join(dir, 'board.html'), '<!doctype html><title>Board</title>');
    app = Fastify();
    registerBoardPageRoutes(app, dir);
    await app.ready();
    for (const url of ['/board', '/board.html']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toContain('<title>Board</title>');
    }
  });

  it('answers a clear 404 when the page is not installed', async () => {
    app = Fastify();
    registerBoardPageRoutes(app, dir);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/board' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('shipped board.html', () => {
  const html = readFileSync(SHIPPED, 'utf-8');

  it('reads the board API with the viewer login and refreshes every minute', () => {
    expect(html).toContain("fetch('/api/board'");
    expect(html).toContain("credentials: 'same-origin'");
    expect(html).toContain('setInterval(load, 60e3)');
  });

  it('has a phone viewport and no horizontal page overflow rule it relies on', () => {
    expect(html).toContain('name="viewport"');
    expect(html).toContain('[hidden]{display:none!important}');
  });

  it('its script parses', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('calls no external host', () => {
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
  });

  // The plan account actions moved here from the old /plans page.
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
  const between = (from: string, to: string) => script.slice(script.indexOf(from), script.indexOf(to));
  const planActions = (planEdit: string | null, planErr: Record<string, string> = {}) =>
    new vm.Script(`${/const esc = .*/.exec(script)?.[0]}\n${between('function planActions(p)', 'function wirePlanActions')}; planActions`).runInNewContext({ planEdit, planErr }) as (p: object) => string;
  const plan = { id: 'p-1', profileId: 'p-1', provider: 'anthropic', isDefault: false, label: 'Work <a>' };

  it('uses only the plans and subscription-profile account APIs for the plan actions', () => {
    const paths = new Set([...between('/* ---------- Plan accounts', "document.getElementById('addAcct').onclick").matchAll(/['"`](\/api\/[a-z/-]+)/g)].map((m) => m[1]));
    expect([...paths].sort()).toEqual(['/api/plans/accounts/', '/api/plans/logins/', '/api/subscription-profiles', '/api/subscription-profiles/']);
    expect(script).toContain("method: 'PATCH', body: {label}");
    expect(html).toMatch(/<dialog id="addDlg"[\s\S]*<dialog id="signDlg"[\s\S]*<dialog id="removeDlg"/);
  });

  it('offers Rename only with a profile id, says why without one, and keeps Remove off the defaults', () => {
    const full = planActions(null)(plan);
    expect(full).toContain('data-rename="p-1"');
    expect(full).toContain('data-signin="p-1"');
    expect(full).toContain('data-remove="p-1"');
    const folder = planActions(null)({ ...plan, id: 'acct-anthropic-spare', profileId: null });
    expect(folder).not.toContain('data-rename');
    expect(folder).not.toContain('data-remove');
    expect(folder).toContain('data-signin="acct-anthropic-spare"');
    expect(folder).toMatch(/No rename or remove: this account is only a login folder/);
    const def = planActions(null)({ ...plan, isDefault: true });
    expect(def).toContain('data-rename');
    expect(def).not.toContain('data-remove');
  });

  it('shows the rename form with the current label escaped, and a refused rename as a visible error', () => {
    const form = planActions('p-1', { 'p-1': 'Not renamed: Only the owner renames accounts' })(plan);
    expect(form).toContain('data-rename-form="p-1"');
    expect(form).toContain('value="Work &lt;a&gt;"');
    expect(form).toMatch(/blank after a rename/);
    expect(form).toMatch(/class="err" role="alert">Not renamed: Only the owner renames accounts/);
  });

  // The real plan-account code in a DOM. jsdom has no dialog methods, so these follow the spec: close() queues the close event as a task.
  const accountDom = () => {
    const dom = new JSDOM('<dialog id="signDlg"></dialog><dialog id="addDlg"></dialog><dialog id="removeDlg"></dialog><div id="plans"></div>', { runScripts: 'outside-only' });
    const w = dom.window as unknown as Window & { eval: (src: string) => unknown };
    for (const d of w.document.querySelectorAll('dialog')) {
      Object.assign(d, {
        showModal() { d.setAttribute('open', ''); },
        close() { if (!d.hasAttribute('open')) return; d.removeAttribute('open'); w.setTimeout(() => d.dispatchEvent(new w.Event('close')), 0); },
      });
      Object.defineProperty(d, 'open', { get: () => d.hasAttribute('open') });
    }
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const replies: Record<string, { status: number; body: unknown }> = {};
    let next = 0;
    Object.assign(w, {
      fetch: async (path: string, opts: { method?: string; body?: string } = {}) => {
        const method = opts.method ?? 'GET';
        calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : undefined });
        const r = replies[method + ' ' + path] ?? { status: 200, body: { success: true, data: { id: 'login' + (path.endsWith('/login') ? ++next : next), state: 'waiting', message: 'wait' } } };
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      },
      load: async () => {},
    });
    w.eval(`${/const esc = .*/.exec(script)?.[0]}\n${between('/* ---------- Plan accounts', "document.getElementById('addAcct').onclick")}; var plans = () => {}; var B = {};
      globalThis.acct = { sign: () => sign, edit: (id) => { planEdit = id; } };`);
    const tick = () => new Promise((r) => setTimeout(r, 20));
    return { w, calls, replies, tick };
  };

  it('a sign-in retry keeps the new login open and cancels only the old one', async () => {
    const { w, calls, tick } = accountDom();
    await w.eval(`startSignIn('acct-1', 'Work')`);
    await w.eval(`startSignIn('acct-1', 'Work')`);
    await tick();
    expect(w.document.getElementById('signDlg')?.hasAttribute('open')).toBe(true);
    expect(w.eval('acct.sign()?.view?.id')).toBe('login2');
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/plans/logins/login1']);
    // Closing the dialog (Esc) still cancels the live login, once.
    (w.document.getElementById('signDlg') as HTMLDialogElement).close();
    await tick();
    expect(w.eval('acct.sign()')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/plans/logins/login1', '/api/plans/logins/login2']);
  });

  it('shows an empty or refused rename in the alert and leaves the who-note hint alone', async () => {
    const { w, replies, calls } = accountDom();
    const hint = "The 'who' line under the name is kept under the old name, so it is blank after a rename until it is set again.";
    const submit = async (value: string) => {
      w.eval(`B.planBurn = [{id: 'p-1', profileId: 'p-1', provider: 'anthropic', isDefault: false, label: 'Work'}]; acct.edit('p-1');
        document.getElementById('plans').innerHTML = planActions(B.planBurn[0]); wirePlanActions(document.getElementById('plans'));`);
      const form = w.document.querySelector('[data-rename-form]') as HTMLFormElement;
      (form.elements.namedItem('label') as HTMLInputElement).value = value;
      await (form.onsubmit as (e: object) => Promise<void>)({ preventDefault() {} });
      return { alert: w.document.querySelector('.err[role=alert]')?.textContent, hint: w.document.querySelector('#plans .hint')?.textContent };
    };
    expect(await submit('  ')).toEqual({ alert: 'The name cannot be empty', hint });
    expect(calls).toEqual([]);
    for (const [status, error] of [[403, 'Only the owner renames accounts'], [409, 'Another account already has that name']] as const) {
      replies['PATCH /api/subscription-profiles/p-1'] = { status, body: { success: false, error } };
      expect(await submit('Default Claude')).toEqual({ alert: 'Not renamed: ' + error, hint });
    }
  });

  it('never reloads the page from a refused account call, and refuses an empty name before sending', () => {
    const acct = between('/* ---------- Plan accounts', "document.getElementById('addAcct').onclick");
    expect(acct).not.toContain('location.reload');
    expect(acct).toContain("'The name cannot be empty'");
    expect(acct).toContain("credentials: 'same-origin'");
  });
});
