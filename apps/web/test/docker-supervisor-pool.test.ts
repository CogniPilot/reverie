/**
 * The office supervisor's office-level laptop steps against fakes of the services they call: the shared pool
 * after a host restart (`keepPool`), and the stored home of a stopped laptop (`storedHome`).
 */
import { describe, expect, it } from 'vitest';
import { CompanyError } from '../src/company-service.js';
import {
  DockerEmployeeContinuationError,
  type DockerContinuationAuthority,
} from '../src/docker-employee-continuation.js';
import { DockerSupervisorLaptops, type DockerSupervisorLaptopDeps } from '../src/docker-employee-supervisor-laptops.js';
import type { DockerStoppedStorage } from '../src/docker-employee-engine.js';
import type { SupervisedEmployee, SupervisorPoolGuard } from '../src/employee-supervisor.js';

const employee = (digit: string, patch: Partial<SupervisedEmployee> = {}): SupervisedEmployee => ({
  id: `${digit.repeat(8)}-1111-4111-8111-111111111111`,
  name: 'E' + digit,
  owner: undefined,
  sessionId: `${digit.repeat(8)}-2222-4222-8222-222222222222`,
  sessionGeneration: 3,
  desiredRunning: true,
  onVacation: false,
  bindingMigration: false,
  ...patch,
});
const A = employee('a'),
  B = employee('b'),
  C = employee('c');
const refuse = (code: string) => new DockerEmployeeContinuationError(code);
const SCOPE = '6'.repeat(64);

