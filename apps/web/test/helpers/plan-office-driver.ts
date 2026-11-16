/** Owned CI office acceptance only. No production admission or paid provider override. */
import {
  runPlanOfficeMoveScenario,
  runPlanOfficeSelfSequence,
  runPlanOfficeTeamSequence,
  planOfficeSelfDirection,
  planOfficeSelfLegKind,
  type PlanOfficeSelfCompletion,
  type PlanOfficeSelfLeg,
} from './plan-office-move-driver.js';
export { runPlanOfficeMoveScenario };
import {
  verifyPlanOfficeMovedProvider,
  planOfficeCanonicalAuthDigest,
  verifyPlanOfficeReadyNative,
} from './plan-office-move-verifier.js';
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
import { enrollIsolatedPlanOfficeOwner, resumeIsolatedPlanOfficeOwner } from './docker-continuation-auth-canary.js';
import { dockerContinuationDigest } from '../../src/docker-employee-continuation.js';
import { nativeThreadProfile } from '../../src/utils/native-thread-profile.js';
import { dockerPlanGeneration } from '../../src/docker-plan-install-data.js';
import { PlanOfficePermissionProbe, PlanOfficePermissionReceipt } from './plan-office-permission-probe.js';
import {
  runPlanOfficeViewerRepair,
  PlanOfficeViewerCommandInput,
  PlanOfficeViewerCommandReceipt,
  PlanOfficeWebsiteClient,
  PlanOfficeViewerRepairCompletion,
  PLAN_OFFICE_WEBSITE_CLIENT_PROGRAM,
  PLAN_OFFICE_WEBSITE_GONE_PROGRAM,
  planOfficeViewerPrompt,
  planOfficeViewerDigest,
  planOfficeViewerArgs,
  type PlanOfficeWebsiteClientInput,
} from './plan-office-viewer-repair.js';
import {
  DOCKER_PROVIDER_VIEW_ENV,
  DOCKER_PROVIDER_VIEW_PROGRAM,
  DOCKER_PROVIDER_VIEW_TMUX,
} from '../../src/docker-employee-provider-view-native.js';
import { dockerEmployeeProviderSourceDigest } from '../../src/docker-employee-store.js';
import { PROVIDER_LAUNCH_DISK_KEY } from '../../src/provider-launch-publication.js';
import { EmployeeSchema } from '../../src/company-types.js';
import { planFixtureTurnBarrier } from './boxed-plan-provider.js';
import type { PlanOfficeStartupCheckpoint } from './plan-office-startup-diagnostic.js';
import {
  PlanOfficeAgentForceInput,
  PlanOfficeAgentForceReceipt,
  PlanOfficeAgentForceSpawn,
  PlanOfficeAgentForceClosed,
  planOfficeForceDigest,
  planOfficeForceHandoff,
  planOfficeAgentForceArgs,
} from './plan-office-agent-force.js';
import { planOfficeForceChildArgs } from './plan-office-force-child.js';
import { DockerPlanMoveJournalState, dockerPlanMoveHandoffDigest } from '../../src/docker-plan-move-data.js';
import { PlanMoveStore } from '../../src/plan-move-store.js';
import { WORKER_CLIENT_ENTRY, parseWorkerClientReadback } from '../../src/worker-client-manifest.js';
import { parseDockerPlanProtocol } from '../../src/docker-plan-protocol.js';
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
    acceptance: z
      .enum(['baseline', 'ordinary-self', 'self-roundtrip', 'self-owner-force', 'self-agent-force', 'team-plan-move'])
      .default('baseline'),
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
      (v.acceptance === 'baseline' ||
        (v.acceptance === 'team-plan-move' &&
          v.bootstrap.employees.length === 2 &&
          v.bootstrap.employees.every((e) => e.account === 'ci-plan-a' && e.permissions.managePlans === false) &&
          v.bootstrap.employees[0]!.permissions.moveOwnPlan === false &&
          v.bootstrap.employees[1]!.permissions.moveOwnPlan === true &&
          new Set(v.bootstrap.employees.map((e) => e.nativeThreadId)).size === 2 &&
          v.sourceProviders.every((e) => e.mode === 'ordinary')) ||
        (v.acceptance !== 'team-plan-move' &&
          v.bootstrap.employees.length === 1 &&
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
/** Read-only actual image qualification before owner enrollment/provider intent.
 * Unit reply DATA never substitutes for the fixed CLI calls on the owned image. */
export function requirePlanOfficeControlClient(
  control: string,
  manifestDigest: string,
  execute: (args: string[]) => string
) {
  cid.parse(control);
  hash.parse(manifestDigest);
  const command = (role: 'status' | 'plan-protocol') => [
    'exec',
    control,
    WORKER_CLIENT_ENTRY,
    'worker-client',
    role,
    '--expected-digest',
    manifestDigest,
  ];
  const before = parseWorkerClientReadback(execute(command('status')), manifestDigest);
  parseDockerPlanProtocol(execute(command('plan-protocol')));
  const after = parseWorkerClientReadback(execute(command('status')), manifestDigest);
  assert.deepEqual(after, before, 'Actual website capsule changed during protocol qualification');
  return { ...after, protocol: 1 as const, readOnly: true as const };
}
/** Normal owner prompt: mux strips LF and submits a separate Enter only for CR. */
export function planOfficePermissionProbeInput(id: string) {
  z.string().uuid().parse(id);
  return { input: 'BOXED_PLAN_PERMISSION_PROBE_' + id + '\r', useMux: true as const };
}
export function planOfficeAgentForcePrompt(id: string, stage: 'PREPARE' | 'EXECUTE') {
  z.string().uuid().parse(id);
  z.enum(['PREPARE', 'EXECUTE']).parse(stage);
  return { input: 'BOXED_PLAN_FORCE_' + stage + '_' + id + '\r', useMux: true as const };
}
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
  constructor(
    readonly root: string,
    existing = false
  ) {
    if (!existing) fs.mkdirSync(root, { mode: 0o700 });
    else
      this.serial = Math.max(
        0,
        ...fs
          .readdirSync(root)
          .filter((n) => /^\d+-(?:intent|result)\.json$/.test(n))
          .map((n) => Number(n.split('-')[0]))
      );
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
/** Terminal bytes are distinct from parsed assistant transcript output. */
export async function planOfficeTerminal(response: Response) {
  const value = await data(response);
  return z
    .object({ terminalBuffer: z.string().max(4 * 1024 ** 2) })
    .passthrough()
    .parse(value).terminalBuffer;
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
export async function runPlanOfficeBaseline(contractFile: string, entered: PlanOfficeStartupCheckpoint = () => {}) {
  entered('driver-admission');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
  assert.ok(path.isAbsolute(contractFile));
  privateDirectory(path.dirname(contractFile));
  entered('driver-contract');
  const input = PlanOfficeDriverInput.parse(readPrivate(contractFile));
  entered('driver-runtime-package');
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
  entered('driver-evidence-directory');
  const evidence = new Evidence(path.join(path.dirname(contractFile), 'office-' + input.instance)),
    driver = new Driver(input, evidence, metadata.dockerExecutable),
    names = driver.names;
  try {
    evidence.save('plan', {
      ...input,
      limitation:
        input.acceptance === 'baseline'
          ? 'Fake external model; real owner/API/Engine/native/HMAC baseline only.'
          : 'Fake external model; only the explicit selected scenario is checked with actual physical verification. No paid vendor or complete permission/recovery matrix acceptance.',
    });
    entered('driver-container-census');
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
      entered(`driver-image-${role}`);
      const image = input[(role + 'ImageId') as 'sourceImageId'],
        rows = JSON.parse(driver.docker(['image', 'inspect', image]));
      assert.equal(rows.length, 1);
      driver.configs.set(image, requirePlanOfficeImage(rows[0], input, role));
      driver.images.set(role, rows[0]);
    }
    entered('driver-image-layer-prefix');
    const srcLayers = (driver.images.get('source')!.RootFS as Json).Layers as string[],
      targetLayers = (driver.images.get('worker')!.RootFS as Json).Layers as string[];
    assert.ok(srcLayers.length > 0);
    assert.deepEqual(targetLayers.slice(0, srcLayers.length), srcLayers);
    entered('driver-fixture-directories');
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
    entered('driver-bootstrap-seed');
    await driver.metadata(
      'seed',
      input.controlImageId,
      [controlNode, input.runtimePath + '/lib/reverie/plan-office-bootstrap.mjs'],
      [driver.bind(evidence.root, '/fixture')]
    );
    // Both fixture networks block external provider egress; the host reaches only the mapped loopback API.
    entered('driver-network-front');
    const front = await driver.network(names.front, true);
    entered('driver-network-workers');
    const network = await driver.network(names.network, true),
      sources: Json[] = [];
    entered('driver-platform-closure-read');
    const closures = fs.readFileSync(path.join(input.platformClosure, 'store-paths'), 'utf8').trim().split('\n');
    assert.ok(closures.length > 0 && closures.length <= 4096);
    for (const item of closures) {
      store.parse(item);
      pinned(item);
    }
    for (const employee of input.bootstrap.employees) {
      entered('driver-worker-directories');
      mkdir('workers', employee.employeeId);
      const home = mkdir('workers', employee.employeeId, 'home'),
        nix = mkdir('workers', employee.employeeId, 'nix'),
        workspace = mkdir('workers', employee.employeeId, 'workspace');
      mkdir('workers', employee.employeeId, 'workspace', 'cases');
      mkdir('workers', employee.employeeId, 'workspace', 'cases', 'boxed-canary');
      const nixStore = mkdir('workers', employee.employeeId, 'nix', 'store');
      entered('driver-worker-platform-copy');
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
      entered('driver-worker-home-prepare');
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
            ...(input.acceptance === 'self-agent-force' ? { sdkForceEnabled: true } : {}),
            ...(input.acceptance === 'team-plan-move' &&
            employee.employeeId === input.bootstrap.employees[1]!.employeeId
              ? { approvalAllowlistOnly: true }
              : {}),
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
      entered('driver-source-create');
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
    entered('driver-docker-socket');
    const socket = fs.lstatSync('/var/run/docker.sock');
    assert.ok(socket.isSocket());
    entered('driver-control-create');
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
    entered('driver-control-connect');
    driver.docker(['network', 'connect', '--alias', 'reverie', network, control]);
    driver.owned(control, 'control');
    evidence.save('control-start-issued', { control });
    entered('driver-control-start');
    driver.docker(['start', control]);
    const running = driver.owned(control, 'control');
    assert.equal((running.State as Json).Running, true);
    const ports = (running.NetworkSettings as Json).Ports as Record<string, { HostIp: string; HostPort: string }[]>;
    assert.equal(ports['3000/tcp']!.length, 1);
    assert.equal(ports['3000/tcp']![0]!.HostIp, '127.0.0.1');
    const port = Number(ports['3000/tcp']![0]!.HostPort);
    assert.ok(port >= 1024 && port !== 3000);
    const endpoint = 'http://127.0.0.1:' + port;
    entered('driver-control-owner-preflight');
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
    entered('driver-control-tools');
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
    driver.owned(control, 'control');
    const client = requirePlanOfficeControlClient(control, input.clientManifestDigest, (args) => driver.docker(args));
    driver.owned(control, 'control');
    evidence.save('control-client-qualified', { control, ...client });
    entered('driver-internal-host');
    await planOfficeInternalHostPreflight(endpoint);
    evidence.save('internal-api-host-qualified', { control, host: 'reverie:3000', readOnly: true });
    entered('driver-owner-enrollment');
    const owner = await enrollIsolatedPlanOfficeOwner(endpoint, path.join(evidence.root, 'auth'));
    evidence.save('owner-enrolled', { ownerSessionFile: owner.ownerSessionFile, requests: owner.requests() });
    for (const entry of sources) {
      entered('driver-original-policy');
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
      entered('driver-original-recovery');
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
      entered('driver-original-sdk');
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
          const output = await planOfficeTerminal(
            await owner.request('/api/sessions/' + employee.sessionId + '/terminal')
          );
          const freshSession = await planOfficeSession(
            await owner.request('/api/sessions/' + employee.sessionId),
            employee.sessionId
          );
          if (
            valid &&
            freshSession.providerInputHeld === false &&
            freshSession.isWorking === false &&
            freshSession.status === 'idle' &&
            output.includes(barrier)
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
    entered('driver-selected-scenario');
    let planMovesAccepted = false;
    let selfRoundtripAccepted = false;
    let ownerForceAccepted = false;
    let agentForceAccepted = false;
    let teamAccepted = false;
    let viewerRepairAccepted = false;
    const acceptance = input.acceptance;
    if (acceptance === 'team-plan-move') {
      const caller = input.bootstrap.employees[0]!,
        target = input.bootstrap.employees[1]!;
      const callerHome = sources[0]!.home as string,
        targetHome = sources[1]!.home as string;
      const controlEpoch = driver.owned(control, 'control').State as Json;
      const current = () => {
        evidence.current();
        const actual = driver.owned(control, 'control').State as Json;
        assert.equal(actual.Running, true);
        assert.equal(actual.Pid, controlEpoch.Pid);
        assert.equal(actual.StartedAt, controlEpoch.StartedAt);
      };
      const employee = (id: string) => {
        const company = readPrivate(path.join(evidence.root, 'data/company.json')) as Json;
        const row = DockerEmployeeContinuationRecord.parse(
          (company.dockerEmployeeContinuations as Json[]).find((e) => e.employeeId === id)
        );
        const current = (company.employees as Json[]).find((e) => e.id === id)!;
        assert.ok(current && row.destination);
        assert.equal(row.phase, 'ready');
        return { current, row };
      };
      const epoch = () =>
        [caller, target].map((e) => {
          current();
          const { current: employeeRow, row } = employee(e.employeeId);
          const inspect = DockerEmployeeInspect.parse(driver.inspect(row.destination!.containerId));
          assert.equal(inspect.State.Running, true);
          return {
            employeeId: e.employeeId,
            sessionId: employeeRow.sessionId,
            sessionGeneration: employeeRow.sessionGeneration,
            dockerBinding: employeeRow.dockerBinding,
            row,
            native: {
              id: inspect.Id,
              image: inspect.Image,
              pid: inspect.State.Pid,
              startedAt: inspect.State.StartedAt,
              config: inspect.Config,
              mounts: inspect.Mounts,
            },
          };
        });
      const journals = () =>
        ['plan-requests.json', 'plan-moves.json'].map((name) => {
          const file = path.join(evidence.root, 'data', name);
          return {
            name,
            digest: fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null,
          };
        });
      const verifyNative = async (e: typeof caller) => {
        const reports = readPrivate(
          path.join(evidence.root, 'genuine-capsule-receipts-' + e.employeeId + '.json')
        ) as Json[];
        const report = reports.find(
          (value) =>
            value.employeeId === e.employeeId &&
            value.sessionId === e.sessionId &&
            value.state === 'idle' &&
            value.requestId === null
        );
        assert.ok(report);
        return (
          await verifyPlanOfficeReadyNative(
            employee(e.employeeId).row,
            e.nativeThreadId,
            report as unknown as import('./boxed-plan-provider.js').PlanProviderFixtureReport,
            { current, metadata: async (args) => driver.docker([...args]) }
          )
        ).native;
      };
      const originalCallerNative = await verifyNative(caller),
        originalTargetNative = await verifyNative(target);
      evidence.save('team-initial-native', { caller: originalCallerNative, target: originalTargetNative });
      const originalCaller = epoch()[0];
      const completed = await runPlanOfficeTeamSequence({
        grant: async (enabled) => {
          const p = '/api/company/employees/' + caller.employeeId;
          await data(await owner.request(p, 'PUT', { permissions: { managePlans: enabled } }));
          const readback = await data(await owner.request(p + '/permissions'));
          assert.equal(readback.employeeId, caller.employeeId);
          assert.equal((readback.permissions as Json).managePlans, enabled);
          const actual = employee(caller.employeeId);
          assert.equal((actual.current.permissions as Json).managePlans, enabled);
          assert.equal((actual.current.permissions as Json).moveOwnPlan, false);
          assert.deepEqual(epoch()[0], originalCaller);
          evidence.save('team-grant-' + randomUUID(), {
            employeeId: caller.employeeId,
            managePlans: enabled,
            apiAndDiskReadback: true,
          });
        },
        probe: async (scope) => {
          const id = randomUUID();
          const callerRow = employee(caller.employeeId).row,
            targetRow = employee(target.employeeId).row;
          assert.equal((employee(caller.employeeId).current.permissions as Json).managePlans, scope === 'team-pending');
          const input = PlanOfficePermissionProbe.parse({
            version: 1,
            purpose: 'reverie-ci-team-permission-probe-v1',
            id,
            scope,
            callerEmployeeId: caller.employeeId,
            callerSessionId: callerRow.request.sessionId,
            employeeId: target.employeeId,
            sessionId: targetRow.request.sessionId,
            toAccount: 'ci-plan-b',
          });
          const before = { epoch: epoch(), journals: journals() };
          evidence.save('team-permission-' + id + '-intent', { input, before, noRetry: true });
          const fixture = new Evidence(path.join(callerHome, '.fixture'), true);
          try {
            fixture.save('plan-permission-probe-' + id, input);
          } finally {
            fixture.close();
          }
          // One ordinary owner input, consumed by the existing caller SDK process.
          await data(
            await owner.request(
              '/api/sessions/' + callerRow.request.sessionId + '/input',
              'POST',
              planOfficePermissionProbeInput(id)
            )
          );
          const receiptFile = path.join(callerHome, '.fixture', 'plan-permission-returned-' + id + '.json');
          let receipt: z.infer<typeof PlanOfficePermissionReceipt> | undefined;
          for (let index = 0; index < 100; index++) {
            current();
            if (fs.existsSync(receiptFile)) {
              const value = PlanOfficePermissionReceipt.parse(readPrivate(receiptFile));
              const session = await planOfficeSession(
                await owner.request('/api/sessions/' + callerRow.request.sessionId),
                callerRow.request.sessionId
              );
              const output = await planOfficeTerminal(
                await owner.request('/api/sessions/' + callerRow.request.sessionId + '/terminal')
              );
              if (
                session.status === 'idle' &&
                session.isWorking === false &&
                session.providerInputHeld === false &&
                output.includes('BCPLAN_PERMISSION_RETURNED_' + id) &&
                output.trimEnd().endsWith('❯')
              ) {
                receipt = value;
                break;
              }
            }
            await wait(250);
          }
          assert.ok(receipt, 'Permission transport/idle outcome unknown; never issue another request');
          for (const key of ['id', 'scope', 'callerEmployeeId', 'callerSessionId', 'employeeId', 'sessionId'] as const)
            assert.equal(receipt[key], input[key]);
          assert.equal(
            receipt.namespacePid,
            originalCallerNative.panePid,
            'Probe must run in the physically observed original SDK process'
          );
          assert.deepEqual(await verifyNative(caller), originalCallerNative);
          assert.deepEqual(await verifyNative(target), originalTargetNative);
          assert.deepEqual(epoch(), before.epoch);
          assert.deepEqual(
            journals(),
            before.journals,
            'Permission observation must not create request/native move journals'
          );
          evidence.save('team-permission-' + id + '-checked', {
            ...receipt,
            unchangedNativeAndJournals: true,
            actualSdkProcess: true,
          });
          return receipt;
        },
        move: async (permissionReceipts) => {
          const result = await runPlanOfficeMoveLeg(
            input,
            evidence,
            driver,
            control,
            owner,
            targetHome,
            'first',
            undefined,
            'team',
            {
              employeeId: target.employeeId,
              callerEmployeeId: caller.employeeId,
              forbiddenIds: permissionReceipts.map((receipt) => receipt.id),
            }
          );
          assert.deepEqual(epoch()[0], originalCaller, 'A team move must preserve its separate caller worker');
          assert.deepEqual(await verifyNative(caller), originalCallerNative);
          return result;
        },
      });
      evidence.save('team-plan-move-completed', {
        employeeId: target.employeeId,
        callerEmployeeId: caller.employeeId,
        callerSessionId: caller.sessionId,
        id: completed.scenario.id,
        receipt: 'team-move-' + completed.scenario.id + '-completed',
        physicalReceipt: 'physical-move-' + completed.scenario.id,
        permissionReceipts: completed.receipts,
        permissionChecks: completed.receipts.map((receipt) =>
          readPrivate(path.join(evidence.root, 'team-permission-' + receipt.id + '-checked.json'))
        ),
        apiDenialsObserved: true,
        capsulePositive: true,
        callerPreserved: true,
      });
      await runPlanOfficeTeamViewerRepair({
        input,
        evidence,
        driver,
        control,
        owner,
        caller,
        target,
        callerHome,
        targetHome,
        current,
        employee,
        originalCallerNative,
        targetPhysical: readPrivate(
          path.join(evidence.root, 'physical-move-' + completed.scenario.id + '.json')
        ) as Json,
      });
      viewerRepairAccepted = true;
      planMovesAccepted = teamAccepted = true;
    } else if (acceptance !== 'baseline') {
      const originalControl = driver.owned(control, 'control').State as Json;
      const sameControl = () => {
        const observed = driver.owned(control, 'control').State as Json;
        assert.equal(observed.Running, true);
        assert.equal(observed.Pid, originalControl.Pid);
        assert.equal(observed.StartedAt, originalControl.StartedAt);
      };
      const completed = await runPlanOfficeSelfSequence(acceptance, async (leg, previous) => {
        sameControl();
        const result = await runPlanOfficeMoveLeg(
          input,
          evidence,
          driver,
          control,
          owner,
          sources[0]!.home as string,
          leg,
          previous,
          planOfficeSelfLegKind(acceptance, leg)
        );
        sameControl();
        return result;
      });
      if (completed.returned) {
        const ownerForce = completed.returned.scenario.kind === 'owner-force';
        const agentForce = completed.returned.scenario.kind === 'agent-force';
        evidence.save(
          ownerForce
            ? 'self-owner-force-completed'
            : agentForce
              ? 'self-agent-force-completed'
              : 'self-roundtrip-completed',
          {
            employeeId: completed.first.scenario.employeeId,
            firstMoveId: completed.first.scenario.id,
            returnMoveId: completed.returned.scenario.id,
            firstNewSession: completed.first.record.newSession,
            returnNewSession: completed.returned.record.newSession,
            accounts: ['ci-plan-a', 'ci-plan-b', 'ci-plan-a'],
            firstReceipt: 'first-self-move-completed',
            returnReceipt:
              (ownerForce ? 'owner-force-move-' : agentForce ? 'agent-force-move-' : 'self-move-') +
              completed.returned.scenario.id +
              '-completed',
            returnKind: completed.returned.scenario.kind,
          }
        );
        selfRoundtripAccepted = !ownerForce && !agentForce;
        ownerForceAccepted = ownerForce;
        agentForceAccepted = agentForce;
      }
      planMovesAccepted = true;
    }
    entered('driver-completion-census');
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
      selfRoundtripAccepted,
      ownerForceAccepted,
      agentForceAccepted,
      teamAccepted,
      viewerRepairAccepted,
      acceptedScenario: input.acceptance,
      refreshReuseAccepted: false,
      forceAccepted: ownerForceAccepted || agentForceAccepted,
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

/** Shared one-shot move adapter; the first self latch and per-operation return latches never replay. */
async function runPlanOfficeTeamViewerRepair(p: {
  input: Input;
  evidence: Evidence;
  driver: Driver;
  control: string;
  owner: Awaited<ReturnType<typeof enrollIsolatedPlanOfficeOwner>>;
  caller: Input['bootstrap']['employees'][number];
  target: Input['bootstrap']['employees'][number];
  callerHome: string;
  targetHome: string;
  current(): void;
  employee(id: string): { current: Json; row: DockerEmployeeContinuationRecord };
  originalCallerNative: unknown;
  targetPhysical: Json;
}) {
  const { input, evidence, driver, control, owner, caller, target, current } = p;
  assert.equal(input.acceptance, 'team-plan-move');
  const native = z
    .object({
      paneId: z.string().regex(/^%[0-9]+$/),
      panePid: z.number().int().min(2),
      paneStartTicks: z.string().regex(/^[1-9][0-9]*$/),
      hooks: z.object({ kind: z.literal('generation'), generation: z.string() }).strict(),
    })
    .strict();
  const callerNative = native.parse(p.originalCallerNative),
    targetNative = native.parse(p.targetPhysical.pane);
  const controlConfig = driver.owned(control, 'control').Config as Json;
  const controlCommand = [
    ...z.array(z.string()).parse(controlConfig.Entrypoint),
    ...z.array(z.string()).parse(controlConfig.Cmd),
  ];
  const node = controlCommand[0]!,
    module = input.runtimePath + '/lib/reverie/test/helpers/plan-office-viewer-repair.js';
  const selected = () => ({ caller: p.employee(caller.employeeId), target: p.employee(target.employeeId) });
  const initial = selected(),
    callerSid = initial.caller.row.request.sessionId,
    targetSid = initial.target.row.request.sessionId;
  assert.equal(callerSid, caller.sessionId);
  assert.notEqual(targetSid, target.sessionId, 'The mandatory viewer exercise follows the completed team replacement');
  const permissions = structuredClone(initial.caller.current.permissions) as Json;
  const draft = 'BCVIEW_DRAFT_' + randomUUID().replaceAll('-', '');
  let requirePublishedView = false;
  const metadata = (args: string[]) => {
    current();
    const value = driver.docker(args);
    current();
    return value;
  };
  const observeProvider = (row: DockerEmployeeContinuationRecord) =>
    native.parse(
      JSON.parse(
        metadata([
          'exec',
          ...DOCKER_PROVIDER_VIEW_ENV,
          row.destination!.containerId,
          '/opt/reverie-worker-client/bin/node',
          '--input-type=commonjs',
          '--no-warnings',
          '-e',
          DOCKER_PROVIDER_VIEW_PROGRAM,
          '--',
          'observe',
          row.request.sessionId,
          row.request.operationId,
          'generation',
        ])
      )
    );
  const captureTarget = () => {
    const row = selected().target.row;
    return metadata([
      'exec',
      ...DOCKER_PROVIDER_VIEW_ENV,
      row.destination!.containerId,
      DOCKER_PROVIDER_VIEW_TMUX,
      '-N',
      '-f',
      '/dev/null',
      '-L',
      'reverie-docker',
      'capture-pane',
      '-p',
      '-J',
      '-S',
      '-',
      '-t',
      targetNative.paneId,
    ]);
  };
  const websiteInput = async (who: 'caller' | 'target'): Promise<PlanOfficeWebsiteClientInput> => {
    const row = selected()[who].row;
    const session = await planOfficeSession(
      await owner.request('/api/sessions/' + row.request.sessionId),
      row.request.sessionId
    );
    const mux = z
      .array(
        z
          .object({
            sessionId: z.string(),
            muxName: z.string(),
            pid: z.number().int().positive(),
            docker: z.record(z.string(), z.unknown()),
          })
          .passthrough()
      )
      .parse(readPrivate(path.join(evidence.root, 'data/mux-sessions.json')))
      .filter((value) => value.sessionId === row.request.sessionId);
    assert.equal(mux.length, 1);
    assert.equal(mux[0]!.muxName, 'reverie-' + row.request.sessionId.slice(0, 8));
    assert.equal(mux[0]!.docker.containerName, row.destination!.containerId);
    assert.equal((mux[0]!.docker.continuation as Json).operationId, row.request.operationId);
    return {
      operation: 'observe',
      sessionId: row.request.sessionId,
      pid: z.number().int().min(2).parse(session.pid),
      outerPid: mux[0]!.pid,
      containerId: row.destination!.containerId,
      operationId: row.request.operationId,
      controlCommand: controlCommand as PlanOfficeWebsiteClientInput['controlCommand'],
    };
  };
  const website = async (who: 'caller' | 'target') =>
    PlanOfficeWebsiteClient.parse(
      JSON.parse(
        metadata([
          'exec',
          control,
          node,
          '--input-type=module',
          '-e',
          PLAN_OFFICE_WEBSITE_CLIENT_PROGRAM,
          '--',
          module,
          JSON.stringify(await websiteInput(who)),
        ])
      )
    );
  const presence = (record: Json, key: string) => ({ present: Object.hasOwn(record, key), value: record[key] ?? null });
  const snapshot = async () => {
    current();
    const chosen = selected(),
      state = readPrivate(path.join(evidence.root, 'data/state.json')) as Json;
    const rows = state.sessions as Record<string, SessionState>;
    const records = await Promise.all(
      (['caller', 'target'] as const).map(async (who) => {
        const { row, current: employee } = chosen[who];
        const actual = DockerEmployeeInspect.parse(driver.inspect(row.destination!.containerId));
        assert.equal(actual.State.Running, true);
        const view = observeProvider(row);
        assert.deepEqual(view, who === 'caller' ? callerNative : targetNative);
        const limits = await data(
          await owner.request('/api/company/employees/' + row.employeeId + '/docker-resources')
        );
        assert.equal(limits.enforcement, 'fresh-native-readback');
        assert.equal(limits.actualMemoryHighBytes, row.policy.memoryHighBytes);
        assert.equal(limits.memoryMaxBytes, row.policy.memoryMaxBytes);
        const { pool: _pool, ...leafPolicy } = row.policy;
        assert.deepEqual(limits.actualLimits, { ...leafPolicy, cpuQuota: 'unlimited' });
        const session = await planOfficeSession(
          await owner.request('/api/sessions/' + row.request.sessionId),
          row.request.sessionId
        );
        assert.equal(session.providerInputHeld, false);
        assert.equal(session.viewerInputHeld, false);
        const viewCurrent = z.boolean().parse(session.dockerProviderViewCurrent);
        if (who === 'target' && requirePublishedView)
          assert.equal(
            viewCurrent,
            true,
            'The product must retain its actual published private Engine view after repair and caller revocation'
          );
        const saved = rows[row.request.sessionId]!;
        assert.ok(saved);
        return [
          who,
          {
            scope: {
              employeeId: row.employeeId,
              sessionId: row.request.sessionId,
              generation: row.request.sessionGeneration,
              binding: employee.dockerBinding,
              rowDigest: dockerContinuationDigest(row),
              recipeDigest: dockerEmployeeProviderSourceDigest(EmployeeSchema.parse(employee), saved),
            },
            container: {
              id: actual.Id,
              image: actual.Image,
              state: actual.State,
              config: actual.Config,
              host: actual.HostConfig,
              mounts: actual.Mounts,
            },
            native: view,
            kernel: limits,
            website: await website(who),
            viewCurrent,
            fences: {
              publicTerminal: presence(session, 'terminalInputHeld'),
              savedTerminal: presence(saved as unknown as Json, 'terminalInputHeld'),
              publicProvider: presence(session, 'providerDispatchHeld'),
              savedProvider: presence(saved as unknown as Json, 'providerDispatchHeld'),
            },
          },
        ] as const;
      })
    );
    const output = captureTarget();
    assert.equal(output.split(draft).length - 1, 1, 'One unsubmitted native draft only');
    assert.ok(output.trimEnd().endsWith(draft), 'The same unsubmitted text remains in the native composer');
    const turns = fs
      .readdirSync(path.join(p.targetHome, '.fixture'))
      .filter((name) => name.startsWith('plan-turn-' + targetSid + '-'))
      .sort();
    const paidHistory = z
      .object({
        version: z.literal(1),
        kind: z.enum(['observed', 'unconfirmed']),
        rows: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(state[PROVIDER_LAUNCH_DISK_KEY]);
    assert.ok(
      paidHistory.rows[callerSid] && paidHistory.rows[targetSid],
      'Both original paid launch histories required'
    );
    const result = {
      records: Object.fromEntries(records),
      draft: {
        occurrences: 1,
        nativeDraftSha256: planOfficeViewerDigest(draft),
        targetTurns: turns,
        consumingHistoryBarriers: output.match(/BCPLAN(?:_TURN)?_[a-f0-9]{64}/g) ?? [],
      },
      nativeCaptureObservationSha256: planOfficeViewerDigest(output), // terminal reflow is not a new SDK turn
      journals: {
        provider: dockerContinuationDigest(paidHistory),
        canonicalAuth: {
          caller: planOfficeCanonicalAuthDigest(evidence.root, 'ci-plan-a'),
          target: planOfficeCanonicalAuthDigest(evidence.root, 'ci-plan-b'),
        },
        plans: ['plan-requests.json', 'plan-moves.json'].map((name) => ({
          name,
          sha256: planOfficeViewerDigest(fs.readFileSync(path.join(evidence.root, 'data', name))),
        })),
      },
      uncertaintyScope:
        'Exact public/saved fence presence only; absent/false is not an exercised unknown-input history',
    };
    current();
    return result;
  };
  const command = async (kind: 'viewer-status' | 'reconnect-viewer', expected: 'allowed' | 'denied', id: string) => {
    const chosen = selected(),
      row = chosen.target.row;
    const value = PlanOfficeViewerCommandInput.parse({
      version: 1,
      purpose: 'reverie-ci-sdk-viewer-command-v1',
      id,
      command: kind,
      expected,
      callerEmployeeId: caller.employeeId,
      callerSessionId: callerSid,
      employeeId: target.employeeId,
      sessionId: targetSid,
      sessionGeneration: row.request.sessionGeneration,
    });
    evidence.save('viewer-command-' + id + '-intent', value);
    const files = new Evidence(path.join(p.callerHome, '.fixture'), true);
    try {
      files.save('viewer-command-input-' + id, value);
    } finally {
      files.close();
    }
    const oldTurns = new Set(
      fs
        .readdirSync(path.join(p.callerHome, '.fixture'))
        .filter((name) => name.startsWith('plan-turn-' + callerSid + '-'))
    );
    await data(await owner.request('/api/sessions/' + callerSid + '/input', 'POST', planOfficeViewerPrompt(id)));
    const receiptFile = path.join(p.callerHome, '.fixture', 'viewer-command-returned-' + id + '.json');
    let receipt: z.infer<typeof PlanOfficeViewerCommandReceipt> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      current();
      if (fs.existsSync(receiptFile)) {
        const result = PlanOfficeViewerCommandReceipt.parse(readPrivate(receiptFile));
        const session = await planOfficeSession(await owner.request('/api/sessions/' + callerSid), callerSid);
        const terminal = await planOfficeTerminal(await owner.request('/api/sessions/' + callerSid + '/terminal'));
        const reports = fs
          .readdirSync(path.join(p.callerHome, '.fixture'))
          .filter((name) => name.startsWith('plan-turn-' + callerSid + '-') && !oldTurns.has(name))
          .map(
            (name) =>
              readPrivate(
                path.join(p.callerHome, '.fixture', name)
              ) as import('./boxed-plan-provider.js').PlanProviderFixtureReport
          );
        const turn = reports.find(
          (report) =>
            report.state === 'idle' &&
            report.requestId === null &&
            report.sessionId === callerSid &&
            report.employeeId === caller.employeeId &&
            report.providerThread === caller.nativeThreadId &&
            report.hookGenerationSha256 === planOfficeViewerDigest(callerNative.hooks.generation) &&
            report.probes.some(
              (probe) =>
                probe.exitCode === 0 &&
                JSON.stringify(probe.args) === JSON.stringify(['worker-callback', 'hook-event', '--event', 'stop'])
            ) &&
            terminal.includes(planFixtureTurnBarrier(report)) &&
            report.namespacePid === callerNative.panePid
        );
        if (
          turn &&
          terminal.includes('BCVIEW_RETURNED_' + id) &&
          terminal.trimEnd().endsWith('❯') &&
          session.isWorking === false &&
          session.providerInputHeld === false &&
          session.status === 'idle'
        ) {
          receipt = result;
          break;
        }
      }
      await wait(250);
    }
    assert.ok(receipt, 'SDK viewer command/consuming-close outcome unknown; never issue another command');
    for (const key of [
      'id',
      'command',
      'expected',
      'callerEmployeeId',
      'callerSessionId',
      'employeeId',
      'sessionId',
      'sessionGeneration',
    ] as const)
      assert.equal(receipt[key], value[key]);
    assert.equal(receipt.namespacePid, callerNative.panePid);
    assert.equal(receipt.child.parentPid, callerNative.panePid);
    assert.equal(receipt.child.sessionId, callerSid);
    assert.equal(
      receipt.child.argsDigest,
      planOfficeViewerDigest(JSON.stringify(planOfficeForceChildArgs(planOfficeViewerArgs(value))))
    );
    assert.equal(
      receipt.child.identityFileDigest,
      planOfficeViewerDigest(planOfficeSelfIdentityFile(chosen.caller.row))
    );
    assert.deepEqual(observeProvider(chosen.caller.row), callerNative);
    assert.deepEqual(observeProvider(chosen.target.row), targetNative);
    if (kind === 'reconnect-viewer') requirePublishedView = true;
    evidence.save('viewer-command-' + id + '-checked', {
      ...receipt,
      cliRefusalOnlyNotHttpStatus: expected === 'denied',
    });
    return receipt;
  };
  const result = await runPlanOfficeViewerRepair({
    current,
    grant: async (enabled) => {
      await data(
        await owner.request('/api/company/employees/' + caller.employeeId, 'PUT', {
          permissions: { recoverEmployees: enabled },
        })
      );
      const readback = await data(await owner.request('/api/company/employees/' + caller.employeeId + '/permissions'));
      assert.equal(readback.employeeId, caller.employeeId);
      assert.equal((readback.permissions as Json).recoverEmployees, enabled);
      assert.equal((selected().caller.current.permissions as Json).recoverEmployees, enabled);
      for (const [key, value] of Object.entries(permissions))
        if (key !== 'recoverEmployees') assert.equal((readback.permissions as Json)[key], value);
      evidence.save('viewer-grant-' + randomUUID(), {
        employeeId: caller.employeeId,
        recoverEmployees: enabled,
        apiAndCanonicalReadback: true,
      });
    },
    draft: async () => {
      assert.ok(captureTarget().trimEnd().endsWith('❯'));
      await data(await owner.request('/api/sessions/' + targetSid + '/input', 'POST', { input: draft, useMux: true }));
    },
    snapshot,
    detach: async () => {
      const original = await website('target'),
        request = { ...(await websiteInput('target')), operation: 'detach', expected: original };
      evidence.save('viewer-detach-intent', { original, noReplay: true, control });
      const acknowledged = PlanOfficeWebsiteClient.parse(
        JSON.parse(
          metadata([
            'exec',
            control,
            node,
            '--input-type=module',
            '-e',
            PLAN_OFFICE_WEBSITE_CLIENT_PROGRAM,
            '--',
            module,
            JSON.stringify(request),
          ])
        )
      );
      assert.deepEqual(acknowledged, original);
      let gone = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        current();
        const session = await planOfficeSession(await owner.request('/api/sessions/' + targetSid), targetSid);
        if (
          session.pid === null &&
          JSON.parse(
            metadata([
              'exec',
              control,
              node,
              '--input-type=module',
              '-e',
              PLAN_OFFICE_WEBSITE_GONE_PROGRAM,
              '--',
              module,
              JSON.stringify({ value: original, controlCommand }),
            ])
          ) === true
        ) {
          gone = true;
          break;
        }
        await wait(100);
      }
      assert.equal(gone, true, 'One website detach outcome unconfirmed; never repeat it');
      evidence.save('viewer-detach-confirmed', { original, exitedAndAbsentFromOriginalCensus: true });
    },
    command,
    verify: (beforeValue, afterValue, transport) => {
      const before = beforeValue as Awaited<ReturnType<typeof snapshot>>,
        after = afterValue as Awaited<ReturnType<typeof snapshot>>;
      assert.deepEqual(after.draft, before.draft);
      assert.deepEqual(after.journals, before.journals);
      for (const who of ['caller', 'target']) {
        const a = before.records[who]!,
          b = after.records[who]!;
        assert.deepEqual(
          { ...b, website: undefined, viewCurrent: undefined },
          { ...a, website: undefined, viewCurrent: undefined }
        );
        if (who === 'caller' || transport === 'same') assert.deepEqual(b.website, a.website);
        else {
          assert.notEqual(b.website.pid, a.website.pid);
          const omitClient = ({
            pid: _pid,
            birth: _birth,
            tty: _tty,
            ttyStamp: _stamp,
            ...rest
          }: PlanOfficeWebsiteClient) => rest;
          assert.deepEqual(omitClient(b.website), omitClient(a.website));
        }
      }
    },
    record: (name, value) => evidence.save(name, value),
  });
  const before = result.before as Awaited<ReturnType<typeof snapshot>>,
    after = result.after as Awaited<ReturnType<typeof snapshot>>,
    revoked = result.revoked as Awaited<ReturnType<typeof snapshot>>;
  const websiteProjection = ({ socketPath, ...value }: PlanOfficeWebsiteClient) => ({
    ...value,
    socketPathSha256: planOfficeViewerDigest(socketPath),
  });
  const providerProjection = (value: z.infer<typeof native>, threadId: string) => ({
    paneId: value.paneId,
    panePid: value.panePid,
    paneStartTicks: value.paneStartTicks,
    threadId,
    hookGenerationSha256: planOfficeViewerDigest(value.hooks.generation),
  });
  const fences = before.records.target!.fences;
  const receipt = PlanOfficeViewerRepairCompletion.parse({
    version: 1,
    purpose: 'reverie-ci-team-viewer-repair-completed-v1',
    id: result.id,
    controlId: control,
    callerEmployeeId: caller.employeeId,
    employeeId: target.employeeId,
    callerSessionId: callerSid,
    sessionId: targetSid,
    sessionGeneration: initial.target.row.request.sessionGeneration,
    operationId: initial.target.row.request.operationId,
    containerId: initial.target.row.destination!.containerId,
    callerNative: providerProjection(callerNative, caller.nativeThreadId),
    targetNative: providerProjection(targetNative, target.nativeThreadId),
    oldWebsite: websiteProjection(before.records.target!.website),
    newWebsite: websiteProjection(after.records.target!.website),
    afterRevokeWebsite: websiteProjection(revoked.records.target!.website),
    commands: [result.status, result.repaired, result.connected, result.denied],
    draft: {
      sha256: before.draft.nativeDraftSha256,
      occurrences: 1,
      targetTurnFilesSha256: planOfficeViewerDigest(JSON.stringify(before.draft.targetTurns)),
      consumingHistoryBarriersSha256: planOfficeViewerDigest(JSON.stringify(before.draft.consumingHistoryBarriers)),
    },
    paidJournalSha256: before.journals.provider,
    kernelPolicySha256: dockerContinuationDigest(Object.values(before.records).map((record) => record.kernel)),
    canonicalScopeSha256: dockerContinuationDigest(Object.values(before.records).map((record) => record.scope)),
    inputFences: fences,
    activeUnknownInputExercised: [fences.publicTerminal, fences.savedTerminal].some(
      (flag) => flag.present && flag.value === true
    ),
    unknownPipelineHistoryNativeQualified: false,
    sdkInheritedMinusOnlyMux: true,
    realPackagedCliAndHttp: true,
    oneWebsiteClientOnly: true,
    originalPaidProviderAndDraftRetained: true,
    grantRevokedAndReadBack: true,
    currentAfterCallerGrantRevoked: revoked.records.target!.viewCurrent,
    productViewCurrentAfterRepair: after.records.target!.viewCurrent,
    productViewCurrentAfterCallerRevoke: revoked.records.target!.viewCurrent,
    limitation: 'External fake provider; no paid vendor/chat/self/website-restart recovery proof.',
  });
  evidence.save('team-viewer-repair-completed', receipt);
}

async function runPlanOfficeMoveLeg(
  input: Input,
  evidence: Evidence,
  driver: Driver,
  control: string,
  owner: Pick<Awaited<ReturnType<typeof enrollIsolatedPlanOfficeOwner>>, 'request'>,
  home: string,
  leg: PlanOfficeSelfLeg = 'first',
  previous?: PlanOfficeSelfCompletion,
  kind: 'self' | 'owner-force' | 'agent-force' | 'team' = 'self',
  actors?: { employeeId: string; callerEmployeeId: string; forbiddenIds: readonly string[] }
) {
  const direction = planOfficeSelfDirection(leg);
  if (kind === 'owner-force' || kind === 'agent-force') assert.equal(leg, 'return');
  const names = driver.names;
  assert.equal(input.bootstrap.employees.length, kind === 'team' ? 2 : 1);
  assert.equal(kind === 'team', actors !== undefined);
  const initialEmployee = input.bootstrap.employees.find(
    (e) => e.employeeId === (actors?.employeeId ?? input.bootstrap.employees[0]!.employeeId)
  )!;
  assert.ok(initialEmployee);
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
  assert.equal(saved.subscriptionProfile?.id, direction.fromAccount);
  const caller =
    actors &&
    DockerEmployeeContinuationRecord.parse(
      ((readPrivate(path.join(evidence.root, 'data/company.json')) as Json).dockerEmployeeContinuations as Json[]).find(
        (e) => e.employeeId === actors.callerEmployeeId
      )
    );
  if (caller) {
    assert.equal(caller.phase, 'ready');
    assert.ok(caller.destination);
    assert.notEqual(caller.employeeId, row.employeeId);
    assert.notEqual(caller.request.sessionId, row.request.sessionId);
    assert.notEqual(caller.destination.containerId, row.destination.containerId);
  }
  if (leg === 'return') {
    assert.ok(previous, 'Return move requires the physically completed first move');
    assert.equal(previous.record.phase, 'completed');
    assert.equal(row.version, 3, 'Return move must use the actual installed-generation worker');
    assert.equal(row.employeeId, previous.scenario.employeeId);
    assert.equal(row.request.sessionId, previous.record.newSession);
    assert.equal(row.request.sessionGeneration, previous.scenario.sessionGeneration + 1);
    assert.equal(row.version === 3 && row.planReplacement.moveId, previous.scenario.id);
    assert.equal(row.version === 3 && row.planReplacement.account.id, direction.fromAccount);
  } else assert.equal(previous, undefined);
  const scenario = {
    version: 1 as const,
    purpose: 'reverie-ci-plan-move-scenario-v1' as const,
    kind,
    id: randomUUID(),
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    ...direction,
  };
  if (previous) assert.notEqual(scenario.id, previous.scenario.id);
  if (kind === 'team') {
    assert.ok(actors);
    assert.equal(actors.forbiddenIds.length, 4);
    for (const id of actors.forbiddenIds) {
      z.string().uuid().parse(id);
      assert.notEqual(scenario.id, id, 'Denied or uncertain IDs can never be reused');
    }
    const fixture = new Evidence(path.join(home, '.fixture'), true);
    try {
      fixture.save('plan-team-cooperation-' + scenario.id, {
        version: 1,
        purpose: 'reverie-ci-team-positive-cooperation-v1',
        id: scenario.id,
      });
    } finally {
      fixture.close();
    }
    evidence.save('team-positive-cooperation-' + scenario.id, { id: scenario.id, externalModelOnly: true });
  }
  const sourceInspect = DockerEmployeeInspect.parse(driver.inspect(row.destination.containerId));
  const instanceId = z
    .string()
    .uuid()
    .parse((readPrivate(path.join(evidence.root, 'data/docker-runtime/worker-identity.json')) as Json).instanceId);
  const homeStat = fs.lstatSync(home);
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
    home: { source: home, dev: String(homeStat.dev), ino: String(homeStat.ino), user: driver.user },
    canonicalAuthDigest: planOfficeCanonicalAuthDigest(evidence.root, direction.toAccount),
  };
  const moveName =
    kind === 'owner-force'
      ? 'owner-force-move-'
      : kind === 'agent-force'
        ? 'agent-force-move-'
        : kind === 'team'
          ? 'team-move-'
          : 'self-move-';
  evidence.save(leg === 'first' && kind !== 'team' ? 'before-self-move' : 'before-' + moveName + scenario.id, before);
  const ownerGet = async (p: string) => {
    current();
    const result = await owner.request(p);
    current();
    return result;
  };
  const currentSource = () => {
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
  };
  let sdkProof:
    | { prepared: z.infer<typeof PlanOfficeAgentForceReceipt>; native: { panePid: number; paneStartTicks: string } }
    | undefined;
  const sdkForce = async () => {
    assert.equal(kind, 'agent-force');
    currentSource();
    // Only the actual SDK will select its inherited identity and create the handoff.
    const input = PlanOfficeAgentForceInput.parse({
      version: 1,
      purpose: 'reverie-ci-sdk-agent-force-v1',
      id: scenario.id,
      employeeId: scenario.employeeId,
      sessionId: scenario.sessionId,
      sessionGeneration: scenario.sessionGeneration,
      fromAccount: scenario.fromAccount,
      toAccount: scenario.toAccount,
    });
    const fixture = new Evidence(path.join(home, '.fixture'), true);
    try {
      fixture.save('plan-agent-force-input-' + input.id, input);
    } finally {
      fixture.close();
    }
    evidence.save('agent-force-prepare-' + input.id + '-intent', {
      input,
      context: 'actual-sdk-inherited-minus-only-mux',
      noRetry: true,
    });
    await data(
      await owner.request(
        '/api/sessions/' + input.sessionId + '/input',
        'POST',
        planOfficeAgentForcePrompt(input.id, 'PREPARE')
      )
    );
    const receiptFile = path.join(home, '.fixture', 'plan-agent-force-prepared-' + input.id + '.json');
    let prepared: z.infer<typeof PlanOfficeAgentForceReceipt> | undefined;
    for (let index = 0; index < 100; index++) {
      currentSource();
      if (fs.existsSync(receiptFile)) {
        const candidate = PlanOfficeAgentForceReceipt.parse(readPrivate(receiptFile));
        const session = await planOfficeSession(
          await owner.request('/api/sessions/' + input.sessionId),
          input.sessionId
        );
        const output = await planOfficeTerminal(await owner.request('/api/sessions/' + input.sessionId + '/terminal'));
        if (
          !session.isWorking &&
          !session.providerInputHeld &&
          session.status === 'idle' &&
          output.includes('BCPLAN_FORCE_PREPARED_' + input.id) &&
          output.trimEnd().endsWith('❯')
        ) {
          prepared = candidate;
          break;
        }
      }
      await wait(250);
    }
    assert.ok(prepared, 'SDK preparation outcome unknown; no execute input may follow');
    assert.equal(prepared.kind, 'prepared');
    assert.deepEqual(PlanOfficeAgentForceInput.strip().parse(prepared), input);
    assert.equal(prepared.identityFileDigest, planOfficeForceDigest(planOfficeSelfIdentityFile(row)));
    assert.equal(prepared.handoffDigest, planOfficeForceDigest(planOfficeForceHandoff(input)));
    const age = Date.now() - prepared.capabilitiesCheckedAt;
    assert.ok(age >= 0 && age <= 35000);
    const reportNames = fs
      .readdirSync(path.join(home, '.fixture'))
      .filter((name) => name.startsWith('plan-turn-' + row.request.sessionId + '-'));
    assert.ok(reportNames.length > 0 && reportNames.length <= 128);
    const report = reportNames
      .map((name) => readPrivate(path.join(home, '.fixture', name)) as Json)
      .find((r) => r.state === 'idle' && r.requestId === null && r.sessionId === row.request.sessionId);
    assert.ok(report);
    const native = (
      await verifyPlanOfficeReadyNative(
        row,
        nativeThreadId,
        report as unknown as import('./boxed-plan-provider.js').PlanProviderFixtureReport,
        { current: currentSource, metadata: async (args) => driver.docker([...args]) }
      )
    ).native;
    assert.equal(prepared.namespacePid, native.panePid);
    assert.equal(prepared.nativeBirthTicks, native.paneStartTicks);
    const employee = snapshot().employee;
    assert.equal(employee.sessionId, scenario.sessionId);
    assert.equal(employee.sessionGeneration, scenario.sessionGeneration);
    assert.equal(employee.desiredRunning, true);
    assert.equal(employee.onVacation, false);
    assert.equal(employee.bindingMigration, undefined);
    assert.equal((employee.permissions as Json).moveOwnPlan, true);
    assert.equal((employee.permissions as Json).managePlans, false);
    sdkProof = { prepared, native };
    evidence.save('agent-force-sdk-preflight-' + input.id, { ...sdkProof, inheritedMinusOnlyMux: true });
    currentSource();
    evidence.save('agent-force-execute-' + input.id + '-intent', { id: input.id, noRetry: true });
    await data(
      await owner.request(
        '/api/sessions/' + input.sessionId + '/input',
        'POST',
        planOfficeAgentForcePrompt(input.id, 'EXECUTE')
      )
    );
  };
  const record = await runPlanOfficeMoveScenario(scenario, {
    assertCurrent: async () => current(),
    ownerPost: async (p, body) => {
      if (kind === 'agent-force')
        assert.notEqual(p, '/api/plans/moves/force', 'An SDK force may never use owner force authority');
      if (p === '/api/plans/moves/force') currentSource();
      else current();
      const result = await owner.request(p, 'POST', body);
      current();
      return result;
    },
    agentForce: sdkForce,
    capsule: async (args) => {
      currentSource();
      const actor = caller ?? row;
      if (caller) {
        const actual = (
          (readPrivate(path.join(evidence.root, 'data/company.json')) as Json).dockerEmployeeContinuations as Json[]
        ).find((e) => e.employeeId === caller.employeeId);
        assert.deepEqual(DockerEmployeeContinuationRecord.parse(actual), caller);
        const observed = DockerEmployeeInspect.parse(driver.inspect(caller.destination!.containerId));
        assert.equal(observed.State.Running, true);
        assert.equal(observed.Id, caller.destination!.containerId);
      }
      const identityFile = planOfficeSelfIdentityFile(actor);
      const output = driver.docker([
        'exec',
        '--env',
        'HOME=/home/agent',
        '--env',
        'REVERIE_API_URL=http://reverie:3000',
        '--env',
        'REVERIE_SESSION_ID=' + actor.request.sessionId,
        '--env',
        'REVERIE_WORKER_IDENTITY_FILE=' + identityFile,
        actor.destination!.containerId,
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
  const target = DockerEmployeeContinuationRecord.parse(snapshot().row);
  assert.equal(target.version, 3);
  assert.equal(target.phase, 'ready');
  assert.equal(target.request.sessionId, record.newSession);
  assert.equal(target.request.sessionGeneration, scenario.sessionGeneration + 1);
  assert.equal(target.version === 3 && target.planReplacement.moveId, scenario.id);
  assert.ok(target.destination);
  let agentForceProof: unknown;
  if (kind === 'agent-force') {
    assert.ok(sdkProof, 'Actual SDK preparation/native proof required');
    const issued = PlanOfficeAgentForceReceipt.parse(
      readPrivate(path.join(home, '.fixture', 'plan-agent-force-issued-' + scenario.id + '.json'))
    );
    const spawned = PlanOfficeAgentForceSpawn.parse(
      readPrivate(path.join(home, '.fixture', 'plan-agent-force-spawned-' + scenario.id + '.json'))
    );
    const childClosed = PlanOfficeAgentForceClosed.parse(
      readPrivate(path.join(home, '.fixture', 'plan-agent-force-child-closed-' + scenario.id + '.json'))
    );
    assert.equal(childClosed.id, scenario.id);
    assert.equal(childClosed.proofDigest, planOfficeForceDigest(JSON.stringify(spawned)));
    const { child, ...spawnScope } = spawned;
    assert.deepEqual({ ...spawnScope, kind: 'issued' }, issued);
    assert.equal(child.parentPid, sdkProof.prepared.namespacePid);
    assert.equal(child.sessionId, scenario.sessionId);
    assert.equal(child.identityFileDigest, issued.identityFileDigest);
    const expectedArgs = planOfficeAgentForceArgs(PlanOfficeAgentForceInput.strip().parse(issued));
    assert.equal(child.argsDigest, planOfficeForceDigest(JSON.stringify(planOfficeForceChildArgs(expectedArgs))));
    assert.deepEqual(
      { ...issued, kind: 'prepared', capabilitiesCheckedAt: sdkProof.prepared.capabilitiesCheckedAt },
      sdkProof.prepared
    );
    assert.equal(issued.kind, 'issued');
    assert.ok(issued.capabilitiesCheckedAt >= sdkProof.prepared.capabilitiesCheckedAt);
    const actualRecord = await new PlanMoveStore(path.join(evidence.root, 'data/plan-moves.json')).dockerRecord(
      scenario.id
    );
    current();
    assert.equal(actualRecord.phase, 'completed');
    assert.equal(actualRecord.employeeId, scenario.employeeId);
    assert.equal(actualRecord.oldSession, scenario.sessionId);
    assert.equal(actualRecord.newSession, record.newSession);
    const journal = DockerPlanMoveJournalState.parse(actualRecord.dockerReplacement);
    assert.equal(journal.seed.forceBusy, true);
    assert.equal(journal.seed.moveId, scenario.id);
    assert.equal(journal.seed.source.binding.sessionId, scenario.sessionId);
    assert.equal(journal.seed.source.binding.sessionGeneration, scenario.sessionGeneration);
    const input = PlanOfficeAgentForceInput.parse({
      version: 1,
      purpose: 'reverie-ci-sdk-agent-force-v1',
      id: scenario.id,
      employeeId: scenario.employeeId,
      sessionId: scenario.sessionId,
      sessionGeneration: scenario.sessionGeneration,
      fromAccount: scenario.fromAccount,
      toAccount: scenario.toAccount,
    });
    assert.equal(journal.seed.handoff, planOfficeForceHandoff(input));
    assert.equal(journal.handoff?.phase, 'submitted');
    assert.equal(journal.handoff?.digest, dockerPlanMoveHandoffDigest(journal.seed.handoff));
    agentForceProof = {
      ...sdkProof,
      issued,
      spawned,
      childClosed,
      forceBusy: true,
      handoffDigest: issued.handoffDigest,
      journalHandoffDigest: journal.handoff.digest,
      actualCompletedForceJournal: true,
      inheritedMinusOnlyMux: true,
      forceJournal: {
        id: actualRecord.id,
        employeeId: actualRecord.employeeId,
        oldSession: actualRecord.oldSession,
        newSession: actualRecord.newSession,
        phase: actualRecord.phase,
        sourceGeneration: journal.seed.source.binding.sessionGeneration,
        targetGeneration: journal.seed.target.sessionGeneration,
        forceBusy: journal.seed.forceBusy,
        handoffDigest: planOfficeForceDigest(journal.seed.handoff),
        submittedHandoffDigest: journal.handoff.digest,
      },
    };
    evidence.save('agent-force-sdk-checked-' + scenario.id, agentForceProof);
  }
  evidence.save(
    leg === 'first' && kind !== 'team' ? 'first-self-move-completed' : moveName + scenario.id + '-completed',
    {
      id: scenario.id,
      employeeId: scenario.employeeId,
      fromAccount: scenario.fromAccount,
      toAccount: scenario.toAccount,
      sessionId: scenario.sessionId,
      sessionGeneration: scenario.sessionGeneration,
      newSession: record.newSession,
      realCapsuleHmac: kind !== 'owner-force',
      ...(caller
        ? {
            callerEmployeeId: caller.employeeId,
            callerSessionId: caller.request.sessionId,
            callerContainerId: caller.destination!.containerId,
          }
        : {}),
      ownerApiForce: kind === 'owner-force',
      ...(agentForceProof ? { agentForce: agentForceProof } : {}),
      sourceContainerId: row.destination.containerId,
      targetContainerId: target.destination.containerId,
      targetOperationId: target.request.operationId,
      nativeThreadId,
      physicalReceipt: 'physical-move-' + scenario.id,
      originalOnly: true,
    }
  );
  return { scenario, record };
}

/** The selected current row owns this credential path; no copied old token or MUX override. */
export function planOfficeSelfIdentityFile(row: DockerEmployeeContinuationRecord) {
  assert.ok(row.destination);
  return row.version === 3
    ? dockerPlanGeneration({
        operationId: row.request.operationId,
        containerId: row.destination.containerId,
        projectionDigest: row.planReplacement.account.projectionDigest,
        provider: row.planReplacement.account.provider,
      }).identityFile
    : '/home/agent/.reverie/docker-worker-identity';
}

/** Resume only the never-issued self scenario of an existing owned Ready fixture.
 * No setup, BEGIN, continuation, create, start, account write or new login occurs. */
export async function runPlanOfficeReadySelf(contractFile: string, entered: PlanOfficeStartupCheckpoint = () => {}) {
  entered('ready-self-admission');
  assert.equal(process.platform, 'linux');
  privateDirectory(path.dirname(contractFile));
  const input = PlanOfficeDriverInput.parse(readPrivate(contractFile));
  assert.equal(input.acceptance, 'ordinary-self');
  const actualModule = fileURLToPath(import.meta.url),
    suffix = '/lib/reverie/test/helpers/plan-office-driver.js';
  assert.ok(actualModule.startsWith('/nix/store/') && actualModule.endsWith(suffix));
  const runnerRuntime = actualModule.slice(0, -suffix.length);
  pinned(runnerRuntime);
  pinned(input.runtimePath);
  pinned(input.sourcePath);
  const runnerMetadata = readJsonPinned(path.join(runnerRuntime, 'metadata.json'));
  assert.equal(runnerMetadata.purpose, 'reverie-ci-plan-office-build-v1');
  assert.equal(fs.realpathSync(process.execPath), runnerMetadata.nodeExecutable);
  pinned(runnerMetadata.sourcePath as string);
  const originalMetadata = readJsonPinned(path.join(input.runtimePath, 'metadata.json'));
  assert.equal(originalMetadata.sourcePath, input.sourcePath);
  assert.equal(originalMetadata.nodeExecutable, runnerMetadata.nodeExecutable);
  assert.equal(originalMetadata.dockerExecutable, runnerMetadata.dockerExecutable);
  const root = path.join(path.dirname(contractFile), 'office-' + input.instance);
  privateDirectory(root);
  assert.equal(
    fs.existsSync(path.join(root, 'before-self-move.json')),
    false,
    'Original self scenario already reserved; observe its ID only'
  );
  const evidence = new Evidence(root, true),
    driver = new Driver(input, evidence, originalMetadata.dockerExecutable as string);
  try {
    const { limitation, ...recordedPlan } = readPrivate(path.join(root, 'plan.json')) as Json;
    assert.equal(typeof limitation, 'string');
    const plan = PlanOfficeDriverInput.parse(recordedPlan);
    assert.deepEqual(plan, input);
    for (const role of ['source', 'worker', 'helper', 'control'] as const) {
      const image = input[(role + 'ImageId') as 'sourceImageId'];
      const rows = JSON.parse(driver.docker(['image', 'inspect', image]));
      assert.equal(rows.length, 1);
      driver.configs.set(image, requirePlanOfficeImage(rows[0], input, role));
    }
    const saved = readPrivate(path.join(root, 'created-' + driver.names.control + '.json')) as Json;
    const control = cid.parse(saved.id);
    driver.createdConfigurations.set(control, saved.configuration as Json);
    const actual = driver.owned(control, 'control'),
      state = actual.State as Json;
    assert.equal(state.Running, true);
    const originalBirth = planOfficeControlBirth(z.number().int().positive().parse(state.Pid));
    assert.equal((actual.HostConfig as Json).AutoRemove, false);
    const ports = (actual.NetworkSettings as Json).Ports as Record<string, { HostIp: string; HostPort: string }[]>;
    assert.equal(ports['3000/tcp']!.length, 1);
    assert.equal(ports['3000/tcp']![0]!.HostIp, '127.0.0.1');
    const endpoint = 'http://127.0.0.1:' + ports['3000/tcp']![0]!.HostPort;
    const owner = await resumeIsolatedPlanOfficeOwner(endpoint, path.join(root, 'auth'));
    const employee = input.bootstrap.employees[0]!;
    const current = () => {
      const fresh = driver.owned(control, 'control').State as Json;
      assert.equal(fresh.Running, true);
      assert.equal(fresh.Pid, state.Pid);
      assert.equal(fresh.StartedAt, state.StartedAt);
      assert.equal(planOfficeControlBirth(z.number().int().positive().parse(fresh.Pid)), originalBirth);
    };
    current();
    const begin = readPrivate(path.join(root, 'begin-' + employee.employeeId + '.json')) as Json;
    const operationId = z
      .string()
      .uuid()
      .parse((begin.request as Json).operationId);
    const selection = await planOfficeOriginalStatus(
      await owner.request('/api/company/employees/' + employee.employeeId + '/docker-policy'),
      operationId
    );
    assert.equal((selection.operation as Json).phase, 'ready');
    const session = await planOfficeSession(
      await owner.request('/api/sessions/' + employee.sessionId),
      employee.sessionId
    );
    assert.equal(session.isWorking, false);
    assert.equal(session.status, 'idle');
    assert.equal(session.providerInputHeld, false);
    const terminal = await planOfficeTerminal(await owner.request('/api/sessions/' + employee.sessionId + '/terminal'));
    const home = path.join(root, 'workers', employee.employeeId, 'home');
    privateDirectory(home);
    const reports = fs
      .readdirSync(path.join(home, '.fixture'))
      .filter((n) => /^plan-turn-[A-Za-z0-9-]+\.json$/.test(n))
      .map((n) => readPrivate(path.join(home, '.fixture', n)) as Json);
    const report = reports.find(
      (r) =>
        r.sessionId === employee.sessionId &&
        r.providerThread === employee.nativeThreadId &&
        r.state === 'idle' &&
        r.requestId === null &&
        Array.isArray(r.probes) &&
        r.probes.some(
          (p) =>
            (p as Json).exitCode === 0 &&
            JSON.stringify((p as Json).args) === JSON.stringify(['agent', 'capabilities', '--json'])
        ) &&
        r.probes.some(
          (p) =>
            (p as Json).exitCode === 0 &&
            JSON.stringify((p as Json).args) === JSON.stringify(['worker-callback', 'hook-event', '--event', 'stop'])
        )
    );
    assert.ok(report, 'Original actual startup receipt absent');
    const barrier =
      'BCPLAN_' +
      createHash('sha256')
        .update(employee.sessionId + '\0' + '\0idle')
        .digest('hex');
    assert.ok(terminal.includes(barrier), 'Original consuming-close terminal barrier absent');
    const canonical = readPrivate(path.join(root, 'data/company.json')) as Json;
    const row = DockerEmployeeContinuationRecord.parse(
      (canonical.dockerEmployeeContinuations as Json[]).find((r) => r.employeeId === employee.employeeId)
    );
    assert.equal(row.phase, 'ready');
    assert.deepEqual(row.request, begin.request);
    assert.equal(row.request.sessionId, employee.sessionId);
    const native = await verifyPlanOfficeReadyNative(
      row,
      employee.nativeThreadId,
      report as unknown as import('./boxed-plan-provider.js').PlanProviderFixtureReport,
      { current, metadata: async (args) => driver.docker([...args]) }
    );
    const ownerStatus = await data(await owner.request('/api/owner/status'));
    assert.equal(ownerStatus.signedIn, true);
    assert.equal(ownerStatus.policy, 'enforce');
    current();
    evidence.save('ready-self-native', native);
    evidence.save('ready-self-resume-intent', {
      operationId,
      control,
      actualStartupReceipt: report,
      observedSession: session,
      currentRuntime: runnerRuntime,
      originalRuntime: input.runtimePath,
      noSetupOrRecoveryReplay: true,
    });
    const completed = await runPlanOfficeMoveLeg(input, evidence, driver, control, owner, home);
    const result = {
      scenarioId: completed.scenario.id,
      control,
      planMovesAccepted: true,
      acceptedScenario: 'ordinary-self',
      forceAccepted: false,
      refreshReuseAccepted: false,
      resumedAlreadyReady: true,
    };
    evidence.save('ready-self-completed', result);
    return result;
  } finally {
    evidence.close();
  }
}
function readJsonPinned(file: string): Json {
  pinned(file);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
}

/** Own fixture controller birth only, from actual Engine PID in verified procfs. */
export function planOfficeControlBirth(pid: number) {
  z.number().int().positive().parse(pid);
  const fd = fs.openSync(
    '/proc/' + pid + '/stat',
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  let value: string;
  try {
    assert.equal(fs.statfsSync('/proc/self/fd/' + fd).type, 0x9fa0);
    const b = Buffer.alloc(4097),
      n = fs.readSync(fd, b, 0, b.length, 0);
    assert.ok(n > 0 && n < 4097);
    const text = b.subarray(0, n).toString('utf8');
    assert.ok(Buffer.from(text).equals(b.subarray(0, n)));
    assert.equal(Number(text.slice(0, text.indexOf(' '))), pid);
    value = text.slice(text.lastIndexOf(')') + 2).split(' ')[19]!;
    assert.match(value, /^[1-9][0-9]*$/);
  } finally {
    fs.closeSync(fd);
  }
  return value;
}
