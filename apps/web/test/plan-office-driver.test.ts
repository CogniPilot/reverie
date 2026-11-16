/** Driver admission/tuple policy tests only. No Docker/API calls or fake paid authority. */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { registerHostGuard } from '../src/web/middleware/auth.js';
import { installResponseEnvelope } from '../src/web/response-envelope.js';
import { isPlainPromptInput } from '../src/web/route-helpers.js';
import { Session } from '../src/session.js';
import { createHash } from 'node:crypto';
import {
  DockerEmployeeContinuation,
  dockerContinuationDigest,
  type DockerContainerObservation,
  type DockerContinuationStore,
} from '../src/docker-employee-continuation.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import {
  PlanOfficeDriverInput,
  planOfficeNames,
  planOfficeScratchParts,
  planOfficeProviderMode,
  removeEmptyPlanOfficeScratch,
  ciPlanPolicy,
  requireSameOperation,
  requireOriginalPolicy,
  runPlanOfficeBaseline,
  runPlanOfficeReadySelf,
  planOfficeControlBirth,
  requirePlanOfficeImage,
  requirePlanOfficeContainer,
  PLAN_OFFICE_CPU_PROGRAM,
  parsePlanOfficeCpus,
  planOfficeInternalHostPreflight,
  planOfficeSession,
  planOfficeOriginalStatus,
  planOfficeSelfIdentityFile,
  planOfficePermissionProbeInput,
  completePlanOfficeOriginal,
  requirePlanOfficeControlClient,
} from './helpers/plan-office-driver.js';
import { DockerPlanInitialReceipt } from '../src/docker-plan-install-data.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
const sha = 'sha256:' + 'a'.repeat(64),
  sid = '11111111-1111-4111-8111-111111111111',
  eid = '22222222-2222-4222-8222-222222222222',
  thread = '33333333-3333-4333-8333-333333333333',
  oid = '44444444-4444-4444-8444-444444444444';
