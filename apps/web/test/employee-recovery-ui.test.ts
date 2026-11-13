/** Actual profile DOM with closed recovery wire fixtures. Native effects are not exercised here. */
import { afterEach, expect, it, vi } from 'vitest';
import { EmployeePermissionsSchema } from '../src/company-types.js';
import { createHarness } from './helpers/chat-app-harness.mjs';

const eid = '11111111-2222-4333-8444-555555555555';
const sid = '22222222-3333-4444-8555-666666666666';
const originalAttemptId = '33333333-4444-4555-8666-777777777777';
const operationId = '44444444-5555-4666-8777-888888888888';
const path = `/api/company/employees/${eid}/recovery`;
const keys = ['reconcileOwned', 'stopProvider', 'closeViewer', 'observeOriginal', 'closeRetainedViewer'] as const;
type Approval = {
  operationId: string;
  sessionId: string;
  sessionGeneration: string;
  originalAttemptId: string | null;
  parentOperationId: string | null;
  action: string;
};
type Selection = ReturnType<typeof selection>;
type Reply = { ok: boolean; data?: unknown; status?: number; error?: string };
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.window.close();
});
function selection() {
  return {
    version: 1,
    purpose: 'employee-recovery-selection-v1',
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: '2',
    provider: { source: 'retained-native-dispatch', originalAttemptId, providerExecution: 'unproved' },
    unusedIntent: 'none',
    recovery: { kind: 'none' } as {
      kind: string;
      approval?: Approval;
      componentApproval?: Approval | null;
      application?: { state: string; intentRetirement: string };
    },
    availability: Object.fromEntries(
      keys.map((key) => [key, { state: 'unavailable', reason: 'no-original-operation' }])
    ) as Record<(typeof keys)[number], { state: string; reason: string | null }>,
    readOnly: true,
  };
}
const available = (data: Selection, ...names: (typeof keys)[number][]) => {
  for (const name of names) data.availability[name] = { state: 'available', reason: null };
  return data;
};
const parent = (action = 'stop-provider'): Approval => ({
  operationId,
  sessionId: sid,
  sessionGeneration: '2',
  originalAttemptId,
  parentOperationId: null,
  action,
});
const result = (approval: Approval, outcome: string) => ({
  native: {
    version: 1,
    purpose: 'employee-recovery-v1',
    employeeId: eid,
    approval,
    outcome,
    newDispatch: 'attempted',
    earlierEffects: 'unproved',
  },
  application: { state: 'recovery-required', intentRetirement: 'not-applicable' },
});

async function setup(
  options: {
    read?: () => Reply | Promise<Reply>;
    effect?: (input: Approval) => Reply | Promise<Reply>;
    observe?: (input: Approval) => Reply | Promise<Reply>;
  } = {}
) {
  const employee = {
    id: eid,
    sessionId: sid,
    sessionGeneration: 2,
    name: 'River',
    position: 'Engineer',
    permissions: EmployeePermissionsSchema.parse({}),
    onVacation: false,
    desiredRunning: true,
    effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false },
    boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' },
  };
  const company = { canManage: true, settings: { ownerName: 'Owner' }, employees: [employee] };
  const h = await createHarness({ company });
  handles.push(h);
  const previous = h.app._chatApi.bind(h.app);
  const calls: Array<{ path: string; method: string; body?: { approval: Approval } }> = [];
  h.app._chatApi = async (url: string, request?: { method?: string; body?: { approval: Approval } }) => {
    if (url.startsWith(path)) {
      calls.push({ path: url, method: request?.method ?? 'GET', body: request?.body });
      if (url === path + '-selection') return options.read?.() ?? { ok: true, data: selection() };
      if (url === path && request?.body) return options.effect?.(request.body.approval) ?? { ok: false, status: 503 };
      if (url === path + '/observe' && request?.body)
        return options.observe?.(request.body.approval) ?? { ok: false, status: 503 };
    }
    if (url === '/api/company') return { ok: true, data: structuredClone(company) };
    if (url === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    return previous(url, request);
  };
  await h.shell.openCompany('people');
  const open = async () => {
    (h.document.querySelector(`[aria-label="Edit profile for ${employee.name}"]`) as HTMLButtonElement).click();
    await h.flush();
    const dialog = h.document.querySelector('.ca-expert-profile') as HTMLDialogElement;
    (dialog.querySelector('[data-profile-tab="permissions"]') as HTMLButtonElement).click();
    await h.flush();
    return dialog;
  };
  const dialog = await open();
  const panel = () => h.document.querySelector('.ca-employee-recovery') as HTMLElement;
  const button = (label: string) => panel().querySelector(`[aria-label="${label} for River"]`) as HTMLButtonElement;
  const effects = () => calls.filter((c) => c.method === 'POST');
  return { h, employee, dialog, panel, button, calls, effects, open };
}

