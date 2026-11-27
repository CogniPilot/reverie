import { describe, expect, it } from 'vitest';
import { CompanyError } from '../src/company-service.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
} from '../src/docker-employee-continuation.js';
import { DockerSupervisorLaptops, type DockerSupervisorLaptopDeps } from '../src/docker-employee-supervisor-laptops.js';
import { layoutFor, ownLaptop, standingLayout, standingLimits } from '../src/docker-standing-defaults.js';
import type { SupervisedEmployee } from '../src/employee-supervisor.js';

const EMPLOYEE: SupervisedEmployee = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Stan',
  owner: undefined,
  sessionId: '22222222-2222-4222-8222-222222222222',
  sessionGeneration: 3,
  desiredRunning: true,
  onVacation: false,
  bindingMigration: false,
};
const DESTINATION = 'd'.repeat(64);
const TEMPLATE = { user: '1000:1000', scratchRoot: '/host/scratch/laptops', mounts: [] };
const REQUEST = {
  operationId: '33333333-3333-4333-8333-333333333333',
  sessionId: EMPLOYEE.sessionId,
  sessionGeneration: 3,
  containerId: 'a'.repeat(64),
  imageId: 'sha256:' + 'b'.repeat(64),
  expectedPolicyDigest: 'c'.repeat(64),
  expectedDestinationImageId: 'sha256:' + 'e'.repeat(64),
  enterOffice: true,
};
const retired = (patch: Record<string, unknown> = {}) => ({
  employeeId: EMPLOYEE.id,
  operationId: '44444444-4444-4444-8444-444444444444',
  sessionId: EMPLOYEE.sessionId,
  sessionGeneration: 3,
  scopeDigest: '5'.repeat(64),
  template: TEMPLATE,
  source: { phase: 'created' },
  session: { phase: 'cleared' },
  ...patch,
});

function world() {
  const state = {
    current: true,
    guard: true,
    binding: true,
    flight: false,
    record: { version: 2, phase: 'resources-issued', request: REQUEST, destination: { containerId: DESTINATION } } as
      | Record<string, unknown>
      | undefined,
    policy: { memory: 1 } as unknown,
    approved: true,
    retired: [retired()] as Array<Record<string, unknown>>,
    session: { pid: 77 } as ({ pid: number | null } & Record<string, unknown>) | undefined,
    observed: { state: 'running', provider: { kind: 'exited', exit: {} } } as unknown,
    preview: {
      sessionId: EMPLOYEE.sessionId,
      sessionGeneration: 3,
      scopeDigest: '6'.repeat(64),
      runningLaptops: [] as string[],
      allowedActions: ['rebuild'] as string[],
    } as Record<string, unknown>,
    result: { operationId: REQUEST.operationId, phase: 'ready', state: 'ready', allowedActions: ['observe'] } as Record<
      string,
      unknown
    >,
    selection: {
      sessionId: EMPLOYEE.sessionId,
      sessionGeneration: 3,
      containerId: '7'.repeat(64),
      imageId: 'sha256:' + '8'.repeat(64),
      destinationImageId: 'sha256:' + '9'.repeat(64),
      state: 'stopped',
      operationId: null,
    } as Record<string, unknown>,
    rebuilt: { operationId: 'new', state: 'ready' } as Record<string, unknown>,
    /** What the shared pool's status read and a laptop's in-place repair answer. */
    pool: { state: 'retained', sessionId: EMPLOYEE.sessionId, sessionGeneration: 3, allowedActions: [] } as
      | Record<string, unknown>
      | Error,
    repaired: { operationId: REQUEST.operationId, phase: 'ready', state: 'ready', allowedActions: ['observe'] } as
      | Record<string, unknown>
      | Error,
    /** What the attendance-independent repair of the laptop's own limits answers, call by call. */
    kept: ['unchanged'] as Array<'unchanged' | 'restored' | Error>,
    limitsFlight: false,
    calls: [] as Array<[string, unknown]>,
    authority: undefined as DockerContinuationAuthority | undefined,
    during: undefined as (() => void) | undefined,
    /** The other employees of the same company, the company's settings, and what the saved session record says. */
    others: [] as Array<Record<string, unknown>>,
    settings: [] as Array<Record<string, unknown>>,
    heldOnRecord: false,
    /** Resource limits saved through the store, and what runs inside that save before it writes. */
    saved: [] as unknown[],
    duringSave: undefined as (() => void) | undefined,
    /** What happens after the rebuild service was called and before it says that the stop is next. */
    beforeStop: undefined as (() => void) | undefined,
    /** The input holds taken and released for a session, in order. */
    holds: [] as string[],
    /** Each read of the stored home: the holds in place then, and the calls that had been made before it. */
    homeReads: [] as Array<{ holds: string; after: string[] }>,
    /** What the read of the stored home finds. A laptop that runs has no stopped storage to compare. */
    stored: { state: 'not-stopped' } as { state: string; cause?: string; reason?: string },
    now: 10 * 60_000,
    /** What the Engine says of the employee's own laptop, and the plan the employee is on. */
    inspect: undefined as Record<string, unknown> | Error | undefined,
    plan: undefined as string | undefined,
  };
  const took = (name: string, argument: unknown, authority: DockerContinuationAuthority) => {
    state.calls.push([name, argument]);
    state.authority = authority;
    authority.require();
  };
  const deps = {
    company: {
      recoveryAction: (id: string, owner: string | undefined) => {
        expect([id, owner]).toEqual([EMPLOYEE.id, undefined]);
        return {
          current: () => state.binding,
          require: () => {
            if (!state.binding) throw new CompanyError('Recovery permission or employee binding changed', 409);
          },
        };
      },
      store: {
        snapshot: () => ({
          employees: [
            {
              id: EMPLOYEE.id,
              dockerBinding: {},
              ...(state.approved ? { dockerResourcePolicy: state.policy } : {}),
              ...(state.plan ? { runtimeRecipe: { subscriptionProfile: { id: state.plan } } } : {}),
            },
            ...state.others,
          ],
          settings: state.settings,
          retiredDockerEmployeeContinuations: state.retired,
        }),
      },
    },
    store: {
      record: () => state.record,
      policy: () => state.policy,
      savePolicy: async (id: string, owner: string | undefined, policy: unknown, current: () => void) => {
        state.duringSave?.();
        current();
        state.saved.push([id, owner, policy]);
        state.policy = policy;
        state.approved = true;
      },
    },
    engine: {
      observeDestination: async () => {
        state.calls.push(['observeDestination', undefined]);
        if (state.observed instanceof Error) throw state.observed;
        return state.observed;
      },
    },
    service: {
      flightActive: () => state.flight,
      observe: async (_id: string, operationId: string, authority: DockerContinuationAuthority) => {
        took('observe', operationId, authority);
        if (state.result instanceof Error) throw state.result;
        return state.result;
      },
      selection: async (_id: string, authority: DockerContinuationAuthority) => {
        took('selection', undefined, authority);
        if (state.selection instanceof Error) throw state.selection;
        return state.selection;
      },
      begin: async (_id: string, request: unknown, authority: DockerContinuationAuthority) => {
        took('begin', request, authority);
        if (state.result instanceof Error) throw state.result;
        return state.result;
      },
      repair: async (_id: string, operationId: string, authority: DockerContinuationAuthority) => {
        took('repair', operationId, authority);
        if (state.repaired instanceof Error) throw state.repaired;
        return state.repaired;
      },
    },
    pool: {
      status: async (_id: string, authority: DockerContinuationAuthority) => {
        took('pool-status', undefined, authority);
        if (state.pool instanceof Error) throw state.pool;
        return state.pool;
      },
      repair: async (_id: string, input: unknown, authority: DockerContinuationAuthority) => {
        took('pool-repair', input, authority);
        return { ...(state.pool as Record<string, unknown>), state: 'retained', allowedActions: [] };
      },
    },
    limits: {
      flightActive: () => state.limitsFlight,
      finished: () =>
        state.record && state.record.version !== 3 && ['provider-issued', 'ready'].includes(String(state.record.phase))
          ? state.record
          : undefined,
      restore: async (_id: string, operationId: string, authority: DockerContinuationAuthority) => {
        took('limits', operationId, authority);
        const answer = state.kept.length > 1 ? state.kept.shift()! : state.kept[0]!;
        if (answer instanceof Error) throw answer;
        return { operationId, limits: answer };
      },
    },
    absent: {
      previewRebuild: async (_id: string, template: unknown, authority: DockerContinuationAuthority) => {
        took('preview', template, authority);
        if (state.preview instanceof Error) throw state.preview;
        return state.preview;
      },
      rebuild: async (_id: string, request: unknown, authority: DockerContinuationAuthority) => {
        took('rebuild', request, authority);
        // As the service does: its checks and the seat preparation, then word that the stop is next, then the stop.
        state.beforeStop?.();
        authority.require();
        authority.discarding?.();
        state.during?.();
        authority.require();
        return state.rebuilt;
      },
    },
    sessions: { get: () => state.session },
    inputHeldOnRecord: () => state.heldOnRecord,
    inspectLaptop: async (containerId: string) => {
      state.calls.push(['inspect', containerId]);
      if (state.inspect instanceof Error) throw state.inspect;
      return state.inspect;
    },
    holdInput: (sessionId: string) => {
      state.holds.push('hold ' + sessionId);
      return () => void state.holds.push('release ' + sessionId);
    },
    storage: {
      stopped: async () => {
        state.homeReads.push({ holds: state.holds.join(','), after: state.calls.map(([name]) => String(name)) });
        return state.stored;
      },
    },
    now: () => state.now,
    current: () => state.current,
  } as unknown as DockerSupervisorLaptopDeps;
  const guard = () => {
    if (!state.guard) throw new Error('The office supervisor was switched off');
  };
  const made = (name: string) => state.calls.filter(([call]) => call === name).map(([, argument]) => argument);
  return { state, laptops: new DockerSupervisorLaptops(deps), guard, made };
}

