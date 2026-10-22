import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
import { COMPANY_ROLE_TEMPLATES } from '../src/company-role-templates.js';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.close(); vi.restoreAllMocks(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
async function setup(manage = true) {
  const h = await createHarness(); opened.push(h);
  const company: any = { canManage: manage, settings: { ownerName: 'Owner' }, employees: [{ id: 'existing', sessionId: 'old-session', name: 'Alex', position: 'Engineer', expertise: ['Testing'], permissions: { recoverEmployees: false }, avatar: '/assets/avatars/pack-01.png', available: false }] };
  const calls: any[] = [];
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: manage ? 'owner' : 'guest', canSetOwn: manage } };
    if (path === '/api/company/hire-options') return { ok: true, data: { roles: COMPANY_ROLE_TEMPLATES, harnesses: [{ id: 'codex', label: 'Codex' }, { id: 'opencode', label: 'OpenCode' }], sources: [{ id: 'work', kind: 'subscription', label: 'Codex plan', modes: ['opencode', 'codex'], defaultMode: 'codex' }] } };
    if (path === '/api/company/hire') { calls.push(options.body); const employee = { ...options.body, id: 'hired-person', sessionId: 'new-runtime', available: true }; company.employees.push(employee); return { ok: true, data: { employee, sessionId: employee.sessionId } }; }
    if (path === '/api/voice/options') return { ok: true, data: { voices: [] } };
    return original(path, options);
  };
  const fetch = h.window.fetch;
  const photos: string[] = [];
  h.window.fetch = async (url: any, options: any) => {
    if (url === '/assets/avatars/pack-manifest.json') return { ok: true, json: async () => ({ avatars: [1, 2].map(n => ({ id: `pack-0${n}`, name: `Picture ${n}`, src: `/assets/avatars/pack-0${n}.png` })) }) };
    if (String(url).startsWith('/assets/avatars/pack-')) { photos.push(String(url)); return { ok: true, blob: async () => new h.window.Blob(['png'], { type: 'image/png' }) }; }
    return fetch(url, options);
  };
  h.shell.imageToIcon = async () => 'data:image/png;base64,aW1hZ2U=';
  vi.spyOn(h.shell, 'saveEmployeePicture').mockResolvedValue(true);
  await h.shell.openCompany('people'); await settle();
  const form = h.document.querySelector('.ca-company-hire form') as HTMLFormElement;
  const field = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement;
  const next = () => (form.querySelector('[aria-label="Next"]') as HTMLButtonElement).click();
  return { h, company, calls, form, field, next, photos };
}

