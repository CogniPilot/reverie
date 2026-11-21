/** Actual profile/company DOM; responses represent API decisions, never runtime authority. */
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fixture as nativeResources } from './helpers/docker-resource-physical.js';
import { EmployeePermissionsSchema } from '../src/company-types.js';
import { createHarness } from './helpers/chat-app-harness.mjs';
const eid = '11111111-1111-4111-8111-111111111111',
  sid = '22222222-2222-4222-8222-222222222222',
  revision = '33333333-3333-4333-8333-333333333333';
const base = '/api/company/employees/' + eid,
  high = 48 * 1024 ** 3;
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.window.close();
});
async function fixture(
  options: {
    view?: 'company' | 'employee';
    originalReply?: (path: string, request?: { method?: string; body?: unknown }) => unknown | Promise<unknown>;
    missingEmployee?: boolean;
    rootFailure?: { status: number; error: unknown };
    approved?: boolean;
    owner?: boolean;
    stoppedPool?: boolean;
    action?: string[];
    reply?: (path: string, body: unknown) => unknown | Promise<unknown>;
    malformed?: boolean;
    readFailure?: string;
    summary?: Record<string, unknown>;
    actualLimits?: Record<string, unknown>;
    binding?: { employeeId: string; sessionId: string; sessionGeneration: number };
    writerClosed?: boolean;
    intentRetired?: boolean;
    legacyRead?: boolean;
    resourceScope?: { operationId: string; containerId: string };
  } = {}
) {
  const employee = {
    id: options.binding?.employeeId ?? eid,
    sessionId: options.binding?.sessionId ?? sid,
    sessionGeneration: options.binding?.sessionGeneration ?? 9,
    name: 'River',
    position: 'Engineer',
    permissions: EmployeePermissionsSchema.parse({}),
    onVacation: false,
    desiredRunning: true,
    effectiveBoardPermissions: {},
    boardPermissionSources: {},
  };
  const profileBase = '/api/company/employees/' + employee.id;
  const company = {
    canManage: true,
    boxedRuntime: true,
    settings: { ownerName: 'Owner' },
    employees: options.missingEmployee ? [] : [employee],
  };
  const h = await createHarness({ company });
  handles.push(h);
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let approved = options.approved !== false,
    owner = options.owner !== false;
  let actual = 16 * 1024 ** 3,
    allowed = options.action ?? ['apply'];
  let summary = options.summary;
  let readFailure = options.readFailure,
    readApproved = true;
  let operationId = options.resourceScope?.operationId ?? '55555555-5555-4555-8555-555555555555',
    containerId = options.resourceScope?.containerId ?? '6'.repeat(64);
  let rootFailure: { status: number; error: unknown } | null = options.rootFailure ?? null;
  const initialDesired = summary?.desired as { revision: string } | null | undefined;
  let closed = options.writerClosed === true,
    retired = options.intentRetired === true;
  let currentRevision = initialDesired?.revision ?? revision,
    defaultHigh = high;
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, request?: { method?: string; body?: unknown }) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status')
      return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (
      path.startsWith('/api/company/docker-resources') ||
      path.startsWith(profileBase + '/docker-resources') ||
      path.startsWith(profileBase + '/docker-pool')
    ) {
      const method = request?.method ?? 'GET';
      calls.push({ path, method, body: structuredClone(request?.body) });
      if (path.startsWith('/api/company/docker-resources/original-attempts'))
        return options.originalReply
          ? options.originalReply(path, request)
          : { ok: true, data: { items: [], next: null, enforcement: 'not-observed' } };
      if (method !== 'GET' && options.reply) return options.reply(path, request?.body);
      if (path === '/api/company/docker-resources' && rootFailure) return { ok: false, ...rootFailure };
      if (path === '/api/company/docker-resources' && summary) return { ok: true, data: structuredClone(summary) };
      if (path === '/api/company/docker-resources')
        return {
          ok: true,
          data: {
            allowedActions: ['approve-default'],
            desired: approved
              ? { revision: currentRevision, scope: 'all-current-and-future', memoryHighBytes: defaultHigh }
              : null,
            employees: [
              {
                employeeId: employee.id,
                sessionId: employee.sessionId,
                sessionGeneration: employee.sessionGeneration,
                state: 'not-observed',
                allowedActions: allowed,
                enforcement: 'not-observed',
              },
            ],
          },
        };
      if (path === profileBase + '/docker-resources' && readFailure) return { ok: false, error: { code: readFailure } };
      if (path === profileBase + '/docker-resources')
        return {
          ok: true,
          data: {
            employeeId: employee.id,
            sessionId: employee.sessionId,
            sessionGeneration: options.malformed ? employee.sessionGeneration - 1 : employee.sessionGeneration,
            revision: approved ? currentRevision : null,
            desiredMemoryHighBytes: approved ? high : null,
            operationId: options.legacyRead ? undefined : operationId,
            containerId: options.legacyRead ? undefined : containerId,
            actualMemoryHighBytes: actual,
            memoryMaxBytes: options.actualLimits?.memoryMaxBytes ?? 64 * 1024 ** 3,
            ...(options.actualLimits ? { actualLimits: options.actualLimits } : {}),
            approved: readApproved,
            approvalSource: readApproved ? 'original-policy' : null,
            approvedRevision: null,
            writerClosed: closed || undefined,
            intentRetired: retired || undefined,
            originalOutcome: closed || retired ? 'unknown' : undefined,
            enforcement: 'fresh-native-readback',
            allowedActions: allowed,
          },
        };
      if (path === profileBase + '/docker-pool/status')
        return {
          ok: true,
          data: {
            sessionId: employee.sessionId,
            sessionGeneration: employee.sessionGeneration,
            ...(options.stoppedPool
              ? { state: 'held', code: 'DOCKER_POOL_ANCHOR_UNCONFIRMED', allowedActions: [] }
              : { state: 'reconciliation-required', allowedActions: ['reconcile-pool'], scopeDigest: 'a'.repeat(64) }),
          },
        };
      if (path === profileBase + '/docker-pool/cold-preview' && options.stoppedPool)
        return {
          ok: true,
          data: {
            sessionId: employee.sessionId,
            sessionGeneration: employee.sessionGeneration,
            scopeDigest: 'a'.repeat(64),
            policy: { memoryMaxBytes: high },
          },
        };
      return { ok: false, error: { code: 'FIXTURE_UNHANDLED_WRITE' } };
    }
    return original(path, request);
  };
  if (options.view === 'company') await h.shell.openCompanySettings();
  else {
    await h.shell.openCompany('people');
    (h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement).click();
    await h.flush();
    (h.document.querySelector('[data-profile-tab="permissions"]') as HTMLButtonElement).click();
  }
  await h.flush();
  const panel = () => h.document.querySelector('.ca-docker-resources') as HTMLElement;
  const button = (name: string) => [...(panel()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === name);
  const writes = () => calls.filter((c) => c.method !== 'GET');
  const click = async (name: string) => {
    button(name)!.click();
    await h.flush();
  };
  const originals = () => h.document.querySelector('[aria-label="Original resource requests"]') as HTMLElement;
  const originalButton = (name: string) =>
    [...(originals()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === name);
  return {
    originals,
    originalButton,
    originalClick: async (name: string) => {
      originalButton(name)!.click();
      await h.flush();
    },
    h,
    company,
    employee,
    panel,
    button,
    writes,
    calls,
    click,
    setReadApproved: (v: boolean) => {
      readApproved = v;
    },
    setReadFailure: (v: string | undefined) => {
      readFailure = v;
    },
    setResourceScope: (v: { operationId: string; containerId: string }) => {
      operationId = v.operationId;
      containerId = v.containerId;
    },
    setRootFailure: (v: { status: number; error: unknown } | null) => {
      rootFailure = v;
    },
    setSummary: (v: Record<string, unknown>) => {
      summary = v;
    },
    setClosed: (v: boolean) => {
      closed = v;
    },
    setRetired: (v: boolean) => {
      retired = v;
    },
    setOwner: (v: boolean) => {
      owner = v;
    },
    setActual: (v: number) => {
      actual = v;
    },
    setDefaultHigh: (v: number) => {
      defaultHigh = v;
    },
    setRevision: (v: string) => {
      currentRevision = v;
    },
    setAllowed: (v: string[]) => {
      allowed = v;
    },
    setApproved: (v: boolean) => {
      approved = v;
    },
  };
}
it('separates approved policy, actual readback and pool correlation in the real employee profile', async () => {
  const f = await fixture();
  expect(f.panel().textContent).toContain('Owner-approved default: 48 GiB');
  expect(f.panel().textContent).toContain('Actual soft RAM: 16 GiB. Hard RAM ceiling: 64 GiB');
  expect(f.button('Apply approved soft RAM default')).toBeDefined();
  expect(f.button('Reconcile shared pool observation')).toBeDefined();
  expect(f.writes()).toEqual([]);
  expect(f.calls.every((c) => !c.path.includes('/resources/fleet') && !c.path.includes('/resources/employees'))).toBe(
    true
  );
});
it('shows compact company totals and a full unapproved48GiB proposal without issuing an approval', async () => {
  const f = await fixture({ view: 'company', approved: false });
  expect(f.panel().textContent).toContain('1 employee');
  expect(f.panel().textContent).toContain('Proposed soft RAM default: 48 GiB');
  expect(f.panel().textContent).toContain('not fresh enforcement');
  expect(f.button('Approve 48 GiB soft RAM default')).toBeDefined();
  expect(f.writes()).toEqual([]);
});
it('approves only the exact default proposal using one owner UUID and expected revision', async () => {
  const f = await fixture({
    view: 'company',
    approved: false,
    reply: async (path, body) => {
      expect(path).toBe('/api/company/docker-resources/default');
      expect(body).toMatchObject({ expectedRevision: null, scope: 'all-current-and-future', memoryHighBytes: high });
      expect((body as { revision: unknown }).revision).toMatch(/^[a-f0-9-]{36}$/);
      return { ok: false, error: { code: 'UNKNOWN_DEFAULT_REPLY' } };
    },
  });
  const b = f.button('Approve 48 GiB soft RAM default')!;
  b.click();
  b.click();
  await f.h.flush();
  expect(f.writes()).toHaveLength(1);
  expect(f.panel().textContent).toContain('UNKNOWN_DEFAULT_REPLY');
  await f.click('Refresh resources');
  expect(f.button('Approve 48 GiB soft RAM default')).toBeUndefined();
  expect(f.writes()).toHaveLength(1);
});
it('keeps unknown application latched and refresh read-only; offers only API-authorized original reconciliation', async () => {
  const f = await fixture({ reply: async () => ({ ok: false, error: { code: 'ORIGINAL_HELPER_UNCONFIRMED' } }) });
  const b = f.button('Apply approved soft RAM default')!;
  b.click();
  b.click();
  await f.h.flush();
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]!.body).toEqual({ revision });
  expect(f.panel().textContent).toContain('ORIGINAL_HELPER_UNCONFIRMED');
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
  f.setAllowed(['reconcile']);
  await f.click('Refresh resources');
  expect(f.button('Check original resource application')).toBeDefined();
  await f.click('Check original resource application');
  expect(f.writes().map((c) => c.path)).toEqual([
    base + '/docker-resources/apply',
    base + '/docker-resources/reconcile',
  ]);
  expect(f.writes().every((c) => JSON.stringify(c.body) === JSON.stringify({ revision }))).toBe(true);
});
it('uses the exact API pool scope/currentSID/gen without requesting limits or starting an employee', async () => {
  const f = await fixture({
    reply: async (path, body) => {
      expect(path).toBe(base + '/docker-pool/reconcile');
      expect(body).toEqual({ sessionId: sid, sessionGeneration: 9, expectedScopeDigest: 'a'.repeat(64) });
      return { ok: true, data: { sessionId: sid, sessionGeneration: 9, state: 'retained', allowedActions: [] } };
    },
  });
  await f.click('Reconcile shared pool observation');
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]!.path).not.toMatch(/continuation|apply/);
});
it('requires explicit owner confirmation before submitting the stopped pool recovery preview', async () => {
  const f = await fixture({
    stoppedPool: true,
    reply: async (path, body) => {
      expect(path).toBe(base + '/docker-pool/cold-recover');
      expect(body).toEqual({
        operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        sessionId: sid,
        sessionGeneration: 9,
        expectedScopeDigest: 'a'.repeat(64),
      });
      return { ok: true, data: { sessionId: sid, sessionGeneration: 9, state: 'retained' } };
    },
  });
  await f.click('Review stopped pool recovery');
  expect(f.writes()).toEqual([]);
  const dialog = f.h.document.querySelector('.ca-company-confirm')!;
  expect(dialog.textContent).toContain('48 GiB RAM ceiling');
  (dialog.querySelector('[aria-label="Recover shared pool"]') as HTMLButtonElement).click();
  await f.h.flush();
  expect(f.writes()).toHaveLength(1);
});
it('refuses malformed binding and missing or malformed action lists without guessing permissions', async () => {
  const bad = await fixture({ malformed: true });
  expect(bad.button('Apply approved soft RAM default')).toBeUndefined();
  expect(bad.panel().textContent).toContain('could not be verified');
  const missing = await fixture({ action: ['arbitrary-action'] });
  expect(missing.button('Apply approved soft RAM default')).toBeUndefined();
  expect(missing.writes()).toEqual([]);
});
it('rechecks owner and employee currentness before mutation and after awaited reads', async () => {
  const f = await fixture();
  f.setOwner(false);
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toEqual([]);
  expect(f.panel().textContent).toContain('Sign in as the owner');
  f.setOwner(true);
  f.employee.sessionGeneration = 10;
  await f.click('Refresh resources');
  expect(f.writes()).toEqual([]);
  expect(f.panel().textContent).toContain('Employee identity changed');
});
it('does not mount owner controls for a non-owner in normal company settings', async () => {
  const f = await fixture({ owner: false, view: 'company' });
  expect(f.panel()).toBeNull();
  expect(f.writes()).toEqual([]);
});