describe('the office supervisor’s laptop authority', () => {
  it('presents the employee’s owner and holds only while the switch, the runtime and the binding hold', async () => {
    const w = world();
    await w.laptops.read(EMPLOYEE, w.guard);
    const authority = w.state.authority!;
    expect(authority.owner).toBeUndefined();
    expect(() => authority.require()).not.toThrow();
    for (const key of ['guard', 'current', 'binding'] as const) {
      w.state[key] = false;
      expect(() => authority.require()).toThrow();
      expect(() => authority.requireOffice()).toThrow();
      w.state[key] = true;
    }
    // Its office authority is the same check: it confirms an attendance, it cannot change one.
    expect(authority.requireOffice).toBe(authority.require);
  });

  it('is refused before any service call once the switch is off', async () => {
    const w = world();
    w.state.guard = false;
    await expect(w.laptops.resend(EMPLOYEE, w.guard)).rejects.toThrow(/switched off/);
    await expect(w.laptops.rebuild(EMPLOYEE, w.guard)).rejects.toThrow(/switched off/);
    expect(w.state.calls).toEqual([]);
    // A read reports what it could not confirm instead of throwing.
    expect(await w.laptops.read(EMPLOYEE, w.guard)).toMatchObject({ state: 'held', code: 'DOCKER_CONTINUATION_UNCONFIRMED' });
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('unknown');
    expect(await w.laptops.source(EMPLOYEE, w.guard)).toBe('unknown');
  });
});

describe('putting approved limits back on a running laptop', () => {
  const published = () => {
    const w = world();
    w.state.record = { version: 2, phase: 'ready', request: REQUEST, destination: { containerId: DESTINATION } };
    return w;
  };
  it('repairs the shared pool when its status offers that, then the laptop’s own limits, and sends no set-up request', async () => {
    const w = published();
    w.state.pool = {
      state: 'held',
      code: 'DOCKER_POOL_POLICY_CHANGED',
      sessionId: EMPLOYEE.sessionId,
      sessionGeneration: 3,
      scopeDigest: '9'.repeat(64),
      allowedActions: ['repair-pool'],
    };
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'ready' });
    expect(w.state.calls.map(([name]) => name)).toEqual(['pool-status', 'pool-repair', 'repair']);
    // The pool repair carries the hold the status named and nothing else: no limit and no policy.
    expect(w.made('pool-repair')).toEqual([
      { sessionId: EMPLOYEE.sessionId, sessionGeneration: 3, expectedScopeDigest: '9'.repeat(64) },
    ]);
    expect(w.made('repair')).toEqual([REQUEST.operationId]);
  });
  it('leaves a pool alone whose status offers no repair', async () => {
    const w = published();
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'ready' });
    expect(w.state.calls.map(([name]) => name)).toEqual(['pool-status', 'repair']);
  });
  it('reports what a repair did not settle, and falls back to the request only when the laptop offers it', async () => {
    const w = published();
    w.state.repaired = {
      operationId: REQUEST.operationId,
      phase: 'ready',
      state: 'held',
      code: 'DOCKER_RESOURCE_HELPER_FAILED',
      allowedActions: ['observe'],
    };
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'DOCKER_RESOURCE_HELPER_FAILED',
    });
    expect(w.made('begin')).toEqual([]);
    w.state.repaired = { ...w.state.repaired, code: 'DOCKER_CONTINUATION_STORAGE_UNCONFIRMED', allowedActions: ['observe', 'continue'] };
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'ready' });
    expect(w.made('begin')).toEqual([REQUEST]);
  });
  it('holds the supervisor’s authority for both repairs and refuses once the switch is off', async () => {
    const w = published();
    w.state.pool = new DockerEmployeeContinuationError('DOCKER_POOL_TARGET_CHANGED');
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'refused', detail: 'DOCKER_POOL_TARGET_CHANGED' });
    expect(w.made('repair')).toEqual([]);
    w.state.guard = false;
    await expect(w.laptops.resend(EMPLOYEE, w.guard)).rejects.toThrow(/switched off/);
  });
  it('never repairs for a laptop whose set-up is not finished: that set-up applies its own limits', async () => {
    const w = world();
    await w.laptops.resend(EMPLOYEE, w.guard);
    expect(w.state.calls.map(([name]) => name)).toEqual(['begin']);
  });
});

describe('keeping the approved limits of a laptop whose employee is out of the office', () => {
  const AWAY: SupervisedEmployee = { ...EMPLOYEE, onVacation: true, desiredRunning: false };
  const published = () => {
    const w = world();
    w.state.record = { version: 2, phase: 'ready', request: REQUEST, destination: { containerId: DESTINATION } };
    return w;
  };
  const names = (w: ReturnType<typeof world>) => w.state.calls.map(([name]) => name);

  it('asks the repair that does not depend on attendance, and nothing of a set-up, a terminal or an agent', async () => {
    const w = published();
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toEqual({ outcome: 'done', detail: 'unchanged' });
    w.state.kept = ['restored'];
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toEqual({ outcome: 'done', detail: 'restored' });
    expect(names(w)).toEqual(['limits', 'limits']);
    expect(w.made('limits')).toEqual([REQUEST.operationId, REQUEST.operationId]);
    // The same call serves an employee who is in the office.
    expect(await w.laptops.keepLimits(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'restored' });
  });

  it('repairs the shared pool first only when the pool stands in the way, then tries the laptop once more', async () => {
    for (const code of ['DOCKER_CONTINUATION_POOL_UNCONFIRMED', 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED']) {
      const w = published();
      w.state.kept = [new DockerEmployeeContinuationError(code), 'unchanged'];
      w.state.pool = {
        state: 'held',
        code: 'DOCKER_POOL_POLICY_CHANGED',
        sessionId: EMPLOYEE.sessionId,
        sessionGeneration: 3,
        scopeDigest: '9'.repeat(64),
        allowedActions: ['repair-pool'],
      };
      expect(await w.laptops.keepLimits(AWAY, w.guard)).toEqual({ outcome: 'done', detail: 'restored' });
      expect(names(w)).toEqual(['limits', 'pool-status', 'pool-repair', 'limits']);
      expect(w.made('pool-repair')).toEqual([
        { sessionId: EMPLOYEE.sessionId, sessionGeneration: 3, expectedScopeDigest: '9'.repeat(64) },
      ]);
    }
    // A pool whose status offers no repair is left alone, and the hold is reported.
    const w = published();
    w.state.kept = [new DockerEmployeeContinuationError('DOCKER_CONTINUATION_POOL_UNCONFIRMED')];
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'DOCKER_CONTINUATION_POOL_UNCONFIRMED',
    });
    expect(names(w)).toEqual(['limits', 'pool-status']);
  });

  it('has nothing to keep without a finished laptop, and calls a stopped laptop not running', async () => {
    const w = world();
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toBeUndefined();
    w.state.record = { ...w.state.record, phase: 'ready', version: 3 };
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toBeUndefined();
    w.state.record = undefined;
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toBeUndefined();
    expect(w.state.calls).toEqual([]);
    const stopped = published();
    stopped.state.kept = [new DockerEmployeeContinuationError('DOCKER_CONTINUATION_CONTAINER_STOPPED')];
    expect(await stopped.laptops.keepLimits(AWAY, stopped.guard)).toEqual({ outcome: 'done', detail: 'not-running' });
  });

  it('reports a refusal by its code, a busy laptop as busy, and never falls back to a set-up request', async () => {
    const w = published();
    w.state.kept = [new DockerEmployeeContinuationError('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED')];
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED',
    });
    w.state.kept = [new DockerEmployeeContinuationError('DOCKER_CONTINUATION_BUSY')];
    expect(await w.laptops.keepLimits(AWAY, w.guard)).toEqual({ outcome: 'busy', detail: 'DOCKER_CONTINUATION_BUSY' });
    for (const never of ['begin', 'repair', 'observe', 'selection', 'preview', 'rebuild', 'observeDestination'])
      expect([never, w.made(never)]).toEqual([never, []]);
  });

  it('presents the supervisor’s authority, which holds only while the switch, the runtime and the binding hold', async () => {
    const w = published();
    await w.laptops.keepLimits(AWAY, w.guard);
    const authority = w.state.authority!;
    for (const key of ['guard', 'current', 'binding'] as const) {
      w.state[key] = false;
      expect(() => authority.require()).toThrow();
      w.state[key] = true;
    }
    w.state.guard = false;
    await expect(w.laptops.keepLimits(AWAY, w.guard)).rejects.toThrow(/switched off/);
    expect(names(w)).toEqual(['limits']);
  });

  it('counts a limits repair in flight as an operation on that employee', () => {
    const w = published();
    expect(w.laptops.flightActive(EMPLOYEE.id)).toBe(false);
    w.state.limitsFlight = true;
    expect(w.laptops.flightActive(EMPLOYEE.id)).toBe(true);
  });
});

