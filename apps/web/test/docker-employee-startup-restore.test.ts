/** Real startup, StateStore/CompanyStore and boxed Runtime; only Docker and PTY
 * physical I/O are controlled. No native/installed/provider acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { runBoxedStartupNamespace } from './fixtures/boxed-webserver-startup.js';
import type { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type { DockerContinuationTask, DockerContinuationTaskRole } from '../src/docker-continuation-task.js';

const eid = '11111111-1111-4111-8111-111111111111';
const sid = '22222222-2222-4222-8222-222222222222';
const oid = '33333333-3333-4333-8333-333333333333';
const thread = '44444444-4444-4444-8444-444444444444';
const sourceId = '1'.repeat(64),
  destinationId = '2'.repeat(64);
const target = 'sha256:' + 'a'.repeat(64),
  sourceImage = 'sha256:' + 'c'.repeat(64);
const helper = 'sha256:' + 'd'.repeat(64),
  manifest = 'b'.repeat(64);
const deployment = 'synthetic-startup';
const pane = {
  paneId: '%1',
  panePid: 41,
  paneStartTicks: '12345',
  hooks: { kind: 'generation', generation: 'synthetic-startup-hook' },
};
interface PhysicalMount {
  Type: string;
  Source: string;
  Target: string;
  ReadOnly?: boolean;
}
interface PhysicalHost {
  PidMode?: string;
  Binds?: string[];
  Mounts?: PhysicalMount[];
  [key: string]: unknown;
}
interface PhysicalConfig {
  Labels?: Record<string, string> | null;
  [key: string]: unknown;
}
interface Raw {
  Id: string;
  Image: string;
  Config: PhysicalConfig;
  HostConfig: PhysicalHost;
  Mounts: unknown[];
  State: {
    Status?: string;
    Running: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    Dead?: boolean;
    OOMKilled?: boolean;
    Pid?: number;
    ExitCode?: number;
  };
}
const noop = () => {};
const file = '/fixture/protocol.json';

class PhysicalDocker implements DockerEngineCommand {
  readonly containers = new Map<string, Raw>();
  readonly logs = new Map<string, string>();
  mutations = 0;
  configured = false;
  high = false;
  tokenDigest = '';
  absent = false;
  constructor(readonly boxId: string) {}
  observation(worker: boolean) {
    const anchor = [...this.containers].find(
      ([, r]) => r.Config.Labels?.['reverie.box.resource.role'] === 'anchor'
    )?.[0];
    assert(anchor);
    const parent = '/reverie.slice/reverie-box.slice/reverie-box-' + this.boxId + '.slice';
    return {
      version: 1,
      purpose: 'reverie-boxed-resource-observation-v1',
      boxId: this.boxId,
      parent: { path: parent, dev: '1', ino: '2' },
      anchor: {
        id: anchor,
        pid: 100,
        startTicks: '10',
        path: parent + '/docker-' + anchor + '.scope',
        dev: '1',
        ino: '3',
      },
      worker: worker
        ? {
            id: destinationId,
            pid: 200,
            startTicks: '20',
            path: parent + '/docker-' + destinationId + '.scope',
            dev: '1',
            ino: '4',
          }
        : null,
      resources: {
        memoryMax: this.configured ? String(48 * 1024 ** 3) : 'max',
        memoryHigh: worker && this.high ? String(16 * 1024 ** 3) : 'max',
        swapMax: '0',
        pidsMax: this.configured ? String(worker ? 512 : 8192) : 'max',
        cpuWeight: '100',
        cpuMax: 'max 100000',
        cpusetCpus: '0-1',
        cpusetCpusEffective: '0-1',
        cpusetMemsEffective: '0',
      },
    };
  }
  storage(destination = false) {
    return {
      version: 1,
      purpose: 'reverie-boxed-storage-observation-v1',
      holderStartTicks: destination ? null : '30',
      home: { dev: '1', ino: '2', uid: 1000, gid: 100, mode: 16832 },
      nix: { dev: '1', ino: '3', uid: 1000, gid: 100, mode: 16832 },
    };
  }
  async create(_name: string, config: Readonly<Record<string, unknown>>, current: () => void) {
    current();
    this.mutations++;
    const labels = config.Labels as Record<string, string>;
    const id = labels['reverie.boxed.operation'] ? destinationId : String(this.containers.size + 3).padStart(64, '0');
    const host = structuredClone(config.HostConfig) as PhysicalHost;
    host.PidMode ??= '';
    const mounts =
      host.Mounts?.map((m: PhysicalMount) => ({
        Type: m.Type,
        Source: m.Source,
        Destination: m.Target,
        RW: !m.ReadOnly,
        Propagation: 'rprivate',
      })) ??
      (host.Binds ?? []).map((v: string) => {
        const [Source, Destination, mode] = v.split(':');
        return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
      });
    this.containers.set(id, {
      Id: id,
      Image: config.Image as string,
      Config: structuredClone(config) as PhysicalConfig,
      HostConfig: host,
      Mounts: mounts,
      State: {
        Status: 'created',
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Pid: 0,
        ExitCode: 0,
      },
    });
    return id;
  }
  async run(args: readonly string[], input?: string): Promise<string> {
    if (args[0] === 'image')
      return JSON.stringify([
        {
          Id: args[2],
          RootFS: { Layers: args[2] === sourceImage ? ['old'] : ['old', 'new'] },
          Config: {
            Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
            Cmd: null,
            Env: ['HOME=/home/agent', 'PATH=/bin'],
            Labels: { 'org.reverie.worker-client.manifest': manifest },
          },
        },
      ]);
    if (args[0] === 'container' && args[1] === 'inspect') {
      const value = this.containers.get(args[2]!);
      assert(value, 'Unknown fixture CID ' + args[2]);
      return JSON.stringify([value]);
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      if (args.includes('label=reverie.managed=1')) return '';
      const filters = args.flatMap((v, i) => (v === '--filter' ? [args[i + 1]!] : []));
      return [...this.containers]
        .filter(
          ([id, r]) =>
            !(this.absent && id === destinationId) &&
            filters.every((f) => {
              if (f.startsWith('name=')) return r.Config.Labels?.['reverie.box.resource.name'] === f.slice(5);
              if (!f.startsWith('label=')) return true;
              const [key, ...rest] = f.slice(6).split('=');
              return r.Config.Labels?.[key!] === rest.join('=');
            })
        )
        .map(([id]) => id)
        .join('\n');
    }
    if (args[0] === 'container' && args[1] === 'start') {
      this.mutations++;
      const id = args.at(-1)!,
        raw = this.containers.get(id)!;
      const role = raw.Config.Labels?.['reverie.box.resource.role'];
      const storage = raw.Config.Labels?.['reverie.box.storage.operation'] !== undefined;
      const identity = raw.Config.Labels?.['reverie.box.identity.operation'] !== undefined;
      const running = role === 'anchor' || storage;
      raw.State = {
        Status: running ? 'running' : 'exited',
        Running: running,
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Pid: role === 'anchor' ? 100 : storage ? 300 : 0,
        ExitCode: 0,
      };
      if (role === 'pool-helper') this.configured = true;
      if (role === 'leaf-helper') this.high = true;
      if (role && role !== 'anchor') this.logs.set(id, JSON.stringify(this.observation(role === 'leaf-helper')));
      if (storage) this.logs.set(id, JSON.stringify(this.storage()));
      if (identity) {
        assert(input);
        this.tokenDigest = createHash('sha256').update(input).digest('hex');
        this.logs.set(
          id,
          JSON.stringify({
            version: 1,
            purpose: 'reverie-worker-credential-installed-v1',
            manifestDigest: manifest,
            sessionId: sid,
            tokenDigest: this.tokenDigest,
            homeDev: '1',
            homeIno: '2',
          })
        );
      }
      return id;
    }
    if (args[0] === 'container' && args[1] === 'wait') return '0\n';
    if (args[0] === 'logs' || (args[0] === 'container' && args[1] === 'logs')) return this.logs.get(args.at(-1)!)!;
    if (args[0] === 'exec') {
      if (args.includes('/bin/cat')) return '1 (worker) S ' + [...Array(18).fill('0'), '20', '0'].join(' ') + '\n';
      if (args.includes('probe-pool') || args.includes('probe-worker'))
        return JSON.stringify(this.observation(args.includes('probe-worker')));
      if (args.includes('storage-status')) return JSON.stringify(this.storage());
      if (args.includes('probe-storage')) return JSON.stringify(this.storage(true));
      if (args.includes('credential-status'))
        return JSON.stringify({
          version: 1,
          purpose: 'reverie-worker-credential-readback-v1',
          manifestDigest: manifest,
          sessionId: sid,
          tokenDigest: this.tokenDigest,
        });
      if (args.includes('status')) return '{}';
      if (args.includes('presence') || args.includes('observe'))
        return JSON.stringify({ ...pane, hooks: args.at(-1) === 'none' ? { kind: 'none' } : pane.hooks });
    }
    throw Error('Unexpected Docker physical request: ' + JSON.stringify(args));
  }
  save() {
    fs.writeFileSync(
      file,
      JSON.stringify({
        boxId: this.boxId,
        containers: [...this.containers],
        logs: [...this.logs],
        configured: this.configured,
        high: this.high,
        tokenDigest: this.tokenDigest,
      }),
      { mode: 0o600 }
    );
  }
  static load() {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = new PhysicalDocker(data.boxId);
    for (const [id, v] of data.containers) p.containers.set(id, v);
    for (const [id, v] of data.logs) p.logs.set(id, v);
    p.configured = data.configured;
    p.high = data.high;
    p.tokenDigest = data.tokenDigest;
    return p;
  }
}
async function seed(scenario: string) {
  const [
    { DockerRuntimeKey },
    { dockerContinuationDigest },
    { DockerEmployeeInspect, boxedOriginal },
    { DockerEmployeeEngine },
    { DockerContainedResources },
    { DockerEmployeeStorage },
    { CompanyStore },
    { EmployeeSchema, CompanySettingsSchema },
    { StateStore },
    { Session },
  ] = await Promise.all([
    import('../src/docker-runtime-key.js'),
    import('../src/docker-employee-continuation.js'),
    import('../src/docker-employee-engine-data.js'),
    import('../src/docker-employee-engine.js'),
    import('../src/docker-contained-resource-controller.js'),
    import('../src/docker-employee-storage.js'),
    import('../src/company-store.js'),
    import('../src/company-types.js'),
    import('../src/state-store.js'),
    import('../src/session.js'),
  ]);
  fs.mkdirSync('/fixture/work', { mode: 0o700 });
  const key = new DockerRuntimeKey('/fixture/data/docker-runtime');
  const boxId = dockerContinuationDigest({ instanceId: key.instanceId, deployment });
  key.close();
  const physical = new PhysicalDocker(boxId);
  const policy = {
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  };
  const source = DockerEmployeeInspect.parse({
    Id: sourceId,
    Image: sourceImage,
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
    Config: {
      User: '1000:100',
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: null,
      Env: ['HOME=/home/agent', 'PATH=/bin'],
      WorkingDir: '/fixture/work',
      Labels: { 'reverie.worker': deployment, 'reverie.employee': eid, 'reverie.session': sid },
    },
    Mounts: [
      { Type: 'bind', Source: '/synthetic/home', Destination: '/home/agent', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: '/synthetic/nix', Destination: '/nix', RW: true, Propagation: 'rprivate' },
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
  physical.containers.set(sourceId, source);
  const subject = {
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: 1,
    owner: undefined,
    sourceDigest: 'e'.repeat(64),
    onVacation: false,
    desiredRunning: true,
  };
  const row: DockerEmployeeContinuationRecord = {
    version: 1,
    purpose: 'docker-employee-continuation-v1',
    employeeId: eid,
    request: {
      operationId: oid,
      sessionId: sid,
      sessionGeneration: 1,
      containerId: sourceId,
      imageId: sourceImage,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: target,
      enterOffice: false,
    },
    sourceDigest: subject.sourceDigest,
    original: boxedOriginal(source, subject, deployment),
    workerImage: { imageId: target, sourceImageId: sourceImage, clientManifestDigest: manifest },
    policy,
    credentialId: '55555555-5555-4555-8555-555555555555',
    phase: 'pool-issued',
  };
  const tasks = new Map<DockerContinuationTaskRole, DockerContinuationTask>();
  const { allowedDockerTaskTransition } = await import('../src/docker-continuation-task.js');
  const journal = {
    read: (_r: DockerEmployeeContinuationRecord, role: DockerContinuationTaskRole) => tasks.get(role),
    publish: async (
      _r: DockerEmployeeContinuationRecord,
      before: DockerContinuationTask | undefined,
      next: DockerContinuationTask,
      current: () => void
    ) => {
      current();
      assert.deepEqual(tasks.get(next.role), before);
      assert(allowedDockerTaskTransition(before, next));
      tasks.set(next.role, structuredClone(next));
      return row;
    },
  };
  const resources = new DockerContainedResources(physical, journal, {
    boxId,
    deployment,
    helperImageId: helper,
    selectedWorkerContainerIds: () => (row.destination ? [destinationId] : []),
  });
  const engine = new DockerEmployeeEngine(
    physical,
    deployment,
    resources,
    { imageId: target, clientManifestDigest: manifest, sourceImageIds: [sourceImage] },
    journal,
    helper,
    boxId
  );
  const storage = new DockerEmployeeStorage(physical, journal, helper, async () => source, boxId);
  await storage.prepare(row, noop);
  await resources.preparePool(row, noop);
  row.pool = (await resources.observePool(row))!;
  await engine.createDestination(row, noop);
  const destination = physical.containers.get(destinationId)!;
  destination.HostConfig.OomKillDisable = false;
  destination.State = {
    Status: 'running',
    Running: true,
    Paused: false,
    Restarting: false,
    Dead: false,
    OOMKilled: false,
    Pid: 200,
  };
  row.destination = boxedOriginal(DockerEmployeeInspect.parse(destination), subject, deployment, true);
  await resources.configure(row, noop);
  row.phase = 'identity-issued';
  await engine.provisionIdentity(row, 'synthetic-test-token-not-server-authority', noop);
  row.phase = scenario.startsWith('issued-') || scenario.startsWith('codex-') ? 'provider-issued' : 'ready';
  row.tasks = [...tasks.values()];
  const docker = {
    hostId: 'boxed-runtime',
    label: 'Synthetic',
    engine: 'docker' as const,
    image: target,
    containerName: destinationId,
    hostWorkspacePath: '/',
    containerWorkdir: '/fixture/work',
    network: 'bridge',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      operationId: oid,
      employeeId: eid,
      sessionGeneration: 1,
      clientManifestDigest: manifest,
      apiUrl: 'http://reverie:3000',
    },
  };
  const writer = new StateStore('/fixture/data/state.json');
  const data = {
    id: sid,
    name: 'Synthetic',
    mode: scenario.startsWith('codex-') ? 'codex' : 'claude',
    ...(scenario.startsWith('codex-')
      ? { codexConfig: { dangerouslyBypassApprovals: true, resumeSessionId: thread } }
      : {}),
    workingDir: '/fixture/work',
    status: 'busy',
    pid: 23,
    createdAt: 1,
    lastActivityAt: 1,
    currentTaskId: null,
    pinned: true,
    desiredRunning: true,
    docker,
    claudeSessionChain: [thread],
  } as import('../src/types.js').SessionState;
  writer.setSession(sid, data);

  const original = new Session({ ...data, publicationStore: writer });
  const publication = writer.stageProviderLaunch(original, {
    transport: 'docker',
    current: () => true,
    snapshot: () => original.toPersistedState(),
  });
  await publication.prepare(original, {
    kind: 'mux',
    sessionId: sid,
    owner: null,
    mode: data.mode ?? 'claude',
    command: 'controlled-known-returned-docker',
    cwd: '/fixture/work',
    environment: {},
  });
  publication.claim();
  publication.settle(true);
  await original.stop(false);
  writer.flush();
  if (scenario === 'unknown' || scenario === 'issued-held') {
    writer.setSession(sid, { ...writer.getSession(sid)!, providerDispatchHeld: true });
    writer.flush();
  }
  const employee = EmployeeSchema.parse({
    id: eid,
    sessionId: sid,
    sessionGeneration: 1,
    name: 'Synthetic',
    icon: 'S',
    position: 'Employee',
    expertise: ['testing'],
    createdAt: 1,
    onVacation: false,
    desiredRunning: scenario !== 'desired-off',
    dockerResourcePolicy: policy,
    dockerBinding: {
      version: 1,
      operationId: oid,
      credentialId: row.credentialId,
      sessionId: sid,
      sessionGeneration: 1,
      containerId: destinationId,
      imageId: target,
      originalDigest: dockerContinuationDigest(row.destination),
      policyDigest: dockerContinuationDigest(policy),
    },
  });
  const { dockerEmployeeSourceDigest } = await import('../src/docker-employee-store.js');
  row.sourceDigest = dockerEmployeeSourceDigest(employee, writer.getSession(sid)!);
  const company = new CompanyStore('/fixture/data/company.json');
  await company.init();
  await company.update((state) => {
    state.employees = [employee];
    state.settings = [CompanySettingsSchema.parse({ autoWakeEnabled: false })];
    state.dockerEmployeeContinuations = [row];
  });
  physical.save();
}
async function startup(scenario: string) {
  const physical = PhysicalDocker.load();
  physical.absent = ['absent', 'issued-absent'].includes(scenario);
  const { PackagedDockerEngineCommand } = await import('../src/docker-engine-command.js');
  const originalRun = PackagedDockerEngineCommand.prototype.run,
    originalCreate = PackagedDockerEngineCommand.prototype.create;
  PackagedDockerEngineCommand.prototype.run = physical.run.bind(physical);
  PackagedDockerEngineCommand.prototype.create = physical.create.bind(physical);
  const require = createRequire(import.meta.url),
    pty = require('node-pty');
  const oldSpawn = pty.spawn;
  let ptys = 0;
  const writes: string[] = [];
  let failWrite = false;
  pty.spawn = (program: string, args: string[]) => {
    assert.equal(program, process.execPath);
    assert.deepEqual(args, [
      '-e',
      'if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.pipe(process.stdout);',
    ]);
    ptys++;
    let exit: ((event: { exitCode: number; signal: number }) => void) | undefined;
    return {
      pid: 2147483647,
      cols: 80,
      rows: 24,
      process: 'tmux',
      write: (data: string) => {
        writes.push(data);
        if (failWrite) throw Error('Controlled physical write reply lost');
      },
      resize: noop,
      pause: noop,
      resume: noop,
      onData: () => ({ dispose: noop }),
      onExit: (fn: typeof exit) => {
        exit = fn;
        return { dispose: noop };
      },
      kill: () => exit?.({ exitCode: 0, signal: 0 }),
    };
  };
  const { PROVIDER_LAUNCH_DISK_KEY } = await import('../src/provider-launch-publication.js');
  const before = JSON.parse(fs.readFileSync('/fixture/data/state.json', 'utf8'))[PROVIDER_LAUNCH_DISK_KEY];
  const { WebServer } = await import('../src/web/server.js');
  const server = new WebServer(0, false, false, '0.0.0.0');
  try {
    await server.start();
    const internal = server as unknown as {
      sessions: Map<string, import('../src/session.js').Session>;
      dockerEmployeeRuntime: { restorationReports: readonly { state: string; sessionId: string }[] };
      store: import('../src/state-store.js').StateStore;
      companyService: import('../src/company-service.js').CompanyService;
      terminalInput: import('../src/web/terminal-input-service.js').TerminalInputService;
      workerProviderHealth: {
        refresh(): Promise<void>;
        read(id: string): import('../src/types/provider-health.js').ProviderHealth | undefined;
      };
    };
    assert.equal(JSON.parse(fs.readFileSync('/fixture/data/company.json', 'utf8')).settings[0].autoWakeEnabled, false);
    const app = (server as unknown as { app: import('fastify').FastifyInstance }).app;
    const enrollment = await app.inject({
      method: 'POST',
      url: '/api/owner/setup',
      headers: { host: 'reverie:3000', origin: 'http://reverie:3000' },
      payload: {
        username: 'synthetic-startup',
        password: 'Azure-river-maple-73!',
        confirmation: 'Azure-river-maple-73!',
      },
    });
    assert.equal(enrollment.statusCode, 200, 'Only the actual private fixture owner setup may authenticate the read');
    const cookies = enrollment.headers['set-cookie'];
    assert(cookies);
    const cookie = (Array.isArray(cookies) ? cookies : [cookies]).map((value) => value.split(';')[0]).join('; ');
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/' + sid,
      headers: { host: 'reverie:3000', cookie },
    });
    assert.equal(
      response.statusCode,
      ['attached', 'issued-live'].includes(scenario) || scenario.startsWith('codex-') ? 200 : 404
    );
    assert(internal.workerProviderHealth, 'Docker health must exist without a retired host worker socket');
    assert.equal(process.env.REVERIE_WORKER_SOCKET, undefined);
    if (scenario === 'attached' || scenario === 'issued-live' || scenario.startsWith('codex-'))
      assert.equal(
        internal.workerProviderHealth.read(sid)?.state,
        'healthy',
        'Post-listen Docker polling must run without the retired host-worker socket'
      );
    await internal.workerProviderHealth.refresh();
    if (scenario === 'attached' || scenario === 'issued-live' || scenario.startsWith('codex-')) {
      assert.equal(internal.workerProviderHealth.read(sid)?.state, 'healthy');
      const current = await app.inject({
        method: 'GET',
        url: '/api/sessions/' + sid,
        headers: { host: 'reverie:3000', cookie },
      });
      assert.equal(current.statusCode, 200);
      assert.equal(current.json().success, true);
      assert.equal(
        current.json().data.providerHealth?.state,
        'healthy',
        'Actual Session HTTP DTO must expose fresh Docker native health'
      );
      const company = await app.inject({
        method: 'GET',
        url: '/api/company',
        headers: { host: 'reverie:3000', cookie },
      });
      const e = company.json().data.employees.find((e: { id: string }) => e.id === eid);
      assert.equal(e.dockerProviderPlacement, current.json().data.providerHealth.dockerPlacement);
    }

    if (scenario === 'issued-live') {
      assert.equal(internal.workerProviderHealth.read(sid)?.state, 'healthy');
      const response = await app.inject({
        method: 'GET',
        url: '/api/company',
        headers: { host: 'reverie:3000', cookie },
      });
      assert.equal(response.statusCode, 200);
      const employee = response.json().data.employees.find((e: { id: string }) => e.id === eid);
      assert.equal(employee.providerHealth?.state, 'healthy');
      assert.equal(employee.dockerProviderPlacement, employee.providerHealth.dockerPlacement);
      assert.equal(
        JSON.parse(fs.readFileSync('/fixture/data/company.json', 'utf8')).dockerEmployeeContinuations[0].phase,
        'provider-issued'
      );
    }
    const session = internal.sessions.get(sid),
      reports = internal.dockerEmployeeRuntime.restorationReports;
    if (scenario === 'attached' || scenario === 'issued-live' || scenario.startsWith('codex-')) {
      assert(session, 'A genuine existing provider must restore a Session with empty control-local mux');
      assert.equal(session.dockerContinuationViewCurrent, true);
      assert.equal(session.providerDispatchHeld, true);
      assert.equal(session.providerInputHeld, false);
      assert.equal(session.claudeSessionId, thread);
      assert.equal(session.claudeSessionIdPending, false);
      assert.equal(ptys, 1);
      assert(reports.some((r) => r.sessionId === sid && r.state === 'attached'));
    } else {
      assert.equal(session, undefined);
      assert.equal(ptys, 0);
      if (scenario !== 'desired-off') assert(reports.some((r) => r.sessionId === sid && r.state === 'held'));
    }
    if (scenario.startsWith('codex-')) {
      assert(session);
      assert.equal(session.workspaceHookConfiguration, 'opted-out');
      assert.equal(session.admitHookReport('forged-generation'), 'refused');
      const headers = { host: 'reverie:3000', origin: 'http://reverie:3000', cookie, 'x-reverie-input-protocol': '2' };
      const post = (input: string, seq: number) =>
        app.inject({
          method: 'POST',
          url: '/api/sessions/' + sid + '/input',
          headers,
          payload: { input, useMux: false, clientId: 'namespace-http', seq },
        });
      const denied = await app.inject({
        method: 'POST',
        url: '/api/sessions/' + sid + '/input',
        headers: { host: 'reverie:3000', origin: 'http://reverie:3000', 'x-reverie-input-protocol': '2' },
        payload: { input: 'forbidden', useMux: false },
      });
      assert.equal(denied.statusCode, 401);
      assert.equal(writes.length, 0);
      const http = await post('http-original', 1);
      assert.equal(http.json().success, true);
      assert.deepEqual(writes, ['http-original']);
      assert.equal((await post('http-original', 1)).json().success, true);
      assert.deepEqual(writes, ['http-original']);
      const { default: WebSocket } = await import('ws');
      const ws = new WebSocket(
        'ws://127.0.0.1:' + server.boundPort + '/ws/sessions/' + sid + '/terminal?inputProtocol=2',
        { headers: { Host: 'reverie:3000', Origin: 'http://reverie:3000', Cookie: cookie } }
      );
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const send = (text: string, seq: number) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Actual WS input ACK missing')), 5000);
          const listener = (data: unknown) => {
            const x = JSON.parse(String(data));
            if (x.t === 'ia' && x.seq === seq) {
              clearTimeout(timer);
              ws.off('message', listener);
              resolve(x);
            }
          };
          ws.on('message', listener);
          ws.send(JSON.stringify({ t: 'i', d: text, cid: 'namespace-ws', seq, useMux: false }));
        });
      try {
        assert.equal((await send('ws-original', 1)).confirmed, true);
        assert.deepEqual(writes, ['http-original', 'ws-original']);
        assert.equal((await send('ws-original', 1)).confirmed, true);
        assert.equal(writes.length, 2);
        // Trusted input leases recheck actual canonical scoped permissions and
        // actual Session identity immediately before bytes, not only at capture.
        const { CompanyStore } = await import('../src/company-store.js');
        const { EmployeeSchema } = await import('../src/company-types.js');
        const { Session } = await import('../src/session.js');
        const actorSid = '66666666-6666-4666-8666-666666666666',
          actorId = '77777777-7777-4777-8777-777777777777';
        const actor = new Session({ id: actorSid, mode: 'shell', workingDir: '/fixture/work' });
        internal.sessions.set(actorSid, actor);
        const canonical = new CompanyStore('/fixture/data/company.json');
        await canonical.init();
        await canonical.update((state) => {
          state.employees.push(
            EmployeeSchema.parse({
              id: actorId,
              name: 'Scoped synthetic actor',
              icon: 'A',
              sessionId: actorSid,
              sessionGeneration: 1,
              position: 'Tester',
              expertise: ['testing'],
              desiredRunning: true,
              onVacation: false,
              createdAt: 1,
              permissions: { recoverEmployees: true },
            })
          );
        });
        const grant = internal.companyService.recoveryAction(eid, undefined, actorSid);
        const permissionCurrent = () => {
          try {
            grant.require();
            return true;
          } catch {
            return false;
          }
        };
        const permissionLease = internal.terminalInput.begin(
          session,
          { input: 'revoked-grant', useMux: false },
          permissionCurrent
        );
        assert.equal(permissionLease.state, 'admitted');
        await canonical.update((state) => {
          state.employees.find((e) => e.id === actorId)!.permissions.recoverEmployees = false;
        });
        assert.equal(permissionCurrent(), false);
        assert(permissionLease.state === 'admitted');
        assert.equal(permissionLease.operation.writeRaw(), false);
        permissionLease.operation.refuse();
        assert.equal(writes.length, 2);
        internal.sessions.delete(actorSid);
        await actor.stop(false);
        await canonical.update((state) => {
          state.employees = state.employees.filter((e) => e.id !== actorId);
        });
        assert.equal(session.providerDispatchHeld, true, 'Input must not clear original paid-effect fence');
        assert.throws(() => session.assertProviderLaunchAdmission());
        if (scenario === 'codex-identity') {
          const ownerLease = internal.terminalInput.begin(
            session,
            { input: 'old-owner', useMux: false },
            () => internal.sessions.get(sid) === session
          );
          assert(ownerLease.state === 'admitted');
          session.owner = 'replacement-owner';
          assert.equal(ownerLease.operation.writeRaw(), false);
          ownerLease.operation.refuse();
          assert.equal((await send('foreign-owner-ws', 2)).held, true);
          assert.equal(writes.length, 2);
        } else if (scenario === 'codex-stale') {
          const { CompanyStore } = await import('../src/company-store.js');
          const canonical = new CompanyStore('/fixture/data/company.json');
          await canonical.init();
          await canonical.update((state) => {
            state.employees[0]!.owner = 'replacement-owner';
          });
          assert.equal(session.dockerContinuationViewCurrent, false);
          assert.equal((await post('stale-http', 2)).json().success, false);
          assert.equal((await send('stale-ws', 2)).held, true);
          assert.equal(writes.length, 2);
        } else {
          failWrite = true;
          assert.equal((await post('uncertain-original', 2)).json().success, false);
          assert.equal(session.terminalInputHeld, true);
          assert.equal(writes.length, 3);
          failWrite = false;
          assert.equal((await post('uncertain-original', 2)).json().success, false);
          assert.equal((await send('unknown-must-not-replay', 2)).held, true);
          assert.equal(writes.length, 3);
        }
      } finally {
        ws.close();
        await new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) resolve();
          else ws.once('close', () => resolve());
        });
      }
    }
    assert.equal(physical.mutations, 0, 'Startup must not create/start/dispatch any provider');
    internal.store.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync('/fixture/data/state.json', 'utf8'))[PROVIDER_LAUNCH_DISK_KEY], before);
    console.log(JSON.stringify({ scenario, passed: true, ptys, physicalMutations: physical.mutations }));
  } finally {
    await server.stop();
    for (const session of (
      server as unknown as { sessions: Map<string, import('../src/session.js').Session> }
    ).sessions.values())
      await session.stop(false);
    pty.spawn = oldSpawn;
    PackagedDockerEngineCommand.prototype.run = originalRun;
    PackagedDockerEngineCommand.prototype.create = originalCreate;
  }
}
if (process.argv.includes('--namespace')) {
  const scenario = process.argv.at(-1)!;
  const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, '--seed', scenario], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, 'Canonical fixture seed refused');
  await startup(scenario);
} else if (process.argv.includes('--seed')) {
  await seed(process.argv.at(-1)!);
} else {
  const { describe, it } = await import('vitest');
  describe('actual boxed WebServer startup restores only existing provider viewers', () => {
    for (const scenario of [
      'attached',
      'absent',
      'desired-off',
      'unknown',
      'issued-live',
      'issued-absent',
      'issued-held',
      'codex-input',
      'codex-stale',
      'codex-identity',
    ])
      it(scenario, () => runBoxedStartupNamespace('test/docker-employee-startup-restore.test.ts', scenario), 60_000);
  });
}
