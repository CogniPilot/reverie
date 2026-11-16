import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { dockerPlanRetirementFixture } from './helpers/docker-plan-retirement-fixture.js';
import { dockerPlanSourceRecordCurrent } from '../src/docker-plan-move-actor.js';
/** Real captured HTTP/HMAC requester, canonical CompanyStore/PlanMoveStore and
 * private native SourceReader over controlled Docker replies. This is NOT an
 * actual Docker/provider or complete move acceptance claim. */
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {
  DockerPlanMoveActor,
  type DockerPlanMoveComposition,
  requireDockerPlanPaidDispatch,
} from '../src/docker-plan-move-actor.js';
import { dockerPlanSourceFixture } from './helpers/docker-plan-source-fixture.js';
import { DockerEmployeeEngine, type DockerContainedResourceController } from '../src/docker-employee-engine.js';
import { boxedOriginal } from '../src/docker-employee-engine-data.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import {
  CompanyDockerContinuationStore,
  dockerEmployeeSourceDigest,
  dockerEmployeeProviderSourceDigest,
} from '../src/docker-employee-store.js';
import { DockerEmployeeSessionProvider } from '../src/docker-employee-session-provider.js';
import { DockerResourceRevisionStore, dockerRevisedPolicy } from '../src/docker-resource-revisions.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { PlanService, type PlanAccount } from '../src/plan-accounts.js';
import { PackagedDockerEngineCommand } from '../src/docker-engine-command.js';
import { expertRuntimeRecipeData } from '../src/expert-runtime-recipe.js';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  DOCKER_WORKER_IDENTITY_HEADER,
} from '../src/docker-worker-identity.js';
import {
  captureDockerPlanMoveRequester,
  captureDockerPlanMoveOriginalRequester,
  requireDockerPlanMoveRequesterCurrent,
} from '../src/docker-plan-move-requester.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import {
  DockerPlanMoveSeed,
  DockerPlanMoveJournalState,
  dockerPlanMoveHandoffDigest,
} from '../src/docker-plan-move-data.js';
import { dockerPlanMaterial } from '../src/docker-plan-material.js';
import { dockerProviderRuntimeRecipeDigest } from '../src/docker-employee-source-correlation.js';
import { DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM } from '../src/docker-plan-account-status.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../src/docker-employee-provider-view-native.js';
import { StateStore } from '../src/state-store.js';
import { Session } from '../src/session.js';
import { PlanMoves, PlanMoveComposerNotReady } from '../src/plan-move.js';
import type { PlanMoveRecord, PlanMoveInput, PlanMoveExecutor, PlanMovePort } from '../src/plan-move.js';
import { PlanMoveRequests } from '../src/plan-request.js';
import { requireDockerPlanDisjointGeneration } from '../src/docker-plan-disjoint-generation.js';
import { dockerPlanMaximumStates } from '../src/docker-plan-move-capacity.js';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import type { PlanMoveDockerJournal } from '../src/plan-move-docker.js';
import type { SessionState } from '../src/types.js';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(running = true, retainedAccount = false) {
  const f = dockerPlanSourceFixture(running),
    directory = fs.mkdtempSync(join(tmpdir(), 'plan-actor-'));
  fs.chmodSync(directory, 0o700);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved: SessionState = {
    id: f.row.request.sessionId,
    pid: null,
    status: 'stopped',
    currentTaskId: null,
    createdAt: 1,
    lastActivityAt: 1,
    mode: 'claude',
    workingDir: '/workspace',
    resumeSessionId: '90000000-0000-4000-8000-000000000009',
    claudeMode: 'normal',
    allowedTools: 'Read',
    subscriptionProfile: { id: 'a', label: 'A', provider: 'anthropic' },
  };
  const policy = { ...f.row.policy, memoryHighBytes: 8 * 1024 ** 3 },
    binding = { ...f.binding, policyDigest: digest(policy) };
  const employee = EmployeeSchema.parse({
    id: f.row.employeeId,
    name: 'Synthetic',
    icon: 'X',
    position: 'Engineer',
    expertise: ['testing'],
    createdAt: 1,
    sessionId: saved.id,
    sessionGeneration: 1,
    onVacation: false,
    desiredRunning: true,
    permissions: { moveOwnPlan: true },
    runtimeRecipe: expertRuntimeRecipeData(saved, {
      mode: 'claude',
      workingDir: '/workspace',
      subscriptionProfile: saved.subscriptionProfile,
    }),
    dockerBinding: binding,
    dockerResourcePolicy: policy,
  });
  const legacy = {
    ...structuredClone(f.raw),
    Id: f.row.original.containerId,
    State: { ...f.raw.State, Running: false, Pid: 0, Status: 'exited' },
    Config: {
      ...f.raw.Config,
      Labels: { 'reverie.worker': 'synthetic', 'reverie.employee': employee.id, 'reverie.session': saved.id },
    },
  };
  const original = boxedOriginal(
    legacy,
    {
      employeeId: employee.id,
      sessionId: saved.id,
      sessionGeneration: 1,
      owner: undefined,
      sourceDigest: 'a'.repeat(64),
      providerSourceDigest: 'a'.repeat(64),
      onVacation: false,
      desiredRunning: true,
    },
    'synthetic'
  );
  const row = DockerEmployeeContinuationRecord.parse({
    ...f.row,
    original,
    policy,
    sourceDigest: dockerEmployeeSourceDigest(employee, saved),
    providerSourceDigest: dockerEmployeeProviderSourceDigest(employee, saved),
  });
  const companyStore = new CompanyStore(join(directory, 'company.json'));
  await companyStore.init();
  await companyStore.update((state) => {
    state.employees = [employee];
    state.dockerEmployeeContinuations = [row];
  });
  const company = new CompanyService(companyStore, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  const sourceStore = new CompanyDockerContinuationStore(
    company,
    (id) => (id === saved.id ? saved : undefined),
    (owner, original) => {
      const desired = revisions.desired(owner);
      return desired ? dockerRevisedPolicy(original, desired) : original;
    }
  );
  const base = vi.mocked(f.command.run).getMockImplementation()!;
  let loseStop = false;
  const run = vi.fn(async (args: readonly string[], input?: string) => {
    if (args[0] === 'image')
      return JSON.stringify([
        {
          Id: f.raw.Image,
          RootFS: { Layers: ['sha256:synthetic'] },
          Config: {
            Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
            Cmd: null,
            Labels: { 'org.reverie.worker-client.manifest': f.row.workerImage.clientManifestDigest },
          },
        },
      ]);
    if (args[0] === 'container' && args[1] === 'inspect' && args[2] === legacy.Id) return JSON.stringify([legacy]);
    if (args[0] === 'container' && args[1] === 'stop') {
      f.raw.State.Running = false;
      f.raw.State.Pid = 0;
      f.raw.State.Status = 'exited';
      if (loseStop) throw Error('synthetic transport closed');
      return args.at(-1)!;
    }
    return base(args, input);
  });
  vi.spyOn(PackagedDockerEngineCommand.prototype, 'run').mockImplementation(run);
  const nativeCreate = vi.spyOn(PackagedDockerEngineCommand.prototype, 'create').mockImplementation(async () => {
    throw Error('CREATE forbidden');
  });
  const resources: DockerContainedResourceController = {
    validate: async () => {},
    preparePool: async () => {
      throw Error('no effects');
    },
    observePool: async () => null,
    read: async () => null,
    configure: async () => {
      throw Error('no effects');
    },
  };
  const engine = new DockerEmployeeEngine(
    f.command,
    'synthetic',
    resources,
    {
      imageId: f.raw.Image,
      clientManifestDigest: f.row.workerImage.clientManifestDigest,
      sourceImageIds: [f.raw.Image],
    },
    sourceStore,
    'sha256:' + 'f'.repeat(64),
    '7'.repeat(64)
  );
  // Engine receives the same controlled actual OS reply port as the packaged actor.
  vi.mocked(f.command.run).mockImplementation(run);
  const sessions = new Map(),
    ctx = {
      sessions,
      store: { getSession: (id: string) => (id === saved.id ? saved : undefined) },
      mux: {},
      getClaudeModeConfig: async () => ({ claudeMode: 'normal' }),
    } as unknown as DockerPlanMoveComposition['ctx'];
  const provider = new DockerEmployeeSessionProvider(sourceStore, ctx, 'http://reverie:3000'),
    moves = new PlanMoveStore(join(directory, 'moves.json'));
  const revisions = new DockerResourceRevisionStore(join(directory, 'revisions'));
  await revisions.approve(
    {
      revision: 'b0000000-0000-4000-8000-00000000000b',
      owner: null,
      scope: 'all-current-and-future',
      memoryHighBytes: 48 * 1024 ** 3,
    },
    null,
    () => {}
  );
  cleanup.push(() => {
    engine.close();
    revisions.close();
  });
  const accounts = new Map<string, PlanAccount>();
  for (const id of ['a', 'b']) {
    const root = join(directory, id);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(join(root, '.credentials.json'), JSON.stringify({ synthetic: id }), { mode: 0o600 });
    accounts.set(id, {
      id,
      label: id.toUpperCase(),
      provider: 'anthropic',
      configDir: root,
      realDir: root,
      profileId: id,
      isDefault: false,
      profile: { id, label: id.toUpperCase(), provider: 'anthropic', configDir: root, openCodeDataDir: root },
    });
  }
  const plans = new PlanService({
    reader: {
      read: async () => {
        throw Error('no vendor requests');
      },
    },
    sessions: () => [],
    coordinatorIds: () => [],
    historyFile: join(directory, 'history.json'),
    home: directory,
  });
  vi.spyOn(plans, 'account').mockImplementation(async (id) => accounts.get(id));
  vi.spyOn(plans, 'accountForSavedState').mockImplementation(async () => accounts.get('a'));
  let key = true;
  const selected = (id: string) => {
    const current = companyStore.snapshot().employees.find((e) => e.id === id),
      b = current?.dockerBinding;
    return current && b
      ? {
          employeeId: id,
          owner: current.owner,
          sessionId: current.sessionId,
          sessionGeneration: current.sessionGeneration,
          containerId: b.containerId,
          credentialId: b.credentialId,
        }
      : undefined;
  };
  const auth = new DockerWorkerIdentityAuthentication('a0000000-0000-4000-8000-00000000000a', Buffer.alloc(32, 0x41), {
    binding: selected,
    keyCurrent: () => key,
  });
  cleanup.push(() => auth.close());
  const token = auth.issue(selected(employee.id)!, () => key),
    app = Fastify();
  await app.register(cookie);
  registerDockerWorkerIdentity(app, auth);
  let proof: unknown;
  const input: PlanMoveInput = {
    id: 'synthetic-actor-move',
    employeeId: employee.id,
    sessionId: saved.id,
    fromAccount: 'a',
    toAccount: 'b',
    forceBusy: true,
    handoff: 'Continue the synthetic work.',
  };
  const current = () => {
    if (!key) throw Error('runtime revoked');
  };
  app.post('/api/capture', async (request) => {
    proof = captureDockerPlanMoveRequester(
      request,
      {
        employeeId: employee.id,
        sessionId: saved.id,
        sessionGeneration: 1,
        choice: { moveId: input.id, toAccount: input.toAccount, forceBusy: true },
      },
      company,
      { authSessions: null },
      undefined,
      current
    );
    return { success: true };
  });
  await app.ready();
  cleanup.push(() => app.close());
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/capture',
        headers: { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': saved.id },
      })
    ).statusCode
  ).toBe(200);
  const retain = vi.fn(),
    baseActor = new DockerPlanMoveActor({
      company,
      ctx,
      plans,
      moves,
      chat: {} as DockerPlanMoveComposition['chat'],
      store: sourceStore,
      engine,
      provider,
      configuration: {
        version: 1,
        purpose: 'reverie-boxed-runtime-v1',
        deployment: 'synthetic',
        workerImageId: f.raw.Image,
        clientManifestDigest: f.row.workerImage.clientManifestDigest,
        sourceImageIds: [f.raw.Image],
        helperImageId: 'sha256:' + 'f'.repeat(64),
        apiUrl: 'http://reverie:3000',
      },
      boxId: '7'.repeat(64),
      authentication: auth,
      revisions,
      current,
      retain,
    });
  const actor = baseActor.withRequesterAuthority(proof);
  const selectedSeed = await actor.reserve(input, undefined, 'd'.repeat(64)),
    seed = retainedAccount
      ? DockerPlanMoveSeed.parse({
          ...selectedSeed,
          target: {
            ...selectedSeed.target,
            accountSource: {
              kind: 'retained-generation',
              moveId: 'old-account-move',
              operationId: selectedSeed.source.binding.operationId,
              containerId: selectedSeed.source.binding.containerId,
              projectionDigest: 'a'.repeat(64),
              originalCanonicalSnapshotDigest: selectedSeed.target.accountSnapshotDigest,
            },
          },
        })
      : selectedSeed,
    epoch = 'e0000000-0000-4000-8000-00000000000e';
  let state = DockerPlanMoveJournalState.parse({ version: 1, purpose: 'docker-plan-replacement-v1', epoch, seed });
  const record: PlanMoveRecord = {
    id: input.id,
    employeeId: employee.id,
    name: employee.name,
    oldSession: saved.id,
    newSession: seed.target.sessionId,
    fromAccount: 'a',
    toAccount: 'b',
    phase: 'waiting',
    at: 1,
    requestDigest: seed.requestDigest,
    dockerReplacement: state,
  };
  await moves.save([record]);
  const journal: PlanMoveDockerJournal = {
    moveId: record.id,
    epoch,
    publication: 'admitting',
    current: () => {
      current();
      moves.dockerCurrent(record.id, epoch, digest(seed));
      requireDockerPlanMoveRequesterCurrent(proof, record, state);
    },
    read: () => structuredClone(state),
    publish: async (before, next) => {
      const result = await moves.dockerPublish(record.id, before, next, () => {
        current();
        requireDockerPlanMoveRequesterCurrent(proof, record, state);
      });
      state = result.dockerReplacement!;
    },
  };
  return {
    ...f,
    directory,
    actor,
    baseActor,
    record,
    journal,
    input,
    seed,
    saved,
    companyStore,
    sourceStore,
    run,
    nativeCreate,
    retain,
    sessions,
    plans,
    accounts,
    moves,
    freshActor: () => baseActor.withRequesterAuthority(proof),
    auth,
    token,
    loseStop: () => {
      loseStop = true;
    },
    keyLost: () => {
      key = false;
    },
  };
}