const employee = {
  employeeId: eid,
  sessionId: sid,
  nativeThreadId: thread,
  name: 'CI Employee',
  account: 'ci-plan-a',
  permissions: {},
};
const raw = {
  version: 1,
  purpose: 'reverie-ci-plan-office-baseline-v1',
  instance: 'b'.repeat(32),
  sourcePath: '/nix/store/' + 'a'.repeat(32) + '-source',
  runtimePath: '/nix/store/' + 'c'.repeat(32) + '-runtime',
  platformClosure: '/nix/store/' + 'd'.repeat(32) + '-closure',
  sourceImageId: sha,
  workerImageId: sha,
  helperImageId: sha,
  controlImageId: sha,
  clientManifestDigest: 'e'.repeat(64),
  bootstrap: { version: 1, purpose: 'reverie-ci-plan-office-bootstrap-v1', employees: [employee] },
};
it('brackets the actual website native19-field plan protocol with fixed protected capsule status calls', () => {
  const control = 'a'.repeat(64),
    manifest = 'b'.repeat(64);
  const readback = {
    version: 1,
    purpose: 'reverie-worker-client-readback-v1',
    manifestDigest: manifest,
    entrySha256: 'c'.repeat(64),
    filesChecked: 12,
    nodeMajor: 22,
    ownerUid: 0,
  };
  const protocol = {
    version: 1,
    purpose: 'reverie-plan-protocol-v1',
    protocol: 1,
    receiptFields: Object.keys(DockerPlanInitialReceipt.shape),
  };
  const execute = vi.fn((args: string[]) => JSON.stringify(args[4] === 'plan-protocol' ? protocol : readback));
  expect(requirePlanOfficeControlClient(control, manifest, execute)).toEqual({
    ...readback,
    protocol: 1,
    readOnly: true,
  });
  expect(execute.mock.calls.map(([args]) => args)).toEqual(
    ['status', 'plan-protocol', 'status'].map((role) => [
      'exec',
      control,
      '/opt/reverie-worker-client/bin/reverie',
      'worker-client',
      role,
      '--expected-digest',
      manifest,
    ])
  );
});
it.each([
  'wrong-manifest',
  'nonroot',
  'unknown-field',
  'old-protocol',
  'missing-field',
  'changed-entry',
  'missing-readback',
] as const)('refuses %s website capsule/protocol DATA before any provider intent', (kind) => {
  const manifest = 'b'.repeat(64);
  const readback = {
    version: 1,
    purpose: 'reverie-worker-client-readback-v1',
    manifestDigest: manifest,
    entrySha256: 'c'.repeat(64),
    filesChecked: 12,
    nodeMajor: 22,
    ownerUid: 0,
  };
  const protocol = {
    version: 1,
    purpose: 'reverie-plan-protocol-v1',
    protocol: 1,
    receiptFields: Object.keys(DockerPlanInitialReceipt.shape),
  };
  if (kind === 'wrong-manifest') readback.manifestDigest = 'd'.repeat(64);
  if (kind === 'nonroot') readback.ownerUid = 1000;
  if (kind === 'unknown-field') Object.assign(protocol, { capable: true });
  if (kind === 'old-protocol') protocol.protocol = 0;
  if (kind === 'missing-field') protocol.receiptFields.pop();
  let statuses = 0;
  expect(() =>
    requirePlanOfficeControlClient('a'.repeat(64), manifest, (args) => {
      if (args[4] === 'plan-protocol') return JSON.stringify(protocol);
      if (kind === 'missing-readback') return '';
      if (++statuses === 2 && kind === 'changed-entry') readback.entrySha256 = 'd'.repeat(64);
      return JSON.stringify(readback);
    })
  ).toThrow();
});
it('refuses invalid website/digest selectors before a fixed qualification command', () => {
  const execute = vi.fn();
  for (const [control, manifest] of [
    ['name', 'b'.repeat(64)],
    ['a'.repeat(64), '../manifest'],
  ])
    expect(() => requirePlanOfficeControlClient(control!, manifest!, execute)).toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it('submits the actual team probe body as a production normal owner mux prompt with separate Enter', () => {
  const body = planOfficePermissionProbeInput(oid);
  expect(body.useMux).toBe(true);
  expect(isPlainPromptInput(body.input)).toBe(true);
  expect(body.input.slice(0, -1)).toBe('BOXED_PLAN_PERMISSION_PROBE_' + oid);
  // Production plain-prompt classification rejects LF: mux strips it without submitting Enter.
  expect(isPlainPromptInput('BOXED_PLAN_PERMISSION_PROBE_' + oid + '\n')).toBe(false);
  for (const invalid of [oid + '\r', oid + '\n', '../escape', 'not-a-uuid'])
    expect(() => planOfficePermissionProbeInput(invalid)).toThrow();
});
it('admits only explicit same-run namespace/immutable artifact IDs and inactive bootstrap DATA', () => {
  const input = PlanOfficeDriverInput.parse(raw);
  expect(input.bootstrap.employees[0]!.nativeThreadId).toBe(thread);
  expect(planOfficeNames(input.instance).control).toBe('reverie-ci-plan-office-' + input.instance + '-control');
  for (const altered of [
    { ...raw, sourceImageId: 'latest' },
    { ...raw, runtimePath: '/tmp/mutable' },
    { ...raw, instance: 'production' },
    { ...raw, endpoint: 'http://production:3000' },
    { ...raw, bootstrap: { ...raw.bootstrap, binding: { containerId: 'a'.repeat(64) } } },
  ])
    expect(() => PlanOfficeDriverInput.parse(altered)).toThrow();
});
it('uses bounded CI limits with actual selected CPU data and rejects foreign operation/source tuples', () => {
  const policy = ciPlanPolicy([1, 3]);
  expect(policy.memoryMaxBytes).toBe(536870912);
  expect(policy.memoryHighBytes).toBe(402653184);
  expect(policy.pool.memoryMaxBytes).toBe(2147483648);
  for (const cpus of [[], [3, 1], [1, 1], [-1], [4096]]) expect(() => ciPlanPolicy(cpus)).toThrow();
  const e = PlanOfficeDriverInput.parse(raw).bootstrap.employees[0]!;
  const selection = {
    sessionId: sid,
    sessionGeneration: 1,
    sourceDigest: 'a'.repeat(64),
    containerId: 'b'.repeat(64),
    imageId: sha,
    destinationImageId: sha,
    operationId: null,
  };
  expect(requireOriginalPolicy(selection, e, 'b'.repeat(64), sha).sessionId).toBe(sid);
  expect(() => requireOriginalPolicy({ ...selection, operationId: oid }, e, 'b'.repeat(64), sha)).toThrow();
  expect(() => requireOriginalPolicy({ ...selection, sessionId: thread }, e, 'b'.repeat(64), sha)).toThrow();
  expect(
    requireSameOperation({ operationId: oid, phase: 'ready', state: 'ready', allowedActions: [] }, oid).state
  ).toBe('ready');
  expect(() =>
    requireSameOperation({ operationId: thread, phase: 'ready', state: 'ready', allowedActions: [] }, oid)
  ).toThrow();
});
it('refuses product/native images without exact CI factory config and namespace aliases', () => {
  const input = PlanOfficeDriverInput.parse(raw),
    name = planOfficeNames(input.instance).prefix;
  const image = {
    Id: sha,
    Os: 'linux',
    Architecture: 'amd64',
    RepoTags: [name + '-worker:latest'],
    Config: {
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: [],
      Labels: {
        'org.reverie.fixture': 'ci-plan-office-v1',
        'org.reverie.worker-client.manifest': input.clientManifestDigest,
      },
    },
  };
  expect(() => requirePlanOfficeImage(image, input, 'worker')).not.toThrow();
  for (const Cmd of [undefined, null, []])
    expect(() => requirePlanOfficeImage({ ...image, Config: { ...image.Config, Cmd } }, input, 'worker')).not.toThrow();
  const omitted = Object.fromEntries(Object.entries(image.Config).filter(([key]) => key !== 'Cmd'));
  expect(() => requirePlanOfficeImage({ ...image, Config: omitted }, input, 'worker')).not.toThrow();
  for (const Cmd of [['unexpected'], '', false, {}])
    expect(() => requirePlanOfficeImage({ ...image, Config: { ...image.Config, Cmd } }, input, 'worker')).toThrow();
  expect(() => requirePlanOfficeImage({ ...image, RepoTags: ['reverie-worker:latest'] }, input, 'worker')).toThrow();
  expect(() =>
    requirePlanOfficeImage({ ...image, Config: { ...image.Config, Entrypoint: ['/bin/bash'] } }, input, 'worker')
  ).toThrow();
});
it('refuses mutable-checkout physical execution before any office directory or Engine operation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-driver-'));
  fs.chmodSync(root, 0o700);
  try {
    const file = path.join(root, 'contract.json');
    fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
    await expect(runPlanOfficeBaseline(file)).rejects.toThrow('immutable CI package');
    expect(fs.readdirSync(root)).toEqual(['contract.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('executes the exact read-only CPU metadata expression and validates canonical finite CPU sets', () => {
  const actual = spawnSync(process.execPath, ['-e', PLAN_OFFICE_CPU_PROGRAM], { encoding: 'utf8', timeout: 5000 });
  expect(actual.status, actual.stderr).toBe(0);
  expect(parsePlanOfficeCpus(actual.stdout).length).toBeGreaterThan(0);
  expect(parsePlanOfficeCpus('1-3,7')).toEqual([1, 2, 3, 7]);
  for (const invalid of ['', '1,,2', '3-1', '0-4096', '2,1', '1,1'])
    expect(() => parsePlanOfficeCpus(invalid)).toThrow();
});
it('requires the exact owned unprivileged metadata config and bind projection before any START', () => {
  const expected = {
    Image: sha,
    User: '1001:118',
    Entrypoint: ['/opt/reverie-worker-client/bin/node'],
    Cmd: [],
    Env: ['HOME=/home/agent'],
    WorkingDir: '/tmp',
    Labels: { 'reverie.disposable': 'b'.repeat(32) },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      Mounts: [
        {
          Type: 'bind',
          Source: '/owned/new/home',
          Target: '/home/agent',
          BindOptions: { Propagation: 'rprivate', NonRecursive: true },
        },
      ],
    },
  };
  const actual = {
    Image: sha,
    Config: {
      User: expected.User,
      Entrypoint: expected.Entrypoint,
      Cmd: [],
      Env: expected.Env,
      WorkingDir: '/tmp',
      Labels: expected.Labels,
    },
    HostConfig: { ...expected.HostConfig, PidMode: '', UTSMode: '', GroupAdd: null, Devices: null, Tmpfs: null },
    Mounts: [
      { Type: 'bind', Source: '/owned/new/home', Destination: '/home/agent', RW: true, Propagation: 'rprivate' },
    ],
  };
  expect(() => requirePlanOfficeContainer(actual, expected)).not.toThrow();
  for (const key of ['Privileged', 'ReadonlyRootfs'] as const) {
    const changed = structuredClone(actual);
    changed.HostConfig[key] = !changed.HostConfig[key];
    expect(() => requirePlanOfficeContainer(changed, expected)).toThrow();
  }
  const foreign = structuredClone(actual);
  foreign.Mounts[0]!.Source = '/personal/home';
  expect(() => requirePlanOfficeContainer(foreign, expected)).toThrow();
  const alias = structuredClone(actual);
  alias.Mounts[0]!.RW = false;
  expect(() => requirePlanOfficeContainer(alias, expected)).toThrow();
});

it('refuses invalid physical CLI admission before importing product configuration or creating a HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cli-refuse-'));
  fs.chmodSync(root, 0o700);
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.resolve('test/fixtures/plan-office-canary.mts'), '--help'],
      { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: root } }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Use --contract');
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('selects only the closed legacy source-SID layouts while preserving distinct source and future target identity', () => {
  const input = PlanOfficeDriverInput.parse({
    ...raw,
    sourceLayouts: [{ employeeId: eid, layout: 'operator-recovery' }],
  });
  const source = input.bootstrap.employees[0]!,
    futureTargetSID = '99999999-9999-4999-8999-999999999999';
  expect(planOfficeScratchParts(source, 'employees')).toEqual(['laptops', 'employees', eid]);
  for (const layout of ['operator-recovery', 'operator-sessions'] as const) {
    const parts = planOfficeScratchParts(source, layout);
    expect(parts).toEqual(['laptops', layout, sid]);
    expect(parts).not.toContain(futureTargetSID);
    expect(parts).not.toContain(eid);
  }
  expect(() =>
    PlanOfficeDriverInput.parse({ ...raw, sourceLayouts: [{ employeeId: thread, layout: 'operator-recovery' }] })
  ).toThrow();
  expect(() =>
    PlanOfficeDriverInput.parse({ ...raw, sourceLayouts: [{ employeeId: eid, layout: '../../personal' }] })
  ).toThrow();
});

