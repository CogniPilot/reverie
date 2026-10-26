import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const ID = '00000001-0001-4001-8001-000000000001';
const NEXT = '00000002-0002-4002-8002-000000000002';
const MISSING = '00000003-0003-4003-8003-000000000003';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.close(); vi.restoreAllMocks(); });
async function setup({ owner = true, inventoryFailure = false, deferGrant = false, failSave = false } = {}) {
  const employee: any = { id: 'river', sessionId: 'runtime', name: 'River', icon: 'R', reportsTo: 'owner',
    permissions: { publicationTokenIds: [ID, MISSING] },
    effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false },
    boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' } };
  const company = { canManage: owner, settings: {}, employees: [employee] };
  const tokens: any[] = [{ id: ID, name: 'release-pat', label: 'Release work', repositories: ['example/project'], createdAt: 1, updatedAt: 1 }];
  const h = await createHarness({ company }); opened.push(h);
  const writes: any[] = [], reads: string[] = [];
  let finishGrant: (() => void) | undefined;
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: any) => {
    if (!options?.method || options.method === 'GET') reads.push(path);
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (path === '/api/publication/tokens' && !options?.method)
      return inventoryFailure ? { ok: false, status: 503 } : { ok: true, data: { tokens: structuredClone(tokens) } };
    if (path.startsWith('/api/company/employees/river/publication-tokens/')) {
      writes.push({ path, method: options.method, body: structuredClone(options.body) });
      const tokenId = path.split('/').at(-1)!;
      const result = () => {
        const current = employee.permissions.publicationTokenIds.filter((id: string) => id !== tokenId);
        if (options.body.enabled) current.push(tokenId);
        employee.permissions.publicationTokenIds = current;
        return { ok: true, data: { employee: structuredClone(employee) } };
      };
      if (deferGrant) return new Promise(resolve => { finishGrant = () => resolve(result()); });
      return result();
    }
    if (path.startsWith('/api/publication/tokens') && options?.method) {
      writes.push({ path, method: options.method, body: structuredClone(options.body) });
      if (failSave) return { ok: false, status: 503, error: 'untrusted echo ' + options.body?.token };
      const tokenId = path.split('/').at(-1);
      if (options.method === 'DELETE') { tokens.splice(tokens.findIndex(t => t.id === tokenId), 1); return { ok: true, data: { id: tokenId, deleted: true } }; }
      const existing = tokens.find(t => t.id === tokenId);
      const metadata = { ...(existing || {}), id: existing?.id || NEXT, name: options.body.name, repositories: options.body.repositories || [], createdAt: 1, updatedAt: 2 };
      if (existing) Object.assign(existing, metadata); else tokens.push(metadata);
      return { ok: true, data: { token: structuredClone(metadata) } };
    }
    return original(path, options);
  };
  await h.shell.openCompany('people');
  if (owner) { (h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement).click(); await h.flush(); }
  const grant = (name: string) => h.document.querySelector(`[aria-label="Access to ${name} for River"]`) as HTMLInputElement;
  const manage = async () => { (h.document.querySelector('[aria-label="Manage PATs"]') as HTMLButtonElement).click(); await h.flush(); return h.document.querySelector('.ca-publication-tokens')!; };
  return { h, employee, tokens, writes, reads, grant, manage, finishGrant: () => finishGrant!() };
}

it('shows only named metadata and performs no grant writes on render', async () => {
  const { h, writes, grant } = await setup();
  expect(grant('release-pat').checked).toBe(true);
  expect(grant('unavailable PAT ' + MISSING).checked).toBe(true);
  expect(h.document.querySelector('.ca-profile-publication').textContent).toContain('example/project');
  expect(h.document.querySelector('.ca-profile-publication').textContent).toContain('previously copied tokens must be revoked or rotated at GitHub');
  expect(writes).toEqual([]);
});

