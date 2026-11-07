import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
import type { FleetStatus, FleetOperation, FleetPreview, FleetPreviewRequest } from '../src/types/resource-fleet.js';

const employeeId = '11111111-2222-4333-8444-555555555555';
const otherId = '22222222-3333-4444-8555-666666666666';
const imageId = `sha256:${'a'.repeat(64)}`;
const desired = { memoryHighMiB: 4096, memoryMaxMiB: 8192, cpuWeight: 100, perfEnabled: true };
const initial = (): FleetStatus => ({
  version: 1,
  revision: 'revision-1',
  canPreview: true,
  blockers: [],
  images: [{ id: imageId, label: 'Nix worker with perf' }],
  pool: {
    desired: { memoryHighMiB: 16384, memoryMaxMiB: 32768, cpuWeight: 100, allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7] },
    observed: null,
  },
  employees: [
    {
      employeeId,
      name: 'River',
      state: 'running',
      reason: null,
      desired: { ...desired },
      observed: { memoryHighMiB: null, memoryMaxMiB: 4096, cpuWeight: 100, perfEnabled: null },
      desiredImageId: imageId,
      observedImageId: 'old-image',
    },
    {
      employeeId: otherId,
      name: 'Recovery',
      state: 'excluded',
      reason: 'Reserved recovery employee',
      desired: null,
      observed: null,
      desiredImageId: null,
      observedImageId: null,
    },
  ],
  operations: [],
  unmanagedLaptops: [],
});
const operation = (blocksFurtherChanges = true): FleetOperation => ({
  id: 'operation-one',
  state: blocksFurtherChanges ? 'recovery-required' : 'settled',
  blocksFurtherChanges,
  message: blocksFurtherChanges
    ? 'Inspect this rollout before another change.'
    : 'The operation is settled; River remains unverified.',
  employees: [{ employeeId, state: 'unknown', verified: false, reason: 'Kernel readback is unavailable' }],
});
const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
  vi.restoreAllMocks();
});

async function setup(
  options: {
    verified?: boolean;
    data?: any;
    replies?: Record<string, (body: any) => any>;
    saved?: Record<string, string>;
  } = {}
) {
  const h = await createHarness({
    company: { canManage: true, settings: { ownerName: 'Owner' }, employees: [], cycles: [] },
  });
  opened.push(h);
  const calls: Array<{ path: string; body: any }> = [];
  const owner = { id: 'owner', signedIn: true };
  const data = options.data ?? initial();
  for (const [key, value] of Object.entries(options.saved ?? {})) h.window.localStorage.setItem(key, value);
  const previous = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, request?: any) => {
    if (path === '/api/owner/status')
      return {
        ok: true,
        data: { configured: true, signedIn: owner.signedIn, identity: { id: owner.id, role: 'owner' } },
      };
    if (path === '/api/chatrooms/phone-status')
      return {
        ok: true,
        data: { self: options.verified === false ? 'agent' : 'owner', canSetOwn: options.verified !== false },
      };
    if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
    if (path.startsWith('/api/company/resources/fleet')) {
      calls.push({ path, body: request?.body });
      const action = path.slice('/api/company/resources/fleet'.length) || '/status';
      const reply = options.replies?.[action];
      return reply
        ? reply(request?.body)
        : action === '/status'
          ? { ok: true, data }
          : { ok: false, status: 503, error: 'Host unavailable' };
    }
    return previous(path, request);
  };
  vi.spyOn(h.shell, 'confirmCompanyAction').mockResolvedValue(true);
  await h.shell.openCompanySettings();
  await h.flush();
  const section = () => h.document.querySelector('.ca-fleet-resources') as HTMLElement;
  const button = (label: string) => section().querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
  const submit = async () => {
    (section().querySelector('[aria-label="Canary employee"]') as HTMLSelectElement).value = employeeId;
    section()
      .querySelector('form')!
      .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
  };
  const reopen = async () => {
    (h.document.querySelector('.ca-company-settings') as HTMLDialogElement).close();
    await h.shell.openCompanySettings();
    await h.flush();
  };
  return { h, data, owner, calls, section, button, submit, reopen };
}
function preview(body: FleetPreviewRequest, changes: Partial<FleetPreview> = {}) {
  return {
    ok: true,
    data: {
      previewId: 'preview-one',
      operationId: 'operation-one',
      revision: body.expectedRevision,
      expiresAt: Date.now() + 60000,
      canApply: true,
      blockers: [],
      steps: [{ employeeId, name: 'River', action: 'Replace canary; verify image, perf and kernel limits' }],
      request: {
        ...body,
        policies: body.policies.map((row: any) => ({
          memoryHighMiB: row.memoryHighMiB,
          memoryMaxMiB: row.memoryMaxMiB,
          cpuWeight: row.cpuWeight,
          perfEnabled: row.perfEnabled,
          employeeId: row.employeeId,
        })),
      },
      ...changes,
    },
  };
}