/** Historical cursor DATA, published through the real journal CAS. This fixture
 * deliberately supplies no target Session, installed material or native proof;
 * recovering actors must not confuse these entries with effect authority. */
async function issuedCheckpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  handoff?: 'issued' | 'submitted',
  publication: 'issued' | 'published' = 'published'
) {
  await f.actor.stopSource(f.record, f.journal);
  const before = f.journal.read(),
    seed = before.seed,
    prior = dockerPlanJournalFixture(),
    material = prior.material,
    selected = dockerPlanMaterial(
      {
        operationId: seed.target.operationId,
        sessionId: seed.target.sessionId,
        provider: seed.target.provider,
        accountId: seed.target.accountId,
        context: material.context,
      },
      material.authDigest
    ),
    destination = {
      ...seed.source.record.destination!,
      containerId: 'f'.repeat(64),
      sessionId: seed.target.sessionId,
    },
    work = {
      ...prior.work,
      employeeId: f.record.employeeId,
      owner: f.record.owner,
      request: {
        ...prior.work.request,
        sessionId: seed.target.sessionId,
        sessionGeneration: seed.target.sessionGeneration,
        operationId: seed.target.operationId,
        containerId: seed.source.binding.containerId,
        imageId: seed.source.binding.imageId,
        expectedPolicyDigest: digest(seed.source.record.policy),
        expectedDestinationImageId: seed.target.workerImage.imageId,
      },
      original: seed.source.record.destination,
      workerImage: seed.target.workerImage,
      policy: seed.source.record.policy,
      credentialId: seed.target.credentialId,
      phase: 'ready',
      pool: {
        containerId: '1'.repeat(64),
        cgroupParent: '/synthetic-pool',
        policyDigest: digest(seed.source.record.policy.pool),
        physicalDigest: '2'.repeat(64),
      },
      destination,
      tasks: [
        {
          role: 'storage-holder',
          name: 'reverie-boxed-storage-synthetic',
          imageId: seed.target.workerImage.imageId,
          configurationDigest: '3'.repeat(64),
          containerId: '4'.repeat(64),
          phase: 'running',
          initPid: 42,
          initStartTicks: '1234',
        },
        ...(['identity-helper', 'leaf-helper'] as const).map((role) => ({
          role,
          name: 'reverie-boxed-' + role + '-synthetic',
          imageId: seed.target.workerImage.imageId,
          configurationDigest: '5'.repeat(64),
          containerId: (role === 'identity-helper' ? '6' : '7').repeat(64),
          phase: 'completed',
          resultDigest: '8'.repeat(64),
        })),
      ],
      planReplacement: {
        ...prior.work.planReplacement,
        moveId: seed.moveId,
        source: {
          binding: seed.source.binding,
          continuationDigest: digest(seed.source.record),
          providerSourceDigest: seed.source.providerSourceDigest,
        },
        account: {
          id: seed.target.accountId,
          provider: seed.target.provider,
          projectionDigest: selected.projectionDigest,
          contextDigest: selected.contextInputDigest,
        },
      },
    };
  await f.journal.publish(
    before,
    DockerPlanMoveJournalState.parse({
      ...before,
      material,
      work,
      paidDispatch: {
        phase: 'issued',
        epoch: before.epoch,
        operationId: seed.target.operationId,
        sessionId: seed.target.sessionId,
        containerId: destination.containerId,
        recipeDigest: work.sourceDigest,
      },
      companyPublication: {
        phase: publication,
        digest: digest({
          row: { ...work, phase: 'provider-issued' },
          binding: {
            version: 1,
            operationId: work.request.operationId,
            sessionId: work.request.sessionId,
            sessionGeneration: work.request.sessionGeneration,
            credentialId: work.credentialId,
            containerId: destination.containerId,
            imageId: destination.imageId,
            originalDigest: digest(destination),
            policyDigest: digest(work.policy),
          },
          templateDigest: seed.target.templateDigest,
        }),
      },
      ...(handoff ? { handoff: { phase: 'issued', digest: dockerPlanMoveHandoffDigest(seed.handoff) } } : {}),
    })
  );
  if (handoff === 'submitted') {
    const state = f.journal.read();
    await f.journal.publish(state, { ...state, handoff: { ...state.handoff!, phase: 'submitted' } });
  }
  return f.journal.read();
}

