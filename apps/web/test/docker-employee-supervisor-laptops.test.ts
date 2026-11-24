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
        return state.selection;
      },
      begin: async (_id: string, request: unknown, authority: DockerContinuationAuthority) => {
        took('begin', request, authority);
        if (state.result instanceof Error) throw state.result;
        return state.result;
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
    expect(w.state.calls).toEqual([]);
    // A read reports what it could not confirm instead of throwing.
    expect(await w.laptops.read(EMPLOYEE, w.guard)).toMatchObject({ state: 'held', code: 'DOCKER_CONTINUATION_UNCONFIRMED' });
    expect(await w.laptops.source(EMPLOYEE, w.guard)).toBe('unknown');
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
});
