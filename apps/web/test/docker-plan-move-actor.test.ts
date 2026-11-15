import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
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
  requireDockerPlanMoveRequesterCurrent,
} from '../src/docker-plan-move-requester.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import { DockerPlanMoveSeed, DockerPlanMoveJournalState } from '../src/docker-plan-move-data.js';
import type { PlanMoveRecord, PlanMoveInput } from '../src/plan-move.js';
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
  vi.spyOn(PackagedDockerEngineCommand.prototype, 'create').mockImplementation(async () => {
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
    retain,
    sessions,
    loseStop: () => {
      loseStop = true;
    },
    keyLost: () => {
      key = false;
    },
  };
}
describe('captured native plan actor before paid dispatch', () => {
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