describe('reading a laptop', () => {
  it('glances at the record, the approvals and the layout on record without a service call', () => {
    const w = world();
    expect(w.laptops.glance(EMPLOYEE.id)).toEqual({
      record: { phase: 'resources-issued', version: 2, operationId: REQUEST.operationId },
      bound: true,
      policyApproved: true,
      templateOnRecord: true,
      // The employee has a laptop of their own whose container can be read for a layout.
      standing: { enabled: true, limits: false, layout: true },
    });
    w.state.retired = [];
    w.state.record = undefined;
    w.state.approved = false;
    expect(w.laptops.glance(EMPLOYEE.id)).toEqual({
      record: null,
      bound: true,
      policyApproved: false,
      templateOnRecord: false,
      standing: { enabled: true, limits: false, layout: false },
    });
    w.state.retired = [retired({ source: { phase: 'issued' } })];
    expect(w.laptops.glance(EMPLOYEE.id)).toMatchObject({ rebuildPending: true });
    expect(w.state.calls).toEqual([]);
  });

  it('returns the owner’s observe read, with how an exited agent ended as one sentence', async () => {
    const w = world();
    w.state.result = {
      operationId: REQUEST.operationId,
      phase: 'provider-issued',
      state: 'held',
      code: 'DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED',
      allowedActions: ['observe'],
      providerExit: { status: 1, signal: null, lines: ['model not found'] },
    };
    expect(await w.laptops.read(EMPLOYEE, w.guard)).toEqual({
      state: 'held',
      phase: 'provider-issued',
      code: 'DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED',
      allowedActions: ['observe'],
      providerExit: 'The agent exited with status 1 right after it started. Its last line was: model not found',
    });
    expect(w.made('observe')).toEqual([REQUEST.operationId]);
  });

  it('reports a refused read as the hold it names', async () => {
    const w = world();
    w.state.result = new DockerEmployeeContinuationError('DOCKER_CONTINUATION_TARGET_CHANGED') as never;
    expect(await w.laptops.read(EMPLOYEE, w.guard)).toEqual({
      state: 'held',
      phase: 'resources-issued',
      code: 'DOCKER_CONTINUATION_TARGET_CHANGED',
      allowedActions: [],
    });
    w.state.result = new Error('socket hang up /run/secret') as never;
    expect(await w.laptops.read(EMPLOYEE, w.guard)).toMatchObject({ code: 'DOCKER_CONTINUATION_UNCONFIRMED' });
    w.state.record = undefined;
    expect(await w.laptops.read(EMPLOYEE, w.guard)).toBeUndefined();
  });
});

describe('continuing and starting a laptop', () => {
  it('re-sends the recorded request verbatim', async () => {
    const w = world();
    w.state.result = { operationId: REQUEST.operationId, phase: 'resources-ready', state: 'pending', allowedActions: [] };
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'resources-ready' });
    expect(w.made('begin')).toEqual([REQUEST]);
  });

  it('reports a hold as refused and a busy laptop as busy', async () => {
    const w = world();
    w.state.result = { phase: 'resources-issued', state: 'held', code: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING', allowedActions: [] };
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'refused', detail: 'DOCKER_RESOURCE_HELPER_RETRY_PENDING' });
    w.state.result = new DockerEmployeeContinuationError('DOCKER_CONTINUATION_BUSY') as never;
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({ outcome: 'busy', detail: 'DOCKER_CONTINUATION_BUSY' });
    w.state.result = new CompanyError('Recovery permission or employee binding changed', 409) as never;
    expect(await w.laptops.resend(EMPLOYEE, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'Recovery permission or employee binding changed',
    });
    w.state.result = new Error('unexpected') as never;
    await expect(w.laptops.resend(EMPLOYEE, w.guard)).rejects.toThrow('unexpected');
  });

  it('never re-sends a plan move’s private record', async () => {
    const w = world();
    w.state.record = { ...w.state.record, version: 3 };
    expect((await w.laptops.resend(EMPLOYEE, w.guard)).outcome).toBe('refused');
    expect(w.made('begin')).toEqual([]);
  });

  it('starts a stopped source with the approved limits and never changes attendance', async () => {
    const w = world();
    w.state.record = undefined;
    expect(await w.laptops.start(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'ready' });
    const [request] = w.made('begin') as Array<Record<string, unknown>>;
    expect(request).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sessionId: EMPLOYEE.sessionId,
      sessionGeneration: 3,
      containerId: '7'.repeat(64),
      imageId: 'sha256:' + '8'.repeat(64),
      expectedPolicyDigest: dockerContinuationDigest({ memory: 1 }),
      expectedDestinationImageId: 'sha256:' + '9'.repeat(64),
      enterOffice: false,
    });
  });

  it('does not start beside a record, without approved limits or from a running source', async () => {
    const w = world();
    expect((await w.laptops.start(EMPLOYEE, w.guard)).detail).toBe('a laptop set-up already exists');
    w.state.record = undefined;
    w.state.approved = false;
    expect((await w.laptops.start(EMPLOYEE, w.guard)).detail).toBe('no approved resource limits');
    w.state.approved = true;
    w.state.selection = { ...w.state.selection, state: 'running' };
    expect((await w.laptops.start(EMPLOYEE, w.guard)).detail).toBe('no stopped laptop source');
    expect(w.made('begin')).toEqual([]);
    expect(await w.laptops.source(EMPLOYEE, w.guard)).toBe('running');
  });

  it('reads an unused source that was made for an earlier laptop image as outdated, and starts nothing from it', async () => {
    const w = world();
    w.state.record = undefined;
    w.state.selection = new DockerEmployeeContinuationError('DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED') as never;
    expect(await w.laptops.source(EMPLOYEE, w.guard)).toBe('outdated');
    expect(await w.laptops.start(EMPLOYEE, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED',
    });
    expect(w.made('begin')).toEqual([]);
    // Any other refusal of that read says nothing about the source: a changed image alone is not this finding.
    for (const code of ['DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED', 'DOCKER_CONTINUATION_UNIQUE_ORIGINAL_REQUIRED']) {
      w.state.selection = new DockerEmployeeContinuationError(code) as never;
      expect(await w.laptops.source(EMPLOYEE, w.guard)).toBe('unknown');
    }
    w.state.selection = Error('synthetic Engine outage') as never;
    expect(await w.laptops.source(EMPLOYEE, w.guard)).toBe('unknown');
  });
});

describe('what a rebuild would discard', () => {
  it('finds no laptop when the Engine lists none running', async () => {
    const w = world();
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('no-laptop');
    expect(w.made('preview')).toEqual([TEMPLATE]);
    expect(w.made('observeDestination')).toEqual([]);
  });

  it.each([
    ['exited', { state: 'running', provider: { kind: 'exited', exit: {} } }, 'exited'],
    ['never started', { state: 'running', provider: { kind: 'absent' } }, 'absent'],
    ['running', { state: 'running', provider: { kind: 'running', operationId: 'o', sessionId: 's' } }, 'running'],
    ['unreadable', { state: 'running', provider: { kind: 'unknown' } }, 'unknown'],
    ['a container the read says is stopped', { state: 'stopped', provider: { kind: 'absent' } }, 'unknown'],
    ['a container the read cannot find', null, 'unknown'],
    ['a read that fails', new Error('exec failed'), 'unknown'],
  ])('reads the one running destination: agent %s', async (_title, observed, expected) => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
    w.state.observed = observed;
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe(expected);
  });

  it('calls any other running laptop occupied, because nothing shows it empty', async () => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: ['f'.repeat(64)] };
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION, 'f'.repeat(64)] };
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    expect(w.made('observeDestination')).toEqual([]);
  });

  it('knows nothing without a layout on record or when the preview fails', async () => {
    const w = world();
    w.state.preview = new DockerEmployeeContinuationError('DOCKER_REPROVISION_ABSENCE_UNCONFIRMED') as never;
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('unknown');
    w.state.retired = [];
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('unknown');
  });

  it('uses the newest laptop operation’s layout and none when the history is ambiguous', async () => {
    const w = world();
    const newer = { ...TEMPLATE, scratchRoot: '/host/new/laptops' };
    w.state.retired = [retired(), retired({ operationId: 'newer', previous: retired().operationId, template: newer })];
    await w.laptops.provider(EMPLOYEE, w.guard);
    expect(w.made('preview')).toEqual([newer]);
    w.state.retired = [retired(), retired({ operationId: 'sibling' })];
    expect(w.laptops.glance(EMPLOYEE.id).templateOnRecord).toBe(false);
  });
});