it('shows unavailable native recovery loudly and performs only a status read on profile open', async () => {
  const data = selection();
  for (const key of keys) data.availability[key] = { state: 'unavailable', reason: 'no-native-channel' };
  const x = await setup({ read: () => ({ ok: true, data }) });
  expect(x.panel().textContent).toContain('Native recovery is unavailable on this server.');
  expect(x.calls).toEqual([{ path: path + '-selection', method: 'GET', body: undefined }]);
  expect([...x.panel().querySelectorAll('button')].filter((b) => !b.disabled).map((b) => b.textContent)).toEqual([
    'Refresh recovery status',
  ]);
  expect(x.effects()).toEqual([]);
});

it('honors only server action availability, without treating a retained provider attempt as proof of a running employee', async () => {
  const x = await setup({ read: () => ({ ok: true, data: available(selection(), 'reconcileOwned') }) });
  expect(x.button('Reconcile session').disabled).toBe(false);
  expect(x.button('Stop provider')).toBeNull();
  expect(x.panel().textContent).not.toMatch(/employee.*running|recovery complete/i);
  expect(x.effects()).toEqual([]);
});

it('keeps a lost request across profile reopen and explicitly continues with exactly the same operation ID', async () => {
  const data = available(selection(), 'reconcileOwned');
  let first: Approval | undefined;
  const x = await setup({
    read: () => ({ ok: true, data }),
    effect: async (input) => {
      if (!first) {
        first = structuredClone(input);
        throw Error('Synthetic lost reply');
      }
      expect(input).toEqual(first);
      return { ok: true, data: result(input, 'original-handler-pending') };
    },
  });
  x.button('Reconcile session').click();
  await x.h.flush();
  expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain('Synthetic lost reply');
  expect(x.effects()).toHaveLength(1);
  x.dialog.close();
  await x.open();
  expect(x.panel().textContent).toContain('previous request is unconfirmed');
  expect(x.effects()).toHaveLength(1);
  expect(x.button('Reconcile session').disabled).toBe(false);
  x.button('Reconcile session').click();
  await x.h.flush();
  expect(x.effects()).toHaveLength(2);
  expect(x.effects()[1].body?.approval).toEqual(first);
  expect(x.panel().textContent).toContain('Recovery still requires attention');
  expect(x.panel().textContent).not.toMatch(/recovery complete|employee.*running/i);
});

it.each(['missing-application', 'wrong-operation'])(
  'reports a %s reply as unconfirmed without replay',
  async (mode) => {
    const data = available(selection(), 'reconcileOwned');
    const x = await setup({
      read: () => ({ ok: true, data }),
      effect: (input) => {
        const response = result(input, 'original-handler-reconciled');
        return {
          ok: true,
          data:
            mode === 'missing-application'
              ? { native: response.native }
              : { ...response, native: { ...response.native, approval: { ...input, operationId } } },
        };
      },
    });
    x.button('Reconcile session').click();
    await x.h.flush();
    expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain(
      'response is incomplete or belongs to another operation'
    );
    expect(x.effects()).toHaveLength(1);
    expect(x.panel().textContent).not.toContain('Recovery complete');
  }
);

