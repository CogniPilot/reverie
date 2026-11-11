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
  it('leads with observed fleet summary and profile links while keeping disruptive workflows explicit', async () => {
    const { section, calls } = await setup();
    const fleet = section();
    expect(fleet.querySelector('.ca-fleet-summary')!.textContent).toContain('Pool hard ceilingNot verified');
    expect(fleet.querySelector('.ca-fleet-summary')!.textContent).toContain('Laptops reported running1 of 2');
    expect(fleet.querySelector('[data-fleet-profile]')!.textContent).toBe('River');
    expect((fleet.querySelector('.ca-fleet-maintenance') as HTMLDetailsElement).open).toBe(false);
    expect((fleet.querySelector('.ca-fleet-rollout') as HTMLDetailsElement).open).toBe(false);
    expect(
      fleet.querySelector('.ca-fleet-table')!.compareDocumentPosition(fleet.querySelector('.ca-fleet-rollout')!) & 4
    ).toBe(4);
    expect(calls.every((call) => call.body === undefined)).toBe(true);
  });
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
    expect(section().querySelector('tbody tr')?.getAttribute('title')).toContain('Running image: old-image');
    expect(section().querySelector('[aria-label="River soft RAM (MiB)"]')).toBeNull();
    expect(section().querySelector('tbody')?.textContent).toContain('Soft RAM 4,096 MiB; hard RAM 8,192 MiB');
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
  it('renders a known unbounded parent and preserves exact null in the preview without a numeric fallback', async () => {
    const data = initial();
    const pool = { ...data.pool.desired!, memoryHighMiB: null, memoryMaxMiB: 49152 };
    data.pool = { desired: pool, observed: { ...pool } };
    const { section, submit, calls } = await setup({ data, replies: { '/preview': (body) => preview(body) } });
    const parent = Array.from(section().querySelectorAll('fieldset')).find(
      (row) => row.querySelector('legend')?.textContent === 'Shared employee pool'
    )!;
    expect(parent.textContent).toContain('Running: Soft RAM unbounded; hard RAM 49,152 MiB');
    expect(parent.textContent).toContain('Pool soft RAM is unbounded; the hard pool ceiling still applies.');
    expect(parent.querySelector('[aria-label="Pool soft RAM (MiB)"]')).toBeNull();
    expect(section().querySelector('tbody')?.textContent).toContain('Soft RAM 4,096 MiB');
    await submit();
    expect(calls.at(-1)?.body.pool).toEqual(pool);
    expect(calls.at(-1)?.body.pool.memoryHighMiB).toBeNull();
    expect(section().textContent).toContain('Preview only. No laptop has been changed.');
  });
  it('keeps an unknown whole pool distinct from known unbounded high and rejects an omitted threshold', async () => {
    const data = initial();
    data.pool.desired!.memoryHighMiB = null;
    const unknown = await setup({ data });
    const parent = Array.from(unknown.section().querySelectorAll('fieldset')).find(
      (row) => row.querySelector('legend')?.textContent === 'Shared employee pool'
    )!;
    expect(parent.textContent).toContain('Running: Not verified');
    expect(parent.textContent).not.toContain('Running: Soft RAM unbounded');
    const malformed: any = initial();
    delete malformed.pool.desired.memoryHighMiB;
    const refused = await setup({ data: malformed });
    expect(refused.section().textContent).toContain('Laptop fleet status could not be verified');
    expect(refused.section().querySelector('form')).toBeNull();
    expect(refused.calls.filter((row) => row.path.endsWith('/preview'))).toHaveLength(0);
  });
  it('invalidates approval when a field changes, and obeys server canApply=false', async () => {
    let allowed = true;
    const { h, section, button, calls, submit } = await setup({
      replies: { '/preview': (body) => preview(body, { canApply: allowed }) },
    });
    await submit();
    const input = section().querySelector<HTMLInputElement>('[aria-label="Pool CPU weight"]')!;
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

describe('Failed native shared pool setup recovery', () => {
  const operationId = '33333333-4444-4555-8666-777777777777';
  const key = 'reverie:native-pool-migration:owner';
  it('preserves UNKNOWN history and requires a new review without replaying activation or starts', async () => {
    const { h, button, calls } = await setup({
      saved: { [key]: JSON.stringify({ operationId }) },
      replies: {
        '/native-reconcile': () => ({
          ok: true,
          data: {
            operationId,
            priorOutcome: 'unconfirmed',
            currentState: 'pool-uninstalled',
            historyRecorded: true,
            evidenceDigest: 'e'.repeat(64),
            observationNonce: '44444444-5555-4666-8777-888888888888',
            startsAuthorized: false,
            activationAuthorized: false,
          },
        }),
      },
    });
    button('Recover setup after a failed activation').click();
    await h.flush();
    expect(h.window.localStorage.getItem(key)).toBeNull();
    expect(JSON.parse(h.window.localStorage.getItem(key + ':unconfirmed-history'))).toMatchObject([
      { operationId, priorOutcome: 'unconfirmed', evidenceDigest: 'e'.repeat(64) },
    ]);
    expect(button('Review host-selected migration')).not.toBeNull();
    expect(calls.filter((row) => row.path.endsWith('/native-reconcile'))).toHaveLength(1);
    expect(calls.some((row) => /native-(apply|preview)$/.test(row.path))).toBe(false);
  });
  it('keeps the pending reference when the recovery reply is lost', async () => {
    const original = JSON.stringify({ operationId });
    const { h, button, calls } = await setup({
      saved: { [key]: original },
      replies: {
        '/native-reconcile': () => {
          throw new Error('lost reply');
        },
      },
    });
    button('Recover setup after a failed activation').click();
    await h.flush();
    expect(h.window.localStorage.getItem(key)).toBe(original);
    expect(h.window.localStorage.getItem(key + ':unconfirmed-history')).toBeNull();
    expect(button('Recover setup after a failed activation')).not.toBeNull();
    expect(calls.some((row) => /native-(apply|preview)$/.test(row.path))).toBe(false);
    expect(h.document.querySelector('.ca-fleet-native [role="alert"]')?.textContent).toContain('lost reply');
  });
  it('shows an unconfirmed result beside its action and preserves the original reference', async () => {
    const original = JSON.stringify({ operationId });
    const { h, button, section, calls } = await setup({
      saved: { [key]: original },
      replies: {
        '/native-result': () => ({
          ok: true,
          data: {
            operationId,
            state: 'unknown',
            blocksFurtherChanges: true,
            native: null,
            restore: [],
          },
        }),
      },
    });
    button('Check original shared-pool migration').click();
    await h.flush();
    const message = section().querySelector('.ca-fleet-native [role="alert"]');
    expect(message?.textContent).toContain('unconfirmed');
    expect(h.document.activeElement).toBe(message);
    expect(h.window.localStorage.getItem(key)).toBe(original);
    expect(section().querySelector('.ca-fleet-results')?.nextElementSibling?.className).toBe('ca-fleet-content');
    expect(calls.some((row) => /native-(apply|preview)$/.test(row.path))).toBe(false);
  });
  it('shows never-issued history and permits a new review without claiming activation or dispatching it', async () => {
    const { h, button, section, calls } = await setup({
      saved: { [key]: JSON.stringify({ operationId }) },
      replies: {
        '/native-result': () => ({
          ok: true,
          data: {
            operationId,
            state: 'not-issued',
            phase: 'not-issued',
            blocksFurtherChanges: false,
            native: null,
            nativeFailure: null,
            restore: [],
            failure: {
              code: 'PREVIEW_ENDED_BEFORE_ISSUE',
              message: 'Preview ended before migration consent was dispatched.',
            },
          },
        }),
      },
    });
    button('Check original shared-pool migration').click();
    await h.flush();
    expect(section().querySelector('.ca-fleet-native [role="status"]')?.textContent).toContain(
      'before activation consent was dispatched'
    );
    expect(h.window.localStorage.getItem(key)).toBeNull();
    expect(button('Review host-selected migration')).not.toBeNull();
    expect(section().querySelector('.ca-fleet-native [role="alert"]')).toBeNull();
    expect(calls.some((row) => /native-(apply|preview)$/.test(row.path))).toBe(false);
  });
  it('announces a pending check immediately and displays its lost reply locally', async () => {
    let reject!: (reason: Error) => void;
    const { h, button, section } = await setup({
      saved: { [key]: JSON.stringify({ operationId }) },
      replies: {
        '/native-result': () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      },
    });
    button('Check original shared-pool migration').click();
    await h.flush();
    expect(section().querySelector('.ca-fleet-native [role="status"]')?.textContent).toContain('Checking');
    expect(button('Check original shared-pool migration').disabled).toBe(true);
    reject(new Error('connection closed'));
    await h.flush();
    expect(section().querySelector('.ca-fleet-native [role="alert"]')?.textContent).toBe('connection closed');
    expect(button('Check original shared-pool migration').disabled).toBe(false);
  });
  it('clears a stale error when a later check verifies the original activation', async () => {
    let unavailable = true;
    const { h, button, section } = await setup({
      saved: { [key]: JSON.stringify({ operationId }) },
      replies: {
        '/native-result': () => {
          if (unavailable) throw new Error('lost observation');
          return {
            ok: true,
            data: {
              operationId,
              state: 'pool-configured',
              blocksFurtherChanges: false,
              native: { kind: 'fleet-migration-result', phase: 'pool-configured', approval: { operationId } },
              restore: [],
            },
          };
        },
      },
    });
    button('Check original shared-pool migration').click();
    await h.flush();
    expect(section().querySelector('.ca-fleet-native [role="alert"]')?.textContent).toContain('lost observation');
    unavailable = false;
    button('Check original shared-pool migration').click();
    await h.flush();
    expect(section().querySelector('.ca-company-error')?.textContent).toBe('');
    expect(section().querySelector('.ca-fleet-native [role="alert"]')).toBeNull();
    expect(h.window.localStorage.getItem(key)).toBeNull();
  });
  it('shows known activation separately from pending and unknown employee recovery with a retained diagnostic', async () => {
    const original = JSON.stringify({ operationId });
    const { h, button, section, calls } = await setup({
      saved: { [key]: original },
      replies: {
        '/native-result': () => ({
          ok: true,
          data: {
            operationId,
            state: 'unknown',
            phase: 'unknown',
            blocksFurtherChanges: true,
            native: { kind: 'fleet-migration-result', phase: 'pool-configured', approval: { operationId } },
            restore: [
              { employeeId, sessionId: 'current-session', state: 'pending' },
              { employeeId: otherId, sessionId: 'other-session', state: 'unknown' },
            ],
            failure: {
              code: 'RESTORE_OUTCOME_UNCONFIRMED',
              message: 'An original employee recovery outcome is unconfirmed. It will not be replayed.',
            },
            nativeFailure: null,
          },
        }),
      },
    });
    button('Check original shared-pool migration').click();
    await h.flush();
    expect(section().querySelector('.ca-fleet-native [role="alert"]')?.textContent).toContain(
      'activation was confirmed; employee startup is unconfirmed'
    );
    const result = section().querySelector('.ca-fleet-results')?.textContent;
    expect(result).toContain('River: startup intent recorded; outcome pending');
    expect(result).toContain('Recovery: startup unconfirmed; not retried');
    expect(result).toContain('RESTORE_OUTCOME_UNCONFIRMED');
    expect(result).toContain('does not verify the current running pool');
    expect(h.window.localStorage.getItem(key)).toBe(original);
    expect(calls.some((row) => /native-(apply|preview)$/.test(row.path))).toBe(false);
  });
  it('finds the original operation after local storage is lost using metadata only', async () => {
    const { h, button, section, calls } = await setup({
      replies: {
        '/native-operations': () => ({
          ok: true,
          data: {
            available: true,
            blocksFurtherChanges: true,
            operations: [{ operationId, state: 'unknown', blocksFurtherChanges: true }],
          },
        }),
        '/native-result': () => ({
          ok: true,
          data: {
            operationId,
            state: 'unknown',
            blocksFurtherChanges: true,
            native: null,
            restore: [],
            failure: null,
            nativeFailure: {
              kind: 'fleet-migration-failure',
              approval: { operationId },
              outcome: 'unconfirmed',
              code: 'RESERVATION_ADMISSION_LOCK_BUSY',
            },
          },
        }),
      },
    });
    button('Check saved shared-pool migrations').click();
    await h.flush();
    button(`Check saved migration ${operationId}`).click();
    await h.flush();
    expect(section().querySelector('.ca-fleet-results')?.textContent).toContain('RESERVATION_ADMISSION_LOCK_BUSY');
    expect(calls.filter((row) => row.path.endsWith('/native-operations')).map((row) => row.body)).toEqual([{}]);
    expect(calls.filter((row) => row.path.endsWith('/native-result')).map((row) => row.body)).toEqual([
      { operationId },
    ]);
    expect(calls.some((row) => /native-(apply|preview|reconcile)$/.test(row.path))).toBe(false);
  });
  it('does not treat an unavailable durable history as an empty completed history', async () => {
    const { h, button, section, calls } = await setup({
      replies: {
        '/native-operations': () => ({
          ok: true,
          data: { available: false, blocksFurtherChanges: true, operations: [] },
        }),
      },
    });
    button('Check saved shared-pool migrations').click();
    await h.flush();
    expect(section().querySelector('.ca-fleet-native [role="alert"]')?.textContent).toContain(
      'unavailable or incomplete'
    );
    expect(section().textContent).not.toContain('No migrations were recorded');
    expect(calls.some((row) => /native-(apply|preview|reconcile)$/.test(row.path))).toBe(false);
  });
  it('preserves the current pending reference when checking an older completed migration', async () => {
    const oldId = '44444444-5555-4666-8777-888888888888';
    const original = JSON.stringify({ operationId });
    const { h, button, calls } = await setup({
      saved: { [key]: original },
      replies: {
        '/native-operations': () => ({
          ok: true,
          data: {
            available: true,
            blocksFurtherChanges: true,
            operations: [{ operationId: oldId, state: 'pool-configured', blocksFurtherChanges: false }],
          },
        }),
        '/native-result': () => ({
          ok: true,
          data: {
            operationId: oldId,
            state: 'pool-configured',
            blocksFurtherChanges: false,
            native: { kind: 'fleet-migration-result', phase: 'pool-configured', approval: { operationId: oldId } },
            restore: [],
          },
        }),
      },
    });
    button('Check saved shared-pool migrations').click();
    await h.flush();
    button(`Check saved migration ${oldId}`).click();
    await h.flush();
    expect(h.window.localStorage.getItem(key)).toBe(original);
    expect(calls.some((row) => /native-(apply|preview|reconcile)$/.test(row.path))).toBe(false);
  });
});