/** A retained, installed target checkpoint. The shared fixture supplies only
 * controlled syscall replies: actual Storage/Installer/Engine methods earn each
 * new private view. Canonical Company/Session/PlanMove stores and protected HTTP
 * original-recovery capture are real. No composer readiness is synthesized. */
async function publishedTargetFixture(publication: 'issued' | 'published', handoff?: 'issued' | 'submitted') {
  const native = await dockerPlanRetirementFixture(),
    directory = fs.mkdtempSync(join(tmpdir(), 'plan-actor-target-'));
  fs.chmodSync(directory, 0o700);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => native.engine.close());
  const saved = native.target.toState(),
    source = native.state.seed.source,
    row = native.state.work!,
    binding = {
      version: 1 as const,
      operationId: row.request.operationId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
      credentialId: row.credentialId,
      containerId: row.destination!.containerId,
      imageId: row.destination!.imageId,
      originalDigest: digest(row.destination),
      policyDigest: digest(row.policy),
    },
    employee = EmployeeSchema.parse({
      id: row.employeeId,
      name: 'Synthetic',
      icon: 'X',
      position: 'Engineer',
      expertise: ['testing'],
      createdAt: 1,
      sessionId: saved.id,
      sessionGeneration: row.request.sessionGeneration,
      onVacation: false,
      desiredRunning: true,
      permissions: { recoverEmployees: true },
      runtimeRecipe: expertRuntimeRecipeData(saved, { mode: 'claude', workingDir: saved.workingDir }),
      dockerBinding: binding,
      dockerResourcePolicy: row.policy,
    }),
    work = DockerEmployeeContinuationRecord.parse({
      ...row,
      sourceDigest: dockerEmployeeSourceDigest(employee, saved),
      providerSourceDigest: dockerEmployeeProviderSourceDigest(employee, saved),
    });
  const companyStore = new CompanyStore(join(directory, 'company.json'));
  await companyStore.init();
  await companyStore.update((company) => {
    company.employees = [employee];
    company.dockerEmployeeContinuations = [work];
  });
  const store = new StateStore(join(directory, 'state.json'));
  store.setSession(saved.id, saved);
  store.saveNow();
  cleanup.push(() => store.saveNow());
  const sessions = new Map([[native.target.id, native.target]]),
    ctx = {
      sessions,
      store,
      mux: {},
      getClaudeModeConfig: async () => ({ claudeMode: 'normal' }),
    } as unknown as DockerPlanMoveComposition['ctx'],
    company = new CompanyService(companyStore, {
      getSession: (id: string) => sessions.get(id),
      chatrooms: { rooms: () => [] },
      research: {},
    } as unknown as CompanyServiceDeps),
    sourceStore = new CompanyDockerContinuationStore(company, (id) => store.getSession(id)),
    moves = new PlanMoveStore(join(directory, 'moves.json')),
    state = DockerPlanMoveJournalState.parse({
      ...native.state,
      seed: {
        ...native.state.seed,
        target: {
          ...native.state.seed.target,
          templateDigest: dockerProviderRuntimeRecipeDigest(employee.runtimeRecipe),
        },
      },
      work,
      paidDispatch: { ...native.state.paidDispatch!, recipeDigest: work.sourceDigest },
      companyPublication: {
        phase: publication,
        digest: digest({
          row: { ...work, phase: 'provider-issued' },
          binding,
          templateDigest: dockerProviderRuntimeRecipeDigest(employee.runtimeRecipe),
        }),
      },
      handoff: handoff ? { phase: handoff, digest: dockerPlanMoveHandoffDigest(native.state.seed.handoff) } : undefined,
    }),
    record: PlanMoveRecord = { ...native.record, phase: 'checking', dockerReplacement: state };
  const reserved = DockerPlanMoveJournalState.parse({
    version: state.version,
    purpose: state.purpose,
    epoch: state.epoch,
    seed: state.seed,
  });
  await moves.dockerReserve({ ...record, phase: 'waiting', dockerReplacement: reserved }, () => {});
  const issued = DockerPlanMoveJournalState.parse({
    ...state,
    handoff: state.handoff ? { ...state.handoff, phase: 'issued' } : undefined,
  });
  await moves.dockerPublish(record.id, reserved, issued, () => {});
  if (handoff === 'submitted') await moves.dockerPublish(record.id, issued, state, () => {});
  const key = () => true,
    auth = new DockerWorkerIdentityAuthentication('a0000000-0000-4000-8000-00000000000a', Buffer.alloc(32, 0x41), {
      binding: (id) => {
        const current = companyStore.snapshot().employees.find((e) => e.id === id),
          b = current?.dockerBinding;
        return current && b
          ? {
              employeeId: current.id,
              owner: current.owner,
              sessionId: current.sessionId,
              sessionGeneration: current.sessionGeneration,
              containerId: b.containerId,
              credentialId: b.credentialId,
            }
          : undefined;
      },
      keyCurrent: key,
    });
  cleanup.push(() => auth.close());
  const token = auth.issue(
      {
        employeeId: employee.id,
        owner: employee.owner,
        sessionId: binding.sessionId,
        sessionGeneration: binding.sessionGeneration,
        containerId: binding.containerId,
        credentialId: binding.credentialId,
      },
      key
    ),
    app = Fastify();
  cleanup.push(() => app.close());
  await app.register(cookie);
  registerDockerWorkerIdentity(app, auth);
  let proof: unknown;
  app.post('/api/capture-original', async (request) => {
    proof = await captureDockerPlanMoveOriginalRequester(
      request,
      record.id,
      moves,
      company,
      { authSessions: null },
      undefined,
      () => {}
    );
    return { success: true };
  });
  await app.ready();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/capture-original',
        headers: {
          [DOCKER_WORKER_IDENTITY_HEADER]: token,
          'x-reverie-parent-session': saved.id,
        },
      })
    ).statusCode
  ).toBe(200);
  let accountStatus: (() => Promise<void>) | undefined, liveAuthDigest: string | undefined;
  const baseRun = vi.mocked(native.command.run).getMockImplementation()!,
    run = vi.fn(async (args: readonly string[], input?: string) => {
      if (args.includes(DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM)) {
        await accountStatus?.();
        return JSON.stringify({
          version: 1,
          purpose: 'reverie-plan-account-status-v1',
          provider: 'anthropic',
          authenticated: true,
        });
      }
      const text = await baseRun(args, input);
      if (liveAuthDigest && args.includes('plan-status') && args.includes('live'))
        return JSON.stringify({ ...JSON.parse(text), observedAuthDigest: liveAuthDigest });
      return text;
    });
  vi.mocked(native.command.run).mockImplementation(run);
  vi.spyOn(PackagedDockerEngineCommand.prototype, 'run').mockImplementation(run);
  const create = vi.spyOn(PackagedDockerEngineCommand.prototype, 'create').mockImplementation(async () => {
    throw Error('Unexpected recovery CREATE');
  });
  const plans = new PlanService({
      reader: {
        read: async () => {
          throw Error('No vendor requests');
        },
      },
      sessions: () => [],
      coordinatorIds: () => [],
      historyFile: join(directory, 'history.json'),
      home: directory,
    }),
    provider = new DockerEmployeeSessionProvider(sourceStore, ctx, 'http://reverie:3000'),
    launch = vi.spyOn(provider, 'launchPlanReplacement'),
    revisions = new DockerResourceRevisionStore(join(directory, 'revisions')),
    replaceSession = vi.fn(async () => {
      throw Error('Unexpected recovery room migration');
    }),
    baseActor = new DockerPlanMoveActor({
      company,
      ctx,
      plans,
      moves,
      chat: { replaceSession } as unknown as DockerPlanMoveComposition['chat'],
      store: sourceStore,
      engine: native.engine,
      provider,
      configuration: {
        version: 1,
        purpose: 'reverie-boxed-runtime-v1',
        deployment: 'synthetic',
        workerImageId: row.workerImage.imageId,
        clientManifestDigest: row.workerImage.clientManifestDigest,
        sourceImageIds: [source.binding.imageId],
        helperImageId: 'sha256:' + 'f'.repeat(64),
        apiUrl: 'http://reverie:3000',
      },
      boxId: '7'.repeat(64),
      authentication: auth,
      revisions,
      current: () => {},
      retain: () => {},
    });
  cleanup.push(() => revisions.close());
  let losePublicationAck = false;
  const loadJournal = async () => {
    // Reopen the actual disk journal rather than carrying an in-memory cursor
    // across reconstruction. Its DATA still supplies no native-view authority.
    const reopened = new PlanMoveStore(join(directory, 'moves.json'));
    let current = (await reopened.dockerRecord(record.id)).dockerReplacement!;
    const journal: PlanMoveDockerJournal = {
      moveId: record.id,
      epoch: current.epoch,
      publication: 'admitting',
      read: () => structuredClone(current),
      current: () => {
        reopened.dockerCurrent(record.id, current.epoch, digest(current.seed));
        requireDockerPlanMoveRequesterCurrent(proof, record, current);
      },
      publish: async (before, next) => {
        const result = await reopened.dockerPublish(record.id, before, next, () =>
          requireDockerPlanMoveRequesterCurrent(proof, record, current)
        );
        if (losePublicationAck) {
          losePublicationAck = false;
          throw Error('Synthetic publication ACK lost after durable commit');
        }
        current = result.dockerReplacement!;
      },
    };
    return journal;
  };
  run.mockClear();
  vi.mocked(native.command.create).mockClear();
  return {
    native,
    record,
    companyStore,
    store,
    sessions,
    moves,
    run,
    create,
    launch,
    replaceSession,
    loadJournal,
    actor: () => baseActor.withRequesterAuthority(proof),
    accountStatus: (callback: typeof accountStatus) => {
      accountStatus = callback;
    },
    liveAuthDigest: (value: string) => {
      liveAuthDigest = value;
    },
    losePublicationAck: () => {
      losePublicationAck = true;
    },
  };
}
describe('captured native plan actor before paid dispatch', () => {
  it('admits the genuine HMAC force route with the observed generation and refuses a stale generation before effects', async () => {
    const f = await fixture(),
      app = Fastify();
    cleanup.push(() => app.close());
    await app.register(cookie);
    registerDockerWorkerIdentity(app, f.auth);
    const begin = vi.fn(async () => ({ id: f.input.id, phase: 'waiting' }));
    const executor = { snapshot: f.actor.snapshot.bind(f.actor) } as PlanMoveExecutor;
    registerPlanMoveRoutes(
      app,
      { begin } as unknown as PlanMoves,
      { authSessions: null },
      undefined,
      () => executor,
      async () => 'claude'
    );
    const payload = {
      id: f.input.id,
      employeeId: f.input.employeeId,
      sessionId: f.input.sessionId,
      sessionGeneration: f.seed.source.binding.sessionGeneration,
      toAccount: f.input.toAccount,
      handoff: f.input.handoff,
    };
    const headers = { [DOCKER_WORKER_IDENTITY_HEADER]: f.token, 'x-reverie-parent-session': f.saved.id };
    const admitted = await app.inject({ method: 'POST', url: '/api/plans/moves/force', headers, payload });
    expect(admitted.statusCode).toBe(202);
    expect(begin).toHaveBeenCalledWith(
      { ...payload, fromAccount: 'a', forceBusy: true, targetMode: 'claude' },
      undefined,
      executor
    );
    expect(await f.actor.snapshot(f.input.employeeId, undefined)).toMatchObject({
      backend: 'docker',
      sessionId: f.saved.id,
      sessionGeneration: f.seed.source.binding.sessionGeneration,
    });
    begin.mockClear();
    const stale = await app.inject({
      method: 'POST',
      url: '/api/plans/moves/force',
      headers,
      payload: { ...payload, sessionGeneration: payload.sessionGeneration + 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(begin).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([args]) => args[1] === 'stop' || args[1] === 'start')).toBe(false);
  });
  it('qualifies a force source with no disposable controller Session, retaining no preview FD owner', async () => {
    const f = await fixture();
    expect(f.sessions.size).toBe(0);
    expect(f.seed.source.observation.kind).toBe('running');
    expect(f.seed.forceBusy).toBe(true);
    expect(f.retain).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([a]) => a[1] === 'stop' || a[1] === 'start')).toBe(false);
  });
  it('accepts an actual stopped source without inventing a PID birth or sending STOP', async () => {
    const f = await fixture(false);
    expect(f.seed.source.observation.kind).toBe('stopped');
    await f.actor.stopSource(f.record, f.journal);
    expect(f.journal.read().sourceStop).toMatchObject({ phase: 'closed', sourceInit: null });
    expect(f.run.mock.calls.filter(([a]) => a[1] === 'stop')).toHaveLength(0);
  });
  it('records the original STOP before dispatch and settles a lost reply from fresh stopped proof without replay', async () => {
    const f = await fixture();
    f.loseStop();
    await expect(f.actor.stopSource(f.record, f.journal)).rejects.toThrow('unconfirmed');
    expect(f.journal.read().sourceStop?.phase).toBe('issued');
    await f.actor.stopSource(f.record, f.journal);
    expect(f.journal.read().sourceStop?.phase).toBe('closed');
    expect(f.run.mock.calls.filter(([a]) => a[1] === 'stop')).toHaveLength(1);
  });
  it('refuses a source incarnation change before publishing or sending STOP', async () => {
    const f = await fixture();
    f.ticks('999');
    await expect(f.actor.stopSource(f.record, f.journal)).rejects.toThrow('incarnation');
    expect(f.journal.read().sourceStop).toBeUndefined();
    expect(f.run.mock.calls.filter(([a]) => a[1] === 'stop')).toHaveLength(0);
  });
  it('rechecks revoked genuine authority before its first native effect', async () => {
    const f = await fixture();
    f.keyLost();
    await expect(f.actor.stopSource(f.record, f.journal)).rejects.toThrow();
    expect(f.run.mock.calls.filter(([a]) => a[1] === 'stop')).toHaveLength(0);
  });
  it('projects a new approved default without rewriting the retained operation or employee approval', async () => {
    const f = await fixture(),
      before = f.companyStore.snapshot();
    expect(f.sourceStore.newOperationPolicy(f.record.employeeId).memoryHighBytes).toBe(48 * 1024 ** 3);
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.sourceStore.record(f.record.employeeId)?.policy.memoryHighBytes).toBe(8 * 1024 ** 3);
  });
  it('does not turn serialized decision/dispatch DATA into private capabilities', async () => {
    const f = await fixture();
    expect(() => f.baseActor.withDecisionAuthority?.({})).toThrow();
    expect(() => requireDockerPlanPaidDispatch({}, f.seed.source.record, f.seed.source.binding)).toThrow(
      'native paid-dispatch'
    );
  });
});