it('reuses the exact retained parent for a read-only inspect and closes only its explicit viewer child after confirmation', async () => {
  const original = parent();
  const data = available(selection(), 'observeOriginal', 'closeRetainedViewer');
  data.recovery = {
    kind: 'retained',
    approval: original,
    componentApproval: null,
    application: { state: 'recovery-required', intentRetirement: 'not-applicable' },
  };
  const x = await setup({
    read: () => ({ ok: true, data }),
    observe: (input) => ({ ok: true, data: result(input, 'provider-stopped-viewer-pending') }),
    effect: (input) => ({ ok: true, data: result(input, 'viewer-close-pending') }),
  });
  x.button('Inspect original operation').click();
  await x.h.flush();
  expect(x.effects()).toEqual([{ path: path + '/observe', method: 'POST', body: { approval: original } }]);
  x.button('Refresh recovery status').click();
  await x.h.flush();
  const confirm = vi.spyOn(x.h.shell, 'confirmCompanyAction').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  x.button('Close retained terminal viewer').click();
  await x.h.flush();
  expect(x.effects()).toHaveLength(1);
  x.button('Close retained terminal viewer').click();
  await x.h.flush();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(x.effects()).toHaveLength(2);
  expect(x.effects()[1].body?.approval).toEqual({
    ...original,
    operationId: expect.any(String),
    parentOperationId: original.operationId,
    action: 'close-viewer',
  });
  expect(x.effects()[1].body?.approval.operationId).not.toBe(original.operationId);
});

it.each(['preparing', 'owner-unavailable'])('keeps %s read-only and preserves unsaved profile edits', async (kind) => {
  const data = selection();
  data.recovery =
    kind === 'preparing'
      ? { kind }
      : {
          kind,
          approval: parent(),
          componentApproval: null,
          application: { state: 'recovery-required', intentRetirement: 'not-applicable' },
        };
  for (const key of keys)
    data.availability[key] = {
      state: 'unavailable',
      reason: kind === 'preparing' ? 'recovery-preparing' : 'original-owner-unavailable',
    };
  const x = await setup({ read: () => ({ ok: true, data }) });
  const draft = x.dialog.querySelector('[name="position"]') as HTMLInputElement;
  draft.value = 'Unsaved role';
  x.button('Refresh recovery status').click();
  await x.h.flush();
  expect(draft.value).toBe('Unsaved role');
  expect(x.effects()).toEqual([]);
  expect([...x.panel().querySelectorAll('button')].filter((b) => !b.disabled)).toHaveLength(1);
});

it('ignores late status data for a changed session and never enables recovery on that stale profile', async () => {
  let resolve!: (value: Reply) => void;
  const pending = new Promise<Reply>((done) => {
    resolve = done;
  });
  const x = await setup({ read: () => pending });
  // The real dialog owns its own projection object, which the shell updates on lifecycle changes.
  x.h.shell.company.employees.find((row: { id: string }) => row.id === eid).sessionGeneration = 3;
  resolve({ ok: true, data: available(selection(), 'stopProvider') });
  await x.h.flush();
  expect(x.effects()).toEqual([]);
  expect(x.panel().querySelector('[aria-label="Stop provider for River"]')).toBeNull();
  expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain('Reopen this profile');
});

it.each([
  { key: 'stopProvider', action: 'stop-provider', label: 'Stop provider', outcome: 'provider-stop-pending' },
  { key: 'closeViewer', action: 'close-viewer', label: 'Close terminal viewer', outcome: 'viewer-close-pending' },
] as const)(
  'confirms the explicit $action action and sends only its original API binding',
  async ({ key, action, label, outcome }) => {
    const x = await setup({
      read: () => ({ ok: true, data: available(selection(), key) }),
      effect: (input) => ({ ok: true, data: result(input, outcome) }),
    });
    const confirm = vi.spyOn(x.h.shell, 'confirmCompanyAction').mockResolvedValue(true);
    x.button(label).click();
    await x.h.flush();
    expect(confirm).toHaveBeenCalledOnce();
    expect(x.effects()).toEqual([
      {
        path,
        method: 'POST',
        body: {
          approval: {
            operationId: expect.any(String),
            sessionId: sid,
            sessionGeneration: '2',
            originalAttemptId,
            parentOperationId: null,
            action,
          },
        },
      },
    ]);
    expect(x.panel().textContent).toContain('Recovery still requires attention');
  }
);

