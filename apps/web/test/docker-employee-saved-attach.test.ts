import { DOCKER_EMPLOYEE_PROVIDER_RECIPE_FIELDS } from '../src/docker-employee-provider-recipe.js';
import type { ClaudeMode } from '../src/types.js';
/** Actual private Engine capture over controlled OS replies, real saved StateStore
 * and Session. No installed/native/provider acceptance; no view/receipt DTO grant. */
import fs from 'node:fs';
import * as childProcess from 'node:child_process';
import {
  installRecordedDockerViewer,
  recordedDockerViewerSocketPath,
  recordedDockerViewerStat,
  type RecordedDockerViewerClient,
} from './helpers/recorded-docker-viewer.js';
import { openDockerEmployeeRuntime } from '../src/docker-employee-runtime.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import type { CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { CompanyDockerContinuationStore, dockerEmployeeSourceDigest } from '../src/docker-employee-store.js';
import { DockerEmployeeSessionProvider } from '../src/docker-employee-session-provider.js';
import type { SessionPort, ConfigPort, InfraPort } from '../src/web/ports/index.js';
import { dirname } from 'node:path';
import { TerminalInputService, terminalInputFingerprint } from '../src/web/terminal-input-service.js';
import { StateStore } from '../src/state-store.js';
import { PROVIDER_LAUNCH_DISK_KEY } from '../src/provider-launch-publication.js';
import { Session } from '../src/session.js';
import { TmuxManager, buildDockerLaunchCommand } from '../src/tmux-manager.js';
import type { CreateSessionOptions, MuxSession } from '../src/mux-interface.js';
import type { SessionDocker, SessionState } from '../src/types.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DockerEmployeeEngine,
  DockerEmployeeProviderView,
  type DockerContainedResourceController,
} from '../src/docker-employee-engine.js';
import {
  DockerEmployeeResourcePolicy,
  type DockerEmployeeContinuationRecord,
} from '../src/docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from '../src/docker-employee-engine-data.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { captureDockerEmployeeProviderLaunch } from '../src/docker-employee-provider-launch.js';
import { registerDockerWorkerIdentity, dockerWorkerIdentityOf } from '../src/docker-worker-identity.js';
import { DockerPlanLocalClient } from '../src/docker-plan-local-client.js';
import { DockerViewerPane } from '../src/docker-viewer-pane.js';
import { WorkerViewerReconnect, registerWorkerViewerReconnect } from '../src/worker-viewer-reconnect.js';
import { AGENT_EXIT as EXIT } from '../src/agent-exit-codes.js';
import { DEFAULT_AGENT_HTTP_TIMEOUT_MS } from '../src/cli-agent.js';
import Fastify from 'fastify';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type { DockerContinuationTaskJournal } from '../src/docker-continuation-task.js';
const cid = 'a'.repeat(64),
  dest = 'd'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  target = 'sha256:' + 'c'.repeat(64),
  helper = 'sha256:' + 'f'.repeat(64);
// GET company and POST reconnect each own the unchanged CLI HTTP bound. The
// Runtime's 25s one-shot admission is inside the POST, not an extra request.
// Retain the original 15s allowance for child bootstrap, and another for the
// parent's real fixture setup/cleanup; a slow/unknown child still fails once.
const CLI_BOOTSTRAP_MS = 15_000;
const VIEWER_CLI_CHILD_MS = CLI_BOOTSTRAP_MS + 2 * DEFAULT_AGENT_HTTP_TIMEOUT_MS;
const VIEWER_CLI_TEST_MS = VIEWER_CLI_CHILD_MS + CLI_BOOTSTRAP_MS;
const eid = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000002',
  oid = '30000000-0000-4000-8000-000000000003';
const subject = {
  employeeId: eid,
  sessionId: sid,
  sessionGeneration: 3,
  owner: undefined,
  sourceDigest: 'e'.repeat(64),
  providerSourceDigest: 'e'.repeat(64),
  onVacation: false,
  desiredRunning: true,
};
function fixture(boxId = '7'.repeat(64)) {
  const policy = DockerEmployeeResourcePolicy.parse({
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  });
  const source = DockerEmployeeInspect.parse({
    Id: cid,
    Image: image,
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
    Config: {
      User: '1000:100',
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: null,
      Env: ['HOME=/home/agent', 'PATH=/bin'],
      WorkingDir: '/workspace',
      Labels: { 'reverie.worker': 'fixture', 'reverie.employee': eid, 'reverie.session': sid },
    },
    Mounts: [
      { Type: 'bind', Source: '/synthetic/home', Destination: '/home/agent', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: '/synthetic/nix', Destination: '/nix', RW: true, Propagation: 'rprivate' },
      {
        Type: 'bind',
        Source: '/synthetic/host-script',
        Destination: '/instances/default/console/statusline-exporter.sh',
        RW: false,
      },
    ],
    HostConfig: {
      Privileged: false,
      OomKillDisable: false,
      Memory: 16 * 1024 ** 3,
      MemorySwap: 16 * 1024 ** 3,
      PidsLimit: 512,
      CgroupParent: 'legacy.slice',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Mounts: [],
    },
  });
  const pool = {
    containerId: '1'.repeat(64),
    cgroupParent: 'reverie-box-fixture.slice',
    policyDigest: dockerContinuationDigest(policy.pool),
    physicalDigest: '2'.repeat(64),
  };
  const original = boxedOriginal(source, subject, 'fixture');
  const row: DockerEmployeeContinuationRecord = {
    version: 1,
    purpose: 'docker-employee-continuation-v1',
    employeeId: eid,
    request: {
      operationId: oid,
      sessionId: sid,
      sessionGeneration: 3,
      containerId: cid,
      imageId: image,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: target,
      enterOffice: false,
    },
    sourceDigest: subject.sourceDigest,
    original,
    workerImage: { imageId: target, sourceImageId: image, clientManifestDigest: '4'.repeat(64) },
    policy,
    credentialId: '50000000-0000-4000-8000-000000000005',
    phase: 'pool-ready',
    pool,
  };
  let created: Record<string, unknown> | undefined;
  const command: DockerEngineCommand = {
    run: vi.fn(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([source]);
      if (args[0] === 'container' && args[1] === 'ls') return cid;
      if (args[0] === 'image')
        return JSON.stringify([
          {
            Id: args[2],
            RootFS: { Layers: args[2] === image ? ['old'] : ['old', 'new'] },
            Config: {
              Entrypoint: source.Config.Entrypoint,
              Cmd: null,
              Labels: { 'org.reverie.worker-client.manifest': '4'.repeat(64) },
            },
          },
        ]);
      throw Error('Unexpected command');
    }),
    create: vi.fn(async (_name, config, current) => {
      current();
      created = structuredClone(config);
      return dest;
    }),
  };
  const resources: DockerContainedResourceController = {
    validate: vi.fn(async () => {}),
    preparePool: vi.fn(async () => {}),
    observePool: vi.fn(async () => pool),
    read: vi.fn(async () => null),
    configure: vi.fn(async () => {}),
  };
  const journal: DockerContinuationTaskJournal = {
    read: () => undefined,
    publish: async () => {
      throw Error('Unexpected holder mutation');
    },
  };
  const engine = new DockerEmployeeEngine(
    command,
    'fixture',
    resources,
    { imageId: target, clientManifestDigest: '4'.repeat(64), sourceImageIds: [image] },
    journal,
    helper,
    boxId
  );
  return { source, row, engine, command, resources, policy, created: () => created };
}
async function dockerEncodedDestination() {
  const f = fixture();
  f.source.Mounts.push({
    Type: 'bind',
    Source: '/synthetic/workspace',
    Destination: '/workspace',
    RW: false,
    Propagation: 'rprivate',
  });
  f.row.original = boxedOriginal(f.source, subject, 'fixture');
  await f.engine.createDestination(f.row, () => {});
  const desired = f.created()!;
  const observed = DockerEmployeeInspect.parse({
    ...structuredClone(f.source),
    Id: dest,
    Image: target,
    Config: {
      ...structuredClone(f.source.Config),
      User: desired.User,
      Env: desired.Env,
      Labels: desired.Labels,
      Entrypoint: desired.Entrypoint,
      Cmd: desired.Cmd,
    },
    Mounts: f.source.Mounts.filter((m) => m.Destination !== '/instances/default/console/statusline-exporter.sh'),
    HostConfig: {
      ...(desired.HostConfig as Record<string, unknown>),
      OomKillDisable: false,
      Mounts: [
        { Type: 'bind', Source: '/synthetic/home', Target: '/home/agent', BindOptions: { Propagation: 'rprivate' } },
        { Type: 'bind', Source: '/synthetic/nix', Target: '/nix', BindOptions: { Propagation: 'rprivate' } },
        {
          Type: 'bind',
          Source: '/synthetic/workspace',
          Target: '/workspace',
          ReadOnly: true,
          BindOptions: { Propagation: 'rprivate' },
        },
      ],
    },
  });
  const originalRun = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.run).mockImplementation(async (args, options) => {
    if (args[0] === 'container' && args[1] === 'ls') return dest;
    if (args[0] === 'container' && args[1] === 'inspect' && args[2] === dest) return JSON.stringify([observed]);
    return originalRun(args, options);
  });
  return { ...f, observed };
}