describe('immutable source row across legitimate readonly progress', () => {
  it('allows only provider-issued to ready with every other field identical', () => {
    const row = dockerPlanJournalFixture().state.seed.source.record,
      before = { ...row, phase: 'provider-issued' as const };
    expect(dockerPlanSourceRecordCurrent(before, row)).toBe(true);
    expect(dockerPlanSourceRecordCurrent(row, before)).toBe(false);
    for (const actual of [
      { ...row, sourceDigest: 'd'.repeat(64) },
      { ...row, credentialId: 'b0000000-0000-4000-8000-00000000000b' },
      { ...row, request: { ...row.request, operationId: 'c0000000-0000-4000-8000-00000000000c' } },
    ])
      expect(dockerPlanSourceRecordCurrent(before, actual)).toBe(false);
  });
  it('rechecks revocation after an awaited physical source read before STOP', async () => {
    const f = await fixture();
    f.afterInit(() => f.keyLost());
    await expect(f.actor.stopSource(f.record, f.journal)).rejects.toThrow();
    expect(f.journal.read().sourceStop).toBeUndefined();
    expect(f.run.mock.calls.filter(([a]) => a[1] === 'stop')).toHaveLength(0);
  });
  it('requires the current scoped plan grant before the first STOP', async () => {
    const f = await fixture();
    await f.companyStore.update((company) => {
      company.employees[0]!.permissions.moveOwnPlan = false;
    });
    await expect(f.actor.stopSource(f.record, f.journal)).rejects.toThrow();
    expect(f.journal.read().sourceStop).toBeUndefined();
    expect(f.run.mock.calls.filter(([a]) => a[1] === 'stop')).toHaveLength(0);
  });
});