it('uses an atomic one-ID update, serializes the group and retains concurrent grants from the response', async () => {
  const { h, employee, writes, grant, finishGrant } = await setup({ deferGrant: true });
  grant('release-pat').click(); await h.flush();
  expect(writes).toEqual([{ path: '/api/company/employees/river/publication-tokens/' + ID, method: 'PUT', body: { enabled: false } }]);
  expect(grant('unavailable PAT ' + MISSING).disabled).toBe(true);
  employee.permissions.publicationTokenIds.push(NEXT); finishGrant(); await h.flush();
  expect(employee.permissions.publicationTokenIds).toEqual([MISSING, NEXT]);
  expect(grant('release-pat').checked).toBe(false);
  expect(grant('unavailable PAT ' + NEXT).checked).toBe(true);
});

it('allows removing unavailable grants without requiring token inventory', async () => {
  const { h, writes, grant } = await setup({ inventoryFailure: true });
  grant('unavailable PAT ' + MISSING).click(); await h.flush();
  expect(writes[0]).toMatchObject({ path: '/api/company/employees/river/publication-tokens/' + MISSING, body: { enabled: false } });
  expect(grant('unavailable PAT ' + MISSING)).toBeNull();
});

it('adds and replaces PATs through write-only fields, and never lists or prefills their values', async () => {
  const { h, writes, manage, reads } = await setup(); const dialog = await manage();
  const field = (label: string) => dialog.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  const secret = field('PAT value (write-only)'); expect(secret.type).toBe('password'); expect(secret.value).toBe('');
  field('PAT name').value = 'second-pat'; field('Declared repositories (optional)').value = 'example/first, example/second'; secret.value = 'FAKE_TEST_PAT_DO_NOT_USE';
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes[0]).toMatchObject({ path: '/api/publication/tokens', method: 'POST', body: { name: 'second-pat', token: 'FAKE_TEST_PAT_DO_NOT_USE', repositories: ['example/first', 'example/second'] } });
  expect(secret.value).toBe(''); expect(dialog.textContent).not.toContain('FAKE_TEST_PAT_DO_NOT_USE');
  (dialog.querySelector('[aria-label="Edit PAT second-pat"]') as HTMLButtonElement).click(); expect(secret.value).toBe('');
  secret.value = 'FAKE_REPLACEMENT_PAT'; dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes[1]).toMatchObject({ path: '/api/publication/tokens/' + NEXT, method: 'PUT', body: { token: 'FAKE_REPLACEMENT_PAT' } });
  expect(secret.value).toBe(''); expect(dialog.textContent).not.toContain('FAKE_REPLACEMENT_PAT');
  expect(reads.filter(p => p.startsWith('/api/publication/'))).toEqual(expect.arrayContaining(['/api/publication/tokens']));
  expect(reads.some(p => p.includes('/credential'))).toBe(false);
});

it('clears secret input on failed saves and close, without echoing untrusted errors', async () => {
  const { h, manage } = await setup({ failSave: true }); const dialog = await manage();
  const secret = dialog.querySelector('[aria-label="PAT value (write-only)"]') as HTMLInputElement;
  (dialog.querySelector('[aria-label="PAT name"]') as HTMLInputElement).value = 'failed-pat'; secret.value = 'FAKE_SECRET_SHOULD_NOT_ECHO';
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(secret.value).toBe(''); expect(dialog.textContent).not.toContain('FAKE_SECRET_SHOULD_NOT_ECHO');
  secret.value = 'FAKE_UNSAVED_SECRET'; (dialog.querySelector('[aria-label="Close Manage PATs"]') as HTMLButtonElement).click();
  expect(secret.value).toBe(''); expect(dialog.isConnected).toBe(false);
});

it('requires an explicit delete confirmation and does not expose vault management to nonowners', async () => {
  const { h, manage, writes } = await setup(); const dialog = await manage();
  const confirm = vi.spyOn(h.shell, 'confirmCompanyAction').mockResolvedValue(false);
  (dialog.querySelector('[aria-label="Delete PAT release-pat"]') as HTMLButtonElement).click(); await h.flush(); expect(writes).toEqual([]);
  confirm.mockResolvedValue(true); (dialog.querySelector('[aria-label="Delete PAT release-pat"]') as HTMLButtonElement).click(); await h.flush();
  expect(writes).toEqual([{ path: '/api/publication/tokens/' + ID, method: 'DELETE', body: undefined }]);
  const denied = await setup({ owner: false }); expect(denied.h.document.querySelector('[aria-label="Manage PATs"]')).toBeNull();
});
