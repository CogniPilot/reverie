import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const handles: any[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); vi.restoreAllMocks(); });
async function setup({ companyCore = [] as string[], personal = undefined as string[] | undefined, context = undefined as any } = {}) {
  const employee: any = { id: 'river', sessionId: 'runtime', sessionGeneration: 2, name: 'River', icon: 'R', position: 'Reviewer', reportsTo: 'owner', onVacation: true, coreBeliefs: personal,
    effectiveCoreBeliefs: [...companyCore, ...(personal || [])], permissions: {}, effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false }, boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' } };
  const company: any = { canManage: true, employees: [employee], settings: { coreBeliefs: companyCore } };
  const h = await createHarness({ company }); handles.push(h); const writes: any[] = [], reads: string[] = [];
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: any) => {
    if (!options?.method) reads.push(path);
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/publication/tokens') return { ok: true, data: { tokens: [] } };
    if (path === '/api/company/employees/river/startup-context') return context?.deny ? { ok: false, status: 403, error: 'Owner sign-in required' } : { ok: true, data: structuredClone(context) };
    if (options?.method === 'PUT') {
      writes.push({ path, body: structuredClone(options.body) });
      if (path === '/api/company/settings') { Object.assign(company.settings, options.body); return { ok: true, data: { settings: structuredClone(company.settings) } }; }
      Object.assign(employee, options.body); return { ok: true, data: { employee: structuredClone(employee) } };
    }
    return original(path, options);
  };
  await h.shell.openCompany('people');
  const profile = async () => { (h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement).click(); await h.flush(); return h.document.querySelector('.ca-expert-profile')!; };
  return { h, employee, company, writes, reads, profile };
}

it('starts with empty company beliefs and writes only explicitly edited exact blocks', async () => {
  const { h, writes } = await setup(); await h.shell.openCompanySettings(); await h.flush();
  const form = h.document.querySelector('.ca-company-core-form')!;
  let fields = form.querySelectorAll('textarea'); expect(fields).toHaveLength(1); expect(fields[0].value).toBe('');
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush(); expect(writes).toEqual([]);
  fields[0].value = 'First line\n\nPreserved paragraph'; fields[0].dispatchEvent(new h.window.Event('input'));
  (form.querySelector('[aria-label="Add Company core beliefs block"]') as HTMLButtonElement).click();
  fields = form.querySelectorAll('textarea'); fields[1].value = '  Exact spaces retained  ';
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes).toEqual([{ path: '/api/company/settings', body: { coreBeliefs: ['First line\n\nPreserved paragraph', '  Exact spaces retained  '] } }]);
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush(); expect(writes).toHaveLength(1);
});

it('preserves untouched personal blocks and displays server-provided company-first effective text', async () => {
  const { h, profile, writes } = await setup({ companyCore: ['Company baseline'], personal: ['Personal\r\nparagraph'] });
  const dialog = await profile();
  expect(dialog.querySelectorAll('.ca-core-preview')[0].textContent).toBe('Company baseline');
  expect(dialog.querySelectorAll('.ca-core-preview')[1].textContent).toBe('Company baseline\n\nPersonal\r\nparagraph');
  expect(dialog.querySelector('[aria-label="View startup context for River"]')).not.toBeNull();
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes[0].body).not.toHaveProperty('coreBeliefs');
});

it('does not normalize an untouched CRLF block when another company block changes', async () => {
  const { h, writes } = await setup({ companyCore: ['Keep\r\nexact lines', 'Edit this block'] });
  await h.shell.openCompanySettings(); await h.flush();
  const form = h.document.querySelector('.ca-company-core-form')!;
  const fields = form.querySelectorAll('textarea'); fields[1].value = 'Changed block';
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes[0].body.coreBeliefs).toEqual(['Keep\r\nexact lines', 'Changed block']);
});

it('saves personal additions as exact separate blocks and can clear them without changing company core', async () => {
  const { h, profile, writes, company } = await setup({ companyCore: ['Company baseline'], personal: ['Old personal block'] });
  let dialog = await profile(); const core = dialog.querySelector('[aria-label="Additional personal core beliefs block 1"]') as HTMLTextAreaElement;
  core.value = 'New personal\n\nparagraph'; core.dispatchEvent(new h.window.Event('input'));
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes[0].body.coreBeliefs).toEqual(['New personal\n\nparagraph']); expect(company.settings.coreBeliefs).toEqual(['Company baseline']);
  dialog = await profile(); (dialog.querySelector('[aria-label="Remove Additional personal core beliefs block"]') as HTMLButtonElement).click();
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes[1].body.coreBeliefs).toEqual([]); expect(company.settings.coreBeliefs).toEqual(['Company baseline']);
});