describe('rebuilding a laptop', () => {
  it('applies the preview it just read, with the recorded layout, and never confirms a discard nobody needs', async () => {
    const w = world();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
    expect(w.made('rebuild')).toEqual([
      {
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        sessionId: EMPLOYEE.sessionId,
        sessionGeneration: 3,
        expectedScopeDigest: '6'.repeat(64),
        template: TEMPLATE,
      },
    ]);
  });

  it('confirms discarding a running laptop only after a read inside it found no agent', async () => {
    for (const kind of ['exited', 'absent']) {
      const w = world();
      w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
      w.state.observed = { state: 'running', provider: { kind } };
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('done');
      expect(w.made('rebuild')).toEqual([expect.objectContaining({ confirmDiscardRunning: true })]);
      expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination', 'rebuild']);
    }
  });

  it.each([
    ['an agent runs in it', { state: 'running', provider: { kind: 'running' } }, [DESTINATION]],
    ['it cannot be read', { state: 'running', provider: { kind: 'unknown' } }, [DESTINATION]],
    ['the read fails', new Error('exec failed'), [DESTINATION]],
    ['the running laptop is not the recorded destination', { state: 'running', provider: { kind: 'absent' } }, ['f'.repeat(64)]],
    ['two laptops run', { state: 'running', provider: { kind: 'absent' } }, [DESTINATION, 'f'.repeat(64)]],
  ])('never discards a running laptop when %s', async (_title, observed, running) => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: running };
    w.state.observed = observed;
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'a running laptop is not shown to be empty',
    });
    expect(w.made('rebuild')).toEqual([]);
  });

  it('stops the discard if anything that could start an agent moved after the read', async () => {
    const cases: Array<[string, (state: ReturnType<typeof world>['state']) => void, boolean]> = [
      ['a set-up step took flight', (state) => (state.flight = true), true],
      ['the office terminal became another process', (state) => (state.session = { pid: 99 }), true],
      ['the office terminal was replaced', (state) => (state.session = { pid: 77 }), true],
      ['the office terminal went away, as the rebuild itself does', (state) => (state.session = undefined), false],
      ['the office terminal stopped', (state) => (state.session!.pid = null), false],
    ];
    for (const [title, change, stops] of cases) {
      const w = world();
      w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
      w.state.during = () => change(w.state);
      const result = w.laptops.rebuild(EMPLOYEE, w.guard);
      if (stops) expect([title, await result]).toEqual([title, { outcome: expect.stringMatching(/busy|refused/), detail: expect.stringMatching(/^DOCKER_/) }]);
      else expect([title, (await result).outcome]).toEqual([title, 'done']);
    }
  });

  it('does not rebuild when the preview is blocked or offers no rebuild', async () => {
    const w = world();
    w.state.preview = { ...w.state.preview, code: 'DOCKER_REBUILD_PLAN_MOVE_HELD', allowedActions: ['abandon'] };
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({ outcome: 'refused', detail: 'DOCKER_REBUILD_PLAN_MOVE_HELD' });
    w.state.preview = { ...w.state.preview, code: undefined, allowedActions: [] };
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).detail).toBe('the rebuild is not offered');
    w.state.preview = new DockerEmployeeContinuationError('DOCKER_REPROVISION_BUSY') as never;
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({ outcome: 'busy', detail: 'DOCKER_REPROVISION_BUSY' });
    w.state.retired = [];
    // No layout on record for anyone, and the employee's own laptop could not be read for one.
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).detail).toMatch(/^no laptop layout is on record for any laptop of this office/);
    expect(w.made('rebuild')).toEqual([]);
  });

  it('finishes a rebuild that is recorded but not finished by sending that same request again', async () => {
    const w = world();
    const pending = retired({ session: { phase: 'pending' } });
    w.state.retired = [pending];
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('no-laptop');
    w.state.rebuilt = { operationId: pending.operationId, state: 'held', code: 'DOCKER_REPROVISION_SOURCE_UNCONFIRMED' };
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({ outcome: 'refused', detail: 'DOCKER_REPROVISION_SOURCE_UNCONFIRMED' });
    w.state.rebuilt = { operationId: pending.operationId, state: 'ready' };
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('done');
    expect(w.made('preview')).toEqual([]);
    expect(w.made('rebuild')[0]).toEqual({
      operationId: pending.operationId,
      sessionId: EMPLOYEE.sessionId,
      sessionGeneration: 3,
      expectedScopeDigest: '5'.repeat(64),
      template: TEMPLATE,
    });
  });
});

describe('rebuilding a laptop whose office terminal can never be typed into again', () => {
  const HELD = ['terminal-input-held'] as const;
  const NOT_EMPTY = { outcome: 'refused', detail: 'a running laptop is not shown to be empty' };
  /** The one running laptop is the recorded one, an agent runs in it, and the terminal's input is held between turns. */
  const stuck = (terminal: Record<string, unknown> = {}) => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
    w.state.observed = { state: 'running', provider: { kind: 'running', operationId: 'o', sessionId: 's' } };
    w.state.session = { pid: 77, status: 'idle', isWorking: false, terminalInputHeld: true, lastActivityAt: 1000, ...terminal };
    return w;
  };

  it('confirms the discard when the policy chose the rebuild for that reason and the terminal, read again, still shows it', async () => {
    const w = stuck();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
    expect(w.made('rebuild')).toEqual([
      {
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        sessionId: EMPLOYEE.sessionId,
        sessionGeneration: 3,
        expectedScopeDigest: '6'.repeat(64),
        template: TEMPLATE,
        confirmDiscardRunning: true,
      },
    ]);
    expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination', 'rebuild']);
  });

  it('never confirms it without that reason, whatever the terminal shows', async () => {
    const w = stuck();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual(NOT_EMPTY);
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, [])).toEqual(NOT_EMPTY);
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, ['no-agent-running'])).toEqual(NOT_EMPTY);
    expect(w.made('rebuild')).toEqual([]);
  });

  it.each([
    ['the hold is gone', { terminalInputHeld: false }, { outcome: 'refused', detail: "the office terminal's input is not held" }],
    ['a turn began', { isWorking: true, status: 'busy' }, { outcome: 'busy', detail: 'the agent is in the middle of a turn' }],
    ['the pane only looks busy', { status: 'busy' }, { outcome: 'busy', detail: 'the agent is in the middle of a turn' }],
    ['the terminal has no process', { pid: null }, { outcome: 'refused', detail: "the office is not reading the agent's terminal" }],
    ['the terminal lost its client', { runtimeHealth: 'disconnected' }, { outcome: 'refused', detail: "the office is not reading the agent's terminal" }],
    ['the terminal is being reconnected', { viewerInputHeld: true }, { outcome: 'refused', detail: "the office is not reading the agent's terminal" }],
  ])('reads the terminal again and requests nothing when %s', async (_title, terminal, expected) => {
    const w = stuck(terminal);
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual(expected);
    expect(w.made('rebuild')).toEqual([]);
  });

  it('requests nothing when the office has no terminal object at all', async () => {
    const w = stuck();
    w.state.session = undefined;
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual({ outcome: 'refused', detail: "the office terminal's input is not held" });
    expect(w.made('rebuild')).toEqual([]);
  });

  it('reads the terminal last: a turn that begins while the laptop is being read stops the rebuild', async () => {
    const w = stuck();
    const running = w.state.observed;
    Object.defineProperty(w.state, 'observed', {
      get: () => {
        w.state.session = { ...w.state.session!, isWorking: true };
        return running;
      },
    });
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual({ outcome: 'busy', detail: 'the agent is in the middle of a turn' });
    expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination']);
  });

  it.each([
    ['the running laptop is not the recorded one', { state: 'running', provider: { kind: 'running' } }, ['f'.repeat(64)]],
    ['a second laptop runs', { state: 'running', provider: { kind: 'running' } }, [DESTINATION, 'f'.repeat(64)]],
  ])('confirms it only for the one recorded laptop: not when %s', async (_title, observed, running) => {
    const w = stuck();
    w.state.preview = { ...w.state.preview, runningLaptops: running };
    w.state.observed = observed;
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual(NOT_EMPTY);
    expect(w.made('rebuild')).toEqual([]);
  });

  it.each([
    ['the read inside the laptop cannot say what runs there', { state: 'running', provider: { kind: 'unknown' } }],
    ['the read inside the laptop fails', new Error('exec failed')],
  ])('judges the recorded laptop by the terminal alone when %s: that is never an empty laptop', async (_title, observed) => {
    const w = stuck();
    w.state.observed = observed;
    // Without the reason nothing is confirmed, as for any laptop that is not shown to be empty.
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual(NOT_EMPTY);
    // With it, the pane the office terminal shows decides: a turn in progress stops it, an idle pane allows it.
    w.state.session = { ...w.state.session!, isWorking: true };
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual({ outcome: 'busy', detail: 'the agent is in the middle of a turn' });
    w.state.session = { ...w.state.session!, isWorking: false };
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
    expect(w.made('rebuild')).toEqual([expect.objectContaining({ confirmDiscardRunning: true })]);
  });

  it('leaves the other cases as they were: an empty laptop needs no held terminal, and no running laptop needs no confirmation', async () => {
    const empty = stuck({ terminalInputHeld: false, isWorking: true });
    empty.state.observed = { state: 'running', provider: { kind: 'exited', exit: {} } };
    expect((await empty.laptops.rebuild(EMPLOYEE, empty.guard, HELD)).outcome).toBe('done');
    expect(empty.made('rebuild')).toEqual([expect.objectContaining({ confirmDiscardRunning: true })]);
    const none = stuck();
    none.state.preview = { ...none.state.preview, runningLaptops: [] };
    expect((await none.laptops.rebuild(EMPLOYEE, none.guard, HELD)).outcome).toBe('done');
    expect(none.made('rebuild')).toEqual([expect.not.objectContaining({ confirmDiscardRunning: true })]);
    expect(none.made('observeDestination')).toEqual([]);
  });

  it('holds the same fence while the rebuild runs, and does not take the stopping laptop’s output for a turn', async () => {
    const cases: Array<[string, (state: ReturnType<typeof world>['state']) => void, boolean]> = [
      ['a set-up step took flight', (state) => (state.flight = true), true],
      ['the office terminal was replaced', (state) => (state.session = { ...state.session!, pid: 99 }), true],
      ['the office terminal went away, as the rebuild itself does', (state) => (state.session = undefined), false],
      ['the stopping laptop printed into the pane', (state) => ((state.session as Record<string, unknown>).isWorking = true), false],
    ];
    for (const [title, change, stops] of cases) {
      const w = stuck();
      w.state.during = () => change(w.state);
      const result = await w.laptops.rebuild(EMPLOYEE, w.guard, HELD);
      if (stops) expect([title, result]).toEqual([title, { outcome: expect.stringMatching(/busy|refused/), detail: expect.stringMatching(/^DOCKER_/) }]);
      else expect([title, result.outcome]).toEqual([title, 'done']);
    }
  });

  it('presents the supervisor’s own authority for it and is refused once the switch is off', async () => {
    const w = stuck();
    w.state.during = () => (w.state.guard = false);
    await expect(w.laptops.rebuild(EMPLOYEE, w.guard, HELD)).rejects.toThrow(/switched off/);
  });
});

