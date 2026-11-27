import { planMoveExecutor, type PlanMoveRuntime } from '../src/plan-move-runtime.js';
import * as planProtocol from '../src/docker-plan-protocol.js';
import * as multiuser from '../src/config/multiuser.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { dockerPlanRetirementFixture } from './helpers/docker-plan-retirement-fixture.js';
import { dockerPlanSourceRecordCurrent } from '../src/docker-plan-move-actor.js';
/** Real captured HTTP/HMAC requester, canonical CompanyStore/PlanMoveStore and
 * private native SourceReader over controlled Docker replies. This is NOT an
 * actual Docker/provider or complete move acceptance claim. */
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { dockerPlanMoveTargetRecipe } from '../src/docker-plan-move-recipe.js';
import { DockerPlanMoveWork } from '../src/docker-plan-move-work.js';
import { DockerPlanSourceHolder } from '../src/docker-plan-source-holder.js';
import { dockerProviderRuntimeRecipeDigest } from '../src/docker-employee-source-correlation.js';
import { DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM } from '../src/docker-plan-account-status.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../src/docker-employee-provider-view-native.js';
import { StateStore } from '../src/state-store.js';
import { Session } from '../src/session.js';
import { PlanMoves, PlanMoveComposerNotReady } from '../src/plan-move.js';
import { composerIsEmpty } from '../src/session-submit-verifier.js';
import type { PlanMoveRecord, PlanMoveInput, PlanMoveExecutor, PlanMovePort } from '../src/plan-move.js';
import { PlanMoveRequests } from '../src/plan-request.js';
import {
  captureDockerPlanDisjointGeneration,
  requireDockerPlanDisjointGeneration,
} from '../src/docker-plan-disjoint-generation.js';
import { DockerPlanSourceProof, DockerPlanSourceReader, DOCKER_PLAN_INIT_PROGRAM } from '../src/docker-plan-source.js';
import { DOCKER_PLAN_SOURCE_READ_PROGRAM } from '../src/docker-plan-source-native.js';
import { dockerPlanMaximumStates } from '../src/docker-plan-move-capacity.js';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import type { PlanMoveDockerJournal } from '../src/plan-move-docker.js';
import type { SessionState } from '../src/types.js';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  running = true,
  retainedAccount = false,
  preparedPool = false,
  owner?: string,
  replacement?: { imageId: string; clientManifestDigest: string }
) {
  if (owner !== undefined) vi.spyOn(multiuser, 'isMultiUserMode').mockReturnValue(true);
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
    ...(owner === undefined ? {} : { owner }),
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
    ...(owner === undefined ? {} : { owner }),
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
    ...(owner === undefined ? {} : { owner }),
    original,
    policy,
    ...(preparedPool
      ? {
          pool: {
            containerId: '1'.repeat(64),
            cgroupParent: '/synthetic-pool',
            policyDigest: digest(policy.pool),
            physicalDigest: '2'.repeat(64),
          },
        }
      : {}),
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
          Id: replacement && args[2] === replacement.imageId ? replacement.imageId : f.raw.Image,
          RootFS: { Layers: ['sha256:synthetic'] },
          Config: {
            Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
            Cmd: null,
            Labels: {
              'org.reverie.worker-client.manifest':
                replacement && args[2] === replacement.imageId
                  ? replacement.clientManifestDigest
                  : f.row.workerImage.clientManifestDigest,
            },
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
      imageId: replacement?.imageId ?? f.raw.Image,
      clientManifestDigest: replacement?.clientManifestDigest ?? f.row.workerImage.clientManifestDigest,
      sourceImageIds: [f.raw.Image],
    },
    sourceStore,
    'sha256:' + 'f'.repeat(64),
    '7'.repeat(64)
  );
  // Engine receives the same controlled actual OS reply port as the packaged actor.
  vi.mocked(f.command.run).mockImplementation(run);
  const readReplacementHome = engine.planReplacementHome.bind(engine);
  const liveHome = vi.spyOn(engine, 'planReplacementHome').mockImplementation(async (row, current, placement) => {
    if (placement !== 'running') return readReplacementHome(row, current, placement);
    current();
    return { source: row.destination!.home.source, user: '1000:100', dev: '11', ino: '12' };
  });
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
  if (owner !== undefined)
    app.addHook('preHandler', async (request) => {
      request.authUser = { username: owner, role: 'admin' };
    });
  const ownerSessions =
    owner === undefined
      ? null
      : new Map([
          [
            'fixture-owner',
            {
              username: owner,
              ip: '127.0.0.1',
              ua: 'test',
              createdAt: 1,
              method: 'basic' as const,
            },
          ],
        ]);
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
      { authSessions: ownerSessions as never },
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
        headers:
          owner === undefined
            ? { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': saved.id }
            : { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=fixture-owner' },
      })
    ).statusCode
  ).toBe(200);
  const configuration: DockerPlanMoveComposition['configuration'] = {
    version: 1,
    purpose: 'reverie-boxed-runtime-v1',
    deployment: 'synthetic',
    workerImageId: replacement?.imageId ?? f.raw.Image,
    clientManifestDigest: replacement?.clientManifestDigest ?? f.row.workerImage.clientManifestDigest,
    sourceImageIds: [f.raw.Image],
    helperImageId: 'sha256:' + 'f'.repeat(64),
    apiUrl: 'http://reverie:3000',
  };
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
      configuration,
      boxId: '7'.repeat(64),
      authentication: auth,
      revisions,
      current,
      retain,
    });
  const actor = baseActor.withRequesterAuthority(proof);
  const selectedSeed = await actor.reserve(input, owner, 'd'.repeat(64)),
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
    ...(owner === undefined ? {} : { owner }),
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
    engine,
    liveHome,
    company,
    ctx,
    provider,
    current,
    configuration,
    resources,
    actorWithConfiguration: (selected: DockerPlanMoveComposition['configuration'], selectedEngine = engine,
      requireReconciledSourcePool?: DockerPlanMoveComposition['requireReconciledSourcePool']) =>
      new DockerPlanMoveActor({
        company,
        ctx,
        plans,
        moves,
        chat: {} as DockerPlanMoveComposition['chat'],
        store: sourceStore,
        engine: selectedEngine,
        requireReconciledSourcePool,
        provider,
        configuration: selected,
        boxId: '7'.repeat(64),
        authentication: auth,
        revisions,
        current,
        retain,
      }).withRequesterAuthority(proof),
    retain,
    sessions,
    plans,
    accounts,
    moves,
    freshActor: () => baseActor.withRequesterAuthority(proof),
    requester: proof,
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
  publication: 'issued' | 'published' = 'published',
  prepaid = false,
  amend?: (
    work: NonNullable<DockerPlanMoveJournalState['work']>,
    material: NonNullable<DockerPlanMoveJournalState['material']>
  ) => void
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
    work: NonNullable<DockerPlanMoveJournalState['work']> = {
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
      original: seed.source.record.destination!,
      workerImage: seed.target.workerImage,
      policy: seed.source.record.policy,
      credentialId: seed.target.credentialId,
      phase: prepaid ? 'identity-ready' : 'ready',
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
          phase: 'completed' as const,
          resultDigest: '8'.repeat(64),
        })),
      ],
      planReplacement: {
        ...prior.work.planReplacement,
        ...(seed.target.runtimeNamespace ? { runtimeNamespace: seed.target.runtimeNamespace } : {}),
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
  amend?.(work, material);
  let checkpoint = before;
  if (prepaid && !before.sourceReader) {
    const reader = {
      version: 1 as const,
      purpose: 'docker-plan-source-reader-v1' as const,
      name: 'reverie-boxed-reader-synthetic',
      imageId: seed.target.workerImage.imageId,
      configurationDigest: '8'.repeat(64),
      containerId: '9'.repeat(64),
    };
    await f.journal.publish(checkpoint, { ...checkpoint, sourceReader: { ...reader, phase: 'create-issued' } });
    checkpoint = f.journal.read();
    await f.journal.publish(checkpoint, {
      ...checkpoint,
      sourceReader: {
        ...reader,
        phase: 'closed',
        terminalStateDigest: '8'.repeat(64),
      },
    });
    checkpoint = f.journal.read();
  }
  await f.journal.publish(
    checkpoint,
    DockerPlanMoveJournalState.parse({
      ...checkpoint,
      material,
      work,
      ...(!prepaid
        ? {
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
          }
        : {}),
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
async function publishedTargetFixture(
  publication: 'issued' | 'published',
  handoff?: 'issued' | 'submitted',
  recoverPublishedPlanView?: DockerPlanMoveComposition['recoverPublishedPlanView']
) {
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
      recoverPublishedPlanView,
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
  it('rejects unconfirmed cold storage before reserving a same-plan worker recovery', async () => {
    const f = await fixture(false);
    f.liveHome.mockRejectedValueOnce(Error('Unconfirmed original storage'));
    const before = await f.moves.dockerRecord(f.record.id);
    const input = { ...f.input, fromAccount: f.input.toAccount };
    await expect(f.freshActor().reserve(input, undefined, 'd'.repeat(64))).rejects.toThrow('Unconfirmed original storage');
    expect(await f.moves.dockerRecord(f.record.id)).toEqual(before);
    expect(f.nativeCreate).not.toHaveBeenCalled();
  });
  it.each([true, false])('qualifies the target before fresh final source facts (running=%s)', async (running) => {
    const f = await fixture(running);
    let clock = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const targetImage = f.engine.replacementTargetImage.bind(f.engine);
    vi.spyOn(f.engine, 'replacementTargetImage').mockImplementation(async (source, current) => {
      const image = await targetImage(source, current);
      clock += 6000; // Controlled slow immutable setup, not a real latency claim.
      current();
      return image;
    });
    const before = await f.moves.dockerRecord(f.record.id);
    const seed = await f.freshActor().reserve(f.input, undefined, 'd'.repeat(64));
    expect(seed.source.observation.kind).toBe(running ? 'running' : 'stopped');
    expect(seed.target.workerImage).toEqual(f.seed.target.workerImage);
    expect(await f.moves.dockerRecord(f.record.id)).toEqual(before);
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([a]) => a[0] === 'container' && ['start', 'stop'].includes(a[1]!))).toBe(false);
  });

  it.each(['target-image', 'runtime-current', 'recipe', 'binding', 'source-epoch'] as const)(
    'retains target/source admission guards after reordered setup: %s',
    async (change) => {
      const f = await fixture();
      let clock = performance.now();
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const targetImage = f.engine.replacementTargetImage.bind(f.engine);
      if (change === 'target-image') {
        const run = f.run.getMockImplementation()!;
        f.run.mockImplementation(async (args, input) => {
          const text = await run(args, input);
          if (args[0] !== 'image') return text;
          const images = JSON.parse(text);
          images[0].Config.Labels['org.reverie.worker-client.manifest'] = '0'.repeat(64);
          return JSON.stringify(images);
        });
      }
      vi.spyOn(f.engine, 'replacementTargetImage').mockImplementation(async (source, current) => {
        const image = await targetImage(source, current);
        clock += 6000;
        if (change === 'runtime-current') f.keyLost();
        if (change === 'recipe' || change === 'binding')
          await f.companyStore.update((company) => {
            const employee = company.employees[0]!;
            if (change === 'recipe') employee.runtimeRecipe!.workingDir = '/changed';
            else employee.sessionGeneration++;
          });
        if (change === 'source-epoch') f.afterInit(() => f.ticks('999'));
        current();
        return image;
      });
      const before = await f.moves.dockerRecord(f.record.id);
      await expect(f.freshActor().reserve(f.input, undefined, 'd'.repeat(64))).rejects.toThrow();
      expect(await f.moves.dockerRecord(f.record.id)).toEqual(before);
      expect(f.nativeCreate).not.toHaveBeenCalled();
      expect(f.run.mock.calls.some(([a]) => a[0] === 'container' && ['start', 'stop'].includes(a[1]!))).toBe(false);
    }
  );

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
    expect(f.seed.target.runtimeNamespace).toBe('session-v1');
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
  it('keeps the source running when its retained storage cannot be verified', async () => {
    const f = await fixture();
    f.liveHome.mockRestore();
    await expect(f.actor.stopSource(f.record, f.journal)).rejects.toMatchObject({
      code: 'DOCKER_STORAGE_PRIVATE_BIND_REQUIRED',
    });
    expect(f.journal.read().sourceStop).toBeUndefined();
    expect(f.raw.State.Running).toBe(true);
    expect(f.run.mock.calls.some(([a]) => a[1] === 'stop')).toBe(false);
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

describe('fresh source selection within its native proof lifetime', () => {
  it('retains the five-second native admission under bounded canonical correlation work', async () => {
    const f = await fixture();
    const started = performance.now();
    let clock = started;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const existingSubject = f.sourceStore.existingSubject.bind(f.sourceStore);
    vi.spyOn(f.sourceStore, 'existingSubject').mockImplementation((employeeId, row) => {
      // Charge actual correlation work a controlled cost, independent of CPU
      // load. The real Store, private requester, SourceReader and TTL remain.
      const subject = existingSubject(employeeId, row);
      clock += 100;
      return subject;
    });
    f.run.mockClear();
    const snapshot = await f.actor.snapshot(f.record.employeeId, f.record.owner);
    expect(snapshot).toMatchObject({ backend: 'docker', sessionId: f.saved.id, sessionGeneration: 1 });
    expect(clock - started).toBeLessThan(5000);
    expect(f.run).toHaveBeenCalled();
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(
      f.run.mock.calls.some(([args]) => args[0] === 'container' && ['start', 'stop', 'rename'].includes(args[1]!))
    ).toBe(false);
  });

  it.each(['grant', 'binding', 'row', 'live-recipe'] as const)(
    'rechecks %s after the original account read without native effects',
    async (change) => {
      const f = await fixture();
      vi.mocked(f.plans.accountForSavedState).mockImplementationOnce(async () => {
        if (change === 'live-recipe') {
          f.sessions.set(f.saved.id, new Session({ ...f.saved, workingDir: '/changed-recipe', useMux: false }));
        } else {
          await f.companyStore.update((state) => {
            if (change === 'grant') state.employees[0]!.permissions.moveOwnPlan = false;
            else if (change === 'binding') state.employees[0]!.sessionGeneration++;
            else {
              const row = state.dockerEmployeeContinuations![0]!;
              if (row.version === 1) throw Error('Versioned provider correlation required');
              row.providerSourceDigest = 'e'.repeat(64);
            }
          });
        }
        return f.accounts.get('a');
      });
      f.run.mockClear();
      await expect(f.actor.snapshot(f.record.employeeId, f.record.owner)).rejects.toThrow();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.nativeCreate).not.toHaveBeenCalled();
    }
  );
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

  it('adopts the already published target through the live reattachment proof after the original holder disappears', async () => {
    const recover = vi.fn<NonNullable<DockerPlanMoveComposition['recoverPublishedPlanView']>>();
    const f = await publishedTargetFixture('published', 'submitted', recover),
      journal = await f.loadJournal(),
      before = journal.read(),
      ordinary = f.native.engine.captureProviderView.bind(f.native.engine);
    vi.spyOn(f.native.engine, 'captureProviderView').mockRejectedValue(Error('Missing original holder'));
    vi.spyOn(f.native.engine, 'verifyPlanReplacementCanonicalAccount').mockRejectedValue(Error('Missing original holder'));
    recover.mockImplementation((row, digest, current) => {
      expect(digest).toBe(before.material!.authDigest);
      expect(row).toEqual(before.work);
      current();
      return ordinary(row, current);
    });
    const actor = f.actor(), fence = await actor.verify(f.record, journal);
    expect(() => fence()).not.toThrow();
    await actor.finalize(f.record, journal);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(journal.read()).toEqual(before);
    expect(f.launch).not.toHaveBeenCalled();
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
// Real Store/Company/native-port joins need a bounded instrumentation budget;
// this changes no production proof lifetime or operation deadline.
describe('cold legacy disjoint native admission', { timeout: 60_000 }, () => {
  let sourceObservationTime: number;
  beforeEach(() => {
    // These native replies are controlled snapshots: coverage CPU time must not
    // age them. Explicitly advance this clock to test the real freshness guard.
    sourceObservationTime = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => sourceObservationTime);
  });
  it('expires an actual disjoint native proof after five seconds and never revives it', async () => {
    const { f, old, store } = await disjointFixture();
    const proof = await f.actor.admitDisjointGeneration!(f.input.employeeId, undefined, [old]);
    const requireCurrent = () => requireDockerPlanDisjointGeneration(proof, [old], f.input.employeeId, undefined);
    expect(requireCurrent).not.toThrow();
    sourceObservationTime += 5000;
    expect(requireCurrent).not.toThrow();
    sourceObservationTime++;
    expect(requireCurrent).toThrow('DOCKER_PLAN_SOURCE_UNCONFIRMED');
    sourceObservationTime = 1000;
    expect(requireCurrent).toThrow('DOCKER_PLAN_SOURCE_UNCONFIRMED');
    expect(await store.load()).toEqual([old]);
    expect(f.nativeCreate).not.toHaveBeenCalled();
  });
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
    const noOp = vi.fn();
    const shadowed = Object.create(Object.getPrototypeOf(proof), {
      require: { value: noOp },
      requireReservation: { value: noOp },
    });
    expect(() => requireDockerPlanDisjointGeneration(shadowed, [old], f.input.employeeId, undefined)).toThrow();
    await expect(store.dockerReserve(f.record, () => {}, shadowed)).rejects.toThrow();
    const fakeNative = Object.create(DockerPlanSourceProof.prototype, { require: { value: noOp } });
    const state = f.companyStore.snapshot(),
      row = state.dockerEmployeeContinuations![0]!,
      binding = state.employees[0]!.dockerBinding!;
    expect(() => captureDockerPlanDisjointGeneration(f.requester, fakeNative, row, binding, [old], () => {})).toThrow();
    expect(noOp).not.toHaveBeenCalled();
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

/** Routing tests retain genuine requester/store/journal admission. Native protocol
 * read itself is separately exercised through the actual Engine below. */
describe('prepaid installed original across website pair changes', () => {
  it.each([
    'unchanged',
    'local-digest',
    'default-label',
    'default-image',
    'saved-label',
    'saved-image',
    'saved-source',
    'unsupported-source',
    'unregistered-target',
    'revoked',
    'source-row',
  ] as const)('qualifies an actual cold unissued seed independently of the current website pair: %s', async (mode) => {
    const f = await fixture(true, false, true, undefined, {
      imageId: 'sha256:' + '4'.repeat(64),
      clientManifestDigest: '5'.repeat(64),
    });
    const before = await f.moves.dockerRecord(f.record.id);
    await f.moves.save([{ ...before, phase: 'recovery-required', error: 'original pre-effect refusal' }]);
    const reopened = new PlanMoveStore(join(f.directory, 'moves.json'));
    const original = await reopened.dockerRecord(f.record.id),
      state = original.dockerReplacement!;
    expect(state.sourceStop).toBeUndefined();
    expect(state.sourceReader).toBeUndefined();
    expect(state.work).toBeUndefined();
    expect(state.paidDispatch).toBeUndefined();
    expect(state.seed.target.workerImage.imageId).not.toBe(state.seed.source.binding.imageId);
    const currentPair = {
      imageId: 'sha256:' + '2'.repeat(64),
      sourceImageId: state.seed.target.workerImage.sourceImageId,
      clientManifestDigest: '3'.repeat(64),
    };
    const run = f.run.getMockImplementation()!;
    let savedReads = 0,
      sourceReads = 0;
    f.run.mockImplementation(async (args, input) => {
      if (args[0] !== 'image') return run(args, input);
      const images =
        args[2] === currentPair.imageId
          ? [
              {
                Id: currentPair.imageId,
                RootFS: { Layers: ['sha256:synthetic'] },
                Config: {
                  Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
                  Cmd: null,
                  Labels: { 'org.reverie.worker-client.manifest': currentPair.clientManifestDigest },
                },
              },
            ]
          : JSON.parse(await run(args, input));
      if (args[2] === currentPair.imageId) {
        if (mode === 'default-label') images[0].Config.Labels['org.reverie.worker-client.manifest'] = '0'.repeat(64);
        if (mode === 'default-image') images[0].Id = 'sha256:' + '0'.repeat(64);
      } else if (args[2] === state.seed.target.workerImage.imageId) {
        savedReads++;
        if (mode === 'saved-label') images[0].Config.Labels['org.reverie.worker-client.manifest'] = '0'.repeat(64);
        if (mode === 'saved-image') images[0].Id = 'sha256:' + '0'.repeat(64);
        if (savedReads === 1) {
          if (mode === 'revoked') f.keyLost();
          if (mode === 'source-row')
            await f.companyStore.update((s) => {
              s.employees[0]!.sessionGeneration++;
            });
        }
      } else if (args[2] === state.seed.source.binding.imageId) {
        sourceReads++;
        if (mode === 'saved-source' && sourceReads === 2) images[0].Id = 'sha256:' + '0'.repeat(64);
      }
      return JSON.stringify(images);
    });
    const sourceImageIds =
      mode === 'unsupported-source'
        ? []
        : mode === 'unregistered-target'
          ? [state.seed.source.binding.imageId]
          : [state.seed.source.binding.imageId, state.seed.target.workerImage.imageId];
    const currentEngine = new DockerEmployeeEngine(
      f.command,
      'synthetic',
      f.resources,
      {
        imageId: currentPair.imageId,
        clientManifestDigest: currentPair.clientManifestDigest,
        sourceImageIds,
      },
      f.sourceStore,
      f.configuration.helperImageId,
      '7'.repeat(64)
    );
    cleanup.push(() => currentEngine.close());
    const actor = f.actorWithConfiguration(
      {
        ...f.configuration,
        workerImageId: currentPair.imageId,
        clientManifestDigest: currentPair.clientManifestDigest,
        sourceImageIds,
      },
      currentEngine
    );
    const local = vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((digest, current) => {
      current();
      expect(digest).toBe(currentPair.clientManifestDigest);
      if (mode === 'local-digest') throw Error('installed current capsule mismatch');
    });
    vi.spyOn(currentEngine, 'observePool').mockResolvedValue(state.seed.source.record.pool!);
    const native = vi.spyOn(DockerEmployeeEngine.prototype, 'inspectPlanReplacementProtocol');
    const journal: PlanMoveDockerJournal = {
      ...f.journal,
      read: () => structuredClone(state),
      current: () => {
        reopened.dockerCurrent(original.id, state.epoch, digest(state.seed));
        requireDockerPlanMoveRequesterCurrent(f.requester, original, state);
      },
      publish: async () => {
        throw Error('Unissued compatibility must not publish');
      },
    };
    if (mode === 'unchanged') {
      await actor.prepare(original, journal);
      expect(savedReads).toBe(1);
      await expect(
        currentEngine.qualifyPlanReplacementImage(
          state.seed.source.record.destination!,
          { ...state.seed.target.workerImage, sourceImageId: 'sha256:' + '0'.repeat(64) },
          journal.current
        )
      ).rejects.toThrow('SOURCE_IMAGE_UNSUPPORTED');
    } else
      await expect(actor.prepare(original, journal)).rejects.toThrow(
        mode === 'local-digest'
          ? 'installed current capsule mismatch'
          : mode === 'unsupported-source' || mode === 'unregistered-target'
            ? 'DOCKER_CONTINUATION_SOURCE_IMAGE_UNSUPPORTED'
            : mode === 'revoked' || mode === 'source-row'
              ? 'The Docker plan requester or permission changed'
              : 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED'
      );
    expect(local).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
    expect(await reopened.dockerRecord(original.id)).toEqual(original);
    expect(state.seed.target.workerImage).toEqual(f.seed.target.workerImage);
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([a]) => a[0] === 'container' && ['start', 'stop'].includes(a[1]!))).toBe(false);
  });

  it.each(['missing', 'new-epoch', 'foreign', 'unconfirmed'] as const)(
    'revalidates the original pool before continuing a plan move (%s)', async (mode) => {
      const f = await fixture(true, false, true);
      const row = f.journal.read().seed.source.record;
      const pool = row.pool!;
      vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((_digest, current) => current());
      vi.spyOn(f.engine, 'observePool').mockResolvedValue(
        mode === 'missing' ? null : { ...pool, physicalDigest: 'e'.repeat(64),
          containerId: mode === 'foreign' ? 'd'.repeat(64) : pool.containerId });
      const verify = vi.fn(async (candidate: DockerEmployeeContinuationRecord, current: () => void) => {
        current();
        expect(candidate).toEqual(row);
        if (mode === 'unconfirmed') throw Error('current pool has no verified receipt');
      });
      const actor = f.actorWithConfiguration(f.configuration, f.engine, verify);
      const target = vi.spyOn(f.engine, 'replacementTargetImage').mockRejectedValue(Error('target preparation reached'));
      await expect(actor.prepare(f.record, f.journal)).rejects.toThrow(
        mode === 'foreign' ? 'original shared pool' : mode === 'unconfirmed' ? 'no verified receipt' : 'target preparation reached');
      expect(verify).toHaveBeenCalledTimes(mode === 'foreign' ? 0 : 1);
      expect(target).toHaveBeenCalledTimes(mode === 'missing' || mode === 'new-epoch' ? 1 : 0);
      expect(f.nativeCreate).not.toHaveBeenCalled();
    }
  );
  it('validates current local/default pair and reads the immutable old target without changing any cursor', async () => {
    const f = await fixture(true, false, true);
    await issuedCheckpoint(f, undefined, 'published', true);
    const original = f.journal.read();
    const currentPair = {
      imageId: 'sha256:' + '2'.repeat(64),
      sourceImageId: original.seed.target.workerImage.sourceImageId,
      clientManifestDigest: '3'.repeat(64),
    };
    const actor = f.actorWithConfiguration({
      ...f.configuration,
      workerImageId: currentPair.imageId,
      clientManifestDigest: currentPair.clientManifestDigest,
    });
    const local = vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((digest, current) => {
      current();
      expect(digest).toBe(currentPair.clientManifestDigest);
    });
    vi.spyOn(f.engine, 'observePool').mockResolvedValue(original.seed.source.record.pool!);
    vi.spyOn(f.engine, 'replacementTargetImage').mockResolvedValue(currentPair);
    const native = vi
      .spyOn(DockerEmployeeEngine.prototype, 'inspectPlanReplacementProtocol')
      .mockImplementation(async (row, current) => {
        current();
        expect(row).toEqual(original.work);
        expect(row.workerImage).toEqual(original.seed.target.workerImage);
      });
    await actor.prepare(f.record, f.journal);
    expect(local).toHaveBeenCalledOnce();
    expect(native).toHaveBeenCalledOnce();
    expect(f.journal.read()).toEqual(original);
    expect(f.nativeCreate).not.toHaveBeenCalled();
  });
  it.each(['default-image', 'default-digest', 'default-source', 'local-protocol', 'original-protocol', 'revoked'])(
    'refuses %s while retaining the exact original',
    async (mode) => {
      const f = await fixture(true, false, true);
      await issuedCheckpoint(f, undefined, 'published', true);
      const original = f.journal.read();
      const pair = {
        imageId: 'sha256:' + '2'.repeat(64),
        sourceImageId: original.seed.target.workerImage.sourceImageId,
        clientManifestDigest: '3'.repeat(64),
      };
      const actor = f.actorWithConfiguration({
        ...f.configuration,
        workerImageId: pair.imageId,
        clientManifestDigest: pair.clientManifestDigest,
      });
      vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((digest, current) => {
        current();
        expect(digest).toBe(pair.clientManifestDigest);
        if (mode === 'local-protocol') throw Error('local protocol unavailable');
      });
      vi.spyOn(f.engine, 'observePool').mockResolvedValue(original.seed.source.record.pool!);
      vi.spyOn(f.engine, 'replacementTargetImage').mockResolvedValue({
        ...pair,
        ...(mode === 'default-image' ? { imageId: 'sha256:' + '4'.repeat(64) } : {}),
        ...(mode === 'default-digest' ? { clientManifestDigest: '4'.repeat(64) } : {}),
        ...(mode === 'default-source' ? { sourceImageId: 'sha256:' + '4'.repeat(64) } : {}),
      });
      const native = vi
        .spyOn(DockerEmployeeEngine.prototype, 'inspectPlanReplacementProtocol')
        .mockImplementation(async (_row, current) => {
          current();
          if (mode === 'revoked') f.keyLost();
          else throw Error('original protocol unavailable');
        });
      await expect(actor.prepare(f.record, f.journal)).rejects.toThrow();
      if (mode.startsWith('default-') || mode === 'local-protocol') expect(native).not.toHaveBeenCalled();
      else expect(native).toHaveBeenCalledOnce();
      expect(f.journal.read()).toEqual(original);
      expect(f.nativeCreate).not.toHaveBeenCalled();
    }
  );
  it.each(['paid', 'reader-open', 'before-identity', 'closed-source-without-target'] as const)(
    'keeps strict old-pair admission for %s',
    async (mode) => {
      const f = await fixture(true, false, true);
      if (mode === 'paid') await issuedCheckpoint(f);
      else if (mode === 'closed-source-without-target') await f.actor.stopSource(f.record, f.journal);
      else await issuedCheckpoint(f, undefined, 'published', true);
      const state = f.journal.read();
      // A denial-only journal projection cannot manufacture a native capability.
      const changed = {
        ...state,
        ...(mode === 'reader-open'
          ? {
              sourceReader: {
                version: 1,
                purpose: 'docker-plan-source-reader-v1',
                name: state.sourceReader!.name,
                imageId: state.sourceReader!.imageId,
                configurationDigest: state.sourceReader!.configurationDigest,
                containerId: state.sourceReader!.containerId,
                phase: 'close-issued' as const,
                init: { pid: 42, startTicks: '1234' },
              },
            }
          : {}),
        ...(mode === 'before-identity' ? { work: { ...state.work!, phase: 'identity-issued' as const } } : {}),
      };
      const read = { ...f.journal, read: () => DockerPlanMoveJournalState.parse(changed) };
      const actor = f.actorWithConfiguration({ ...f.configuration, clientManifestDigest: '3'.repeat(64) });
      const local = vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((digest) => {
        expect(digest).toBe(state.seed.target.workerImage.clientManifestDigest);
        throw Error('strict old pair refused');
      });
      const native = vi.spyOn(DockerEmployeeEngine.prototype, 'inspectPlanReplacementProtocol');
      await expect(actor.prepare(f.record, read)).rejects.toThrow('strict old pair refused');
      expect(local).toHaveBeenCalledOnce();
      expect(native).not.toHaveBeenCalled();
    }
  );
});

/** Actual public owner route + installed request-scoped adapter + runner +
 * protected stores + genuine original requester. Native I/O is controlled;
 * the deliberately refused next boundary grants no effect/paid completion. */
describe('fresh owner original-recovery composition', () => {
  it.each([
    ['ownerless', undefined, undefined],
    ['named owner', 'synthetic-owner', undefined],
    ['changed owner', 'synthetic-owner', 'owner'],
    ['changed material', undefined, 'material'],
  ] as const)('retains exact work through a cold disk reload: %s', async (_label, owner, change) => {
    const f = await fixture(true, false, true, owner);
    const seed = f.seed;
    const context = {
      source: { kind: 'intake' as const, dev: '11', ino: '12' },
      roles: ['claude-projects' as const],
      conversation: {
        nativeId: f.saved.resumeSessionId!,
        relative: ['projects', f.saved.resumeSessionId! + '.jsonl'],
        sha256: 'a'.repeat(64),
      },
    };
    const material = { ...dockerPlanJournalFixture().material, context };
    const selected = dockerPlanMaterial(
      {
        operationId: seed.target.operationId,
        sessionId: seed.target.sessionId,
        provider: seed.target.provider,
        accountId: seed.target.accountId,
        context,
      },
      material.authDigest
    );
    const target = dockerPlanMoveTargetRecipe(
      f.saved,
      f.accounts.get('b')!,
      f.input,
      { sessionId: seed.target.sessionId, owner, at: f.record.at },
      { claudeMode: 'normal', allowedTools: 'Read' },
      { kind: 'resolved', nativeId: context.conversation.nativeId }
    );
    expect(target.templateDigest).toBe(seed.target.templateDigest);
    const employee = f.companyStore.snapshot().employees[0]!;
    const targetEmployee = {
      ...employee,
      sessionId: seed.target.sessionId,
      sessionGeneration: seed.target.sessionGeneration,
      runtimeRecipe: target.recipe,
    };
    const policy = f.sourceStore.newOperationPolicy(employee.id);
    const home = { source: seed.source.record.destination!.home.source, user: '1000:100', dev: '11', ino: '12' };
    vi.spyOn(f.engine, 'planReplacementHome').mockImplementation(async (_r, current) => {
      current();
      return home;
    });
    // Earn the actual closed SourceHolder cursor over a fixed synthetic Engine
    // port. Frozen native guards stay intact, including configuration and birth.
    let helper: (Record<string, unknown> & { State: Record<string, unknown> }) | undefined;
    const helperId = '9'.repeat(64),
      baseRun = f.run.getMockImplementation()!;
    f.nativeCreate.mockImplementation(async (_name, config, current) => {
      current();
      const { Image, HostConfig, ...rest } = structuredClone(config);
      const host = HostConfig as {
        Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly?: boolean }>;
      };
      helper = {
        Id: helperId,
        Image,
        Config: { ...rest, Volumes: null },
        HostConfig: { ...host, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } },
        Mounts: host.Mounts.map((m) => ({
          Type: m.Type,
          Source: m.Source,
          Destination: m.Target,
          RW: !m.ReadOnly,
        })),
        State: {
          Running: false,
          Status: 'created',
          Pid: 0,
          Paused: false,
          Restarting: false,
          Dead: false,
          ExitCode: 0,
        },
      };
      return helperId;
    });
    f.run.mockImplementation(async (args, input) => {
      if (args[0] === 'image') {
        const images = JSON.parse(await baseRun(args, input));
        images[0].Config.Env = ['PATH=/bin'];
        images[0].Config.Volumes = null;
        return JSON.stringify(images);
      }
      if (args[0] === 'container' && args[1] === 'ls') return helper ? helperId : '';
      if (args[0] === 'container' && args.includes(helperId) && helper) {
        if (args[1] === 'inspect') return JSON.stringify([helper]);
        if (args[1] === 'start' || args[1] === 'stop') {
          helper.State = {
            Running: args[1] === 'start',
            Status: args[1] === 'start' ? 'running' : 'exited',
            Pid: args[1] === 'start' ? 500 : 0,
            Paused: false,
            Restarting: false,
            Dead: false,
            ExitCode: args[1] === 'start' ? 0 : 143,
          };
          return helperId;
        }
      }
      if (args.includes(helperId) && args.includes(DOCKER_PLAN_INIT_PROGRAM))
        return JSON.stringify({ startTicks: '5000' });
      if (args.includes(DOCKER_PLAN_SOURCE_READ_PROGRAM))
        return JSON.stringify({
          version: 1,
          purpose: 'reverie-plan-source-home-v1',
          homeDev: home.dev,
          homeIno: home.ino,
          uid: 1000,
          gid: 100,
        });
      return baseRun(args, input);
    });
    await f.actor.stopSource(f.record, f.journal);
    const holderCommand = new PackagedDockerEngineCommand();
    const holder = new DockerPlanSourceHolder(
      holderCommand,
      '7'.repeat(64),
      new DockerPlanSourceReader(
        holderCommand,
        'synthetic',
        '7'.repeat(64),
        'http://reverie:3000',
        (row, current) => f.engine.captureProviderView(row, current),
        async (row, current) => {
          await f.engine.existingImage(row, current);
        }
      ),
      async (_row, current) => {
        current();
        return home;
      }
    );
    await holder.open(f.record, f.journal);
    await holder.close(f.record, f.journal);
    expect(f.journal.read().sourceReader?.phase).toBe('closed');
    f.nativeCreate.mockClear();
    const sourceDigest = dockerEmployeeSourceDigest(targetEmployee, target.saved);
    await issuedCheckpoint(f, undefined, 'published', true, (work, retainedMaterial) => {
      Object.assign(retainedMaterial, material);
      Object.assign(work, {
        policy,
        request: { ...work.request, expectedPolicyDigest: digest(policy), enterOffice: false },
        sourceDigest,
        providerSourceDigest: dockerEmployeeProviderSourceDigest(targetEmployee, target.saved),
        planReplacement: {
          ...work.planReplacement,
          source: { ...work.planReplacement.source, networkIds: ['5'.repeat(64)] },
          account: {
            id: 'b',
            provider: 'anthropic' as const,
            projectionDigest: selected.projectionDigest,
            contextDigest: selected.contextInputDigest,
          },
        },
      });
      if (change === 'material') work.sourceDigest = '0'.repeat(64);
    });
    const checkpoint = f.journal.read(),
      work = checkpoint.work!;
    const original = { ...f.record, phase: 'recovery-required' as const, dockerReplacement: checkpoint };
    await f.moves.save([original]);
    // The original must really cross JSON persistence, not stay in the actor's
    // in-memory reservation. This is the ownerless production failure boundary.
    const reopened = new PlanMoveStore(join(f.directory, 'moves.json'));
    const disk = await reopened.dockerRecord(original.id);
    expect(Object.hasOwn(disk.dockerReplacement!.work!, 'owner')).toBe(owner !== undefined);
    if (change === 'owner')
      await f.companyStore.update((s) => {
        s.employees[0]!.owner = 'different-owner';
      });
    const credentials = new Map([
      [
        'owner',
        {
          ip: '127.0.0.1',
          ua: 'test',
          createdAt: 1,
          method: 'basic' as const,
          ...(owner === undefined ? {} : { username: owner }),
        },
      ],
    ]);
    // Controlled native phase/receipt ports deliberately do not establish
    // Docker/provider acceptance. Real requester/current, runner, strict work
    // comparison and durable paid-intent CAS remain the subject of this test.
    vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((_d, current) => current());
    vi.spyOn(DockerEmployeeEngine.prototype, 'inspectPlanReplacementProtocol').mockImplementation(async (_r, current) =>
      current()
    );
    vi.spyOn(f.engine, 'observePool').mockResolvedValue(seed.source.record.pool!);
    vi.spyOn(f.engine, 'planReplacementNetworkIds').mockImplementation(async (_r, current) => {
      current();
      return ['5'.repeat(64)];
    });
    vi.spyOn(DockerPlanMoveWork.prototype, 'inspect').mockImplementation(async function (this: DockerPlanMoveWork) {
      this.row();
    });
    vi.spyOn(DockerPlanMoveWork.prototype, 'prepareNative').mockImplementation(async function (
      this: DockerPlanMoveWork
    ) {
      this.row();
    });
    vi.spyOn(DockerEmployeeEngine.prototype, 'initialPlanReplacementInstallation').mockImplementation(
      async (row, current) => {
        current();
        return {
          version: 1,
          purpose: 'reverie-plan-installed-v1',
          readMode: 'initial',
          operationId: row.request.operationId,
          sessionId: row.request.sessionId,
          containerId: row.destination!.containerId,
          projectionDigest: selected.projectionDigest,
          accountId: 'b',
          provider: 'anthropic',
          contextInputDigest: digest(context),
          installedAuthDigest: material.authDigest,
          observedAuthDigest: material.authDigest,
          tokenDigest: 'a'.repeat(64),
          contextDigest: 'b'.repeat(64),
          observedContextDigest: 'b'.repeat(64),
          homeDev: '11',
          homeIno: '12',
          configDev: '11',
          configIno: '13',
        };
      }
    );
    vi.spyOn(DockerEmployeeEngine.prototype, 'observePlanReplacementWork').mockImplementation(async (row, current) => {
      current();
      return {
        original: row.destination!,
        state: 'running',
        resources: row.policy,
        provider: { kind: 'absent' as const },
        credentialDigest: null,
      };
    });
    const rawRun = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (args, input) =>
      args.includes(DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM)
        ? JSON.stringify({
            version: 1,
            purpose: 'reverie-plan-account-status-v1',
            provider: 'anthropic',
            authenticated: true,
          })
        : rawRun(args, input)
    );
    const publish = vi.spyOn(reopened, 'dockerPublish');
    const no = async () => {
      throw Error('Unexpected legacy/effect call');
    };
    const port: PlanMovePort = {
      load: () => reopened.load(),
      save: (rows) => reopened.save(rows),
      dockerReplacement: f.baseActor,
      dockerJournal: {
        reserve: (...a) => reopened.dockerReserve(...a),
        record: (id) => reopened.dockerRecord(id),
        readCurrent: (...a) => reopened.dockerReadCurrent(...a),
        current: (...a) => reopened.dockerCurrent(...a),
        publish: (...a) => reopened.dockerPublish(...a),
        claim: (...a) => reopened.dockerClaim(...a),
        phase: (...a) => reopened.dockerPhase(...a),
      },
      snapshot: no,
      idle: no,
      create: no,
      start: no,
      ready: no,
      beforeStop: no,
      stop: no,
      rebind: no,
      binding: () => f.saved.id,
      exists: () => true,
      audit: async () => {},
    };
    const moves = new PlanMoves(port),
      app = Fastify();
    cleanup.push(() => app.close());
    await app.register(cookie);
    if (owner !== undefined)
      app.addHook('preHandler', async (request) => {
        request.authUser = { username: owner, role: 'admin' };
      });
    registerPlanMoveRoutes(app, moves, { authSessions: credentials as never }, undefined, (request) =>
      planMoveExecutor(
        {
          company: f.company,
          plans: f.plans,
          chat: {
            rooms: () => [],
            post: () => {
              throw Error('Unexpected post');
            },
            auditEntry: async () => {},
          },
          sessions: f.sessions,
          mux: f.ctx.mux,
          cleanup: no,
          authorized: () => true,
          request: no,
          dockerReplacement: f.baseActor,
          dockerRequester: () => {
            throw Error('New request forbidden');
          },
          dockerOriginalRequester: (id) =>
            captureDockerPlanMoveOriginalRequester(
              request,
              id,
              reopened,
              f.company,
              { authSessions: credentials as never },
              undefined,
              f.current
            ),
        },
        owner
      )
    );
    const reply = await app.inject({
      method: 'POST',
      url: '/api/plans/moves/' + original.id + '/resolve',
      headers: { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner' },
      payload: {
        action: 'continue-original',
        oldSession: original.oldSession,
        newSession: original.newSession,
        toAccount: original.toAccount,
      },
    });
    expect(reply.statusCode).toBe(202);
    await expect
      .poll(
        async () => {
          const current = await moves.get(original.id, owner);
          return current?.phase === 'recovery-required' ? current.error : undefined;
        },
        { timeout: 5000 }
      )
      .toBeTruthy();
    const after = await reopened.dockerRecord(original.id);
    const issued = publish.mock.calls.filter(([, before, next]) => !before.paidDispatch && !!next.paidDispatch);
    if (change) {
      expect(issued).toHaveLength(0);
      expect(after.dockerReplacement!.paidDispatch).toBeUndefined();
      if (change === 'material') expect(after.error).toBe('The held target material changed');
    } else {
      expect(after.error).not.toBe('The held target material changed');
      expect(issued, after.error).toHaveLength(1);
      expect(after.dockerReplacement!.paidDispatch).toMatchObject({
        phase: 'issued',
        operationId: seed.target.operationId,
        containerId: work.destination!.containerId,
      });
      // Publication intentionally stops at the fixture's unavailable saved-state
      // writer; no provider launch/effect capability is claimed from these ports.
      expect(after.error).toContain('setSession');
    }
    expect(f.nativeCreate).not.toHaveBeenCalled();
  });

  it.each([
    'closed-source',
    'revoked-owner',
    'changed-cursor',
    'running-source',
    'paid-unknown',
    'forged-requester',
  ] as const)('binds only fresh original authority before runner checks: %s', async (mode) => {
    const f = await fixture(true, false, true);
    if (mode === 'running-source') await f.actor.stopSource(f.record, f.journal);
    else await issuedCheckpoint(f, undefined, 'published', mode !== 'paid-unknown');
    const original = { ...(await f.moves.dockerRecord(f.record.id)), phase: 'recovery-required' as const };
    await f.moves.save([original]);
    const before = original.dockerReplacement!,
      baselineCalls = f.run.mock.calls.length;
    const credentials = new Map([['owner', { ip: '127.0.0.1', ua: 'test', createdAt: 1, method: 'basic' as const }]]);
    const deny = async () => {
      throw Error('Unexpected legacy/effect call');
    };
    const app = Fastify();
    cleanup.push(() => app.close());
    await app.register(cookie);
    let compatibilityReads = 0;
    // The local fixed CLI is a controlled compatibility DATA port. Actual
    // Actor/current, SourceReader, native continuation and Store claim stay real.
    const protocol = vi.spyOn(planProtocol, 'requireDockerPlanProtocol').mockImplementation((_digest, current) => {
      current();
      compatibilityReads++;
      if (mode === 'closed-source') throw Error('bound original reached exact protocol boundary');
    });
    vi.spyOn(f.engine, 'observePool').mockResolvedValue(original.dockerReplacement!.seed.source.record.pool!);
    if (mode === 'running-source') Object.assign(f.raw.State, { Running: true, Status: 'running', Pid: 42 });
    const claimed = vi.spyOn(f.moves, 'dockerClaim');
    const port: PlanMovePort = {
      load: () => f.moves.load(),
      save: (rows) => f.moves.save(rows),
      dockerReplacement: f.baseActor,
      dockerJournal: {
        reserve: (...args) => f.moves.dockerReserve(...args),
        record: (id) => f.moves.dockerRecord(id),
        readCurrent: (...args) => f.moves.dockerReadCurrent(...args),
        current: (...args) => f.moves.dockerCurrent(...args),
        publish: (...args) => f.moves.dockerPublish(...args),
        claim: (...args) => f.moves.dockerClaim(...args),
        phase: (...args) => f.moves.dockerPhase(...args),
      },
      snapshot: deny,
      idle: deny,
      create: deny,
      start: deny,
      ready: deny,
      beforeStop: deny,
      stop: deny,
      rebind: deny,
      binding: () => f.saved.id,
      exists: () => true,
      audit: async () => {},
    };
    const moves = new PlanMoves(port);
    const factories = vi.fn();
    registerPlanMoveRoutes(app, moves, { authSessions: credentials as never }, undefined, (request) => {
      const runtime: PlanMoveRuntime = {
        company: f.company,
        plans: f.plans,
        chat: {
          rooms: () => [],
          post: () => {
            throw Error('Unexpected chat post');
          },
          auditEntry: async () => {},
        },
        sessions: f.sessions,
        mux: f.ctx.mux,
        cleanup: deny,
        authorized: () => credentials.has('owner'),
        request: deny,
        dockerReplacement: f.baseActor,
        dockerRequester: () => {
          throw Error('A new choice cannot bind an original');
        },
        dockerOriginalRequester: async (id) => {
          factories();
          const proof = await captureDockerPlanMoveOriginalRequester(
            request,
            id,
            f.moves,
            f.company,
            { authSessions: credentials as never },
            undefined,
            f.current
          );
          if (mode === 'revoked-owner') credentials.delete('owner');
          if (mode === 'changed-cursor') {
            // A competing original epoch is recording metadata only; it must
            // invalidate this runner before any native inspection/dispatch.
            await f.moves.dockerClaim(id, before, 'f0000000-0000-4000-8000-00000000000f', () => {}, f.current);
          }
          return mode === 'forged-requester' ? { ...original, purpose: 'original' } : proof;
        },
      };
      return planMoveExecutor(runtime);
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plans/moves/' + original.id + '/resolve',
      headers: { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner' },
      payload: {
        action: 'continue-original',
        oldSession: original.oldSession,
        newSession: original.newSession,
        toAccount: original.toAccount,
      },
    });
    expect(response.statusCode).toBe(202);
    await expect
      .poll(
        async () => {
          const value = await moves.get(original.id, original.owner);
          return value?.phase === 'recovery-required' ? value.error : undefined;
        },
        { timeout: 5000 }
      )
      .toBeTruthy();
    const after = await f.moves.dockerRecord(original.id),
      view = (await moves.get(original.id, original.owner))!;
    expect(view.error).not.toContain('original Docker move requester is unavailable');
    expect(factories).toHaveBeenCalledOnce();
    if (mode === 'closed-source') {
      expect(after.error).toBe('bound original reached exact protocol boundary');
      expect(protocol).toHaveBeenCalledOnce();
    } else if (mode === 'paid-unknown') {
      expect(protocol).not.toHaveBeenCalled();
      expect(after.dockerReplacement?.paidDispatch).toEqual(before.paidDispatch);
    } else if (mode !== 'running-source') expect(protocol).not.toHaveBeenCalled();
    if (mode === 'changed-cursor') {
      expect(claimed).toHaveBeenCalledOnce();
      expect(after.dockerReplacement?.epoch, view.error).not.toBe(before.epoch);
    } else {
      expect(claimed).not.toHaveBeenCalled();
      expect(after.dockerReplacement).toEqual(before);
    }
    expect(f.nativeCreate).not.toHaveBeenCalled();
    expect(
      f.run.mock.calls
        .slice(baselineCalls)
        .some(([args]) => args[0] === 'container' && ['start', 'stop', 'rename'].includes(args[1]!))
    ).toBe(false);
  });
});

it.each(['unattached', 'busy', 'dialog', 'revoked-input'] as const)(
  'keeps handoff unissued after a known %s input refusal at the final boundary',
  async (kind) => {
    const f = await publishedTargetFixture('published'),
      journal = await f.loadJournal(),
      actor = f.actor();
    // Controlled local UI observations let the real Engine-earned target fence
    // reach finalization. They are not a native provider/readiness acceptance.
    vi.spyOn(f.native.target, 'pid', 'get').mockReturnValue(123);
    vi.spyOn(f.native.target, 'terminalBuffer', 'get').mockReturnValue('❯ \n shift+tab to cycle');
    await actor.verify(f.record, journal);
    if (kind !== 'unattached') vi.spyOn(f.native.target, 'muxName', 'get').mockReturnValue('controlled-existing-pane');
    if (kind === 'busy') vi.spyOn(f.native.target, 'isWorking', 'get').mockReturnValue(true);
    if (kind === 'dialog') vi.spyOn(f.native.target, 'paneDialog', 'get').mockReturnValue('Permission needed');
    if (kind === 'revoked-input') f.native.target.holdUnconfirmedInput(Error('Prior input remains unknown'));
    const before = journal.read(),
      write = vi.spyOn(f.native.target, 'writeViaMux');
    const refused = await actor.finalize(f.record, journal).catch((error: unknown) => error);
    expect(journal.read()).toEqual(before);
    expect((await f.moves.dockerRecord(f.record.id)).dockerReplacement).toEqual(before);
    expect(before.handoff).toBeUndefined();
    expect(refused).toBeInstanceOf(PlanMoveComposerNotReady);
    expect(write).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.native.command.create).not.toHaveBeenCalled();
  }
);

it('names the provider start-up screen its target is waiting at, as description only', async () => {
  const f = await publishedTargetFixture('published'),
    journal = await f.loadJournal();
  // Controlled local UI observations, as above: a live viewer that shows a sign-in
  // prompt rather than a composer. They are not a native readiness acceptance.
  vi.spyOn(f.native.target, 'pid', 'get').mockReturnValue(123);
  vi.spyOn(f.native.target, 'terminalBuffer', 'get').mockReturnValue(' Select login method:');
  vi.spyOn(f.native.target, 'startupScreen').mockReturnValue({
    id: 'claude-sign-in',
    label: "Claude's sign-in screen",
    kind: 'credential',
    answering: false,
    shown: 'widget',
  });
  const before = journal.read(),
    write = vi.spyOn(f.native.target, 'writeViaMux');
  const refused = await f
    .actor()
    .verify(f.record, journal)
    .catch((error: unknown) => error);
  // Still the retryable not-ready refusal, now saying where the session is.
  expect(refused).toBeInstanceOf(PlanMoveComposerNotReady);
  expect((refused as PlanMoveComposerNotReady).waitingAt).toMatchObject({
    label: "Claude's sign-in screen",
    kind: 'credential',
    answering: false,
  });
  expect((refused as Error).message).toMatch(/new session is waiting at Claude's sign-in screen/i);
  expect(journal.read()).toEqual(before);
  expect(write).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
});

it('retains the exact input admission across the handoff publication await', async () => {
  const f = await publishedTargetFixture('published'),
    journal = await f.loadJournal(),
    actor = f.actor();
  // These local UI read ports only isolate the private input lease. They make
  // no physical provider-readiness or successful handoff claim.
  vi.spyOn(f.native.target, 'pid', 'get').mockReturnValue(123);
  vi.spyOn(f.native.target, 'muxName', 'get').mockReturnValue('controlled-existing-pane');
  vi.spyOn(f.native.target, 'terminalBuffer', 'get').mockReturnValue('❯\n────\nshift+tab to cycle');
  vi.spyOn(Session.prototype, 'composerProvablyIdle').mockReturnValue(true);
  await actor.verify(f.record, journal);
  const publish = journal.publish.bind(journal),
    write = vi.spyOn(f.native.target, 'writeViaMux');
  journal.publish = async (before, next) => {
    await publish(before, next);
    // Same public mode/recipe; genuine Session method invalidates the original
    // workspace/input epoch while the async durable publication was pending.
    f.native.target.setMode(f.native.target.mode);
  };
  const refused = await actor.finalize(f.record, journal).catch((error: unknown) => error);
  expect(write).not.toHaveBeenCalled();
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain('canceled');
  expect(journal.read().handoff?.phase).toBe('issued');
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.native.command.create).not.toHaveBeenCalled();
});

it('hands off over a composer that shows only Claude’s own suggestion, and never over the same words typed', async () => {
  const f = await publishedTargetFixture('published'),
    journal = await f.loadJournal(),
    actor = f.actor();
  // The candidate pane of 2026-11-24: a finished turn, then a next prompt that Claude itself suggests.
  const frame = (composer: string) =>
    [
      '✻ Sautéed for 18s · done 7:35 AM',
      '──────────────────────────────────────────────────── Ada ─',
      composer,
      '────────────────────────────────────────────────────────',
      '  Opus 5.5  in:50,206 out:648  ctx:5%  cache:until 08:35',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
  const typed = frame('❯ yes, check Vulkan and start the RTX run'),
    suggested = frame('❯ \x1b[7my\x1b[0;2mes,\x1b[0m \x1b[2mcheck Vulkan and start the RTX run\x1b[0m');
  let screen = typed;
  vi.spyOn(f.native.target, 'pid', 'get').mockReturnValue(123);
  vi.spyOn(f.native.target, 'muxName', 'get').mockReturnValue('controlled-existing-pane');
  vi.spyOn(f.native.target, 'terminalBuffer', 'get').mockImplementation(() => screen);
  // The session's own idle proof, reduced to the composer read it ends in; the other holds are not under test here.
  vi.spyOn(Session.prototype, 'composerProvablyIdle').mockImplementation(() => composerIsEmpty(screen, '❯'));
  const write = vi.spyOn(f.native.target, 'writeViaMux').mockImplementation(async (_text, options) => {
    options?.onOutcome?.('submitted');
    return true;
  });
  await actor.verify(f.record, journal);
  const before = journal.read();
  const refused = await actor.finalize(f.record, journal).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(PlanMoveComposerNotReady);
  expect((refused as Error).message).toBe('The existing candidate is not at its verified composer');
  expect(write).not.toHaveBeenCalled();
  expect(journal.read()).toEqual(before);
  screen = suggested;
  await actor.finalize(f.record, journal);
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]![1]).toMatchObject({ requireEmptyComposer: true });
  expect(journal.read().handoff?.phase).toBe('submitted');
  // A submitted handoff is the record's own evidence: the composer is not consulted again.
  screen = typed;
  await actor.verify(f.record, journal);
  await actor.finalize(f.record, journal);
  expect(write).toHaveBeenCalledOnce();
});