it('shows missing core and uncaptured startup separately from current text and copies only the requested preview', async () => {
  const context = { employeeId: 'river', sessionId: 'runtime', sessionGeneration: 2, generatedAt: 1000, context: '<script>window.contextExecuted=true</script>\nConfigured role', sections: [{ id: 'core', label: 'Core beliefs', status: 'missing', text: '' }, { id: 'role', label: 'Role', status: 'configured', text: '<img src=x onerror=window.contextExecuted=true>' }], startup: { status: 'unavailable', reason: 'This older startup was not captured.' } };
  const { h, profile, writes } = await setup({ context }); const dialog = await profile();
  (dialog.querySelector('[aria-label="View startup context for River"]') as HTMLButtonElement).click(); await h.flush();
  const inspector = h.document.querySelector('.ca-startup-context')!;
  expect(inspector.textContent).toContain('Startup capture unavailable'); expect(inspector.textContent).toContain('Core beliefs · missing');
  expect(inspector.querySelector('img, script')).toBeNull(); expect(h.window.contextExecuted).toBeUndefined();
  const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  (inspector.querySelector('[aria-label="Copy current configured context"]') as HTMLButtonElement).click(); await h.flush();
  expect(copy).toHaveBeenCalledExactlyOnceWith(context.context); expect(writes).toEqual([]);
});

it('labels an older harness report by its own binding and process-lifetime assurance', async () => {
  const report = { employeeId: 'river', sessionId: 'older-runtime', sessionGeneration: 1, generatedAt: 500, reportedAt: 600, stage: 'model-request', digest: 'sha256:' + 'a'.repeat(64), context: 'Previously reported input', sections: [], assurance: 'harness-reported-input', retention: 'website-process-lifetime' };
  const context = { employeeId: 'river', sessionId: 'runtime', sessionGeneration: 2, generatedAt: 1000, context: 'Current configured text', sections: [], startup: { status: 'unavailable', reason: 'Current startup not captured' }, lastManagedDelivery: report };
  const { h, profile } = await setup({ context }); const dialog = await profile();
  (dialog.querySelector('[aria-label="View startup context for River"]') as HTMLButtonElement).click(); await h.flush();
  const inspector = h.document.querySelector('.ca-startup-context')!;
  expect(inspector.textContent).toContain('another session binding'); expect(inspector.textContent).toContain('does not independently establish provider consumption');
  expect(inspector.textContent).toContain('website restart clears');
  expect((inspector.querySelector('[aria-label="Last harness-reported input"]') as HTMLTextAreaElement).value).toBe('Previously reported input');
  expect(inspector.querySelector('[aria-label="Captured startup input"]')).toBeNull();
});

it('never invents context on a denied owner read', async () => {
  const { h, profile, writes } = await setup({ context: { deny: true } }); const dialog = await profile();
  (dialog.querySelector('[aria-label="View startup context for River"]') as HTMLButtonElement).click(); await h.flush();
  const inspector = h.document.querySelector('.ca-startup-context')!;
  expect(inspector.textContent).toContain('Owner sign-in required'); expect(inspector.querySelector('textarea')).toBeNull();
  expect((inspector.querySelector('[aria-label="Copy current configured context"]') as HTMLButtonElement).disabled).toBe(true); expect(writes).toEqual([]);
});

it('keeps a matching captured startup report separate from a later configured preview', async () => {
  const report = { employeeId: 'river', sessionId: 'runtime', sessionGeneration: 2, generatedAt: 500, reportedAt: 600, stage: 'startup', digest: 'sha256:' + 'a'.repeat(64), context: 'Original startup input', sections: [], assurance: 'harness-reported-input', retention: 'website-process-lifetime' };
  const context = { employeeId: 'river', sessionId: 'runtime', sessionGeneration: 2, generatedAt: 1000, context: 'Later configured preview', sections: [], startup: { status: 'captured', reason: 'Matching startup input reported', report } };
  const { h, profile } = await setup({ context }); const dialog = await profile();
  (dialog.querySelector('[aria-label="View startup context for River"]') as HTMLButtonElement).click(); await h.flush();
  const inspector = h.document.querySelector('.ca-startup-context')!;
  expect((inspector.querySelector('[aria-label="Captured startup input"]') as HTMLTextAreaElement).value).toBe('Original startup input');
  expect((inspector.querySelector('[aria-label="Current configured context preview"]') as HTMLTextAreaElement).value).toBe('Later configured preview');
  expect(inspector.textContent).toContain('does not independently establish provider consumption');
});


it('does not call a prior runtime report current when the session ID and generation are reused', async () => {
  const report = { employeeId: 'river', sessionId: 'runtime', sessionGeneration: 2, runtimeBinding: 'sha256:' + 'a'.repeat(64), generatedAt: 500, reportedAt: 600, stage: 'startup', digest: 'sha256:' + 'c'.repeat(64), context: 'Prior runtime input', sections: [], assurance: 'harness-reported-input', retention: 'website-process-lifetime' };
  const context = { employeeId: 'river', sessionId: 'runtime', sessionGeneration: 2, runtimeBinding: 'sha256:' + 'b'.repeat(64), generatedAt: 1000, context: 'Current runtime preview', sections: [], startup: { status: 'unavailable', reason: 'Current runtime startup unavailable' }, lastManagedDelivery: report };
  const { h, profile } = await setup({ context }); const dialog = await profile();
  (dialog.querySelector('[aria-label="View startup context for River"]') as HTMLButtonElement).click(); await h.flush();
  const inspector = h.document.querySelector('.ca-startup-context')!;
  expect(inspector.textContent).toContain('another session binding or runtime incarnation');
  expect(inspector.textContent).not.toContain('This report names the current session binding.');
  expect(inspector.querySelector('[aria-label="Captured startup input"]')).toBeNull();
});
