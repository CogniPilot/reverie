import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EmployeeDiskBudgetService,
  measureDirBytes,
  resolveMeasurableCaseDir,
  type DiskBudgetEmployee,
  type DiskBudgetNoticeTarget,
} from '../src/employee-disk-budget-service.js';
import { DISK_BUDGET_NOTICE_INTERVAL_MS } from '../src/employee-disk-budget.js';
import { registerEmployeeDiskBudgetRoutes } from '../src/web/routes/employee-disk-budget-routes.js';

const GIB = 1024 ** 3;
const HALF_HOUR = 30 * 60 * 1000;

class FakeSession implements DiskBudgetNoticeTarget {
  pid: number | null = 4242;
  isWorking = false;
  providerDispatchHeld = false;
  terminalInputHeld = false;
  paneDialog: string | null = null;
  accepts = true;
  fail = false;
  writes: { text: string; options: object }[] = [];
  async writeViaMux(text: string, options: { opencodeGuard: boolean; requireEmptyComposer: boolean }) {
    if (this.fail) throw new Error('pane gone');
    if (!this.accepts) return false;
    this.writes.push({ text, options });
    return true;
  }
}

function harness(overrides: Partial<DiskBudgetEmployee> = {}) {
  const ada: DiskBudgetEmployee = {
    id: 'ada',
    name: 'Ada',
    sessionId: 's-ada',
    onVacation: false,
    desiredRunning: true,
    ...overrides,
  };
  const state = {
    now: 1_000_000_000,
    employees: [ada],
    used: new Map<string, number | null>([['/cases/expert-ada', 37.2 * GIB]]),
    dirs: new Map<string, string>([['s-ada', '/cases/expert-ada']]),
    sessions: new Map<string, FakeSession>([['s-ada', new FakeSession()]]),
    measured: [] as string[],
    warnings: [] as string[],
  };
  const service = new EmployeeDiskBudgetService({
    employees: () => state.employees,
    workingDir: (id) => state.dirs.get(id),
    session: (id) => state.sessions.get(id),
    measure: async (dir) => {
      state.measured.push(dir);
      return state.used.get(dir) ?? null;
    },
    now: () => state.now,
    warn: (text) => state.warnings.push(text),
  });
  const cycle = async (advance = HALF_HOUR) => {
    state.now += advance;
    await service.runOnce();
  };
  return {
    state,
    service,
    cycle,
    session: state.sessions.get('s-ada')!,
    row: () => service.view(state.employees).employees[0],
  };
}

