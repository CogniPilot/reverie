/** Real profile DOM. Wire fixtures supply server decisions; no runtime effects. */
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EmployeePermissionsSchema } from '../src/company-types.js';
import { createHarness } from './helpers/chat-app-harness.mjs';

const eid = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';
const base = '/api/company/employees/' + eid;
const policy = {
  memoryMaxBytes: 48 * 1024 ** 3,
  memoryHighBytes: 16 * 1024 ** 3,
  swapMaxBytes: 0,
  pidsMax: 512,
  cpuWeight: 100,
  allowedCpus: [0, 1],
  pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
};
type Request = {
  operationId: string;
  sessionId: string;
  sessionGeneration: number;
  containerId: string;
  imageId: string;
  expectedDestinationImageId: string;
  expectedPolicyDigest: string;
  enterOffice: boolean;
};
type Body = { request: Request; policyApproval?: { policy: typeof policy } };
type Reply = { ok: boolean; data?: unknown; status?: number };
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.window.close();
});
const selection = () => ({
  sessionId: sid,
  sessionGeneration: 9,
  sourceDigest: 'a'.repeat(64),
  containerId: 'b'.repeat(64),
  imageId: 'sha256:' + 'c'.repeat(64),
  destinationImageId: 'sha256:' + 'd'.repeat(64),
  state: 'stopped',
  operationId: null as string | null,
  policy: policy as typeof policy | null,
  policyDigest: 'e'.repeat(64),
  enforcement: 'unverified',
  allowedActions: ['continue'],
  canApprovePolicy: true,
  proposedPolicy: undefined as typeof policy | undefined,
  proposedPolicyDigest: undefined as string | undefined,
  originalRequest: undefined as Request | undefined,
  operation: undefined as { operationId: string; state: string; phase: string; allowedActions: string[] } | undefined,
});
async function fixture(
  options: {
    selection?: ReturnType<typeof selection>;
    selectionFailure?: { status: number; error: string | { code: string; message?: string } };
    stopStatus?: Record<string, unknown>;
    start?: (body: Body) => Reply | Promise<Reply>;
    observe?: (body: { operationId: string }) => Reply | Promise<Reply>;
  } = {}
) {
  const employee = {
    id: eid,
    sessionId: sid,
    sessionGeneration: 9,
    name: 'River',
    position: 'Engineer',
    permissions: EmployeePermissionsSchema.parse({}),
    onVacation: true,
    desiredRunning: false,
    effectiveBoardPermissions: {},
    boardPermissionSources: {},
  };
  const company = { canManage: true, boxedRuntime: true, settings: { ownerName: 'Owner' }, employees: [employee] };
  const h = await createHarness({ company });
  handles.push(h);
  const original = h.app._chatApi.bind(h.app);
  const originalTransport = h.app._api.bind(h.app);
  h.app._api = async (url: string, request?: object) => {
    if (url === base + '/docker-policy' && options.selectionFailure)
      return Response.json(
        { success: false, error: options.selectionFailure.error },
        { status: options.selectionFailure.status }
      );
    if (url === base + '/docker-stop/status')
      return options.stopStatus
        ? Response.json({ success: true, data: options.stopStatus })
        : Response.json({ success: false, error: 'Unavailable' }, { status: 404 });
    return originalTransport(url, request);
  };
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const selected = options.selection ?? selection();
  h.app._chatApi = async (url: string, request?: { method?: string; body?: unknown }) => {
    if (url.startsWith(base + '/docker-')) {
      calls.push({ url, method: request?.method ?? 'GET', body: structuredClone(request?.body) });
      if (url === base + '/docker-policy')
        return options.selectionFailure ? original(url, request) : { ok: true, data: structuredClone(selected) };
      if (url === base + '/docker-continuation')
        return options.start?.(request?.body as Body) ?? { ok: false, status: 503 };
      if (url === base + '/docker-continuation/observe')
        return options.observe?.(request?.body as { operationId: string }) ?? { ok: false, status: 503 };
    }
    if (url === '/api/company') return { ok: true, data: structuredClone(company) };
    if (url === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    return original(url, request);
  };
  await h.shell.openCompany('people');
  const open = async () => {
    (h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement).click();
    await h.flush();
    const dialog = h.document.querySelector('.ca-expert-profile') as HTMLDialogElement;
    (dialog.querySelector('[data-profile-tab="permissions"]') as HTMLButtonElement).click();
    await h.flush();
    return dialog;
  };
  const dialog = await open();
  const panel = () => h.document.querySelector('.ca-profile-docker-recovery') as HTMLElement;
  const button = (text: string) => [...panel().querySelectorAll('button')].find((b) => b.textContent === text);
  const starts = () => calls.filter((c) => c.url === base + '/docker-continuation');
  return { h, employee, selected, dialog, open, panel, button, calls, starts };
}

it.each([
  {
    status: 409,
    error: { code: 'DOCKER_CONTINUATION_TARGET_CHANGED' },
    expected: 'DOCKER_CONTINUATION_TARGET_CHANGED',
  },
  { status: 401, error: 'Sign in as the owner', expected: 'Sign in as the owner' },
  {
    status: 409,
    error: { code: 'DOCKER_CONTINUATION_OWNER_STOP_PENDING', message: 'The previous stop requires reconciliation.' },
    expected: 'The previous stop requires reconciliation.',
  },
])(
  'shows the actual shared transport error for HTTP$status without starting recovery',
  async ({ status, error, expected }) => {
    const f = await fixture({ selectionFailure: { status, error } });
    expect(f.panel().querySelector('[role="alert"]')!.textContent).toContain(expected);
    expect(f.panel().textContent).toContain('Docker recovery status is unavailable.');
    expect(f.button('Recover and enter office')).toBeUndefined();
    expect(f.button('Approve displayed limits and recover')).toBeUndefined();
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.starts()).toHaveLength(0);
  }
);