describe('rebuilding a laptop whose agent is parked on a provider start-up screen', () => {
  const PARKED = ['agent-parked-at-screen'] as const;
  const NOT_EMPTY = { outcome: 'refused', detail: 'a running laptop is not shown to be empty' };
  const NOT_PARKED = { outcome: 'refused', detail: 'the agent is not shown to be parked on a start-up screen' };
  const NOT_READ = { outcome: 'refused', detail: "the office is not reading the agent's terminal" };
  /** A turn that began tried nothing: the attempt is given back and the step is asked again later. */
  const IN_A_TURN = { outcome: 'busy', detail: 'the agent is in the middle of a turn' };
  const signIn = { label: "Claude's sign-in screen", kind: 'credential', answering: false, shown: 'widget' };
  /** The one running laptop is the recorded one, an agent runs in it, and the office terminal shows it parked. */
  const parked = (terminal: Record<string, unknown> = {}) => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
    w.state.observed = { state: 'running', provider: { kind: 'running', operationId: 'o', sessionId: 's' } };
    w.state.session = { pid: 77, status: 'idle', isWorking: false, lastActivityAt: 1000, startupScreen: () => signIn, ...terminal };
    return w;
  };

  it('confirms the discard when the policy chose the rebuild for that reason and the pane, read again, still shows it', async () => {
    const w = parked();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, PARKED)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
    expect(w.made('rebuild')).toEqual([expect.objectContaining({ template: TEMPLATE, confirmDiscardRunning: true })]);
    expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination', 'rebuild']);
    // A screen the office cannot read, proved by its own launch, is the same reason.
    const unread = parked({ startupScreen: () => ({ label: "Claude's theme chooser", kind: 'first-run', answering: false, shown: 'launch' }) });
    expect((await unread.laptops.rebuild(EMPLOYEE, unread.guard, PARKED)).outcome).toBe('done');
  });

  it('never confirms it without that reason, whatever the pane shows', async () => {
    const w = parked();
    for (const proved of [undefined, [], ['no-agent-running'], ['terminal-input-held']] as const)
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard, proved)).outcome).toBe('refused');
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, [])).toEqual(NOT_EMPTY);
    expect(w.made('rebuild')).toEqual([]);
  });

  it.each([
    ['the screen is gone', { startupScreen: () => null }, NOT_PARKED],
    ['only words about the screen are on the pane', { startupScreen: () => ({ ...signIn, shown: 'words' }) }, NOT_PARKED],
    ['the office is answering the screen itself again', { startupScreen: () => ({ label: 'x', kind: 'first-run', answering: true, shown: 'widget' }) }, NOT_PARKED],
    ['the agent began to work', { isWorking: true, status: 'busy' }, IN_A_TURN],
    ['the pane cannot be read', { startupScreen: () => { throw new Error('tmux gone'); } }, NOT_PARKED],
    ['the terminal has no process', { pid: null }, NOT_PARKED],
    ['the terminal lost its client', { runtimeHealth: 'disconnected' }, NOT_PARKED],
    ['the terminal is being reconnected', { viewerInputHeld: true }, NOT_PARKED],
    ['the terminal is not idle', { status: 'error' }, NOT_READ],
    ['the pane prints while its screen is up', { isWorking: true }, IN_A_TURN],
  ])('reads the pane again and requests nothing when %s', async (_title, terminal, expected) => {
    const w = parked(terminal);
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, PARKED)).toEqual(expected);
    expect(w.made('rebuild')).toEqual([]);
  });

  it('requests nothing when the office has no terminal object at all', async () => {
    const w = parked();
    w.state.session = undefined;
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, PARKED)).toEqual(NOT_PARKED);
    expect(w.made('rebuild')).toEqual([]);
  });

  it('reads the pane last: a screen that clears while the laptop is being read stops the rebuild', async () => {
    const w = parked();
    const running = w.state.observed;
    Object.defineProperty(w.state, 'observed', {
      get: () => {
        w.state.session = { ...w.state.session!, startupScreen: () => null };
        return running;
      },
    });
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, PARKED)).toEqual(NOT_PARKED);
    expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination']);
  });

  it.each([
    ['the running laptop is not the recorded one', { state: 'running', provider: { kind: 'running' } }, ['f'.repeat(64)]],
    ['a second laptop runs', { state: 'running', provider: { kind: 'running' } }, [DESTINATION, 'f'.repeat(64)]],
  ])('confirms it only for the one recorded laptop: not when %s', async (_title, observed, running) => {
    const w = parked();
    w.state.preview = { ...w.state.preview, runningLaptops: running };
    w.state.observed = observed;
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, PARKED)).toEqual(NOT_EMPTY);
    expect(w.made('rebuild')).toEqual([]);
  });

  it.each([
    ['cannot say what runs in the laptop', { state: 'running', provider: { kind: 'unknown' } }],
    ['fails', new Error('exec failed')],
  ])('goes by the pane when the read inside the laptop %s: that counts as an agent running, and the pane shows it parked', async (_title, observed) => {
    const w = parked();
    w.state.observed = observed;
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard, PARKED)).outcome).toBe('done');
    // Without the screen on the pane the same read refuses.
    const gone = parked({ startupScreen: () => null });
    gone.state.observed = observed;
    expect(await gone.laptops.rebuild(EMPLOYEE, gone.guard, PARKED)).toEqual(NOT_PARKED);
  });

  it('keeps the screen as what must be proved when the long wait for an unread pane has passed', async () => {
    // A terminal that is neither idle nor working shows no turn. With `agent-unreadable` that is no longer a refusal,
    // and the screen still is: the pane must show it by more than its words.
    const both = ['agent-parked-at-screen', 'agent-unreadable'] as const;
    const unread = parked({ status: 'error' });
    expect(await unread.laptops.rebuild(EMPLOYEE, unread.guard, PARKED)).toEqual(NOT_READ);
    expect((await unread.laptops.rebuild(EMPLOYEE, unread.guard, both)).outcome).toBe('done');
    const words = parked({ status: 'error', startupScreen: () => ({ ...signIn, shown: 'words' }) });
    expect(await words.laptops.rebuild(EMPLOYEE, words.guard, both)).toEqual(NOT_PARKED);
    const detached = parked({ runtimeHealth: 'disconnected' });
    expect(await detached.laptops.rebuild(EMPLOYEE, detached.guard, both)).toEqual(NOT_PARKED);
  });

  it('holds the fence of every such rebuild: a step that takes flight or a replaced terminal stops it', async () => {
    const flight = parked();
    flight.state.during = () => (flight.state.flight = true);
    expect(await flight.laptops.rebuild(EMPLOYEE, flight.guard, PARKED)).toEqual({ outcome: 'busy', detail: 'DOCKER_CONTINUATION_BUSY' });
    const replaced = parked();
    replaced.state.during = () => (replaced.state.session = { ...replaced.state.session!, pid: 78 });
    expect((await replaced.laptops.rebuild(EMPLOYEE, replaced.guard, PARKED)).outcome).toBe('refused');
  });
});

