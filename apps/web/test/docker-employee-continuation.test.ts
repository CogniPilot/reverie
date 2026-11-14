import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DockerEmployeeContinuation,
  DockerEmployeeContinuationError,
  dockerContinuationFailureCauses,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
  type DockerContinuationStore,
  type DockerContainerObservation,
} from '../src/docker-employee-continuation.js';
import type {
  DockerEmployeeContinuationRecord,
  DockerEmployeeBinding,
  DockerEmployeePool,
} from '../src/docker-employee-continuation-data.js';
import { DockerEmployeeContinuationRecord as ContinuationRecordSchema } from '../src/docker-employee-continuation-data.js';
const eid = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000002';
const oid = '30000000-0000-4000-8000-000000000003',
  cid = 'c'.repeat(64),
  destCid = 'd'.repeat(64),
  image = 'sha256:' + 'e'.repeat(64);
const destinationImage = 'sha256:' + '9'.repeat(64);
function fixture() {
  const poolPolicy = {
    memoryMaxBytes: 48 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 8192,
    cpuWeight: 100,
    allowedCpus: [0, 1],
  };
  const policy = {
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: poolPolicy,
  };
  const original = {
    containerId: cid,
    imageId: image,
    deployment: 'synthetic-native',
    employeeId: eid,
    sessionId: sid,
    home: {
      type: 'bind' as const,
      source: '/synthetic-retained-home',
      destination: '/home/agent' as const,
      readWrite: true as const,
    },
    mountDigest: 'a'.repeat(64),
    storageDigest: '7'.repeat(64),
    configurationDigest: 'b'.repeat(64),
  };
  let row: DockerEmployeeContinuationRecord | undefined,
    binding: DockerEmployeeBinding | undefined,
    pool: DockerEmployeePool | null = null;
  let destination: DockerContainerObservation | null = null,
    actor = true,
    office = true,
    sourceRunning = false;
  const subject = {
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: 7,
    owner: 'synthetic-owner',
    sourceDigest: 'f'.repeat(64),
    providerSourceDigest: '7'.repeat(64),
    onVacation: true,
    desiredRunning: false,
  };
  const journal: string[] = [];
  const authority: DockerContinuationAuthority = {
    owner: subject.owner,
    require() {
      if (!actor) throw Error('revoked');
    },
    requireOffice() {
      if (!office) throw Error('office permission required');
    },
  };
  const store: DockerContinuationStore = {
    subject: () => ({ ...subject }),
    existingSubject: (_id, record) =>
      record.version === 2 && record.providerSourceDigest === subject.providerSourceDigest ? { ...subject } : undefined,
    policy: () => structuredClone(policy),
    record: () => row,
    async replace(before, next, current) {
      current();
      expect(row).toEqual(before);
      journal.push(next.phase);
      row = structuredClone(next);
    },
    async enterOffice(_subject, current) {
      current();
      subject.onVacation = false;
      subject.desiredRunning = true;
    },
    async bind(_row, next, current) {
      current();
      binding = structuredClone(next);
    },
  };
  const engine = {
    image: vi.fn(async () => ({
      imageId: destinationImage,
      sourceImageId: image,
      clientManifestDigest: '4'.repeat(64),
    })),
    observeSource: vi.fn(async () => ({
      original: structuredClone(original),
      state: sourceRunning ? ('running' as const) : ('stopped' as const),
    })),
    validateCapabilities: vi.fn(async () => {}),
    preparePool: vi.fn(async () => {
      expect(row?.phase).toBe('pool-issued');
      pool = {
        containerId: '1'.repeat(64),
        cgroupParent: '/synthetic-box-parent',
        policyDigest: dockerContinuationDigest(policy.pool),
        physicalDigest: '2'.repeat(64),
      };
    }),
    observePool: vi.fn(async () => (pool ? structuredClone(pool) : null)),
    createDestination: vi.fn(async () => {
      expect(row?.phase).toBe('destination-issued');
      expect(sourceRunning).toBe(false);
      destination = {
        original: {
          ...structuredClone(original),
          containerId: destCid,
          imageId: destinationImage,
          deployment: 'synthetic-boxed',
          configurationDigest: '3'.repeat(64),
        },
        state: 'stopped',
        resources: null,
        provider: { kind: 'absent' },
        credentialDigest: null,
      };
    }),
    observeDestination: vi.fn(async () => (destination ? structuredClone(destination) : null)),
    start: vi.fn(async () => {
      expect(row?.phase).toBe('start-issued');
      expect(row?.destination?.containerId).toBe(destCid);
      destination = { ...destination!, state: 'running' };
    }),
    configureResources: vi.fn(async () => {
      expect(row?.phase).toBe('resources-issued');
      destination = { ...destination!, resources: structuredClone(policy) };
    }),
    provisionIdentity: vi.fn(async (_row: DockerEmployeeContinuationRecord, token: string) => {
      expect(row?.phase).toBe('identity-issued');
      destination = { ...destination!, credentialDigest: createHash('sha256').update(token).digest('hex') };
    }),
  };
  const provider = {
    launch: vi.fn(async () => {
      expect(row?.phase).toBe('provider-issued');
      destination = { ...destination!, provider: { kind: 'running', operationId: oid, sessionId: sid } };
    }),
  };
  const identity = { issue: vi.fn(() => 'synthetic-fixed-credential') };
  const request = {
    operationId: oid,
    sessionId: sid,
    sessionGeneration: 7,
    containerId: cid,
    imageId: image,
    expectedPolicyDigest: dockerContinuationDigest(policy),
    expectedDestinationImageId: destinationImage,
    enterOffice: true,
  };
  const make = () => new DockerEmployeeContinuation(store, engine, provider, identity);
  return {
    service: make(),
    make,
    engine,
    provider,
    identity,
    request,
    authority,
    policy,
    subject,
    journal,
    store,
    original,
    record: () => row,
    binding: () => binding,
    destination: () => destination,
    pool: () => pool,
    setDestination: (next: DockerContainerObservation) => {
      destination = next;
    },
    setPool: (next: DockerEmployeePool) => {
      pool = next;
    },
    startSource: () => {
      sourceRunning = true;
    },
    revoke: () => {
      actor = false;
    },
    revokeOffice: () => {
      office = false;
    },
  };
}
describe('owned boxed Docker employee continuation', () => {
  it('round-trips explicit legacy and current formats and rejects ambiguous source contracts', async () => {
    const f = fixture();
    await f.service.begin(eid, f.request, f.authority);
    const current = f.record()!;
    expect(current.version).toBe(2);
    expect(ContinuationRecordSchema.parse(JSON.parse(JSON.stringify(current)))).toEqual(current);
    const { providerSourceDigest: _source, ...common } = current as Extract<
      DockerEmployeeContinuationRecord,
      { version: 2 }
    >;
    const legacy = { ...common, version: 1, purpose: 'docker-employee-continuation-v1' };
    expect(ContinuationRecordSchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    for (const invalid of [
      { ...current, providerSourceDigest: undefined },
      { ...current, providerSourceDigest: 'not-a-digest' },
      { ...current, purpose: 'docker-employee-continuation-v1' },
      { ...legacy, providerSourceDigest: _source },
      { ...legacy, purpose: 'docker-employee-continuation-v2' },
      { ...current, version: 3 },
    ])
      expect(ContinuationRecordSchema.safeParse(invalid).success).toBe(false);
  });
  it('reports one bounded failure without secrets, including frames after a large command message', () => {
    const error = Object.assign(new Error('PRIVATE-TOKEN'), { code: 'EACCES' });
    error.stack = 'PRIVATE-TOKEN\n'.repeat(3000) + '    at launch (/private/path/tmux-manager.js:2703:11)';
    expect(dockerContinuationFailureCauses(error)).toEqual([
      { errorType: 'Error', errno: 'EACCES', locations: [{ module: 'tmux-manager', line: 2703, column: 11 }] },
    ]);
    expect(JSON.stringify(dockerContinuationFailureCauses(error))).not.toMatch(/PRIVATE-TOKEN|private\/path/);
  });
  it('bounds cyclic causes and refuses arbitrary names, codes and stack filenames', () => {
    const error = Object.assign(new Error('SECRET'), {
      name: 'SECRET-NAME',
      code: 'SECRET-CODE',
      stack: 'Error\n at f (/SECRET-FILE.js:1:1)',
      cause: undefined as unknown,
    });
    error.cause = error;
    expect(dockerContinuationFailureCauses(error)).toEqual([{ errorType: 'OtherError', locations: [] }]);
    const hostile = Object.defineProperty({}, 'stack', {
      get() {
        throw Error('SECRET');
      },
    });
    expect(dockerContinuationFailureCauses(hostile)).toEqual([{ errorType: 'UninspectableError', locations: [] }]);
  });
  it('a failing reporter cannot release a failed provider attempt or dispatch it again', async () => {
    const f = fixture();
    f.provider.launch.mockRejectedValue(new Error('PRIVATE-TOKEN'));
    const reporter = vi.fn(
      (_failure: Parameters<NonNullable<ConstructorParameters<typeof DockerEmployeeContinuation>[4]>>[0]) => {
        throw Error('report sink unavailable');
      }
    );
    const service = new DockerEmployeeContinuation(f.store, f.engine, f.provider, f.identity, reporter);
    const failed = await service.begin(eid, f.request, f.authority);
    expect(failed).toMatchObject({ state: 'held', phase: 'provider-issued', allowedActions: ['observe'] });
    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter.mock.calls[0]?.[0]).toMatchObject({ employeeId: eid, operationId: oid, phase: 'provider-issued' });
    expect(JSON.stringify(reporter.mock.calls)).not.toContain('PRIVATE-TOKEN');
    await service.observe(eid, oid, f.authority);
    expect(reporter).toHaveBeenCalledOnce();
    expect(f.provider.launch).toHaveBeenCalledOnce();
  });
  it('retains original stopped and journals NEW destination/pool and every effect before dispatch', async () => {
    const f = fixture();
    expect(await f.service.begin(eid, f.request, f.authority)).toMatchObject({ state: 'ready', phase: 'ready' });
    expect(f.journal).toEqual([
      'staged',
      'office-issued',
      'office-ready',
      'pool-issued',
      'pool-ready',
      'destination-issued',
      'destination-ready',
      'start-issued',
      'container-running',
      'resources-issued',
      'resources-ready',
      'identity-issued',
      'identity-ready',
      'provider-issued',
      'ready',
    ]);
    expect(f.record()!.original).toEqual(f.original);
    expect(f.binding()).toMatchObject({
      sessionId: sid,
      sessionGeneration: 7,
      containerId: destCid,
      imageId: destinationImage,
    });
    expect(f.record()!.destination!.home).toEqual(f.original.home);
    expect(f.engine.start).toHaveBeenCalledOnce();
    expect(f.provider.launch).toHaveBeenCalledOnce();
  });
  it.each(['preparePool', 'createDestination', 'start', 'configureResources', 'provisionIdentity'] as const)(
    'lost %s reply is inspected on the same original, never retransmitted',
    async (effect) => {
      const f = fixture(),
        original = f.engine[effect].getMockImplementation()!;
      f.engine[effect].mockImplementationOnce(async (...args: unknown[]) => {
        await Reflect.apply(original, undefined, args);
        throw Error('partial reply');
      });
      expect((await f.service.begin(eid, f.request, f.authority)).state).toBe('held');
      const counts = new Map(
        ['preparePool', 'createDestination', 'start', 'configureResources', 'provisionIdentity'].map((name) => [
          name,
          vi.mocked(f.engine[name as typeof effect]).mock.calls.length,
        ])
      );
      expect((await f.service.observe(eid, oid, f.authority)).state).toBe('pending');
      for (const name of [
        'preparePool',
        'createDestination',
        'start',
        'configureResources',
        'provisionIdentity',
      ] as const)
        expect(f.engine[name]).toHaveBeenCalledTimes(counts.get(name)!);
      expect(f.provider.launch).not.toHaveBeenCalled();
      expect((await f.service.begin(eid, f.request, f.authority)).state).toBe('ready');
      expect(f.engine[effect]).toHaveBeenCalledOnce();
    }
  );
  it.each([
    'DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED',
    'DOCKER_CONTINUATION_CREATE_DEPENDENCY_MISSING',
    'DOCKER_CONTINUATION_CREATE_NAME_CONFLICT',
    'DOCKER_CONTINUATION_CREATE_UNCONFIRMED',
  ])('preserves typed create cause %s without granting another effect', async (code) => {
    const f = fixture();
    f.engine.createDestination.mockImplementationOnce(async () => {
      throw new DockerEmployeeContinuationError(code);
    });
    expect(await f.service.begin(eid, f.request, f.authority)).toMatchObject({
      state: 'held',
      phase: 'destination-issued',
      code,
      allowedActions: ['observe'],
    });
    expect(await f.make().begin(eid, f.request, f.authority)).toMatchObject({
      state: 'held',
      phase: 'destination-issued',
      allowedActions: ['observe'],
    });
    expect(f.engine.createDestination).toHaveBeenCalledOnce();
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.provider.launch).not.toHaveBeenCalled();
  });
  it('a genuinely unknown create stays held after a fresh service and never creates again', async () => {
    const f = fixture();
    f.engine.createDestination.mockImplementationOnce(async () => {
      throw Error('unknown accepted create');
    });
    expect(await f.service.begin(eid, f.request, f.authority)).toMatchObject({
      state: 'held',
      phase: 'destination-issued',
    });
    expect(await f.make().begin(eid, f.request, f.authority)).toMatchObject({
      state: 'held',
      phase: 'destination-issued',
    });
    expect(f.engine.createDestination).toHaveBeenCalledOnce();
    expect(f.engine.start).not.toHaveBeenCalled();
  });
  it('unknown provider outcome never launches twice, including after service reconstruction', async () => {
    const f = fixture();
    f.provider.launch.mockImplementationOnce(async () => {
      throw Error('dispatch may have happened');
    });
    expect(await f.service.begin(eid, f.request, f.authority)).toMatchObject({
      state: 'held',
      phase: 'provider-issued',
    });
    expect(await f.make().begin(eid, f.request, f.authority)).toMatchObject({
      state: 'held',
      phase: 'provider-issued',
    });
    expect(f.provider.launch).toHaveBeenCalledOnce();
    f.setDestination({ ...f.destination()!, provider: { kind: 'running', operationId: oid, sessionId: sid } });
    expect(await f.make().observe(eid, oid, f.authority)).toMatchObject({ state: 'ready' });
    expect(f.provider.launch).toHaveBeenCalledOnce();
  });
  it('Observe can acknowledge owned pool metadata but cannot create or start a destination', async () => {
    const f = fixture(),
      original = f.engine.preparePool.getMockImplementation()!;
    f.engine.preparePool.mockImplementationOnce(async () => {
      await original();
      throw Error('unknown');
    });
    await f.service.begin(eid, f.request, f.authority);
    expect(await f.service.observe(eid, oid, f.authority)).toMatchObject({ phase: 'pool-ready', state: 'pending' });
    expect(f.engine.preparePool).toHaveBeenCalledOnce();
    expect(f.engine.createDestination).not.toHaveBeenCalled();
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.engine.configureResources).not.toHaveBeenCalled();
  });
  it('a second operation or foreign owner cannot take/drop the original completion', async () => {
    const f = fixture();
    await f.service.begin(eid, f.request, f.authority);
    await expect(
      f.service.begin(eid, { ...f.request, operationId: '40000000-0000-4000-8000-000000000004' }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_CONTINUATION_ORIGINAL_HELD' });
    await expect(f.service.observe(eid, oid, { ...f.authority, owner: 'foreign' })).rejects.toMatchObject({
      code: 'DOCKER_CONTINUATION_UNKNOWN_OPERATION',
    });
    expect(f.provider.launch).toHaveBeenCalledOnce();
  });
  it('recovery permission alone cannot end vacation or edit stored policy', async () => {
    const f = fixture();
    f.revokeOffice();
    await expect(f.service.begin(eid, f.request, f.authority)).rejects.toThrow();
    expect(f.record()).toBeUndefined();
    expect(f.engine.observeSource).not.toHaveBeenCalled();
    expect(f.subject.onVacation).toBe(true);
    await expect(
      f.service.begin(eid, { ...f.request, resources: { memoryMaxBytes: 1 } }, f.authority)
    ).rejects.toThrow();
  });
  it.each([
    'generation',
    'source-home',
    'destination-home',
    'destination-image',
    'destination-cid',
    'policy',
    'pool-physical',
    'source-running',
    'revocation',
  ] as const)('fresh %s change after destination creation prevents all later effects', async (change) => {
    const f = fixture(),
      original = f.engine.createDestination.getMockImplementation()!;
    f.engine.createDestination.mockImplementationOnce(async () => {
      await original();
      if (change === 'generation') f.subject.sessionGeneration++;
      if (change === 'source-home') f.original.home.source = '/replacement';
      if (change === 'destination-home')
        f.setDestination({
          ...f.destination()!,
          original: { ...f.destination()!.original, home: { ...f.original.home, source: '/replacement' } },
        });
      if (change === 'destination-image')
        f.setDestination({
          ...f.destination()!,
          original: { ...f.destination()!.original, imageId: 'sha256:' + '8'.repeat(64) },
        });
      if (change === 'destination-cid')
        f.setDestination({ ...f.destination()!, original: { ...f.destination()!.original, containerId: cid } });
      if (change === 'policy') f.policy.memoryMaxBytes--;
      if (change === 'pool-physical') f.setPool({ ...f.pool()!, physicalDigest: '8'.repeat(64) });
      if (change === 'source-running') f.startSource();
      if (change === 'revocation') f.revoke();
    });
    expect((await f.service.begin(eid, f.request, f.authority)).state).toBe('held');
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.provider.launch).not.toHaveBeenCalled();
  });
  it('finite-high/pool capability denial is pre-effect and records no attempted operation', async () => {
    const f = fixture();
    f.engine.validateCapabilities.mockRejectedValueOnce(Error('actual aggregate/high capability unavailable'));
    await expect(f.service.begin(eid, f.request, f.authority)).rejects.toThrow('aggregate/high');
    expect(f.record()).toBeUndefined();
    expect(f.engine.preparePool).not.toHaveBeenCalled();
  });
  it('missing pool or mismatched actual high cannot masquerade as pending pre-effect readiness', async () => {
    const f = fixture();
    f.engine.configureResources.mockImplementationOnce(async () => {});
    expect(await f.service.begin(eid, f.request, f.authority)).toMatchObject({
      phase: 'resources-issued',
      state: 'held',
      code: 'DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED',
    });
    expect(f.provider.launch).not.toHaveBeenCalled();
    expect(f.engine.provisionIdentity).not.toHaveBeenCalled();
    await f.service.observe(eid, oid, f.authority);
    expect(f.engine.configureResources).toHaveBeenCalledOnce();
  });
});

