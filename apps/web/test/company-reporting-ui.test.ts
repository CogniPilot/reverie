import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const handles: any[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); });
async function setup(owner = true, refuse = false) {
  const employees = [
    { id: 'lead', sessionId: 'lead-runtime', name: 'Lead', position: 'Reviewer', reportsTo: 'owner', available: true },
    { id: 'river', sessionId: 'river-runtime', name: 'River', position: 'Engineer', reportsTo: 'lead', available: false },
    { id: 'peer', sessionId: 'peer-runtime', name: 'Peer', position: 'Researcher', reportsTo: 'owner', available: true },
  ].map(e => ({ ...e, icon: 'R', permissions: { recoverEmployees: false } }));
  const company = { canManage: owner, settings: { ownerName: 'Owner' }, employees };
  const h = await createHarness({ company }); handles.push(h);
  const writes: any[] = [];
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (options?.method === 'PUT' && path.startsWith('/api/company/employees/')) {
      writes.push({ path, body: options.body });
      if (refuse) return { ok: false, status: 403, error: 'Save refused' };
      const employee = employees.find(e => path.endsWith('/' + e.id))!;
      Object.assign(employee, options.body);
      return { ok: true, data: { employee: structuredClone(employee) } };
    }
    return original(path, options);
  };
  await h.shell.openCompany('people'); await h.flush();
  const card = (id: string) => h.document.querySelector(`[data-employee-id="${id}"].ca-company-person`) as HTMLElement;
  const drag = (from: HTMLElement, onto: HTMLElement) => {
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    for (const [target, type] of [[from, 'dragstart'], [onto, 'dragover'], [onto, 'drop']] as const) {
      const event = new h.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event);
    }
  };
  return { h, employees, writes, card, drag };
}

it('keeps the reporting overview compact and makes an offline person editable through the same profile', async () => {
  const { h, card, writes } = await setup();
  const offline = card('river'); expect(offline.classList.contains('is-offline')).toBe(true);
  expect(offline.querySelectorAll('input[type=checkbox], .ca-company-actions, .ca-company-work, .ca-company-person-controls')).toHaveLength(0);
  expect(offline.querySelector('select')!.disabled).toBe(false);
  expect(h.document.querySelector('.ca-company-work-list')!.closest('.ca-company-chart')).toBeNull();
  (offline.querySelector('.ca-company-icon') as HTMLElement).click(); await h.flush();
  expect(h.document.querySelector('.ca-expert-profile')!.getAttribute('aria-label')).toBe('Edit profile: River');
  expect(h.document.querySelector('.ca-expert-profile [aria-label="Recovery permission for River"]')).not.toBeNull();
  expect(writes).toEqual([]);
});

it('reparents by drag using only the existing one-field employee update', async () => {
  const { h, card, drag, writes, employees } = await setup();
  drag(card('river'), card('peer')); await h.flush();
  expect(writes).toEqual([{ path: '/api/company/employees/river', body: { reportsTo: 'peer' } }]);
  expect(employees.find(e => e.id === 'river')!.reportsTo).toBe('peer');
  expect((card('river').querySelector('select') as HTMLSelectElement).value).toBe('peer');
});

it('supports dropping on the owner and preserves dropdown reparenting', async () => {
  const { h, card, drag, writes } = await setup();
  drag(card('river'), h.document.querySelector('.ca-company-owner')); await h.flush();
  const select = card('river').querySelector('select') as HTMLSelectElement;
  select.value = 'peer'; select.dispatchEvent(new h.window.Event('change')); await h.flush();
  expect(writes.map(w => w.body)).toEqual([{ reportsTo: 'owner' }, { reportsTo: 'peer' }]);
});

it('does not send self, descendant or external drops to the server', async () => {
  const { h, card, drag, writes } = await setup();
  drag(card('lead'), card('river')); drag(card('lead'), card('lead'));
  card('peer').dispatchEvent(new h.window.Event('drop', { bubbles: true, cancelable: true })); await h.flush();
  expect(writes).toEqual([]);
});

it('restores the reporting choice and displays a refusal without retrying', async () => {
  const { h, card, drag, writes } = await setup(true, true);
  drag(card('river'), card('peer')); await h.flush();
  expect(writes).toHaveLength(1);
  expect((card('river').querySelector('select') as HTMLSelectElement).value).toBe('lead');
  expect(card('river').textContent).toContain('Save refused');
});

it('never enables drag or owner profile controls from an expert title', async () => {
  const { h, card, drag, writes } = await setup(false);
  expect(card('lead').draggable).toBe(false);
  expect(h.document.querySelector('[aria-label="Edit profile for Lead"]')).toBeNull();
  expect(card('river').querySelector('select')).toBeNull();
  drag(card('river'), card('peer')); await h.flush(); expect(writes).toEqual([]);
});


it('lays out parents above children, siblings side by side and real SVG reporting edges', async () => {
  const { h, card, writes } = await setup();
  const lead = card('lead'), river = card('river'), peer = card('peer');
  expect(Number.parseFloat(lead.style.top)).toBeLessThan(Number.parseFloat(river.style.top));
  expect(lead.style.top).toBe(peer.style.top);
  expect(lead.style.left).not.toBe(peer.style.left);
  expect(river.dataset.parentId).toBe('lead');
  expect(h.document.querySelectorAll('.ca-company-map-links path')).toHaveLength(3);
  expect(h.document.querySelector('.ca-company-map-links path[data-parent-id="lead"][data-child-id="river"]')).not.toBeNull();
  expect(h.document.querySelector('.ca-company-tree ul')).toBeNull();
  expect(writes).toEqual([]);
});

it('fits the full diagram, zooms without writes and removes its resize listener on navigation', async () => {
  const { h, writes } = await setup();
  const viewport = h.document.querySelector('.ca-company-map-viewport') as HTMLElement;
  Object.defineProperties(viewport, { clientWidth: { value: 500 }, clientHeight: { value: 400 } });
  (h.document.querySelector('[aria-label="Fit entire company"]') as HTMLButtonElement).click();
  const stage = h.document.querySelector('.ca-company-map-stage') as HTMLElement;
  expect(Number.parseFloat(stage.style.width)).toBeLessThanOrEqual(500);
  expect(Number.parseFloat(stage.style.height)).toBeLessThanOrEqual(400);
  const scale = Number(viewport.dataset.scale);
  (h.document.querySelector('[aria-label="Zoom in reporting chart"]') as HTMLButtonElement).click();
  expect(Number(viewport.dataset.scale)).toBeGreaterThan(scale);
  (h.document.querySelector('[aria-label="Show reporting chart at 100%"]') as HTMLButtonElement).click();
  expect(Number(viewport.dataset.scale)).toBe(1); expect(writes).toEqual([]);
  const listener = h.shell._companyChartResize; h.shell.closePage();
  expect(listener).toBeTypeOf('function'); expect(h.shell._companyChartResize).toBeNull();
});
