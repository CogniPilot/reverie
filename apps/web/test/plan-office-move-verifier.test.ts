/** Actual private-FS and production installer/read decoder with controlled OS metadata ports.
 * These unit stubs never constitute physical office, account or paid acceptance. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  verifyPlanOfficeMovedProvider,
  verifyPlanOfficeReadyNative,
  planOfficeCanonicalAuthDigest,
  planOfficeVerifierReadAllowed,
  type PlanOfficeBeforeMove,
} from './helpers/plan-office-move-verifier.js';
import { planFixtureTurnBarrier, type PlanProviderFixtureReport } from './helpers/boxed-plan-provider.js';
import { ciPlanPolicy } from './helpers/plan-office-driver.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { DockerEmployeeContinuationRecord, DockerEmployeeBinding } from '../src/docker-employee-continuation-data.js';
import { boxedOriginal, type DockerEmployeeInspect } from '../src/docker-employee-engine-data.js';
import { identityHelperConfiguration } from '../src/docker-identity-helper.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../src/docker-employee-provider-view-native.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const uuid = (n: number) => n.toString().padStart(8, '0') + '-0000-4000-8000-000000000001',
  hex = (s: string) => s.repeat(64);
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-verifier-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const instance = 'a'.repeat(32),
    namespace = 'reverie-ci-plan-office-' + instance,
    office = path.join(root, 'office-' + instance),
    f = dockerPlanJournalFixture();
  const mkdir = (p: string) => {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    fs.chmodSync(p, 0o700);
    return p;
  };
  mkdir(office);
  mkdir(path.join(office, 'accounts'));
  mkdir(path.join(office, 'accounts', 'plan-b'));
  const auth = path.join(office, 'accounts', 'plan-b', '.credentials.json');
  fs.writeFileSync(auth, JSON.stringify({ synthetic: 'canonical-b' }) + '\n', { mode: 0o600 });
  const home = mkdir(path.join(office, 'workers', f.state.seed.source.record.employeeId, 'home'));
  mkdir(path.join(home, '.fixture'));
  const stat = fs.statSync(home),
    user = process.getuid!() + ':' + process.getgid!(),
    image = f.work.workerImage.imageId,
    thread = uuid(9),
    moveId = uuid(10),
    box = hex('7'),
    policy = ciPlanPolicy([0]);
  const inspect = (id: string, sid: string, op: string, generation: number): DockerEmployeeInspect => ({
    Id: id,
    Image: image,
    State: {
      Running: true,
      Status: 'running',
      Pid: 42,
      StartedAt: 'synthetic-incarnation',
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    Config: {
      User: user,
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: null,
      Env: ['HOME=/home/agent'],
      Labels: {
        'reverie.boxed.employee': f.work.employeeId,
        'reverie.boxed.session': sid,
        'reverie.boxed.instance': namespace,
        'reverie.boxed.operation': op,
        'reverie.boxed.generation': String(generation),
      },
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      PidMode: '',
      OomKillDisable: false,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
    Mounts: [{ Type: 'bind', Source: home, Destination: '/home/agent', RW: true, Propagation: 'rprivate' }],
  });
  const original = f.state.seed.source.record,
    rawSource = inspect(original.destination!.containerId, original.request.sessionId, original.request.operationId, 1);
  const sub = (sid: string, generation: number) => ({
    employeeId: f.work.employeeId,
    sessionId: sid,
    sessionGeneration: generation,
    owner: 'synthetic-owner',
    sourceDigest: hex('2'),
    providerSourceDigest: hex('3'),
    onVacation: false,
    desiredRunning: true,
  });
  const sourceOriginal = boxedOriginal(rawSource, sub(original.request.sessionId, 1), namespace, true);
  const old = DockerEmployeeContinuationRecord.parse({
    ...original,
    policy,
    request: { ...original.request, expectedPolicyDigest: digest(policy) },
    original: { ...original.original, home: sourceOriginal.home, storageDigest: sourceOriginal.storageDigest },
    destination: sourceOriginal,
  });
  const binding = (row: DockerEmployeeContinuationRecord) =>
    DockerEmployeeBinding.parse({
      version: 1,
      operationId: row.request.operationId,
      credentialId: row.credentialId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
      containerId: row.destination!.containerId,
      imageId: row.destination!.imageId,
      originalDigest: digest(row.destination),
      policyDigest: digest(row.policy),
    });
  const rawTarget = inspect(hex('c'), f.targetSid, f.targetOp, 2),
    destination = boxedOriginal(rawTarget, sub(f.targetSid, 2), namespace, true),
    canonical = planOfficeCanonicalAuthDigest(office, 'ci-plan-b');
  const initial = {
    version: 1,
    purpose: 'reverie-plan-installed-v1',
    readMode: 'initial',
    operationId: f.targetOp,
    sessionId: f.targetSid,
    containerId: rawTarget.Id,
    projectionDigest: f.work.planReplacement.account.projectionDigest,
    accountId: 'ci-plan-b',
    provider: 'anthropic',
    contextInputDigest: f.work.planReplacement.account.contextDigest,
    installedAuthDigest: canonical,
    observedAuthDigest: canonical,
    tokenDigest: hex('2'),
    contextDigest: hex('3'),
    observedContextDigest: hex('3'),
    homeDev: String(stat.dev),
    homeIno: String(stat.ino),
    configDev: String(stat.dev),
    configIno: '13',
  };
  const live = { ...initial, purpose: 'reverie-plan-live-observation-v1', readMode: 'live' };
  const base = f.work;
  const row = DockerEmployeeContinuationRecord.parse({
    ...base,
    original: sourceOriginal,
    policy,
    request: { ...base.request, expectedPolicyDigest: digest(policy) },
    phase: 'ready',
    destination,
    pool: {
      containerId: hex('6'),
      cgroupParent: '/synthetic-pool',
      policyDigest: digest(policy.pool),
      physicalDigest: hex('8'),
    },
    planReplacement: {
      ...base.planReplacement,
      moveId,
      source: { ...base.planReplacement.source, binding: binding(old), continuationDigest: digest(old) },
      account: { ...base.planReplacement.account, id: 'ci-plan-b' },
    },
    tasks: [
      {
        role: 'storage-holder',
        name: 'reverie-boxed-storage-synthetic',
        imageId: image,
        configurationDigest: hex('b'),
        phase: 'running',
        containerId: hex('7'),
        initPid: 100,
        initStartTicks: '10',
      },
      {
        role: 'leaf-helper',
        name: 'reverie-boxed-leaf-synthetic',
        imageId: image,
        configurationDigest: hex('b'),
        phase: 'completed',
        containerId: hex('8'),
        resultDigest: hex('b'),
      },
      {
        role: 'identity-helper',
        name: 'reverie-boxed-identity-' + digest([box, 'identity-helper', f.targetOp]),
        imageId: image,
        configurationDigest: hex('b'),
        phase: 'completed',
        containerId: hex('9'),
        resultDigest: digest(initial),
      },
    ],
  });
  if (row.version !== 3) throw Error();
  const homeData = { source: home, user, dev: String(stat.dev), ino: String(stat.ino) },
    imageRaw = { Id: image, Config: { Env: ['HOME=/home/agent', 'PATH=/bin'], Volumes: null } };
  const config = await identityHelperConfiguration(
    {
      run: async () => JSON.stringify([imageRaw]),
      create: async () => {
        throw Error('No create');
      },
    },
    row,
    homeData,
    box,
    { projectionDigest: f.work.planReplacement.account.projectionDigest, payloadDigest: hex('a'), attempt: f.targetOp }
  );
  row.tasks!.find((t) => t.role === 'identity-helper')!.configurationDigest = digest(config);
  const terminal = {
    Running: false,
    Status: 'exited',
    Pid: 0,
    ExitCode: 0,
    OOMKilled: false,
    Dead: false,
    Restarting: false,
    Paused: false,
    StartedAt: 'synthetic-installer',
    FinishedAt: 'synthetic-finished',
  };
  const helper = {
    Id: hex('9'),
    Image: image,
    Config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'HostConfig')),
    HostConfig: structuredClone(config.HostConfig),
    Mounts: [{ Type: 'bind', Source: home, Destination: '/home/agent', RW: true }],
    State: terminal,
  };
  const closedSource = {
    ...structuredClone(rawSource),
    State: {
      ...rawSource.State,
      StartedAt: rawSource.State.StartedAt,
      Running: false,
      Status: 'exited',
      Pid: 0,
      FinishedAt: 'synthetic-finished',
    },
  };
  const native = {
    paneId: '%0',
    panePid: 485,
    paneStartTicks: '1234',
    hooks: { kind: 'generation' as const, generation: uuid(11) },
  };
  const report = (turnId: string, accountId: string | null, args: string[]): PlanProviderFixtureReport => ({
    version: 1,
    purpose: 'synthetic-plan-provider-turn-v1',
    turnId,
    employeeId: row.employeeId,
    sessionId: f.targetSid,
    providerThread: thread,
    namespacePid: 485,
    hookGenerationSha256: createHash('sha256').update(native.hooks.generation).digest('hex'),
    requestId: null,
    accountId,
    state: 'idle',
    probes: args.map((arg) => ({ args: arg.split(' '), exitCode: 0, stdoutSha256: hex('a'), stderrSha256: hex('b') })),
    limitation: 'External fake provider only; no native, permission, policy or paid-dispatch proof.',
  });
  const startup = report(uuid(12), null, ['agent capabilities --json', 'worker-callback hook-event --event stop']),
    handoff = report(uuid(13), 'ci-plan-b', [
      'plans --json',
      'worker-callback hook-event --event prompt_submitted',
      'worker-callback hook-event --event stop',
    ]);
  for (const [i, r] of [startup, handoff].entries())
    fs.writeFileSync(
      path.join(home, '.fixture', 'plan-turn-' + f.targetSid + '-' + i + '.json'),
      JSON.stringify(r) + '\n',
      { mode: 0o600 }
    );
  let capture = planFixtureTurnBarrier(startup) + '\n' + planFixtureTurnBarrier(handoff) + '\n❯ ',
    nativeCalls = 0;
  const employee = { id: row.employeeId, sessionId: f.targetSid, sessionGeneration: 2, dockerBinding: binding(row) };
  const session = {
    id: f.targetSid,
    providerInputHeld: false,
    isWorking: false,
    status: 'idle',
    claudeSessionId: thread,
  };
  const resources = {
    employeeId: row.employeeId,
    sessionId: f.targetSid,
    sessionGeneration: 2,
    operationId: f.targetOp,
    containerId: rawTarget.Id,
    enforcement: 'fresh-native-readback',
    actualMemoryHighBytes: policy.memoryHighBytes,
    memoryMaxBytes: policy.memoryMaxBytes,
  };
  const metadata = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'image') return JSON.stringify([imageRaw]);
    if (args[0] === 'logs') return JSON.stringify(initial) + '\n';
    if (args[0] === 'container')
      return JSON.stringify([args[2] === helper.Id ? helper : args[2] === rawTarget.Id ? rawTarget : closedSource]);
    if (args.includes('plan-status')) return JSON.stringify(live) + '\n';
    if (args.includes(DOCKER_PROVIDER_VIEW_PROGRAM)) {
      nativeCalls++;
      return JSON.stringify(native) + '\n';
    }
    if (args.includes('capture-pane')) return capture;
    throw Error('Unrecognized metadata command');
  });
  const record = vi.fn(),
    ports = {
      current: vi.fn(),
      metadata,
      snapshot: () => ({ employee, row }),
      ownerGet: vi.fn(
        async (p: string) =>
          new Response(JSON.stringify({ success: true, data: p.startsWith('/api/sessions/') ? session : resources }), {
            status: 200,
          })
      ),
      record,
    };
  const before: PlanOfficeBeforeMove = {
    scenario: {
      version: 1,
      purpose: 'reverie-ci-plan-move-scenario-v1',
      kind: 'self',
      id: moveId,
      employeeId: row.employeeId,
      sessionId: old.request.sessionId,
      sessionGeneration: 1,
      fromAccount: 'ci-plan-a',
      toAccount: 'ci-plan-b',
    },
    namespace,
    fixtureRoot: office,
    workerImageId: image,
    clientManifestDigest: row.workerImage.clientManifestDigest,
    boxId: box,
    nativeThreadId: thread,
    sourceRow: old,
    sourceInspect: rawSource,
    home: homeData,
    canonicalAuthDigest: canonical,
  };
  const completed = { id: moveId, employeeId: row.employeeId, phase: 'completed', newSession: f.targetSid };
  return {
    before,
    completed,
    ports,
    row,
    initial,
    live,
    helper,
    rawTarget,
    closedSource,
    employee,
    session,
    resources,
    auth,
    startup,
    handoff,
    setCapture: (s: string) => {
      capture = s;
    },
    native,
    nativeCalls: () => nativeCalls,
  };
}
it('performs only fixed actual read protocols and correlates the production installer ACK/live read with retained HOME, account, thread and unique turn barriers', async () => {
  const f = await fixture();
  await verifyPlanOfficeMovedProvider(f.before, f.completed, f.ports);
  expect(f.ports.record).toHaveBeenCalledTimes(1);
  expect(f.nativeCalls()).toBe(2);
  expect(
    f.ports.metadata.mock.calls.every(([a]) => !a.includes('start') && !a.includes('create') && !a.includes('stop'))
  ).toBe(true);
  expect(f.ports.record.mock.calls[0]?.[1]).toMatchObject({
    sourceStopped: true,
    targetId: f.rawTarget.Id,
    canonicalAuthDigest: f.before.canonicalAuthDigest,
    handoffTurnId: f.handoff.turnId,
    actualCallbacksAndConsumingCloses: true,
  });
});
it('refuses changed canonical/private auth and an original helper failure instead of inferring principal identity or completion', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.live.observedAuthDigest = hex('f');
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      fs.writeFileSync(f.auth, 'changed');
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.helper.State.ExitCode = 1;
    },
  ]) {
    const f = await fixture();
    mutate(f);
    await expect(verifyPlanOfficeMovedProvider(f.before, f.completed, f.ports)).rejects.toThrow();
    expect(f.ports.record).not.toHaveBeenCalled();
  }
});
it('does not accept readable post-handoff receipt bytes with only the old startup close barrier', async () => {
  const f = await fixture();
  f.setCapture(planFixtureTurnBarrier(f.startup) + '\n❯ ');
  await expect(verifyPlanOfficeMovedProvider(f.before, f.completed, f.ports)).rejects.toThrow(
    'handoff turn consuming-close'
  );
  expect(f.ports.record).not.toHaveBeenCalled();
});
it('refuses live/restarted sources, wrong target PID birth, stale scope, owner logout or unverified resource facts', async () => {
  const live = await fixture();
  live.closedSource.State.Running = true;
  await expect(verifyPlanOfficeMovedProvider(live.before, live.completed, live.ports)).rejects.toThrow();
  const restarted = await fixture();
  restarted.closedSource.State.StartedAt = 'different-incarnation';
  await expect(verifyPlanOfficeMovedProvider(restarted.before, restarted.completed, restarted.ports)).rejects.toThrow();
  const pane = await fixture();
  const original = pane.ports.metadata.getMockImplementation()!;
  pane.ports.metadata.mockImplementation(async (args) => {
    const value = await original(args);
    return args.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && pane.nativeCalls() === 2
      ? JSON.stringify({ ...pane.native, paneStartTicks: '9999' })
      : value;
  });
  await expect(verifyPlanOfficeMovedProvider(pane.before, pane.completed, pane.ports)).rejects.toThrow();
  const scope = await fixture();
  scope.employee.sessionGeneration = 3;
  await expect(verifyPlanOfficeMovedProvider(scope.before, scope.completed, scope.ports)).rejects.toThrow();
  const logout = await fixture();
  logout.ports.ownerGet.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 403 }));
  await expect(verifyPlanOfficeMovedProvider(logout.before, logout.completed, logout.ports)).rejects.toThrow();
  const facts = await fixture();
  facts.resources.enforcement = 'not-observed';
  await expect(verifyPlanOfficeMovedProvider(facts.before, facts.completed, facts.ports)).rejects.toThrow();
});
it('requires real private owned files and refuses symlinks or named replacement before accepting an auth digest', async () => {
  const f = await fixture();
  fs.chmodSync(f.auth, 0o644);
  expect(() => planOfficeCanonicalAuthDigest(f.before.fixtureRoot, 'ci-plan-b')).toThrow();
  fs.chmodSync(f.auth, 0o600);
  fs.renameSync(f.auth, f.auth + '.retained');
  fs.symlinkSync(f.auth + '.retained', f.auth);
  expect(() => planOfficeCanonicalAuthDigest(f.before.fixtureRoot, 'ci-plan-b')).toThrow();
});
it('does not admit any arbitrary Docker command or altered fixed read vector', () => {
  const allowed = [
    ['logs', hex('a')],
    ['container', 'inspect', hex('b')],
  ];
  expect(planOfficeVerifierReadAllowed(['logs', hex('a')], allowed)).toBe(true);
  for (const args of [
    ['start', hex('a')],
    ['container', 'start', hex('b')],
    ['logs', '--follow', hex('a')],
    ['exec', hex('a'), '/bin/sh'],
    ['container', 'inspect', hex('b'), hex('c')],
  ])
    expect(planOfficeVerifierReadAllowed(args, allowed)).toBe(false);
});

it('earns startup native incarnation plus exact checked-close barrier using only fixed read argv', async () => {
  const f = await fixture();
  const value = await verifyPlanOfficeReadyNative(f.row, f.before.nativeThreadId, f.startup, f.ports);
  expect(value.native).toEqual(f.native);
  expect(
    f.ports.metadata.mock.calls.every(
      ([args]) => !args.includes('start') && !args.includes('create') && !args.includes('stop')
    )
  ).toBe(true);
});
it('refuses startup receipt/native identity mismatches, missing close barrier and revocation', async () => {
  for (const changed of ['pid', 'thread', 'generation', 'barrier', 'birth', 'revoked']) {
    const f = await fixture(),
      report = structuredClone(f.startup);
    if (changed === 'pid') report.namespacePid++;
    if (changed === 'thread') report.providerThread = uuid(99);
    if (changed === 'generation') report.hookGenerationSha256 = hex('f');
    if (changed === 'barrier') f.setCapture('❯ ');
    if (changed === 'birth') {
      const original = f.ports.metadata.getMockImplementation()!;
      let n = 0;
      f.ports.metadata.mockImplementation(async (args) => {
        if (args.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && ++n === 2)
          return JSON.stringify({ ...f.native, paneStartTicks: '9999' });
        return original(args);
      });
    }
    if (changed === 'revoked')
      f.ports.current
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw Error('revoked');
        });
    await expect(verifyPlanOfficeReadyNative(f.row, f.before.nativeThreadId, report, f.ports)).rejects.toThrow();
  }
});
