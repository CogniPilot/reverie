import { describe, expect, it } from 'vitest';
import { CompanyError } from '../src/company-service.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
} from '../src/docker-employee-continuation.js';
import { DockerSupervisorLaptops, type DockerSupervisorLaptopDeps } from '../src/docker-employee-supervisor-laptops.js';
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
    session: { pid: 77 } as { pid: number | null } | undefined,
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
            { id: EMPLOYEE.id, dockerBinding: {}, ...(state.approved ? { dockerResourcePolicy: state.policy } : {}) },
          ],
          retiredDockerEmployeeContinuations: state.retired,
        }),
      },
    },
    store: { record: () => state.record, policy: () => state.policy },
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
        state.during?.();
        authority.require();
        return state.rebuilt;
      },
    },
    sessions: { get: () => state.session },
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
    });
    w.state.retired = [];
    w.state.record = undefined;
    w.state.approved = false;
    expect(w.laptops.glance(EMPLOYEE.id)).toEqual({ record: null, bound: true, policyApproved: false, templateOnRecord: false });
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
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).detail).toBe('no approved laptop layout on record');
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
