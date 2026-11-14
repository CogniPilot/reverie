import { DOCKER_EMPLOYEE_PROVIDER_RECIPE_FIELDS } from '../src/docker-employee-provider-recipe.js';
import type { ClaudeMode } from '../src/types.js';
/** Actual private Engine capture over controlled OS replies, real saved StateStore
 * and Session. No installed/native/provider acceptance; no view/receipt DTO grant. */
import fs from 'node:fs';
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
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type { DockerContinuationTaskJournal } from '../src/docker-continuation-task.js';
const cid = 'a'.repeat(64),
  dest = 'd'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  target = 'sha256:' + 'c'.repeat(64),
  helper = 'sha256:' + 'f'.repeat(64);
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
    let exit: ((value: { exitCode: number; signal: number }) => void) | undefined;
    return {
      pid: 2147483647,
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
      onExit: (fn: typeof exit) => {
        exit = fn;
        if (fn) native.exits.push(fn);
        return { dispose: () => {} };
      },
      kill: () => exit?.({ exitCode: 0, signal: 0 }),
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
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
  native.ptys.length = 0;
  native.writes.length = 0;
  native.data.length = 0;
  native.exits.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function savedFixture(
  explicitUnknown = false,
  savedInputUnknown = false,
  livePermissions: { claudeMode?: ClaudeMode; allowedTools?: string } = {}
) {
  const f = await dockerEncodedDestination();
  f.observed.State.Running = true;
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
      if (kind === 'stopped') f.observed.State.Running = false;
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
    const open = fs.openSync,
      lstat = fs.lstatSync;
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
    return { ...f, employee, companyFile, sessions, runtime, captured, attach };
  }
  it('actual Runtime.wake renews a revoked same-provider view after unrelated wake bookkeeping without another attach', async () => {
    const f = await runtimeFixture();
    await f.companyFile.update((state) => {
      state.employees[0]!.wakeAttempts = [Date.now()];
    });
    await expect(f.runtime.wake(f.employee, () => true)).resolves.toBe(true);
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