it('registers the Docker resource module once in the shipped document', () => {
  const page = new JSDOM(readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8'));
  try {
    expect(page.window.document.querySelectorAll('script[src="company-resources.js"][defer]')).toHaveLength(1);
  } finally {
    page.window.close();
  }
});

it('keeps a new same-value approval explicit and collapsed after a closed writer', async () => {
  const f = await fixture({ view: 'company' });
  const details = f.panel().querySelector('details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(f.button('Approve new 48 GiB default revision')).toBeDefined();
  expect(f.writes()).toEqual([]);
  const employee = await fixture({ action: ['reconcile', 'new-revision'], writerClosed: true });
  expect(employee.panel().textContent).toContain('original writer is closed');
  expect(employee.button('Apply approved soft RAM default')).toBeUndefined();
  expect(employee.button('Review resource default')).toBeDefined();
  expect(employee.writes()).toEqual([]);
});

it('keeps API-authorized original reconciliation available when fresh running readback is held', async () => {
  const f = await fixture({ action: ['reconcile'], readFailure: 'ORIGINAL_WRITER_UNCONFIRMED' });
  expect(f.panel().textContent).toContain('ORIGINAL_WRITER_UNCONFIRMED');
  expect(f.button('Check original resource application')).toBeDefined();
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
  expect(f.writes()).toEqual([]);
});

it('confirms one apply response then refreshes actual enforcement without another write', async () => {
  const f = await fixture({
    reply: async () => {
      f.setActual(high);
      f.setAllowed([]);
      return {
        ok: true,
        data: {
          employeeId: eid,
          sessionId: sid,
          sessionGeneration: 9,
          revision,
          state: 'applied',
          enforcement: 'fresh-native-readback',
        },
      };
    },
  });
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toHaveLength(1);
  expect(f.panel().textContent).toContain('Actual soft RAM: 48 GiB');
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
});
it('keeps closed-writer proof distinct from historical success and unobserved desired enforcement', async () => {
  const f = await fixture({
    action: ['reconcile'],
    reply: async () => {
      f.setAllowed(['reconcile', 'new-revision']);
      f.setClosed(true);
      return {
        ok: true,
        data: {
          employeeId: eid,
          sessionId: sid,
          sessionGeneration: 9,
          revision,
          state: 'closed-writer',
          writerClosed: true,
          originalOutcome: 'unknown',
          enforcement: 'not-observed',
          allowedActions: ['new-revision'],
        },
      };
    },
  });
  await f.click('Check original resource application');
  expect(f.writes()).toHaveLength(1);
  expect(f.panel().textContent).toContain('Actual soft RAM: 16 GiB');
  expect(f.panel().textContent).toContain('original writer is closed');
  expect(f.button('Review resource default')).toBeDefined();
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
});
it('refuses a malformed closure result and never converts it into permission to apply', async () => {
  const f = await fixture({
    action: ['reconcile'],
    reply: async () => ({
      ok: true,
      data: {
        employeeId: eid,
        sessionId: sid,
        sessionGeneration: 9,
        revision,
        state: 'closed-writer',
        writerClosed: false,
        originalOutcome: 'unknown',
        enforcement: 'not-observed',
        allowedActions: ['new-revision'],
      },
    }),
  });
  await f.click('Check original resource application');
  expect(f.panel().textContent).toContain('original resource outcome remains unconfirmed');
  expect(f.writes()).toHaveLength(1);
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
});

it('distinguishes original approved limits from the unapplied current48GiB default', async () => {
  const f = await fixture();
  expect(f.panel().textContent).toContain('Actual limits match the original approved policy.');
  expect(f.panel().textContent).toContain('The 48 GiB default is not currently applied to this employee.');
  expect(f.writes()).toEqual([]);
});
it('keeps raw verification codes in collapsed technical details with an actionable primary message', async () => {
  const f = await fixture({ readFailure: 'DOCKER_POOL_ORIGINAL_ACK_MISSING' });
  expect(f.panel().querySelector('[role="alert"]')?.textContent).toContain('Refresh before another change');
  expect(f.panel().querySelector('[role="alert"]')?.textContent).not.toContain('DOCKER_POOL_');
  const details = f.panel().querySelector('.ca-docker-resource-details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('DOCKER_POOL_ORIGINAL_ACK_MISSING');
  expect(f.writes()).toEqual([]);
});

it('preserves the old unknown request without blocking an independently offered new revision', async () => {
  const f = await fixture({ reply: async () => ({ ok: false, error: { code: 'ORIGINAL_UNKNOWN' } }) });
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toHaveLength(1);
  const next = '44444444-4444-4444-8444-444444444444';
  f.setRevision(next);
  f.setAllowed(['apply']);
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Apply approved soft RAM default')).toBeDefined();
  await f.click('Apply approved soft RAM default');
  expect(f.writes().map((v) => v.body)).toEqual([{ revision }, { revision: next }]);
});

it('releases only its matching canonically retained lost default and requires a new explicit approval', async () => {
  const submitted: Array<{
    revision: string;
    expectedRevision: string | null;
    scope: string;
    memoryHighBytes: number;
  }> = [];
  const f = await fixture({
    view: 'company',
    approved: false,
    reply: async (_path, body) => {
      const request = body as (typeof submitted)[number];
      submitted.push(request);
      if (submitted.length === 1) return { ok: false, error: { code: 'DEFAULT_REPLY_LOST' } };
      f.setApproved(true);
      f.setRevision(request.revision);
      return {
        ok: true,
        data: {
          desired: { revision: request.revision, scope: request.scope, memoryHighBytes: request.memoryHighBytes },
          enforcement: 'not-observed',
        },
      };
    },
  });
  await f.click('Approve 48 GiB soft RAM default');
  expect(f.writes()).toHaveLength(1);
  f.setApproved(true);
  f.setRevision('55555555-5555-4555-8555-555555555555');
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
  f.setRevision(submitted[0]!.revision);
  f.setDefaultHigh(16 * 1024 ** 3);
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
  f.setDefaultHigh(high);
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Approve new 48 GiB default revision')).toBeDefined();
  expect(f.panel().textContent).not.toContain('Default approval outcome is unconfirmed');
  await f.click('Approve new 48 GiB default revision');
  expect(f.writes()).toHaveLength(2);
  expect(submitted[1]!.expectedRevision).toBe(submitted[0]!.revision);
  expect(submitted[1]!.revision).not.toBe(submitted[0]!.revision);
});

// Producer: actual owner HTTP status after real CompanyStore/revision-ledger
// transitions. Its owning backend test asserts equality against this SAME file.
const closedWriterStatus = JSON.parse(
  readFileSync(new URL('./fixtures/docker-resource-closed-writer-status.json', import.meta.url), 'utf8')
) as Record<string, unknown> & { employees: Array<Record<string, unknown>> };
it('roundtrips the actual closed-writer backend golden into the company GUI without claiming application success', async () => {
  const f = await fixture({ view: 'company', summary: closedWriterStatus });
  expect(f.panel().textContent).toContain('2 employees');
  expect(f.panel().textContent).toContain('0 recorded limit observations, 1 unknown original outcome');
  expect(f.panel().textContent).toContain('1 original resource writer is closed');
  expect(f.panel().textContent).toContain('does not confirm that the requested limits were applied');
  expect(f.button('Approve new 48 GiB default revision')).toBeDefined();
  expect(f.panel().querySelector('[role="alert"]')?.textContent).toBe('');
  expect(f.writes()).toEqual([]);
});
it('refuses a closed-writer summary without its frozen closure flags', async () => {
  const changed = structuredClone(closedWriterStatus);
  changed.employees.find((v) => v.state === 'closed-writer')!.writerClosed = false;
  const f = await fixture({ view: 'company', summary: changed });
  expect(f.panel().textContent).toContain('Company resource summary could not be verified');
  expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
  expect(f.writes()).toEqual([]);
});
it('keeps original uncertainty visible after a later recorded observation', async () => {
  const changed = structuredClone(closedWriterStatus);
  Object.assign(changed.employees.find((v) => v.state === 'closed-writer')!, { state: 'observed', allowedActions: [] });
  const f = await fixture({ view: 'company', summary: changed });
  expect(f.panel().textContent).toContain('1 recorded limit observations, 1 unknown original outcome');
  expect(f.panel().textContent).toContain('original execution outcome remains unknown');
  expect(f.writes()).toEqual([]);
});

it('renders CPU and RAM together from the real native-controller readback DTO without writes', async () => {
  const native = nativeResources();
  await native.controller.preparePool(native.row(), native.current);
  await native.setPool();
  native.makeWorker();
  await native.controller.configure(native.row(), native.current);
  const report = await native.controller.observeMemoryHigh(native.row(), native.current);
  const f = await fixture({ actualLimits: report.actualLimits });
  const table = f.panel().querySelector('table')!;
  expect(table.caption?.textContent).toBe('Running CPU and memory limits');
  expect([...table.rows].map((row) => row.textContent)).toEqual([
    'Soft RAM16 GiB',
    'Hard RAM ceiling48 GiB',
    'Swap allowance0 GiB',
    'CPU weight100',
    'CPU quotaUnlimited',
    'Allowed CPUs0–1',
    'Process limit512',
  ]);
  expect(f.writes()).toEqual([]);
});
it.each([{ cpuWeight: 0 }, { allowedCpus: [1, 1] }, { memoryHighBytes: 0 }, { cpuQuota: 'limited' }])(
  'refuses incoherent additional native resource facts %j',
  async (drift) => {
    const f = await fixture({
      actualLimits: {
        memoryHighBytes: 16 * 1024 ** 3,
        memoryMaxBytes: 48 * 1024 ** 3,
        swapMaxBytes: 0,
        pidsMax: 512,
        cpuWeight: 100,
        allowedCpus: [0, 1],
        cpuQuota: 'unlimited',
        ...drift,
      },
    });
    expect(f.panel().textContent).toContain('CPU and memory readback could not be verified');
    expect(f.panel().querySelector('table')).toBeNull();
    expect(f.writes()).toEqual([]);
  }
);
type PhaseRow = {
  employeeId: string;
  sessionId: string;
  sessionGeneration: number;
  state: string;
  allowedActions: string[];
  writerClosed?: boolean;
  intentRetired?: boolean;
  originalOutcome?: string;
  code?: string;
};
type PhaseStatus = Record<string, unknown> & {
  desired: null | { revision: string; scope: string; memoryHighBytes: number };
  employees: PhaseRow[];
  allowedActions: string[];
};
const phaseStatuses = JSON.parse(
  readFileSync(new URL('./fixtures/docker-resource-phase-statuses.json', import.meta.url), 'utf8')
) as Record<string, PhaseStatus>;
const defaultNotIssued = JSON.parse(
  readFileSync(new URL('./fixtures/docker-resource-default-not-issued.json', import.meta.url), 'utf8')
) as { success: false; error: { code: string; action: string; revision: string; publication: string } };
const actionLabels: Record<string, string> = {
  apply: 'Apply approved soft RAM default',
  'continue-original': 'Continue original resource application',
  'abandon-original': 'Abandon unstarted resource application',
  reconcile: 'Check original resource application',
  'new-revision': 'Review resource default',
};
const targetRow = (status: PhaseStatus) =>
  status.employees.find((row) => row.employeeId === '22222222-2222-4222-8222-222222222222')!;
const nonces = (h: Awaited<ReturnType<typeof createHarness>>, values: string[]) =>
  Object.defineProperty(h.window.crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      const next = values.shift();
      if (!next) throw Error('Unexpected additional nonce');
      return next;
    },
  });
it('offers only actual producer actions across the complete resource phase matrix', async () => {
  expect(Object.keys(phaseStatuses).sort()).toEqual(
    [
      'applied',
      'closed-writer',
      'completed',
      'create-issued',
      'created',
      'failure-before-intent',
      'no-desired',
      'none',
      'observed',
      'observed-after-closure',
      'observed-after-retirement',
      'running',
      'start-issued',
      'unstarted-retired',
    ].sort()
  );
  for (const status of Object.values(phaseStatuses)) {
    const target = targetRow(status);
    const f = await fixture({
      summary: status,
      binding: target,
      action: target.allowedActions,
      readFailure: 'RESOURCE_READBACK_UNCONFIRMED',
    });
    for (const [action, label] of Object.entries(actionLabels))
      expect(f.button(label) !== undefined).toBe(target.allowedActions.includes(action));
    expect(f.writes()).toEqual([]);
    const company = await fixture({ view: 'company', summary: status });
    expect(
      company.button(status.desired ? 'Approve new 48 GiB default revision' : 'Approve 48 GiB soft RAM default') !==
        undefined
    ).toBe(status.allowedActions.includes('approve-default'));
    expect(company.writes()).toEqual([]);
  }
});
it('continues only the explicitly offered original resource attempt despite its local unknown latch', async () => {
  const f = await fixture({
    reply: async () => ({ ok: false, status: 503, error: { code: 'ORIGINAL_OUTCOME_UNKNOWN' } }),
  });
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toHaveLength(1);
  f.setAllowed(['continue-original', 'abandon-original']);
  await f.click('Refresh resources');
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
  const button = f.button('Continue original resource application')!;
  button.click();
  button.click();
  await f.h.flush();
  expect(f.writes().map((v) => v.path)).toEqual([
    base + '/docker-resources/apply',
    base + '/docker-resources/continue',
  ]);
  expect(f.writes().map((v) => v.body)).toEqual([{ revision }, { revision }]);
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(2);
});
it('retires an explicitly offered unstarted intent without claiming a stopped writer or applying limits', async () => {
  const f = await fixture({
    action: ['continue-original', 'abandon-original'],
    reply: async (path) => {
      expect(path).toBe(base + '/docker-resources/abandon');
      f.setAllowed(['reconcile', 'new-revision']);
      f.setRetired(true);
      return {
        ok: true,
        data: {
          employeeId: eid,
          sessionId: sid,
          sessionGeneration: 9,
          revision,
          state: 'unstarted-retired',
          intentRetired: true,
          originalOutcome: 'unknown',
          enforcement: 'not-observed',
          allowedActions: ['reconcile', 'new-revision'],
        },
      };
    },
  });
  expect(f.writes()).toEqual([]);
  await f.click('Abandon unstarted resource application');
  expect(f.writes()).toHaveLength(1);
  expect(f.panel().textContent).toContain('does not prove that a container was stopped');
  expect(f.panel().textContent).toContain('Actual soft RAM: 16 GiB');
  expect(f.button('Continue original resource application')).toBeUndefined();
  expect(f.button('Check original resource application')).toBeDefined();
  expect(f.button('Review resource default')).toBeDefined();
});
it('never shows original continuation or abandonment for an issued helper', async () => {
  const f = await fixture({ action: ['reconcile'] });
  expect(f.button('Continue original resource application')).toBeUndefined();
  expect(f.button('Abandon unstarted resource application')).toBeUndefined();
  expect(f.button('Check original resource application')).toBeDefined();
  expect(f.writes()).toEqual([]);
});
it('rejects a retired-intent reply that falsely claims terminal writer closure', async () => {
  const f = await fixture({
    action: ['continue-original', 'abandon-original'],
    reply: async () => ({
      ok: true,
      data: {
        employeeId: eid,
        sessionId: sid,
        sessionGeneration: 9,
        revision,
        state: 'unstarted-retired',
        intentRetired: true,
        writerClosed: true,
        originalOutcome: 'unknown',
        enforcement: 'not-observed',
        allowedActions: ['reconcile', 'new-revision'],
      },
    }),
  });
  await f.click('Abandon unstarted resource application');
  expect(f.panel().textContent).toContain('original resource outcome remains unconfirmed');
  expect(f.writes()).toHaveLength(1);
});
it('renders actual producer convergence failures as attention without extra employee reads or false completion', async () => {
  const status = phaseStatuses['failure-before-intent']!;
  const f = await fixture({ view: 'company', summary: status });
  expect(f.panel().querySelector('[role="alert"]')?.textContent).toContain(
    '1 employee resource application needs attention'
  );
  expect(f.panel().querySelector('[role="alert"]')?.textContent).not.toContain('DOCKER_');
  const details = f.panel().querySelector('.ca-docker-resource-details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain(targetRow(status).code);
  expect(
    f.calls.every((call) =>
      ['/api/company/docker-resources', '/api/company/docker-resources/original-attempts'].includes(call.path)
    )
  ).toBe(true);
  expect(f.writes()).toEqual([]);
});
it('uses the actual default prewrite refusal only after fresh authenticated status and a later explicit approval', async () => {
  const f = await fixture({
    view: 'company',
    summary: phaseStatuses.none,
    reply: async (_path, body) => {
      const input = body as { revision: string };
      if (input.revision === defaultNotIssued.error.revision) {
        f.setSummary(phaseStatuses.created!);
        return { ok: false, status: 409, error: structuredClone(defaultNotIssued.error) };
      }
      return { ok: false, status: 503, error: { code: 'NEW_REPLY_UNKNOWN' } };
    },
  });
  const next = '99999999-9999-4999-8999-999999999999';
  nonces(f.h, [defaultNotIssued.error.revision, next]);
  await f.click('Approve new 48 GiB default revision');
  expect(f.writes()).toHaveLength(1);
  expect(f.panel().textContent).toContain('previous default approval was not issued');
  expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
  expect(f.calls.filter((call) => call.path === '/api/company/docker-resources')).toHaveLength(2);
  f.setSummary(phaseStatuses['unstarted-retired']!);
  await f.click('Refresh resources');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Approve new 48 GiB default revision')).toBeDefined();
  await f.click('Approve new 48 GiB default revision');
  expect(f.writes().map((v) => v.body)).toEqual([
    {
      revision: defaultNotIssued.error.revision,
      expectedRevision: phaseStatuses.none!.desired!.revision,
      scope: 'all-current-and-future',
      memoryHighBytes: high,
    },
    {
      revision: next,
      expectedRevision: phaseStatuses['unstarted-retired']!.desired!.revision,
      scope: 'all-current-and-future',
      memoryHighBytes: high,
    },
  ]);
});
it('retains a valid not-issued receipt until a fresh authenticated status read succeeds', async () => {
  const f = await fixture({
    view: 'company',
    summary: phaseStatuses.none,
    reply: async () => {
      f.setRootFailure({ status: 401, error: 'Sign in again' });
      return { ok: false, status: 409, error: structuredClone(defaultNotIssued.error) };
    },
  });
  nonces(f.h, [defaultNotIssued.error.revision]);
  await f.click('Approve new 48 GiB default revision');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
  f.setRootFailure(null);
  await f.click('Refresh resources');
  expect(f.button('Approve new 48 GiB default revision')).toBeDefined();
  expect(f.writes()).toHaveLength(1);
});
it('never treats a generic denial wrong nonce or wrong action as the scoped not-issued receipt', async () => {
  const variants = [
    { status: 409, error: { code: defaultNotIssued.error.code } },
    { status: 403, error: defaultNotIssued.error },
    { status: 409, error: { ...defaultNotIssued.error, revision: '99999999-9999-4999-8999-999999999999' } },
    { status: 409, error: { ...defaultNotIssued.error, action: 'apply' } },
    { status: 409, error: { ...defaultNotIssued.error, extra: true } },
  ];
  for (const variant of variants) {
    const f = await fixture({
      view: 'company',
      summary: phaseStatuses.none,
      reply: async () => ({ ok: false, ...structuredClone(variant) }),
    });
    nonces(f.h, [defaultNotIssued.error.revision]);
    await f.click('Approve new 48 GiB default revision');
    expect(f.writes()).toHaveLength(1);
    expect(f.calls.filter((v) => v.path === '/api/company/docker-resources')).toHaveLength(1);
    await f.click('Refresh resources');
    expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
    expect(f.writes()).toHaveLength(1);
  }
});
it('does not let an old not-issued reply release a newer pending default nonce', async () => {
  const replies: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
  const f = await fixture({
    view: 'company',
    summary: phaseStatuses.none,
    reply: async (_path, body) =>
      new Promise((resolve) => {
        replies.push({ body, resolve });
      }),
  });
  // Mount a second real component to model an older view with a delayed reply.
  // The shell intentionally opens only one settings dialog; no decision owner is mocked here.
  const secondDialog = f.h.document.createElement('dialog') as HTMLDialogElement;
  f.h.document.body.append(secondDialog);
  secondDialog.showModal();
  const registry = f.h.window as unknown as {
    ReverieDockerResources: { mount(shell: unknown, container: HTMLElement, dialog: HTMLDialogElement): unknown };
  };
  registry.ReverieDockerResources.mount(f.h.shell, secondDialog, secondDialog);
  await f.h.flush();
  const panels = [...f.h.document.querySelectorAll('[aria-label="Docker employee resource defaults"]')];
  expect(panels).toHaveLength(2);
  const newer = '99999999-9999-4999-8999-999999999999';
  nonces(f.h, [defaultNotIssued.error.revision, newer]);
  (panels[0]!.querySelector('[aria-label="Approve new 48 GiB default revision"]') as HTMLButtonElement).click();
  await f.h.flush();
  (panels[1]!.querySelector('[aria-label="Approve new 48 GiB default revision"]') as HTMLButtonElement).click();
  await f.h.flush();
  expect(replies).toHaveLength(2);
  replies[0]!.resolve({ ok: false, status: 409, error: structuredClone(defaultNotIssued.error) });
  await f.h.flush();
  replies[1]!.resolve({ ok: false, status: 503, error: { code: 'NEWER_OUTCOME_UNKNOWN' } });
  await f.h.flush();
  (panels[1]!.querySelector('[aria-label="Refresh Docker resources"]') as HTMLButtonElement).click();
  await f.h.flush();
  expect(panels[1]!.querySelector('[aria-label="Approve new 48 GiB default revision"]')).toBeNull();
  expect(f.writes()).toHaveLength(2);
  const confirmed = structuredClone(phaseStatuses.none!);
  confirmed.desired!.revision = newer;
  f.setSummary(confirmed);
  (panels[1]!.querySelector('[aria-label="Refresh Docker resources"]') as HTMLButtonElement).click();
  await f.h.flush();
  expect(panels[1]!.querySelector('[aria-label="Approve new 48 GiB default revision"]')).not.toBeNull();
  expect(f.writes()).toHaveLength(2);
});

const applyNotIssued = JSON.parse(
  readFileSync(new URL('./fixtures/docker-resource-apply-not-issued.json', import.meta.url), 'utf8')
) as {
  success: false;
  error: Record<string, unknown> & {
    employeeId: string;
    sessionId: string;
    sessionGeneration: number;
    operationId: string;
    containerId: string;
    revision: string;
  };
};
const capacityStatus = JSON.parse(
  readFileSync(new URL('./fixtures/docker-resource-capacity-status.json', import.meta.url), 'utf8')
) as { success: true; data: PhaseStatus };
const capacityOptions = {
  summary: capacityStatus.data,
  binding: targetRow(capacityStatus.data),
  action: ['apply'],
  resourceScope: { operationId: applyNotIssued.error.operationId, containerId: applyNotIssued.error.containerId },
};
it('releases only the actual scoped capacity refusal after fresh owner resource readback without retrying apply', async () => {
  const f = await fixture({
    ...capacityOptions,
    reply: async () => ({ ok: false, status: 409, error: structuredClone(applyNotIssued.error) }),
  });
  expect(f.writes()).toEqual([]);
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]!.body).toEqual({ revision: applyNotIssued.error.revision });
  expect(f.button('Apply approved soft RAM default')).toBeDefined();
  expect(f.panel().textContent).toContain('This resource application was not issued');
  expect(
    f.calls.filter(
      (v) =>
        v.path === '/api/company/employees/' + applyNotIssued.error.employeeId + '/docker-resources' &&
        v.method === 'GET'
    )
  ).toHaveLength(2);
});
it('retains the capacity refusal until authenticated matching readback succeeds', async () => {
  const f = await fixture({
    ...capacityOptions,
    reply: async () => {
      f.setReadFailure('OWNER_READ_UNCONFIRMED');
      return { ok: false, status: 409, error: structuredClone(applyNotIssued.error) };
    },
  });
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toHaveLength(1);
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
  f.setReadFailure(undefined);
  await f.click('Refresh resources');
  expect(f.button('Apply approved soft RAM default')).toBeDefined();
  expect(f.writes()).toHaveLength(1);
});
it('does not consume the new marker when the original read lacked an operation or container', async () => {
  const f = await fixture({
    ...capacityOptions,
    legacyRead: true,
    reply: async () => ({ ok: false, status: 409, error: structuredClone(applyNotIssued.error) }),
  });
  expect(f.button('Apply approved soft RAM default')).toBeDefined();
  await f.click('Apply approved soft RAM default');
  await f.click('Refresh resources');
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
  expect(f.writes()).toHaveLength(1);
});
it('keeps mismatched or generic capacity responses latched across every scope field', async () => {
  const e = applyNotIssued.error;
  const variants = [
    { status: 409, error: { code: e.code } },
    { status: 403, error: e },
    { status: 409, error: { ...e, action: 'approve-default' } },
    { status: 409, error: { ...e, publication: 'unknown' } },
    { status: 409, error: { ...e, extra: true } },
    ...Object.entries({
      employeeId: '33333333-3333-4333-8333-333333333333',
      sessionId: 'cccccccc-2222-4222-8222-222222222222',
      sessionGeneration: 10,
      operationId: '99999999-9999-4999-8999-999999999999',
      containerId: 'a'.repeat(64),
      revision: '99999999-9999-4999-8999-999999999999',
    }).map(([key, value]) => ({ status: 409, error: { ...e, [key]: value } })),
  ];
  for (const response of variants) {
    const f = await fixture({ ...capacityOptions, reply: async () => ({ ok: false, ...structuredClone(response) }) });
    await f.click('Apply approved soft RAM default');
    await f.click('Refresh resources');
    expect(f.button('Apply approved soft RAM default')).toBeUndefined();
    expect(f.writes()).toHaveLength(1);
  }
});
it('does not infer an unknown application outcome from matching but unadopted actual values', async () => {
  const f = await fixture({
    ...capacityOptions,
    reply: async () => ({ ok: false, status: 503, error: { code: 'ORIGINAL_REPLY_UNKNOWN' } }),
  });
  await f.click('Apply approved soft RAM default');
  f.setActual(high);
  f.setReadApproved(false);
  await f.click('Refresh resources');
  expect(f.panel().textContent).toContain('Actual soft RAM: 48 GiB');
  expect(f.panel().textContent).toContain('have not been adopted');
  expect(f.button('Apply approved soft RAM default')).toBeUndefined();
  expect(f.writes()).toHaveLength(1);
});
it('requires the same fresh container and preserves the original scoped receipt for a later matching read', async () => {
  const f = await fixture({
    ...capacityOptions,
    reply: async () => {
      f.setResourceScope({ operationId: applyNotIssued.error.operationId, containerId: 'a'.repeat(64) });
      f.setAllowed(['reconcile']);
      return { ok: false, status: 409, error: structuredClone(applyNotIssued.error) };
    },
  });
  await f.click('Apply approved soft RAM default');
  expect(f.writes()).toHaveLength(1);
  expect(f.panel().textContent).toContain('This resource application was not issued');
  f.setResourceScope(capacityOptions.resourceScope);
  f.setAllowed(['apply']);
  await f.click('Refresh resources');
  expect(f.button('Apply approved soft RAM default')).toBeDefined();
  expect(f.writes()).toHaveLength(1);
});
it('shows the actual global capacity reason without inventing cleanup or another approval', async () => {
  const f = await fixture({ view: 'company', summary: capacityStatus.data });
  expect(f.panel().querySelector('[role="alert"]')?.textContent).toContain(
    'Resource approval history has reached its capacity'
  );
  expect(f.panel().querySelector('[role="alert"]')?.textContent).not.toContain('DOCKER_RESOURCE_');
  expect(f.panel().querySelector('.ca-docker-resource-details')?.textContent).toContain(
    'DOCKER_RESOURCE_REVISION_CAPACITY'
  );
  expect(f.button('Approve new 48 GiB default revision')).toBeUndefined();
  expect(f.writes()).toEqual([]);
  expect([...f.panel().querySelectorAll('button')].map((v) => v.textContent)).toEqual([
    'Refresh resources',
    'Refresh original requests',
  ]);
});

