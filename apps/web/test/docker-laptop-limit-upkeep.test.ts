/** The in-place repair of a finished laptop's limits that does not ask where its employee is. Every port is an
 * inert fake; no Engine, session or live data is used. */
import { describe, expect, it } from 'vitest';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
  type DockerContinuationSubject,
} from '../src/docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { DockerLaptopLimitUpkeep, type DockerLaptopLimitUpkeepDeps } from '../src/docker-laptop-limit-upkeep.js';

const EMPLOYEE = '11111111-1111-4111-8111-111111111111';
const OPERATION = '33333333-3333-4333-8333-333333333333';
const SESSION = '22222222-2222-4222-8222-222222222222';
const POOL_POLICY = { memoryMaxBytes: 2 ** 34, swapMaxBytes: 0, pidsMax: 4096, cpuWeight: 100, allowedCpus: [0, 1] };
const POLICY = { memoryMaxBytes: 2 ** 33, memoryHighBytes: 2 ** 32, allowedCpus: [1], pool: POOL_POLICY };
const IMAGE = {
  imageId: 'sha256:' + 'e'.repeat(64),
  sourceImageId: 'sha256:' + 'b'.repeat(64),
  clientManifestDigest: 'f'.repeat(64),
};
const POOL = {
  containerId: 'a'.repeat(64),
  cgroupParent: 'reverie-box-x.slice',
  policyDigest: dockerContinuationDigest(POOL_POLICY),
  physicalDigest: '9'.repeat(64),
};
const record = (patch: Record<string, unknown> = {}) =>
  ({
    version: 2,
    employeeId: EMPLOYEE,
    owner: undefined,
    phase: 'ready',
    request: { operationId: OPERATION, sessionId: SESSION, sessionGeneration: 3 },
    policy: POLICY,
    workerImage: IMAGE,
    pool: POOL,
    destination: { containerId: 'd'.repeat(64) },
    ...patch,
  }) as unknown as DockerEmployeeContinuationRecord;

/** One employee who is out of the office, with a finished laptop that is running. */
function world() {
  const state = {
    authorized: true,
    record: record() as DockerEmployeeContinuationRecord | undefined,
    subject: {
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      sessionGeneration: 3,
      owner: undefined,
      sourceDigest: 's'.repeat(64),
      providerSourceDigest: 'p'.repeat(64),
      // Attendance is on the subject and is never read here.
      onVacation: true,
      desiredRunning: false,
    } as DockerContinuationSubject | undefined,
    policy: POLICY as unknown,
    busy: false,
    image: IMAGE as unknown,
    storage: 'ready' as 'ready' | 'unissued' | 'unknown' | 'ephemeral-unissued',
    pool: POOL as unknown,
    restore: 'restored' as 'unchanged' | 'restored' | Error,
    calls: [] as string[],
    /** Runs between two steps, to change the world under a call in flight. */
    during: {} as Partial<Record<string, () => void>>,
  };
  const step = (name: string) => {
    state.calls.push(name);
    state.during[name]?.();
  };
  const deps: DockerLaptopLimitUpkeepDeps = {
    store: {
      record: () => state.record && structuredClone(state.record),
      existingSubject: () => state.subject,
      policy: () => state.policy as never,
    },
    engine: {
      existingImage: async (_row, current) => {
        current();
        step('image');
        return state.image as never;
      },
      observeStorage: async () => {
        step('storage');
        return state.storage;
      },
      observePool: async () => {
        step('pool');
        return state.pool as never;
      },
      assertPreparationCurrent: () => {},
      restoreResources: async (row, current) => {
        current();
        step('restore');
        // Every value the writer gets comes from the record that was qualified.
        expect(row.policy).toEqual(POLICY);
        if (state.restore instanceof Error) throw state.restore;
        return state.restore;
      },
    },
    busy: () => state.busy,
  };
  const authority: DockerContinuationAuthority = {
    owner: undefined,
    require: () => {
      if (!state.authorized) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
    },
    requireOffice: () => {
      throw new Error('keeping limits never asks for office authority');
    },
  };
  const upkeep = new DockerLaptopLimitUpkeep(deps);
  const run = () => upkeep.restore(EMPLOYEE, OPERATION, authority);
  const refused = async () =>
    run().then(
      () => 'done',
      (error: unknown) => (error instanceof DockerEmployeeContinuationError ? error.code : String(error))
    );
  return { state, deps, upkeep, run, refused };
}