type Status = { state: string; code?: string; scopeDigest?: string; allowedActions: string[] };
function world() {
  const state = {
    current: true,
    /** Which of the two switches the supervisor's guard still allows. */
    retry: true,
    repair: true,
    /** Employees who have a laptop record. */
    records: new Set([A.id, B.id, C.id]),
    /** The anchor of the pool. */
    anchor: 'stopped' as 'stopped' | 'running',
    /** A laptop of the box is running. */
    laptopRunning: false,
    /** The cold recovery that was issued and did not finish, when there is one. */
    held: undefined as
      | { employeeId: string; sessionId: string; sessionGeneration: number; operationId: string }
      | undefined,
    /** Overrides, call by call. */
    status: undefined as ((id: string) => Status | Error) | undefined,
    preview: undefined as ((id: string) => Error | undefined) | undefined,
    recover: undefined as ((id: string) => Status | Error) | undefined,
    resume: undefined as ((id: string) => Status | Error) | undefined,
    stopped: { state: 'verified' } as DockerStoppedStorage | Error,
    remembered: [] as string[],
    /** What the configured verifier image can do, and what one attempt to record a home answers. */
    capability: 'none' as 'none' | 'full' | 'compare-only' | 'image-missing' | 'unknown',
    remember: (() => 'recorded') as () => 'recorded' | 'not-running' | 'not-recorded',
    /** The laptop record version of each employee; 3 is a laptop a plan move made. */
    versions: new Map<string, number>(),
    limits: 'unchanged' as 'unchanged' | 'restored' | Error,
    calls: [] as Array<[string, string, unknown?]>,
    tiers: [] as Array<[string, 'retry' | 'repair']>,
  };
  const session = (id: string) => [A, B, C].find((row) => row.id === id)!;
  const answer = (id: string): Status => ({
    ...(state.held
      ? { state: 'held', code: 'DOCKER_POOL_COLD_ATTEMPT_HELD', allowedActions: [] }
      : state.anchor === 'running'
        ? { state: 'retained', allowedActions: [] }
        : { state: 'held', code: 'DOCKER_POOL_ANCHOR_UNCONFIRMED', allowedActions: [] }),
    ...{ sessionId: session(id).sessionId, sessionGeneration: 3 },
  });
  const took = (name: string, id: string, authority: DockerContinuationAuthority, argument?: unknown) => {
    state.calls.push([name, id, argument]);
    authority.require();
    authority.requireOffice();
  };
  const give = <T>(value: T | Error): T => {
    if (value instanceof Error) throw value;
    return value;
  };
  const deps = {
    company: {
      recoveryAction: () => ({ current: () => true, require: () => {} }),
      store: {
        snapshot: () => ({
          employees: [],
          // The layout of each employee's most recent laptop operation, as a rebuild reuses it.
          retiredDockerEmployeeContinuations: [A, B, C].map((row) => ({
            employeeId: row.id,
            operationId: 'retired-' + row.id,
            sessionId: row.sessionId,
            sessionGeneration: 3,
            scopeDigest: SCOPE,
            template: { user: '1000:1000', scratchRoot: '/host/scratch/laptops', mounts: [] },
            source: { phase: 'created' },
            session: { phase: 'cleared' },
          })),
        }),
      },
    },
    store: {
      record: (id: string) =>
        state.records.has(id)
          ? {
              employeeId: id,
              version: state.versions.get(id) ?? 2,
              phase: 'ready',
              request: { operationId: 'op-' + id },
              destination: {},
            }
          : undefined,
      policy: () => ({}),
    },
    engine: { observeDestination: async () => null },
    service: { flightActive: () => false },
    pool: {
      coldHeld: () => state.held,
      status: async (id: string, authority: DockerContinuationAuthority) => {
        took('status', id, authority);
        return give(state.status?.(id) ?? answer(id));
      },
      repair: async () => {
        throw Error('The in-place repair is not the office-level step');
      },
      reconcile: async (id: string, input: unknown, authority: DockerContinuationAuthority) => {
        took('reconcile', id, authority, input);
        return { ...answer(id), state: 'retained', allowedActions: [] };
      },
      coldPreview: async (id: string, authority: DockerContinuationAuthority) => {
        took('cold-preview', id, authority);
        const refused = state.preview?.(id);
        if (refused) throw refused;
        if (!state.records.has(id)) throw refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
        // The service's own rule: nothing is recovered cold while a laptop of the box runs.
        if (state.laptopRunning) throw refuse('DOCKER_POOL_COLD_WORKERS_RUNNING');
        return { sessionId: session(id).sessionId, sessionGeneration: 3, scopeDigest: SCOPE, policy: {} };
      },
      coldRecover: async (id: string, input: unknown, authority: DockerContinuationAuthority) => {
        took('cold-recover', id, authority, input);
        const result = give(state.recover?.(id) ?? ({ state: 'retained', allowedActions: [] } as Status));
        if (result.state === 'retained') state.anchor = 'running';
        return result;
      },
      coldResume: async (id: string, authority: DockerContinuationAuthority) => {
        took('cold-resume', id, authority);
        if (!state.records.has(id)) throw refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
        const result = give(state.resume?.(id) ?? ({ state: 'retained', allowedActions: [] } as Status));
        state.held = undefined;
        if (result.state === 'retained') state.anchor = 'running';
        return result;
      },
    },
    limits: {
      flightActive: () => false,
      finished: (id: string) =>
        state.records.has(id) ? { employeeId: id, request: { operationId: 'op-' + id } } : undefined,
      restore: async (_id: string, operationId: string) => ({ operationId, limits: give(state.limits) }),
    },
    absent: {
      previewRebuild: async (id: string, _template: unknown, authority: DockerContinuationAuthority) => {
        took('rebuild-preview', id, authority);
        return {
          sessionId: session(id).sessionId,
          sessionGeneration: 3,
          scopeDigest: SCOPE,
          runningLaptops: [],
          allowedActions: ['rebuild'],
        };
      },
      rebuild: async (id: string, input: unknown, authority: DockerContinuationAuthority) => {
        took('rebuild', id, authority, input);
        return { state: 'ready', operationId: 'new-' + id };
      },
    },
    storage: {
      stopped: async (row: { employeeId: string }, current: () => void) => {
        current();
        state.calls.push(['stored-home', row.employeeId]);
        return give(state.stopped);
      },
      capability: () => state.capability,
      remember: async (row: { employeeId: string }) => {
        const outcome = state.remember();
        if (outcome === 'recorded') state.remembered.push(row.employeeId);
        return outcome;
      },
    },
    sessions: { get: () => undefined },
    current: () => state.current,
  } as unknown as DockerSupervisorLaptopDeps;
  const guard: SupervisorPoolGuard = (row, tier) => () => {
    state.tiers.push([row.id, tier]);
    if (!(tier === 'repair' ? state.repair && state.retry : state.retry))
      throw new Error('The office supervisor was switched off');
  };
  const made = (name: string) => state.calls.filter(([call]) => call === name);
  return { state, laptops: new DockerSupervisorLaptops(deps), guard, made };
}