describe('the owner’s standing defaults for an employee who has no limits or no layout', () => {
  const GIB = 1024 ** 3;
  const POOL = { memoryMaxBytes: 64 * GIB, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1, 2, 3] };
  const limits = (patch: Record<string, unknown> = {}) => ({
    memoryMaxBytes: 16 * GIB,
    memoryHighBytes: 12 * GIB,
    swapMaxBytes: 0,
    pidsMax: 2048,
    cpuWeight: 100,
    allowedCpus: [0, 1, 2, 3],
    pool: POOL,
    ...patch,
  });
  const DRIVE = { source: '/host/drive', destination: '/reverie_workspace', readOnly: false };
  const PROJECT = { source: '/host/projects/x', destination: '/projects/x', readOnly: false };
  const layout = (patch: Record<string, unknown> = {}) => ({
    user: '1000:1000',
    scratchRoot: '/host/scratch/laptops',
    mounts: [DRIVE],
    workspaceAlias: true,
    ...patch,
  });
  const otherId = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  /** Another employee of the same company, with what the owner approved for them. */
  const other = (n: number, policy?: unknown, owner?: string) => ({
    id: otherId(n),
    owner,
    ...(policy ? { dockerResourcePolicy: policy } : {}),
  });
  const laptopOf = (n: number, template: unknown) =>
    retired({ employeeId: otherId(n), operationId: `0000000${n}-1111-4111-8111-111111111111`, template });
  /** The employee has neither limits nor a layout; two others have both. */
  const bare = () => {
    const w = world();
    w.state.approved = false;
    w.state.record = undefined;
    w.state.retired = [laptopOf(1, layout()), laptopOf(2, layout({ mounts: [DRIVE, PROJECT] }))];
    w.state.others = [other(1, limits()), other(2, limits({ memoryMaxBytes: 8 * GIB, memoryHighBytes: null, allowedCpus: [1, 2] }))];
    return w;
  };

  describe('limits', () => {
    it('are the smallest of each value approved for the others, in the pool they all share', () => {
      expect(standingLimits([limits(), limits({ memoryMaxBytes: 8 * GIB, memoryHighBytes: null, pidsMax: 4096, cpuWeight: 50, allowedCpus: [1, 2] })] as never)).toEqual({
        memoryMaxBytes: 8 * GIB,
        // The one soft limit among them is above the smallest hard limit, so it is given as that hard limit.
        memoryHighBytes: 8 * GIB,
        swapMaxBytes: 0,
        pidsMax: 2048,
        cpuWeight: 50,
        allowedCpus: [1, 2],
        pool: POOL,
      });
      expect(standingLimits([limits({ memoryHighBytes: null })] as never)).toMatchObject({ memoryHighBytes: null });
    });

    it('do not exist where nothing is approved, the pools differ, or the others share no processor', () => {
      expect(standingLimits([])).toBeUndefined();
      expect(standingLimits([limits(), limits({ pool: { ...POOL, pidsMax: 4096 } })] as never)).toBeUndefined();
      expect(standingLimits([limits({ allowedCpus: [0] }), limits({ allowedCpus: [3] })] as never)).toBeUndefined();
    });

    it('are saved through the store behind the owner’s route, under the supervisor’s authority', async () => {
      const w = bare();
      expect(w.laptops.glance(EMPLOYEE.id)).toMatchObject({ policyApproved: false, standing: { enabled: true, limits: true } });
      const result = await w.laptops.applyStandingLimits(EMPLOYEE, w.guard);
      const expected = limits({ memoryMaxBytes: 8 * GIB, memoryHighBytes: 8 * GIB, allowedCpus: [1, 2] });
      expect(result).toEqual({ outcome: 'done', detail: 'standing limits ' + dockerContinuationDigest(expected).slice(0, 12) });
      expect(w.state.saved).toEqual([[EMPLOYEE.id, undefined, expected]]);
      expect(w.laptops.glance(EMPLOYEE.id).policyApproved).toBe(true);
      // Limits that are approved are never written over.
      expect(await w.laptops.applyStandingLimits(EMPLOYEE, w.guard)).toEqual({
        outcome: 'refused',
        detail: 'no standing default limits to give',
      });
      expect(w.state.saved).toHaveLength(1);
    });

    it('reads only the other employees of the same company', async () => {
      const w = bare();
      w.state.others = [other(1, limits(), 'someone-else')];
      expect(w.laptops.glance(EMPLOYEE.id).standing).toMatchObject({ limits: false });
      expect((await w.laptops.applyStandingLimits(EMPLOYEE, w.guard)).outcome).toBe('refused');
      expect(w.state.saved).toEqual([]);
    });

    it('are not given once the owner switched the standing defaults off', async () => {
      const w = bare();
      w.state.settings = [{ owner: undefined, supervisorStandingDefaults: false }];
      expect(w.laptops.glance(EMPLOYEE.id).standing).toEqual({ enabled: false, limits: true, layout: true });
      expect(await w.laptops.applyStandingLimits(EMPLOYEE, w.guard)).toEqual({
        outcome: 'refused',
        detail: 'no standing default limits to give',
      });
      expect(w.state.saved).toEqual([]);
    });

    it.each([
      ['the owner switches the defaults off', (w: ReturnType<typeof world>) => (w.state.settings = [{ supervisorStandingDefaults: false }])],
      ['the limits of another employee change', (w: ReturnType<typeof world>) => (w.state.others = [other(1, limits({ pidsMax: 64 }))])],
      ['the employee is given limits by the owner', (w: ReturnType<typeof world>) => (w.state.approved = true)],
    ])('reads everything again inside the save and writes nothing when %s meanwhile', async (_title, change) => {
      const w = bare();
      w.state.duringSave = () => change(w);
      expect(await w.laptops.applyStandingLimits(EMPLOYEE, w.guard)).toEqual({
        outcome: 'refused',
        detail: 'The standing default limits changed',
      });
      expect(w.state.saved).toEqual([]);
    });

    it('holds the supervisor’s authority inside the save', async () => {
      const w = bare();
      w.state.duringSave = () => (w.state.guard = false);
      await expect(w.laptops.applyStandingLimits(EMPLOYEE, w.guard)).rejects.toThrow(/switched off/);
      expect(w.state.saved).toEqual([]);
    });
  });

  describe('layout', () => {
    /** What the other laptops share is given read-only: nobody is given a drive to write on by somebody else's layout. */
    const shared = (patch: Record<string, unknown> = {}) => layout({ mounts: [{ ...DRIVE, readOnly: true }], ...patch });

    it('taken from the other laptops, is their user, their scratch root and the drives all of them have, read-only', () => {
      expect(standingLayout([layout(), layout({ mounts: [DRIVE, PROJECT] })] as never)).toEqual(shared());
      // No alias unless all of them have it.
      expect(standingLayout([layout(), layout({ workspaceAlias: undefined })] as never)).toEqual({
        user: '1000:1000',
        scratchRoot: '/host/scratch/laptops',
        mounts: [{ ...DRIVE, readOnly: true }],
      });
      // What belongs to one employee alone is never copied.
      expect(standingLayout([layout({ network: 'reverie-boxed-api-one', accountSource: '/host/seats/plan-a' })] as never)).toEqual(shared());
    });

    const HOME = '/host/state/employees/' + EMPLOYEE.id + '/home';
    const SEAT = '/instances/default/console/accounts/plan-a';
    /** The employee's own last laptop, as the Engine describes it. */
    const own = (patch: Record<string, unknown> = {}) => ({
      user: '1000:1000',
      mounts: [
        { source: '/host/drive', destination: '/reverie_workspace', readOnly: false },
        { source: '/host/drive', destination: '/workspace', readOnly: false },
        { source: '/host/projects/x', destination: '/projects/x', readOnly: true },
        { source: '/host/scratch/laptops/employees/' + EMPLOYEE.id, destination: '/scratch', readOnly: false },
        { source: HOME, destination: '/home/agent', readOnly: false },
        { source: '/host/state/nix', destination: '/nix', readOnly: false },
        { source: '/host/seats/plan-a', destination: SEAT, readOnly: false },
      ],
      networks: ['bridge', 'reverie-boxed-api-stan'],
      ...patch,
    });
    const mine = { employeeId: EMPLOYEE.id, home: HOME, seatProfile: 'plan-a' };

    it('is read from the employee’s own last laptop first: its user, its drives as they were, its network and its seat', () => {
      expect(layoutFor({ ...mine, own: own(), others: [] })).toEqual({
        layout: {
          user: '1000:1000',
          scratchRoot: '/host/scratch/laptops',
          mounts: [
            { source: '/host/drive', destination: '/reverie_workspace', readOnly: false },
            { source: '/host/projects/x', destination: '/projects/x', readOnly: true },
          ],
          workspaceAlias: true,
          network: 'reverie-boxed-api-stan',
          accountSource: '/host/seats/plan-a',
        },
      });
      // The other laptops' drives are not added to what this one had.
      const others = [layout({ mounts: [DRIVE, PROJECT] })] as never;
      expect(layoutFor({ ...mine, own: own({ mounts: own().mounts.slice(3) }), others })).toMatchObject({ layout: { mounts: [] } });
    });

    it('names no seat folder for a seat the laptop keeps in its home, or for an employee on no plan', () => {
      const inHome = own({
        mounts: [...own().mounts.slice(0, 6), { source: HOME + '/.reverie/seat-auth/plan-a', destination: SEAT, readOnly: false }],
      });
      expect(layoutFor({ ...mine, own: inHome, others: [] })).toMatchObject({ layout: expect.not.objectContaining({ accountSource: expect.anything() }) });
      expect(layoutFor({ employeeId: EMPLOYEE.id, home: HOME, own: own(), others: [] })).toMatchObject({
        layout: expect.not.objectContaining({ accountSource: expect.anything() }),
      });
    });

    it('takes from the other laptops only what its own cannot say: the scratch root of a laptop from before that layout', () => {
      const old = own({ mounts: own().mounts.filter((mount) => mount.destination !== '/scratch') });
      expect(layoutFor({ ...mine, own: old, others: [] })).toEqual({
        missing: 'no laptop of this office says where scratch space is kept, and this one does not either',
      });
      expect(layoutFor({ ...mine, own: old, others: [layout()] as never })).toMatchObject({
        layout: { scratchRoot: '/host/scratch/laptops', mounts: [expect.objectContaining({ readOnly: false }), expect.anything()] },
      });
    });

    it('without a laptop of its own to read, gives what the others share, and refuses when the plan needs a seat', () => {
      expect(layoutFor({ employeeId: EMPLOYEE.id, home: HOME, others: [layout(), layout()] as never })).toEqual({ layout: shared() });
      expect(layoutFor({ ...mine, others: [layout()] as never })).toEqual({
        missing:
          "the folder of this employee's plan sign-in cannot be told: their last laptop could not be read, and a " +
          'laptop built without it would stop at the sign-in screen',
      });
      expect(layoutFor({ employeeId: EMPLOYEE.id, home: HOME, others: [] })).toEqual({
        missing: 'no laptop layout is on record for any laptop of this office, and this employee has no laptop to read one from',
      });
    });

    it('reads a laptop from what the Engine says of its container', () => {
      expect(
        ownLaptop({
          Config: { User: '1000:1000' },
          Mounts: [
            { Type: 'bind', Source: '/host/drive', Destination: '/workspace', RW: true },
            { Type: 'bind', Source: '/host/tools', Destination: '/instances/default/tools', RW: false },
            { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/data', RW: true },
          ],
          NetworkSettings: { Networks: { 'reverie-boxed-api-stan': {}, bridge: {} } },
        })
      ).toEqual({
        user: '1000:1000',
        mounts: [
          { source: '/host/drive', destination: '/workspace', readOnly: false },
          { source: '/host/tools', destination: '/instances/default/tools', readOnly: true },
        ],
        networks: ['reverie-boxed-api-stan', 'bridge'],
      });
      expect(ownLaptop({ Config: {} })).toBeUndefined();
      expect(ownLaptop(null)).toBeUndefined();
    });

    it('does not exist where no laptop has one or they differ in user or scratch root', () => {
      expect(standingLayout([])).toBeUndefined();
      expect(standingLayout([layout(), layout({ user: '1001:1001' })] as never)).toBeUndefined();
      expect(standingLayout([layout(), layout({ scratchRoot: '/elsewhere/laptops' })] as never)).toBeUndefined();
    });

    it('is what a rebuild and its read use for an employee with no layout of their own', async () => {
      const w = bare();
      w.state.approved = true;
      w.state.record = { version: 2, phase: 'resources-issued', request: REQUEST, destination: { containerId: DESTINATION } };
      expect(w.laptops.glance(EMPLOYEE.id)).toMatchObject({ templateOnRecord: false, standing: { enabled: true, layout: true } });
      expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('no-laptop');
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
      // No laptop of the employee could be read here, so it is what the others share, read-only.
      expect(w.made('preview')).toEqual([shared(), shared()]);
      expect(w.made('rebuild')).toEqual([expect.objectContaining({ template: shared() })]);
      expect(w.made('inspect')).toEqual([DESTINATION, DESTINATION]);
    });

    it('reads the employee’s own laptop for it, and builds with what that laptop had', async () => {
      const w = bare();
      w.state.approved = true;
      w.state.plan = 'plan-a';
      w.state.record = {
        version: 2,
        phase: 'resources-issued',
        request: REQUEST,
        original: { containerId: 'a'.repeat(64), home: { source: HOME } },
        destination: { containerId: DESTINATION, home: { source: HOME } },
      };
      w.state.inspect = own();
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('done');
      expect(w.made('rebuild')).toEqual([
        expect.objectContaining({
          template: expect.objectContaining({
            network: 'reverie-boxed-api-stan',
            accountSource: '/host/seats/plan-a',
            mounts: [expect.objectContaining({ destination: '/reverie_workspace', readOnly: false }), expect.anything()],
          }),
        }),
      ]);
      // The laptop cannot be read and the plan needs its seat: nothing is built, and the step says why.
      w.state.inspect = new Error('No such container');
      w.state.calls.length = 0;
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({
        outcome: 'refused',
        detail: expect.stringMatching(/^the folder of this employee's plan sign-in cannot be told/),
      });
      expect(w.made('rebuild')).toEqual([]);
      expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('unknown');
    });

    it('never replaces a layout the employee has, and is not used once the owner switched the defaults off', async () => {
      const own = world();
      own.state.retired = [...own.state.retired, laptopOf(1, layout())];
      own.state.others = [other(1)];
      await own.laptops.rebuild(EMPLOYEE, own.guard);
      expect(own.made('rebuild')).toEqual([expect.objectContaining({ template: TEMPLATE })]);
      const off = bare();
      off.state.approved = true;
      off.state.settings = [{ supervisorStandingDefaults: false }];
      expect(await off.laptops.provider(EMPLOYEE, off.guard)).toBe('unknown');
      expect(await off.laptops.rebuild(EMPLOYEE, off.guard)).toEqual({
        outcome: 'refused',
        detail: 'no approved laptop layout on record',
      });
      expect(off.state.calls).toEqual([]);
    });
  });
});

describe('rebuilding any laptop an agent runs in, between that agent’s turns', () => {
  const BETWEEN = ['agent-between-turns'] as const;
  const NOT_EMPTY = { outcome: 'refused', detail: 'a running laptop is not shown to be empty' };
  const BUSY = { outcome: 'busy', detail: 'the agent is in the middle of a turn' };
  const UNREAD = { outcome: 'refused', detail: "the office is not reading the agent's terminal" };
  /** The one running laptop is the recorded one and an agent runs in it. The terminal takes input and is idle. */
  const occupied = (terminal: Record<string, unknown> = {}) => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
    w.state.observed = { state: 'running', provider: { kind: 'running', operationId: 'o', sessionId: 's' } };
    w.state.session = { pid: 77, status: 'idle', isWorking: false, lastActivityAt: 1000, ...terminal };
    return w;
  };

  it('confirms the discard when the terminal, read again, shows no turn in progress', async () => {
    const w = occupied();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
    expect(w.made('rebuild')).toEqual([expect.objectContaining({ confirmDiscardRunning: true })]);
    expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination', 'rebuild']);
  });

  it.each([
    ['a turn is in progress', { isWorking: true, status: 'busy' }, BUSY],
    ['the pane only looks busy', { status: 'busy' }, BUSY],
    ['the terminal has no process', { pid: null }, UNREAD],
    ['the terminal lost its client', { runtimeHealth: 'disconnected' }, UNREAD],
  ])('requests nothing when %s', async (_title, terminal, expected) => {
    const w = occupied(terminal);
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).toEqual(expected);
    expect(w.made('rebuild')).toEqual([]);
  });

  it('requests nothing without a terminal object, and nothing for a laptop that is not the one recorded', async () => {
    const gone = occupied();
    gone.state.session = undefined;
    expect(await gone.laptops.rebuild(EMPLOYEE, gone.guard, BETWEEN)).toEqual(UNREAD);
    for (const running of [['f'.repeat(64)], [DESTINATION, 'f'.repeat(64)]]) {
      const w = occupied();
      w.state.preview = { ...w.state.preview, runningLaptops: running };
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard, [...BETWEEN, 'agent-unreadable'])).toEqual(NOT_EMPTY);
      expect(w.made('rebuild')).toEqual([]);
    }
  });

  it('reads the laptop’s own hold once more where that is the reason, and keeps a laptop that has finished', async () => {
    const w = occupied();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, [...BETWEEN, 'laptop-held'])).toEqual({
      outcome: 'refused',
      detail: 'the laptop is no longer held',
    });
    expect(w.state.calls.map(([name]) => name)).toEqual(['observe']);
    w.state.result = { ...w.state.result, state: 'held', code: 'DOCKER_RESOURCE_HELPER_FAILED' };
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, [...BETWEEN, 'laptop-held'])).toEqual({ outcome: 'done', detail: 'rebuilt new' });
  });

  describe('a pane the office cannot read at all, after the long wait for a reading', () => {
    const BLIND = ['agent-unreadable'] as const;

    it('is rebuilt without a reading, but never against one that shows a turn', async () => {
      const gone = occupied();
      gone.state.session = undefined;
      expect(await gone.laptops.rebuild(EMPLOYEE, gone.guard, BLIND)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
      expect(gone.made('rebuild')).toEqual([expect.objectContaining({ confirmDiscardRunning: true })]);
      expect(await occupied({ pid: null }).laptops.rebuild(EMPLOYEE, () => {}, BLIND)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
      const working = occupied({ isWorking: true, status: 'busy' });
      expect(await working.laptops.rebuild(EMPLOYEE, working.guard, BLIND)).toEqual(BUSY);
      expect(working.made('rebuild')).toEqual([]);
    });

    it('for a held terminal input, takes the hold from the saved session record once the office has no terminal object', async () => {
      const HELD_BLIND = ['terminal-input-held', 'agent-unreadable'] as const;
      const w = occupied();
      w.state.session = undefined;
      // As after an office restart. Without the saved record saying so, the reason is not proved.
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD_BLIND)).toEqual({
        outcome: 'refused',
        detail: "the office terminal's input is not held",
      });
      w.state.heldOnRecord = true;
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard, HELD_BLIND)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
      // A terminal object's own word is taken over the record's.
      w.state.session = { pid: 77, status: 'idle', isWorking: false, terminalInputHeld: false };
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard, HELD_BLIND)).detail).toBe("the office terminal's input is not held");
      // Without the long wait, an unread pane still refuses, held on record or not.
      w.state.session = undefined;
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard, ['terminal-input-held'])).toEqual(UNREAD);
    });
  });
});

