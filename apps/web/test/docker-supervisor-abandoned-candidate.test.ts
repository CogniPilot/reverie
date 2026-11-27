/**
 * What an abandoned plan move leaves behind for the supervisor's rebuild: the candidate laptop it built for the
 * new plan. No Engine and no journal here; the services are answered by the test.
 */
import { describe, expect, it } from 'vitest';
import type { DockerContinuationAuthority } from '../src/docker-employee-continuation.js';
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
/** The employee's recorded laptop, which the move stopped, and the candidate the move built. */
const SOURCE = 'd'.repeat(64);
const CANDIDATE = 'c'.repeat(64);
const OTHER = 'f'.repeat(64);
const TEMPLATE = { user: '1000:1000', scratchRoot: '/host/scratch/laptops', mounts: [] };
type Seen = { state: string; provider: { kind: string } } | null | Error;

function world() {
  const state = {
    running: [CANDIDATE] as string[],
    /** What a read inside each container finds. */
    inside: new Map<string, Seen>([[CANDIDATE, { state: 'running', provider: { kind: 'absent' } }]]),
    candidates: [{ moveId: 'move-1', record: { version: 3, destination: { containerId: CANDIDATE } } }] as unknown[],
    journal: undefined as Error | undefined,
    withJournal: true,
    read: [] as string[],
    rebuilds: [] as Array<Record<string, unknown>>,
  };
  const took = <T>(answer: T, authority: DockerContinuationAuthority): T => {
    authority.require();
    return answer;
  };
  const deps = {
    company: {
      recoveryAction: () => ({ current: () => true, require: () => {} }),
      store: {
        snapshot: () => ({
          employees: [{ id: EMPLOYEE.id, dockerBinding: {} }],
          retiredDockerEmployeeContinuations: [
            {
              employeeId: EMPLOYEE.id,
              operationId: '44444444-4444-4444-8444-444444444444',
              sessionId: EMPLOYEE.sessionId,
              sessionGeneration: 3,
              scopeDigest: '5'.repeat(64),
              template: TEMPLATE,
              source: { phase: 'created' },
              session: { phase: 'cleared' },
            },
          ],
        }),
      },
    },
    store: {
      record: () => ({ version: 2, phase: 'ready', request: {}, destination: { containerId: SOURCE } }),
      policy: () => ({}),
    },
    engine: {
      observeDestination: async (row: { destination: { containerId: string } }) => {
        state.read.push(row.destination.containerId);
        const seen = state.inside.get(row.destination.containerId) ?? null;
        if (seen instanceof Error) throw seen;
        return seen;
      },
    },
    service: { flightActive: () => false },
    pool: {},
    absent: {
      previewRebuild: async (_id: string, _template: unknown, authority: DockerContinuationAuthority) =>
        took(
          {
            sessionId: EMPLOYEE.sessionId,
            sessionGeneration: 3,
            scopeDigest: '6'.repeat(64),
            runningLaptops: [...state.running],
            allowedActions: ['rebuild'],
          },
          authority
        ),
      rebuild: async (_id: string, request: Record<string, unknown>, authority: DockerContinuationAuthority) => {
        state.rebuilds.push(request);
        return took({ operationId: 'new', state: 'ready' }, authority);
      },
    },
    moves: () =>
      state.withJournal
        ? {
            abandonedCandidateRecords: async (employeeId: string, owner: string | undefined) => {
              expect([employeeId, owner]).toEqual([EMPLOYEE.id, undefined]);
              if (state.journal) throw state.journal;
              return state.candidates;
            },
          }
        : undefined,
    sessions: { get: () => undefined },
    current: () => true,
  } as unknown as DockerSupervisorLaptopDeps;
  return { state, laptops: new DockerSupervisorLaptops(deps), guard: () => {} };
}

describe('the candidate laptop an abandoned plan move left behind', () => {
  it('is not counted as occupied once a read inside it finds no agent', async () => {
    for (const kind of ['absent', 'exited']) {
      const w = world();
      w.state.inside.set(CANDIDATE, { state: 'running', provider: { kind } });
      expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('absent');
      expect(w.state.read).toEqual([CANDIDATE]);
    }
  });

  it('is discarded by the rebuild, which reads it again first', async () => {
    const w = world();
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({ outcome: 'done', detail: 'rebuilt new' });
    expect(w.state.read).toEqual([CANDIDATE]);
    expect(w.state.rebuilds).toEqual([expect.objectContaining({ confirmDiscardRunning: true, template: TEMPLATE })]);
  });

  it.each([
    ['an agent runs in it', { state: 'running', provider: { kind: 'running' } }],
    ['it cannot be read', { state: 'running', provider: { kind: 'unknown' } }],
    [
      'the read says it is stopped although it is listed as running',
      { state: 'stopped', provider: { kind: 'absent' } },
    ],
    ['the read does not find it', null],
    ['the read fails', new Error('exec failed')],
  ] as Array<[string, Seen]>)('stays occupied when %s', async (_title, seen) => {
    const w = world();
    w.state.inside.set(CANDIDATE, seen);
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'a running laptop is not shown to be empty',
    });
    expect(w.state.rebuilds).toEqual([]);
  });

  it('excuses no other running laptop: only what an abandoned move of this employee recorded', async () => {
    const w = world();
    w.state.running = [OTHER];
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    w.state.running = [CANDIDATE, OTHER];
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('refused');
    // No abandoned move names the candidate: it is a running laptop like any other.
    w.state.running = [CANDIDATE];
    w.state.candidates = [];
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    expect(w.state.rebuilds).toEqual([]);
  });

  it('changes nothing when the journal cannot be read or is not there', async () => {
    const w = world();
    w.state.journal = new Error('journal unavailable');
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    w.state.journal = undefined;
    w.state.withJournal = false;
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    expect((await w.laptops.rebuild(EMPLOYEE, w.guard)).outcome).toBe('refused');
  });

  it('never takes the employee’s recorded laptop for a candidate', async () => {
    const w = world();
    // The move had already put the employee into its candidate: that laptop is now the recorded one.
    w.state.running = [SOURCE];
    w.state.candidates = [{ moveId: 'move-1', record: { version: 3, destination: { containerId: SOURCE } } }];
    w.state.inside.set(SOURCE, { state: 'running', provider: { kind: 'running' } });
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    expect(await w.laptops.rebuild(EMPLOYEE, w.guard)).toEqual({
      outcome: 'refused',
      detail: 'a running laptop is not shown to be empty',
    });
    // Beside an empty candidate, the recorded laptop is still judged by its own read.
    w.state.running = [SOURCE, CANDIDATE];
    w.state.candidates = [{ moveId: 'move-1', record: { version: 3, destination: { containerId: CANDIDATE } } }];
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('running');
    w.state.inside.set(SOURCE, { state: 'running', provider: { kind: 'exited' } });
    expect(await w.laptops.provider(EMPLOYEE, w.guard)).toBe('exited');
  });
});