describe('keeping the approved limits of a finished laptop', () => {
  it('puts them back for an employee who is out of the office, and says whether anything was written', async () => {
    const w = world();
    expect(await w.run()).toEqual({ operationId: OPERATION, limits: 'restored' });
    expect(w.state.calls).toEqual(['image', 'storage', 'pool', 'restore']);
    w.state.restore = 'unchanged';
    expect(await w.run()).toEqual({ operationId: OPERATION, limits: 'unchanged' });
    expect(w.upkeep.flightActive(EMPLOYEE)).toBe(false);
  });

  describe('for a laptop that a plan move made', () => {
    const MOVE = 'move-1';
    /** The record of an employee who was moved to another plan: it stays a plan-move record for good. */
    const moved = () => record({ version: 3, planReplacement: { moveId: MOVE } });
    const withMoves = (open: readonly { id: string }[] | Error | undefined) => {
      const w = world();
      w.state.record = moved();
      const asked: string[] = [];
      const upkeep = new DockerLaptopLimitUpkeep({
        ...w.deps,
        ...(open === undefined
          ? {}
          : {
              openMoves: async (employeeId: string) => {
                asked.push(employeeId);
                if (open instanceof Error) throw open;
                return open;
              },
            }),
      });
      const refused = () =>
        upkeep.restore(EMPLOYEE, OPERATION, { owner: undefined, require: () => {}, requireOffice: () => {} }).then(
          (result) => result.limits as string,
          (error: unknown) => (error instanceof DockerEmployeeContinuationError ? error.code : String(error))
        );
      return { w, upkeep, refused, asked };
    };

    it('keeps the limits like any other once the move is finished', async () => {
      const o = withMoves([]);
      expect(o.upkeep.finished(EMPLOYEE)).toMatchObject({ version: 3, phase: 'ready' });
      expect(await o.refused()).toBe('restored');
      expect(o.w.state.calls).toEqual(['image', 'storage', 'pool', 'restore']);
      expect(o.asked.length).toBeGreaterThan(0);
    });

    it.each<[string, readonly { id: string }[] | Error | undefined]>([
      ['the move that made it is still open', [{ id: MOVE }]],
      ['another move of the employee is open', [{ id: 'move-2' }]],
      ['the moves cannot be read', new Error('journal')],
      ['the office cannot say which moves are open', undefined],
    ])('leaves the laptop to the move while %s', async (_title, open) => {
      const o = withMoves(open);
      expect(await o.refused()).toBe('DOCKER_PLAN_REPLACEMENT_PRIVATE_OWNER_REQUIRED');
      expect(o.w.state.calls).toEqual([]);
    });

    it('writes nothing when a move opens while the laptop is being read', async () => {
      const open: { id: string }[] = [];
      const o = withMoves(open);
      o.w.state.during.pool = () => open.push({ id: 'move-2' });
      expect(await o.refused()).toBe('DOCKER_PLAN_REPLACEMENT_PRIVATE_OWNER_REQUIRED');
      expect(o.w.state.calls).toEqual(['image', 'storage', 'pool']);
    });

    it('asks nothing about moves for a laptop no plan move made', async () => {
      const w = world();
      const asked: string[] = [];
      const upkeep = new DockerLaptopLimitUpkeep({ ...w.deps, openMoves: async (id) => (asked.push(id), [{ id: MOVE }]) });
      const result = await upkeep.restore(EMPLOYEE, OPERATION, { owner: undefined, require: () => {}, requireOffice: () => {} });
      expect(result.limits).toBe('restored');
      expect(asked).toEqual([]);
    });
  });

  it('acts only for a finished record', async () => {
    for (const patch of [
      { phase: 'resources-issued' },
      { phase: 'pool-issued' },
      { destination: undefined },
      { version: 3, phase: 'resources-issued' },
    ]) {
      const w = world();
      w.state.record = record(patch);
      expect(w.upkeep.finished(EMPLOYEE)).toBeUndefined();
      expect(await w.refused()).toBe('DOCKER_CONTINUATION_UNKNOWN_OPERATION');
      expect(w.state.calls).toEqual([]);
    }
    const w = world();
    expect(w.upkeep.finished(EMPLOYEE)).toMatchObject({ phase: 'ready' });
    w.state.record = record({ phase: 'provider-issued' });
    expect(await w.refused()).toBe('done');
    w.state.record = undefined;
    expect(await w.refused()).toBe('DOCKER_CONTINUATION_UNKNOWN_OPERATION');
  });

  it('refuses another operation, another owner, a changed employee and a changed approved policy before any read', async () => {
    const cases: Array<[string, (state: ReturnType<typeof world>['state']) => void]> = [
      ['DOCKER_CONTINUATION_UNKNOWN_OPERATION', (state) => (state.record = record({ owner: 'someone-else' }))],
      [
        'DOCKER_CONTINUATION_UNKNOWN_OPERATION',
        (state) => (state.record = record({ request: { operationId: '4'.repeat(8), sessionId: SESSION, sessionGeneration: 3 } })),
      ],
      ['DOCKER_CONTINUATION_TARGET_CHANGED', (state) => (state.subject = undefined)],
      ['DOCKER_CONTINUATION_TARGET_CHANGED', (state) => (state.subject = { ...state.subject!, sessionGeneration: 4 })],
      ['DOCKER_CONTINUATION_TARGET_CHANGED', (state) => (state.subject = { ...state.subject!, owner: 'someone-else' })],
      ['DOCKER_CONTINUATION_POLICY_CHANGED', (state) => (state.policy = { ...POLICY, memoryHighBytes: 2 ** 31 })],
      ['DOCKER_CONTINUATION_RUNTIME_CHANGED', (state) => (state.authorized = false)],
    ];
    for (const [code, change] of cases) {
      const w = world();
      change(w.state);
      expect([code, await w.refused()]).toEqual([code, code]);
      expect(w.state.calls).toEqual([]);
    }
  });

  it('stands aside for a set-up step, a rebuild or another repair of the same employee', async () => {
    const w = world();
    w.state.busy = true;
    expect(await w.refused()).toBe('DOCKER_CONTINUATION_BUSY');
    expect(w.state.calls).toEqual([]);
    // One that took flight while the laptop was being read stops the write.
    w.state.busy = false;
    w.state.during.pool = () => (w.state.busy = true);
    expect(await w.refused()).toBe('DOCKER_CONTINUATION_BUSY');
    expect(w.state.calls).not.toContain('restore');
    // Its own flight is denial data for the others, and a second call of its own is refused.
    const v = world();
    let second: Promise<string> | undefined;
    v.state.during.storage = () => {
      expect(v.upkeep.flightActive(EMPLOYEE)).toBe(true);
      second = v.refused();
    };
    expect(await v.run()).toMatchObject({ limits: 'restored' });
    expect(await second).toBe('DOCKER_CONTINUATION_BUSY');
    expect(v.state.calls.filter((name) => name === 'restore')).toHaveLength(1);
  });

  it('writes nothing unless the image, the storage and the shared pool are the record’s own', async () => {
    const cases: Array<[string, (state: ReturnType<typeof world>['state']) => void]> = [
      ['DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED', (state) => (state.image = { ...IMAGE, imageId: 'sha256:' + '0'.repeat(64) })],
      ['DOCKER_CONTINUATION_STORAGE_UNCONFIRMED', (state) => (state.storage = 'unknown')],
      ['DOCKER_CONTINUATION_STORAGE_UNCONFIRMED', (state) => (state.storage = 'unissued')],
      ['DOCKER_EPHEMERAL_PREPARATION_REQUIRED', (state) => (state.storage = 'ephemeral-unissued')],
      ['DOCKER_CONTINUATION_POOL_UNCONFIRMED', (state) => (state.pool = null)],
      ['DOCKER_CONTINUATION_POOL_UNCONFIRMED', (state) => (state.record = record({ pool: undefined }))],
      ['DOCKER_CONTINUATION_POOL_CHANGED', (state) => (state.pool = { ...POOL, policyDigest: '1'.repeat(64) })],
      ['DOCKER_CONTINUATION_POOL_CHANGED', (state) => (state.pool = { ...POOL, physicalDigest: '1'.repeat(64) })],
    ];
    for (const [code, change] of cases) {
      const w = world();
      change(w.state);
      expect([code, await w.refused()]).toEqual([code, code]);
      expect(w.state.calls).not.toContain('restore');
    }
    const w = world();
    delete (w.deps.engine as { existingImage?: unknown }).existingImage;
    expect(await w.refused()).toBe('DOCKER_RESOURCE_REPAIR_SCOPE_UNSUPPORTED');
    delete (w.deps.engine as { restoreResources?: unknown }).restoreResources;
    expect(await w.refused()).toBe('DOCKER_RESOURCE_REPAIR_UNAVAILABLE');
  });

  it('stops as soon as the record, the employee or the authority changes under it', async () => {
    const changes: Array<[string, (state: ReturnType<typeof world>['state']) => void]> = [
      ['DOCKER_CONTINUATION_ORIGINAL_CHANGED', (state) => (state.record = undefined)],
      ['DOCKER_CONTINUATION_ORIGINAL_CHANGED', (state) => (state.record = record({ credentialId: 'another' }))],
      ['DOCKER_CONTINUATION_TARGET_CHANGED', (state) => (state.subject = { ...state.subject!, providerSourceDigest: 'q'.repeat(64) })],
      ['DOCKER_CONTINUATION_POLICY_CHANGED', (state) => (state.policy = { ...POLICY, memoryMaxBytes: 2 ** 34 })],
      ['DOCKER_CONTINUATION_RUNTIME_CHANGED', (state) => (state.authorized = false)],
    ];
    for (const at of ['image', 'storage', 'pool'])
      for (const [code, change] of changes) {
        const w = world();
        w.state.during[at] = () => change(w.state);
        expect([at, code, await w.refused()]).toEqual([at, code, code]);
        expect(w.state.calls).not.toContain('restore');
        expect(w.upkeep.flightActive(EMPLOYEE)).toBe(false);
      }
  });

  it('passes on what the repair itself refuses, such as a laptop that is not running', async () => {
    const w = world();
    w.state.restore = new DockerEmployeeContinuationError('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    expect(await w.refused()).toBe('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    w.state.restore = new DockerEmployeeContinuationError('DOCKER_RESOURCE_REPAIR_REVISION_PRESENT');
    expect(await w.refused()).toBe('DOCKER_RESOURCE_REPAIR_REVISION_PRESENT');
    expect(w.upkeep.flightActive(EMPLOYEE)).toBe(false);
  });

  it('reads attendance nowhere: the same call serves an employee in the office, out of it or stopped', async () => {
    for (const attendance of [
      { onVacation: false, desiredRunning: true },
      { onVacation: true, desiredRunning: true },
      { onVacation: false, desiredRunning: false },
      { onVacation: false, desiredRunning: undefined },
    ]) {
      const w = world();
      w.state.subject = { ...w.state.subject!, ...attendance };
      expect(await w.run()).toEqual({ operationId: OPERATION, limits: 'restored' });
    }
  });
});
