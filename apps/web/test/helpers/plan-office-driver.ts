/** Owned CI office baseline only. No production admission or paid provider override. */
import { runPlanOfficeMoveScenario } from './plan-office-move-driver.js';
export { runPlanOfficeMoveScenario };
import { verifyPlanOfficeMovedProvider, planOfficeCanonicalAuthDigest } from './plan-office-move-verifier.js';
export { verifyPlanOfficeMovedProvider, planOfficeCanonicalAuthDigest };
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlanOfficeBootstrap } from './plan-office-bootstrap.js';
import { enrollIsolatedPlanOfficeOwner } from './docker-continuation-auth-canary.js';
import { dockerContinuationDigest } from '../../src/docker-employee-continuation.js';
import { nativeThreadProfile } from '../../src/utils/native-thread-profile.js';
import { dockerPlanGeneration } from '../../src/docker-plan-install-data.js';
import { boxedOriginal, DockerEmployeeInspect } from '../../src/docker-employee-engine-data.js';
import type { SessionState } from '../../src/types.js';
import {
  DockerEmployeeResourcePolicy,
  DockerEmployeeContinuationRequest,
  DockerEmployeeContinuationPhase,
  DockerEmployeeContinuationRecord,
} from '../../src/docker-employee-continuation-data.js';
const id = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  cid = z.string().regex(/^[a-f0-9]{64}$/);
const store = z.string().regex(/^\/nix\/store\/[a-z0-9]{32}-[^/]+$/);
export const PlanOfficeDriverInput = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-plan-office-baseline-v1'),
    acceptance: z.enum(['baseline', 'ordinary-self']).default('baseline'),
    instance: z.string().regex(/^[a-f0-9]{32}$/),
    sourcePath: store,
    runtimePath: store,
    platformClosure: store,
    sourceImageId: id,
    workerImageId: id,
    helperImageId: id,
    controlImageId: id,
    clientManifestDigest: hash,
    bootstrap: PlanOfficeBootstrap,
    sourceProviders: z
      .array(
        z
          .object({
            employeeId: z.string().uuid(),
            mode: z.enum(['ordinary', 'exhausted', 'rotate-a', 'pause-approval']),
          })
          .strict()
      )
      .max(2)
      .default([]),
    sourceLayouts: z
      .array(
        z
          .object({
            employeeId: z.string().uuid(),
            layout: z.enum(['employees', 'operator-recovery', 'operator-sessions']),
            missingEphemeral: z.boolean().default(false),
          })
          .strict()
      )
      .max(2)
      .default([]),
  })
  .strict()
  .refine(
    (v) =>
      (v.acceptance !== 'ordinary-self' ||
        (v.bootstrap.employees.length === 1 &&
          v.bootstrap.employees[0]!.account === 'ci-plan-a' &&
          v.bootstrap.employees[0]!.permissions.moveOwnPlan === true &&
          v.bootstrap.employees[0]!.permissions.managePlans !== true &&
          (v.sourceProviders.find((row) => row.employeeId === v.bootstrap.employees[0]!.employeeId)?.mode ??
            'ordinary') === 'ordinary')) &&
      v.bootstrap.employees.length <= 2 &&
      new Set(v.sourceProviders.map((row) => row.employeeId)).size === v.sourceProviders.length &&
      v.sourceProviders.every((row) =>
        v.bootstrap.employees.some((employee) => employee.employeeId === row.employeeId)
      ) &&
      new Set(v.sourceLayouts.map((row) => row.employeeId)).size === v.sourceLayouts.length &&
      v.sourceLayouts.every((row) => v.bootstrap.employees.some((employee) => employee.employeeId === row.employeeId))
  );