it('simulates missing ephemeral leaves only after fresh inert proof and refuses nonempty fixture data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-empty-'));
  fs.chmodSync(root, 0o700);
  const scratch = path.join(root, 'scratch'),
    tmp = path.join(scratch, 'tmp');
  try {
    fs.mkdirSync(scratch, 0o700);
    fs.mkdirSync(tmp, 0o700);
    let checked = false;
    removeEmptyPlanOfficeScratch(scratch, () => {
      checked = true;
    });
    expect(checked).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
    fs.mkdirSync(scratch, 0o700);
    fs.mkdirSync(tmp, 0o700);
    fs.writeFileSync(path.join(tmp, 'real-work'), 'retained', { mode: 0o600 });
    expect(() => removeEmptyPlanOfficeScratch(scratch, () => {})).toThrow();
    expect(fs.readFileSync(path.join(tmp, 'real-work'), 'utf8')).toBe('retained');
    expect(() =>
      removeEmptyPlanOfficeScratch(scratch, () => {
        throw Error('Source is running');
      })
    ).toThrow('Source is running');
    expect(fs.existsSync(tmp)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('checks the real advertised Host guard before any provider intent and trusts only the explicit fixture alias', async () => {
  const app = Fastify();
  let allowedHosts: string[] = [];
  registerHostGuard(app, () => ({ bindHost: '0.0.0.0', allowedHosts, tunnelHost: null }));
  app.get('/api/owner/status', () => ({ success: true, data: { signedIn: false } }));
  try {
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(planOfficeInternalHostPreflight(endpoint)).rejects.toThrow('Advertised internal API Host refused');
    allowedHosts = ['reverie'];
    await expect(planOfficeInternalHostPreflight(endpoint)).resolves.toBeUndefined();
    expect(
      (await app.inject({ method: 'GET', url: '/api/owner/status', headers: { host: 'foreign.invalid:3000' } }))
        .statusCode
    ).toBe(403);
    await expect(planOfficeInternalHostPreflight('http://foreign.invalid:3000')).rejects.toThrow();
  } finally {
    await app.close();
  }
});

it('consumes the actual response envelope around a real Session DTO without granting readiness or accepting another SID', async () => {
  const app = Fastify(),
    session = new Session({ id: sid, mode: 'claude', workingDir: '/synthetic/work', useMux: false });
  installResponseEnvelope(app, '');
  app.get('/api/sessions/:id', () => session.toState());
  try {
    const actual = await app.inject({ method: 'GET', url: '/api/sessions/' + sid });
    expect(actual.statusCode).toBe(200);
    const wire = JSON.parse(actual.body);
    expect(wire.success).toBe(true);
    expect(wire.data.id).toBe(sid);
    expect(wire.id).toBeUndefined();
    const response = () => new Response(actual.body, { status: actual.statusCode });
    expect((await planOfficeSession(response(), sid)).id).toBe(sid);
    await expect(planOfficeSession(response(), thread)).rejects.toThrow();
    await expect(
      planOfficeSession(new Response(JSON.stringify(session.toState()), { status: 200 }), sid)
    ).rejects.toThrow();
  } finally {
    await app.close();
    await session.stop(false);
  }
});

const recoveryRequest = {
  operationId: oid,
  sessionId: sid,
  sessionGeneration: 1,
  containerId: 'b'.repeat(64),
  imageId: sha,
  expectedDestinationImageId: sha,
  expectedPolicyDigest: 'c'.repeat(64),
  enterOffice: true,
};
const originalSelection = (phase = 'resources-ready', state = 'pending', allowedActions = ['observe', 'continue']) => ({
  operationId: oid,
  sessionId: sid,
  sessionGeneration: 1,
  containerId: recoveryRequest.containerId,
  imageId: sha,
  destinationImageId: sha,
  sourceDigest: 'd'.repeat(64),
  operation: { operationId: oid, phase, state, allowedActions },
});
function recoveryPorts(observations: unknown[]) {
  const records: { name: string; value: unknown }[] = [];
  let index = 0;
  return {
    records,
    observe: vi.fn(async () => {
      const value = observations[Math.min(index++, observations.length - 1)];
      if (value instanceof Error) throw value;
      return value;
    }),
    continueOriginal: vi.fn(
      async (_body: { request: typeof recoveryRequest }, _phase: string) =>
        originalSelection('resources-ready').operation
    ),
    record(name: string, value: unknown) {
      records.push({ name, value });
    },
    pause: vi.fn(async () => {}),
  };
}
const expectedRecovery = { request: recoveryRequest, sourceDigest: 'd'.repeat(64) };
it('retains the same original through bounded read timeouts and journals one advertised continuation before sending only its request', async () => {
  const ports = recoveryPorts([
    new DOMException('Read timed out', 'TimeoutError'),
    originalSelection(),
    originalSelection('ready', 'ready', ['observe']),
  ]);
  ports.continueOriginal.mockImplementation(async (body, phase) => {
    expect(phase).toBe('resources-ready');
    expect(body).toEqual({ request: recoveryRequest });
    expect(ports.records.at(-1)?.name).toBe('continue-resources-ready-intent');
    return originalSelection().operation;
  });
  expect((await completePlanOfficeOriginal(expectedRecovery, true, ports)).state).toBe('ready');
  expect(ports.continueOriginal).toHaveBeenCalledTimes(1);
  expect(ports.records[0]?.name).toBe('read-timeout-0');
  expect(ports.records.find((r) => r.name.endsWith('-intent'))?.value).toEqual({
    operationId: oid,
    phase: 'resources-ready',
    body: { request: recoveryRequest },
    noPolicyApproval: true,
  });
});
it('never repeats a continuation phase and bounds all original observation attempts', async () => {
  const ports = recoveryPorts([originalSelection()]);
  await expect(completePlanOfficeOriginal(expectedRecovery, true, ports)).rejects.toThrow('not confirmed Ready');
  expect(ports.observe).toHaveBeenCalledTimes(180);
  expect(ports.continueOriginal).toHaveBeenCalledTimes(1);
});
it('keeps unknown first or continuation mutation outcomes observation-only even when a later phase advertises continue', async () => {
  const observations = [
    originalSelection(),
    originalSelection('identity-ready'),
    originalSelection('ready', 'ready', ['observe']),
  ];
  const first = recoveryPorts(observations);
  await completePlanOfficeOriginal(expectedRecovery, false, first);
  expect(first.continueOriginal).not.toHaveBeenCalled();
  const later = recoveryPorts(observations);
  later.continueOriginal.mockRejectedValue(new DOMException('Mutation outcome unknown', 'TimeoutError'));
  await completePlanOfficeOriginal(expectedRecovery, true, later);
  expect(later.continueOriginal).toHaveBeenCalledTimes(1);
  expect(later.records.some((r) => r.name === 'continue-resources-ready-unknown')).toBe(true);
});
it('does not infer continuation from issued phases, historical held status or missing server permission', async () => {
  for (const observation of [
    originalSelection('provider-issued'),
    originalSelection('start-issued'),
    originalSelection('resources-issued'),
    originalSelection('resources-ready', 'pending', ['observe']),
    {
      ...originalSelection('resources-ready', 'held'),
      operation: { ...originalSelection().operation, state: 'held', code: 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED' },
    },
  ]) {
    const ports = recoveryPorts([observation, originalSelection('ready', 'ready', ['observe'])]);
    await completePlanOfficeOriginal(expectedRecovery, true, ports);
    expect(ports.continueOriginal).not.toHaveBeenCalled();
  }
  const held = recoveryPorts([
    {
      ...originalSelection(),
      operation: { ...originalSelection().operation, state: 'held', code: 'DOCKER_CONTINUATION_FOREIGN_PROVIDER' },
    },
  ]);
  await expect(completePlanOfficeOriginal(expectedRecovery, true, held)).rejects.toThrow('Original recovery held');
  expect(held.continueOriginal).not.toHaveBeenCalled();
});
it('refuses changed original scope, malformed phases, foreign operations and auth errors before continuation', async () => {
  for (const [key, value] of Object.entries({
    sessionId: thread,
    sessionGeneration: 2,
    containerId: 'f'.repeat(64),
    imageId: 'sha256:' + 'f'.repeat(64),
    destinationImageId: 'sha256:' + 'f'.repeat(64),
    sourceDigest: 'f'.repeat(64),
  })) {
    const ports = recoveryPorts([{ ...originalSelection(), [key]: value }]);
    await expect(completePlanOfficeOriginal(expectedRecovery, true, ports)).rejects.toThrow(
      'Original recovery scope changed'
    );
    expect(ports.continueOriginal).not.toHaveBeenCalled();
  }
  for (const value of [
    { ...originalSelection(), operationId: thread },
    { ...originalSelection(), operation: { ...originalSelection().operation, operationId: thread } },
    originalSelection('future-unreviewed'),
    new Error('Owner authorization changed'),
  ]) {
    const ports = recoveryPorts([value]);
    await expect(completePlanOfficeOriginal(expectedRecovery, true, ports)).rejects.toThrow();
    expect(ports.continueOriginal).not.toHaveBeenCalled();
    expect(ports.observe).toHaveBeenCalledTimes(1);
  }
});
it('does not dispatch a continuation when its durable intent cannot be published', async () => {
  const ports = recoveryPorts([originalSelection()]);
  const record = ports.record;
  ports.record = (name, value) => {
    if (name.endsWith('-intent')) throw Error('Intent close unknown');
    record(name, value);
  };
  await expect(completePlanOfficeOriginal(expectedRecovery, true, ports)).rejects.toThrow('Intent close unknown');
  expect(ports.continueOriginal).not.toHaveBeenCalled();
});
it('consumes actual domain selection and enveloped results after completed native resources without replaying create, start or configure', async () => {
  const policy = ciPlanPolicy([0]),
    sourceDigest = 'd'.repeat(64);
  const original = {
    containerId: recoveryRequest.containerId,
    imageId: sha,
    deployment: 'synthetic',
    employeeId: eid,
    sessionId: sid,
    home: {
      type: 'bind' as const,
      source: '/synthetic-owned-home',
      destination: '/home/agent' as const,
      readWrite: true as const,
    },
    mountDigest: 'a'.repeat(64),
    storageDigest: 'b'.repeat(64),
    configurationDigest: 'c'.repeat(64),
  };
  const destinationOriginal = { ...original, containerId: 'e'.repeat(64), configurationDigest: 'e'.repeat(64) };
  const pool = {
    containerId: 'f'.repeat(64),
    cgroupParent: '/synthetic-pool',
    policyDigest: dockerContinuationDigest(policy.pool),
    physicalDigest: 'f'.repeat(64),
  };
  const request = { ...recoveryRequest, expectedPolicyDigest: dockerContinuationDigest(policy) };
  let row = DockerEmployeeContinuationRecord.parse({
    version: 2,
    purpose: 'docker-employee-continuation-v2',
    employeeId: eid,
    owner: 'synthetic-owner',
    request,
    sourceDigest,
    providerSourceDigest: sourceDigest,
    original,
    workerImage: { imageId: sha, sourceImageId: sha, clientManifestDigest: 'a'.repeat(64) },
    credentialId: thread,
    policy,
    pool,
    destination: destinationOriginal,
    phase: 'resources-ready',
  });
  const subject = {
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: 1,
    owner: 'synthetic-owner',
    sourceDigest,
    providerSourceDigest: sourceDigest,
    onVacation: false,
    desiredRunning: true,
  };
  const authority = { owner: subject.owner, require() {}, requireOffice() {} };
  let destination: DockerContainerObservation = {
    original: destinationOriginal,
    state: 'running',
    resources: policy,
    provider: { kind: 'absent' },
    credentialDigest: null,
  };
  const store: DockerContinuationStore = {
    subject: () => subject,
    existingSubject: () => subject,
    policy: () => policy,
    record: () => row,
    async replace(before, next, current) {
      current();
      expect(row).toEqual(before);
      row = structuredClone(next);
    },
    async bind(_row, _binding, current) {
      current();
    },
    async enterOffice() {
      throw Error('Office entry replay');
    },
  };
  const replay = vi.fn(async () => {
    throw Error('Paid/native original replay');
  });
  const service = new DockerEmployeeContinuation(
    store,
    {
      image: async () => row.workerImage,
      observeSource: async () => ({ original, state: 'stopped' }),
      validateCapabilities: replay,
      preparePool: replay,
      observePool: async () => pool,
      createDestination: replay,
      observeDestination: async () => structuredClone(destination),
      start: replay,
      configureResources: replay,
      async provisionIdentity(_row, token, current) {
        current();
        destination = { ...destination, credentialDigest: createHash('sha256').update(token).digest('hex') };
      },
    },
    {
      async launch(_row, _binding, current) {
        current();
        destination = { ...destination, provider: { kind: 'running', operationId: oid, sessionId: sid } };
      },
    },
    { issue: () => 'synthetic-test-token' }
  );
  const app = Fastify();
  installResponseEnvelope(app, '');
  app.get('/api/policy', () => service.selection(eid, authority));
  app.post('/api/continue', async (req) => {
    expect(req.body).toEqual({ request });
    return service.begin(eid, request, authority);
  });
  const records: string[] = [];
  try {
    await completePlanOfficeOriginal({ request, sourceDigest }, true, {
      async observe() {
        const r = await app.inject({ method: 'GET', url: '/api/policy' });
        return planOfficeOriginalStatus(new Response(r.body, { status: r.statusCode }), oid);
      },
      async continueOriginal(body) {
        const r = await app.inject({ method: 'POST', url: '/api/continue', payload: body });
        expect(r.statusCode).toBe(200);
        return r.json().data;
      },
      record: (name) => {
        records.push(name);
      },
      pause: async () => {},
    });
    expect(row.phase).toBe('ready');
    expect(replay).not.toHaveBeenCalled();
    expect(records.filter((name) => name.endsWith('-intent'))).toEqual(['continue-resources-ready-intent']);
    const actual = await app.inject({ method: 'GET', url: '/api/policy' });
    expect(actual.json().data.operation.allowedActions).toEqual(['observe']);
    await expect(planOfficeOriginalStatus(new Response(actual.body), thread)).rejects.toThrow();
  } finally {
    await app.close();
  }
});

it('defaults canonical move fixtures to nonrotating auth and keeps exhaustion/rotation/pause as closed explicit cases', () => {
  expect(planOfficeProviderMode('ordinary')).toEqual({
    autoApprove: true,
    exhausted: false,
    refreshAccountId: null,
    pauseBeforeApproval: false,
  });
  expect(planOfficeProviderMode('rotate-a').refreshAccountId).toBe('ci-plan-a');
  expect(planOfficeProviderMode('exhausted')).toMatchObject({
    autoApprove: false,
    exhausted: true,
    refreshAccountId: null,
  });
  expect(planOfficeProviderMode('pause-approval').pauseBeforeApproval).toBe(true);
  for (const sourceProviders of [
    [{ employeeId: thread, mode: 'ordinary' }],
    [{ employeeId: eid, mode: 'arbitrary' }],
    [
      { employeeId: eid, mode: 'ordinary' },
      { employeeId: eid, mode: 'rotate-a' },
    ],
  ])
    expect(() => PlanOfficeDriverInput.parse({ ...raw, sourceProviders })).toThrow();
});

it('admits the first ordinary self scenario only for one nonrotating A employee with the actual self grant', () => {
  const good = {
    ...raw,
    acceptance: 'ordinary-self',
    bootstrap: { ...raw.bootstrap, employees: [{ ...employee, permissions: { moveOwnPlan: true } }] },
  };
  expect(PlanOfficeDriverInput.parse(good).acceptance).toBe('ordinary-self');
  expect(PlanOfficeDriverInput.parse({ ...good, acceptance: 'self-roundtrip' }).acceptance).toBe('self-roundtrip');
  expect(PlanOfficeDriverInput.parse({ ...good, acceptance: 'self-owner-force' }).acceptance).toBe('self-owner-force');
  for (const changes of [
    { bootstrap: raw.bootstrap },
    { bootstrap: { ...good.bootstrap, employees: [{ ...employee, permissions: { managePlans: true } }] } },
    { sourceProviders: [{ employeeId: eid, mode: 'rotate-a' }] },
    { acceptance: 'force-implicit' },
  ])
    for (const acceptance of ['ordinary-self', 'self-roundtrip', 'self-owner-force'])
      expect(() => PlanOfficeDriverInput.parse({ ...good, acceptance, ...changes })).toThrow();
});

it('uses the current installed v3 generation credential for the return instead of the legacy source identity', () => {
  const f = dockerPlanJournalFixture();
  expect(planOfficeSelfIdentityFile(f.state.seed.source.record)).toBe('/home/agent/.reverie/docker-worker-identity');
  const row = { ...f.work, destination: { ...f.work.original, containerId: 'c'.repeat(64) } };
  const actual = planOfficeSelfIdentityFile(row);
  expect(actual).toBe(
    '/home/agent/.reverie/plan-moves/' +
      row.request.operationId +
      '/generation-' +
      row.planReplacement.account.projectionDigest +
      '/worker-identity-' +
      row.destination.containerId
  );
  expect(
    planOfficeSelfIdentityFile({ ...row, destination: { ...row.destination, containerId: 'd'.repeat(64) } })
  ).not.toBe(actual);
  expect(() => planOfficeSelfIdentityFile(f.work)).toThrow();
});
it('admits team moves only with two distinct real employees/threads and initially denied explicit caller grants', () => {
  const caller = { ...employee, permissions: { managePlans: false, moveOwnPlan: false } };
  const target = {
    ...employee,
    employeeId: oid,
    sessionId: thread,
    nativeThreadId: sid,
    permissions: { managePlans: false, moveOwnPlan: true },
  };
  const good = { ...raw, acceptance: 'team-plan-move', bootstrap: { ...raw.bootstrap, employees: [caller, target] } };
  expect(PlanOfficeDriverInput.parse(good).acceptance).toBe('team-plan-move');
  for (const employees of [
    [caller],
    [caller, { ...target, nativeThreadId: caller.nativeThreadId }],
    [{ ...caller, permissions: { managePlans: true, moveOwnPlan: false } }, target],
    [caller, { ...target, permissions: { managePlans: false, moveOwnPlan: false } }],
  ])
    expect(() => PlanOfficeDriverInput.parse({ ...good, bootstrap: { ...good.bootstrap, employees } })).toThrow();
  expect(() =>
    PlanOfficeDriverInput.parse({ ...good, sourceProviders: [{ employeeId: eid, mode: 'exhausted' }] })
  ).toThrow();
});

it('refuses mutable ready-only admission without touching existing fixture state or Engine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ready-refuse-'));
  fs.chmodSync(root, 0o700);
  try {
    const file = path.join(root, 'contract.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...raw,
        acceptance: 'ordinary-self',
        bootstrap: { ...raw.bootstrap, employees: [{ ...employee, permissions: { moveOwnPlan: true } }] },
      }),
      { mode: 0o600 }
    );
    await expect(runPlanOfficeReadySelf(file)).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual(['contract.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('reads actual procfs controller birth and refuses nonpositive PID selectors', () => {
  expect(planOfficeControlBirth(process.pid)).toMatch(/^[1-9][0-9]*$/);
  expect(planOfficeControlBirth(process.pid)).toBe(planOfficeControlBirth(process.pid));
  for (const pid of [0, -1, NaN, Infinity]) expect(() => planOfficeControlBirth(pid)).toThrow();
});