describe('proving "between turns" up to the moment a laptop is stopped', () => {
  const BETWEEN = ['agent-between-turns'] as const;
  const BUSY_TURN = { outcome: 'busy', detail: 'the agent is in the middle of a turn' };
  const SESSION = EMPLOYEE.sessionId;
  /** The one running laptop is the recorded one, an agent runs in it, and its pane has been idle since `quietSince`. */
  const occupied = (quietSince = 1000, terminal: Record<string, unknown> = {}) => {
    const w = world();
    w.state.preview = { ...w.state.preview, runningLaptops: [DESTINATION] };
    w.state.observed = { state: 'running', provider: { kind: 'running', operationId: 'o', sessionId: 's' } };
    w.state.session = { pid: 77, status: 'idle', isWorking: false, lastActivityAt: quietSince, lastPromptTime: quietSince, ...terminal };
    return w;
  };

  it('asks for the same two silent minutes as the policy, at the step itself', async () => {
    const w = occupied();
    w.state.session = { ...w.state.session!, lastActivityAt: w.state.now - 119_000 };
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).toEqual({
      outcome: 'busy',
      detail: "the agent's terminal has not been silent for two minutes",
    });
    expect(w.made('rebuild')).toEqual([]);
    w.state.session = { ...w.state.session!, lastActivityAt: w.state.now - 120_000 };
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).outcome).toBe('done');
    // An idle pane with no time on it is no reading at all.
    const timeless = occupied(0);
    expect(await timeless.laptops.rebuild(EMPLOYEE, timeless.guard, BETWEEN)).toEqual({
      outcome: 'refused',
      detail: "the office is not reading the agent's terminal",
    });
  });

  it.each([
    ['a turn starts', (s: Record<string, unknown>) => (s.isWorking = true)],
    ['the pane prints', (s: Record<string, unknown>) => (s.lastActivityAt = 9 * 60_000)],
    ['a prompt is submitted', (s: Record<string, unknown>) => (s.lastPromptTime = 9 * 60_000)],
  ])('stops nothing when %s after the proof and before the stop, and gives the attempt back', async (_title, change) => {
    const w = occupied();
    w.state.beforeStop = () => change(w.state.session as Record<string, unknown>);
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).toEqual(BUSY_TURN);
    // The same at the last look, the one the service asks for immediately before it stops the laptop.
    const last = occupied();
    const state = last.state;
    let asked = 0;
    const session = state.session as Record<string, unknown>;
    Object.defineProperty(state, 'session', {
      get: () => {
        // The proof, the fence's own start, the service's check, and then the look that precedes the stop.
        if (++asked === 6) change(session);
        return session;
      },
    });
    expect(await last.laptops.rebuild(EMPLOYEE, last.guard, BETWEEN)).toEqual(BUSY_TURN);
  });

  it('does not take what a stopping laptop prints for a turn', async () => {
    const w = occupied();
    w.state.during = () => {
      const session = w.state.session as Record<string, unknown>;
      session.isWorking = true;
      session.lastActivityAt = w.state.now;
    };
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).outcome).toBe('done');
  });

  it('asks the pane nothing more of a laptop that a read showed to be empty', async () => {
    const w = occupied();
    w.state.observed = { state: 'running', provider: { kind: 'exited', exit: {} } };
    w.state.beforeStop = () => ((w.state.session as Record<string, unknown>).isWorking = true);
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('done');
    // Input is held all the same while a running laptop is stopped: nothing is typed into a pane that is going.
    expect(w.state.holds).toEqual(['hold ' + SESSION, 'release ' + SESSION]);
  });

  describe('holding input to the session meanwhile', () => {
    it('takes the hold before the last look at the pane and releases it when the rebuild has returned', async () => {
      const w = occupied();
      const order: string[] = [];
      w.state.beforeStop = () => order.push('service called with ' + w.state.holds.join(','));
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).outcome).toBe('done');
      expect(order).toEqual(['service called with hold ' + SESSION]);
      expect(w.state.holds).toEqual(['hold ' + SESSION, 'release ' + SESSION]);
      // The hold is in place before the pane is read for the proof: a wake cannot slip in between.
      const early = occupied();
      const session = early.state.session;
      let heldAtProof: boolean | undefined;
      Object.defineProperty(early.state, 'session', {
        get: () => {
          heldAtProof ??= early.state.holds.length === 1;
          return session;
        },
      });
      await early.laptops.rebuild(EMPLOYEE, early.guard, BETWEEN);
      expect(heldAtProof).toBe(true);
    });

    it.each<[string, (w: ReturnType<typeof world>) => void, RegExp | undefined]>([
      ['the pane shows a turn', (w) => ((w.state.session as Record<string, unknown>).isWorking = true), undefined],
      ['a turn starts before the stop', (w) => (w.state.beforeStop = () => ((w.state.session as Record<string, unknown>).isWorking = true)), undefined],
      ['the service refuses', (w) => (w.state.rebuilt = { operationId: 'new', state: 'held', code: 'DOCKER_REBUILD_REMOVAL_UNCONFIRMED' }), undefined],
      ['the service throws a refusal', (w) => (w.state.during = () => { throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_BUSY'); }), undefined],
      ['the supervisor is switched off meanwhile', (w) => (w.state.during = () => (w.state.guard = false)), /switched off/],
    ])('releases the hold when %s', async (_title, arrange, throws) => {
      const w = occupied();
      arrange(w);
      if (throws) await expect(w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).rejects.toThrow(throws);
      else expect((await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).outcome).not.toBe('done');
      expect(w.state.holds).toEqual(['hold ' + SESSION, 'release ' + SESSION]);
    });

    it('reads the stored home after the proof and before the stop, under the hold', async () => {
      const w = occupied();
      const order: string[] = [];
      w.state.beforeStop = () => order.push('service');
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).outcome).toBe('done');
      // The proof (the read inside the laptop), then the home under the hold, then the service with its own last
      // look and the stop.
      expect(w.state.homeReads).toEqual([{ holds: 'hold ' + SESSION, after: ['preview', 'observeDestination'] }]);
      expect(w.state.calls.map(([name]) => name)).toEqual(['preview', 'observeDestination', 'rebuild']);
      expect(order).toEqual(['service']);
    });

    it.each([
      [{ state: 'unconfirmed', cause: 'verifier-timed-out' }, 'the stored home could not be read'],
      [{ state: 'renumbered', reason: 'no-record-no-grant' }, 'the stored home has a new device number that nothing accepts'],
      [{ state: 'different' }, 'the stored home is not the directory the laptop was built on'],
    ])('releases the hold and gives the attempt back when the stored home reads %j', async (stored, detail) => {
      const w = occupied();
      w.state.stored = stored;
      // Nothing was stopped and nothing was tried: the attempt is not spent, and input flows again.
      expect(await w.laptops.rebuild(EMPLOYEE, w.guard, BETWEEN)).toEqual({ outcome: 'busy', detail });
      expect(w.made('rebuild')).toEqual([]);
      expect(w.state.holds).toEqual(['hold ' + SESSION, 'release ' + SESSION]);
    });

    it('is not taken for a rebuild that stops no running laptop', async () => {
      const w = world();
      expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('done');
      expect(w.state.holds).toEqual([]);
    });
  });
});