describe('canonical account selection until real refreshed-principal qualification', () => {
  it('reserves ordinary selected canonical credentials independently of source conversation history', async () => {
    const f = await fixture();
    expect(f.seed.target.accountSource).toEqual({ kind: 'canonical' });
    expect(f.saved.resumeSessionId).toBe('90000000-0000-4000-8000-000000000009');
  });
  it.each(['prepare', 'stopSource', 'start'] as const)(
    'holds retained refresh before STOP or target effects in %s',
    async (method) => {
      const f = await fixture(true, true);
      await expect(f.actor[method](f.record, f.journal)).rejects.toMatchObject({
        code: 'DOCKER_PLAN_ACCOUNT_PRINCIPAL_UNCONFIRMED',
        status: 409,
      });
      expect(f.journal.read().sourceStop).toBeUndefined();
      expect(f.run.mock.calls.some(([a]) => a[1] === 'stop' || a[1] === 'start' || a[1] === 'create')).toBe(false);
    }
  );
});

describe('actor authority across an actual account-selection await', () => {
  it.each(['grant revoked', 'employee removed', 'employee stopped'] as const)(
    'refuses target preparation when %s while the selected account lookup is pending',
    async (change) => {
      const f = await fixture(false);
      await f.actor.stopSource(f.record, f.journal);
      const before = f.journal.read();
      let entered = false,
        release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(f.plans.account).mockImplementationOnce(async (id) => {
        entered = true;
        await gate;
        return f.accounts.get(id);
      });
      f.run.mockClear();
      const pending = f.actor.start(f.record, f.journal).then(
        () => undefined,
        (error: unknown) => error
      );
      try {
        await expect.poll(() => entered, { timeout: 2000 }).toBe(true);
        await f.companyStore.update((company) => {
          if (change === 'employee removed') company.employees = [];
          else if (change === 'employee stopped') company.employees[0]!.desiredRunning = false;
          else company.employees[0]!.permissions.moveOwnPlan = false;
        });
        release();
        expect(await pending).toMatchObject({ status: 403 });
        expect(f.journal.read()).toEqual(before);
        expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
        expect(f.run).not.toHaveBeenCalled();
        expect(f.command.create).not.toHaveBeenCalled();
        expect(f.nativeCreate).not.toHaveBeenCalled();
        expect(f.sessions.size).toBe(0);
      } finally {
        release();
        await pending;
      }
    }
  );

  it('refuses changed canonical credential bytes after reservation before creating target work', async () => {
    const f = await fixture(false);
    await f.actor.stopSource(f.record, f.journal);
    const before = f.journal.read();
    fs.writeFileSync(
      join(f.accounts.get('b')!.configDir, '.credentials.json'),
      JSON.stringify({ synthetic: 'changed' })
    );
    f.run.mockClear();
    await expect(f.actor.start(f.record, f.journal)).rejects.toMatchObject({ status: 409 });
    await expect(f.freshActor().start(f.record, f.journal)).rejects.toThrow('material changed after reservation');
    expect(f.journal.read()).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
  });
});