describe('the shared pool after a host restart', () => {
  it('only reads when it is not asked for a step, and says which step the pool calls for', async () => {
    const w = world();
    await expect(w.laptops.keepPool([A, B], w.guard)).resolves.toEqual({
      pool: 'down',
      detail: 'DOCKER_POOL_ANCHOR_UNCONFIRMED',
      step: 'recover-pool',
      employeeId: A.id,
    });
    expect(w.state.calls.map(([name]) => name)).toEqual(['status', 'cold-preview']);
    expect(w.state.anchor).toBe('stopped');
  });

  it('recovers a stopped pool through the owner’s two calls: the preview, then the recovery it previewed', async () => {
    const w = world();
    await expect(w.laptops.keepPool([A, B], w.guard, 'recover-pool')).resolves.toEqual({
      pool: 'up',
      step: 'recover-pool',
      outcome: 'done',
      detail: 'retained',
      employeeId: A.id,
    });
    expect(w.state.calls.map(([name, id]) => [name, id])).toEqual([
      ['status', A.id],
      ['cold-preview', A.id],
      ['cold-recover', A.id],
    ]);
    const [, , input] = w.made('cold-recover')[0]!;
    expect(input).toMatchObject({ sessionId: A.sessionId, sessionGeneration: 3, expectedScopeDigest: SCOPE });
    expect((input as { operationId: string }).operationId).toMatch(/^[0-9a-f-]{36}$/);
    // Reading needs the first switch; starting the stopped anchor needs the one for repairs as well.
    expect(w.state.tiers.at(-1)).toEqual([A.id, 'repair']);
    expect(w.state.anchor).toBe('running');
    // Looked at again, a pool that runs needs nothing.
    await expect(w.laptops.keepPool([A, B], w.guard, 'recover-pool')).resolves.toEqual({
      pool: 'up',
      employeeId: A.id,
    });
    expect(w.made('cold-recover')).toHaveLength(1);
  });

  it('takes no step other than the one it was asked for', async () => {
    const w = world();
    const found = await w.laptops.keepPool([A], w.guard, 'reconcile-pool');
    expect(found).toMatchObject({ pool: 'down', step: 'recover-pool' });
    expect(found.outcome).toBeUndefined();
    expect(w.made('cold-recover')).toEqual([]);
  });

  it('leaves the refusal to the service while a laptop runs: no step is offered and nothing is recovered', async () => {
    const w = world();
    w.state.laptopRunning = true;
    const found = await w.laptops.keepPool([A, B], w.guard, 'recover-pool');
    // Every record was tried, and the refusal's own code is what the look reports.
    expect(found).toEqual({ pool: 'down', detail: 'DOCKER_POOL_COLD_WORKERS_RUNNING' });
    expect(w.made('cold-preview').map(([, id]) => id)).toEqual([A.id, B.id]);
    expect(w.made('cold-recover')).toEqual([]);
    expect(w.state.anchor).toBe('stopped');
  });

  it('never takes a read that failed for a stopped pool', async () => {
    const w = world();
    for (const code of [
      'DOCKER_POOL_OBSERVATION_UNCONFIRMED',
      'DOCKER_POOL_PUBLICATION_UNCONFIRMED',
      'DOCKER_RESOURCE_PROBE_DEADLINE',
    ]) {
      w.state.status = () => ({ state: 'held', code, allowedActions: [] });
      await expect(w.laptops.keepPool([A], w.guard, 'recover-pool')).resolves.toEqual({
        pool: 'unknown',
        detail: code,
        employeeId: A.id,
      });
    }
    w.state.status = () => refuse('DOCKER_CONTINUATION_RUNTIME_CHANGED');
    await expect(w.laptops.keepPool([A], w.guard, 'recover-pool')).resolves.toEqual({
      pool: 'unknown',
      detail: 'DOCKER_CONTINUATION_RUNTIME_CHANGED',
    });
    // A preview that is refused for any other reason offers no step either.
    w.state.status = undefined;
    w.state.preview = () => refuse('DOCKER_POOL_COLD_WRITER_UNCONFIRMED');
    await expect(w.laptops.keepPool([A], w.guard, 'recover-pool')).resolves.toEqual({
      pool: 'down',
      detail: 'DOCKER_POOL_COLD_WRITER_UNCONFIRMED',
    });
    expect(w.made('cold-recover')).toEqual([]);
  });

  it.each([
    'DOCKER_POOL_COLD_WRITER_UNCONFIRMED',
    'DOCKER_POOL_COLD_SOURCE_CHANGED',
    'DOCKER_POOL_COLD_POLICY_CHANGED',
    'DOCKER_POOL_COLD_ANCHOR_NOT_STOPPED',
    'DOCKER_CONTINUATION_UNCONFIRMED',
  ])('tries the next employee when the preview through one record is refused with %s', async (code) => {
    const w = world();
    w.state.preview = (id) => (id === A.id ? refuse(code) : undefined);
    // The look offers the step through the record that can stand for the pool.
    await expect(w.laptops.keepPool([A, B, C], w.guard)).resolves.toEqual({
      pool: 'down',
      detail: 'DOCKER_POOL_ANCHOR_UNCONFIRMED',
      step: 'recover-pool',
      employeeId: B.id,
    });
    await expect(w.laptops.keepPool([A, B, C], w.guard, 'recover-pool')).resolves.toMatchObject({
      pool: 'up',
      outcome: 'done',
      employeeId: B.id,
    });
    expect(w.made('cold-recover').map(([, id]) => id)).toEqual([B.id]);
    // Refused through every record: the first refusal is what stands in the way.
    const all = world();
    all.state.preview = (id) => refuse(id === A.id ? code : 'DOCKER_POOL_COLD_WORKERS_RUNNING');
    await expect(all.laptops.keepPool([A, B], all.guard, 'recover-pool')).resolves.toEqual({
      pool: 'down',
      detail: code,
    });
    expect(all.made('cold-recover')).toEqual([]);
  });

  it('reports a recovery that the service refused, and leaves the pool down', async () => {
    const w = world();
    w.state.recover = () => refuse('DOCKER_RESOURCE_HELPER_FAILED');
    await expect(w.laptops.keepPool([A], w.guard, 'recover-pool')).resolves.toEqual({
      pool: 'down',
      detail: 'DOCKER_RESOURCE_HELPER_FAILED',
      step: 'recover-pool',
      outcome: 'refused',
      employeeId: A.id,
    });
  });

  it('uses the record of the next employee when one cannot stand for the pool', async () => {
    const w = world();
    w.state.records.delete(A.id);
    w.state.preview = (id) => (id === B.id ? refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED') : undefined);
    await expect(w.laptops.keepPool([A, B, C], w.guard, 'recover-pool')).resolves.toMatchObject({
      pool: 'up',
      outcome: 'done',
      employeeId: C.id,
    });
    expect(w.made('status').map(([, id]) => id)).toEqual([A.id, B.id, C.id]);
    expect(w.made('cold-recover').map(([, id]) => id)).toEqual([C.id]);
  });

  it('does not take a record with another pool policy for the pool, nor for an office without one', async () => {
    const w = world();
    w.state.preview = (id) => (id === A.id ? refuse('DOCKER_POOL_COLD_POLICY_CHANGED') : undefined);
    await expect(w.laptops.keepPool([A, B], w.guard, 'recover-pool')).resolves.toMatchObject({
      pool: 'up',
      outcome: 'done',
      employeeId: B.id,
    });
    const all = world();
    all.state.preview = () => refuse('DOCKER_POOL_COLD_POLICY_CHANGED');
    // The anchor is known to be stopped, and the refusal says what stands in the way of starting it.
    await expect(all.laptops.keepPool([A, B], all.guard, 'recover-pool')).resolves.toEqual({
      pool: 'down',
      detail: 'DOCKER_POOL_COLD_POLICY_CHANGED',
    });
    expect(all.made('cold-recover')).toEqual([]);
  });

  it('says that there is no pool to recover when no laptop record names one, so that a first laptop can be set up', async () => {
    const w = world();
    w.state.records.clear();
    await expect(w.laptops.keepPool([A, B], w.guard, 'recover-pool')).resolves.toEqual({
      pool: 'none',
      detail: 'no laptop record names the shared pool',
    });
    expect(w.made('cold-recover')).toEqual([]);
    // An employee with no approved limits has no pool to show either.
    w.state.status = () => new CompanyError('Approve a boxed resource policy before recovery', 409);
    await expect(w.laptops.keepPool([A, B], w.guard)).resolves.toMatchObject({ pool: 'none' });
    // A record that could not be read is not a record that names no pool: nothing is known then.
    w.state.status = (id) =>
      id === A.id ? refuse('DOCKER_CONTINUATION_RUNTIME_CHANGED') : new CompanyError('Unknown company employee', 404);
    await expect(w.laptops.keepPool([A, B], w.guard)).resolves.toEqual({
      pool: 'unknown',
      detail: 'DOCKER_CONTINUATION_RUNTIME_CHANGED',
    });
  });

  it('starts no stopped anchor once repairs are switched off, and still reads', async () => {
    const w = world();
    w.state.repair = false;
    await expect(w.laptops.keepPool([A], w.guard)).resolves.toMatchObject({ pool: 'down', step: 'recover-pool' });
    const refused = await w.laptops.keepPool([A], w.guard, 'recover-pool');
    expect(refused).toMatchObject({ pool: 'down', step: 'recover-pool', outcome: 'refused' });
    expect(w.made('cold-recover')).toEqual([]);
    expect(w.state.anchor).toBe('stopped');
  });

  it('finishes a recovery that did not finish before it previews anything, for the employee it was issued for first', async () => {
    const w = world();
    w.state.held = { employeeId: B.id, sessionId: B.sessionId, sessionGeneration: 3, operationId: 'op' };
    await expect(w.laptops.keepPool([A, B], w.guard)).resolves.toEqual({
      pool: 'down',
      step: 'finish-pool-recovery',
      employeeId: B.id,
    });
    expect(w.state.calls).toEqual([]);
    await expect(w.laptops.keepPool([A, B], w.guard, 'recover-pool')).resolves.toMatchObject({
      step: 'finish-pool-recovery',
    });
    expect(w.state.calls).toEqual([]);
    await expect(w.laptops.keepPool([A, B], w.guard, 'finish-pool-recovery')).resolves.toEqual({
      pool: 'up',
      step: 'finish-pool-recovery',
      outcome: 'done',
      detail: 'retained',
      employeeId: B.id,
    });
    expect(w.state.calls.map(([name, id]) => [name, id])).toEqual([['cold-resume', B.id]]);
    expect(w.state.tiers.at(-1)).toEqual([B.id, 'repair']);
  });

  it('lets another employee finish it when the one it was issued for has no record any more', async () => {
    const w = world();
    w.state.held = { employeeId: B.id, sessionId: B.sessionId, sessionGeneration: 3, operationId: 'op' };
    w.state.resume = (id) =>
      id === B.id ? refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED') : { state: 'retained', allowedActions: [] };
    await expect(w.laptops.keepPool([A, B], w.guard, 'finish-pool-recovery')).resolves.toMatchObject({
      pool: 'up',
      outcome: 'done',
      employeeId: A.id,
    });
    expect(w.made('cold-resume').map(([, id]) => id)).toEqual([B.id, A.id]);
  });

  it('reports a recovery that ended without confirming anything by what the pool is then', async () => {
    const w = world();
    w.state.held = { employeeId: A.id, sessionId: A.sessionId, sessionGeneration: 3, operationId: 'op' };
    // The anchor runs and its limits are not written yet: a laptop set-up writes them, so the pool is usable.
    w.state.resume = () => ({ state: 'held', code: 'DOCKER_POOL_POLICY_CHANGED', allowedActions: [] });
    await expect(w.laptops.keepPool([A], w.guard, 'finish-pool-recovery')).resolves.toMatchObject({
      pool: 'up',
      outcome: 'done',
      detail: 'DOCKER_POOL_POLICY_CHANGED',
    });
    // The anchor is stopped again: the next look previews a new recovery.
    w.state.held = { employeeId: A.id, sessionId: A.sessionId, sessionGeneration: 3, operationId: 'op' };
    w.state.resume = () => ({ state: 'held', code: 'DOCKER_POOL_ANCHOR_UNCONFIRMED', allowedActions: [] });
    await expect(w.laptops.keepPool([A], w.guard, 'finish-pool-recovery')).resolves.toMatchObject({
      pool: 'down',
      outcome: 'done',
    });
    await expect(w.laptops.keepPool([A], w.guard)).resolves.toMatchObject({ pool: 'down', step: 'recover-pool' });
  });

  it('records the observation of a pool that runs without one, with the first switch alone', async () => {
    const w = world();
    w.state.repair = false;
    w.state.status = () => ({
      state: 'reconciliation-required',
      code: 'DOCKER_POOL_ACK_NOT_RETAINED',
      scopeDigest: SCOPE,
      allowedActions: ['reconcile-pool'],
    });
    await expect(w.laptops.keepPool([A], w.guard)).resolves.toMatchObject({ pool: 'up', step: 'reconcile-pool' });
    await expect(w.laptops.keepPool([A], w.guard, 'reconcile-pool')).resolves.toMatchObject({
      pool: 'up',
      step: 'reconcile-pool',
      outcome: 'done',
    });
    expect(w.made('reconcile')[0]![2]).toMatchObject({ expectedScopeDigest: SCOPE });
    expect(w.made('cold-recover')).toEqual([]);
  });

  it('counts a pool that runs with its limits or their acknowledgement missing as usable, and recovers nothing', async () => {
    const w = world();
    for (const code of ['DOCKER_POOL_POLICY_CHANGED', 'DOCKER_POOL_ORIGINAL_ACK_MISSING']) {
      w.state.status = () => ({ state: 'held', code, allowedActions: ['repair-pool'] });
      await expect(w.laptops.keepPool([A], w.guard, 'recover-pool')).resolves.toEqual({
        pool: 'up',
        detail: code,
        employeeId: A.id,
      });
    }
    expect(w.state.calls.map(([name]) => name)).toEqual(['status', 'status']);
  });

  it('stops presenting its authority with the runtime', async () => {
    const w = world();
    w.state.current = false;
    await expect(w.laptops.keepPool([A], w.guard, 'recover-pool')).resolves.toMatchObject({ pool: 'unknown' });
    expect(w.state.calls).toEqual([]);
  });
});

describe('the stored home of a stopped laptop', () => {
  const guard = () => {};
  it.each([
    [{ state: 'verified' }, { found: 'verified' }],
    [{ state: 'different' }, { found: 'different' }],
    [{ state: 'changed' }, { found: 'changed' }],
    [
      { state: 'renumbered', reason: 'no-record-no-grant' },
      { found: 'renumbered', cause: 'no-record-no-grant' },
    ],
    // Nothing stopped to compare, and an office that is configured with no verifier at all.
    [{ state: 'not-stopped' }, { found: 'unchecked' }],
    [{ state: 'no-verifier' }, { found: 'unchecked' }],
  ] as const)('reads %j as %j', async (seen, expected) => {
    const w = world();
    w.state.stopped = seen;
    await expect(w.laptops.storedHome(A, guard)).resolves.toEqual(expected);
    expect(w.made('stored-home')).toHaveLength(1);
  });

  it.each([
    'verifier-image-missing',
    'verifier-lacks-command',
    'verifier-timed-out',
    'verifier-failed',
    'receipt-unreadable',
    'laptop-unreadable',
  ] as const)('never reads a check that could not tell (%s) as a home to rebuild on', async (cause) => {
    const w = world();
    w.state.stopped = { state: 'unconfirmed', cause };
    await expect(w.laptops.storedHome(A, guard)).resolves.toEqual({ found: 'unknown', cause });
    // The rebuild step, which makes the read itself, replaces nothing either, and spends no attempt on it.
    await expect(w.laptops.rebuild(A, guard, ['stored-home'])).resolves.toEqual({
      outcome: 'busy',
      detail: 'the stored home could not be read',
    });
    expect(w.made('rebuild')).toEqual([]);
  });

  it('reads a refused read as unknown, and an employee with no laptop record as nothing to compare', async () => {
    const w = world();
    w.state.stopped = new CompanyError('Recovery permission or employee binding changed', 409);
    await expect(w.laptops.storedHome(A, guard)).resolves.toEqual({ found: 'unknown', cause: 'read-refused' });
    await expect(
      w.laptops.storedHome(A, () => {
        throw new Error('The office supervisor was switched off');
      })
    ).resolves.toEqual({ found: 'unknown', cause: 'read-refused' });
    w.state.records.delete(A.id);
    await expect(w.laptops.storedHome(A, guard)).resolves.toEqual({ found: 'unchecked' });
  });

  it('records the home of every finished laptop alike, also one a plan move made', async () => {
    const w = world();
    w.state.capability = 'full';
    w.state.versions.set(B.id, 3);
    await expect(w.laptops.rememberHome(A, guard)).resolves.toBe('recorded');
    await expect(w.laptops.rememberHome(B, guard)).resolves.toBe('recorded');
    expect(w.state.remembered).toEqual([A.id, B.id]);
    // The limits check records nothing of its own any more: it skips laptops of a plan move.
    await w.laptops.keepLimits(C, guard);
    expect(w.state.remembered).toEqual([A.id, B.id]);
  });

  it('says why nothing was recorded, so that it is tried again', async () => {
    const w = world();
    w.state.capability = 'full';
    w.state.remember = () => 'not-running';
    await expect(w.laptops.rememberHome(A, guard)).resolves.toBe('not-running');
    w.state.remember = () => {
      throw refuse('DOCKER_CONTINUATION_REATTACH_VERIFIER_UNCONFIRMED');
    };
    await expect(w.laptops.rememberHome(A, guard)).resolves.toBe('failed');
    w.state.remember = () => 'recorded';
    await expect(
      w.laptops.rememberHome(A, () => {
        throw new Error('The office supervisor was switched off');
      })
    ).resolves.toBe('failed');
    // No record of a laptop set-up: nothing runs to be read.
    w.state.records.delete(A.id);
    await expect(w.laptops.rememberHome(A, guard)).resolves.toBe('not-running');
    // A verifier image that cannot read what is mounted, and an office with none, record nothing.
    for (const capability of ['compare-only', 'image-missing', 'none'] as const) {
      w.state.capability = capability;
      await expect(w.laptops.rememberHome(B, guard)).resolves.toBe('unsupported');
    }
    // An image that has not answered the probe yet is asked: the first read settles what it can do.
    w.state.capability = 'unknown';
    await expect(w.laptops.rememberHome(B, guard)).resolves.toBe('recorded');
  });
});

describe('the rebuild step and the stored home', () => {
  const guard = () => {};
  it('reads the stored home itself, last, and rebuilds when nothing is found against it', async () => {
    for (const found of ['verified', 'not-stopped', 'no-verifier'] as const) {
      const w = world();
      w.state.stopped = { state: found };
      // Whatever it was told had been proved: the read is its own.
      await expect(w.laptops.rebuild(A, guard, found === 'verified' ? ['stored-home'] : [])).resolves.toEqual({
        outcome: 'done',
        detail: 'rebuilt new-' + A.id,
      });
      expect(w.state.calls.map(([name]) => name)).toEqual(['rebuild-preview', 'stored-home', 'rebuild']);
    }
  });

  it.each([
    [
      { state: 'renumbered', reason: 'no-record-no-grant' },
      'the stored home has a new device number that nothing accepts',
    ],
    [{ state: 'different' }, 'the stored home is not the directory the laptop was built on'],
    [{ state: 'changed' }, 'the stored home no longer matches what was recorded'],
  ] as const)(
    'replaces no laptop whose stored home is %j, by whatever path the rebuild was reached, and spends no attempt',
    async (found, detail) => {
      for (const proved of [[], ['stored-home'], ['laptop-held', 'agent-unreadable']] as const) {
        const w = world();
        w.state.stopped = found;
        // Nothing was tried, so the attempt is given back: a round's two rebuilds are not used up by a read.
        await expect(w.laptops.rebuild(A, guard, proved)).resolves.toEqual({ outcome: 'busy', detail });
        expect(w.made('rebuild')).toEqual([]);
      }
    }
  );

  it('replaces no laptop whose stored home it was not allowed to read', async () => {
    const w = world();
    w.state.stopped = new CompanyError('Recovery permission or employee binding changed', 409);
    await expect(w.laptops.rebuild(A, guard, ['stored-home'])).resolves.toEqual({
      outcome: 'busy',
      detail: 'the stored home could not be read',
    });
    expect(w.made('rebuild')).toEqual([]);
  });

  it('says what the office checks with the verifier image it is configured with', () => {
    expect(world().laptops.storedHomeCheck()).toBe('none');
  });
});