it.each(['employee', 'generation'])(
  'refuses a status reply with a different %s without offering actions',
  async (mismatch) => {
    const data = available(selection(), 'stopProvider');
    if (mismatch === 'employee') data.employeeId = originalAttemptId;
    else data.sessionGeneration = '1';
    const x = await setup({ read: () => ({ ok: true, data }) });
    expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain('does not match the current session');
    expect(x.button('Stop provider')).toBeNull();
    expect(x.effects()).toEqual([]);
  }
);

it('refuses an effect when the canonical session changes while its confirmation is open', async () => {
  const x = await setup({ read: () => ({ ok: true, data: available(selection(), 'stopProvider') }) });
  vi.spyOn(x.h.shell, 'confirmCompanyAction').mockImplementation(async () => {
    x.h.shell.company.employees.find((row: { id: string }) => row.id === eid).sessionGeneration = 3;
    return true;
  });
  x.button('Stop provider').click();
  await x.h.flush();
  expect(x.effects()).toEqual([]);
  expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain('Reopen this profile');
});

it('serializes repeated explicit clicks while the original API request remains in flight', async () => {
  let resolve!: (value: Reply) => void;
  let input!: Approval;
  const pending = new Promise<Reply>((done) => {
    resolve = done;
  });
  const x = await setup({
    read: () => ({ ok: true, data: available(selection(), 'reconcileOwned') }),
    effect: (approval) => {
      input = structuredClone(approval);
      return pending;
    },
  });
  const button = x.button('Reconcile session');
  button.click();
  button.click();
  await x.h.flush();
  expect(x.effects()).toHaveLength(1);
  expect(x.button('Refresh recovery status').disabled).toBe(true);
  resolve({ ok: true, data: result(input, 'original-handler-pending') });
  await x.h.flush();
  expect(x.effects()).toHaveLength(1);
  expect(x.panel().textContent).toContain('Recovery still requires attention');
});