describe('Company Settings laptop fleet', () => {
  it('is mounted only for the verified owner', async () => {
    const { section, calls } = await setup({ verified: false });
    expect(section()).toBeNull();
    expect(calls).toEqual([]);
  });
  it('shows real host setup blockers and unknown history/coverage without a preview or Apply', async () => {
    const data = initial();
    Object.assign(data, {
      revision: null,
      canPreview: false,
      images: [],
      operations: null,
      unmanagedLaptops: null,
      blockers: [
        {
          code: 'FLEET_HOST_SETUP_REQUIRED',
          message: 'Authenticated host service is not installed.',
          remedy: 'Complete supported host setup.',
        },
      ],
    });
    data.pool.desired = null as never;
    data.employees[0].desired = null as never;
    const { section, calls } = await setup({ data });
    expect(section().textContent).toContain('Complete supported host setup');
    expect(section().textContent).toContain('history is unavailable');
    expect(section().textContent).toContain('coverage has not been verified');
    expect(section().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(calls.map((row) => row.path)).toEqual(['/api/company/resources/fleet']);
    expect(section().querySelector('[aria-label="Apply previewed fleet rollout"]')).toBeNull();
  });
  it('separates editable requested values, observed unbounded RAM, untested perf and excluded employees', async () => {
    const { section } = await setup();
    expect(section().textContent).toContain('Soft RAM unbounded; hard RAM 4,096 MiB');
    expect(section().textContent).toContain('perf not tested');
    expect(section().textContent).toContain('Reserved recovery employee');
    expect(section().textContent).toContain('Running image: old-image');
    expect(section().querySelector<HTMLInputElement>('[aria-label="River soft RAM (MiB)"]')!.value).toBe('4096');
    expect(section().querySelector('[aria-label="Recovery soft RAM (MiB)"]')).toBeNull();
  });
  it('previews exact policies and sends only the selected preview/revision once, even after two confirmation clicks', async () => {
    const { h, calls, section, button, submit } = await setup({
      replies: { '/preview': (body) => preview(body), '/apply': () => ({ ok: true, data: operation() }) },
    });
    await submit();
    expect(calls.at(-1)?.body).toEqual({
      expectedRevision: 'revision-1',
      targetImageId: imageId,
      policies: [{ employeeId, ...desired }],
      pool: initial().pool.desired,
      canaryEmployeeId: employeeId,
      handoff: 'Resume your current task from your journal and board after the laptop restart.',
    });
    const apply = button('Apply previewed fleet rollout');
    apply.click();
    apply.click();
    await h.flush();
    expect(calls.filter((row) => row.path.endsWith('/apply')).map((row) => row.body)).toEqual([
      { previewId: 'preview-one', expectedRevision: 'revision-1' },
    ]);
    expect(apply.disabled).toBe(true);
    expect(section().textContent).toContain('River: unknown; not verified');
    expect(section().textContent).not.toContain('Fleet complete');
  });
  it('invalidates approval when a field changes, and obeys server canApply=false', async () => {
    let allowed = true;
    const { h, section, button, calls, submit } = await setup({
      replies: { '/preview': (body) => preview(body, { canApply: allowed }) },
    });
    await submit();
    const input = section().querySelector<HTMLInputElement>('[aria-label="River CPU weight"]')!;
    input.value = '200';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(section().querySelector('[aria-label="Apply previewed fleet rollout"]')).toBeNull();
    allowed = false;
    await submit();
    expect(button('Apply previewed fleet rollout').disabled).toBe(true);
    button('Apply previewed fleet rollout').click();
    await h.flush();
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(0);
  });
  it('preserves an unconfirmed Apply before dispatch and across reopen while server history is absent', async () => {
    const { h, button, calls, submit, reopen } = await setup({
      replies: {
        '/preview': (body) => preview(body),
        '/apply': () => {
          expect(h.window.localStorage.getItem('reverie:laptop-fleet:owner')).toBe('["operation-one"]');
          throw new Error('lost reply');
        },
      },
    });
    await submit();
    button('Apply previewed fleet rollout').click();
    await h.flush();
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(1);
    await reopen();
    expect(h.document.querySelector<HTMLButtonElement>('.ca-fleet-form button[type="submit"]')!.disabled).toBe(true);
    button('Check laptop rollout status').click();
    await h.flush();
    expect(calls.at(-1)?.body).toEqual({ operationId: 'operation-one' });
    expect(h.window.localStorage.getItem('reverie:laptop-fleet:owner')).toBe('["operation-one"]');
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(1);
  });
  it('uses authoritative settlement without promoting unverified employee readback to completion', async () => {
    const data = initial();
    data.operations = [operation()] as never;
    const { h, section, button } = await setup({
      data,
      replies: { '/result': () => ({ ok: true, data: operation(false) }) },
    });
    button('Check laptop rollout status').click();
    await h.flush();
    expect(section().textContent).toContain('River remains unverified');
    expect(section().textContent).toContain('unknown; not verified');
    expect(section().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(h.window.localStorage.getItem('reverie:laptop-fleet:owner')).toBe('[]');
  });
  it('refuses an owner change before Apply and keeps unknown IDs in the original owner namespace', async () => {
    const { h, owner, button, calls, submit, reopen } = await setup({
      replies: { '/preview': (body) => preview(body) },
    });
    await submit();
    owner.id = 'another-owner';
    button('Apply previewed fleet rollout').click();
    await h.flush();
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(0);
    h.window.localStorage.setItem('reverie:laptop-fleet:owner', '["old-unknown"]');
    await reopen();
    expect(h.window.localStorage.getItem('reverie:laptop-fleet:owner')).toBe('["old-unknown"]');
    expect(h.window.localStorage.getItem('reverie:laptop-fleet:another-owner')).toBeNull();
  });
  it('expires a preview without dispatch', async () => {
    const { h, button, section, calls, submit } = await setup({
      replies: { '/preview': (body) => preview(body, { expiresAt: Date.now() - 1 }) },
    });
    await submit();
    button('Apply previewed fleet rollout').click();
    await h.flush();
    expect(section().textContent).toContain('preview expired');
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(0);
  });
  it.each(['operations', 'revision', 'pool'])(
    'does not enable Preview with missing %s even if canPreview is inconsistent',
    async (field) => {
      const data = initial();
      if (field === 'operations') data.operations = null;
      if (field === 'revision') data.revision = null;
      if (field === 'pool') data.pool.desired = null;
      const { section, submit, calls } = await setup({ data });
      expect(section().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await submit();
      expect(calls.filter((row) => row.path.endsWith('/preview'))).toHaveLength(0);
    }
  );
  it('rechecks expiry after owner confirmation before persisting or sending Apply', async () => {
    const { h, button, section, calls, submit } = await setup({ replies: { '/preview': (body) => preview(body) } });
    await submit();
    h.shell.confirmCompanyAction.mockImplementation(async () => {
      vi.spyOn(h.window.Date, 'now').mockReturnValue(Date.now() + 120000);
      return true;
    });
    button('Apply previewed fleet rollout').click();
    await h.flush();
    expect(section().textContent).toContain('preview expired');
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(0);
    expect(h.window.localStorage.getItem('reverie:laptop-fleet:owner')).toBeNull();
  });
  it('refuses a stale preview response and a new pending operation from another open panel', async () => {
    let stale = true;
    const { h, section, button, calls, submit } = await setup({
      replies: {
        '/preview': (body) =>
          stale ? { ok: false, status: 409, error: 'Fleet revision changed. Refresh status.' } : preview(body),
      },
    });
    await submit();
    expect(section().textContent).toContain('Fleet revision changed');
    expect(section().querySelector('[aria-label="Apply previewed fleet rollout"]')).toBeNull();
    stale = false;
    await submit();
    h.window.localStorage.setItem('reverie:laptop-fleet:owner', '["another-unknown"]');
    button('Apply previewed fleet rollout').click();
    await h.flush();
    expect(calls.filter((row) => row.path.endsWith('/apply'))).toHaveLength(0);
    expect(h.window.localStorage.getItem('reverie:laptop-fleet:owner')).toBe('["another-unknown"]');
    expect(button('Check laptop rollout status').hidden).toBe(false);
  });
  it('renders server names, blockers and unmanaged coverage as text without dropping orphaned rows', async () => {
    const data = initial();
    data.employees[0].name = '<img src=x onerror=alert(1)>';
    data.unmanagedLaptops = [{ id: 'orphan-one', reason: '<script>not executable</script>' }];
    data.blockers = [{ code: 'BLOCKED', message: '<img src=x>', remedy: 'Use supported host setup.' }];
    data.canPreview = false;
    const { section } = await setup({ data });
    expect(section().textContent).toContain('<img src=x onerror=alert(1)>');
    expect(section().textContent).toContain('Unmanaged laptop orphan-one');
    expect(section().querySelector('img,script')).toBeNull();
  });
});