describe('employee disk budget service', () => {
  it('tells an idle employee over budget once, as a submitted single-line prompt', async () => {
    const { session, cycle, row, state } = harness();
    await cycle();
    expect(session.writes).toHaveLength(1);
    expect(session.writes[0].text).toMatch(
      /^Disk budget notice from the office: .*37\.2 GiB of your 20 GiB budget.*\r$/
    );
    expect(session.writes[0].text.slice(0, -1)).not.toMatch(/[\r\n]/);
    expect(session.writes[0].options).toEqual({ opencodeGuard: true, requireEmptyComposer: true });
    expect(row()).toEqual({
      id: 'ada',
      name: 'Ada',
      usedBytes: 37.2 * GIB,
      measuredAt: state.now,
      state: 'over',
      lastNotifiedAt: state.now,
    });
  });

  it('sends nothing more within six hours, then repeats while still over', async () => {
    const { session, cycle } = harness();
    await cycle();
    await cycle();
    expect(session.writes).toHaveLength(1);
    await cycle(DISK_BUDGET_NOTICE_INTERVAL_MS);
    expect(session.writes).toHaveLength(2);
  });

  it('sends a fresh notice when the folder newly crosses over again', async () => {
    const { session, cycle, state, row } = harness();
    await cycle();
    state.used.set('/cases/expert-ada', GIB);
    await cycle();
    expect(row().state).toBe('ok');
    state.used.set('/cases/expert-ada', 21 * GIB);
    await cycle();
    expect(session.writes).toHaveLength(2);
  });

  it.each([
    ['working', (s: FakeSession) => ((s.isWorking = true), () => (s.isWorking = false))],
    [
      'provider dispatch held',
      (s: FakeSession) => ((s.providerDispatchHeld = true), () => (s.providerDispatchHeld = false)),
    ],
    ['terminal input held', (s: FakeSession) => ((s.terminalInputHeld = true), () => (s.terminalInputHeld = false))],
    ['showing a dialog', (s: FakeSession) => ((s.paneDialog = 'Allow?'), () => (s.paneDialog = null))],
    ['without a pid', (s: FakeSession) => ((s.pid = null), () => (s.pid = 4242))],
    ['refusing the write', (s: FakeSession) => ((s.accepts = false), () => (s.accepts = true))],
  ])('skips a session that is %s and retries on the next cycle', async (_name, block) => {
    const { session, cycle, row } = harness();
    const release = block(session);
    await cycle();
    expect(session.writes).toHaveLength(0);
    expect(row()).toMatchObject({ state: 'over', lastNotifiedAt: null });
    release();
    await cycle();
    expect(session.writes).toHaveLength(1);
  });

  it('retries when the session is not running here', async () => {
    const { state, cycle, row } = harness();
    const session = state.sessions.get('s-ada')!;
    state.sessions.delete('s-ada');
    await cycle();
    expect(row()).toMatchObject({ state: 'over', lastNotifiedAt: null });
    state.sessions.set('s-ada', session);
    await cycle();
    expect(session.writes).toHaveLength(1);
  });

  it.each([
    ['on vacation', { onVacation: true }],
    ['not desired running', { desiredRunning: false }],
  ])('measures but never notifies an employee %s', async (_name, overrides) => {
    const { session, cycle, row } = harness(overrides);
    await cycle();
    await cycle(DISK_BUDGET_NOTICE_INTERVAL_MS);
    expect(session.writes).toHaveLength(0);
    expect(row()).toMatchObject({ state: 'over', lastNotifiedAt: null });
  });

  it('reports unknown and sends nothing when the folder cannot be measured', async () => {
    const { session, cycle, row, state } = harness();
    state.used.set('/cases/expert-ada', null);
    await cycle();
    expect(row()).toMatchObject({ usedBytes: null, state: 'unknown', lastNotifiedAt: null });
    state.dirs.delete('s-ada');
    await cycle();
    expect(row()).toMatchObject({ usedBytes: null, state: 'unknown' });
    expect(session.writes).toHaveLength(0);
  });

  it('survives a throwing measurer and a throwing delivery, logging each once', async () => {
    const { session, cycle, row, state } = harness();
    session.fail = true;
    await cycle();
    await cycle();
    expect(row()).toMatchObject({ state: 'over', lastNotifiedAt: null });
    expect(state.warnings).toHaveLength(1);
    const broken = new EmployeeDiskBudgetService({
      employees: () => state.employees,
      workingDir: () => '/cases/expert-ada',
      session: () => session,
      measure: async () => {
        throw new Error('du exploded');
      },
      warn: (text) => state.warnings.push(text),
    });
    await broken.runOnce();
    await broken.runOnce();
    expect(broken.view(state.employees).employees[0].state).toBe('unknown');
    expect(state.warnings).toHaveLength(2);
  });

  it('never overlaps runs and measures one folder at a time', async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const gates: (() => void)[] = [];
    const employees = ['a', 'b'].map((id) => ({ id, name: id, sessionId: id, onVacation: false }));
    const service = new EmployeeDiskBudgetService({
      employees: () => employees,
      workingDir: (id) => `/cases/${id}`,
      session: () => undefined,
      measure: async () => {
        calls++;
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active--;
        return 1;
      },
    });
    const first = service.runOnce();
    const second = service.runOnce();
    expect(second).toBe(first);
    let done = false;
    void first.then(() => (done = true));
    while (!done) {
      gates.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(calls).toBe(2);
    expect(peak).toBe(1);
    expect(service.view(employees).employees.map((row) => row.state)).toEqual(['ok', 'ok']);
  });

  it('measures a folder shared by two employees once per cycle and forgets removed employees', async () => {
    const { state, service, cycle } = harness();
    state.employees.push({ id: 'bob', name: 'Bob', sessionId: 's-bob', onVacation: false });
    state.dirs.set('s-bob', '/cases/expert-ada');
    await cycle();
    expect(state.measured).toEqual(['/cases/expert-ada']);
    const bob = state.employees.pop()!;
    await cycle();
    expect(service.view([bob]).employees[0]).toMatchObject({ state: 'unknown', measuredAt: null });
  });

  it('does not run after stop', async () => {
    const { service, state } = harness();
    service.start();
    service.stop();
    await service.runOnce();
    expect(state.measured).toEqual([]);
  });
});

