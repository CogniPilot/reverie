/** Driver admission/tuple policy tests only. No Docker/API calls or fake paid authority. */
import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { registerHostGuard } from '../src/web/middleware/auth.js';
import {
  PlanOfficeDriverInput,
  planOfficeNames,
  planOfficeScratchParts,
  removeEmptyPlanOfficeScratch,
  ciPlanPolicy,
  requireSameOperation,
  requireOriginalPolicy,
  runPlanOfficeBaseline,
  requirePlanOfficeImage,
  requirePlanOfficeContainer,
  PLAN_OFFICE_CPU_PROGRAM,
  parsePlanOfficeCpus,
  planOfficeInternalHostPreflight,
} from './helpers/plan-office-driver.js';
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
