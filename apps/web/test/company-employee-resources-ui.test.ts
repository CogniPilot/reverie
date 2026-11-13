/** Real profile/Permissions DOM; native observations are closed read-only API fixtures. */
import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
import {
  EmployeeMemoryDiagnostics,
  memoryPressureAdvisory,
  type EmployeeResourceStatus,
} from '../src/resource-employee-data.js';

const employeeId = '11111111-2222-4333-8444-555555555555';
const cachedSid = '22222222-3333-4444-8555-666666666666';
const currentSid = '33333333-4444-4555-8666-777777777777';
const baseEndpoint = `/api/company/resources/employees/${employeeId}`;
const endpoint = baseEndpoint + '/memory-diagnostics';
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
async function setup(
  options: {
    reply?: () => Reply | Promise<Reply>;
    edit?: (body: Record<string, unknown>) => Reply | Promise<Reply>;
    verified?: boolean;
    memory?: () => Reply | Promise<Reply>;
  } = {}
) {
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
    if (path === endpoint) {
      if (options.memory) return options.memory();
      const reply = options.reply ? await options.reply() : { ok: true, data: running() };
      return reply.ok
        ? {
            ...reply,
            data: {
              version: 1,
              employeeId,
              sessionId: currentSid,
              sessionGeneration: '2',
              source: 'independent-status-read',
              resources: reply.data,
              diagnostics: { kind: 'unavailable', reason: 'native-observation-unconfirmed' },
            },
          }
        : reply;
    }
    if (path === baseEndpoint + '/policy' && options.edit) return options.edit(request.body);
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
    'unexpected hard memory edit capability',
    (data: any) => {
      data.capabilities.hardMemoryReplacement = true;
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

const editable = () => {
  const value = running();
  value.capabilities.softMemoryLive = true;
  value.capabilities.cpuWeightLive = true;
  return value;
};

it('leaves the summary read-only if only one live capability is present', async () => {
  const value = editable();
  value.capabilities.cpuWeightLive = false;
  const { panel, noEffects } = await setup({ reply: () => ({ ok: true, data: value }) });
  expect(cells(panel()!, 'Soft RAM')).toEqual(['8 GiB', '4 GiB']);
  expect(panel()!.querySelector('form')).toBeNull();
  noEffects();
});

it('dispatches a single edit from fresh native status and refreshes the verified table after correlated success', async () => {
  let current = editable();
  let release!: (reply: Reply) => void;
  const { h, panel, resourceCalls } = await setup({
    reply: () => ({ ok: true, data: current }),
    edit: () =>
      new Promise<Reply>((resolve) => {
        release = resolve;
      }),
  });
  const form = panel()!.querySelector('form')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  form.querySelector<HTMLInputElement>('[name="memoryHighMiB"]')!.value = '12288';
  form.querySelector<HTMLInputElement>('[name="cpuWeight"]')!.value = '180';
  expect(submit.textContent).toBe('Apply RAM and CPU limits');
  submit.click();
  submit.click();
  await h.flush();
  expect(resourceCalls().map(({ method }) => method)).toEqual(['GET', 'POST']);
  expect(panel()!.querySelector('form input')?.hasAttribute('disabled')).toBe(true);
  const body = resourceCalls()[1].body as Record<string, unknown>;
  expect(body).toEqual({
    sessionId: currentSid,
    operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    expectedRevision: 'a'.repeat(64),
    memoryHighMiB: 12288,
    cpuWeight: 180,
  });
  current = editable();
  current.revision = 'f'.repeat(64);
  current.requested!.memoryHighMiB = 12288;
  current.requested!.cpuWeight = 180;
  current.observed!.memoryHighBytes = String(12288 * 1048576);
  current.observed!.cpuWeight = 180;
  release({
    ok: true,
    data: {
      version: 1,
      employeeId,
      sessionId: body.sessionId,
      operationId: body.operationId,
      state: 'applied',
      memoryHighMiB: body.memoryHighMiB,
      cpuWeight: body.cpuWeight,
    },
  });
  await h.flush();
  expect(resourceCalls().map(({ method }) => method)).toEqual(['GET', 'POST', 'GET']);
  expect(cells(panel()!, 'Soft RAM')).toEqual(['12 GiB', '12 GiB']);
  expect(cells(panel()!, 'CPU share weight')).toEqual(['180', '180']);
  expect(panel()!.querySelector('[role="status"]')?.textContent).toContain('Change applied. Running limits verified');
});

it('submits a v4 edit ID using secure random bytes when randomUUID is unavailable', async () => {
  const { h, panel, resourceCalls } = await setup({
    reply: () => ({ ok: true, data: editable() }),
    edit: () => ({ ok: false, status: 503, error: 'Controlled unconfirmed result' }),
  });
  const crypto = h.dom.window.crypto;
  Object.defineProperty(crypto, 'randomUUID', { value: undefined });
  let draws = 0;
  Object.defineProperty(crypto, 'getRandomValues', {
    value: (bytes: Uint8Array) => {
      draws++;
      expect(bytes).toHaveLength(16);
      return bytes.fill(0xff);
    },
  });
  panel()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await h.flush();
  expect(draws).toBe(1);
  expect(resourceCalls().map(({ method }) => method)).toEqual(['GET', 'POST']);
  expect(resourceCalls()[1].body).toMatchObject({ operationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
});

it('keeps a visible unconfirmed error and never resends an edit', async () => {
  const error = 'The RAM and CPU change was not confirmed.';
  const { h, panel, resourceCalls, refresh } = await setup({
    reply: () => ({ ok: true, data: editable() }),
    edit: () => ({ ok: false, status: 503, error }),
  });
  panel()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await h.flush();
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe(error);
  expect(panel()!.querySelector('form input')?.hasAttribute('disabled')).toBe(true);
  expect(cells(panel()!, 'Soft RAM')).toEqual(['8 GiB', '4 GiB']);
  expect(resourceCalls().map(({ method }) => method)).toEqual(['GET', 'POST']);
  refresh().click();
  await h.flush();
  expect(resourceCalls().map(({ method }) => method)).toEqual(['GET', 'POST', 'GET']);
});

const memoryView = (resources = editable()) => {
  const observed = resources.observed!;
  const value = EmployeeMemoryDiagnostics.parse({
    version: 1,
    purpose: 'employee-memory-diagnostics-v1',
    employeeId,
    sessionId: currentSid,
    sessionGeneration: '2',
    state: 'observed',
    resources,
    readOnly: true,
    observation: {
      binding: {
        containerId: observed.containerId,
        initPid: observed.pid,
        initProcessStart: observed.processStart,
        leafDevice: observed.leafDevice,
        leafInode: observed.leafInode,
      },
      sampledAtEpochMs: Date.now() - 3000,
      sampleDurationUs: '123',
      pressure: {
        state: 'available',
        some: { avg10Hundredths: 1234, avg60Hundredths: 200, avg300Hundredths: 0, totalUs: '9007199254740993' },
        full: { avg10Hundredths: 0, avg60Hundredths: 1, avg300Hundredths: 0, totalUs: '1' },
      },
      events: { state: 'unavailable', reason: 'malformed' },
    },
  });
  return {
    version: 1,
    employeeId,
    sessionId: currentSid,
    sessionGeneration: '2',
    source: 'native-compound',
    resources: value.resources,
    diagnostics: { kind: 'snapshot', value },
  };
};
it('keeps raw pressure details collapsed until requested and preserves the disclosure across a status refresh', async () => {
  const { h, panel, refresh, noEffects } = await setup({ memory: () => ({ ok: true, data: memoryView() }) });
  const details = () => panel()!.querySelector<HTMLDetailsElement>('details.ca-memory-details');
  expect(details()).not.toBeNull();
  expect(details()!.open).toBe(false);
  expect(details()!.querySelector('summary')?.textContent).toBe('Pressure details');
  expect(details()!.textContent).toContain('9007199254740993 microseconds');
  expect(panel()!.querySelector('[data-memory-advisory]')?.closest('details')).toBeNull();
  details()!.open = true;
  refresh().click();
  await h.flush();
  expect(details()!.open).toBe(true);
  expect(details()!.textContent).toContain('9007199254740993 microseconds');
  noEffects();
});
it('renders raw pressure and cumulative sample facts without disabling verified policy controls', async () => {
  const { panel, noEffects } = await setup({ memory: () => ({ ok: true, data: memoryView() }) });
  expect(panel()!.textContent).toContain('12.34%');
  expect(panel()!.textContent).toContain('9007199254740993 microseconds');
  expect(panel()!.textContent).toContain('Unavailable (malformed)');
  expect(panel()!.textContent).toContain('seconds old when checked');
  expect(panel()!.textContent).toContain('does not identify a recent incident');
  expect(panel()!.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
  noEffects();
});
it('renders the server high-stall advisory accessibly with its sample time and no recovery effects', async () => {
  const value = memoryView();
  const sample = value.diagnostics.value.observation!;
  if (sample.pressure.state !== 'available') throw Error('Expected available fixture pressure');
  sample.pressure.some.avg10Hundredths = 9400;
  const data = { ...value, advisory: memoryPressureAdvisory(value.diagnostics.value, Date.now()) };
  const { panel, noEffects } = await setup({ memory: () => ({ ok: true, data }) });
  const warning = panel()!.querySelector('[role="alert"][data-memory-advisory]');
  expect(warning).not.toBeNull();
  expect(warning!.closest('details')).toBeNull();
  expect(warning!.textContent).toContain('High memory stalls were observed');
  expect(panel()!.textContent).toContain(new Date(sample.sampledAtEpochMs).toISOString());
  expect(panel()!.querySelector('.ca-memory-sample-time')?.closest('details')).toBeNull();
  expect(warning!.textContent).toContain('inspect current jobs');
  noEffects();
});
it.each(['legacy', 'unknown', 'different-sample', 'unknown-code', 'not-observed'] as const)(
  'keeps %s advisory responses truthful without inferring browser-only severity or disabling resource controls',
  async (mode) => {
    const value = memoryView();
    const sample = value.diagnostics.value.observation!;
    const warning = {
      state: 'warning',
      code: 'high-memory-stall',
      sampledAtEpochMs: sample.sampledAtEpochMs,
      evaluatedAtEpochMs: Date.now(),
    };
    const advisory =
      mode === 'legacy'
        ? undefined
        : mode === 'unknown'
          ? { ...warning, state: 'unknown', reason: 'stale-sample' }
          : mode === 'different-sample'
            ? { ...warning, sampledAtEpochMs: sample.sampledAtEpochMs - 1000 }
            : mode === 'unknown-code'
              ? { ...warning, code: 'restart-provider' }
              : memoryPressureAdvisory(value.diagnostics.value, Date.now());
    const { panel, noEffects } = await setup({ memory: () => ({ ok: true, data: { ...value, advisory } }) });
    expect(panel()!.querySelector('[role="alert"][data-memory-advisory]')).toBeNull();
    expect(panel()!.querySelector('[data-memory-advisory]')?.textContent).toContain(
      mode === 'unknown' ? 'unknown (stale-sample)' : mode === 'not-observed' ? 'not proof of health' : 'unavailable'
    );
    expect(panel()!.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
    noEffects();
  }
);
it('retains stale verified limits and unsaved policy fields after a whole-snapshot failure without replaying Apply', async () => {
  let failing = false;
  const { h, panel, refresh, resourceCalls } = await setup({
    memory: () =>
      failing ? { ok: false, status: 503, error: 'Observation unconfirmed' } : { ok: true, data: memoryView() },
  });
  const input = panel()!.querySelector<HTMLInputElement>('[name="memoryHighMiB"]')!;
  input.value = '12288';
  failing = true;
  refresh().click();
  await h.flush();
  expect(cells(panel()!, 'Soft RAM')).toEqual(['8 GiB', '4 GiB']);
  expect(input.value).toBe('12288');
  expect(input.disabled).toBe(true);
  expect(panel()!.textContent).toContain('stale and unconfirmed');
  panel()!
    .querySelector('form')!
    .dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush();
  expect(resourceCalls().every((row) => row.method === 'GET')).toBe(true);
});
it('rejects a generation-changed compound response while preserving earlier verified facts as stale', async () => {
  let moved = false;
  const { h, panel, refresh } = await setup({
    memory: () => ({ ok: true, data: { ...memoryView(), sessionGeneration: moved ? '3' : '2' } }),
  });
  moved = true;
  refresh().click();
  await h.flush();
  expect(panel()!.textContent).toContain('stale and unconfirmed');
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toContain('could not be verified');
});

it.each(['sessionId', 'sessionGeneration'] as const)(
  'shows a changed %s while an attached profile waits and never revives its original view from cache ABA',
  async (key) => {
    let release!: (reply: Reply) => void,
      waiting = false;
    const { h, panel, refresh, resourceCalls } = await setup({
      memory: () =>
        waiting
          ? new Promise<Reply>((resolve) => {
              release = resolve;
            })
          : { ok: true, data: memoryView() },
    });
    const draft = panel()!.querySelector<HTMLInputElement>('[name="memoryHighMiB"]')!;
    draft.value = '12288';
    waiting = true;
    refresh().click();
    await h.flush();
    const cached = h.shell.company.employees.find((row: { id: string }) => row.id === employeeId);
    const original = cached[key];
    cached[key] = key === 'sessionId' ? '44444444-5555-4666-8777-888888888888' : Number(original) + 1;
    const successor = memoryView();
    successor.resources.observed!.cpuWeight = 999;
    release({ ok: true, data: successor });
    await h.flush();
    expect(draft.value).toBe('12288');
    expect(cells(panel()!, 'CPU share weight')).toEqual(['100', '200']);
    expect(panel()!.textContent).toContain('Close and reopen this profile');
    expect(panel()!.textContent).toContain('stale and unconfirmed');
    expect(refresh().disabled).toBe(false);
    expect(panel()!.querySelector<HTMLInputElement>('[name="memoryHighMiB"]')!.disabled).toBe(true);
    cached[key] = original;
    waiting = false;
    refresh().click();
    await h.flush();
    expect(panel()!.textContent).toContain('Close and reopen this profile');
    expect(resourceCalls().every((row) => row.method === 'GET')).toBe(true);
  }
);

it('a valid contract-max timestamp stays an unavailable display clock without invalidating verified limits', async () => {
  const value = memoryView();
  value.diagnostics.value.observation!.sampledAtEpochMs = Number.MAX_SAFE_INTEGER;
  const { panel, noEffects } = await setup({ memory: () => ({ ok: true, data: value }) });
  expect(panel()!.textContent).toContain('Sample timestamp is outside this browser’s clock range');
  expect(panel()!.textContent).toContain('Sample age cannot be compared');
  expect(panel()!.textContent).toContain('Running limits verified');
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe('');
  expect(panel()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  noEffects();
});

it('renders available cumulative memory counters as exact text without turning missing group counts into zero', async () => {
  const value = memoryView();
  const sample = value.diagnostics.value.observation!;
  const complete = {
    ...value,
    diagnostics: {
      kind: 'snapshot',
      value: {
        ...value.diagnostics.value,
        observation: {
          ...sample,
          events: {
            state: 'available',
            low: '0',
            high: '9007199254740993',
            max: '0',
            oom: '0',
            oomKill: '0',
            oomGroupKill: null,
          },
        },
      },
    },
  };
  expect(EmployeeMemoryDiagnostics.safeParse(complete.diagnostics.value).success).toBe(true);
  const { panel, noEffects } = await setup({ memory: () => ({ ok: true, data: complete }) });
  expect(cells(panel()!, 'Soft-limit reclaim')).toEqual(['9007199254740993']);
  expect(cells(panel()!, 'OOM kills')).toEqual(['0']);
  expect(cells(panel()!, 'OOM group kills')).toEqual(['Not provided by this kernel']);
  expect(panel()!.textContent).toContain('Event counts are cumulative for this cgroup');
  expect(panel()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  noEffects();
});