describe('same original proven-unissued helper continuation', () => {
  it('Observe never starts a created leaf helper; fresh protected continuation completes its one start', async () => {
    const f = fixture();
    f.engine.configureResources.mockImplementationOnce(async () => {
      f.record()!.tasks = [
        {
          role: 'leaf-helper',
          name: 'reverie-boxed-leaf-' + oid,
          imageId: 'sha256:' + '9'.repeat(64),
          configurationDigest: '8'.repeat(64),
          phase: 'created',
          containerId: '7'.repeat(64),
        },
      ];
      throw Error('authority ended before actual start');
    });
    const held = await f.service.begin(eid, f.request, f.authority);
    expect(held).toMatchObject({ phase: 'resources-issued', state: 'held', allowedActions: ['observe', 'continue'] });
    await f.service.observe(eid, oid, f.authority);
    expect(f.engine.configureResources).toHaveBeenCalledOnce();
    expect(f.provider.launch).not.toHaveBeenCalled();
    expect(await f.service.begin(eid, f.request, f.authority)).toMatchObject({ state: 'ready' });
    expect(f.engine.configureResources).toHaveBeenCalledTimes(2);
    expect(f.engine.start).toHaveBeenCalledOnce();
    expect(f.engine.createDestination).toHaveBeenCalledOnce();
    expect(f.provider.launch).toHaveBeenCalledOnce();
  });
  it('an issued leaf with unknown ACK cannot be promoted to known-unissued on a fresh effect request', async () => {
    const f = fixture();
    f.engine.configureResources.mockImplementationOnce(async () => {
      f.record()!.tasks = [
        {
          role: 'leaf-helper',
          name: 'reverie-boxed-leaf-' + oid,
          imageId: 'sha256:' + '9'.repeat(64),
          configurationDigest: '8'.repeat(64),
          phase: 'start-issued',
          containerId: '7'.repeat(64),
        },
      ];
      throw Error('unknown actual start reply');
    });
    await f.service.begin(eid, f.request, f.authority);
    expect((await f.service.begin(eid, f.request, f.authority)).state).toBe('held');
    expect(f.engine.configureResources).toHaveBeenCalledOnce();
    expect(f.provider.launch).not.toHaveBeenCalled();
  });
});

