/** Actual profile/company DOM; responses represent API decisions, never runtime authority. */
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
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
    approved?: boolean;
    owner?: boolean;
    action?: string[];
    reply?: (path: string, body: unknown) => unknown | Promise<unknown>;
    malformed?: boolean;
    readFailure?: string;
  } = {}
) {
  const employee = {
    id: eid,
    sessionId: sid,
    sessionGeneration: 9,
    name: 'River',
    position: 'Engineer',
    permissions: EmployeePermissionsSchema.parse({}),
    onVacation: false,
    desiredRunning: true,
    effectiveBoardPermissions: {},
    boardPermissionSources: {},
  };
  const company = { canManage: true, boxedRuntime: true, settings: { ownerName: 'Owner' }, employees: [employee] };
  const h = await createHarness({ company });
  handles.push(h);
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let approved = options.approved !== false,
    owner = options.owner !== false;
  let actual = 16 * 1024 ** 3,
    allowed = options.action ?? ['apply'];
  let currentRevision = revision;
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, request?: { method?: string; body?: unknown }) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status')
      return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (
      path.startsWith('/api/company/docker-resources') ||
      path.startsWith(base + '/docker-resources') ||
      path.startsWith(base + '/docker-pool')
    ) {
      const method = request?.method ?? 'GET';
      calls.push({ path, method, body: structuredClone(request?.body) });
      if (method !== 'GET' && options.reply) return options.reply(path, request?.body);
      if (path === '/api/company/docker-resources')
        return {
          ok: true,
          data: {
            allowedActions: ['approve-default'],
            desired: approved
              ? { revision: currentRevision, scope: 'all-current-and-future', memoryHighBytes: high }
              : null,
            employees: [
              {
                employeeId: eid,
                sessionId: sid,
                sessionGeneration: 9,
                state: 'not-observed',
                allowedActions: allowed,
                enforcement: 'not-observed',
              },
            ],
          },
        };
      if (path === base + '/docker-resources' && options.readFailure)
        return { ok: false, error: { code: options.readFailure } };
      if (path === base + '/docker-resources')
        return {
          ok: true,
          data: {
            employeeId: eid,
            sessionId: sid,
            sessionGeneration: options.malformed ? 8 : 9,
            revision: approved ? currentRevision : null,
            desiredMemoryHighBytes: approved ? high : null,
            actualMemoryHighBytes: actual,
            memoryMaxBytes: 64 * 1024 ** 3,
            approved: true,
            approvalSource: 'original-policy',
            approvedRevision: null,
            enforcement: 'fresh-native-readback',
            allowedActions: allowed,
          },
        };
      if (path === base + '/docker-pool/status')
        return {
          ok: true,
          data: {
            sessionId: sid,
            sessionGeneration: 9,
            state: 'reconciliation-required',
            allowedActions: ['reconcile-pool'],
            scopeDigest: 'a'.repeat(64),
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
  return {
    h,
    company,
    employee,
    panel,
    button,
    writes,
    calls,
    click,
    setOwner: (v: boolean) => {
      owner = v;
    },
    setActual: (v: number) => {
      actual = v;
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
  const employee = await fixture({ action: ['new-revision'] });
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
      f.setAllowed(['new-revision']);
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