it('does not use an older capacity refusal to release a newer pending apply for the same full scope', async () => {
  const replies: Array<(value: unknown) => void> = [];
  const f = await fixture({ ...capacityOptions, reply: async () => new Promise((resolve) => replies.push(resolve)) });
  const second = f.h.document.createElement('dialog') as HTMLDialogElement;
  f.h.document.body.append(second);
  second.showModal();
  const registry = f.h.window as unknown as {
    ReverieDockerResources: {
      mountEmployee(shell: unknown, container: HTMLElement, dialog: HTMLDialogElement, employee: unknown): unknown;
    };
  };
  registry.ReverieDockerResources.mountEmployee(f.h.shell, second, second, f.employee);
  await f.h.flush();
  const panels = [...f.h.document.querySelectorAll('[aria-label^="Docker resources for "]')];
  expect(panels).toHaveLength(2);
  (panels[0]!.querySelector('[aria-label="Apply approved soft RAM default"]') as HTMLButtonElement).click();
  await f.h.flush();
  (panels[1]!.querySelector('[aria-label="Apply approved soft RAM default"]') as HTMLButtonElement).click();
  await f.h.flush();
  expect(replies).toHaveLength(2);
  replies[0]!({ ok: false, status: 409, error: structuredClone(applyNotIssued.error) });
  await f.h.flush();
  replies[1]!({ ok: false, status: 503, error: { code: 'NEWER_APPLY_UNKNOWN' } });
  await f.h.flush();
  (panels[1]!.querySelector('[aria-label="Refresh Docker resources"]') as HTMLButtonElement).click();
  await f.h.flush();
  expect(panels[1]!.querySelector('[aria-label="Apply approved soft RAM default"]')).toBeNull();
  expect(panels[1]!.textContent).toContain('original resource application has an unknown outcome');
  expect(f.writes()).toHaveLength(2);
});

