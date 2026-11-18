import { dockerProviderRuntimeRecipeDigest } from '../src/docker-employee-source-correlation.js';
import { StaleExpirationMap } from '../src/utils/stale-expiration-map.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { CompanyStore } from '../src/company-store.js';
import * as companyPublication from '../src/company-store.js';
import { withCanonicalStateLock } from '../src/canonical-state-lock.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  DOCKER_WORKER_IDENTITY_HEADER,
} from '../src/docker-worker-identity.js';
import {
  captureDockerPlanMoveOriginalRequester,
  captureDockerPlanMoveRequester,
  requireDockerPlanMoveRequesterSource,
  requireDockerPlanMoveRequesterReservation,
  requireDockerPlanMoveRequesterCurrent,
  DockerPlanMoveRequester,
  type DockerPlanMoveRequesterTarget,
} from '../src/docker-plan-move-requester.js';
import { DockerPlanMoveJournalState } from '../src/docker-plan-move-data.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import type { AuthSessionRecord } from '../src/web/ports/auth-port.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { dockerPlanSourceFixture } from './helpers/docker-plan-source-fixture.js';
import {
  captureDockerPlanDisjointGeneration,
  requireDockerPlanDisjointHistoryData,
  requireDockerPlanDisjointReservation,
} from '../src/docker-plan-disjoint-generation.js';
import { PlanMoves, type PlanMovePort, type PlanMoveRecord } from '../src/plan-move.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(native?: ReturnType<typeof dockerPlanSourceFixture>, returnToOffice = false) {
  const f = dockerPlanJournalFixture();
  if (native) {
    f.record.employeeId = native.row.employeeId;
    f.record.oldSession = native.binding.sessionId;
    f.state.seed = {
      ...f.state.seed,
      forceBusy: true,
      target: {
        ...f.state.seed.target,
        workerImage: { ...f.state.seed.target.workerImage, sourceImageId: native.binding.imageId },
      },
      source: {
        ...f.state.seed.source,
        record: native.row,
        binding: native.binding,
        providerSourceDigest: native.row.version === 1 ? native.row.sourceDigest : native.row.providerSourceDigest,
      },
    };
  }
  const targetRecipe = {
    mode: 'claude',
    workingDir: '/synthetic-workspace',
    configs: {},
    subscriptionProfile: { id: f.record.toAccount, label: 'Synthetic target', provider: 'anthropic' as const },
  };
  f.state.seed.target.templateDigest = dockerProviderRuntimeRecipeDigest(targetRecipe);
  f.closed.seed.target.templateDigest = dockerProviderRuntimeRecipeDigest(targetRecipe);
  f.state.seed.source.record.owner = undefined;
  f.closed.seed.source.record.owner = undefined;
  if (returnToOffice) f.state.seed = { ...f.state.seed, forceBusy: true, returnToOffice: true };
  f.record.owner = undefined;
  f.record.dockerReplacement = f.state;
  f.work.owner = undefined;
  f.work.planReplacement.source.continuationDigest = dockerContinuationDigest(f.state.seed.source.record);
  const directory = await mkdtemp(join(tmpdir(), 'plan-requester-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  const company = new CompanyService(store, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  await store.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: f.record.employeeId,
        name: 'Synthetic',
        icon: 'X',
        position: 'Engineer',
        expertise: ['testing'],
        createdAt: 1,
        sessionId: f.record.oldSession,
        sessionGeneration: 1,
        onVacation: returnToOffice,
        desiredRunning: !returnToOffice,
        permissions: { moveOwnPlan: true },
        dockerBinding: f.state.seed.source.binding,
      }),
    ];
  });
  let key = true,
    issuerKey = true,
    physical = true;
  const selected = (id: string) => {
    const employee = store.snapshot().employees.find((e) => e.id === id),
      b = employee?.dockerBinding;
    if (!physical || !employee || !b) return undefined;
    return {
      employeeId: employee.id,
      owner: employee.owner,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      containerId: b.containerId,
      credentialId: b.credentialId,
    };
  };
  const authentication = new DockerWorkerIdentityAuthentication(
    'f0000000-0000-4000-8000-00000000000f',
    Buffer.alloc(32, 0x41),
    { binding: selected, keyCurrent: () => key && issuerKey }
  );
  cleanups.push(async () => authentication.close());
  const token = authentication.issue(selected(f.record.employeeId)!, () => key);
  const headers = { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': f.record.oldSession };
  let target: DockerPlanMoveRequesterTarget = {
    employeeId: f.record.employeeId,
    sessionId: f.record.oldSession,
    sessionGeneration: 1,
    choice: { moveId: f.record.id, toAccount: f.record.toAccount, forceBusy: f.state.seed.forceBusy },
  };
  const moveStore = new PlanMoveStore(join(directory, 'moves.json'));
  await moveStore.save([f.record]);
  let proof: unknown;
  let tamper: ((key: string, value: string) => void) | undefined;
  const authSessions = new StaleExpirationMap<string, AuthSessionRecord>({ ttlMs: 60_000 });
  cleanups.push(async () => authSessions.dispose());
  const app = Fastify();
  await app.register(cookie);
  registerDockerWorkerIdentity(app, authentication);
  app.post('/api/capture', async (request, reply) => {
    tamper = (name, value) => {
      request.headers[name] = value;
    };
    try {
      const current = () => {
        if (!key) throw Error('runtime key revoked');
      };
      proof =
        target.purpose === 'original'
          ? await captureDockerPlanMoveOriginalRequester(
              request,
              f.record.id,
              moveStore,
              company,
              { authSessions },
              undefined,
              current
            )
          : captureDockerPlanMoveRequester(request, target, company, { authSessions }, undefined, current);
      return { success: true };
    } catch {
      return reply.code(403).send({ success: false });
    }
  });
  await app.ready();
  cleanups.push(() => app.close());
  const input = {
    id: f.record.id,
    employeeId: f.record.employeeId,
    sessionId: f.record.oldSession,
    fromAccount: f.record.fromAccount,
    toAccount: f.record.toAccount,
    forceBusy: f.state.seed.forceBusy,
    handoff: f.state.seed.handoff,
  };
  const capture = async (h = headers) => {
    const r = await app.inject({ method: 'POST', url: '/api/capture', headers: h });
    return r.statusCode;
  };
  const current = (state = f.state) => requireDockerPlanMoveRequesterCurrent(proof, f.record, state);
  const paid = () => {
    const base = { imageId: f.work.workerImage.imageId, configurationDigest: 'd'.repeat(64) };
    const work = {
      ...f.work,
      phase: 'provider-issued',
      pool: {
        containerId: '1'.repeat(64),
        cgroupParent: '/synthetic',
        policyDigest: dockerContinuationDigest(f.work.policy.pool),
        physicalDigest: '2'.repeat(64),
      },
      destination: {
        ...f.work.original,
        containerId: '0'.repeat(64),
        sessionId: f.targetSid,
        imageId: f.work.workerImage.imageId,
      },
      tasks: [
        {
          ...base,
          role: 'storage-holder',
          name: 'reverie-boxed-storage-test',
          phase: 'running',
          containerId: '3'.repeat(64),
          initPid: 42,
          initStartTicks: '1234',
        },
        ...(['leaf-helper', 'identity-helper'] as const).map((role, i) => ({
          ...base,
          role,
          name: 'reverie-boxed-' + role,
          phase: 'completed',
          containerId: String(i + 4).repeat(64),
          resultDigest: 'e'.repeat(64),
        })),
      ],
    };
    return DockerPlanMoveJournalState.parse({
      ...f.closed,
      work,
      material: f.material,
      paidDispatch: {
        phase: 'issued',
        epoch: f.epoch,
        operationId: f.targetOp,
        sessionId: f.targetSid,
        containerId: '0'.repeat(64),
        recipeDigest: f.work.sourceDigest,
      },
      companyPublication: { phase: 'published', digest: 'f'.repeat(64) },
    });
  };
  return {
    ...f,
    directory,
    targetRecipe,
    issuerKeyLost: () => {
      issuerKey = false;
    },
    tamper: (name: string, value: string) => tamper!(name, value),
    runtimeStillCurrent: () => key,
    app,
    store,
    moveStore,
    company,
    headers,
    authentication,
    input,
    capture,
    current,
    paid,
    proof: () => proof,
    setTarget: (value: DockerPlanMoveRequesterTarget) => {
      target = value;
    },
    selected,
    physicalGone: () => {
      physical = false;
    },
    revokeKey: () => {
      key = false;
    },
    authSessions,
  };
}
async function disjointAdmissionFixture(cost = 50) {
  const native = dockerPlanSourceFixture(),
    f = await fixture(native);
  expect(await f.capture()).toBe(200);
  const store = new PlanMoveStore(join(f.directory, 'disjoint.json'));
  const old: PlanMoveRecord = {
    id: 'historical-legacy',
    employeeId: f.record.employeeId,
    name: 'Synthetic',
    oldSession: '10000000-0000-4000-8000-000000000011',
    newSession: '10000000-0000-4000-8000-000000000012',
    fromAccount: 'old-source',
    toAccount: 'old-target',
    phase: 'recovery-required',
    at: 1,
    sourceStopRequested: true,
    sourceCleanupVerified: true,
  };
  await store.save([old]);
  let clock = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const current = () => {
    requireDockerPlanMoveRequesterSource(f.proof(), f.record.employeeId, undefined);
    // Controlled canonical/requester work, not a production timing assertion.
    clock += cost;
  };
  const forbidden = async () => {
    throw Error('Native effect forbidden');
  };
  const prepare = vi.fn(async () => {
    throw Error('admitted preparation boundary');
  });
  const snapshot = async () => ({
    backend: 'docker' as const,
    sessionId: f.record.oldSession,
    sessionGeneration: 1,
    name: 'Synthetic',
    account: f.record.fromAccount,
    working: true,
  });
  const admission = vi.fn(
    async (employeeId: string, owner: string | undefined, rows: readonly Readonly<PlanMoveRecord>[]) => {
      if (employeeId !== native.row.employeeId || owner !== native.row.owner)
        throw Error('Changed native source scope');
      const proof = await native.reader.capture(native.row, native.binding, current, true);
      return captureDockerPlanDisjointGeneration(f.proof(), proof, native.row, native.binding, rows, current);
    }
  );
  const port: PlanMovePort = {
    load: () => store.load(),
    save: (records) => store.save(records),
    snapshot,
    idle: forbidden,
    create: forbidden,
    start: forbidden,
    ready: forbidden,
    beforeStop: forbidden,
    stop: forbidden,
    rebind: forbidden,
    binding: () => f.record.oldSession,
    exists: () => true,
    audit: async () => {},
    dockerReplacement: {
      admitDisjointGeneration: admission,
      snapshot,
      reserve: async (_input, _owner, requestDigest) => {
        // The initial proof must not survive recipe work: the coordinator owns
        // a separate genuine fresh capture after reserve and before locking.
        clock += 6000;
        return { ...f.state.seed, requestDigest };
      },
      current: (record, state) => requireDockerPlanMoveRequesterCurrent(f.proof(), record, state),
      prepare,
      idle: forbidden,
      stopSource: forbidden,
      start: forbidden,
      verify: forbidden,
      finalize: forbidden,
      inspectForContinuation: forbidden,
      requireContinuation: () => {
        throw Error('No continuation');
      },
    },
    dockerJournal: {
      reserve: (...args) => store.dockerReserve(...args),
      record: (id) => store.dockerRecord(id),
      current: (...args) => store.dockerCurrent(...args),
      readCurrent: (...args) => store.dockerReadCurrent(...args),
      phase: (...args) => store.dockerPhase(...args),
      publish: (...args) => store.dockerPublish(...args),
      claim: (...args) => store.dockerClaim(...args),
    },
  };
  return {
    f,
    native,
    store,
    old,
    port,
    prepare,
    admission,
    current,
    advance: (ms: number) => {
      clock += ms;
    },
    moves: new PlanMoves(port),
  };
}
describe('bounded genuine disjoint journal admission', () => {
  it('refreshes after reserve and validates each locked boundary without repeated native checks', async () => {
    const f = await disjointAdmissionFixture();
    await f.moves.begin(f.f.input, undefined, f.port);
    await expect.poll(() => f.prepare.mock.calls.length).toBe(1);
    expect(f.admission).toHaveBeenCalledTimes(2);
    await expect.poll(async () => (await f.store.dockerRecord(f.f.record.id)).phase).toBe('recovery-required');
    const record = await f.store.dockerRecord(f.f.record.id);
    expect(record.error).toBe('admitted preparation boundary');
    expect(record.dockerReplacement?.sourceStop).toBeUndefined();
    expect(record.dockerReplacement?.paidDispatch).toBeUndefined();
    expect((await f.store.load()).find((r) => r.id === f.old.id)).toEqual(f.old);
    expect(f.native.command.create).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.native.command.run)
        .mock.calls.every(([a]) => a[0] === 'exec' || (a[0] === 'container' && a[1] === 'inspect'))
    ).toBe(true);
  });

  it.each(['grant', 'binding', 'history', 'history-removed'] as const)(
    'refuses changed %s at actual locked admission without native effects',
    async (change) => {
      const f = await disjointAdmissionFixture(0),
        reserve = f.port.dockerJournal!.reserve;
      f.port.dockerJournal!.reserve = async (...args) => {
        if (change === 'grant' || change === 'binding')
          await f.f.store.update((state) => {
            const employee = state.employees[0]!;
            if (change === 'grant') employee.permissions.moveOwnPlan = false;
            else employee.sessionGeneration++;
          });
        else await f.store.save(change === 'history' ? [{ ...f.old, toAccount: 'changed' }] : []);
        return reserve(...args);
      };
      await expect(f.moves.begin(f.f.input, undefined, f.port)).rejects.toThrow();
      expect(f.prepare).not.toHaveBeenCalled();
      const record = await f.store.dockerRecord(f.f.record.id);
      expect(record.phase).toBe('recovery-required');
      expect(record.dockerReplacement?.sourceStop).toBeUndefined();
      expect(record.dockerReplacement?.paidDispatch).toBeUndefined();
      expect(f.native.command.create).not.toHaveBeenCalled();
    }
  );

  it.each(['grant', 'expired-native'] as const)('rechecks %s after an actual writer-lock await', async (change) => {
    const f = await disjointAdmissionFixture(0);
    let locked!: () => void, release!: () => void, atReserve!: () => void;
    const entered = new Promise<void>((r) => {
        locked = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const reached = new Promise<void>((r) => {
      atReserve = r;
    });
    const held = withCanonicalStateLock(f.store.file, async () => {
      locked();
      await gate;
    });
    await entered;
    const reserve = f.port.dockerJournal!.reserve;
    f.port.dockerJournal!.reserve = (...args) => {
      atReserve();
      return reserve(...args);
    };
    const pending = f.moves.begin(f.f.input, undefined, f.port).then(
      () => undefined,
      (error) => error
    );
    try {
      await reached;
      if (change === 'grant') f.f.revokeKey();
      else f.advance(5001);
    } finally {
      release();
    }
    await held;
    expect(await pending).toBeInstanceOf(Error);
    expect(f.prepare).not.toHaveBeenCalled();
    expect((await f.store.dockerRecord(f.f.record.id)).dockerReplacement?.sourceStop).toBeUndefined();
    expect(f.native.command.create).not.toHaveBeenCalled();
  });

  it.each(['lost-ack', 'revoked-after-write', 'expired-after-write'] as const)(
    'retains the exact original after %s',
    async (change) => {
      const f = await disjointAdmissionFixture(0),
        write = companyPublication.writeCompanyStateFile;
      vi.spyOn(companyPublication, 'writeCompanyStateFile').mockImplementationOnce(async (...args) => {
        await write(...args);
        if (change === 'lost-ack') throw Error('synthetic lost reservation ACK');
        if (change === 'revoked-after-write') f.f.revokeKey();
        else f.advance(5001);
      });
      await expect(f.moves.begin(f.f.input, undefined, f.port)).rejects.toThrow();
      const retained = await new PlanMoveStore(f.store.file).dockerRecord(f.f.record.id);
      expect(retained.phase).toBe('recovery-required');
      expect(retained.dockerReplacement?.seed.moveId).toBe(f.f.input.id);
      expect(retained.dockerReplacement?.sourceStop).toBeUndefined();
      expect(retained.dockerReplacement?.paidDispatch).toBeUndefined();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.native.command.create).not.toHaveBeenCalled();
    }
  );

  it('keeps historical correlation data separate from native authority and exact tuple admission', async () => {
    const f = await disjointAdmissionFixture(0);
    const proof = await f.admission(f.f.record.employeeId, undefined, [f.old]);
    expect(() => requireDockerPlanDisjointHistoryData(proof, [f.old], f.f.record.employeeId, undefined)).not.toThrow();
    expect(() =>
      requireDockerPlanDisjointHistoryData(
        proof,
        [{ ...f.old, toAccount: 'changed' }],
        f.f.record.employeeId,
        undefined
      )
    ).toThrow();
    expect(() =>
      requireDockerPlanDisjointReservation(proof, { ...f.f.record, oldSession: f.old.oldSession }, [f.old])
    ).toThrow();
    expect(() => requireDockerPlanDisjointReservation(proof, { ...f.f.record, owner: 'foreign' }, [f.old])).toThrow();
    f.advance(5001);
    // Unchanged history is still only DATA. It cannot refresh or admit an
    // expired private native proof at any Store publication boundary.
    expect(() => requireDockerPlanDisjointHistoryData(proof, [f.old], f.f.record.employeeId, undefined)).not.toThrow();
    expect(() => requireDockerPlanDisjointReservation(proof, f.f.record, [f.old])).toThrow(
      'DOCKER_PLAN_SOURCE_UNCONFIRMED'
    );
    expect(f.native.command.create).not.toHaveBeenCalled();
  });

  it.each(['json', 'prototype'] as const)(
    'denies a forged %s disjoint proof before journal publication',
    async (kind) => {
      const f = await disjointAdmissionFixture(0),
        proof = await f.admission(f.f.record.employeeId, undefined, [f.old]);
      const forged: unknown =
        kind === 'json' ? JSON.parse(JSON.stringify(proof)) : Object.create(Object.getPrototypeOf(proof));
      expect(() => requireDockerPlanDisjointHistoryData(forged, [f.old], f.f.record.employeeId, undefined)).toThrow();
      await expect(f.store.dockerReserve(f.f.record, () => f.f.current(), forged)).rejects.toThrow();
      expect((await f.store.load()).map((r) => r.id)).toEqual([f.old.id]);
      expect(f.native.command.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a changed native birth during genuine capture before creating a journal', async () => {
    const f = await disjointAdmissionFixture(0);
    f.native.afterInit(() => f.native.ticks('456'));
    await expect(f.moves.begin(f.f.input, undefined, f.port)).rejects.toThrow('DOCKER_PLAN_SOURCE_UNCONFIRMED');
    expect((await f.store.load()).map((r) => r.id)).toEqual([f.old.id]);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.native.command.create).not.toHaveBeenCalled();
  });
});
describe('genuine requester grant for one Docker plan journal', () => {
  it('captures real HMAC scope without a Session/viewer and binds the exact new choice', async () => {
    const f = await fixture();
    expect(await f.capture()).toBe(200);
    expect(requireDockerPlanMoveRequesterSource(f.proof(), f.record.employeeId, undefined)).toMatchObject({
      requester: { kind: 'agent', employeeId: f.record.employeeId, sessionId: f.record.oldSession },
      employeeId: f.record.employeeId,
      sessionId: f.record.oldSession,
      sessionGeneration: 1,
    });
    expect(requireDockerPlanMoveRequesterReservation(f.proof(), f.input, undefined).choice?.moveId).toBe(f.record.id);
    expect(() =>
      requireDockerPlanMoveRequesterReservation(f.proof(), { ...f.input, toAccount: 'other' }, undefined)
    ).toThrow();
    expect(() =>
      requireDockerPlanMoveRequesterReservation(f.proof(), { ...f.input, forceBusy: true }, undefined)
    ).toThrow();
    f.current();
  });
  it('refuses unsigned, mixed and wrong-parent transport', async () => {
    const f = await fixture();
    expect(await f.capture({} as typeof f.headers)).toBe(403);
    expect(await f.capture({ ...f.headers, 'x-reverie-parent-session': f.targetSid })).toBe(403);
    expect(await f.capture({ ...f.headers, authorization: 'Bearer refused' } as typeof f.headers)).toBe(403);
  });
  it.each(['permission', 'attendance', 'binding', 'generation', 'recipe', 'runtime'] as const)(
    'revokes genuine %s after capture and stays revoked',
    async (kind) => {
      const f = await fixture();
      expect(await f.capture()).toBe(200);
      if (kind === 'runtime') f.revokeKey();
      else
        await f.store.update((state) => {
          const e = state.employees[0]!;
          if (kind === 'permission') e.permissions.moveOwnPlan = false;
          if (kind === 'attendance') e.onVacation = true;
          if (kind === 'binding') e.dockerBinding!.containerId = '9'.repeat(64);
          if (kind === 'generation') e.sessionGeneration++;
          if (kind === 'recipe') e.runtimeRecipe = { mode: 'codex', workingDir: '/synthetic-workspace', configs: {} };
        });
      expect(() => f.current()).toThrow();
    }
  );
  it('survives only its own durable source stop and exact committed target rebind', async () => {
    const f = await fixture();
    expect(await f.capture()).toBe(200);
    f.current();
    f.physicalGone();
    f.current(f.closed); // no old HMAC.current after this planned transition
    const state = f.paid();
    f.record.newSession = f.targetSid;
    await f.store.update((company) => {
      const e = company.employees[0]!;
      e.runtimeRecipe = f.targetRecipe;
      e.sessionId = f.targetSid;
      e.sessionGeneration = state.seed.target.sessionGeneration;
      e.dockerBinding = {
        version: 1,
        operationId: f.targetOp,
        credentialId: state.seed.target.credentialId,
        sessionId: f.targetSid,
        sessionGeneration: state.seed.target.sessionGeneration,
        containerId: state.work!.destination!.containerId,
        imageId: state.work!.destination!.imageId,
        originalDigest: dockerContinuationDigest(state.work!.destination),
        policyDigest: dockerContinuationDigest(state.work!.policy),
      };
    });
    expect(() => f.current(state)).not.toThrow();
    await f.store.update((company) => {
      company.employees[0]!.permissions.moveOwnPlan = false;
    });
    expect(() => f.current(state)).toThrow();
  });

  it('reacquires exact original observation from the actual journal under genuine new-target HMAC', async () => {
    const f = await fixture(),
      state = f.paid();
    await f.moveStore.dockerPublish(f.record.id, f.state, state, () => {});
    await f.store.update((company) => {
      const e = company.employees[0]!;
      e.runtimeRecipe = f.targetRecipe;
      e.sessionId = f.targetSid;
      e.sessionGeneration = 2;
      e.dockerBinding = {
        version: 1,
        operationId: f.targetOp,
        credentialId: state.seed.target.credentialId,
        sessionId: f.targetSid,
        sessionGeneration: 2,
        containerId: state.work!.destination!.containerId,
        imageId: state.work!.destination!.imageId,
        originalDigest: dockerContinuationDigest(state.work!.destination),
        policyDigest: dockerContinuationDigest(state.work!.policy),
      };
    });
    const token = f.authentication.issue(f.selected(f.record.employeeId)!, () => true);
    f.setTarget({ employeeId: f.record.employeeId, sessionId: f.record.oldSession, purpose: 'original' });
    expect(await f.capture({ [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': f.targetSid })).toBe(
      200
    );
    expect(() => f.current(state)).not.toThrow();
    expect(() => requireDockerPlanMoveRequesterReservation(f.proof(), f.input, undefined)).toThrow();
  });

  it('retains an original return-to-office choice under owner recovery', async () => {
    const f = await fixture(undefined, true);
    f.authSessions.set('owner', { ip: '127.0.0.1', ua: 'test', createdAt: Date.now(), method: 'basic' });
    f.setTarget({ employeeId: f.record.employeeId, sessionId: f.record.oldSession, purpose: 'original' });
    expect(await f.capture()).toBe(403);
    expect(await f.capture({
      host: 'office.test',
      origin: 'https://office.test',
      cookie: 'reverie_session=owner',
    } as unknown as typeof f.headers)).toBe(200);
    expect(() => f.current()).not.toThrow();
  });

  it.each(['issuer-close', 'issuer-key', 'token', 'parent', 'mixed'] as const)(
    'retains genuine %s revocation after planned source closure',
    async (kind) => {
      const f = await fixture();
      expect(await f.capture()).toBe(200);
      f.physicalGone();
      f.current(f.closed);
      if (kind === 'issuer-close') f.authentication.close();
      if (kind === 'issuer-key') f.issuerKeyLost();
      if (kind === 'token') f.tamper(DOCKER_WORKER_IDENTITY_HEADER, 'changed');
      if (kind === 'parent') f.tamper('x-reverie-parent-session', f.targetSid);
      if (kind === 'mixed') f.tamper('authorization', 'Bearer forbidden');
      expect(f.runtimeStillCurrent()).toBe(true); // not the synthetic runtime-current failure
      expect(() => f.current(f.closed)).toThrow();
    }
  );
  it.each(['issuer-close', 'issuer-key', 'recipe', 'account'] as const)(
    'refuses genuine %s change after exact target publication',
    async (kind) => {
      const f = await fixture();
      expect(await f.capture()).toBe(200);
      const state = f.paid();
      await f.store.update((company) => {
        const e = company.employees[0]!;
        e.runtimeRecipe = f.targetRecipe;
        e.sessionId = f.targetSid;
        e.sessionGeneration = 2;
        e.dockerBinding = {
          version: 1,
          operationId: f.targetOp,
          credentialId: state.seed.target.credentialId,
          sessionId: f.targetSid,
          sessionGeneration: 2,
          containerId: state.work!.destination!.containerId,
          imageId: state.work!.destination!.imageId,
          originalDigest: dockerContinuationDigest(state.work!.destination),
          policyDigest: dockerContinuationDigest(state.work!.policy),
        };
      });
      f.physicalGone();
      f.current(state);
      if (kind === 'issuer-close') f.authentication.close();
      if (kind === 'issuer-key') f.issuerKeyLost();
      if (kind === 'recipe' || kind === 'account')
        await f.store.update((company) => {
          const recipe = company.employees[0]!.runtimeRecipe!;
          if (kind === 'recipe') recipe.model = 'different-model';
          else recipe.subscriptionProfile!.id = 'other-account';
        });
      expect(f.runtimeStillCurrent()).toBe(true);
      expect(() => f.current(state)).toThrow();
    }
  );
  it('uses only the locked stock native-observation projection for recipe currency', () => {
    const recipe = {
      mode: 'codex',
      workingDir: '/synthetic',
      configs: { codexConfig: { dangerouslyBypassApprovals: true } },
      runtimeThreads: { codex: 'first' },
    };
    const observed = {
      ...recipe,
      runtimeThreads: { codex: 'second' },
      configs: {
        codexConfig: {
          ...recipe.configs.codexConfig,
          resumeSessionId: 'second',
        },
      },
    };
    expect(dockerProviderRuntimeRecipeDigest(observed)).toBe(dockerProviderRuntimeRecipeDigest(recipe));
    expect(dockerProviderRuntimeRecipeDigest({ ...observed, model: 'different' })).not.toBe(
      dockerProviderRuntimeRecipeDigest(recipe)
    );
    expect(dockerProviderRuntimeRecipeDigest({ ...observed, mode: 'unknown' })).not.toBe(
      dockerProviderRuntimeRecipeDigest({ ...recipe, mode: 'unknown' })
    );
  });
  it('does not accept a different move target as expected self-rebind', async () => {
    const f = await fixture();
    expect(await f.capture()).toBe(200);
    await f.store.update((company) => {
      const e = company.employees[0]!;
      e.runtimeRecipe = f.targetRecipe;
      e.sessionId = f.targetSid;
      e.sessionGeneration = 2;
    });
    expect(() => f.current(f.closed)).toThrow();
  });
  it('permits benign employee note and wake counters without widening target scope', async () => {
    const f = await fixture();
    expect(await f.capture()).toBe(200);
    await f.store.update((company) => {
      const e = company.employees[0]!;
      e.personality = 'Synthetic note';
      e.wakeAttempts = [1];
    });
    expect(() => f.current()).not.toThrow();
  });
  it('requires team plan permission and confines recoverEmployees to the frozen original', async () => {
    const f = await fixture(),
      managerId = '90000000-0000-4000-8000-000000000009',
      managerSid = 'a0000000-0000-4000-8000-00000000000a';
    await f.store.update((company) =>
      company.employees.push(
        EmployeeSchema.parse({
          id: managerId,
          name: 'Manager',
          icon: 'X',
          position: 'Coordinator',
          expertise: ['testing'],
          createdAt: 1,
          sessionId: managerSid,
          sessionGeneration: 1,
          onVacation: false,
          desiredRunning: true,
          permissions: { moveOwnPlan: true },
          dockerBinding: { ...f.state.seed.source.binding, sessionId: managerSid, containerId: '9'.repeat(64) },
        })
      )
    );
    const token = f.authentication.issue(f.selected(managerId)!, () => true);
    const headers = { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': managerSid };
    expect(await f.capture(headers)).toBe(403);
    await f.store.update((company) => {
      company.employees[1]!.permissions.managePlans = true;
    });
    expect(await f.capture(headers)).toBe(200);
    f.current();
    await f.store.update((company) => {
      const p = company.employees[1]!.permissions;
      p.managePlans = false;
      p.recoverEmployees = true;
    });
    expect(await f.capture(headers)).toBe(403);
    f.setTarget({
      employeeId: f.record.employeeId,
      sessionId: f.record.oldSession,
      purpose: 'original',
      choice: { moveId: f.record.id, toAccount: f.record.toAccount, forceBusy: false },
    });
    expect(await f.capture(headers)).toBe(200);
    f.current();
    expect(() => requireDockerPlanMoveRequesterReservation(f.proof(), f.input, undefined)).toThrow(
      'new Docker plan choice'
    );
  });
  it('uses current owner authentication separately from any agent hint', async () => {
    const f = await fixture();
    f.authSessions.set('owner', { ip: '127.0.0.1', ua: 'test', createdAt: Date.now(), method: 'basic' });
    const headers = {
      host: 'office.test',
      origin: 'https://office.test',
      cookie: 'reverie_session=owner',
    } as unknown as typeof f.headers;
    expect(await f.capture(headers)).toBe(200);
    f.current();
    f.authSessions.delete('owner');
    expect(() => f.current()).toThrow();
  });
  it('rejects serialized/prototype-forged grants and monotonic clock rollback', async () => {
    const f = await fixture();
    expect(await f.capture()).toBe(200);
    for (const proof of [
      { source: () => ({}) },
      structuredClone(f.proof()),
      Object.create(DockerPlanMoveRequester.prototype),
    ])
      expect(() => requireDockerPlanMoveRequesterSource(proof, f.record.employeeId, undefined)).toThrow();
    vi.spyOn(performance, 'now').mockReturnValue(-1);
    expect(() => f.current()).toThrow();
  });
});