describe('issued cursors remain data after actor reconstruction', () => {
  it('never dispatches an issued paid operation again when its canonical Company target is absent', async () => {
    const f = await fixture(false),
      before = await issuedCheckpoint(f, undefined, 'issued'),
      company = f.companyStore.snapshot();
    f.run.mockClear();
    for (const actor of [f.actor, f.freshActor()]) {
      await expect(actor.start(f.record, f.journal)).rejects.toThrow('paid dispatch is issued');
      // An issued publication cannot create or adopt a missing canonical target.
      await expect(actor.verify(f.record, f.journal)).rejects.toThrow('target binding or recipe changed');
    }
    expect(f.journal.read()).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(f.companyStore.snapshot()).toEqual(company);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
  });

  it('does not type an issued handoff again or erase its uncertainty without a native target view', async () => {
    const f = await fixture(false),
      before = await issuedCheckpoint(f, 'issued'),
      company = f.companyStore.snapshot();
    f.run.mockClear();
    for (const actor of [f.actor, f.freshActor()]) {
      await expect(actor.finalize(f.record, f.journal)).rejects.toThrow('will not be typed again');
      await expect(actor.verify(f.record, f.journal)).rejects.toThrow('target binding or recipe changed');
    }
    expect(f.journal.read()).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(f.companyStore.snapshot()).toEqual(company);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
  });

  it('treats submitted handoff finalization as a no-op while still requiring proof to verify the target', async () => {
    const f = await fixture(false),
      before = await issuedCheckpoint(f, 'submitted'),
      company = f.companyStore.snapshot();
    f.run.mockClear();
    for (const actor of [f.actor, f.freshActor()]) {
      await actor.finalize(f.record, f.journal);
      await expect(actor.verify(f.record, f.journal)).rejects.toThrow('target binding or recipe changed');
      await expect(actor.start(f.record, f.journal)).rejects.toThrow('paid dispatch is issued');
    }
    expect(f.journal.read()).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(f.companyStore.snapshot()).toEqual(company);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
  });
});