describe('case folder measurement', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'disk-budget-'));
    await mkdir(join(root, 'cases', 'expert-ada'), { recursive: true });
    await mkdir(join(root, 'outside'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts only a real directory strictly under the cases dir', async () => {
    const cases = join(root, 'cases');
    expect(await resolveMeasurableCaseDir(join(cases, 'expert-ada'), cases)).toBe(join(cases, 'expert-ada'));
    expect(await resolveMeasurableCaseDir(cases, cases)).toBeNull();
    expect(await resolveMeasurableCaseDir(join(root, 'outside'), cases)).toBeNull();
    expect(await resolveMeasurableCaseDir(join(cases, '..', 'outside'), cases)).toBeNull();
    expect(await resolveMeasurableCaseDir(join(cases, 'missing'), cases)).toBeNull();
    await writeFile(join(cases, 'a-file'), 'x');
    expect(await resolveMeasurableCaseDir(join(cases, 'a-file'), cases)).toBeNull();
    await symlink(join(root, 'outside'), join(cases, 'linked'));
    expect(await resolveMeasurableCaseDir(join(cases, 'linked'), cases)).toBeNull();
    await mkdir(join(root, 'outside', 'nested'));
    expect(await resolveMeasurableCaseDir(join(cases, 'linked', 'nested'), cases)).toBeNull();
  });

  it('measures a directory with du and reports null once aborted', async () => {
    const dir = join(root, 'cases', 'expert-ada');
    await writeFile(join(dir, 'blob'), Buffer.alloc(256 * 1024, 1));
    const used = await measureDirBytes(dir, new AbortController().signal);
    expect(used).toBeGreaterThanOrEqual(256 * 1024);
    expect(used! % 1024).toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    expect(await measureDirBytes(dir, aborted.signal)).toBeNull();
  });
});

describe('GET /api/company/disk-budget', () => {
  const employees = [{ id: 'ada', name: 'Ada' }];
  const budget = {
    view: (rows: typeof employees) => ({
      budgetBytes: 20 * GIB,
      employees: rows.map((row) => ({
        ...row,
        usedBytes: null,
        measuredAt: null,
        state: 'unknown' as const,
        lastNotifiedAt: null,
      })),
    }),
  };
  const company = { view: () => ({ employees }) } as never;

  it('refuses anyone but the verified owner', async () => {
    const app = Fastify();
    registerEmployeeDiskBudgetRoutes(app, company, budget);
    const response = await app.inject({ method: 'GET', url: '/api/company/disk-budget' });
    expect(response.statusCode).toBe(403);
    expect(response.json().success).toBe(false);
    await app.close();
  });

  it("returns the owner's employees and the budget", async () => {
    const app = Fastify();
    registerEmployeeDiskBudgetRoutes(app, company, budget, () => true);
    const response = await app.inject({ method: 'GET', url: '/api/company/disk-budget' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        budgetBytes: 20 * GIB,
        employees: [
          { id: 'ada', name: 'Ada', usedBytes: null, measuredAt: null, state: 'unknown', lastNotifiedAt: null },
        ],
      },
    });
    await app.close();
  });
});