describe('role-first owner hiring wizard', () => {
  it.each([0, 1, 2, 3])('cancels at step %i without creating a runtime or changing the roster', async step => {
    const { h, form, field, next, calls, company } = await setup();
    const plus = h.document.querySelector('.ca-company-people-heading [aria-label="Hire"]') as HTMLButtonElement;
    plus.click();
    field('roleTemplate').value = 'software'; field('roleTemplate').dispatchEvent(new h.window.Event('change'));
    if (step > 0) next();
    if (step > 1) next();
    if (step > 2) { field('plan').value = 'subscription:work'; field('plan').dispatchEvent(new h.window.Event('change')); next(); }
    expect(form.querySelector('.ca-hire-progress')?.textContent).toContain(`Step ${step + 1}`);
    const cancel = form.querySelector('[aria-label="Cancel hire"]') as HTMLButtonElement;
    expect(cancel.hidden).toBe(false); expect(cancel.closest('fieldset')).toBeNull();
    cancel.click(); await settle();
    expect((h.document.querySelector('.ca-company-hire') as HTMLElement).hidden).toBe(true);
    expect(plus.getAttribute('aria-expanded')).toBe('false'); expect(h.document.activeElement).toBe(plus);
    expect(calls).toEqual([]); expect(company.employees).toHaveLength(1);
    expect(h.shell.saveEmployeePicture).not.toHaveBeenCalled();
    expect(h.document.querySelector('.ca-company-chart')?.textContent).toContain('Alex');
  });
  it('opens beside People, preserves edits Back/Next, reviews exact permissions, and adds the hired person to the roster', async () => {
    const { h, form, field, next, calls, photos } = await setup();
    const plus = h.document.querySelector('.ca-company-people-heading [aria-label="Hire"]') as HTMLButtonElement;
    expect(plus.textContent).toBe('+'); plus.click();
    expect(h.document.activeElement).toBe(field('roleTemplate'));
    expect(form.querySelector('.ca-hire-progress')?.textContent).toContain('Step 1 of 4');
    expect(field('model')).toBeNull(); expect(field('effort')).toBeNull();
    field('roleTemplate').value = 'cto'; field('roleTemplate').dispatchEvent(new h.window.Event('change'));
    expect(field('position').value).toBe('Chief Technology Officer');
    expect(field('responsibilities').value).toContain('roadmap');
    expect((field('recoverEmployees') as HTMLInputElement).checked).toBe(false);
    field('position').value = 'Technical lead'; field('responsibilities').value = 'Review flight software\nVerify changes on recorded data';
    field('expertise').value = 'Code review, SLAM'; next();
    field('name').value = 'Rowan'; field('personality').value = 'Patient and precise. Explain uncertainty.'; field('pronouns').value = 'they/them';
    next(); field('plan').value = 'subscription:work'; field('plan').dispatchEvent(new h.window.Event('change'));
    expect(field('mode').value).toBe('codex');
    (field('sleepEnabled') as HTMLInputElement).checked = true;
    (field('dreamEnabled') as HTMLInputElement).checked = true;
    (field('recoverEmployees') as HTMLInputElement).checked = true;
    (field('managePlans') as HTMLInputElement).checked = true;
    (form.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
    expect(field('personality').value).toContain('Patient'); next();
    expect(field('plan').value).toBe('subscription:work'); next();
    expect(calls).toHaveLength(0);
    expect(form.querySelector('.ca-hire-review')?.textContent).toContain('Technical lead');
    expect(form.querySelector('.ca-hire-review')?.textContent).toContain('May wake reporting experts');
    expect(photos).not.toContain('/assets/avatars/pack-01.png');
    expect(photos).toContain('/assets/avatars/pack-02.png');
    (form.querySelector('button[type=submit]') as HTMLButtonElement).click(); await settle();
    expect(calls).toEqual([{ name: 'Rowan', icon: 'R', position: 'Technical lead', expertise: ['Code review', 'SLAM'], responsibilities: ['Review flight software', 'Verify changes on recorded data'], personality: 'Patient and precise. Explain uncertainty.', pronouns: 'they/them', permissions: { recoverEmployees: true, moveOwnPlan: false, managePlans: true }, sleepEnabled: true, dreamEnabled: true, source: { kind: 'subscription', profileId: 'work' }, mode: 'codex', reportsTo: 'owner' }]);
    expect(h.document.querySelector('.ca-company-chart')?.textContent).toContain('Rowan');
    expect(h.document.querySelector('.ca-company-people-heading')?.textContent).toContain('People · 2');
    expect(h.shell.saveEmployeePicture).toHaveBeenCalledWith('new-runtime', 'data:image/png;base64,aW1hZ2U=');
  });
  it('suggests a distinct editable name and prevents a duplicate before review', async () => {
    const { h, field, next, form } = await setup();
    vi.spyOn(h.window.Math, 'random').mockReturnValue(0);
    (form.querySelector('[aria-label="Suggest another name"]') as HTMLButtonElement).click();
    expect(field('name').value).toBe('Alex 2');
    field('roleTemplate').value = 'software'; field('roleTemplate').dispatchEvent(new h.window.Event('change')); next();
    field('name').value = ' alex '; next();
    expect(form.querySelector('.ca-hire-progress')?.textContent).toContain('Step 2');
    expect(form.querySelector('[role=alert]')?.textContent).toContain('already used');
    field('name').value = 'Alex Rivera'; next();
    expect(form.querySelector('.ca-hire-progress')?.textContent).toContain('Step 3');
  });
  it('does not expose hire or recovery grants to an unverified owner', async () => {
    const { h } = await setup(false);
    expect(h.document.querySelector('[aria-controls="ca-company-hire"]')).toBeNull();
    expect(h.document.querySelector('[name="recoverEmployees"]')).toBeNull();
  });
  it('keeps role details editable later and preserves unrelated profile fields on save', async () => {
    const { h } = await setup();
    const requests: any[] = [];
    const original = h.app._chatApi.bind(h.app);
    h.app._chatApi = async (path: string, options: any) => {
      if (path === '/api/company/employees/existing') { requests.push(options.body); return { ok: true, data: {} }; }
      return original(path, options);
    };
    h.shell.openEmployeeProfile({ id: 'existing', sessionId: 'old-session', name: 'Alex', position: 'Engineer', expertise: ['Testing'], responsibilities: ['Review tests'], personality: 'Direct', pronouns: 'he/him', sleepEnabled: true, dreamEnabled: false }, () => {});
    const form = h.document.querySelector('.ca-expert-profile form') as HTMLFormElement;
    (form.querySelector('[name="responsibilities"]') as HTMLTextAreaElement).value = 'Review tests\nMeasure regressions';
    (form.querySelector('[name="personality"]') as HTMLTextAreaElement).value = 'Patient and direct';
    form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await settle();
    expect(requests[0]).toMatchObject({ responsibilities: ['Review tests', 'Measure regressions'], personality: 'Patient and direct', pronouns: 'he/him', sleepEnabled: true, dreamEnabled: false });
    expect(requests[0]).not.toHaveProperty('permissions');
    expect(requests[0]).not.toHaveProperty('expertise');
  });
});