describe('existing-provider identity survives observed native thread progress', () => {
  it('observes the same running provider after native progress without replaying its original launch', async () => {
    const f = fixture();
    expect((await f.service.begin(eid, f.request, f.authority)).state).toBe('ready');
    const originalDigest = f.record()!.sourceDigest;
    f.subject.sourceDigest = '8'.repeat(64);
    const result = await f.service.observe(eid, oid, f.authority);
    expect(result.state).toBe('ready');
    expect(f.record()!.sourceDigest).toBe(originalDigest);
    expect(f.provider.launch).toHaveBeenCalledTimes(1);
    await expect(f.service.begin(eid, f.request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_CONTINUATION_ORIGINAL_HELD',
    });
    expect(f.provider.launch).toHaveBeenCalledTimes(1);
  });
  it('refuses an actual existing-provider recipe change even when the physical process remains alive', async () => {
    const f = fixture();
    await f.service.begin(eid, f.request, f.authority);
    f.subject.sourceDigest = '8'.repeat(64);
    f.subject.providerSourceDigest = '9'.repeat(64);
    await expect(f.service.observe(eid, oid, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_CONTINUATION_TARGET_CHANGED',
    });
    expect(f.provider.launch).toHaveBeenCalledTimes(1);
  });
});

describe('existing-provider observation keeps its captured operation across awaits', () => {
  it('refuses a same-employee replacement operation during native observation', async () => {
    const f = fixture();
    await f.service.begin(eid, f.request, f.authority);
    f.engine.observeSource.mockImplementationOnce(async () => {
      const original = f.record()!;
      await f.store.replace(
        original,
        { ...original, request: { ...original.request, operationId: '40000000-0000-4000-8000-000000000004' } },
        () => {}
      );
      return { original: structuredClone(f.original), state: 'stopped' };
    });
    await expect(f.service.observe(eid, oid, f.authority)).resolves.toMatchObject({
      state: 'held',
      code: 'DOCKER_CONTINUATION_ORIGINAL_CHANGED',
    });
    expect(f.provider.launch).toHaveBeenCalledTimes(1);
  });
});