it('inspects the original stop parent after a retained viewer child, including a lost child reply and reopen', async () => {
  const original = parent(),
    child: Approval = {
      ...original,
      operationId: '55555555-6666-4777-8888-999999999999',
      parentOperationId: original.operationId,
      action: 'close-viewer',
    };
  const data = available(selection(), 'observeOriginal', 'closeRetainedViewer');
  data.recovery = {
    kind: 'retained',
    approval: original,
    componentApproval: child,
    application: { state: 'recovery-required', intentRetirement: 'not-applicable' },
  };
  const x = await setup({
    read: () => ({ ok: true, data }),
    observe: (input) => ({
      ok: true,
      data: result(input, input.action === 'stop-provider' ? 'provider-stopped' : 'viewer-closed'),
    }),
    effect: () => {
      throw Error('Synthetic child reply lost');
    },
  });
  x.button('Inspect original operation').click();
  await x.h.flush();
  expect(x.effects()).toEqual([{ path: path + '/observe', method: 'POST', body: { approval: original } }]);
  expect(x.panel().textContent).toContain('Recovery still requires attention');
  x.button('Refresh recovery status').click();
  await x.h.flush();
  vi.spyOn(x.h.shell, 'confirmCompanyAction').mockResolvedValue(true);
  x.button('Close retained terminal viewer').click();
  await x.h.flush();
  expect(x.effects()[1]).toEqual({ path, method: 'POST', body: { approval: child } });
  expect(x.panel().textContent).toContain('Synthetic child reply lost');
  x.dialog.close();
  await x.open();
  expect(x.effects()).toHaveLength(2);
  x.button('Inspect original operation').click();
  await x.h.flush();
  expect(x.effects()[2]).toEqual({ path: path + '/observe', method: 'POST', body: { approval: original } });
  expect(x.panel().textContent).not.toContain('Recovery complete');
});
it('renders known application stop separately from a new Enter and never starts it on status read', async () => {
  const data = available(selection(), 'observeOriginal');
  data.provider.source = 'saved-native-denial';
  data.recovery = {
    kind: 'retained',
    approval: parent(),
    componentApproval: null,
    application: { state: 'completed-stopped', intentRetirement: 'issued-native-retired' },
  };
  const x = await setup({ read: () => ({ ok: true, data }) });
  expect(x.panel().textContent).toContain('Recovery completed with its provider stopped');
  expect(x.panel().textContent).toContain('Enter office is a separate action');
  expect(x.effects()).toEqual([]);
});
it('accepts completion only for the original parent observation after a complete server settlement', async () => {
  const data = available(selection(), 'observeOriginal');
  data.recovery = {
    kind: 'retained',
    approval: parent(),
    componentApproval: null,
    application: { state: 'recovery-required', intentRetirement: 'unconfirmed' },
  };
  const x = await setup({
    read: () => ({ ok: true, data }),
    observe: (input) => ({
      ok: true,
      data: {
        ...result(input, 'provider-stopped'),
        application: { state: 'completed-stopped', intentRetirement: 'issued-native-retired' },
      },
    }),
  });
  x.button('Inspect original operation').click();
  await x.h.flush();
  expect(x.panel().textContent).toContain('Recovery completed with its provider stopped');
  expect(x.panel().textContent).not.toContain('Recovery is unconfirmed');
  expect(x.effects()).toEqual([{ path: path + '/observe', method: 'POST', body: { approval: parent() } }]);
});
it.each(['unconfirmed', 'known-unused-retired'])(
  'refuses completed stop with %s retirement instead of treating the data as a healthy employee',
  async (retirement) => {
    const data = available(selection(), 'observeOriginal');
    data.recovery = {
      kind: 'retained',
      approval: parent(),
      componentApproval: null,
      application: { state: 'completed-stopped', intentRetirement: retirement },
    };
    const x = await setup({ read: () => ({ ok: true, data }) });
    expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain('unconfirmed');
    expect(x.panel().textContent).not.toContain('Recovery completed');
    expect(x.effects()).toEqual([]);
  }
);
it('reopens a lost final observation reply by reading the same terminal original without repeating its effect', async () => {
  const data = available(selection(), 'observeOriginal');
  data.recovery = {
    kind: 'retained',
    approval: parent(),
    componentApproval: null,
    application: { state: 'recovery-required', intentRetirement: 'unconfirmed' },
  };
  const x = await setup({
    read: () => ({ ok: true, data }),
    observe: () => {
      data.recovery.application = { state: 'completed-stopped', intentRetirement: 'issued-native-retired' };
      throw Error('Synthetic committed terminal reply lost');
    },
  });
  x.button('Inspect original operation').click();
  await x.h.flush();
  expect(x.panel().textContent).toContain('Synthetic committed terminal reply lost');
  x.dialog.close();
  await x.open();
  expect(x.panel().textContent).toContain('Recovery completed with its provider stopped');
  expect(x.effects()).toEqual([{ path: path + '/observe', method: 'POST', body: { approval: parent() } }]);
});
it('rejects a completed child response instead of releasing the original stop parent presentation', async () => {
  const original = parent(),
    child = {
      ...original,
      operationId: '55555555-6666-4777-8888-999999999999',
      parentOperationId: original.operationId,
      action: 'close-viewer',
    };
  const data = available(selection(), 'closeRetainedViewer');
  data.recovery = {
    kind: 'retained',
    approval: original,
    componentApproval: child,
    application: { state: 'recovery-required', intentRetirement: 'unconfirmed' },
  };
  const x = await setup({
    read: () => ({ ok: true, data }),
    effect: (input) => ({
      ok: true,
      data: {
        ...result(input, 'viewer-closed'),
        application: { state: 'completed-stopped', intentRetirement: 'issued-native-retired' },
      },
    }),
  });
  vi.spyOn(x.h.shell, 'confirmCompanyAction').mockResolvedValue(true);
  x.button('Close retained terminal viewer').click();
  await x.h.flush();
  expect(x.panel().textContent).toContain('response is incomplete');
  expect(x.panel().textContent).not.toContain('Recovery completed');
  expect(x.effects()).toEqual([{ path, method: 'POST', body: { approval: child } }]);
});
it('keeps a late old response from clearing the new launch request correlation on the same binding', async () => {
  const data = available(selection(), 'reconcileOwned');
  let oldReply!: (value: Reply) => void, first: Approval | undefined, next: Approval | undefined;
  const old = new Promise<Reply>((resolve) => {
    oldReply = resolve;
  });
  const x = await setup({
    read: () => ({ ok: true, data }),
    effect: (input) => {
      if (!first) {
        first = structuredClone(input);
        return old;
      }
      if (!next) {
        next = structuredClone(input);
        throw Error('Synthetic newer reply lost');
      }
      expect(input).toEqual(next);
      return { ok: true, data: result(input, 'original-handler-pending') };
    },
  });
  x.button('Reconcile session').click();
  await x.h.flush();
  x.dialog.close();
  data.provider.originalAttemptId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  await x.open();
  expect(x.button('Reconcile session').disabled).toBe(false);
  x.button('Reconcile session').click();
  await x.h.flush();
  expect(next!.originalAttemptId).toBe(data.provider.originalAttemptId);
  expect(next!.operationId).not.toBe(first!.operationId);
  oldReply({ ok: true, data: result(first!, 'original-handler-reconciled') });
  await x.h.flush();
  expect(x.panel().textContent).toContain('Synthetic newer reply lost');
  (x.h.document.querySelector('.ca-expert-profile') as HTMLDialogElement).close();
  await x.open();
  expect(x.panel().textContent).toContain('previous request is unconfirmed');
  x.button('Reconcile session').click();
  await x.h.flush();
  expect(x.effects().map((call) => call.body!.approval)).toEqual([first, next, next]);
});