describe('original target recovery with engine-earned native views', () => {
  it('repairs only a retained publication ACK from the actual canonical target without relaunch or handoff', async () => {
    const f = await publishedTargetFixture('issued'),
      journal = await f.loadJournal(),
      before = journal.read(),
      company = f.companyStore.snapshot(),
      saved = f.store.getSession(f.record.newSession!);
    expect(f.native.target.pid).toBeNull();
    await expect(f.actor().verify(f.record, journal)).rejects.toBeInstanceOf(PlanMoveComposerNotReady);
    const repaired = journal.read();
    expect(repaired).toEqual({ ...before, companyPublication: { ...before.companyPublication!, phase: 'published' } });
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(repaired);
    expect(f.companyStore.snapshot()).toEqual(company);
    expect(f.store.getSession(f.record.newSession!)).toEqual(saved);
    expect(f.run.mock.calls.some(([args]) => args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))).toBe(true);
    expect(f.run.mock.calls.some(([args]) => args.includes('plan-status') && args.includes('live'))).toBe(true);
    const fresh = await f.loadJournal();
    await expect(f.actor().verify(f.record, fresh)).rejects.toBeInstanceOf(PlanMoveComposerNotReady);
    expect(fresh.read()).toEqual(repaired);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.replaceSession).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.native.command.create).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([args]) => args[0] === 'container' && ['start', 'stop'].includes(args[1]!))).toBe(
      false
    );
    expect(repaired.handoff).toBeUndefined();
  });

  it('reopens the original committed publication after its marker ACK is lost without replaying business work', async () => {
    const f = await publishedTargetFixture('issued'),
      journal = await f.loadJournal(),
      before = journal.read(),
      company = f.companyStore.snapshot();
    f.losePublicationAck();
    await expect(f.actor().verify(f.record, journal)).rejects.toThrow('ACK lost after durable commit');
    // The caller still has the old uncertain cursor. Only reopening the real
    // journal discovers the committed marker; no synthetic success is returned.
    expect(journal.read()).toEqual(before);
    const reopened = await f.loadJournal(),
      committed = reopened.read();
    expect(committed).toEqual({ ...before, companyPublication: { ...before.companyPublication!, phase: 'published' } });
    await expect(f.actor().verify(f.record, reopened)).rejects.toBeInstanceOf(PlanMoveComposerNotReady);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(committed);
    expect(f.companyStore.snapshot()).toEqual(company);
    expect(committed.handoff).toBeUndefined();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.replaceSession).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.native.command.create).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([args]) => args[0] === 'container' && ['start', 'stop'].includes(args[1]!))).toBe(
      false
    );
  });

  it.each(['issued', 'submitted'] as const)(
    'earns a fresh positive target fence from a %s handoff checkpoint without sending input',
    async (handoff) => {
      const f = await publishedTargetFixture('published', handoff),
        journal = await f.loadJournal(),
        before = journal.read(),
        company = f.companyStore.snapshot(),
        actor = f.actor(),
        fence = await actor.verify(f.record, journal);
      expect(() => fence()).not.toThrow();
      if (handoff === 'issued')
        await expect(actor.finalize(f.record, journal)).rejects.toThrow('will not be typed again');
      else await actor.finalize(f.record, journal);
      expect(journal.read()).toEqual(before);
      expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
      expect(f.companyStore.snapshot()).toEqual(company);
      expect(f.run.mock.calls.some(([args]) => args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))).toBe(true);
      expect(f.run.mock.calls.some(([args]) => args.includes('plan-status') && args.includes('live'))).toBe(true);
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.replaceSession).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.native.command.create).not.toHaveBeenCalled();
      expect(f.run.mock.calls.some(([args]) => args[0] === 'container' && ['start', 'stop'].includes(args[1]!))).toBe(
        false
      );
      f.sessions.set(
        f.native.target.id,
        new Session({ id: f.native.target.id, workingDir: '/synthetic', docker: f.native.target.docker })
      );
      expect(() => fence()).toThrow('target viewer changed');
    }
  );

  it('refuses changed live canonical authentication despite the retained successful installer ACK', async () => {
    const f = await publishedTargetFixture('published', 'submitted'),
      journal = await f.loadJournal(),
      before = journal.read();
    f.liveAuthDigest('c'.repeat(64));
    await expect(f.actor().verify(f.record, journal)).rejects.toMatchObject({
      code: 'DOCKER_PLAN_ACCOUNT_AUTH_CHANGED',
    });
    expect(journal.read()).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.native.command.create).not.toHaveBeenCalled();
  });

  it('rechecks a revoked recovery-only grant after awaiting native account status before repairing the ACK', async () => {
    const f = await publishedTargetFixture('issued'),
      journal = await f.loadJournal(),
      before = journal.read();
    let entered = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.accountStatus(async () => {
      entered = true;
      await gate;
    });
    const pending = f
      .actor()
      .verify(f.record, journal)
      .then(
        () => undefined,
        (error: unknown) => error
      );
    try {
      await expect.poll(() => entered, { timeout: 2000 }).toBe(true);
      await f.companyStore.update((company) => {
        company.employees[0]!.permissions.recoverEmployees = false;
      });
      release();
      expect(await pending).toMatchObject({ status: 403 });
      expect(journal.read()).toEqual(before);
      expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
      expect(f.run.mock.calls.some(([args]) => args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))).toBe(false);
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.native.command.create).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });
});