// The backend owner HTTP suite deep-equals this same committed fixture.
const originalAttempts = JSON.parse(
  readFileSync(new URL('./fixtures/docker-resource-original-attempts.json', import.meta.url), 'utf8')
);
const originalsRoot = '/api/company/docker-resources/original-attempts';
const originalData = (value: unknown) => ({ ok: true, data: structuredClone(value) });
const originalRow = () => structuredClone(originalAttempts.terminal.pending.items[0]);
const currentUnavailable = { status: 404, error: { code: 'NOT_FOUND' } };
it('keeps actual original helper recovery accessible after the employee disappears and the current summary fails', async () => {
  const row = originalRow();
  const f = await fixture({
    view: 'company',
    missingEmployee: true,
    rootFailure: currentUnavailable,
    originalReply: (path, request) => {
      if (path === originalsRoot) return originalData(originalAttempts.terminal.pending);
      expect(path).toBe(`${originalsRoot}/${row.cursorId}` + (request?.method === 'POST' ? '/reconcile' : ''));
      return originalData(originalAttempts.terminal.closed);
    },
  });
  expect(f.panel().textContent).toContain('Resource status could not be confirmed');
  expect(f.originals()).not.toBeNull();
  expect(f.originals().textContent).toContain('Original execution outcome is unknown');
  expect(f.originals().textContent).not.toContain('River');
  expect(f.originals().querySelector('details')!.textContent).toContain(row.sessionId);
  expect(f.originalButton('Check original helper')).toBeDefined();
  expect(f.originalButton('Retire unstarted request')).toBeUndefined();
  await f.originalClick('Check original helper');
  expect(f.writes()).toEqual([
    {
      path: `${originalsRoot}/${row.cursorId}/reconcile`,
      method: 'POST',
      body: { expectedDigest: row.expectedDigest },
    },
  ]);
  expect(f.originals().textContent).toContain('original execution outcome remains unknown');
  expect(f.originalButton('Check original helper')).toBeUndefined();
  await f.originalClick('Check original request status');
  expect(f.calls.some((call) => call.path === `${originalsRoot}/${row.cursorId}` && call.method === 'GET')).toBe(true);
  expect(f.calls.some((call) => call.path.startsWith(base + '/'))).toBe(false);
});
for (const kind of ['created', 'absent'] as const)
  it(`retires the actual ${kind} original request through explicit CAS without current employee lookup`, async () => {
    const record = originalAttempts[kind],
      row = record.pending.items[0];
    const f = await fixture({
      view: 'company',
      binding: { employeeId: row.employeeId, sessionId: sid, sessionGeneration: 10 },
      originalReply: (path, request) => {
        if (path === originalsRoot) return originalData(record.pending);
        expect(path).toBe(`${originalsRoot}/${row.cursorId}/retire`);
        expect(request?.body).toEqual({ expectedDigest: row.expectedDigest });
        return originalData(record.retired);
      },
    });
    expect(f.originalButton('Retire unstarted request')).toBeDefined();
    await f.originalClick('Retire unstarted request');
    expect(f.writes()).toHaveLength(1);
    expect(f.originals().textContent).toContain('cannot start');
    expect(f.originals().textContent).toContain('does not confirm that a running container was stopped');
    expect(f.originalButton('Retire unstarted request')).toBeUndefined();
    expect(f.originalButton('Check original helper')).toBeUndefined();
    expect(f.calls.some((call) => /\/employees\//.test(call.path))).toBe(false);
  });
it('keeps a lost original reply unknown across collection disappearance until explicit exact GET', async () => {
  const row = originalRow();
  let listed = true,
    exactFails = true;
  const f = await fixture({
    view: 'company',
    originalReply: (path, request) => {
      if (path === originalsRoot)
        return originalData(
          listed ? originalAttempts.terminal.pending : { items: [], next: null, enforcement: 'not-observed' }
        );
      if (request?.method === 'POST') {
        listed = false;
        throw Error('Connection lost');
      }
      return exactFails
        ? { ok: false, status: 409, error: { code: 'DOCKER_RESOURCE_REVISION_CHANGED' } }
        : originalData(originalAttempts.terminal.closed);
    },
  });
  await f.originalClick('Check original helper');
  expect(f.originals().textContent).toContain('reply is unconfirmed');
  expect(f.originalButton('Check original helper')).toBeUndefined();
  await f.originalClick('Refresh original requests');
  expect(f.originals().textContent).toContain('reply is unconfirmed');
  await f.originalClick('Check original request status');
  expect(f.originals().textContent).toContain('reply is unconfirmed');
  exactFails = false;
  await f.originalClick('Check original request status');
  expect(f.originals().textContent).not.toContain('reply is unconfirmed');
  expect(f.originals().textContent).toContain('original helper is closed');
  expect(f.writes()).toHaveLength(1);
  expect(f.calls.filter((call) => call.path === `${originalsRoot}/${row.cursorId}`)).toHaveLength(2);
});
it('uses a fresh exact GET digest for an explicitly offered metadata retry after a CAS denial', async () => {
  const row = originalRow(),
    refreshed = { ...row, expectedDigest: 'f'.repeat(64) };
  const f = await fixture({
    view: 'company',
    originalReply: (path, request) => {
      if (path === originalsRoot) return originalData(originalAttempts.terminal.pending);
      if (request?.method === 'POST')
        return { ok: false, status: 409, error: { code: 'DOCKER_RESOURCE_REVISION_CHANGED' } };
      return originalData(refreshed);
    },
  });
  await f.originalClick('Check original helper');
  expect(f.writes()).toHaveLength(1);
  expect(f.originalButton('Check original helper')).toBeUndefined();
  await f.originalClick('Check original request status');
  expect(f.originalButton('Check original helper')).toBeDefined();
  expect(f.writes()).toHaveLength(1);
  await f.originalClick('Check original helper');
  expect(f.writes()[1]!.body).toEqual({ expectedDigest: refreshed.expectedDigest });
});
it('removes original actions on owner logout before dispatch or after the original response', async () => {
  let afterReply: (() => void) | null = null;
  const f = await fixture({
    view: 'company',
    originalReply: (path) => {
      if (path === originalsRoot) return originalData(originalAttempts.terminal.pending);
      afterReply?.();
      return originalData(originalAttempts.terminal.closed);
    },
  });
  f.setOwner(false);
  await f.originalClick('Check original helper');
  expect(f.writes()).toEqual([]);
  expect(f.originalButton('Check original helper')).toBeUndefined();
  expect(f.originals().textContent).not.toContain(originalRow().sessionId);
  f.setOwner(true);
  await f.originalClick('Refresh original requests');
  afterReply = () => f.setOwner(false);
  await f.originalClick('Check original helper');
  expect(f.writes()).toHaveLength(1);
  expect(f.originalButton('Check original helper')).toBeUndefined();
  expect(f.originals().textContent).not.toContain(originalRow().sessionId);
});
it('rejects changed immutable scope on exact GET and never substitutes the current binding', async () => {
  for (const field of [
    'cursorId',
    'employeeId',
    'sessionId',
    'sessionGeneration',
    'operationId',
    'containerId',
    'revision',
  ]) {
    const row = originalRow(),
      changed = {
        ...row,
        [field]:
          field === 'sessionGeneration' ? 10 : ['cursorId', 'containerId'].includes(field) ? 'f'.repeat(64) : revision,
      };
    const f = await fixture({
      view: 'company',
      originalReply: (path, request) => {
        if (path === originalsRoot) return originalData(originalAttempts.terminal.pending);
        if (request?.method === 'POST') return originalData({ ...changed, state: 'closed', allowedActions: [] });
        return originalData(changed);
      },
    });
    await f.originalClick('Check original helper');
    await f.originalClick('Check original request status');
    expect(f.originals().textContent).toContain('original request scope changed');
    expect(f.originals().textContent).toContain('reply is unconfirmed');
    expect(f.originalButton('Check original helper')).toBeUndefined();
    expect(f.writes()).toHaveLength(1);
  }
});
it('rejects malformed original inventory or unsafe actions without sending a mutation', async () => {
  const row = originalRow(),
    list = originalAttempts.terminal.pending;
  for (const malformed of [
    { ...list, items: [{ ...row, allowedActions: ['retire'] }] },
    { ...list, items: [{ ...row, allowedActions: ['reconcile', 'apply'] }] },
    { ...list, items: [{ ...row, state: 'closed', allowedActions: ['reconcile'] }] },
    { ...list, items: [{ ...row, sessionGeneration: 0 }] },
    { ...list, items: [{ ...row, helperContainerId: 'short' }] },
    { ...list, items: [{ ...row, enforcement: 'fresh-native-readback' }] },
    { ...list, items: [{ ...row, name: 'Invented current owner' }] },
    { ...list, items: [row, row] },
    { ...list, items: Array.from({ length: 65 }, () => row) },
    { ...list, next: '../bad' },
  ]) {
    const f = await fixture({ view: 'company', originalReply: () => originalData(malformed) });
    expect(f.originals().textContent).toContain('could not be verified');
    expect(f.originalButton('Check original helper')).toBeUndefined();
    expect(f.originalButton('Retire unstarted request')).toBeUndefined();
    expect(f.writes()).toEqual([]);
  }
});
it('pages original requests only through explicit GET and retains an exact settled request', async () => {
  const first = originalRow(),
    second = { ...first, cursorId: 'e'.repeat(64) };
  const f = await fixture({
    view: 'company',
    originalReply: (path) => {
      if (path === originalsRoot)
        return originalData({ items: [first], next: first.cursorId, enforcement: 'not-observed' });
      if (path === `${originalsRoot}?after=${first.cursorId}`)
        return originalData({ items: [second], next: null, enforcement: 'not-observed' });
      return originalData({ ...originalAttempts.terminal.closed, cursorId: second.cursorId });
    },
  });
  expect(f.calls.filter((call) => call.path.startsWith(originalsRoot))).toHaveLength(1);
  await f.originalClick('Next original requests');
  expect(f.originals().querySelector('details')!.textContent).toContain(second.cursorId);
  expect(f.originalButton('First original requests')).toBeDefined();
  await f.originalClick('Check original request status');
  expect(f.originals().textContent).toContain('original helper is closed');
  await f.originalClick('First original requests');
  expect(f.originals().querySelector('details')!.textContent).toContain(first.cursorId);
  expect(f.writes()).toEqual([]);
});

it('opens original request details and retires only the explicitly offered preSTART request', async () => {
  const record = originalAttempts.created,
    row = record.pending.items[0];
  const f = await fixture({
    view: 'company',
    originalReply: (path) => originalData(path === originalsRoot ? record.pending : record.retired),
  });
  const recovery = f.originals().parentElement as HTMLDetailsElement;
  expect(recovery.open).toBe(false);
  (recovery.querySelector(':scope > summary') as HTMLElement).click();
  expect(recovery.open).toBe(true);
  const details = f.originals().querySelector('details')!;
  expect(details.open).toBe(false);
  details.querySelector('summary')!.click();
  expect(details.open).toBe(true);
  expect(details.textContent).toContain(row.containerId);
  expect(f.writes()).toEqual([]);
  await f.originalClick('Retire unstarted request');
  expect(f.writes()).toEqual([
    { path: `${originalsRoot}/${row.cursorId}/retire`, method: 'POST', body: { expectedDigest: row.expectedDigest } },
  ]);
  expect(f.originals().textContent).toContain('does not confirm that a running container was stopped');
  expect(f.originalButton('Retire unstarted request')).toBeUndefined();
});

it('does not retain another owner view after genuine inventory denial and a later empty inventory', async () => {
  let denied = false,
    empty = false;
  const f = await fixture({
    view: 'company',
    originalReply: (path, request) => {
      if (path === originalsRoot)
        return denied
          ? { ok: false, status: 403, error: { code: 'FORBIDDEN' } }
          : originalData(
              empty ? { items: [], next: null, enforcement: 'not-observed' } : originalAttempts.terminal.pending
            );
      if (request?.method === 'POST') throw Error('Lost original reply');
      return originalData(originalAttempts.terminal.closed);
    },
  });
  await f.originalClick('Check original helper');
  expect(f.originals().textContent).toContain('reply is unconfirmed');
  denied = true;
  await f.originalClick('Refresh original requests');
  expect(f.originals().textContent).not.toContain(originalRow().sessionId);
  denied = false;
  empty = true;
  await f.originalClick('Refresh original requests');
  expect(f.originals().textContent).toContain('No pending original resource requests');
  expect(f.originals().textContent).not.toContain(originalRow().sessionId);
  expect(f.writes()).toHaveLength(1);
});