it('shows primary and independent cleanup diagnostics without replay or a false completion', async () => {
  const x = await setup({
    read: () => ({ ok: true, data: available(selection(), 'reconcileOwned') }),
    effect: (input) => {
      const response = result(input, 'unconfirmed');
      return {
        ok: true,
        data: {
          ...response,
          native: {
            ...response.native,
            diagnostics: {
              primaryCode: 'WORKER_RECOVERY_PROVIDER_UNCONFIRMED',
              secondaryCode: 'WORKER_REPORT_CLOSE_UNKNOWN',
            },
          },
        },
      };
    },
  });
  x.button('Reconcile session').click();
  await x.h.flush();
  const alert = x.panel().querySelector('[role="alert"]')?.textContent;
  expect(alert).toContain('Primary recovery error: WORKER_RECOVERY_PROVIDER_UNCONFIRMED');
  expect(alert).toContain('Cleanup error: WORKER_REPORT_CLOSE_UNKNOWN');
  expect(x.panel().textContent).toContain('Recovery still requires attention');
  expect(x.panel().textContent).not.toContain('Recovery completed');
  expect(x.effects()).toHaveLength(1);
  await x.h.flush();
  expect(x.effects()).toHaveLength(1);
});

it.each([
  { primaryCode: '<img src=x onerror=alert(1)>', secondaryCode: null },
  { primaryCode: null, secondaryCode: 'A'.repeat(97) },
  { primaryCode: null, secondaryCode: null, ready: true },
])('reports malformed diagnostics as unconfirmed without reflecting them: %j', async (diagnostics) => {
  const x = await setup({
    read: () => ({ ok: true, data: available(selection(), 'reconcileOwned') }),
    effect: (input) => {
      const response = result(input, 'unconfirmed');
      return { ok: true, data: { ...response, native: { ...response.native, diagnostics } } };
    },
  });
  x.button('Reconcile session').click();
  await x.h.flush();
  expect(x.panel().querySelector('[role="alert"]')?.textContent).toContain('response is incomplete');
  expect(x.panel().querySelector('img')).toBeNull();
  expect(x.panel().textContent).not.toContain('<img');
  expect(x.effects()).toHaveLength(1);
});