async function disjointFixture() {
  const f = await fixture(),
    store = new PlanMoveStore(join(f.directory, 'disjoint.json'));
  const old: PlanMoveRecord = {
    id: 'historical-legacy',
    employeeId: f.input.employeeId,
    name: 'Synthetic',
    oldSession: '10000000-0000-4000-8000-000000000011',
    newSession: '10000000-0000-4000-8000-000000000012',
    fromAccount: 'a',
    toAccount: 'b',
    phase: 'recovery-required',
    at: 1,
    error: 'Original remains unknown',
    sourceStopRequested: true,
    sourceCleanupVerified: true,
  };
  await store.save([old]);
  const actor = f.actor,
    unexpected = async () => {
      throw Error('legacy effect forbidden');
    };
  const port: PlanMovePort = {
    load: () => store.load(),
    save: (records) => store.save(records),
    dockerReplacement: {
      admitDisjointGeneration: actor.admitDisjointGeneration!.bind(actor),
      snapshot: actor.snapshot.bind(actor),
      reserve: actor.reserve.bind(actor),
      current: actor.current.bind(actor),
      idle: actor.idle.bind(actor),
      prepare: async () => {
        throw Error('admitted preparation boundary');
      },
      stopSource: actor.stopSource.bind(actor),
      start: actor.start.bind(actor),
      verify: actor.verify.bind(actor),
      finalize: actor.finalize.bind(actor),
      inspectForContinuation: actor.inspectForContinuation.bind(actor),
      requireContinuation: actor.requireContinuation.bind(actor),
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
    snapshot: actor.snapshot.bind(actor),
    idle: unexpected,
    create: unexpected,
    start: unexpected,
    ready: unexpected,
    beforeStop: unexpected,
    binding: () => f.input.sessionId,
    exists: () => true,
    rebind: unexpected,
    stop: unexpected,
    audit: async () => {},
  };
  return { f, store, old, port, moves: new PlanMoves({ ...port, dockerReplacement: f.baseActor }) };
}
describe('cold legacy disjoint native admission', () => {
  it('retains aggregate old hold after a recording new native completion and after pre-reservation refusal', async () => {
    const { f, old, store, port, moves } = await disjointFixture();
    await expect(moves.begin({ ...f.input, toAccount: 'a' }, undefined, port)).rejects.toThrow('already on that plan');
    expect((await moves.employeeRecoveryGuard(f.input.employeeId, undefined, 'effect'))()).toBe(false);
    const actor = port.dockerReplacement!;
    actor.prepare = async () => {};
    actor.stopSource = async (_record, journal) => {
      const before = journal.read(),
        maximum = dockerPlanMaximumStates(before.seed, before.epoch)[1]!;
      await journal.publish(before, { ...before, sourceStop: maximum.sourceStop });
    };
    actor.start = async (_record, journal) => {
      const before = journal.read(),
        maximum = dockerPlanMaximumStates(before.seed, before.epoch)[1]!;
      await journal.publish(before, {
        ...maximum,
        sourceStop: before.sourceStop,
        sourceReader: undefined,
        companyPublication: undefined,
        handoff: undefined,
      });
    };
    actor.verify = async (_record, journal) => () => journal.current();
    actor.finalize = async (_record, journal) => {
      let before = journal.read();
      await journal.publish(before, { ...before, companyPublication: { phase: 'issued', digest: 'a'.repeat(64) } });
      before = journal.read();
      await journal.publish(before, { ...before, companyPublication: { phase: 'published', digest: 'a'.repeat(64) } });
      before = journal.read();
      await journal.publish(before, {
        ...before,
        handoff: { phase: 'issued', digest: dockerPlanMoveHandoffDigest(before.seed.handoff) },
      });
      before = journal.read();
      await journal.publish(before, { ...before, handoff: { ...before.handoff!, phase: 'submitted' } });
    };
    await moves.begin(f.input, undefined, port);
    await vi.waitFor(async () => expect((await moves.get(f.input.id))?.phase).toBe('completed'), { timeout: 10000 });
    expect((await store.load()).find((row) => row.id === old.id)).toEqual(old);
    expect((await moves.employeeRecoveryGuard(f.input.employeeId, undefined, 'effect'))()).toBe(false);
    await expect(
      moves.assertAvailable(f.input.employeeId, undefined, { ...port, dockerReplacement: undefined })
    ).rejects.toThrow('inspect its existing move');
  });
  it('allows only one preparing flight and rejects revoked native admission', async () => {
    const { f, port, moves } = await disjointFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admit = port.dockerReplacement!.admitDisjointGeneration!;
    let first = true;
    port.dockerReplacement!.admitDisjointGeneration = async (...args) => {
      const proof = await admit(...args);
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return proof;
    };
    const pending = moves.begin(f.input, undefined, port);
    await seen;
    // A second actual reservation wins while the first read is paused. The
    // first must recheck the now-active original flight, never append twice.
    await moves.begin(f.input, undefined, port);
    release();
    await expect(pending).rejects.toThrow();
    f.keyLost();
    await expect(moves.assertAvailable(f.input.employeeId, undefined, port)).rejects.toThrow();
  });
  it('admits real Requests discovery and locked native reservation, preserving old history and aggregate hold', async () => {
    const { f, old, store, port, moves } = await disjointFixture();
    const requests = new PlanMoveRequests({
      load: async () => [],
      save: async () => {},
      moves,
      binding: () => f.input.sessionId,
      validateTarget: async () => ({ mode: 'claude' }),
      capability: { write: async () => '/owned-test-request', remove: async () => {} },
      notify: async () => {},
      audit: async () => {},
    });
    expect(
      (
        await requests.create(
          { id: 'disjoint-request', employeeId: f.input.employeeId, sessionId: f.input.sessionId, toAccount: 'b' },
          undefined,
          { executor: port, authorized: () => true }
        )
      ).phase
    ).toBe('pending');
    const move = await moves.begin(f.input, undefined, port);
    expect(move.backend).toBe('docker');
    expect((await store.load()).find((row) => row.id === old.id)).toEqual(old);
    expect((await store.load()).some((row) => row.id === move.id && row.dockerReplacement)).toBe(true);
    expect((await moves.employeeRecoveryGuard(f.input.employeeId, undefined, 'effect'))()).toBe(false);
    await expect(
      moves.assertAvailable(f.input.employeeId, undefined, { ...port, dockerReplacement: undefined })
    ).rejects.toThrow('inspect its existing move');
  });
  it('refuses forged proof, historical disk changes, and changed canonical native binding', async () => {
    const { f, old, store, port, moves } = await disjointFixture();
    const proof = await f.actor.admitDisjointGeneration!(f.input.employeeId, undefined, [old]);
    expect(() => requireDockerPlanDisjointGeneration({}, [old], f.input.employeeId, undefined)).toThrow();
    expect(() =>
      requireDockerPlanDisjointGeneration(
        Object.create(Object.getPrototypeOf(proof)),
        [old],
        f.input.employeeId,
        undefined
      )
    ).toThrow();
    const changed = { ...old, error: 'Historical observation changed' };
    await store.save([changed]);
    await expect(store.dockerReserve(f.record, () => {}, proof)).rejects.toThrow();
    expect(await store.load()).toEqual([changed]);
    await f.companyStore.update((state) => {
      state.employees[0]!.desiredRunning = false;
    });
    await expect(moves.assertAvailable(f.input.employeeId, undefined, port)).rejects.toThrow();
  });
  it.each(['same-source', 'same-target', 'not-closed', 'resource', 'native', 'other-owner'] as const)(
    'preserves default hold for %s',
    async (kind) => {
      const { f, old, store, port } = await disjointFixture(),
        row = { ...old };
      if (kind === 'same-source') row.oldSession = f.input.sessionId;
      if (kind === 'same-target') row.newSession = f.input.sessionId;
      if (kind === 'not-closed') row.sourceCleanupVerified = false;
      if (kind === 'other-owner') row.owner = 'foreign';
      if (kind === 'native') row.dockerReplacement = f.record.dockerReplacement;
      if (kind === 'resource')
        row.resourceIntent = {
          operationId: '20000000-0000-4000-8000-000000000001',
          reservationId: '20000000-0000-4000-8000-000000000002',
          profileVersion: '1',
          profileDigest: 'a'.repeat(64),
          previewDigest: 'b'.repeat(64),
        };
      const moves = new PlanMoves({ ...port, load: async () => [row] });
      await expect(moves.assertAvailable(f.input.employeeId, undefined, port)).rejects.toThrow();
      expect(await store.load()).toEqual([old]);
    }
  );
});