type Input = z.infer<typeof PlanOfficeDriverInput>;
type Json = Record<string, unknown>;
/** Fake-only preparation DATA. Rotation is a negative case until principal proof exists. */
export function planOfficeProviderMode(mode: 'ordinary' | 'exhausted' | 'rotate-a' | 'pause-approval') {
  z.enum(['ordinary', 'exhausted', 'rotate-a', 'pause-approval']).parse(mode);
  return {
    autoApprove: mode !== 'exhausted',
    exhausted: mode === 'exhausted',
    refreshAccountId: mode === 'rotate-a' ? 'ci-plan-a' : null,
    pauseBeforeApproval: mode === 'pause-approval',
  };
}
export function planOfficeScratchParts(
  employee: { employeeId: string; sessionId: string },
  layout: 'employees' | 'operator-recovery' | 'operator-sessions'
) {
  z.string().uuid().parse(employee.employeeId);
  z.string().uuid().parse(employee.sessionId);
  return ['laptops', layout, layout === 'employees' ? employee.employeeId : employee.sessionId];
}
export function removeEmptyPlanOfficeScratch(scratch: string, assertInert: () => void) {
  assertInert();
  const tmp = path.join(scratch, 'tmp');
  privateDirectory(scratch);
  privateDirectory(tmp);
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.deepEqual(fs.readdirSync(scratch), ['tmp']);
  fs.rmdirSync(tmp);
  fs.rmdirSync(scratch);
  const parent = fs.openSync(
    path.dirname(scratch),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
export function planOfficeNames(instance: string) {
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(instance);
  const prefix = 'reverie-ci-plan-office-' + instance;
  return {
    prefix,
    front: prefix + '-front',
    network: prefix + '-workers',
    control: prefix + '-control',
    seed: prefix + '-seed',
  };
}
export const PLAN_OFFICE_CPU_PROGRAM =
  "process.stdout.write(require('node:fs').readFileSync('/proc/self/status','utf8').split(String.fromCharCode(10)).find(line=>line.startsWith('Cpus_allowed_list:')).split(':')[1].trim())";
export function parsePlanOfficeCpus(text: string) {
  assert.match(
    text,
    /^(?:0|[1-9][0-9]{0,3})(?:-(?:0|[1-9][0-9]{0,3}))?(?:,(?:0|[1-9][0-9]{0,3})(?:-(?:0|[1-9][0-9]{0,3}))?)*$/
  );
  const cpus: number[] = [];
  for (const part of text.split(',')) {
    const [low, high = low] = part.split('-').map(Number);
    assert.ok(low !== undefined && high !== undefined && low <= high && high <= 4095);
    for (let n = low!; n <= high!; n++) cpus.push(n);
  }
  return z
    .array(z.number().int().min(0).max(4095))
    .min(1)
    .max(256)
    .refine((v) => v.every((n, i) => i === 0 || v[i - 1]! < n))
    .parse(cpus);
}
export function ciPlanPolicy(allowedCpus: unknown) {
  return DockerEmployeeResourcePolicy.parse({
    memoryMaxBytes: 512 * 1024 ** 2,
    memoryHighBytes: 384 * 1024 ** 2,
    swapMaxBytes: 0,
    pidsMax: 256,
    cpuWeight: 100,
    allowedCpus,
    pool: { memoryMaxBytes: 2 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 1024, cpuWeight: 100, allowedCpus },
  });
}
export function requireOriginalPolicy(
  value: unknown,
  employee: z.infer<typeof PlanOfficeBootstrap>['employees'][number],
  source: string,
  worker: string
) {
  const v = z
    .object({
      sessionId: z.literal(employee.sessionId),
      sessionGeneration: z.number().int().positive(),
      sourceDigest: hash,
      containerId: z.literal(source),
      imageId: id,
      destinationImageId: z.literal(worker),
      operationId: z.null(),
    })
    .passthrough()
    .parse(value);
  return v;
}
export function requireSameOperation(value: unknown, operationId: string) {
  return z
    .object({
      operationId: z.literal(operationId),
      phase: DockerEmployeeContinuationPhase,
      state: z.enum(['ready', 'pending', 'held']),
      allowedActions: z.array(z.enum(['observe', 'continue'])),
    })
    .passthrough()
    .parse(value);
}
function privateDirectory(file: string) {
  const st = fs.lstatSync(file);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.equal(st.uid, process.getuid?.());
  assert.equal(st.gid, process.getgid?.());
  assert.equal(st.mode & 0o777, 0o700);
}
function readPrivate(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    assert.ok(st.isFile());
    assert.equal(st.nlink, 1);
    assert.equal(st.uid, process.getuid?.());
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(st.size > 0 && st.size <= 65536);
    const bytes = fs.readFileSync(fd);
    assert.equal(bytes.length, st.size);
    assert.equal(fs.fstatSync(fd).ino, st.ino);
    const text = bytes.toString('utf8');
    assert.ok(Buffer.from(text).equals(bytes));
    return JSON.parse(text) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}
function pinned(file: string) {
  assert.ok(file.startsWith('/nix/store/'));
  assert.equal(fs.realpathSync(file), file);
  const st = fs.lstatSync(file);
  assert.equal(st.uid, 0);
  assert.equal(st.mode & 0o222, 0);
  return st;
}
export function requirePlanOfficeImage(row: Json, input: Input, role: 'source' | 'worker' | 'helper' | 'control') {
  const names = planOfficeNames(input.instance),
    expected = input[(role + 'ImageId') as 'sourceImageId'];
  assert.equal(row.Id, expected);
  assert.equal(row.Os, 'linux');
  assert.equal(row.Architecture, 'amd64');
  assert.ok(Array.isArray(row.RepoTags) && row.RepoTags.includes(names.prefix + '-' + role + ':latest'));
  const cfg = row.Config as Json;
  assert.ok(cfg && typeof cfg === 'object');
  if (role === 'helper') {
    assert.deepEqual(cfg.Entrypoint, ['/bin/reverie-docker-resources']);
    assert.deepEqual(cfg.Labels, { 'org.reverie.purpose': 'boxed-resource-helper-v1' });
  } else {
    assert.equal((cfg.Labels as Json)['org.reverie.fixture'], 'ci-plan-office-v1');
    if (role === 'control') {
      assert.deepEqual(cfg.Cmd, ['web', '--host', '0.0.0.0', '--port', '3000']);
      const entries = z.array(z.string()).length(2).parse(cfg.Entrypoint);
      assert.ok(entries[0]!.startsWith('/nix/store/'));
      assert.equal(entries[1], input.runtimePath + '/lib/reverie/dist/index.js');
    } else {
      assert.deepEqual(cfg.Entrypoint, ['/opt/reverie/perf/bin/reverie-worker-init']);
      assert.ok(cfg.Cmd == null || (Array.isArray(cfg.Cmd) && cfg.Cmd.length === 0));
      assert.equal((cfg.Labels as Json)['org.reverie.worker-client.manifest'], input.clientManifestDigest);
    }
  }
  return cfg;
}
export function requirePlanOfficeContainer(actual: Json, expected: Json, imageLabels: Json = {}) {
  assert.equal(actual.Image, expected.Image);
  const cfg = actual.Config as Json,
    host = actual.HostConfig as Json,
    want = expected.HostConfig as Json;
  assert.equal(cfg.User, expected.User);
  assert.equal(cfg.WorkingDir, expected.WorkingDir);
  assert.deepEqual(cfg.Entrypoint, expected.Entrypoint);
  assert.deepEqual(cfg.Cmd ?? [], expected.Cmd ?? []);
  assert.deepEqual(cfg.Env, expected.Env);
  assert.deepEqual(cfg.Labels, { ...imageLabels, ...(expected.Labels as Json) });
  for (const key of ['ReadonlyRootfs', 'Privileged', 'NetworkMode']) assert.equal(host[key], want[key]);
  assert.deepEqual(host.CapDrop, ['ALL']);
  assert.deepEqual(host.CapAdd ?? [], []);
  assert.deepEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 });
  assert.ok(
    Array.isArray(host.SecurityOpt) &&
      host.SecurityOpt.length === 1 &&
      ['no-new-privileges:true', 'no-new-privileges'].includes(host.SecurityOpt[0] as string)
  );
  const mounts = actual.Mounts as Json[],
    wanted = (want.Mounts ?? []) as Json[];
  const bindings = mounts.filter((m) => m.Type === 'bind');
  assert.equal(bindings.length, wanted.length);
  for (const mount of mounts.filter((m) => m.Type !== 'bind'))
    assert.ok(mount.Type === 'tmpfs' && Object.hasOwn((want.Tmpfs ?? {}) as Json, mount.Destination as string));
  assert.deepEqual(host.Tmpfs ?? {}, want.Tmpfs ?? {});
  assert.deepEqual(host.GroupAdd ?? [], want.GroupAdd ?? []);
  assert.deepEqual(host.Devices ?? [], []);
  assert.equal(host.PidMode ?? '', '');
  assert.equal(host.UTSMode ?? '', '');
  for (const mount of wanted) {
    const found = mounts.filter((m) => m.Destination === mount.Target);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.Type, 'bind');
    assert.equal(found[0]!.Source, mount.Source);
    assert.equal(found[0]!.RW, mount.ReadOnly !== true);
    assert.equal(found[0]!.Propagation, 'rprivate');
    const hostMount = (host.Mounts as Json[]).find((m) => m.Target === mount.Target);
    assert.ok(hostMount);
    assert.equal((hostMount.BindOptions as Json).NonRecursive, true);
    assert.equal((hostMount.BindOptions as Json).Propagation, 'rprivate');
  }
}
/** Read only the actual advertised internal Host before consuming a provider intent. */
export async function planOfficeInternalHostPreflight(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) >= 1024);
  assert.equal(url.pathname, '/');
  assert.equal(url.search + url.hash + url.username + url.password, '');
  await new Promise<void>((resolve, reject) => {
    const call = request(
      new URL('/api/owner/status', url),
      { method: 'GET', headers: { host: 'reverie:3000' } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (part: string) => {
          text += part;
          if (Buffer.byteLength(text) > 8192) call.destroy(Error('Internal Host response bound'));
        });
        response.once('error', reject);
        response.once('aborted', () => reject(Error('Internal Host response unconfirmed')));
        response.once('end', () => {
          try {
            assert.equal(response.complete, true);
            assert.equal(response.statusCode, 200, 'Advertised internal API Host refused');
            assert.equal(JSON.parse(text).success, true);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    call.setTimeout(5000, () => call.destroy(Error('Internal Host preflight deadline')));
    call.once('error', reject);
    call.end();
  });
}
class Evidence {
  readonly fd: number;
  serial = 0;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { mode: 0o700 });
    privateDirectory(root);
    this.fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  }
  current() {
    const a = fs.fstatSync(this.fd),
      b = fs.lstatSync(this.root);
    assert.ok(b.isDirectory() && !b.isSymbolicLink());
    assert.equal(a.dev, b.dev);
    assert.equal(a.ino, b.ino);
    assert.equal(a.uid, b.uid);
    assert.equal(a.uid, process.getuid?.());
    assert.equal(a.gid, process.getgid?.());
    assert.equal(b.mode & 0o777, 0o700);
  }
  save(name: string, value: unknown) {
    this.current();
    assert.match(name, /^[A-Za-z0-9_-]+$/);
    const fd = fs.openSync('/proc/self/fd/' + this.fd + '/' + name + '.json', 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.fsyncSync(this.fd);
  }
  close() {
    fs.closeSync(this.fd);
  }
}
class Driver {
  readonly names;
  readonly user;
  readonly images = new Map<string, Json>();
  readonly configs = new Map<string, Json>();
  readonly ids: string[] = [];
  readonly createdConfigurations = new Map<string, Json>();
  constructor(
    readonly input: Input,
    readonly evidence: Evidence,
    readonly dockerExecutable: string
  ) {
    this.names = planOfficeNames(input.instance);
    assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
    this.user = process.getuid!() + ':' + process.getgid!();
  }
  docker(args: string[], input?: string) {
    const key = String(++this.evidence.serial).padStart(3, '0');
    this.evidence.save(key + '-intent', {
      args,
      stdin: input === undefined ? 'none' : 'bounded synthetic metadata only',
    });
    const r = spawnSync(this.dockerExecutable, ['--host', 'unix:///var/run/docker.sock', ...args], {
      input,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: path.dirname(this.dockerExecutable), HOME: this.evidence.root, DOCKER_CONFIG: this.evidence.root },
    });
    this.evidence.save(key + '-result', {
      status: r.status,
      signal: r.signal,
      error: r.error?.message,
      stdout: r.stdout,
      stderr: r.stderr,
    });
    assert.equal(r.error, undefined, 'Original Docker outcome unknown; no replay');
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
  inspect(id: string) {
    cid.parse(id);
    const rows = JSON.parse(this.docker(['container', 'inspect', id])) as Json[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.Id, id);
    return rows[0]!;
  }
  owned(id: string, role: string) {
    const row = this.inspect(id),
      labels = (row.Config as Json).Labels as Json;
    assert.equal(labels['reverie.disposable'], this.input.instance);
    assert.equal(labels['reverie.task'], 'plan-office-baseline-v1');
    assert.equal(labels['reverie.role'], role);
    assert.equal((row.Config as Json).User, this.user);
    const expected = this.createdConfigurations.get(id);
    assert.ok(expected);
    requirePlanOfficeContainer(row, expected, (this.configs.get(expected.Image as string)?.Labels ?? {}) as Json);
    return row;
  }
  labels(role: string) {
    return {
      'reverie.disposable': this.input.instance,
      'reverie.task': 'plan-office-baseline-v1',
      'reverie.role': role,
    };
  }
  async create(name: string, configuration: Json) {
    assert.ok(name.startsWith(this.names.prefix + '-'));
    this.evidence.save('create-' + name, { name, configuration });
    const bytes = Buffer.from(JSON.stringify(configuration));
    const result = await new Promise<string>((resolve, reject) => {
      const call = request(
        {
          socketPath: '/var/run/docker.sock',
          method: 'POST',
          path: '/v1.45/containers/create?name=' + encodeURIComponent(name),
          headers: { 'content-type': 'application/json', 'content-length': bytes.length },
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (s: string) => {
            data += s;
            if (data.length > 65536) call.destroy(Error('Create body bound'));
          });
          response.on('error', reject);
          response.on('aborted', () => reject(Error('Create outcome unknown')));
          response.on('end', () => {
            try {
              assert.equal(response.complete, true);
              assert.equal(response.statusCode, 201);
              resolve(cid.parse(JSON.parse(data).Id));
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      call.setTimeout(10000, () => call.destroy(Error('Create outcome unknown')));
      call.on('error', reject);
      call.end(bytes);
    });
    this.evidence.save('created-' + name, { id: result, name, configuration });
    this.ids.push(result);
    this.createdConfigurations.set(result, configuration);
    const row = this.inspect(result);
    requirePlanOfficeContainer(
      row,
      configuration,
      (this.configs.get(configuration.Image as string)?.Labels ?? {}) as Json
    );
    assert.equal(row.Image, configuration.Image);
    assert.equal(row.Name, '/' + name);
    assert.equal((row.State as Json).Pid, 0);
    assert.equal((row.State as Json).Status, 'created');
    assert.equal((row.State as Json).Running, false);
    return result;
  }
  safety(network = 'none'): Json {
    return {
      ReadonlyRootfs: true,
      Privileged: false,
      NetworkMode: network,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    };
  }
  async metadata(role: string, image: string, entry: string[], mounts: Json[], input?: unknown) {
    const name = this.names.prefix + '-' + role,
      cfg = this.configs.get(image)!;
    const id = await this.create(name, {
      Image: image,
      User: this.user,
      Entrypoint: entry,
      Cmd: [],
      WorkingDir: '/tmp',
      Env: cfg.Env,
      Labels: this.labels(role),
      OpenStdin: input !== undefined,
      StdinOnce: input !== undefined,
      HostConfig: { ...this.safety(), Mounts: mounts },
    });
    this.owned(id, role);
    this.evidence.save('start-' + role, { id });
    const output = this.docker(
      ['start', '--attach', ...(input === undefined ? [] : ['--interactive']), id],
      input === undefined ? undefined : JSON.stringify(input) + '\n'
    );
    const row = this.owned(id, role),
      state = row.State as Json;
    assert.equal(state.Running, false);
    assert.equal(state.Pid, 0);
    assert.equal(state.ExitCode, 0);
    return JSON.parse(output.trim()) as Json;
  }
  async network(name: string, internal: boolean) {
    this.evidence.save('network-' + name, { name, internal });
    const id = this.docker([
      'network',
      'create',
      '--driver',
      'bridge',
      ...(internal ? ['--internal'] : []),
      '--opt',
      'com.docker.network.bridge.enable_icc=true',
      '--label',
      'reverie.disposable=' + this.input.instance,
      '--label',
      'reverie.task=plan-office-baseline-v1',
      name,
    ]).trim();
    cid.parse(id);
    const rows = JSON.parse(this.docker(['network', 'inspect', id]));
    assert.equal(rows[0].Id, id);
    assert.equal(rows[0].Name, name);
    assert.equal(rows[0].Internal, internal);
    assert.equal(rows[0].Labels['reverie.disposable'], this.input.instance);
    assert.equal(rows[0].Options['com.docker.network.bridge.enable_icc'], 'true');
    return id;
  }
  bind(source: string, target: string, readOnly = false): Json {
    return {
      Type: 'bind',
      Source: source,
      Target: target,
      ...(readOnly ? { ReadOnly: true } : {}),
      BindOptions: { Propagation: 'rprivate', NonRecursive: true },
    };
  }
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
class OwnerApiRefusal extends Error {
  constructor(
    readonly status: number,
    readonly response: Json
  ) {
    super('Owned fixture API refused; exact body retained privately');
  }
}
async function data(response: Response) {
  const value = (await response.json()) as Json;
  if (!response.ok || value.success !== true) throw new OwnerApiRefusal(response.status, value);
  return value.data as Json;
}
export async function planOfficeSession(response: Response, sessionId: string) {
  z.string().uuid().parse(sessionId);
  const session = await data(response);
  assert.equal(session.id, sessionId);
  return session;
}
export async function planOfficeOriginalStatus(response: Response, operationId: string) {
  const selection = await data(response);
  assert.equal(selection.operationId, operationId);
  requireSameOperation(selection.operation, operationId);
  return selection;
}
/** Thin fixture recovery client. Only a fresh product-native observation can
 * offer continuation. An unknown mutation switches this invocation to observation
 * only; no HTTP status, historical phase or local filesystem implies permission. */
export async function completePlanOfficeOriginal(
  expected: { request: z.infer<typeof DockerEmployeeContinuationRequest>; sourceDigest: string },
  knownMutationReply: boolean,
  ports: {
    observe(): Promise<unknown>;
    continueOriginal(
      body: { request: z.infer<typeof DockerEmployeeContinuationRequest> },
      phase: string
    ): Promise<unknown>;
    record(name: string, value: unknown): void;
    pause(): Promise<void>;
  }
) {
  const original = Object.freeze(DockerEmployeeContinuationRequest.parse(expected.request));
  hash.parse(expected.sourceDigest);
  const attempted = new Set<string>();
  const continuable = new Set([
    'staged',
    'office-ready',
    'pool-ready',
    'destination-ready',
    'container-running',
    'resources-ready',
    'identity-ready',
  ]);
  for (let index = 0; index < 180; index++) {
    let seen: Json;
    try {
      seen = z.record(z.string(), z.unknown()).parse(await ports.observe());
    } catch (error) {
      if (!(error instanceof Error) || !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      ports.record('read-timeout-' + index, { operationId: original.operationId, readOnly: true });
      await ports.pause();
      continue;
    }
    assert.equal(seen.operationId, original.operationId);
    const operation = requireSameOperation(seen.operation, original.operationId);
    ports.record('original-' + index, operation);
    if (operation.state === 'ready') return operation;
    if (
      knownMutationReply &&
      operation.state === 'pending' &&
      operation.allowedActions.includes('continue') &&
      continuable.has(operation.phase) &&
      !attempted.has(operation.phase)
    ) {
      for (const [key, value] of Object.entries({
        sessionId: original.sessionId,
        sessionGeneration: original.sessionGeneration,
        containerId: original.containerId,
        imageId: original.imageId,
        destinationImageId: original.expectedDestinationImageId,
        sourceDigest: expected.sourceDigest,
      }))
        assert.deepEqual(seen[key], value, 'Original recovery scope changed: ' + key);
      const body = { request: structuredClone(original) };
      // Checked durable publication must complete before the sole request for this phase.
      ports.record('continue-' + operation.phase + '-intent', {
        operationId: original.operationId,
        phase: operation.phase,
        body,
        noPolicyApproval: true,
      });
      attempted.add(operation.phase);
      try {
        const result = requireSameOperation(await ports.continueOriginal(body, operation.phase), original.operationId);
        ports.record('continue-' + operation.phase + '-returned', result);
      } catch (error) {
        knownMutationReply = false;
        ports.record('continue-' + operation.phase + '-unknown', {
          operationId: original.operationId,
          errorType: error instanceof Error ? error.name : 'unknown',
          noRetry: true,
        });
      }
    } else if (operation.state === 'held' && operation.code !== 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED') {
      throw Error('Original recovery held; inspect saved operation, never begin again');
    }
    await ports.pause();
  }
  throw Error('Original recovery not confirmed Ready; observe original operation, never begin again');
}
/** Effects are reachable only in the immutable composed package and for explicit qualified image IDs. */
export async function runPlanOfficeBaseline(contractFile: string) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
  assert.ok(path.isAbsolute(contractFile));
  privateDirectory(path.dirname(contractFile));
  const input = PlanOfficeDriverInput.parse(readPrivate(contractFile));
  assert.equal(
    fileURLToPath(import.meta.url),
    input.runtimePath + '/lib/reverie/test/helpers/plan-office-driver.js',
    'Use the immutable CI package, never mutable checkout effects'
  );
  assert.ok(pinned(input.runtimePath).isDirectory());
  assert.ok(pinned(input.sourcePath).isDirectory());
  assert.ok(pinned(input.platformClosure).isDirectory());
  const metadata = JSON.parse(fs.readFileSync(path.join(input.runtimePath, 'metadata.json'), 'utf8'));
  assert.equal(metadata.version, 1);
  assert.equal(metadata.purpose, 'reverie-ci-plan-office-build-v1');
  assert.ok(pinned(metadata.dockerExecutable).isFile());
  assert.ok(pinned(metadata.nodeExecutable).isFile());
  assert.equal(fs.realpathSync(process.execPath), metadata.nodeExecutable);
  assert.equal(metadata.sourcePath, input.sourcePath);
  const evidence = new Evidence(path.join(path.dirname(contractFile), 'office-' + input.instance)),
    driver = new Driver(input, evidence, metadata.dockerExecutable),
    names = driver.names;
  try {
    evidence.save('plan', {
      ...input,
      limitation:
        input.acceptance === 'baseline'
          ? 'Fake external model; real owner/API/Engine/native/HMAC baseline only.'
          : 'Fake external model; one ordinary self move only after actual physical verification. No paid vendor, refreshed principal or force acceptance.',
    });
    const census = driver.docker(['container', 'ls', '--all', '--no-trunc', '--format', 'json']);
    const before = census
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Json);
    evidence.save(
      'preexisting-container-census',
      before.map((row) => ({ id: row.ID, image: row.Image, state: row.State, names: row.Names }))
    );
    for (const role of ['source', 'worker', 'helper', 'control'] as const) {
      const image = input[(role + 'ImageId') as 'sourceImageId'],
        rows = JSON.parse(driver.docker(['image', 'inspect', image]));
      assert.equal(rows.length, 1);
      driver.configs.set(image, requirePlanOfficeImage(rows[0], input, role));
      driver.images.set(role, rows[0]);
    }
    const srcLayers = (driver.images.get('source')!.RootFS as Json).Layers as string[],
      targetLayers = (driver.images.get('worker')!.RootFS as Json).Layers as string[];
    assert.ok(srcLayers.length > 0);
    assert.deepEqual(targetLayers.slice(0, srcLayers.length), srcLayers);
    const mkdir = (...parts: string[]) => {
      const target = path.join(evidence.root, ...parts);
      fs.mkdirSync(target, { mode: 0o700 });
      privateDirectory(target);
      return target;
    };
    for (const folder of ['home', 'data', 'accounts', 'auth', 'scratch', 'workers']) mkdir(folder);
    for (const account of ['plan-a', 'plan-b']) mkdir('accounts', account);
    mkdir('scratch', 'laptops');
    for (const layout of ['employees', 'operator-recovery', 'operator-sessions']) mkdir('scratch', 'laptops', layout);
    const bootstrapFile = path.join(evidence.root, 'plan-office-bootstrap.json');
    fs.writeFileSync(bootstrapFile, JSON.stringify(input.bootstrap) + '\n', { flag: 'wx', mode: 0o600 });
    const controlCfg = driver.configs.get(input.controlImageId)!,
      controlNode = (controlCfg.Entrypoint as string[])[0]!;
    await driver.metadata(
      'seed',
      input.controlImageId,
      [controlNode, input.runtimePath + '/lib/reverie/plan-office-bootstrap.mjs'],
      [driver.bind(evidence.root, '/fixture')]
    );
    const front = await driver.network(names.front, false),
      network = await driver.network(names.network, true),
      sources: Json[] = [];
    const closures = fs.readFileSync(path.join(input.platformClosure, 'store-paths'), 'utf8').trim().split('\n');
    assert.ok(closures.length > 0 && closures.length <= 4096);
    for (const item of closures) {
      store.parse(item);
      pinned(item);
    }
    for (const employee of input.bootstrap.employees) {
      mkdir('workers', employee.employeeId);
      const home = mkdir('workers', employee.employeeId, 'home'),
        nix = mkdir('workers', employee.employeeId, 'nix'),
        workspace = mkdir('workers', employee.employeeId, 'workspace');
      mkdir('workers', employee.employeeId, 'workspace', 'cases');
      mkdir('workers', employee.employeeId, 'workspace', 'cases', 'boxed-canary');
      const nixStore = mkdir('workers', employee.employeeId, 'nix', 'store');
      for (const item of closures)
        fs.cpSync(item, path.join(nixStore, path.basename(item)), {
          recursive: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
          errorOnExist: true,
          force: false,
        });
      const layout = input.sourceLayouts.find((row) => row.employeeId === employee.employeeId)?.layout ?? 'employees';
      const scratchParts = planOfficeScratchParts(employee, layout);
      const scratch = mkdir('scratch', ...scratchParts),
        tmp = mkdir('scratch', ...scratchParts, 'tmp');
      const prepared = await driver.metadata(
        'prep-' + employee.employeeId,
        input.workerImageId,
        ['/opt/reverie-worker-client/bin/node', '/opt/reverie-ci-plan-provider/lib/prepare-home.mjs'],
        [driver.bind(home, '/home/agent')],
        {
          version: 1,
          purpose: 'reverie-ci-plan-worker-home-v1',
          sessionId: employee.sessionId,
          nativeThreadId: employee.nativeThreadId,
          initialAccountId: employee.account,
          provider: {
            version: 1,
            purpose: 'reverie-ci-plan-provider-v1',
            employeeId: employee.employeeId,
            accounts: ['ci-plan-a', 'ci-plan-b'],
            ...planOfficeProviderMode(
              input.sourceProviders.find((row) => row.employeeId === employee.employeeId)?.mode ?? 'ordinary'
            ),
          },
        }
      );
      assert.equal(prepared.purpose, 'synthetic-plan-worker-home-prepared-v1');
      assert.equal(prepared.sessionId, employee.sessionId);
      assert.equal(prepared.nativeThreadId, employee.nativeThreadId);
      const proof = prepared.home as Json,
        actual = fs.lstatSync(home);
      assert.equal(proof.dev, String(actual.dev));
      assert.equal(proof.ino, String(actual.ino));
      assert.equal(proof.uid, process.getuid!());
      const cfg = driver.configs.get(input.sourceImageId)!;
      const source = await driver.create(names.prefix + '-source-' + employee.employeeId, {
        Image: input.sourceImageId,
        User: driver.user,
        Entrypoint: cfg.Entrypoint,
        Cmd: [],
        WorkingDir: '/reverie_workspace/cases/boxed-canary',
        Env: [...(cfg.Env as string[]), 'REVERIE_API_URL=http://reverie:3000'],
        Labels: {
          ...driver.labels('source'),
          'reverie.worker': names.prefix,
          'reverie.employee': employee.employeeId,
          'reverie.session': employee.sessionId,
        },
        HostConfig: {
          ...driver.safety(network),
          Mounts: [
            driver.bind(home, '/home/agent'),
            driver.bind(nix, '/nix'),
            driver.bind(workspace, '/reverie_workspace'),
            driver.bind(scratch, '/scratch'),
            driver.bind(tmp, '/tmp'),
          ],
        },
      });
      const persistent = { home, nix, workspace };
      const beforePersistent = Object.fromEntries(
        Object.entries(persistent).map(([key, file]) => {
          const st = fs.lstatSync(file);
          return [key, { dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }];
        })
      );
      if (input.sourceLayouts.find((row) => row.employeeId === employee.employeeId)?.missingEphemeral) {
        evidence.save('missing-ephemeral-intent-' + employee.employeeId, {
          source,
          scratch,
          tmp,
          onlyNewEmptyFixture: true,
        });
        removeEmptyPlanOfficeScratch(scratch, () => {
          const original = driver.owned(source, 'source');
          assert.equal((original.State as Json).Status, 'created');
          assert.equal((original.State as Json).Pid, 0);
          assert.equal((original.State as Json).Running, false);
        });
        evidence.save('missing-ephemeral-complete-' + employee.employeeId, { source, scratch, tmp });
      }
      sources.push({ employee, source, home, persistent, beforePersistent, scratch, tmp });
    }
    const socket = fs.lstatSync('/var/run/docker.sock');
    assert.ok(socket.isSocket());
    const control = await driver.create(names.control, {
      Image: input.controlImageId,
      User: driver.user,
      Entrypoint: controlCfg.Entrypoint,
      Cmd: controlCfg.Cmd,
      Env: controlCfg.Env,
      WorkingDir: '/fixture',
      Labels: driver.labels('control'),
      ExposedPorts: { '3000/tcp': {} },
      HostConfig: {
        ...driver.safety(front),
        GroupAdd: [String(socket.gid)],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,mode=1777' },
        Mounts: [
          driver.bind(evidence.root, '/fixture'),
          driver.bind(path.join(evidence.root, 'scratch'), '/scratch'),
          driver.bind('/var/run/docker.sock', '/run/reverie-engine/docker.sock', true),
        ],
        PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
      },
    });
    driver.docker(['network', 'connect', '--alias', 'reverie', network, control]);
    driver.owned(control, 'control');
    evidence.save('control-start-issued', { control });
    driver.docker(['start', control]);
    const running = driver.owned(control, 'control');
    assert.equal((running.State as Json).Running, true);
    const ports = (running.NetworkSettings as Json).Ports as Record<string, { HostIp: string; HostPort: string }[]>;
    assert.equal(ports['3000/tcp']!.length, 1);
    assert.equal(ports['3000/tcp']![0]!.HostIp, '127.0.0.1');
    const port = Number(ports['3000/tcp']![0]!.HostPort);
    assert.ok(port >= 1024 && port !== 3000);
    const endpoint = 'http://127.0.0.1:' + port;
    let responding = false;
    for (let i = 0; i < 60; i++) {
      driver.owned(control, 'control');
      try {
        const r = await fetch(endpoint + '/api/owner/status', { redirect: 'error', signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          responding = true;
          break;
        }
      } catch {
        // Read-only readiness remains unconfirmed; this never retries a mutation.
      }
      await wait(500);
    }
    assert.ok(responding, 'Ordinary control did not start');
    // Reject an incomplete fixture tool closure before consuming any provider intent.
    const controlTools = [
      '/bin/sh',
      '/bin/bash',
      '/bin/tmux',
      '/bin/which',
      '/bin/grep',
      '/bin/sed',
      '/bin/awk',
      '/bin/find',
      '/bin/ps',
      '/bin/docker',
    ];
    const toolProgram =
      "const f=require('node:fs'),p=" +
      JSON.stringify(controlTools) +
      ";for(const x of p){f.accessSync(x,f.constants.X_OK);if(!f.statSync(x).isFile())throw Error('Fixture executable missing');}process.stdout.write(JSON.stringify(p));";
    const actualTools = JSON.parse(
      driver.docker(['exec', control, controlNode, '--input-type=commonjs', '-e', toolProgram])
    );
    assert.deepEqual(actualTools, controlTools);
    evidence.save('control-tools-qualified', { control, paths: actualTools, readOnly: true });
    await planOfficeInternalHostPreflight(endpoint);
    evidence.save('internal-api-host-qualified', { control, host: 'reverie:3000', readOnly: true });
    const owner = await enrollIsolatedPlanOfficeOwner(endpoint, path.join(evidence.root, 'auth'));
    evidence.save('owner-enrolled', { ownerSessionFile: owner.ownerSessionFile, requests: owner.requests() });
    for (const entry of sources) {
      const employee = entry.employee as z.infer<typeof PlanOfficeBootstrap>['employees'][number],
        source = entry.source as string;
      driver.owned(control, 'control');
      const selection = requireOriginalPolicy(
        await data(await owner.request('/api/company/employees/' + employee.employeeId + '/docker-policy')),
        employee,
        source,
        input.workerImageId
      );
      // Actual control namespace CPUs select fixture DATA; fresh product Rust probes still own enforcement.
      const cpuText = driver.docker(['exec', control, controlNode, '-e', PLAN_OFFICE_CPU_PROGRAM]).trim();
      const cpus = parsePlanOfficeCpus(cpuText);
      const policy = ciPlanPolicy(cpus),
        operationId = randomUUID(),
        requestBody = {
          operationId,
          sessionId: employee.sessionId,
          sessionGeneration: selection.sessionGeneration,
          containerId: source,
          imageId: selection.imageId,
          expectedDestinationImageId: input.workerImageId,
          expectedPolicyDigest: dockerContinuationDigest(policy),
          enterOffice: true,
        };
      evidence.save('begin-' + employee.employeeId, {
        request: requestBody,
        policyApproval: {
          sessionId: employee.sessionId,
          sessionGeneration: selection.sessionGeneration,
          expectedSourceDigest: selection.sourceDigest,
          policy,
        },
      });
      let knownMutationReply = true;
      try {
        requireSameOperation(
          await data(
            await owner.request('/api/company/employees/' + employee.employeeId + '/docker-continuation', 'POST', {
              request: requestBody,
              policyApproval: {
                sessionId: employee.sessionId,
                sessionGeneration: selection.sessionGeneration,
                expectedSourceDigest: selection.sourceDigest,
                policy,
              },
            })
          ),
          operationId
        );
      } catch (error) {
        knownMutationReply = false;
        evidence.save('begin-unconfirmed-' + employee.employeeId, {
          operationId,
          errorType: error instanceof Error ? error.name : 'unknown',
          noRetry: true,
          ...(error instanceof OwnerApiRefusal ? { httpStatus: error.status, response: error.response } : {}),
        });
      }
      await completePlanOfficeOriginal(
        { request: requestBody, sourceDigest: selection.sourceDigest },
        knownMutationReply,
        {
          async observe() {
            driver.owned(control, 'control');
            const value = await planOfficeOriginalStatus(
              await owner.request('/api/company/employees/' + employee.employeeId + '/docker-policy'),
              operationId
            );
            driver.owned(control, 'control');
            return value;
          },
          async continueOriginal(body, phase) {
            driver.owned(control, 'control');
            const canonical = readPrivate(path.join(evidence.root, 'data', 'company.json')) as Json;
            const row = (canonical.dockerEmployeeContinuations as Json[]).find(
              (row) => row.employeeId === employee.employeeId
            );
            assert.ok(row);
            assert.equal(row.phase, phase);
            assert.deepEqual(row.request, requestBody);
            const value = await data(
              await owner.request(
                '/api/company/employees/' + employee.employeeId + '/docker-continuation',
                'POST',
                body
              )
            );
            driver.owned(control, 'control');
            return value;
          },
          record(name, value) {
            evidence.save(name + '-' + employee.employeeId, value);
          },
          pause: () => wait(500),
        }
      );
      const session = await planOfficeSession(
        await owner.request('/api/sessions/' + employee.sessionId),
        employee.sessionId
      );
      // Ready and the managed Stop/receipt barrier are separate observations; poll actual idle below.
      evidence.save('actual-session-' + employee.employeeId, session);
      let actualReports: Json[] | undefined;
      const barrier =
        'BCPLAN_' +
        createHash('sha256')
          .update(employee.sessionId + '\0' + '\0idle')
          .digest('hex');
      for (let index = 0; index < 120; index++) {
        driver.owned(control, 'control');
        try {
          const reports = fs
            .readdirSync(path.join(entry.home as string, '.fixture'))
            .filter((name) => name.startsWith('plan-turn-'));
          const current = reports.map((name) =>
            readPrivate(path.join(entry.home as string, '.fixture', name))
          ) as Json[];
          const valid = current.some(
            (report) =>
              report.sessionId === employee.sessionId &&
              report.providerThread === employee.nativeThreadId &&
              report.state === 'idle' &&
              (report.probes as Json[]).some(
                (probe) =>
                  Array.isArray(probe.args) &&
                  probe.args.join(' ') === 'agent capabilities --json' &&
                  probe.exitCode === 0
              ) &&
              (report.probes as Json[]).some(
                (probe) =>
                  Array.isArray(probe.args) &&
                  probe.args.join(' ') === 'worker-callback hook-event --event stop' &&
                  probe.exitCode === 0
              )
          );
          const output = await data(await owner.request('/api/sessions/' + employee.sessionId + '/output'));
          const freshSession = await planOfficeSession(
            await owner.request('/api/sessions/' + employee.sessionId),
            employee.sessionId
          );
          if (
            valid &&
            freshSession.providerInputHeld === false &&
            freshSession.isWorking === false &&
            freshSession.status === 'idle' &&
            typeof output.textOutput === 'string' &&
            output.textOutput.includes(barrier)
          ) {
            actualReports = current;
            break;
          }
        } catch {
          // Read-only readiness remains unconfirmed; this never retries a mutation.
        }
        await wait(250);
      }
      assert.ok(actualReports, 'Actual capsule/Stop/consuming-close stdout barrier unconfirmed');
      evidence.save('genuine-capsule-receipts-' + employee.employeeId, actualReports);
      for (const [key, file] of Object.entries(entry.persistent as Record<string, string>)) {
        privateDirectory(file);
        const st = fs.lstatSync(file);
        assert.deepEqual(
          { dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid, mode: st.mode & 0o777 },
          (entry.beforePersistent as Json)[key]
        );
      }
      privateDirectory(entry.scratch as string);
      privateDirectory(entry.tmp as string);
    }
    let planMovesAccepted = false;
    if (input.acceptance === 'ordinary-self') {
      assert.equal(input.bootstrap.employees.length, 1, 'First self scenario owns one fresh employee');
      const initialEmployee = input.bootstrap.employees[0]!,
        entry = sources[0]!;
      assert.equal(initialEmployee.account, 'ci-plan-a');
      assert.equal(
        input.sourceProviders.find((item) => item.employeeId === initialEmployee.employeeId)?.mode ?? 'ordinary',
        'ordinary'
      );
      const controlEpoch = driver.owned(control, 'control').State as Json;
      const current = () => {
        evidence.current();
        const actual = driver.owned(control, 'control').State as Json;
        assert.equal(actual.Running, true);
        assert.equal(actual.Pid, controlEpoch.Pid);
        assert.equal(actual.StartedAt, controlEpoch.StartedAt);
      };
      const snapshot = () => {
        const company = readPrivate(path.join(evidence.root, 'data/company.json')) as Json;
        const employee = (company.employees as Json[]).find((value) => value.id === initialEmployee.employeeId);
        const row = (company.dockerEmployeeContinuations as Json[]).find(
          (value) => value.employeeId === initialEmployee.employeeId
        );
        assert.ok(employee && row);
        return { employee, row };
      };
      current();
      const captured = snapshot(),
        row = DockerEmployeeContinuationRecord.parse(captured.row);
      assert.ok(row.destination);
      assert.equal(row.phase, 'ready');
      const state = readPrivate(path.join(evidence.root, 'data/state.json')) as Json;
      const saved = (state.sessions as Record<string, SessionState>)[row.request.sessionId];
      assert.ok(saved);
      const nativeThreadId = z
        .string()
        .uuid()
        .parse(nativeThreadProfile(saved.mode ?? 'claude')?.read(saved));
      assert.equal(nativeThreadId, initialEmployee.nativeThreadId);
      assert.equal(saved.subscriptionProfile?.id, 'ci-plan-a');
      const scenario = {
        version: 1 as const,
        purpose: 'reverie-ci-plan-move-scenario-v1' as const,
        kind: 'self' as const,
        id: randomUUID(),
        employeeId: row.employeeId,
        sessionId: row.request.sessionId,
        sessionGeneration: row.request.sessionGeneration,
        fromAccount: 'ci-plan-a' as const,
        toAccount: 'ci-plan-b' as const,
      };
      const sourceInspect = DockerEmployeeInspect.parse(driver.inspect(row.destination.containerId));
      const instanceId = z
        .string()
        .uuid()
        .parse((readPrivate(path.join(evidence.root, 'data/docker-runtime/worker-identity.json')) as Json).instanceId);
      const homeStat = fs.lstatSync(entry.home as string);
      const before = {
        scenario,
        namespace: names.prefix,
        fixtureRoot: evidence.root,
        workerImageId: input.workerImageId,
        clientManifestDigest: input.clientManifestDigest,
        boxId: dockerContinuationDigest({ instanceId, deployment: names.prefix }),
        nativeThreadId,
        sourceRow: row,
        sourceInspect,
        home: { source: entry.home as string, dev: String(homeStat.dev), ino: String(homeStat.ino), user: driver.user },
        canonicalAuthDigest: planOfficeCanonicalAuthDigest(evidence.root, 'ci-plan-b'),
      };
      evidence.save('before-self-move', before);
      const ownerGet = async (p: string) => {
        current();
        const result = await owner.request(p);
        current();
        return result;
      };
      await runPlanOfficeMoveScenario(scenario, {
        assertCurrent: async () => current(),
        ownerPost: async (p, body) => {
          current();
          const result = await owner.request(p, 'POST', body);
          current();
          return result;
        },
        capsule: async (args) => {
          current();
          const actual = DockerEmployeeContinuationRecord.parse(snapshot().row);
          assert.deepEqual(actual, row);
          const raw = DockerEmployeeInspect.parse(driver.inspect(row.destination!.containerId));
          assert.deepEqual(
            boxedOriginal(
              raw,
              {
                employeeId: row.employeeId,
                sessionId: row.request.sessionId,
                sessionGeneration: row.request.sessionGeneration,
                owner: row.owner,
                sourceDigest: row.sourceDigest,
                providerSourceDigest: row.version === 1 ? row.sourceDigest : row.providerSourceDigest,
                onVacation: false,
                desiredRunning: true,
              },
              names.prefix,
              true
            ),
            row.destination
          );
          const identityFile =
            row.version === 3
              ? dockerPlanGeneration({
                  operationId: row.request.operationId,
                  containerId: row.destination!.containerId,
                  projectionDigest: row.planReplacement.account.projectionDigest,
                  provider: row.planReplacement.account.provider,
                }).identityFile
              : '/home/agent/.reverie/docker-worker-identity';
          const output = driver.docker([
            'exec',
            '--env',
            'HOME=/home/agent',
            '--env',
            'REVERIE_API_URL=http://reverie:3000',
            '--env',
            'REVERIE_SESSION_ID=' + row.request.sessionId,
            '--env',
            'REVERIE_WORKER_IDENTITY_FILE=' + identityFile,
            row.destination!.containerId,
            '/opt/reverie-worker-client/bin/reverie',
            ...args,
          ]);
          current();
          return { exitCode: 0, signal: null, stdout: output };
        },
        record: (name, value) => evidence.save(name, value),
        pause: () => wait(500),
        verifyCompleted: async (_scenario, record) =>
          verifyPlanOfficeMovedProvider(before, record, {
            current,
            snapshot,
            ownerGet,
            metadata: async (args) => driver.docker([...args]),
            record: (name, value) => evidence.save(name, value),
          }),
      });
      evidence.save('first-self-move-completed', {
        id: scenario.id,
        employeeId: scenario.employeeId,
        fromAccount: scenario.fromAccount,
        toAccount: scenario.toAccount,
        realCapsuleHmac: true,
        originalOnly: true,
      });
      planMovesAccepted = true;
    }
    const after = driver
      .docker(['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'])
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const original of before)
      assert.ok(after.includes(original.ID as string), 'Preexisting container disappeared during baseline');
    const result = {
      status: 0,
      purpose: 'reverie-ci-plan-office-baseline-v1',
      endpoint,
      controlId: control,
      ownedSetupIds: driver.ids,
      ownerSessionFile: owner.ownerSessionFile,
      evidence: evidence.root,
      baselineReady: true,
      planMovesAccepted,
      acceptedScenario: input.acceptance,
      refreshReuseAccepted: false,
      forceAccepted: false,
      cleanup: 'Preserved only owned fixture state; no stop/prune/paid replay.',
    };
    evidence.save('completed', result);
    return result;
  } catch (error) {
    if (error instanceof OwnerApiRefusal)
      evidence.save('owner-api-refused', { status: error.status, response: error.response });
    throw error;
  } finally {
    evidence.close();
  }
}