const native = vi.hoisted(() => ({
  nextPid: 2_000_000,
  ptys: [] as Array<{ file: string; args: string[] }>,
  writes: [] as string[],
  data: [] as Array<(data: string) => void>,
  exits: [] as Array<(value: { exitCode: number; signal: number }) => void>,
}));
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]) => {
    native.ptys.push({ file, args });
    // Session substitutes this exact inert outer-client transport in Vitest.
    // The real Docker attach command is independently rendered and checked below.
    if (
      file !== process.execPath ||
      args.length !== 2 ||
      args[0] !== '-e' ||
      args[1] !== 'if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.pipe(process.stdout);'
    )
      throw Error('Unexpected control-local provider PTY');
    const exits: Array<(value: { exitCode: number; signal: number }) => void> = [];
    const emitExit = (value: { exitCode: number; signal: number }) => {
      for (const callback of exits) callback(value);
    };
    native.exits.push(emitExit);
    const pid = ++native.nextPid;
    return {
      pid,
      ptsName: '/dev/pts/' + pid,
      cols: 80,
      rows: 24,
      process: 'tmux',
      handleFlowControl: false,
      write: vi.fn((data: string) => native.writes.push(data)),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: (callback: (data: string) => void) => {
        native.data.push(callback);
        return { dispose: () => {} };
      },
      onExit: (fn: (value: { exitCode: number; signal: number }) => void) => {
        exits.push(fn);
        return { dispose: () => {} };
      },
      kill: () => emitExit({ exitCode: 0, signal: 0 }),
    };
  }),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn((command: string) => (command.includes('tmux') ? 'tmux 3.5a\n' : '')),
    execFileSync: vi.fn(() => Buffer.from('')),
    exec: vi.fn((_command: unknown, options: unknown, callback?: unknown) => {
      const fn = typeof options === 'function' ? options : callback;
      if (typeof fn === 'function') queueMicrotask(() => fn(null, '', ''));
      return { pid: 2147483647, on: vi.fn(), kill: vi.fn() };
    }),
    spawn: vi.fn((command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
      if (
        command !== 'flock' ||
        JSON.stringify(args) !== JSON.stringify(['--exclusive', '--wait', '5', '--conflict-exit-code', '75', '3'])
      )
        throw Error('Unexpected OS subprocess');
      return actual.spawn(command, args, options);
    }),
    execFile: vi.fn(() => {
      throw Error('Unexpected OS subprocess');
    }),
  };
});
const cleanup: Array<() => Promise<void>> = [];
function installViewerCustody(beforeCapture?: (client: RecordedDockerViewerClient) => void) {
  const recorder = installRecordedDockerViewer();
  recorder.recordCapture();
  recorder.recordLocalClients(beforeCapture);
  vi.mocked(childProcess.execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    const at = args.indexOf('-L');
    if (file !== '/bin/tmux' || at < 0 || args.at(-1) !== '#{pid}|#{socket_path}')
      throw Error('Unexpected viewer custody subprocess');
    queueMicrotask(() => callback(null, '500000|' + recordedDockerViewerSocketPath(args[at + 1]!) + '\n', ''));
    return { pid: 2147483647, on: vi.fn(), kill: vi.fn() };
  }) as unknown as typeof childProcess.execFile);
  return recorder;
}
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
  native.ptys.length = 0;
  native.writes.length = 0;
  native.data.length = 0;
  native.exits.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('admits a restored Hands session with the original local model before spawning a pane', async () => {
  const f = await dockerEncodedDestination();
  const directory = mkdtempSync(join(tmpdir(), 'boxed-local-model-'));
  const companyFile = new CompanyStore(join(directory, 'company.json'));
  const states = new StateStore(join(directory, 'state.json'));
  const mux = new TmuxManager();
  const sessions = new Map<string, Session>();
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  await companyFile.init();
  const employee = EmployeeSchema.parse({
    id: eid,
    sessionId: sid,
    sessionGeneration: 3,
    name: 'Synthetic',
    icon: 'S',
    position: 'Employee',
    expertise: ['testing'],
    createdAt: 1,
    onVacation: false,
    desiredRunning: true,
  });
  await companyFile.update((state) => {
    state.employees = [employee];
  });
  const customModel = { endpointId: 'local-test', modelId: 'synthetic-model', label: 'Local' };
  const original = new Session({ id: sid, workingDir: '/workspace', mode: 'hands', resumeSessionId: sid });
  cleanup.push(() => original.stop(false));
  original.setCustomModel({ ...customModel, envKeys: ['REVERIE_HANDS_MODEL'] });
  const saved = original.toPersistedState();
  states.setSession(sid, saved);
  const company = new CompanyService(companyFile, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  f.row.sourceDigest = dockerEmployeeSourceDigest(employee, saved);
  f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
  f.row.phase = 'provider-issued';
  const provider = new DockerEmployeeSessionProvider(
    new CompanyDockerContinuationStore(company, (id) => states.getSession(id)),
    {
      store: states,
      sessions,
      mux,
      async addSession(session: Session, _unused: undefined, admitted: () => boolean) {
        expect(admitted()).toBe(true);
        expect(session.customModel).toEqual(customModel);
        sessions.set(session.id, session);
        cleanup.push(() => session.stop(false));
      },
      reapplyPersistedSessionState: vi.fn(),
      setupSessionListeners: vi.fn(),
      persistSessionStateNow: vi.fn(),
    } as unknown as SessionPort & ConfigPort & Pick<InfraPort, 'mux'>,
    'http://boxed-office:3000'
  );
  const start = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValueOnce(undefined);
  await provider.launch(
    f.row,
    {
      version: 1,
      operationId: oid,
      credentialId: f.row.credentialId,
      sessionId: sid,
      sessionGeneration: 3,
      containerId: dest,
      imageId: target,
      originalDigest: dockerContinuationDigest(f.row.destination),
      policyDigest: dockerContinuationDigest(f.row.policy),
    },
    () => {}
  );
  expect(start).toHaveBeenCalledOnce();
  expect(sessions.get(sid)?.customModel).toEqual(customModel);
});

async function savedFixture(
  explicitUnknown = false,
  savedInputUnknown = false,
  livePermissions: { claudeMode?: ClaudeMode; allowedTools?: string } = {}
) {
  const f = await dockerEncodedDestination();
  f.observed.State.Running = true;
  f.observed.State.Pid = 123;
  f.observed.State.StartedAt = '2026-11-16T10:00:00.000000000Z';
  f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
  f.row.phase = 'ready';
  let current = true;
  const requireCurrent = () => {
    if (!current) throw Error('Canonical domain changed');
  };
  const nativeRead = {
    paneId: '%1',
    panePid: 41,
    paneStartTicks: '12345',
    hooks: { kind: 'generation', generation: 'synthetic-hook-generation' },
  };
  const run = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.run).mockImplementation(async (args, input) => {
    if (args[0] === 'exec') return JSON.stringify(nativeRead) + '\n';
    return run(args, input);
  });
  const docker: SessionDocker = {
    hostId: 'boxed-runtime',
    label: 'Synthetic',
    engine: 'docker',
    image: target,
    containerName: dest,
    hostWorkspacePath: '/',
    containerWorkdir: '/workspace',
    network: 'bridge',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      operationId: oid,
      employeeId: eid,
      sessionGeneration: 3,
      clientManifestDigest: '4'.repeat(64),
      apiUrl: 'http://synthetic.invalid:3000',
    },
  };
  const directory = mkdtempSync(join(tmpdir(), 'saved-docker-view-'));
  const path = join(directory, 'state.json');
  const writer = new StateStore(path);
  const data = {
    id: sid,
    name: 'Synthetic',
    mode: 'claude',
    claudeMode: 'normal',
    allowedTools: 'Read',
    workingDir: '/workspace',
    status: 'busy',
    pid: 23,
    createdAt: 1,
    lastActivityAt: 1,
    currentTaskId: null,
    pinned: true,
    desiredRunning: true,
    docker,
    claudeSessionChain: ['60000000-0000-4000-8000-000000000006'],
  } as SessionState;
  writer.setSession(sid, data);
  const original = new Session({ ...data, publicationStore: writer });
  const publication = writer.stageProviderLaunch(original, {
    transport: 'docker',
    current: () => true,
    snapshot: () => original.toPersistedState(),
  });
  const execution = {
    kind: 'mux' as const,
    sessionId: sid,
    owner: null,
    mode: 'claude',
    command: 'controlled-known-returned-docker',
    cwd: '/workspace',
    environment: {},
  };
  await publication.prepare(original, execution);
  publication.claim();
  const physicalReturn = vi.fn(() => true);
  publication.settle(physicalReturn());
  expect(physicalReturn).toHaveBeenCalledOnce();
  await original.stop(false);
  writer.flush();
  const denial = JSON.parse(readFileSync(path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY];
  expect(denial.rows[sid].phase).toBe('dispatch-intent');
  const loaded = new StateStore(path);
  if (explicitUnknown || savedInputUnknown) {
    loaded.setSession(sid, {
      ...loaded.getSession(sid)!,
      ...(explicitUnknown ? { providerDispatchHeld: true } : {}),
      ...(savedInputUnknown ? { terminalInputHeld: true } : {}),
    });
    loaded.flush();
  }
  const saved = loaded.getSession(sid)!;
  expect(saved.providerDispatchHeld === true).toBe(explicitUnknown);
  const mux = new TmuxManager();
  const session = new Session({
    ...saved,
    claudeMode: 'normal',
    allowedTools: 'Read',
    ...livePermissions,
    publicationStore: loaded,
    useMux: true,
    mux,
  });
  cleanup.push(async () => {
    await session.stop(false);
    mux.destroy();
    loaded.flush();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...f,
    session,
    mux,
    loaded,
    path,
    denial,
    docker,
    nativeRead,
    requireCurrent,
    revoke: () => {
      current = false;
    },
    capture: () => f.engine.captureProviderView(f.row, requireCurrent),
  };
}
describe('actual saved Docker Session private attachment', () => {
  it.each(['forward', 'map'] as const)(
    'rejects malformed Docker environment %s before an actual observed viewer transport',
    async (mode) => {
      const f = await savedFixture(),
        view = await f.capture();
      const runs = vi.mocked(f.command.run).mock.calls.length,
        creates = vi.mocked(f.command.create).mock.calls.length;
      const options = {
        mode: 'claude' as const,
        docker: f.docker,
        sessionId: sid,
        createContext: {} as never,
        execEnv: {},
        execEnvNames: [] as string[],
        continuationView: view,
      };
      const key = 'CLAUDE_CODE_X;CONTROL_SENTINEL';
      expect(() =>
        buildDockerLaunchCommand({
          ...options,
          ...(mode === 'forward' ? { execEnvNames: [key] } : { execEnv: { [key]: 'bounded' } }),
        })
      ).toThrow('Invalid Docker environment name');
      expect(vi.mocked(f.command.run).mock.calls.length).toBe(runs);
      expect(vi.mocked(f.command.create).mock.calls.length).toBe(creates);
      expect(native.ptys).toEqual([]);
      expect(native.writes).toEqual([]);
      const command = buildDockerLaunchCommand({ ...options, execEnvNames: ['CLAUDE_CODE_TOKEN'] });
      expect(command).toContain('/opt/reverie-worker-client/bin/node');
      expect(command).not.toMatch(/new-session|respawn-pane/);
      expect(f.session.providerDispatchHeld).toBe(true);
    }
  );

  it('normal input reservation and readback use the actual private view without clearing dispatch denial', async () => {
    const f = await savedFixture(),
      service = new TerminalInputService();
    const current = () => {
      f.requireCurrent();
      return true;
    };
    const intent = { input: 'controlled private-view input', useMux: false, clientId: 'restored-browser', seq: 1 };
    const tag = { clientId: intent.clientId, seq: intent.seq, fingerprint: terminalInputFingerprint(intent) };
    expect(service.begin(f.session, intent, current).state).toBe('held');
    expect(service.inspect(f.session, tag, current)).toBe('held');
    const creates = vi.mocked(f.command.create).mock.calls.length;
    f.session.bindDockerContinuationView(await f.capture());
    await f.session.startInteractive();
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(f.session.providerInputHeld).toBe(false);
    expect(service.inspect(f.session, tag, current)).toBe('unknown');
    const input = service.begin(f.session, intent, current);
    expect(input.state).toBe('admitted');
    if (input.state !== 'admitted') throw Error('Expected original private-view input reservation');
    expect(service.inspect(f.session, tag, current)).toBe('pending');
    expect(input.operation.writeRaw()).toBe(true);
    expect(service.inspect(f.session, tag, current)).toBe('confirmed');
    expect(service.begin(f.session, intent, current).state).toBe('duplicate');
    expect(native.writes).toEqual([intent.input]);
    expect(vi.mocked(f.command.create).mock.calls.length).toBe(creates);
    expect(
      vi
        .mocked(f.command.run)
        .mock.calls.some(([args]) => args[0] === 'container' && ['start', 'restart'].includes(args[1]))
    ).toBe(false);
    f.loaded.flush();
    expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(f.denial);
    f.session.holdUnconfirmedInput(Error('controlled input response lost after original dispatch'));
    expect(service.begin(f.session, { ...intent, seq: 2 }, current).state).toBe('held');
    expect(service.inspect(f.session, tag, current)).toBe('held');
    expect(native.writes).toEqual([intent.input]);
    expect(f.session.providerDispatchHeld).toBe(true);
  });
  it('a saved input unknown stays held even with a current observed provider view', async () => {
    const f = await savedFixture(false, true),
      service = new TerminalInputService();
    f.session.bindDockerContinuationView(await f.capture());
    expect(f.session.providerInputHeld).toBe(false);
    expect(f.session.terminalInputHeld).toBe(true);
    const intent = { input: 'must remain unissued', clientId: 'saved-input', seq: 1 };
    expect(service.begin(f.session, intent, () => true).state).toBe('held');
    expect(
      service.inspect(
        f.session,
        { clientId: intent.clientId, seq: 1, fingerprint: terminalInputFingerprint(intent) },
        () => true
      )
    ).toBe('held');
    expect(native.writes).toEqual([]);
    expect(native.ptys).toEqual([]);
    expect(f.session.toPersistedState().terminalInputHeld).toBe(true);
  });
  it('DTOs and an overridden public input-hold getter cannot mint the private input subject', async () => {
    const f = await savedFixture(),
      service = new TerminalInputService();
    const intent = { input: 'must remain unissued', useMux: false, clientId: 'forged-input', seq: 1 };
    const tag = { clientId: intent.clientId, seq: 1, fingerprint: terminalInputFingerprint(intent) };
    const fake = {
      ...f.session.toState(),
      providerInputHeld: false,
      terminalInputHeld: false,
      captureInputAdmission: () => () => true,
    } as unknown as Session;
    expect(() => service.begin(fake, intent, () => true)).toThrow('Missing original input subject');
    expect(() => service.inspect(fake, tag, () => true)).toThrow('Missing original input subject');
    const prototype = Object.create(Session.prototype, { providerInputHeld: { value: false } });
    expect(() => service.begin(prototype, intent, () => true)).toThrow();
    Object.defineProperty(f.session, 'providerInputHeld', { value: false });
    const reserved = service.begin(f.session, intent, () => true);
    if (reserved.state === 'admitted') expect(reserved.operation.writeRaw()).toBe(false);
    else expect(reserved.state).toBe('held');
    expect(service.inspect(f.session, tag, () => true)).toBe('held');
    expect(native.writes).toEqual([]);
    expect(native.ptys).toEqual([]);
    expect(f.session.providerDispatchHeld).toBe(true);
  });
  it('attaches an Engine-observed existing provider without clearing its saved launch denial', async () => {
    const f = await savedFixture();
    const view = await f.capture();
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
    expect(f.session.providerInputHeld).toBe(true);
    f.session.bindDockerContinuationView(view);
    expect(f.session.dockerContinuationViewCurrent).toBe(true);
    expect(f.session.providerInputHeld).toBe(false);
    expect(f.session.toState().providerDispatchHoldKind).toBe('loaded-intent');
    const creations = vi.mocked(f.command.create).mock.calls.length;
    const transport = f.mux as unknown as {
      _createSession(options: CreateSessionOptions, mutation: unknown): Promise<MuxSession>;
    };
    const outer = transport._createSession.bind(f.mux);
    const capture = vi.spyOn(transport, '_createSession').mockImplementation(async (options, mutation) => {
      expect(options.dockerContinuationView).toBe(view);
      const command = buildDockerLaunchCommand({
        mode: 'claude',
        docker: f.docker,
        sessionId: sid,
        createContext: {} as never,
        execEnv: {},
        execEnvNames: [],
        canonicalCommand: 'MUST_NOT_LAUNCH_PROVIDER',
        continuationView: options.dockerContinuationView,
      });
      expect(command).toContain('/opt/reverie-worker-client/bin/node');
      expect(command).toContain('/opt/reverie-worker-tools/bin/tmux');
      expect(command).not.toContain('MUST_NOT_LAUNCH_PROVIDER');
      expect(command).not.toMatch(/new-session|respawn-pane/);
      return outer(options, mutation);
    });
    const thread = f.session.claudeSessionId;
    const chain = [...f.session.claudeSessionChain];
    await f.session.startInteractive();
    expect(f.session.claudeSessionId).toBe(thread);
    expect(f.session.claudeSessionChain).toEqual(chain);
    expect(f.session.claudeSessionIdPending).toBe(false);
    expect(capture).toHaveBeenCalledOnce();
    expect(f.session.providerDispatchHeld).toBe(true);
    f.loaded.flush();
    expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(f.denial);
    expect(vi.mocked(f.command.create).mock.calls.length).toBe(creations);
    expect(
      vi
        .mocked(f.command.run)
        .mock.calls.some(([args]) => args[0] === 'container' && ['start', 'restart'].includes(args[1]))
    ).toBe(false);
    expect(native.ptys).toHaveLength(1);
    expect(native.ptys.every((p) => p.file === process.execPath)).toBe(true);
  });
  it('retains an explicit saved unknown flag even with a genuine observed view', async () => {
    const f = await savedFixture(true),
      view = await f.capture();
    expect(() => f.session.bindDockerContinuationView(view)).toThrow('Original unopened Docker provider view required');
    await expect(f.session.startInteractive()).rejects.toThrow();
    expect(native.ptys).toEqual([]);
    expect(f.session.providerDispatchHeld).toBe(true);
    f.loaded.flush();
    expect(JSON.parse(readFileSync(f.path, 'utf8')).sessions[sid].providerDispatchHeld).toBe(true);
    expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(f.denial);
  });
  it('keeps a known-returned denial usable for another independently observed control restore', async () => {
    const f = await savedFixture(),
      view = await f.capture();
    f.session.bindDockerContinuationView(view);
    const thread = f.session.claudeSessionId,
      chain = [...f.session.claudeSessionChain];
    await f.session.startInteractive();
    expect(f.session.claudeSessionId).toBe(thread);
    expect(f.session.claudeSessionIdPending).toBe(false);
    const snapshot = f.session.toPersistedState();
    expect(snapshot.providerDispatchHeld).not.toBe(true);
    expect(snapshot).not.toHaveProperty('providerInputHeld');
    expect(snapshot).not.toHaveProperty('providerDispatchHoldKind');
    f.loaded.setSessionFromOwner(f.session, snapshot, 'preserve');
    f.loaded.flush();
    const again = new StateStore(f.path);
    const saved = again.getSession(sid)!;
    expect(saved.providerDispatchHeld).not.toBe(true);
    const restored = new Session({ ...saved, publicationStore: again, useMux: true, mux: new TmuxManager() });
    expect(restored.providerDispatchHeld).toBe(true);
    restored.bindDockerContinuationView(await f.capture());
    expect(restored.dockerContinuationViewCurrent).toBe(true);
    await restored.startInteractive();
    expect(restored.claudeSessionId).toBe(thread);
    expect(restored.claudeSessionChain).toEqual(chain);
    expect(restored.claudeSessionIdPending).toBe(false);
    expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(f.denial);
    await restored.stop(false);
  });
  it('keeps saved DATA and forged view methods from admitting an attach', async () => {
    const f = await savedFixture();
    await expect(f.session.startInteractive()).rejects.toThrow();
    expect(native.ptys).toEqual([]);
    const fake = Object.create(DockerEmployeeProviderView.prototype);
    const callback = vi.fn();
    Object.defineProperty(fake, 'require', { value: callback });
    expect(() => f.session.bindDockerContinuationView(fake)).toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(() =>
      f.session.bindDockerContinuationView({ descriptor: {} } as unknown as DockerEmployeeProviderView)
    ).toThrow();
    expect(f.session.providerDispatchHeld).toBe(true);
  });

  it.each(['stopped', 'missing', 'new-pid', 'changed-generation'] as const)(
    'refuses %s actual observer replies before any attachment',
    async (kind) => {
      const f = await savedFixture();
      if (kind === 'stopped') {
        f.observed.State.Running = false;
        f.observed.State.Pid = 0;
      }
      if (kind === 'changed-generation') f.row.request.sessionGeneration++;
      const run = vi.mocked(f.command.run).getMockImplementation()!;
      let nativeReads = 0;
      vi.mocked(f.command.run).mockImplementation(async (args, input) => {
        if (args[0] === 'exec') {
          if (kind === 'missing') throw Error('Controlled native provider is absent');
          nativeReads++;
          if (kind === 'new-pid' && nativeReads === 2) return JSON.stringify({ ...f.nativeRead, panePid: 42 }) + '\n';
        }
        return run(args, input);
      });
      await expect(f.capture()).rejects.toThrow();
      expect(native.ptys).toEqual([]);
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(f.session.providerDispatchHeld).toBe(true);
    }
  );
  it('refuses an actual view on a different saved destination without a provider effect', async () => {
    const f = await savedFixture(),
      view = await f.capture();
    const saved = f.loaded.getSession(sid)!;
    const other = new Session({
      ...saved,
      publicationStore: f.loaded,
      useMux: true,
      mux: f.mux,
      docker: { ...f.docker, containerName: 'f'.repeat(64) },
    });
    expect(() => other.bindDockerContinuationView(view)).toThrow();
    expect(native.ptys).toEqual([]);
    expect(other.providerDispatchHeld).toBe(true);
    await other.stop(false);
  });
  it.each(['foreign-owner', 'changed-model', 'changed-permission', 'changed-tools', 'native-progress'] as const)(
    'actual provider facade checks %s against the same canonical recipe and native process',
    async (mutation) => {
      const f = await savedFixture(),
        saved = f.loaded.getSession(sid)!;
      const companyFile = new CompanyStore(join(dirname(f.path), 'company.json'));
      await companyFile.init();
      const employee = EmployeeSchema.parse({
        id: eid,
        sessionId: sid,
        sessionGeneration: 3,
        name: 'Synthetic',
        icon: 'S',
        position: 'Employee',
        expertise: ['testing'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
      });
      await companyFile.update((state) => {
        state.employees = [employee];
      });
      const candidate = new Session({
        ...saved,
        publicationStore: f.loaded,
        useMux: true,
        mux: f.mux,
        ...(mutation === 'foreign-owner'
          ? { owner: 'foreign-owner' }
          : mutation === 'changed-model'
            ? { model: 'synthetic-different-model' }
            : mutation === 'changed-permission'
              ? { claudeMode: 'normal' as const }
              : mutation === 'changed-tools'
                ? { allowedTools: 'Read' }
                : { claudeSessionChain: ['70000000-0000-4000-8000-000000000007'] }),
      });
      cleanup.push(() => candidate.stop(false));
      const sessions = new Map([[sid, candidate]]);
      const company = new CompanyService(companyFile, {
        getSession: (id: string) => sessions.get(id),
        chatrooms: { rooms: () => [] },
        research: {},
      } as unknown as CompanyServiceDeps);
      const store = new CompanyDockerContinuationStore(company, (id) => f.loaded.getSession(id));
      f.row.sourceDigest = dockerEmployeeSourceDigest(employee, saved);
      const canonical = structuredClone(saved);
      const view = await f.capture();
      const add = vi.fn(),
        discard = vi.fn(),
        publish = vi.fn();
      const provider = new DockerEmployeeSessionProvider(
        store,
        {
          store: f.loaded,
          sessions,
          mux: f.mux,
          addSession: add,
          discardPartiallyBuiltSession: discard,
          reapplyPersistedSessionState: vi.fn(),
          setupSessionListeners: vi.fn(),
          persistSessionStateNow: publish,
        } as unknown as SessionPort & ConfigPort & Pick<InfraPort, 'mux'>,
        'http://boxed-office:3000'
      );
      const binding = {
        version: 1 as const,
        operationId: oid,
        credentialId: '40000000-0000-4000-8000-000000000004',
        sessionId: sid,
        sessionGeneration: 3,
        containerId: dest,
        imageId: target,
        originalDigest: dockerContinuationDigest(f.row.destination),
        policyDigest: dockerContinuationDigest(f.row.policy),
      };
      if (mutation === 'native-progress') {
        await provider.attach(f.row, binding, f.requireCurrent, view);
        expect(candidate.dockerContinuationViewCurrent).toBe(true);
        expect(candidate.providerInputHeld).toBe(false);
        expect(native.ptys).toHaveLength(1);
        expect(publish).toHaveBeenCalledOnce();
      } else {
        await expect(provider.attach(f.row, binding, f.requireCurrent, view)).rejects.toThrow(
          'Initial launch protocol changed before publication'
        );
        expect(publish).not.toHaveBeenCalled();
        expect(native.ptys).toEqual([]);
      }
      expect(add).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
      expect(candidate.providerDispatchHeld).toBe(true);
      expect(f.loaded.getSession(sid)).toEqual(canonical);
      f.loaded.flush();
      expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(f.denial);
    }
  );
  it('holds actual Session input and attachment when a bound view later loses currentness', async () => {
    const f = await savedFixture(),
      view = await f.capture();
    f.session.bindDockerContinuationView(view);
    expect(f.session.providerInputHeld).toBe(false);
    f.revoke();
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
    expect(f.session.providerInputHeld).toBe(true);
    await expect(f.session.startInteractive()).rejects.toThrow();
    expect(native.ptys).toEqual([]);
    expect(f.session.providerDispatchHeld).toBe(true);
    f.loaded.flush();
    expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(f.denial);
  });
  it('revokes the private view when its actual current domain changes', async () => {
    const f = await savedFixture(),
      view = await f.capture();
    f.revoke();
    expect(() => f.session.bindDockerContinuationView(view)).toThrow();
    expect(native.ptys).toEqual([]);
    expect(f.session.providerDispatchHeld).toBe(true);
  });
});

describe('in-place Docker existing-view renewal', () => {
  async function running(livePermissions: { claudeMode?: ClaudeMode; allowedTools?: string } = {}) {
    const f = await savedFixture(false, false, livePermissions),
      old = await f.capture();
    f.session.bindDockerContinuationView(old);
    await f.session.startInteractive();
    native.data.at(-1)!('retained terminal output');
    const before = {
      pid: f.session.pid,
      mux: f.mux.getSession(sid),
      buffer: f.session.terminalBuffer,
      intent: JSON.stringify(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]),
      ptys: native.ptys.length,
      writes: native.writes.length,
    };
    f.revoke();
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
    return { ...f, old, before };
  }
  async function runtimeFixture(livePermissions: { claudeMode?: ClaudeMode; allowedTools?: string } = {}) {
    const f = await running(livePermissions);
    const companyFile = new CompanyStore(join(dirname(f.path), 'company.json'));
    await companyFile.init();
    const employee = EmployeeSchema.parse({
      id: eid,
      sessionId: sid,
      sessionGeneration: 3,
      name: 'Synthetic',
      icon: 'S',
      position: 'Employee',
      expertise: ['testing'],
      createdAt: 1,
      onVacation: false,
      desiredRunning: true,
      dockerBinding: {
        version: 1,
        operationId: oid,
        credentialId: f.row.credentialId,
        sessionId: sid,
        sessionGeneration: 3,
        containerId: dest,
        imageId: target,
        originalDigest: dockerContinuationDigest(f.row.destination),
        policyDigest: dockerContinuationDigest(f.row.policy),
      },
    });
    // Explicit approved permission DATA for this fixture. The production serializer is intentionally unchanged.
    f.loaded.setSession(sid, {
      ...f.loaded.getSession(sid)!,
      claudeMode: 'normal',
      allowedTools: 'Read',
    } as SessionState);
    f.row.sourceDigest = dockerEmployeeSourceDigest(employee, f.loaded.getSession(sid)!);
    await companyFile.update((state) => {
      state.employees = [employee];
      state.dockerEmployeeContinuations = [f.row];
    });
    const sessions = new Map([[sid, f.session]]);
    const company = new CompanyService(companyFile, {
      getSession: (id: string) => sessions.get(id),
      chatrooms: { rooms: () => [] },
      research: {},
    } as unknown as CompanyServiceDeps);
    const configPath = join(dirname(f.path), 'boxed-runtime.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        purpose: 'reverie-boxed-runtime-v1',
        deployment: 'fixture',
        workerImageId: target,
        clientManifestDigest: '4'.repeat(64),
        sourceImageIds: [image],
        helperImageId: helper,
        apiUrl: 'http://synthetic.invalid:3000',
      }),
      { mode: 0o600 }
    );
    // The configuration filesystem port maps one fixed read to a real private fixture inode.
    // Its real fstat/read/retained-FD currency and the real key remain enforced.
    const open = vi.isMockFunction(fs.openSync) ? vi.mocked(fs.openSync).getMockImplementation()! : fs.openSync,
      lstat = vi.isMockFunction(fs.lstatSync) ? vi.mocked(fs.lstatSync).getMockImplementation()! : fs.lstatSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((name: fs.PathLike, flags: number, mode?: number) =>
      open(name === '/etc/reverie/boxed-runtime.json' ? configPath : name, flags, mode)) as typeof fs.openSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((name: fs.PathLike, options?: unknown) =>
      lstat(name === '/etc/reverie/boxed-runtime.json' ? configPath : name, options as never)) as typeof fs.lstatSync);
    vi.stubEnv('REVERIE_RUNTIME_BACKEND', 'boxed-docker-v1');
    vi.stubEnv('REVERIE_WORKER_SOCKET', undefined);
    vi.stubEnv('REVERIE_WORKER_VIEWER_SOCKET', undefined);
    const runtime = openDockerEmployeeRuntime(join(dirname(f.path), 'runtime-key'))!;
    cleanup.push(async () => runtime.close());
    const capture = DockerEmployeeEngine.prototype.captureProviderView;
    // Runtime's actual composition uses the same real Engine implementation over
    // this controlled physical port; no fabricated view or readiness proof enters it.
    const captured = vi
      .spyOn(DockerEmployeeEngine.prototype, 'captureProviderView')
      .mockImplementation((row, current) => capture.call(f.engine, row, current));
    vi.spyOn(DockerEmployeeEngine.prototype, 'observeDestination').mockResolvedValue({
      state: 'running',
      provider: { kind: 'running', operationId: oid, sessionId: sid },
      resources: f.policy,
    } as Awaited<ReturnType<DockerEmployeeEngine['observeDestination']>>);
    const attach = vi
      .spyOn(DockerEmployeeSessionProvider.prototype, 'attach')
      .mockRejectedValue(Error('Unexpected provider attach'));
    runtime.attach(company, { sessions, store: f.loaded, mux: f.mux } as unknown as SessionPort &
      ConfigPort &
      InfraPort);
    return { ...f, employee, company, companyFile, sessions, runtime, captured, attach };
  }
  async function sessionWire(f: Awaited<ReturnType<typeof runtimeFixture>>) {
    const { app } = await createRouteTestHarness((app, ctx) => {
      ctx.sessions = f.sessions;
      ctx.store = f.loaded;
      ctx.getSessionStateWithRespawn = (session: Session) => session.toLightDetailedState();
      registerSessionRoutes(app, ctx);
    });
    cleanup.push(() => app.close());
    return async () => {
      const response = await app.inject({ method: 'GET', url: '/api/sessions/' + sid });
      expect(response.statusCode).toBe(200);
      const wire: SessionState = response.json();
      expect(wire.id).toBe(sid);
      return wire;
    };
  }
  it('recomputes Docker view currency instead of adopting a forged saved observation', async () => {
    const f = await savedFixture();
    expect(f.session.toState().dockerProviderViewCurrent).toBe(false);
    const saved = f.loaded.getSession(sid)!;
    f.loaded.setSession(sid, { ...saved, dockerProviderViewCurrent: true });
    f.loaded.flush();
    const reloaded = new StateStore(f.path),
      raw = reloaded.getSession(sid)!;
    expect(raw.dockerProviderViewCurrent).toBe(true); // Untrusted historical DATA only.
    const restored = new Session({ ...raw, publicationStore: reloaded, useMux: true, mux: f.mux });
    cleanup.push(() => restored.stop(false));
    const wire = JSON.parse(JSON.stringify(restored.toState()));
    expect(wire.dockerProviderViewCurrent).toBe(false);
    expect(restored.dockerContinuationViewCurrent).toBe(false);
    expect(restored.toPersistedState()).not.toHaveProperty('dockerProviderViewCurrent');
    expect(restored.providerDispatchHeld).toBe(true);
    expect(restored.pid).toBeNull();
  });
  it.each(['local', 'ordinary-docker'] as const)(
    'omits the retained-view diagnostic for %s placement',
    async (placement) => {
      const f = await savedFixture();
      const saved: SessionState = {
        ...f.loaded.getSession(sid)!,
        dockerProviderViewCurrent: true,
        docker: placement === 'local' ? undefined : { ...f.docker, continuation: undefined },
      };
      const restored = new Session({ ...saved });
      cleanup.push(() => restored.stop(false));
      expect(restored.toState()).not.toHaveProperty('dockerProviderViewCurrent');
      expect(JSON.parse(JSON.stringify(restored.toState()))).not.toHaveProperty('dockerProviderViewCurrent');
      expect(restored.toPersistedState()).not.toHaveProperty('dockerProviderViewCurrent');
    }
  );
  it('repairs a naturally exited actual Docker Session viewer whose old private view was revoked', async () => {
    installViewerCustody();
    const f = await runtimeFixture();
    let admitted = true;
    const readWire = await sessionWire(f);
    f.attach.mockRestore(); // Exercise the actual existing Session/provider binding boundary.
    expect(f.session.docker?.continuation).toBeDefined();
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
    expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(false);
    const before = { ptys: native.ptys.length, writes: [...native.writes], intent: f.before.intent };
    native.exits.at(-1)!({ exitCode: 1, signal: 0 }); // Actual public PTY exit callback, no Session field mutation.
    expect(f.session.pid).toBeNull();
    const pane = f.mux.getSession(sid)!;
    vi.spyOn(f.mux, 'readPaneLiveness').mockResolvedValue({ state: 'live', pid: pane.pid });
    const creates = vi.mocked(f.command.create).mock.calls.length,
      configures = vi.mocked(f.resources.configure).mock.calls.length;
    await expect(
      f.runtime.reconnectViewer(eid, { sessionId: sid, sessionGeneration: 3 }, undefined, () => admitted)
    ).resolves.toBe('connected');
    expect(native.ptys).toHaveLength(before.ptys + 1);
    expect(native.writes).toEqual(before.writes);
    expect(vi.mocked(f.command.create).mock.calls.length).toBe(creates);
    expect(vi.mocked(f.resources.configure).mock.calls.length).toBe(configures);
    expect(JSON.stringify(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY])).toBe(before.intent);
    admitted = false;
    expect((await readWire()).dockerProviderViewCurrent).toBe(true);
    expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(true);
    expect(f.session.toPersistedState()).not.toHaveProperty('dockerProviderViewCurrent');
    const now = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 30_000);
    expect(f.session.dockerContinuationViewCurrent).toBe(true);
    expect((await readWire()).dockerProviderViewCurrent).toBe(true);
    expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(true);
  });
  it.each(['pid', 'command', 'birth', 'socket', 'restored-row'] as const)(
    'fresh genuine Engine proof cannot adopt changed outer %s before attaching any website client',
    async (fault) => {
      const recorder = installViewerCustody(),
        f = await runtimeFixture();
      native.exits.at(-1)!({ exitCode: 1, signal: 0 });
      const pane = f.mux.getSession(sid)!,
        count = native.ptys.length,
        writes = [...native.writes];
      const originalPid = pane.pid;
      const raw = recorder.data(originalPid);
      if (fault === 'pid') pane.pid++;
      if (fault === 'command') raw.cmdline = Buffer.from('/bin/bash\0-c\0unrelated command\0');
      if (fault === 'birth') raw.statAfter = raw.stat = recordedDockerViewerStat(originalPid, 500000, '999999');
      if (fault === 'socket')
        recorder.socket(recorder.issued.find((item) => item.row === pane)!.socketPath).stat.ino = '999999';
      if (fault === 'restored-row') f.mux.registerSession(structuredClone(pane));
      vi.spyOn(f.mux, 'readPaneLiveness').mockResolvedValue({ state: 'live', pid: pane.pid });
      await expect(
        f.runtime.reconnectViewer(eid, { sessionId: sid, sessionGeneration: 3 }, undefined, () => true)
      ).resolves.not.toBe('connected');
      expect(native.ptys).toHaveLength(count);
      expect(native.writes).toEqual(writes);
      expect(f.session.pid).toBeNull();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
    }
  );
  it.each(['missing', 'readable-data'] as const)(
    'fresh native provider and outer proofs cannot promote a %s website client capture',
    async (fault) => {
      installViewerCustody();
      const f = await runtimeFixture();
      native.exits.at(-1)!({ exitCode: 1, signal: 0 });
      const pane = f.mux.getSession(sid)!,
        count = native.ptys.length,
        writes = [...native.writes];
      vi.spyOn(f.mux, 'readPaneLiveness').mockResolvedValue({ state: 'live', pid: pane.pid });
      vi.spyOn(DockerPlanLocalClient, 'capture').mockImplementation(() => {
        if (fault === 'missing') throw Error('Actual client capture unavailable');
        return Object.freeze({
          serverPid: 500000,
          socketPath: recordedDockerViewerSocketPath(f.mux.muxSocket),
        }) as unknown as DockerPlanLocalClient;
      });
      await expect(
        f.runtime.reconnectViewer(eid, { sessionId: sid, sessionGeneration: 3 }, undefined, () => true)
      ).resolves.toBe('unconfirmed');
      expect(native.ptys).toHaveLength(count + 1);
      expect(native.writes).toEqual(writes);
      expect(f.session.viewerInputHeld).toBe(true);
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
    }
  );
  it.each(['server', 'socket'] as const)(
    'a restored original endpoint cannot confirm a new website client connected to another %s',
    async (fault) => {
      let replacing = false;
      installViewerCustody((client) => {
        if (!replacing) return;
        if (fault === 'server') client.connectedServerPid = 500001;
        else client.connectedSocketPath += '-other';
      });
      const f = await runtimeFixture();
      replacing = true;
      native.exits.at(-1)!({ exitCode: 1, signal: 0 });
      const pane = f.mux.getSession(sid)!,
        count = native.ptys.length,
        writes = [...native.writes];
      vi.spyOn(f.mux, 'readPaneLiveness').mockResolvedValue({ state: 'live', pid: pane.pid });
      await expect(
        f.runtime.reconnectViewer(eid, { sessionId: sid, sessionGeneration: 3 }, undefined, () => true)
      ).resolves.toBe('unconfirmed');
      expect(native.ptys).toHaveLength(count + 1);
      expect(native.writes).toEqual(writes);
      expect(f.session.viewerInputHeld).toBe(true);
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
    }
  );
  it('an unretained dead-pane attachment receipt stays held without later adoption or another attachment', async () => {
    const recorder = installViewerCustody(),
      f = await runtimeFixture();
    native.exits.at(-1)!({ exitCode: 1, signal: 0 });
    const pane = f.mux.getSession(sid)!,
      originalPid = pane.pid,
      ptys = native.ptys.length;
    recorder.remove(originalPid);
    const read = vi
      .spyOn(f.mux, 'readPaneLiveness')
      .mockImplementation(async () =>
        pane.pid === originalPid ? { state: 'dead' } : { state: 'live', pid: pane.pid }
      );
    const capture = DockerViewerPane.capture;
    vi.spyOn(DockerViewerPane, 'capture').mockImplementation((...args) => {
      capture(...args); // Earn the real factory proof from recorded native reads, then lose its retained receipt.
      return undefined;
    });
    const respawn = vi.spyOn(f.mux, 'respawnPane');
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        f.runtime.reconnectViewer(eid, { sessionId: sid, sessionGeneration: 3 }, undefined, () => true)
      ).resolves.toBe('unconfirmed');
    expect(read).toHaveBeenCalledOnce();
    expect(respawn).toHaveBeenCalledOnce();
    expect(recorder.issued.at(-1)!.command.argv).toContain('attach');
    expect(recorder.issued.at(-1)!.command.argv).not.toContain('sh');
    expect(native.ptys).toHaveLength(ptys);
    expect(f.session.viewerInputHeld).toBe(true);
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
  });
  it.each(['completed', 'grant-revoked-at-final-view'] as const)(
    'a genuinely current healthy boxed teammate uses the noMUX CLI and real HTTP API: %s',
    async (resultKind) => {
      installViewerCustody();
      const f = await runtimeFixture();
      const readWire = await sessionWire(f);
      const targetToken = f.runtime.authentication.issue(
        { ...f.employee.dockerBinding!, employeeId: eid, owner: undefined },
        () => true
      );
      const targetRequest = { headers: { 'x-reverie-worker-identity': targetToken, 'x-reverie-parent-session': sid } };
      native.exits.at(-1)!({ exitCode: 1, signal: 0 });
      expect(f.session.pid).toBeNull();
      expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(false);
      expect((await readWire()).dockerProviderViewCurrent).toBe(false);
      expect(f.runtime.authentication.capture(targetRequest)).toBeUndefined(); // Self admission is still held while its viewer is lost.
      const targetIntent = JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[sid];
      const actorId = '80000000-0000-4000-8000-000000000008',
        actorSid = '90000000-0000-4000-8000-000000000009';
      const actorOperation = 'a0000000-0000-4000-8000-00000000000a',
        actorCredential = 'b0000000-0000-4000-8000-00000000000b';
      const actorDocker = structuredClone(f.docker);
      actorDocker.containerName = 'e'.repeat(64);
      Object.assign(actorDocker.continuation!, { operationId: actorOperation, employeeId: actorId });
      const row = structuredClone(f.row);
      row.employeeId = actorId;
      row.credentialId = actorCredential;
      Object.assign(row.request, { operationId: actorOperation, sessionId: actorSid, containerId: 'c'.repeat(64) });
      Object.assign(row.original, { employeeId: actorId, sessionId: actorSid, containerId: 'c'.repeat(64) });
      Object.assign(row.destination!, {
        employeeId: actorId,
        sessionId: actorSid,
        containerId: actorDocker.containerName,
      });
      const binding = {
        ...f.employee.dockerBinding!,
        operationId: actorOperation,
        credentialId: actorCredential,
        sessionId: actorSid,
        containerId: actorDocker.containerName,
        originalDigest: dockerContinuationDigest(row.destination),
      };
      const actor = new Session({
        ...f.loaded.getSession(sid)!,
        id: actorSid,
        name: 'Healthy coordinator',
        docker: actorDocker,
        publicationStore: f.loaded,
        useMux: true,
        mux: f.mux,
        providerDispatchHeld: false,
        terminalInputHeld: false,
      });
      cleanup.push(() => actor.stop(false));
      f.sessions.set(actorSid, actor);
      const launch = captureDockerEmployeeProviderLaunch(actor, binding, () => {});
      actor.bindDockerContinuationLaunch(launch);
      // The recording Manager now uses the same real one-shot boxed renderer as production.
      await actor.startInteractive();
      expect(actor.pid).not.toBeNull();
      expect(actor.providerDispatchHeld).toBe(false);
      const employee = EmployeeSchema.parse({
        ...f.employee,
        id: actorId,
        sessionId: actorSid,
        name: 'Healthy coordinator',
        permissions: { recoverEmployees: true },
        dockerBinding: binding,
      });
      f.loaded.setSession(actorSid, actor.toPersistedState());
      row.sourceDigest = dockerEmployeeSourceDigest(employee, f.loaded.getSession(actorSid)!);
      await f.companyFile.update((state) => {
        state.employees.push(employee);
        state.dockerEmployeeContinuations!.push(row);
      });
      const credential = join(dirname(f.path), 'coordinator-identity');
      const token = f.runtime.authentication.issue({ ...binding, employeeId: actorId, owner: undefined }, () => true);
      fs.writeFileSync(credential, token + '\n', { mode: 0o600 });
      const before = {
        creates: vi.mocked(f.command.create).mock.calls.length,
        configures: vi.mocked(f.resources.configure).mock.calls.length,
        ptys: native.ptys.length,
        writes: [...native.writes],
      };
      const pane = f.mux.getSession(sid)!;
      vi.spyOn(f.mux, 'readPaneLiveness').mockResolvedValue({ state: 'live', pid: pane.pid });
      let viewReads = 0;
      if (resultKind === 'grant-revoked-at-final-view') {
        const capture = f.captured.getMockImplementation()!;
        f.captured.mockImplementation(async (...args) => {
          const view = await capture(...args);
          if (++viewReads === 2)
            await f.company.update(actorId, undefined, { permissions: { recoverEmployees: false } }, () => {});
          return view;
        });
      }
      const app = Fastify();
      cleanup.push(() => app.close());
      const requests: string[] = [];
      app.addHook('onRequest', async (req) => {
        requests.push(`${req.method} ${req.url}`);
      });
      registerDockerWorkerIdentity(app, f.runtime.authentication, '', { requireMachineProof: true });
      app.get('/api/company', (req) => {
        expect(dockerWorkerIdentityOf(req)?.employeeId).toBe(actorId);
        return { success: true, data: f.company.view(undefined) };
      });
      const controller = new WorkerViewerReconnect({
        company: f.company,
        session: (id) => f.sessions.get(id),
        ready: () => true,
        providerHealthy: () => true,
        moveGuard: async () => () => true,
        pause: () => () => {},
        publish: () => {},
        dockerReconnect: (target, allowed, revalidate) =>
          f.runtime.reconnectViewer(
            target.id,
            { sessionId: target.sessionId, sessionGeneration: target.sessionGeneration },
            target.owner,
            allowed,
            revalidate
          ),
      });
      registerWorkerViewerReconnect(app, controller, () => false);
      await app.listen({ host: '127.0.0.1', port: 0 });
      // The server's fixed configuration and the employee CLI have different
      // process environments in production. Preserve that boundary here as well.
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        REVERIE_SESSION_ID: actorSid,
        REVERIE_WORKER_IDENTITY_FILE: credential,
        REVERIE_API_URL: 'http://127.0.0.1:' + (app.server.address() as { port: number }).port,
      };
      delete childEnv.REVERIE_MUX;
      delete childEnv.VITEST; // The child exercises the production CLI path, independently of the recording server ports.
      const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const result = await new Promise<{
        code: number | null;
        transportCode: string | null;
        killed: boolean;
        signal: string | null;
        phase: 'bootstrap' | 'executing' | 'parsed';
        stdout: string;
        stderrBytes: number;
      }>((resolve) => {
        actualProcess.execFile(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            'import {Command} from "commander"; import {registerAgentCommands} from "./src/cli-agent.ts"; console.error("VIEWER_CLI_READY"); const p=new Command(); registerAgentCommands(p); await p.parseAsync(process.argv.slice(1),{from:"user"}); console.error("VIEWER_CLI_PARSED");',
            'agent',
            'reconnect-viewer',
            eid,
            '--json',
          ],
          { env: childEnv, timeout: VIEWER_CLI_CHILD_MS, maxBuffer: 65536 },
          (error, stdout, stderr) => {
            resolve({
              code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
              transportCode: typeof error?.code === 'string' ? error.code : null,
              killed: error?.killed === true,
              signal: error?.signal ?? null,
              phase: stderr.includes('VIEWER_CLI_PARSED\n')
                ? 'parsed'
                : stderr.includes('VIEWER_CLI_READY\n')
                  ? 'executing'
                  : 'bootstrap',
              stdout,
              stderrBytes: Buffer.byteLength(stderr),
            });
          }
        );
      });
      const { stdout: _stdout, ...diagnostic } = result;
      expect(result.code, JSON.stringify(diagnostic)).toBe(resultKind === 'completed' ? EXIT.ok : EXIT.refused);
      expect(result.phase).toBe('parsed');
      expect(result.killed).toBe(false);
      expect(requests).toEqual(['GET /api/company', `POST /api/company/employees/${eid}/reconnect`]);
      expect(f.sessions.get(sid)).toBe(f.session);
      expect(native.ptys).toHaveLength(before.ptys + 1);
      expect(native.writes).toEqual(before.writes);
      expect(vi.mocked(f.command.create).mock.calls.length).toBe(before.creates);
      expect(vi.mocked(f.resources.configure).mock.calls.length).toBe(before.configures);
      expect(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[sid]).toEqual(targetIntent);
      if (resultKind === 'grant-revoked-at-final-view') {
        expect(viewReads).toBe(2);
        expect(f.session.viewerInputHeld).toBe(true);
        expect(f.session.dockerContinuationViewCurrent).toBe(false);
        expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(false);
        expect((await readWire()).dockerProviderViewCurrent).toBe(false);
        return;
      }
      expect(JSON.parse(result.stdout)).toMatchObject({ state: 'viewer-connected' });
      expect(f.session.dockerContinuationViewCurrent).toBe(true); // Controller finally already closed move/claim leases.
      expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(true);
      expect((await readWire()).dockerProviderViewCurrent).toBe(true);
      expect(f.session.toPersistedState()).not.toHaveProperty('dockerProviderViewCurrent');
      const targetIdentity = f.runtime.authentication.capture(targetRequest);
      expect(targetIdentity?.current()).toBe(true);
      await f.company.update(actorId, undefined, { permissions: { recoverEmployees: false } }, () => {});
      expect(f.session.dockerContinuationViewCurrent).toBe(true); // Repairer authority never owns target transport lifetime.
      expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(true);
      expect((await readWire()).dockerProviderViewCurrent).toBe(true);
      const now = performance.now.bind(performance);
      vi.spyOn(performance, 'now').mockImplementation(() => now() + 30_000);
      expect(f.session.dockerContinuationViewCurrent).toBe(true); // One-shot 25s admission is no longer a transport lifetime.
      expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(true);
      expect((await readWire()).dockerProviderViewCurrent).toBe(true);
      expect(targetIdentity?.current()).toBe(true);
      await f.companyFile.update((state) => {
        state.employees.find((value) => value.id === eid)!.sessionGeneration++;
      });
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(JSON.parse(JSON.stringify(f.session.toState())).dockerProviderViewCurrent).toBe(false);
      expect((await readWire()).dockerProviderViewCurrent).toBe(false);
      expect(targetIdentity?.current()).toBe(false);
    },
    VIEWER_CLI_TEST_MS
  );
  it('actual Runtime.wake renews a revoked same-provider view after caller lease completion without another attach', async () => {
    const f = await runtimeFixture();
    let allowed = true;
    await f.companyFile.update((state) => {
      state.employees[0]!.wakeAttempts = [Date.now()];
    });
    await expect(f.runtime.wake(f.employee, () => allowed)).resolves.toBe(true);
    // Finishing the one-shot office request must not revoke the published viewer.
    allowed = false;
    expect(f.captured).toHaveBeenCalledOnce();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.sessions.get(sid)).toBe(f.session);
    expect(f.session.pid).toBe(f.before.pid);
    expect(f.session.dockerContinuationViewCurrent).toBe(true);
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(f.session.terminalBuffer).toBe(f.before.buffer);
    expect(native.ptys).toHaveLength(f.before.ptys);
    expect(native.writes).toHaveLength(f.before.writes);
    expect(JSON.stringify(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY])).toBe(f.before.intent);
    expect(() => DockerEmployeeProviderView.prototype.require.call(f.old, sid, f.docker)).toThrow();
  });
  it('a lease failure after renewing the candidate poisons that new viewer permanently', async () => {
    const f = await runtimeFixture();
    let allowed = true;
    const renew = Session.prototype.renewDockerContinuationView;
    vi.spyOn(Session.prototype, 'renewDockerContinuationView').mockImplementation(function (this: Session, ...args) {
      renew.apply(this, args);
      allowed = false;
    });
    await expect(f.runtime.wake(f.employee, () => allowed)).rejects.toThrow();
    allowed = true;
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(f.session.pid).toBe(f.before.pid);
    expect(native.ptys).toHaveLength(f.before.ptys);
    expect(native.writes).toHaveLength(f.before.writes);
    expect(JSON.stringify(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY])).toBe(f.before.intent);
  });
  it.each(['account', 'mode', 'grant', 'session-replaced'] as const)(
    'actual Runtime.wake refuses %s drift during fresh capture',
    async (kind) => {
      const f = await runtimeFixture();
      let allowed = true;
      const capture = f.captured.getMockImplementation()!;
      f.captured.mockImplementation(async (row, current) => {
        const view = await capture(row, current);
        if (kind === 'account')
          f.session.subscriptionProfile = { id: 'changed', label: 'Changed', provider: 'anthropic' };
        if (kind === 'mode') vi.spyOn(f.session, 'mode', 'get').mockReturnValue('codex');
        if (kind === 'grant') allowed = false;
        if (kind === 'session-replaced') f.sessions.delete(sid);
        return view;
      });
      await expect(f.runtime.wake(f.employee, () => allowed)).rejects.toThrow();
      expect(f.attach).not.toHaveBeenCalled();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(native.ptys).toHaveLength(f.before.ptys);
      expect(native.writes).toHaveLength(f.before.writes);
    }
  );
  it.each(['claudeMode', 'allowedTools'] as const)(
    'actual Runtime.wake refuses preexisting %s permission drift',
    async (field) => {
      const f = await runtimeFixture(
        field === 'claudeMode' ? { claudeMode: 'dangerously-skip-permissions' } : { allowedTools: 'Read,Write' }
      );
      await expect(f.runtime.wake(f.employee, () => true)).rejects.toThrow();
      expect(f.captured).not.toHaveBeenCalled();
      expect(f.attach).not.toHaveBeenCalled();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(native.ptys).toHaveLength(f.before.ptys);
      expect(native.writes).toHaveLength(f.before.writes);
    }
  );
  it.each(['claudeMode', 'allowedTools'] as const)(
    'actual Runtime.wake refuses awaited %s permission drift',
    async (field) => {
      const f = await runtimeFixture(),
        capture = f.captured.getMockImplementation()!;
      f.captured.mockImplementation(async (row, current) => {
        const view = await capture(row, current);
        // Simulate configuration drift on this controlled Session, never a proof/denial flag or a live worker.
        Reflect.set(
          f.session,
          field === 'claudeMode' ? '_claudeMode' : '_allowedTools',
          field === 'claudeMode' ? 'dangerously-skip-permissions' : 'Read,Write'
        );
        return view;
      });
      await expect(f.runtime.wake(f.employee, () => true)).rejects.toThrow();
      expect(f.attach).not.toHaveBeenCalled();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(native.ptys).toHaveLength(f.before.ptys);
      expect(native.writes).toHaveLength(f.before.writes);
    }
  );
  it('covers exactly the complete owning fingerprint field inventory', async () => {
    const f = await running();
    expect(Object.keys(f.session.providerRecipeState()).sort()).toEqual(
      [...DOCKER_EMPLOYEE_PROVIDER_RECIPE_FIELDS].sort()
    );
  });
  it('projects the same persisted recipe without consulting a view callback', async () => {
    const f = await running(),
      persisted = f.session.toPersistedState(),
      data = f.session.providerRecipeState();
    for (const [key, value] of Object.entries(data)) {
      if (key === 'claudeMode') expect(value).toBe(f.session.claudeMode);
      else if (key === 'allowedTools') expect(value).toBe(f.session.allowedTools);
      else expect(value).toEqual((persisted as unknown as Record<string, unknown>)[key]);
    }
  });
  it('replaces only the stale view with fresh same-provider proof, preserving transport/output/unsent input and paid intent', async () => {
    const f = await running(),
      inputs = new TerminalInputService(),
      fresh = await f.engine.captureProviderView(f.row, () => {});
    const unsent = { input: 'unsent owner draft', useMux: false, clientId: 'view-renewal', seq: 1 };
    const tag = { clientId: unsent.clientId, seq: unsent.seq, fingerprint: terminalInputFingerprint(unsent) };
    expect(inputs.begin(f.session, unsent, () => true).state).toBe('held');
    f.session.renewDockerContinuationView(fresh, () => true);
    expect(f.session.dockerContinuationViewCurrent).toBe(true);
    expect(f.session.pid).toBe(f.before.pid);
    expect(f.mux.getSession(sid)).toBe(f.before.mux);
    expect(f.session.terminalBuffer).toBe(f.before.buffer);
    expect(f.before.buffer).toContain('retained terminal output');
    expect(JSON.stringify(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY])).toBe(f.before.intent);
    expect(f.session.providerDispatchHeld).toBe(true);
    expect(f.session.providerInputHeld).toBe(false);
    expect(native.ptys).toHaveLength(f.before.ptys);
    expect(native.writes).toHaveLength(f.before.writes);
    expect(inputs.inspect(f.session, tag, () => true)).toBe('unknown');
    expect(() => DockerEmployeeProviderView.prototype.require.call(f.old, sid, f.docker)).toThrow();
  });
  it.each(['paneId', 'panePid', 'paneStartTicks', 'hookGeneration'] as const)(
    'refuses fresh genuine changed %s without reviving the old view',
    async (field) => {
      const f = await running();
      if (field === 'panePid') f.nativeRead.panePid++;
      else if (field === 'paneId') f.nativeRead.paneId = '%2';
      else if (field === 'paneStartTicks') f.nativeRead.paneStartTicks = '12346';
      else f.nativeRead.hooks.generation += 'changed';
      const fresh = await f.engine.captureProviderView(f.row, () => {});
      expect(() => f.session.renewDockerContinuationView(fresh, () => true)).toThrow();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(native.ptys).toHaveLength(f.before.ptys);
      expect(native.writes).toHaveLength(f.before.writes);
    }
  );
  it.each(['container', 'image', 'operation', 'generation', 'employee', 'client-manifest'] as const)(
    'refuses changed Session %s correlation against a fresh genuine view',
    async (kind) => {
      const f = await running(),
        fresh = await f.engine.captureProviderView(f.row, () => {}),
        docker = f.session.docker!;
      if (kind === 'container') docker.containerName = 'e'.repeat(64);
      if (kind === 'image') docker.image = 'sha256:' + 'e'.repeat(64);
      if (kind === 'operation') docker.continuation!.operationId = '90000000-0000-4000-8000-000000000009';
      if (kind === 'generation') docker.continuation!.sessionGeneration++;
      if (kind === 'employee') docker.continuation!.employeeId = '90000000-0000-4000-8000-000000000009';
      if (kind === 'client-manifest') docker.continuation!.clientManifestDigest = 'e'.repeat(64);
      expect(() => f.session.renewDockerContinuationView(fresh, () => true)).toThrow();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(native.ptys).toHaveLength(f.before.ptys);
    }
  );
  it('refuses a prototype/DTO view without invoking its supplied authority', async () => {
    const f = await running(),
      claimed = vi.fn(),
      forged = Object.create(DockerEmployeeProviderView.prototype, { require: { value: claimed } });
    expect(() => f.session.renewDockerContinuationView(forged, () => true)).toThrow();
    expect(claimed).not.toHaveBeenCalled();
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
  });
  it.each(['account', 'revoked-view', 'revoked-grant', 'closing', 'stopped', 'transport-exit'] as const)(
    'holds %s without changing the Session or launch fence',
    async (kind) => {
      const f = await running();
      let current = true;
      const fresh = await f.engine.captureProviderView(f.row, () => {
        if (!current) throw Error('Fresh view revoked');
      });
      const selected = f.session.subscriptionProfile;
      if (kind === 'account')
        f.session.subscriptionProfile = { id: 'changed-account', label: 'Changed', provider: 'anthropic' };
      if (kind === 'revoked-view') current = false;
      if (kind === 'closing') f.session.markClosing(true);
      if (kind === 'stopped') await f.session.stop(false);
      if (kind === 'transport-exit') native.exits.at(-1)!({ exitCode: 0, signal: 0 });
      expect(() =>
        f.session.renewDockerContinuationView(
          fresh,
          () => kind !== 'revoked-grant' && f.session.subscriptionProfile === selected
        )
      ).toThrow();
      expect(f.session.dockerContinuationViewCurrent).toBe(false);
      expect(JSON.stringify(JSON.parse(readFileSync(f.path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY])).toBe(f.before.intent);
    }
  );
});
