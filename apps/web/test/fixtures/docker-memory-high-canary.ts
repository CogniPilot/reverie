/** Explicit isolated helper acceptance. This proves kernel resource behaviour,
 * not company/agent authorization, provider readiness or plan movement. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export interface CanaryIdentity {
  id: string;
  pid: number;
  start: string;
}
interface DockerState {
  Status: string;
  Running: boolean;
  Pid: number;
  ExitCode: number;
}
interface HelperImage {
  Id: string;
  Config: {
    User: string;
    Entrypoint: string[];
    WorkingDir: string;
    Labels: Record<string, string>;
    Env?: string[] | null;
    Cmd: string[];
  };
  RootFS?: { Type: string; Layers: string[] };
  Os?: string;
  Architecture?: string;
}
interface DockerRow {
  Id: string;
  Image: string;
  State: DockerState;
  Config: HelperImage['Config'];
  HostConfig?: {
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    NetworkMode: string;
    CapDrop: string[];
    CapAdd: string[] | null;
    SecurityOpt: string[];
    RestartPolicy: { Name: string; MaximumRetryCount: number };
  };
}
export interface ResourceObservation {
  version: number;
  purpose: string;
  boxId: string;
  parent: { path: string; dev: string; ino: string };
  anchor: {
    id: string;
    pid: number;
    startTicks: string;
    path: string;
    dev: string;
    ino: string;
  };
  worker: null | {
    id: string;
    pid: number;
    startTicks: string;
    path: string;
    dev: string;
    ino: string;
  };
  resources: Record<string, string>;
}
interface Owned {
  id: string;
  role: string;
  image: string;
  identity?: CanaryIdentity;
}
interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  stdout: string;
  stderr: string;
}
export function requireImageId(value: string): string {
  assert.match(value, /^sha256:[0-9a-f]{64}$/u, 'An actual immutable Engine image ID is required');
  return value;
}
export function requireHelperImage(actual: HelperImage, id: string, writer: boolean): void {
  assert.equal(actual.Id, requireImageId(id));
  assert.equal(actual.Os, 'linux');
  assert.equal(actual.Architecture, 'amd64');
  assert.ok(actual.RootFS);
  assert.equal(actual.RootFS.Type, 'layers');
  assert.ok(actual.RootFS.Layers.length > 0);
  assert.equal(actual.Config.User, '0:0');
  assert.equal(actual.Config.WorkingDir, '/');
  assert.deepEqual(actual.Config.Entrypoint, ['/bin/reverie-docker-resources']);
  assert.deepEqual(actual.Config.Cmd, ['anchor']);
  assert.ok(actual.Config.Env == null || (Array.isArray(actual.Config.Env) && actual.Config.Env.length === 0));
  assert.deepEqual(actual.Config.Labels, {
    'org.reverie.purpose': 'boxed-resource-helper-v1',
    ...(writer ? { 'org.reverie.resource.memory-high-only': 'v1' } : {}),
  });
}
export function requireOwned(actual: DockerRow, expected: Owned, box: string): void {
  assert.equal(actual.Id, expected.id);
  assert.equal(actual.Image, expected.image);
  assert.equal(actual.Config.Labels['reverie.disposable'], box);
  assert.equal(actual.Config.Labels['reverie.task'], 'docker-memory-high-canary-v1');
  assert.equal(actual.Config.Labels['reverie.role'], expected.role);
}
export function requireContainerSafety(actual: DockerRow): void {
  assert.equal(actual.Config.User, '0:0');
  assert.equal(actual.Config.WorkingDir, '/');
  assert.deepEqual(actual.Config.Entrypoint, ['/bin/reverie-docker-resources']);
  const host = actual.HostConfig;
  assert.ok(host);
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Privileged, false);
  assert.equal(host.NetworkMode, 'none');
  assert.deepEqual(host.CapDrop, ['ALL']);
  assert.ok(host.CapAdd === null || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0));
  assert.deepEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 });
  assert.ok(Array.isArray(host.SecurityOpt));
  assert.ok(host.SecurityOpt.some((value) => value === 'no-new-privileges' || value === 'no-new-privileges:true'));
  assert.ok(
    host.SecurityOpt.every((value) => ['no-new-privileges', 'no-new-privileges:true', 'label=disable'].includes(value))
  );
}
export function requireOnlyHighChanged(before: ResourceObservation, after: ResourceObservation, high: string): void {
  const expected = structuredClone(before);
  expected.resources.memoryHigh = high;
  assert.deepEqual(
    after,
    expected,
    'Only memory.high may change; actual PID/birth/inodes and every other field must remain identical'
  );
}
export function requireIdentity(actual: CanaryIdentity, expected: CanaryIdentity): void {
  assert.deepEqual(actual, expected, 'The original container/init incarnation must remain unchanged');
}
class Evidence {
  readonly root: string;
  private readonly fd: number;
  private readonly dev: number;
  private readonly ino: number;
  constructor(root: string) {
    assert.ok(path.isAbsolute(root));
    fs.mkdirSync(root, { mode: 0o700 });
    this.root = fs.realpathSync(root);
    const fd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      assert.equal(stat.uid, process.getuid?.());
      assert.equal(stat.mode & 0o777, 0o700);
      this.fd = fd;
      this.dev = stat.dev;
      this.ino = stat.ino;
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch (close) {
        throw new AggregateError([error, close], 'Evidence admission and close failed');
      }
      throw error;
    }
  }
  save(name: string, value: unknown): void {
    assert.match(name, /^[a-z0-9-]+$/u);
    const named = fs.lstatSync(this.root);
    assert.equal(named.dev, this.dev);
    assert.equal(named.ino, this.ino);
    assert.ok(named.isDirectory());
    const fd = fs.openSync(path.join(this.root, name + '.json'), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.fsyncSync(this.fd);
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}
class NativeCanary {
  readonly box = randomBytes(32).toString('hex');
  private serial = 0;
  private readonly owned: Owned[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly evidence: Evidence;
  readonly baseline: string;
  readonly writer: string;
  private baselineSnapshot: HelperImage | undefined;
  constructor(evidence: Evidence, baseline: string, writer: string) {
    this.evidence = evidence;
    this.baseline = baseline;
    this.writer = writer;
    requireImageId(baseline);
    requireImageId(writer);
    assert.notEqual(baseline, writer);
    const home = path.join(evidence.root, 'docker-home');
    fs.mkdirSync(home, { mode: 0o700 });
    const config = path.join(home, 'config');
    fs.mkdirSync(config, { mode: 0o700 });
    this.env = {
      PATH: process.env.PATH,
      HOME: home,
      DOCKER_CONFIG: config,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    };
    evidence.save('plan', {
      purpose: 'docker-memory-high-native-v1',
      box: this.box,
      baseline,
      writer,
      companyData: false,
      provider: false,
    });
  }
  private command(label: string, args: string[]): Outcome {
    const key = String(++this.serial).padStart(3, '0') + '-' + label;
    this.evidence.save(key + '-intent', { args });
    const result = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      env: this.env,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
    this.evidence.save(key + '-result', output);
    assert.equal(output.error, undefined, label + ' outcome unconfirmed');
    assert.equal(output.status, 0, label + ': ' + output.stderr);
    return output;
  }
  private inspect(id: string): DockerRow {
    return JSON.parse(this.command('inspect', ['inspect', id]).stdout)[0] as DockerRow;
  }
  private image(id: string): HelperImage {
    return JSON.parse(this.command('image', ['image', 'inspect', id]).stdout)[0] as HelperImage;
  }
  private identity(row: DockerRow): CanaryIdentity {
    assert.equal(row.State.Running, true);
    assert.ok(Number.isSafeInteger(row.State.Pid) && row.State.Pid > 1);
    const stat = fs.readFileSync(`/proc/${row.State.Pid}/stat`, 'utf8');
    assert.ok(Buffer.byteLength(stat) < 4096);
    const fields = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/u);
    assert.ok(!['Z', 'X', 'x'].includes(fields[0]));
    assert.match(fields[19], /^[1-9][0-9]*$/u);
    const after = this.inspect(row.Id);
    assert.equal(after.State.Running, true);
    assert.equal(after.State.Pid, row.State.Pid);
    return { id: row.Id, pid: row.State.Pid, start: fields[19] };
  }
  private common(): string[] {
    return [
      '--pull',
      'never',
      '--restart',
      'no',
      '--read-only',
      '--workdir',
      '/',
      '--no-healthcheck',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'none',
      '--user',
      '0:0',
      '--pids-limit',
      '32',
      '--memory',
      '67108864',
      '--memory-swap',
      '67108864',
    ];
  }
  private hostView(): string[] {
    return ['--pid', 'host', '--cgroupns', 'host', '--mount', 'type=bind,src=/proc,dst=/proc,readonly'];
  }
  private create(role: string, image: string, command: string[], extra: string[] = [], flags = this.common()): Owned {
    const name = 'reverie-ci-high-' + this.box.slice(0, 16) + '-' + role;
    const result = this.command('create-' + role, [
      'create',
      '--name',
      name,
      '--label',
      'reverie.disposable=' + this.box,
      '--label',
      'reverie.task=docker-memory-high-canary-v1',
      '--label',
      'reverie.role=' + role,
      ...flags,
      ...extra,
      image,
      ...command,
    ]);
    const id = result.stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/u);
    const owned = { id, role, image };
    this.evidence.save('cid-' + role, owned);
    this.owned.push(owned);
    const row = this.inspect(id);
    requireOwned(row, owned, this.box);
    requireContainerSafety(row);
    assert.equal(row.State.Status, 'created');
    assert.equal(row.State.Pid, 0);
    return owned;
  }
  private start(owned: Owned): DockerRow {
    this.command('start-' + owned.role, ['start', owned.id]);
    return this.inspect(owned.id);
  }
  private runHelper(owned: Owned, success = true): ResourceObservation | Outcome {
    this.start(owned);
    const waited = this.command('wait-' + owned.role, ['wait', owned.id]);
    const row = this.inspect(owned.id);
    requireOwned(row, owned, this.box);
    assert.equal(row.State.Running, false);
    assert.equal(row.State.Status, 'exited');
    assert.equal(row.State.Pid, 0);
    assert.equal(Number(waited.stdout.trim()), row.State.ExitCode);
    const logs = this.command('logs-' + owned.role, ['logs', owned.id]);
    if (!success) {
      assert.notEqual(row.State.ExitCode, 0);
      assert.equal(logs.stdout, '');
      return logs;
    }
    assert.equal(row.State.ExitCode, 0);
    assert.equal(logs.stderr, '');
    return JSON.parse(logs.stdout) as ResourceObservation;
  }
  private commonArgs(anchor: CanaryIdentity): string[] {
    return [
      '--box-id',
      this.box,
      '--anchor-id',
      anchor.id,
      '--anchor-pid',
      String(anchor.pid),
      '--anchor-start',
      anchor.start,
    ];
  }
  private workerArgs(anchor: CanaryIdentity, worker: CanaryIdentity): string[] {
    return [
      ...this.commonArgs(anchor),
      '--worker-id',
      worker.id,
      '--worker-pid',
      String(worker.pid),
      '--worker-start',
      worker.start,
    ];
  }
  private probe(anchor: CanaryIdentity, worker?: CanaryIdentity): ResourceObservation {
    const args = worker
      ? ['probe-worker', ...this.workerArgs(anchor, worker)]
      : ['probe-pool', ...this.commonArgs(anchor)];
    const value = JSON.parse(
      this.command('probe', ['exec', anchor.id, '/bin/reverie-docker-resources', ...args]).stdout
    ) as ResourceObservation;
    assert.equal(value.version, 1);
    assert.equal(value.purpose, 'reverie-boxed-resource-observation-v1');
    assert.equal(value.boxId, this.box);
    assert.equal(value.parent.path, `/reverie.slice/reverie-box.slice/reverie-box-${this.box}.slice`);
    assert.equal(value.anchor.id, anchor.id);
    assert.equal(value.anchor.startTicks, anchor.start);
    if (worker) {
      assert.equal(value.worker?.id, worker.id);
      assert.equal(value.worker?.startTicks, worker.start);
      assert.equal(value.worker?.path, value.parent.path + `/docker-${worker.id}.scope`);
    }
    return value;
  }
  private write(
    role: string,
    selected: string,
    anchor: CanaryIdentity,
    worker: CanaryIdentity,
    snapshot: ResourceObservation,
    cpus: string,
    high: number,
    weight: number,
    success = true
  ): ResourceObservation | Outcome {
    assert.ok(snapshot.worker);
    const args = [
      selected === this.baseline ? 'configure-high' : 'configure-memory-high',
      ...this.workerArgs(anchor, worker),
      '--leaf-dev',
      snapshot.worker.dev,
      '--leaf-ino',
      snapshot.worker.ino,
      '--memory-max',
      '268435456',
      '--swap-max',
      '0',
      '--pids-max',
      '32',
      '--memory-high',
      String(high),
      '--cpu-weight',
      String(weight),
    ];
    if (selected !== this.baseline) args.push('--cpuset-cpus', cpus);
    const owned = this.create(role, selected, args, [
      ...this.hostView(),
      '--mount',
      `type=bind,src=/sys/fs/cgroup${snapshot.worker.path},dst=/run/reverie-worker-cgroup`,
    ]);
    return this.runHelper(owned, success);
  }
  private configurePool(
    role: string,
    anchor: CanaryIdentity,
    scope: ResourceObservation,
    cpus: string
  ): ResourceObservation {
    const helper = this.create(
      role,
      this.baseline,
      [
        'configure-pool',
        ...this.commonArgs(anchor),
        '--parent-dev',
        scope.parent.dev,
        '--parent-ino',
        scope.parent.ino,
        '--memory-max',
        '536870912',
        '--swap-max',
        '0',
        '--pids-max',
        '128',
        '--cpu-weight',
        '100',
        '--cpuset-cpus',
        cpus,
      ],
      [...this.hostView(), '--mount', `type=bind,src=/sys/fs/cgroup${scope.parent.path},dst=/run/reverie-box-pool`]
    );
    const ack = this.runHelper(helper);
    const observed = this.probe(anchor);
    assert.deepEqual(ack, observed);
    assert.equal(observed.resources.memoryMax, '536870912');
    assert.equal(observed.worker, null);
    return observed;
  }
  private restartOwned(owned: Owned, original: CanaryIdentity): CanaryIdentity {
    const running = this.inspect(owned.id);
    requireOwned(running, owned, this.box);
    requireIdentity(this.identity(running), original);
    this.command('stop-original-' + owned.role, ['stop', '--time', '3', owned.id]);
    const stopped = this.inspect(owned.id);
    requireOwned(stopped, owned, this.box);
    assert.equal(stopped.State.Status, 'exited');
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.State.Pid, 0);
    const row = this.start(owned);
    requireOwned(row, owned, this.box);
    const restarted = this.identity(row);
    owned.identity = restarted;
    assert.equal(restarted.id, original.id);
    assert.notEqual(restarted.start, original.start);
    return restarted;
  }
  private restoreWorkerHigh(owned: Owned, previous: CanaryIdentity, anchor: CanaryIdentity, cpus: string,
    configured: ResourceObservation): CanaryIdentity {
    const worker = this.restartOwned(owned, previous);
    const fresh = this.probe(anchor, worker);
    assert.equal(fresh.resources.memoryHigh, 'max');
    const stale = this.write('cold-worker-stale-birth', this.writer, anchor, { ...worker, start: previous.start },
      fresh, cpus, 67108864, 100, false) as Outcome;
    assert.match(stale.stderr, /BOXED_RESOURCE_PID_CHANGED/u);
    assert.deepEqual(this.probe(anchor, worker), fresh);
    const ack = this.write('cold-worker-high', this.writer, anchor, worker, fresh, cpus, 67108864, 100);
    const observed = this.probe(anchor, worker);
    assert.deepEqual(ack, observed);
    assert.deepEqual(observed.resources, configured.resources);
    this.evidence.save('cold-worker-accepted', { previous, worker, fresh, observed });
    return worker;
  }
  run(): void {
    const baseBefore = this.image(this.baseline);
    requireHelperImage(baseBefore, this.baseline, false);
    requireHelperImage(this.image(this.writer), this.writer, true);
    this.baselineSnapshot = baseBefore;
    const info = JSON.parse(this.command('info', ['info', '--format', '{{json .}}']).stdout) as {
      CgroupVersion: string;
      CgroupDriver: string;
    };
    assert.equal(info.CgroupVersion, '2');
    assert.equal(info.CgroupDriver, 'systemd');
    const parent = `reverie-box-${this.box}.slice`;
    const anchorOwned = this.create(
      'anchor',
      this.baseline,
      ['anchor'],
      [...this.hostView(), '--cgroup-parent', parent]
    );
    const original = this.identity(this.start(anchorOwned));
    anchorOwned.identity = original;
    this.evidence.save('anchor-birth', original);
    const initial = this.probe(original);
    const cpus = initial.resources.cpusetCpusEffective.split(',')[0].split('-')[0];
    assert.match(cpus, /^[0-9]+$/u);
    const configured = this.configurePool('pool', original, initial, cpus);
    const anchor = this.restartOwned(anchorOwned, original);
    const after = this.configurePool('cold-pool', anchor, this.probe(anchor), cpus);
    assert.deepEqual(after.resources, configured.resources);
    this.evidence.save('cold-pool-accepted', { before: configured, after });
    const flags = this.common();
    flags[flags.indexOf('--memory') + 1] = '268435456';
    flags[flags.indexOf('--memory-swap') + 1] = '268435456';
    const workerOwned = this.create(
      'worker',
      this.baseline,
      ['anchor'],
      ['--cgroup-parent', parent, '--cpuset-cpus', cpus],
      flags
    );
    let worker = this.identity(this.start(workerOwned));
    workerOwned.identity = worker;
    this.evidence.save('worker-birth', worker);
    let current = this.probe(anchor, worker);
    this.write('initial-high', this.baseline, anchor, worker, current, cpus, 67108864, 100);
    current = this.probe(anchor, worker);
    assert.equal(current.resources.memoryHigh, '67108864');
    assert.equal(current.resources.cpuWeight, '100');
    worker = this.restoreWorkerHigh(workerOwned, worker, anchor, cpus, current);
    current = this.probe(anchor, worker);
    this.write('cpu-calibration', this.baseline, anchor, worker, current, cpus, 67108864, 217);
    const before = this.probe(anchor, worker);
    assert.equal(before.resources.cpuWeight, '217');
    const refused = this.write(
      'cpu-drift-refusal',
      this.writer,
      anchor,
      worker,
      before,
      cpus,
      134217728,
      100,
      false
    ) as Outcome;
    assert.match(refused.stderr, /BOXED_RESOURCE_OTHER_POLICY_MISMATCH/u);
    assert.deepEqual(this.probe(anchor, worker), before);
    const ack = this.write('raise-high', this.writer, anchor, worker, before, cpus, 134217728, 217);
    const raised = this.probe(anchor, worker);
    requireOnlyHighChanged(before, raised, '134217728');
    assert.deepEqual(ack, raised);
    this.write('restore-high', this.writer, anchor, worker, raised, cpus, 67108864, 217);
    const restored = this.probe(anchor, worker);
    assert.deepEqual(restored, before);
    requireIdentity(this.identity(this.inspect(worker.id)), worker);
    requireIdentity(this.identity(this.inspect(anchor.id)), anchor);
    assert.ok(isDeepStrictEqual(this.image(this.baseline), baseBefore));
    this.evidence.save('native-accepted', {
      before,
      raised,
      restored,
      cpuDriftRefusedBeforeWrite: true,
      baselineImageUnchanged: true,
      companyAcceptance: false,
    });
  }
  cleanup(): void {
    for (const owned of [...this.owned].reverse()) {
      const row = this.inspect(owned.id);
      requireOwned(row, owned, this.box);
      if (row.State.Running) {
        assert.ok(owned.identity, 'Unknown helper incarnation retained');
        requireIdentity(this.identity(row), owned.identity);
        this.command('stop-owned-' + owned.role, ['stop', '--time', '3', owned.id]);
      }
      const stopped = this.inspect(owned.id);
      requireOwned(stopped, owned, this.box);
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.Pid, 0);
      assert.ok(['created', 'exited'].includes(stopped.State.Status), 'Unknown terminal state retained');
      this.command('remove-owned-' + owned.role, ['rm', owned.id]);
      const absent = this.command('confirm-absent-' + owned.role, [
        'container',
        'ls',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        'id=' + owned.id,
      ]);
      assert.equal(absent.stdout.trim(), '');
    }
    this.evidence.save('cleanup-complete', {
      removed: this.owned.map((row) => row.id),
      noBroadSelectors: true,
    });
    if (this.baselineSnapshot)
      assert.deepEqual(
        this.image(this.baseline),
        this.baselineSnapshot,
        'Baseline image must also remain unchanged after scoped cleanup'
      );
  }
}
export function runMemoryHighCanary(baseline: string, writer: string, output: string): void {
  requireImageId(baseline);
  requireImageId(writer);
  assert.notEqual(baseline, writer);
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const evidence = new Evidence(output);
  const failures: unknown[] = [];
  let canary: NativeCanary | undefined;
  try {
    canary = new NativeCanary(evidence, baseline, writer);
    canary.run();
  } catch (error) {
    failures.push(error);
    try {
      evidence.save('native-failure', { message: String(error), noAutomaticRetry: true });
    } catch (recordError) {
      failures.push(recordError);
    }
  }
  try {
    canary?.cleanup();
  } catch (error) {
    failures.push(error);
    try {
      evidence.save('cleanup-failure', { message: String(error), noBroadCleanup: true });
    } catch (recordError) {
      failures.push(recordError);
    }
  }
  try {
    evidence.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Real helper acceptance failed; original receipts retained');
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 3, 'Expected baseline-image writer-image NEW-evidence-directory');
  runMemoryHighCanary(args[0], args[1], args[2]);
  process.stdout.write(
    JSON.stringify({
      status: 0,
      purpose: 'docker-memory-high-native-v1',
      companyAcceptance: false,
    }) + '\n'
  );
}
