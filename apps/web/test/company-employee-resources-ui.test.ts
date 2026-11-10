/** Real profile/Permissions DOM; native observations are closed read-only API fixtures. */
import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
import type { EmployeeResourceStatus } from '../src/resource-employee-data.js';

const employeeId = '11111111-2222-4333-8444-555555555555';
const cachedSid = '22222222-3333-4444-8555-666666666666';
const currentSid = '33333333-4444-4555-8666-777777777777';
const endpoint = `/api/company/resources/employees/${employeeId}`;
const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
});
const running = (): EmployeeResourceStatus => ({
  version: 1,
  employeeId,
  sessionId: currentSid,
  revision: 'a'.repeat(64),
  state: 'running',
  requested: {
    memoryHighMiB: 8192,
    memoryMaxMiB: 49152,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    perfPolicy: 'task-v2',
  },
  observed: {
    containerId: 'b'.repeat(64),
    pid: 1234,
    processStart: '123456',
    leafDevice: '27',
    leafInode: '65537',
    memoryHighBytes: '4294967296',
    memoryMaxBytes: 'max',
    memoryCurrentBytes: '1610612736',
    memorySwapMaxBytes: '0',
    cpuWeight: 200,
    cpuMax: '25000 100000',
    allowedCpus: [0, 1],
  },
  perfObserved: null,
  perfObservationReason: 'OWN_PROCESS_PROBE_REQUIRED',
  capabilities: {
    softMemoryLive: false,
    cpuWeightLive: false,
    hardMemoryReplacement: false,
    perfReplacement: false,
    gpuReplacement: false,
  },
  readOnly: true,
});
type Reply = { ok: boolean; data?: unknown; status?: number; error?: string };
async function setup(options: { reply?: () => Reply | Promise<Reply>; verified?: boolean } = {}) {
  const employee = {
    id: employeeId,
    sessionId: cachedSid,
    sessionGeneration: 1,
    name: 'River',
    position: 'Engineer',
    expertise: ['Systems'],
    responsibilities: [],
    permissions: {},
    onVacation: false,
    desiredRunning: true,
  };
  const company = { canManage: true, settings: { ownerName: 'Owner' }, employees: [employee] };
  const h = await createHarness({ company });
  opened.push(h);
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let checkingProfile = false;
  h.app._chatApi = async (path: string, request?: any) => {
    calls.push({ path, method: request?.method ?? 'GET', body: request?.body });
    if (path === endpoint) return options.reply ? options.reply() : { ok: true, data: running() };
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status')
      return {
        ok: true,
        data: {
          self: checkingProfile && options.verified === false ? 'agent' : 'owner',
          canSetOwn: !checkingProfile || options.verified !== false,
        },
      };
    if (path.endsWith('/hiring-permission'))
      return { ok: true, data: { employeeId, sessionId: currentSid, enabled: false, source: 'none' } };
    if (path === '/api/publication/tokens') return { ok: true, data: { tokens: [] } };
    return { ok: false, status: 503, error: 'Unconfigured read-only fixture endpoint' };
  };
  await h.shell.openCompany('people');
  // The rendered row holds the old SID; the real profile's owner check must
  // refresh that employee before mounting its current native observation.
  employee.sessionId = currentSid;
  employee.sessionGeneration = 2;
  const edit = h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement;
  expect(edit).not.toBeNull();
  checkingProfile = true;
  edit.click();
  await h.flush();
  const dialog = h.document.querySelector('.ca-expert-profile') as HTMLDialogElement;
  expect(dialog).not.toBeNull();
  (dialog.querySelector('[data-profile-tab="permissions"]') as HTMLButtonElement).click();
  await h.flush();
  const panel = () => dialog.querySelector('.ca-employee-resources') as HTMLElement | null;
  const refresh = () => panel()!.querySelector('[aria-label="Refresh resource status for River"]') as HTMLButtonElement;
  const resourceCalls = () => calls.filter((call) => call.path.startsWith('/api/company/resources/'));
  const noEffects = () => {
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.some((call) => /wake|restart|replace|native-apply|\/apply/.test(call.path))).toBe(false);
    expect(resourceCalls().every((call) => call.path === endpoint && call.body === undefined)).toBe(true);
  };
  return { h, dialog, panel, refresh, resourceCalls, noEffects };
}
function cells(panel: HTMLElement, label: string): string[] {
  const row = [...panel.querySelectorAll('tbody tr')].find((row) => row.querySelector('th')?.textContent === label);
  expect(row, label).toBeDefined();
  return [...row!.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
}
it('mounts the actual profile Permissions panel for the current SID and separates requested from physical facts', async () => {
  const { dialog, panel, resourceCalls, noEffects } = await setup();
  expect(dialog.querySelector('[data-profile-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true');
  expect(panel()!.closest('[role="tabpanel"]')?.id).toBe('ca-employee-panel-permissions');
  expect(panel()!.getAttribute('aria-label')).toBe('RAM and CPU for River');
  expect(resourceCalls()).toEqual([{ path: endpoint, method: 'GET', body: undefined }]);
  expect(cells(panel()!, 'Soft RAM')).toEqual(['8 GiB', '4 GiB']);
  expect(cells(panel()!, 'Hard RAM ceiling')).toEqual(['48 GiB', 'Unbounded']);
  expect(cells(panel()!, 'RAM in use')).toEqual(['—', '1.5 GiB']);
  expect(cells(panel()!, 'CPU share weight')).toEqual(['100', '200']);
  expect(cells(panel()!, 'CPU quota')).toEqual(['—', '25000 100000']);
  expect(panel()!.querySelector('[role="status"]')?.textContent).toContain('Running limits verified');
  expect(panel()!.textContent).toContain('Actual profiling access requires a separate probe');
  expect(panel()!.querySelectorAll('input,select,textarea,form')).toHaveLength(0);
  expect([...panel()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    'Refresh resource status',
  ]);
  noEffects();
});
it('renders a physically unbounded CPU quota without treating CPU weight as a hard quota', async () => {
  const data = running();
  data.observed!.cpuMax = 'max 100000';
  const { panel, noEffects } = await setup({ reply: () => ({ ok: true, data }) });
  expect(cells(panel()!, 'CPU share weight')).toEqual(['100', '200']);
  expect(cells(panel()!, 'CPU quota')).toEqual(['—', 'No quota']);
  expect(panel()!.textContent).toContain('CPU weight shares CPU under contention');
  noEffects();
});
it.each(['absent', 'stopped', 'controller-unavailable', 'uninstalled'] as const)(
  'shows %s without fabricating physical values or a running verification',
  async (state) => {
    const data = running();
    data.state = state;
    data.observed = null;
    if (state === 'uninstalled') data.requested = null;
    const { panel, noEffects } = await setup({ reply: () => ({ ok: true, data }) });
    expect(panel()!.querySelector('[role="status"]')?.textContent).toContain(`Laptop ${state}`);
    for (const label of ['Soft RAM', 'Hard RAM ceiling', 'RAM in use', 'CPU share weight', 'CPU quota'])
      expect(cells(panel()!, label)[1]).toBe('Unconfirmed');
    expect(cells(panel()!, 'Soft RAM')[0]).toBe(state === 'uninstalled' ? 'Unavailable' : '8 GiB');
    expect(panel()!.textContent).not.toContain('Running limits verified');
    expect(panel()!.textContent).not.toContain('No quota');
    noEffects();
  }
);
it.each([
  [
    'old SID',
    (data: any) => {
      data.sessionId = cachedSid;
    },
  ],
  [
    'foreign employee',
    (data: any) => {
      data.employeeId = '44444444-5555-4666-8777-888888888888';
    },
  ],
  [
    'malformed physical memory',
    (data: any) => {
      data.observed.memoryHighBytes = 'not-a-number';
    },
  ],
  [
    'unexpected edit capability',
    (data: any) => {
      data.capabilities.softMemoryLive = true;
    },
  ],
] as const)('refuses %s data without presenting fabricated verification or controls', async (_label, mutate) => {
  const data = running();
  mutate(data);
  const { panel, noEffects } = await setup({ reply: () => ({ ok: true, data }) });
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toContain('could not be verified');
  expect(panel()!.querySelector('[role="status"]')?.textContent).toBe('Running limits are unconfirmed.');
  expect(panel()!.querySelector('table')).toBeNull();
  noEffects();
});
it('offers one safe GET refresh after HTTP failure and prevents concurrent refresh dispatch', async () => {
  let resourceCallsCount = 0;
  let answer: Reply = { ok: false, status: 503, error: 'Current native observation unavailable' };
  let release: ((reply: Reply) => void) | undefined;
  const { h, panel, refresh, resourceCalls, noEffects } = await setup({
    reply: () =>
      resourceCallsCount++ === 0
        ? answer
        : new Promise<Reply>((resolve) => {
            release = resolve;
          }),
  });
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe(answer.error);
  expect(panel()!.querySelector('table')).toBeNull();
  expect(refresh().disabled).toBe(false);
  refresh().click();
  refresh().click();
  await h.flush();
  expect(resourceCalls()).toHaveLength(2);
  expect(refresh().disabled).toBe(true);
  answer = { ok: true, data: running() };
  release!(answer);
  await h.flush();
  expect(refresh().disabled).toBe(false);
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe('');
  expect(cells(panel()!, 'Soft RAM')).toEqual(['8 GiB', '4 GiB']);
  noEffects();
});
it('ignores an in-flight observation after the profile dialog closes', async () => {
  let release!: (reply: Reply) => void;
  const { h, dialog, panel, resourceCalls, noEffects } = await setup({
    reply: () =>
      new Promise<Reply>((resolve) => {
        release = resolve;
      }),
  });
  const retainedPanel = panel()!;
  expect(retainedPanel.querySelector('[role="status"]')?.textContent).toBe('Checking running limits…');
  dialog.close();
  expect(dialog.isConnected).toBe(false);
  release({ ok: true, data: running() });
  await h.flush();
  expect(retainedPanel.querySelector('table')).toBeNull();
  expect(retainedPanel.querySelector('[role="status"]')?.textContent).toBe('Checking running limits…');
  expect(h.document.querySelector('.ca-employee-resources')).toBeNull();
  expect(resourceCalls()).toHaveLength(1);
  noEffects();
});
it('does not mount or fetch native status when owner authorization changes before the profile permission check', async () => {
  const { panel, resourceCalls, noEffects } = await setup({ verified: false });
  expect(panel()).toBeNull();
  expect(resourceCalls()).toEqual([]);
  noEffects();
});