it.each(['current', 'wrong-session', 'wrong-generation', 'unknown-code', 'unexpected-action'])(
  'only displays a matching, read-only pending stop diagnosis (%s)',
  async (mode) => {
    const stopStatus = {
      sessionId: mode === 'wrong-session' ? '11111111-1111-4111-8111-111111111111' : sid,
      sessionGeneration: mode === 'wrong-generation' ? 10 : 9,
      state: 'pending',
      code: mode === 'unknown-code' ? '<img src=x onerror=alert(1)>' : 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED',
      allowedActions: mode === 'unexpected-action' ? ['clear-stop'] : [],
    };
    const f = await fixture({
      selectionFailure: { status: 409, error: { code: 'DOCKER_CONTINUATION_TARGET_CHANGED' } },
      stopStatus,
    });
    const message = f.panel().querySelector('[role="alert"]')!.textContent;
    if (mode === 'current') {
      expect(message).toContain('Operator recovery is required');
      expect(message).toContain('DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED');
      expect(f.panel().textContent).toContain('An earlier stop is blocking this session.');
    } else {
      expect(message).toBe('DOCKER_CONTINUATION_TARGET_CHANGED');
    }
    expect(f.calls.map((call) => call.url)).toEqual([base + '/docker-policy', base + '/docker-stop/status']);
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.starts()).toHaveLength(0);
    expect([...f.panel().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Refresh recovery status']);
    expect(f.panel().querySelector('img')).toBeNull();
  }
);

it('shows the exact reviewed policy and only reads status until the human acts', async () => {
  const f = await fixture();
  expect(f.panel().textContent).toContain('16 GiB');
  expect(f.panel().textContent).toContain('48 GiB');
  expect(f.panel().textContent).toContain('CPU weight');
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].method).toBe('GET');
  expect(f.button('Recover and enter office')).toBeDefined();
  expect(f.h.document.querySelector('.ca-employee-recovery')).toBeNull();
  expect(f.starts()).toHaveLength(0);
  f.button('Refresh recovery status')!.click();
  await f.h.flush();
  expect(f.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  expect(f.starts()).toHaveLength(0);
});
it('ships the recovery script once and renders its profile controls through the actual module', async () => {
  const f = await fixture();
  const index = new f.h.window.DOMParser().parseFromString(
    readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8'),
    'text/html'
  );
  expect(index.querySelectorAll('script[src="docker-employee-recovery.js"][defer]')).toHaveLength(1);
  expect(f.panel().isConnected).toBe(true);
  expect(f.button('Refresh recovery status')).toBeDefined();
  expect(f.starts()).toHaveLength(0);
});
it('keeps a lost start across profile reopen and never automatically replays it', async () => {
  const f = await fixture({
    start: async () => {
      throw Error('Synthetic lost reply');
    },
  });
  f.button('Recover and enter office')!.click();
  await f.h.flush();
  expect(f.panel().querySelector('[role="alert"]')!.textContent).toContain('Synthetic lost reply');
  expect(f.starts()).toHaveLength(1);
  f.dialog.close();
  await f.open();
  expect(f.button('Recover and enter office')).toBeUndefined();
  expect(f.button('Check original recovery')).toBeDefined();
  f.button('Check original recovery')!.click();
  await f.h.flush();
  expect(f.starts()).toHaveLength(1);
  expect(f.panel().textContent).toContain('could not be verified');
});
it('HTTP success with held state is visibly held and cannot offer a fresh start', async () => {
  const f = await fixture({
    start: (body) => ({
      ok: true,
      data: {
        operationId: body.request.operationId,
        phase: 'resources-issued',
        state: 'held',
        allowedActions: ['observe'],
        code: 'DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED',
      },
    }),
  });
  f.button('Recover and enter office')!.click();
  await f.h.flush();
  expect(f.panel().textContent).toContain('Recovery needs attention. Check the original recovery before trying again.');
  expect(f.panel().querySelector('[role="alert"]')!.textContent).toContain(
    'previous recovery step could not be confirmed'
  );
  const details = f.panel().querySelector('.ca-recovery-details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  details.querySelector('summary')!.click();
  await f.h.flush();
  expect(details.open).toBe(true);
  expect(f.panel().querySelector('.ca-recovery-details code')!.textContent).toContain('RESOURCES_UNCONFIRMED');
  details.querySelector('summary')!.click();
  await f.h.flush();
  expect(details.open).toBe(false);
  expect(f.starts()).toHaveLength(1);
  expect(f.panel().textContent).not.toContain('recovery completed');
  expect(f.button('Recover and enter office')).toBeUndefined();
  expect(f.button('Continue original recovery')).toBeUndefined();
});
it('an explicitly offered continuation uses the exact original request without approving policy twice', async () => {
  const s = selection();
  s.policy = null;
  s.allowedActions = ['approve-policy'];
  s.proposedPolicy = policy;
  s.proposedPolicyDigest = 'f'.repeat(64);
  let first: Body | undefined;
  const f = await fixture({
    selection: s,
    start: (body) => {
      first ??= structuredClone(body);
      return {
        ok: true,
        data: {
          operationId: body.request.operationId,
          phase: 'office-ready',
          state: 'pending',
          allowedActions: ['observe', 'continue'],
        },
      };
    },
  });
  f.button('Approve displayed limits and recover')!.click();
  await f.h.flush();
  expect(first!.policyApproval!.policy).toEqual(policy);
  expect(first!.request.expectedPolicyDigest).toBe(s.proposedPolicyDigest);
  f.button('Continue original recovery')!.click();
  await f.h.flush();
  expect(f.starts()).toHaveLength(2);
  expect(f.starts()[1].body).toEqual({ request: first!.request });
});
it('a foreign operation response stays unconfirmed and never reports completion', async () => {
  const f = await fixture({
    start: () => ({
      ok: true,
      data: {
        operationId: '33333333-3333-4333-8333-333333333333',
        phase: 'ready',
        state: 'ready',
        allowedActions: ['observe'],
      },
    }),
  });
  f.button('Recover and enter office')!.click();
  await f.h.flush();
  expect(f.panel().textContent).toContain('Recovery outcome is unconfirmed');
  expect(f.panel().textContent).not.toContain('recovery completed');
  expect(f.button('Recover and enter office')).toBeUndefined();
});

it('rejoins the server-owned original after reload and offers only its exact allowed continuation', async () => {
  const s = selection();
  s.operationId = '33333333-3333-4333-8333-333333333333';
  s.originalRequest = {
    operationId: s.operationId,
    sessionId: s.sessionId,
    sessionGeneration: s.sessionGeneration,
    containerId: s.containerId,
    imageId: s.imageId,
    expectedDestinationImageId: s.destinationImageId,
    expectedPolicyDigest: s.policyDigest,
    enterOffice: true,
  };
  s.operation = {
    operationId: s.operationId,
    state: 'pending',
    phase: 'office-ready',
    allowedActions: ['observe', 'continue'],
  };
  const f = await fixture({ selection: s });
  expect(f.starts()).toHaveLength(0);
  expect(f.button('Recover and enter office')).toBeUndefined();
  f.button('Continue original recovery')!.click();
  await f.h.flush();
  expect(f.starts()).toHaveLength(1);
  expect(f.starts()[0].body).toEqual({ request: s.originalRequest });
  expect(f.button('Continue original recovery')).toBeUndefined(); // Lost reply requires fresh observation.
});

it.each([
  { cpus: [0, 1, 2, 4, 6, 7], label: '0–2, 4, 6–7' },
  { cpus: [0], label: '0' },
  { cpus: [0, 2], label: '0, 2' },
  { cpus: [], label: 'Unavailable' },
  { cpus: [2, 1], label: 'Unavailable' },
])('formats CPU placement read-only as $label', async ({ cpus, label }) => {
  const selected = selection();
  selected.policy = { ...policy, allowedCpus: cpus };
  const f = await fixture({ selection: selected });
  const row = [...f.panel().querySelectorAll('tr')].find(
    (row) => row.querySelector('th')?.textContent === 'Allowed CPUs'
  );
  expect(row?.querySelector('td')?.textContent).toBe(label);
  expect(f.starts()).toHaveLength(0);
});
