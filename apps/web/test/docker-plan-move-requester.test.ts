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
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = dockerPlanJournalFixture();
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
        onVacation: false,
        desiredRunning: true,
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
    choice: { moveId: f.record.id, toAccount: f.record.toAccount, forceBusy: false },
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
    forceBusy: false,
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
describe('genuine requester grant for one Docker plan journal', () => {
  it('captures real HMAC scope without a Session/viewer and binds the exact new choice', async () => {
    const f = await fixture();
    expect(await f.capture()).toBe(200);
    expect(requireDockerPlanMoveRequesterSource(f.proof(), f.record.employeeId, undefined)).toMatchObject({
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
