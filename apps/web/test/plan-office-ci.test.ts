/** Closed hosted orchestration contracts only; these tests never call Docker or build images. */
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  PLAN_OFFICE_STARTUP_PREFIX,
  PLAN_OFFICE_STARTUP_STAGES,
  planOfficeStartupDiagnostic,
  readPlanOfficeStartupDiagnostic,
  projectPlanOfficeStartupDiagnostic,
  readPlanOfficeBuildDiagnostic,
  projectPlanOfficeBuildDiagnostic,
  projectPlanOfficeNixDiagnostic,
} from './helpers/plan-office-startup-diagnostic.js';
import {
  requireHostedPlanOffice,
  PLAN_OFFICE_CI_SCENARIOS,
  planOfficeCiSelections,
  runPlanOfficeCiSuite,
  createPlanOfficeCiPublishedDirectory,
  planOfficeCiNamespace,
  planOfficeCiImage,
  planOfficeCiContract,
  requirePlanOfficeCiAcceptance,
  planOfficeCiFailureDiagnostic,
  readPlanOfficeCiFailureState,
  requirePlanOfficeCiTeamAcceptance,
} from '../scripts/plan-office-ci.mjs';
const instance = 'a'.repeat(32),
  namespace = planOfficeCiNamespace(instance);
const sha = 'sha256:' + 'b'.repeat(64),
  employeeId = '11111111-1111-4111-8111-111111111111';
const env = { GITHUB_ACTIONS: 'true', REVERIE_CI_RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/private/runner' };
const metadata = {
  version: 1,
  purpose: 'reverie-ci-plan-office-inputs-v1',
  imageNamespace: namespace,
  sourcePath: '/nix/store/' + 'c'.repeat(32) + '-source',
  runtimePath: '/nix/store/' + 'd'.repeat(32) + '-runtime',
  platformClosure: '/nix/store/' + 'e'.repeat(32) + '-closure',
  clientManifestDigest: 'f'.repeat(64),
};
it('retains the actual producer refusal through closed Nix builder records without publishing raw errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-build-diagnostic-'));
  const token = 'HOSTILE_AUTH_TOKEN_DO_NOT_PUBLISH';
  const nil = '0'.repeat(32);
  const record = (frame: string) =>
    '@nix ' + JSON.stringify({ action: 'result', id: 123, type: 101, fields: [frame] }) + '\n';
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.resolve('scripts/build-plan-office.mts'), '--source', path.join(root, token)],
      {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
        env: { HOME: root, TMPDIR: root, PATH: path.dirname(process.execPath), LANG: 'C.UTF-8' },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    // The raw stack contains the deliberately hostile pathname; only the closed
    // producer frame is eligible for the public CI artifact.
    expect(result.stderr).toContain(token);
    expect(result.stdout).not.toContain(token);
    const build = readPlanOfficeBuildDiagnostic(record(result.stdout.trimEnd()));
    expect(build?.builder).toMatchObject({ stage: 'build-inputs', errorClass: 'Error', errorCode: 'ENOENT' });
    const report = planOfficeCiFailureDiagnostic({ status: result.status, signal: result.signal, build }, [], instance);
    expect(report).toMatchObject({ observation: 'last-known-build-stage', fixtureBuild: build });
    expect(JSON.stringify(report)).not.toContain(token);
    const smoke = planOfficeStartupDiagnostic(
      'entry-driver-import',
      nil,
      Object.assign(new Error(token), { code: 'ERR_MODULE_NOT_FOUND' })
    );
    const combined = record(PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(smoke)) + record(result.stdout.trimEnd());
    expect(readPlanOfficeBuildDiagnostic(combined)).toEqual({ builder: build!.builder, importSmoke: smoke });
    const ignored = '@nix ' + JSON.stringify({ action: 'msg', msg: token }) + '\n';
    expect(readPlanOfficeBuildDiagnostic(ignored + combined)).toEqual(readPlanOfficeBuildDiagnostic(combined));
    for (const raw of [
      combined + record(result.stdout.trimEnd()), // Ambiguous repeated builders.
      combined + record(PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(smoke)),
      combined.slice(0, -1),
      result.stdout, // Raw stdout is not a Nix builder record.
      record(PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...build!.builder, message: token })),
      record(PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...build!.builder, instance })),
      record(PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...build!.builder, stage: token })),
      record(PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...build!.builder, errorCode: token })),
      '@nix {"action":"result","type":101,"fields":[' + token + '\n',
    ])
      expect(readPlanOfficeBuildDiagnostic(raw)).toBeUndefined();
    expect(
      planOfficeCiFailureDiagnostic({ build: { builder: { ...build!.builder, message: token } } }, []).fixtureBuild
    ).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const nixRecord = (value: unknown) => '@nix ' + JSON.stringify(value) + '\n';
const nixDrv = '/nix/store/' + 'c'.repeat(32) + '-reverie-ci-plan-office-runtime.drv';
it.each([
  {
    category: 'builder-failure',
    component: 'fixture-runtime',
    source: 'unavailable',
    record: {
      action: 'msg',
      level: 0,
      msg: "error: Cannot build '" + nixDrv + "'.\n       Reason: builder failed with exit code 1.\nHOSTILE_AUTH_TOKEN",
    },
  },
  {
    category: 'dependency-failure',
    component: 'fixture-runtime',
    source: 'unavailable',
    record: {
      action: 'msg',
      level: 0,
      msg: 'error: HOSTILE_AUTH_TOKEN',
      raw_msg: "Cannot build '" + nixDrv + "'.\nReason: 1 dependency failed.\nHOSTILE_AUTH_TOKEN",
    },
  },
  {
    category: 'evaluation-error',
    component: 'unavailable',
    source: 'ci-plan-office-images',
    record: {
      action: 'msg',
      level: 0,
      msg: 'HOSTILE_AUTH_TOKEN',
      file: '/private/HOSTILE_AUTH_TOKEN/nix/ci-plan-office-images.nix',
      line: 42,
      column: 3,
    },
  },
  {
    category: 'nix-error',
    component: 'unavailable',
    source: 'unavailable',
    record: { action: 'msg', level: 0, msg: 'HOSTILE_AUTH_TOKEN', file: null, line: null },
  },
])('retains a child-reported $category before Node producer entry without publishing raw content', (expected) => {
  // A real failed child supplies stderr; these are captured Nix protocol shapes,
  // not a Nix execution or a claim about the hosted failure's underlying cause.
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stderr.write(process.argv[1]);process.exitCode=1', nixRecord(expected.record)],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: path.dirname(process.execPath), LANG: 'C.UTF-8' },
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stderr).toContain('HOSTILE_AUTH_TOKEN');
  const build = readPlanOfficeBuildDiagnostic(result.stderr, instance);
  expect(build?.builder).toBeUndefined();
  expect(build?.nix).toEqual({
    version: 1,
    purpose: 'reverie-ci-plan-office-nix-diagnostic-v1',
    observation: 'last-reported-nix-error',
    instance,
    category: expected.category,
    component: expected.component,
    source: expected.source,
    reports: 'one',
  });
  const report = planOfficeCiFailureDiagnostic({ status: result.status, signal: result.signal, build }, [], instance);
  expect(report.fixtureBuild).toEqual(build);
  expect(report.observation).toBe('last-reported-nix-error');
  expect(JSON.stringify(report)).not.toMatch(/HOSTILE_AUTH_TOKEN|\/private|\/nix\/store|Reason:|exit code/);
});
it('retains only the last reported Nix error alongside independently valid Node checkpoints', () => {
  const nil = '0'.repeat(32),
    token = 'HOSTILE_AUTH_TOKEN';
  const builder = planOfficeStartupDiagnostic('build-product-modules', nil, { name: 'TypeError' });
  const frame = nixRecord({
    action: 'result',
    type: 101,
    fields: [PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(builder)],
  });
  const first = nixRecord({
    action: 'msg',
    level: 0,
    msg: token,
    file: '/private/' + token + '/nix/package.nix',
    line: 1,
  });
  const last = nixRecord({
    action: 'msg',
    level: 0,
    msg: "Cannot build '" + nixDrv + "'.\nReason: 2 dependencies failed.\n" + token,
  });
  const result = readPlanOfficeBuildDiagnostic(first + frame + last, instance);
  expect(result?.builder).toEqual(builder);
  expect(result?.nix).toMatchObject({ category: 'dependency-failure', reports: 'multiple', source: 'unavailable' });
  expect(planOfficeCiFailureDiagnostic({ build: result }, [], instance).observation).toBe('last-known-build-stage');
  expect(JSON.stringify(result)).not.toContain(token);
  expect(readPlanOfficeBuildDiagnostic(first + frame + frame + last, instance)).toBeUndefined();
});
it('retains the first reported builder failure when a later parent dependency failure hides it', () => {
  const token = 'HOSTILE_AUTH_TOKEN';
  const record = (name: string, reason: string) =>
    nixRecord({
      action: 'msg',
      level: 0,
      msg: token,
      raw_msg: "Cannot build '/nix/store/" + 'c'.repeat(32) + '-' + name + ".drv'.\nReason: " + reason + '\n' + token,
    });
  const failed = record('reverie-worker-client-capsule-producer-0.1.0', 'builder failed with exit code 1.');
  const later = record('reverie-ci-plan-office-runtime', 'builder failed with exit code 2.');
  const parent = record('reverie-ci-plan-office-inputs', '2 dependencies failed.');
  const result = readPlanOfficeBuildDiagnostic(failed + later + parent, instance)!;
  expect(result.nix).toMatchObject({ category: 'dependency-failure', reports: 'multiple' });
  expect(result.firstBuilder).toMatchObject({
    observation: 'first-reported-builder-failure',
    category: 'builder-failure',
    component: 'client-capsule-producer',
  });
  expect(planOfficeCiFailureDiagnostic({ build: result }, [], instance).fixtureBuild).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(/HOSTILE_AUTH_TOKEN|\/nix\/store|\.drv|exit code/);
  expect(readPlanOfficeBuildDiagnostic(failed, instance)?.firstBuilder).toBeUndefined();
  for (const firstBuilder of [
    { ...result.firstBuilder, message: token },
    { ...result.firstBuilder, category: 'dependency-failure' },
    { ...result.firstBuilder, observation: 'last-reported-nix-error' },
    { ...result.firstBuilder, instance: 'b'.repeat(32) },
    { ...result.firstBuilder, component: token },
  ])
    expect(projectPlanOfficeBuildDiagnostic({ ...result, firstBuilder }, instance)).toBeUndefined();
  expect(projectPlanOfficeBuildDiagnostic({ firstBuilder: result.firstBuilder }, instance)).toBeUndefined();
  expect(projectPlanOfficeBuildDiagnostic({ nix: result.firstBuilder }, instance)).toBeUndefined();
});
it.each([
  ['reverie-worker-client-bundle', 'client-bundle'],
  ['reverie-worker-client-capsule', 'client-capsule'],
  ['reverie-worker-client-notices', 'client-notices'],
  ['reverie-worker-client-capsule-producer-0.1.0', 'client-capsule-producer'],
  ['reverie-worker-tools-capsule', 'tools-capsule'],
  ['reverie-worker-tools-capsule-producer-0.1.0', 'tools-capsule-producer'],
  ['reverie-perf-guest-capsule', 'guest-capsule'],
  ['reverie-perf-capsule-producer-0.1.0', 'guest-capsule-producer'],
  ['reverie-docker-resources-0.1.0', 'resource-helper'],
  ['reverie-ci-plan-worker-platform', 'worker-platform'],
  ['reverie-worker-client-capsule-HOSTILE_AUTH_TOKEN', 'other-derivation'],
  ['__proto__', 'other-derivation'],
])('classifies only the exact owned build component %s', (name, component) => {
  const raw = nixRecord({
    action: 'msg',
    level: 0,
    msg: "Cannot build '/nix/store/" + 'c'.repeat(32) + '-' + name + ".drv'.\nReason: builder failed with exit code 1.",
  });
  const result = readPlanOfficeBuildDiagnostic(raw, instance);
  expect(result?.nix?.component).toBe(component);
  expect(JSON.stringify(result)).not.toMatch(/HOSTILE_AUTH_TOKEN|\/nix\/store|\.drv/);
});
it.each(['fixture-image', 'other-derivation'] as const)(
  'projects the fixed %s component without retaining a derivation name',
  (component) => {
    const name =
      component === 'fixture-image'
        ? 'docker-image-reverie-ci-plan-office-' + instance + '-control.tar.gz'
        : 'HOSTILE_AUTH_TOKEN-dependency';
    const raw = nixRecord({
      action: 'msg',
      level: 0,
      msg: 'HOSTILE_AUTH_TOKEN',
      raw_msg:
        "Cannot build '/nix/store/" + 'c'.repeat(32) + '-' + name + ".drv'.\nReason: builder failed with exit code 1.",
    });
    const result = readPlanOfficeBuildDiagnostic(raw, instance);
    expect(result?.nix).toMatchObject({ category: 'builder-failure', component });
    expect(JSON.stringify(result)).not.toMatch(/HOSTILE_AUTH_TOKEN|\/nix\/store|tar\.gz|\.drv/);
  }
);
it('ignores ordinary logs, warnings, malformed or oversized records instead of inferring a Nix failure', () => {
  const msg = { action: 'msg', level: 0, msg: 'HOSTILE_AUTH_TOKEN' };
  for (const raw of [
    'error: HOSTILE_AUTH_TOKEN\n',
    nixRecord({ ...msg, level: 3 }),
    nixRecord({ action: 'result', type: 101, fields: [nixRecord(msg)] }),
    nixRecord({ action: 'start', type: 105, text: 'HOSTILE_AUTH_TOKEN' }),
    nixRecord({ ...msg, msg: '' }),
    nixRecord([]),
    '@nix {"action":\n',
    nixRecord(msg).slice(0, -1),
    nixRecord({ ...msg, msg: 'x'.repeat(256 * 1024) }),
  ])
    expect(readPlanOfficeBuildDiagnostic(raw, instance)).toBeUndefined();
  expect(readPlanOfficeBuildDiagnostic(nixRecord(msg))).toBeUndefined();
  expect(readPlanOfficeBuildDiagnostic(nixRecord(msg), 'foreign')).toBeUndefined();
});
it('revalidates every outbound Nix enum, closed field and run rather than trusting a projected DTO', () => {
  const token = 'HOSTILE_AUTH_TOKEN',
    raw = nixRecord({ action: 'msg', level: 0, msg: token });
  const nix = readPlanOfficeBuildDiagnostic(raw, instance)!.nix!;
  expect(projectPlanOfficeNixDiagnostic(nix, instance)).toEqual(nix);
  for (const changed of [
    { ...nix, message: token },
    { ...nix, category: token },
    { ...nix, component: token },
    { ...nix, source: token },
    { ...nix, observation: token },
    { ...nix, reports: token },
    { ...nix, instance: 'b'.repeat(32) },
    { ...nix, version: 2 },
    { ...nix, purpose: token },
    { ...nix, [Symbol('untrusted')]: token },
  ]) {
    expect(projectPlanOfficeNixDiagnostic(changed, instance)).toBeUndefined();
    expect(projectPlanOfficeBuildDiagnostic({ nix: changed }, instance)).toBeUndefined();
    expect(planOfficeCiFailureDiagnostic({ build: { nix: changed } }, [], instance).fixtureBuild).toBeUndefined();
  }
  expect(projectPlanOfficeBuildDiagnostic({ nix }, 'b'.repeat(32))).toBeUndefined();
  expect(projectPlanOfficeBuildDiagnostic({ nix, path: token }, instance)).toBeUndefined();
  expect(projectPlanOfficeBuildDiagnostic({ nix, builder: undefined }, instance)).toBeUndefined();
  let reads = 0;
  const getter = {
    ...nix,
    get category() {
      return ++reads === 1 ? nix.category : token;
    },
  };
  expect(projectPlanOfficeNixDiagnostic(getter, instance)?.category).toBe(nix.category);
  expect(reads).toBe(1);
  expect(
    projectPlanOfficeBuildDiagnostic(
      {
        get nix() {
          throw Error(token);
        },
      },
      instance
    )
  ).toBeUndefined();
  expect(
    planOfficeCiFailureDiagnostic(
      {
        get build() {
          throw Error(token);
        },
      },
      [],
      instance
    ).fixtureBuild
  ).toBeUndefined();
});
it('snapshots promoted child and operation fields once so hostile getters cannot change after validation', () => {
  const token = 'HOSTILE_AUTH_TOKEN',
    reads = new Map<string, number>();
  const get = (key: string, value: unknown, limit: number) => {
    const count = (reads.get(key) ?? 0) + 1;
    reads.set(key, count);
    return count <= limit ? value : token;
  };
  const report = planOfficeCiFailureDiagnostic(
    {
      get status() {
        return get('status', 1, 4);
      },
      get signal() {
        return get('signal', 'SIGTERM', 3);
      },
      get errorName() {
        return get('errorName', 'Error', 2);
      },
    },
    [
      {
        get kind() {
          return get('kind', 'request-status', 2);
        },
        get id() {
          return get('id', employeeId, 2);
        },
        get phase() {
          return get('phase', 'executing', 2);
        },
        get httpStatus() {
          return get('httpStatus', 403, 3);
        },
        get errorCode() {
          return get('errorCode', 'FORBIDDEN', 2);
        },
      },
    ],
    instance
  );
  expect(JSON.stringify(report)).not.toContain(token);
  expect(report.child).toEqual({ status: 1, signal: 'SIGTERM', errorName: 'Error' });
  expect(report.operations).toEqual([
    { kind: 'request-status', id: employeeId, phase: 'executing', httpStatus: 403, errorCode: 'FORBIDDEN' },
  ]);
  expect([...reads.values()]).toEqual(Array(8).fill(1));
  expect(() =>
    planOfficeCiFailureDiagnostic(
      {
        get status() {
          throw Error(token);
        },
      },
      [
        {
          get kind() {
            throw Error(token);
          },
        },
      ],
      instance
    )
  ).not.toThrow();
});
it('projects only complete correlated startup stages/classes/codes and never hostile error content', () => {
  const token = 'HOSTILE_AUTH_TOKEN_DO_NOT_PUBLISH';
  const error = Object.assign(new Error(token), {
    code: 'ERR_ASSERTION',
    details: token,
    path: token,
    env: { TOKEN: token },
  });
  error.name = 'AssertionError';
  const value = planOfficeStartupDiagnostic('driver-image-helper', instance, error);
  const frame = PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(value) + '\n';
  expect(readPlanOfficeStartupDiagnostic(frame, instance)).toEqual(value);
  const publicReport = planOfficeCiFailureDiagnostic({ status: 1, signal: null, startup: value }, [], instance);
  expect(publicReport).toMatchObject({
    observation: 'last-known-entered-stage',
    startup: { stage: 'driver-image-helper', errorClass: 'AssertionError', errorCode: 'ERR_ASSERTION' },
  });
  expect(JSON.stringify(publicReport)).not.toContain(token);
  expect(readPlanOfficeStartupDiagnostic(token + '\n' + frame, instance)).toEqual(value);
  expect(
    planOfficeStartupDiagnostic('entry-driver-import', instance, { name: token, code: token, message: token })
  ).toMatchObject({ errorClass: 'unknown', errorCode: null });
  for (const role of ['source', 'worker', 'helper', 'control'] as const)
    expect(PLAN_OFFICE_STARTUP_STAGES).toContain('driver-image-' + role);
  for (const stdout of [
    frame + frame,
    frame.slice(0, -1),
    frame.slice(0, -20),
    'x'.repeat(65536) + frame,
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, message: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, stage: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, errorClass: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, errorCode: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(value).replace('"version":1', '"version":1,"version":1') + '\n',
  ])
    expect(readPlanOfficeStartupDiagnostic(stdout, instance)).toBeUndefined();
  expect(readPlanOfficeStartupDiagnostic(frame, 'b'.repeat(32))).toBeUndefined();
  expect(
    readPlanOfficeStartupDiagnostic(
      frame + PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, instance: 'b'.repeat(32) }) + '\n',
      instance
    )
  ).toBeUndefined();
  expect(projectPlanOfficeStartupDiagnostic({ ...value, instance: 'b'.repeat(32) }, instance)).toBeUndefined();
  expect(
    planOfficeCiFailureDiagnostic({ startup: { ...value, instance: 'b'.repeat(32) } }, [], instance).observation
  ).toBe('unavailable');
  const hostile = {
    get name() {
      throw Error(token);
    },
    get code() {
      throw Error(token);
    },
    get message() {
      throw Error(token);
    },
    get stack() {
      throw Error(token);
    },
  };
  expect(planOfficeStartupDiagnostic('entry-driver-import', instance, hostile)).toMatchObject({
    errorClass: 'unknown',
    errorCode: null,
  });
  expect(
    projectPlanOfficeStartupDiagnostic(
      {
        get stage() {
          throw Error(token);
        },
      },
      instance
    )
  ).toBeUndefined();
  let reads = 0;
  const changing = {
    ...value,
    get stage() {
      return ++reads < 3 ? value.stage : token;
    },
  };
  expect(projectPlanOfficeStartupDiagnostic(changing, instance)).toEqual(value);
  expect(reads).toBe(1);
});
it('requires the explicit hosted-only command before any filesystem, build or Engine effect', () => {
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).not.toThrow();
  expect(requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).toBe('ordinary-self');
  expect(requireHostedPlanOffice(['--ci', '--scenario', 'self-roundtrip'], env, 'linux', 'x64')).toBe('self-roundtrip');
  expect(requireHostedPlanOffice(['--ci', '--scenario', 'self-owner-force'], env, 'linux', 'x64')).toBe(
    'self-owner-force'
  );
  expect(() => requireHostedPlanOffice(['--ci', '--scenario', 'force'], env, 'linux', 'x64')).toThrow();
  for (const args of [[], ['--ci', '--force'], ['--contract', '/private/office']])
    expect(() => requireHostedPlanOffice(args, env, 'linux', 'x64')).toThrow();
  for (const change of [
    { GITHUB_ACTIONS: 'false' },
    { REVERIE_CI_RUNNER_ENVIRONMENT: 'self-hosted' },
    { REVERIE_CI_RUNNER_ENVIRONMENT: undefined },
    { RUNNER_TEMP: 'relative' },
  ])
    expect(() => requireHostedPlanOffice(['--ci'], { ...env, ...change }, 'linux', 'x64')).toThrow();
  expect(() => requireHostedPlanOffice(['--ci'], env, 'darwin', 'x64')).toThrow();
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'arm64')).toThrow();
});
it('requires every supported scenario on PR/main and permits closed quoted manual selections', () => {
  const repositoryWorkflow = path.resolve('../../.github/workflows/image.yml');
  const workflowFile = fs.existsSync(repositoryWorkflow)
    ? repositoryWorkflow
    : path.resolve('test/fixtures/control-coverage/image.yml');
  const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
  const workflow = yaml.load(fs.readFileSync(workflowFile, 'utf8')) as {
    on: {
      workflow_dispatch: { inputs: { plan_office_scenario: { type: string; default: string; options: string[] } } };
    };
    jobs: { image: { steps: Array<{ run?: string; env?: Record<string, string> }> } };
  };
  const input = workflow.on.workflow_dispatch.inputs.plan_office_scenario;
  expect(input.type).toBe('choice');
  expect(input.default).toBe('all');
  expect(input.options).toEqual([
    'all',
    'ordinary-self',
    'self-roundtrip',
    'self-owner-force',
    'self-agent-force',
    'team-plan-move',
  ]);
  expect(planOfficeCiSelections(['--ci', '--scenario', 'all'], env, 'linux', 'x64')).toEqual(PLAN_OFFICE_CI_SCENARIOS);
  for (const choice of PLAN_OFFICE_CI_SCENARIOS)
    expect(planOfficeCiSelections(['--ci', '--scenario', choice], env, 'linux', 'x64')).toEqual([choice]);
  const office = workflow.jobs.image.steps.find((step) => step.run?.includes('scripts/plan-office-ci.mts'))!;
  expect(office.env?.PLAN_OFFICE_SCENARIO).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs.plan_office_scenario || 'all' }}"
  );
  expect(office.run).toContain('--ci --scenario "$PLAN_OFFICE_SCENARIO"');
  expect(office.run).not.toContain('${{');
  for (const hostile of [
    '$(touch /tmp/forbidden)',
    'ordinary-self; echo leaked',
    'self-owner-force\n--force',
    '--help',
  ])
    expect(() => planOfficeCiSelections(['--ci', '--scenario', hostile], env, 'linux', 'x64')).toThrow();
});
it('awaits each isolated scenario before the next and runs all five once without changing the hosted environment', async () => {
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const pending = runPlanOfficeCiSuite(['--ci', '--scenario', 'all'], env, async (args, environment) => {
    calls.push({ args, env: environment });
    if (args[2] === 'self-roundtrip') {
      entered();
      await gate;
    }
  });
  try {
    await paused;
    expect(calls.map((c) => c.args[2])).toEqual(['ordinary-self', 'self-roundtrip']);
    release();
    await pending;
    expect(calls.map((c) => c.args)).toEqual(PLAN_OFFICE_CI_SCENARIOS.map((s) => ['--ci', '--scenario', s]));
    expect(calls.every((c) => c.env === env)).toBe(true);
  } finally {
    release();
    await pending;
  }
});
it('retains a failed or unconfirmed scenario without retrying it or advancing the suite', async () => {
  const failed = new Error('Synthetic original outcome unconfirmed');
  const calls: string[] = [];
  await expect(
    runPlanOfficeCiSuite(['--ci', '--scenario', 'all'], env, async (args) => {
      calls.push(args[2]!);
      if (args[2] === 'self-owner-force') throw failed;
    })
  ).rejects.toBe(failed);
  expect(calls).toEqual(['ordinary-self', 'self-roundtrip', 'self-owner-force']);
  const selected: string[] = [];
  await runPlanOfficeCiSuite(['--ci', '--scenario', 'team-plan-move'], env, async (args) => {
    selected.push(args[2]!);
  });
  expect(selected).toEqual(['team-plan-move']); // Manual diagnosis cannot masquerade as the suite.
  let dispatched = false;
  for (const args of [
    ['--ci', '--scenario', 'all', '--again'],
    ['--no-ci', '--scenario', 'all'],
  ])
    await expect(
      runPlanOfficeCiSuite(args, env, async () => {
        dispatched = true;
      })
    ).rejects.toThrow();
  expect(dispatched).toBe(false);
});
it('keeps separate public artifact slots and refuses to overwrite any earlier attempt or follow a publication symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-suite-publication-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source, { mode: 0o700 });
    const a = createPlanOfficeCiPublishedDirectory(source, 'ordinary-self');
    fs.writeFileSync(path.join(a, 'failure.json'), 'synthetic original unconfirmed outcome');
    const b = createPlanOfficeCiPublishedDirectory(source, 'team-plan-move');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.dirname(b));
    expect(fs.statSync(a).mode & 0o777).toBe(0o700);
    expect(() => createPlanOfficeCiPublishedDirectory(source, 'ordinary-self')).toThrow();
    expect(fs.readFileSync(path.join(a, 'failure.json'), 'utf8')).toBe('synthetic original unconfirmed outcome');
    const foreign = path.join(root, 'foreign'),
      redirected = path.join(root, 'redirected');
    fs.mkdirSync(foreign);
    fs.mkdirSync(redirected);
    fs.symlinkSync(foreign, path.join(redirected, 'acceptance'));
    expect(() => createPlanOfficeCiPublishedDirectory(redirected, 'ordinary-self')).toThrow();
    expect(fs.readdirSync(foreign)).toEqual([]); // Refusal occurs before even making the next directory.
    const guarded = path.join(root, 'guarded');
    fs.mkdirSync(guarded);
    fs.mkdirSync(path.join(guarded, 'acceptance'), { mode: 0o777 });
    fs.chmodSync(path.join(guarded, 'acceptance'), 0o777);
    expect(() => createPlanOfficeCiPublishedDirectory(guarded, 'ordinary-self')).toThrow();
    expect(fs.readdirSync(path.join(guarded, 'acceptance'))).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('publishes useful closed child/operation diagnostics without hostile tokens, freeform errors or objects', () => {
  const token = 'HOSTILE_TOKEN_DO_NOT_PUBLISH_abcdefghijklmnopqrstuv';
  const id = '22222222-2222-4222-8222-222222222222';
  const report = planOfficeCiFailureDiagnostic(
    {
      status: 1,
      signal: null,
      errorName: 'TimeoutError',
      stdout: token,
      stderr: token,
      message: token,
      stack: token,
      env: { TOKEN: token },
    },
    [
      {
        kind: 'request-status',
        id,
        employeeId,
        phase: 'executing',
        movePhase: 'checking',
        httpStatus: 200,
        errorCode: 'CONFLICT',
        error: token,
        token,
        nonceHash: token,
        owner: token,
        handoff: token,
      },
      { kind: 'owner-refusal', httpStatus: 403, errorCode: 'FORBIDDEN', message: token },
      { kind: 'request-status', id: token, phase: token, errorCode: token, sessionId: token },
      { kind: { toString: () => 'request-status', token }, id },
    ]
  );
  expect(report.child).toEqual({ status: 1, signal: null, errorName: 'TimeoutError' });
  expect(report.operations).toEqual([
    {
      kind: 'request-status',
      id,
      employeeId,
      phase: 'executing',
      movePhase: 'checking',
      httpStatus: 200,
      errorCode: 'CONFLICT',
    },
    { kind: 'owner-refusal', httpStatus: 403, errorCode: 'FORBIDDEN' },
  ]);
  expect(JSON.stringify(report)).not.toContain(token);
  expect(
    planOfficeCiFailureDiagnostic({ status: token, signal: { toString: () => 'SIGTERM', token }, errorName: token }, [])
      .child
  ).toEqual({});
  expect(planOfficeCiFailureDiagnostic({ status: null, signal: 'SIGKILL', errorName: 'Error' }, []).child).toEqual({
    status: null,
    signal: 'SIGKILL',
    errorName: 'Error',
  });
});
it('projects only bounded owned observations/canonical phases and preserves an absent original status before failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-diagnostic-'));
  const token = 'PRIVATE_FAKE_PASSWORD_AND_HMAC_DO_NOT_PUBLISH';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(data), { mode: 0o600 });
  try {
    fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
    write('original-3-' + employeeId + '.json', {
      operationId,
      phase: 'completed',
      operation: {
        operationId,
        employeeId,
        phase: 'identity-issued',
        state: 'held',
        code: 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED',
        error: token,
      },
      error: token,
    });
    write('status-' + requestId + '-absent-5.json', {
      id: requestId,
      originalOutcome: 'unknown',
      noRetry: true,
      token,
    });
    write('data/company.json', {
      dockerEmployeeContinuations: [
        { employeeId, phase: 'identity-issued', request: { operationId, sessionId }, credential: token, owner: token },
      ],
    });
    write('data/plan-requests.json', [
      { id: requestId, employeeId, sessionId, phase: 'executing', movePhase: 'checking', error: token },
    ]);
    write('owner-api-refused.json', { status: 409, response: { errorCode: 'CONFLICT', error: token } });
    write('request-' + requestId + '-intent.json', { credential: token, phase: 'completed' });
    write('owner-session.json', { cookie: token, id: requestId, employeeId, phase: 'completed' });
    fs.symlinkSync(path.join(root, 'owner-session.json'), path.join(root, 'status-' + requestId + '-9.json'));
    write('data/plan-moves.json', [{ id: requestId, employeeId: sessionId, phase: 'completed', error: token }]);
    const projected = planOfficeCiFailureDiagnostic(
      { status: 1, signal: null },
      readPlanOfficeCiFailureState(root, employeeId)
    );
    expect(projected.operations).toContainEqual({
      kind: 'recovery-status',
      id: operationId,
      employeeId,
      phase: 'identity-issued',
      state: 'held',
      errorCode: 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED',
    });
    expect(projected.operations).toContainEqual({
      kind: 'request-status',
      id: requestId,
      employeeId,
      state: 'unknown',
      httpStatus: 404,
    });
    expect(projected.operations).toContainEqual({
      kind: 'canonical-request',
      id: requestId,
      employeeId,
      sessionId,
      phase: 'executing',
      movePhase: 'checking',
    });
    expect(JSON.stringify(projected)).not.toContain(token);
    expect(projected.operations.some((record) => record.phase === 'completed')).toBe(false);
    expect(readPlanOfficeCiFailureState(root, 'foreign-secret')).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
it('rejects present foreign scope in original/status receipts rather than relabeling it with the owned filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-diagnostic-scope-'));
  const foreign = '22222222-2222-4222-8222-222222222222';
  const foreignOperation = '33333333-3333-4333-8333-333333333333';
  const ownRequest = '44444444-4444-4444-8444-444444444444';
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  try {
    write('original-1-' + employeeId + '.json', {
      employeeId: foreign,
      operationId: foreignOperation,
      operation: { phase: 'failed', state: 'held', code: 'CONFLICT' },
    });
    write('status-' + foreignOperation + '-1.json', { employeeId: foreign, id: foreignOperation, phase: 'failed' });
    write('original-2-' + employeeId + '.json', {
      employeeId,
      operationId: foreignOperation,
      operation: { employeeId: foreign, phase: 'failed', state: 'held' },
    });
    write('status-' + ownRequest + '-1.json', { employeeId, id: ownRequest, phase: 'executing' });
    const report = planOfficeCiFailureDiagnostic(
      { status: 1, signal: null },
      readPlanOfficeCiFailureState(root, employeeId)
    );
    expect(report.observation).toBe('last-known-retained-data');
    expect(report.operations).toEqual([{ kind: 'request-status', id: ownRequest, employeeId, phase: 'executing' }]);
    expect(JSON.stringify(report)).not.toContain(foreignOperation);
    expect(JSON.stringify(report)).not.toContain(foreign);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
it('selects only fresh namespaced actual Engine IDs and fixed immutable current-source inputs', () => {
  for (const invalid of ['production', '', '../office', 'A'.repeat(32), 'a'.repeat(31)])
    expect(() => planOfficeCiNamespace(invalid)).toThrow();
  const image = { Id: sha, Os: 'linux', Architecture: 'amd64', RepoTags: [namespace + '-source:latest'] };
  expect(planOfficeCiImage(image, namespace, 'source')).toBe(sha);
  for (const change of [
    { Id: 'source:latest' },
    { Architecture: 'arm64' },
    { Os: 'windows' },
    { RepoTags: ['production:latest'] },
    { RepoTags: [...image.RepoTags, 'production:latest'] },
  ])
    expect(() => planOfficeCiImage({ ...image, ...change }, namespace, 'source')).toThrow();
  const ids = { source: sha, worker: sha, helper: sha, control: sha };
  const c = planOfficeCiContract(metadata, instance, ids);
  expect(c.acceptance).toBe('ordinary-self');
  expect(planOfficeCiContract(metadata, instance, ids, 'self-roundtrip').acceptance).toBe('self-roundtrip');
  expect(planOfficeCiContract(metadata, instance, ids, 'self-owner-force').acceptance).toBe('self-owner-force');
  const team = planOfficeCiContract(metadata, instance, ids, 'team-plan-move');
  expect(team.bootstrap.employees).toHaveLength(2);
  expect(team.bootstrap.employees.map((e) => e.permissions)).toEqual([
    { moveOwnPlan: false, managePlans: false },
    { moveOwnPlan: true, managePlans: false },
  ]);
  for (const key of ['employeeId', 'sessionId', 'nativeThreadId'] as const)
    expect(team.bootstrap.employees[0]![key]).not.toBe(team.bootstrap.employees[1]![key]);
  expect(c.bootstrap.employees[0]?.permissions).toEqual({ moveOwnPlan: true, managePlans: false });
  expect(c.sourceProviders[0]?.mode).toBe('ordinary');
  for (const change of [
    { imageNamespace: 'production' },
    { sourcePath: '/tmp/mutable' },
    { runtimePath: '/tmp/mutable' },
    { clientManifestDigest: 'invalid' },
  ])
    expect(() => planOfficeCiContract({ ...metadata, ...change }, instance, ids)).toThrow();
  expect(() => planOfficeCiContract(metadata, instance, { ...ids, worker: 'worker:latest' })).toThrow();
});
it('requires separate team API denial/revocation, positive capsule and physical receipts without claiming the full matrix', () => {
  const id = '22222222-2222-4222-8222-222222222222',
    caller = '33333333-3333-4333-8333-333333333333',
    callerSession = '44444444-4444-4444-8444-444444444444',
    source = '55555555-5555-4555-8555-555555555555',
    target = '66666666-6666-4666-8666-666666666666',
    operation = '77777777-7777-4777-8777-777777777777';
  const root = '/private/team';
  const result = {
    status: 0,
    acceptedScenario: 'team-plan-move',
    baselineReady: true,
    planMovesAccepted: true,
    teamAccepted: true,
    viewerRepairAccepted: true,
    controlId: 'd'.repeat(64),
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
  };
  const receipt = {
    id,
    employeeId,
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    sessionId: source,
    newSession: target,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
    physicalReceipt: 'physical-move-' + id,
    callerContainerId: 'a'.repeat(64),
    sourceContainerId: 'b'.repeat(64),
    targetContainerId: 'c'.repeat(64),
    targetOperationId: operation,
    sessionGeneration: 1,
    nativeThreadId: operation,
  };
  const physical = {
    sourceStopped: true,
    sourceId: receipt.sourceContainerId,
    targetId: receipt.targetContainerId,
    operationId: operation,
    sessionId: target,
    sessionGeneration: 2,
    nativeThreadId: operation,
    actualCallbacksAndConsumingCloses: true,
    pane: {
      paneId: '%9',
      panePid: 200,
      paneStartTicks: '1000',
      hooks: { kind: 'generation', generation: 'ci-target-hook' },
    },
  };
  const callerThread = '88888888-8888-4888-8888-888888888888';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const oldWebsite = {
    sessionId: target,
    muxName: 'reverie-' + target.slice(0, 8),
    pid: 301,
    birth: '1001',
    tty: '/dev/pts/3',
    ttyStamp: 'tty-before',
    parentBirth: '900',
    parentCommandDigest: 'e'.repeat(64),
    serverPid: 302,
    serverBirth: '901',
    socketStamp: 'socket',
    outerPid: 303,
    outerBirth: '902',
    outerCommandDigest: 'f'.repeat(64),
    outerForm: 'paid-launch',
    manifestDigest: 'a'.repeat(64),
    socketPathSha256: 'b'.repeat(64),
  };
  const newWebsite = { ...oldWebsite, pid: 304, birth: '1010', tty: '/dev/pts/4', ttyStamp: 'tty-after' };
  const commands = ['viewer-status', 'reconnect-viewer', 'viewer-status', 'viewer-status'].map((command, i) => ({
    version: 1,
    purpose: 'reverie-ci-sdk-viewer-command-returned-v1',
    id: '11111111-1111-4111-8111-11111111110' + i,
    command,
    expected: i === 3 ? 'denied' : 'allowed',
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    employeeId,
    sessionId: target,
    sessionGeneration: 2,
    namespacePid: 55,
    child: {
      childPid: 600 + i,
      parentPid: 55,
      childBirthTicks: '200' + i,
      nodeStage: '/opt/reverie-worker-client/bin/node',
      argsDigest: digest(
        JSON.stringify([
          '/opt/reverie-worker-client/bin/node',
          '--no-global-search-paths',
          '--no-addons',
          '/opt/reverie-worker-client/bin/reverie.mjs',
          'agent',
          command,
          employeeId,
          '--json',
        ])
      ),
      sessionId: callerSession,
      identityFileDigest: 'c'.repeat(64),
      childMuxAbsent: true,
      requiredEnvironmentMatched: true,
    },
    exitCode: i === 3 ? 4 : 0,
    reconnect:
      i === 3
        ? null
        : {
            state: i === 0 ? 'blocked' : 'connected',
            reason: i === 0 ? 'not-attempted' : 'connected',
            attempts: i ? 1 : 0,
            retryAfterMs: 0,
          },
    stdoutSha256: 'a'.repeat(64),
    stderrSha256: 'b'.repeat(64),
  }));
  const viewer = {
    version: 1,
    purpose: 'reverie-ci-team-viewer-repair-completed-v1',
    id: '99999999-9999-4999-8999-999999999999',
    controlId: result.controlId,
    callerEmployeeId: caller,
    employeeId,
    callerSessionId: callerSession,
    sessionId: target,
    sessionGeneration: 2,
    operationId: operation,
    containerId: receipt.targetContainerId,
    callerNative: {
      paneId: '%1',
      panePid: 55,
      paneStartTicks: '800',
      threadId: callerThread,
      hookGenerationSha256: 'c'.repeat(64),
    },
    targetNative: {
      paneId: '%9',
      panePid: 200,
      paneStartTicks: '1000',
      threadId: operation,
      hookGenerationSha256: digest('ci-target-hook'),
    },
    oldWebsite,
    newWebsite,
    afterRevokeWebsite: { ...newWebsite },
    commands,
    draft: {
      sha256: 'd'.repeat(64),
      occurrences: 1,
      targetTurnFilesSha256: 'e'.repeat(64),
      consumingHistoryBarriersSha256: 'f'.repeat(64),
    },
    paidJournalSha256: 'a'.repeat(64),
    kernelPolicySha256: 'b'.repeat(64),
    canonicalScopeSha256: 'c'.repeat(64),
    inputFences: Object.fromEntries(
      ['publicTerminal', 'savedTerminal', 'publicProvider', 'savedProvider'].map((key) => [
        key,
        { present: false, value: null },
      ])
    ),
    activeUnknownInputExercised: false,
    unknownPipelineHistoryNativeQualified: false,
    sdkInheritedMinusOnlyMux: true,
    realPackagedCliAndHttp: true,
    oneWebsiteClientOnly: true,
    originalPaidProviderAndDraftRetained: true,
    grantRevokedAndReadBack: true,
    currentAfterCallerGrantRevoked: true,
    productViewCurrentAfterRepair: true,
    productViewCurrentAfterCallerRevoke: true,
    limitation: 'External fake provider; no paid vendor/chat/self/website-restart recovery proof.',
  };
  const bootstrapCaller = { sessionId: callerSession, nativeThreadId: callerThread };
  const permissionReceipts = [403, 200, 403, 200].map((status, i) => ({
    version: 1,
    purpose: 'reverie-ci-team-permission-receipt-v1',
    id: `00000000-0000-4000-8000-00000000000${i}`,
    scope: status === 403 ? 'team-request' : 'team-pending',
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    employeeId,
    sessionId: source,
    namespacePid: 55,
    status,
    code: status === 403 ? 'FORBIDDEN' : null,
    success: status === 200,
  }));
  const summary = {
    id,
    employeeId,
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    apiDenialsObserved: true,
    capsulePositive: true,
    callerPreserved: true,
    receipt: 'team-move-' + id + '-completed',
    physicalReceipt: receipt.physicalReceipt,
    permissionReceipts,
    permissionChecks: permissionReceipts.map((receipt) => ({
      ...receipt,
      unchangedNativeAndJournals: true,
      actualSdkProcess: true,
    })),
  };
  expect(
    requirePlanOfficeCiTeamAcceptance(
      result,
      summary,
      receipt,
      physical,
      root,
      caller,
      employeeId,
      viewer,
      bootstrapCaller
    )
  ).toMatchObject({
    teamAccepted: true,
    teamManagePlansGrantRevocationAccepted: true,
    ordinarySelfAccepted: false,
    permissionMatrixAccepted: false,
    agentForceAccepted: false,
  });
  for (const change of [
    { callerPreserved: false },
    { permissionReceipts: permissionReceipts.slice(1) },
    { permissionReceipts: permissionReceipts.map((p, i) => (i === 2 ? { ...p, status: 500 } : p)) },
    { permissionReceipts: permissionReceipts.map((p, i) => (i === 2 ? { ...p, id: permissionReceipts[0]!.id } : p)) },
  ])
    expect(() =>
      requirePlanOfficeCiTeamAcceptance(
        result,
        { ...summary, ...change },
        receipt,
        physical,
        root,
        caller,
        employeeId,
        viewer,
        bootstrapCaller
      )
    ).toThrow();
  for (const change of [
    { realCapsuleHmac: false },
    { callerContainerId: receipt.sourceContainerId },
    { callerSessionId: source },
  ])
    expect(() =>
      requirePlanOfficeCiTeamAcceptance(
        result,
        summary,
        { ...receipt, ...change },
        physical,
        root,
        caller,
        employeeId,
        viewer,
        bootstrapCaller
      )
    ).toThrow();
  expect(() =>
    requirePlanOfficeCiTeamAcceptance(
      result,
      summary,
      receipt,
      { ...physical, actualCallbacksAndConsumingCloses: false },
      root,
      caller,
      employeeId,
      viewer,
      bootstrapCaller
    )
  ).toThrow();
  expect(() =>
    requirePlanOfficeCiTeamAcceptance(
      result,
      summary,
      receipt,
      physical,
      root,
      caller,
      employeeId,
      undefined,
      bootstrapCaller
    )
  ).toThrow();
  expect(() =>
    requirePlanOfficeCiTeamAcceptance(
      { ...result, viewerRepairAccepted: false },
      summary,
      receipt,
      physical,
      root,
      caller,
      employeeId,
      viewer,
      bootstrapCaller
    )
  ).toThrow();
  const acceptViewer = (candidate: unknown) =>
    requirePlanOfficeCiTeamAcceptance(
      result,
      summary,
      receipt,
      physical,
      root,
      caller,
      employeeId,
      candidate,
      bootstrapCaller
    );
  for (const change of [
    { employeeId: caller },
    { callerSessionId: source },
    { sessionId: source },
    { sessionGeneration: 1 },
    { operationId: id },
    { containerId: receipt.sourceContainerId },
    { controlId: 'e'.repeat(64) },
    { targetNative: { ...viewer.targetNative, panePid: 201 } },
    { targetNative: { ...viewer.targetNative, hookGenerationSha256: 'e'.repeat(64) } },
    { callerNative: { ...viewer.callerNative, threadId: operation } },
    {
      callerNative: { ...viewer.callerNative, panePid: 56 },
      commands: commands.map((v) => ({ ...v, namespacePid: 56, child: { ...v.child, parentPid: 56 } })),
    },
    { newWebsite: oldWebsite },
    { newWebsite: { ...newWebsite, outerPid: 305 } },
    { afterRevokeWebsite: { ...newWebsite, pid: 305 } },
    { commands: commands.slice(1) },
    { commands: commands.map((v, i) => (i === 3 ? { ...v, exitCode: 0 } : v)) },
    { commands: commands.map((v, i) => (i === 2 ? { ...v, id: commands[0]!.id } : v)) },
    { commands: commands.map((v, i) => (i === 2 ? { ...v, child: commands[0]!.child } : v)) },
    { commands: commands.map((v, i) => (i === 1 ? { ...v, child: { ...v.child, childMuxAbsent: false } } : v)) },
    { commands: commands.map((v, i) => (i === 1 ? { ...v, child: { ...v.child, argsDigest: 'f'.repeat(64) } } : v)) },
    { commands: commands.map((v, i) => (i === 1 ? { ...v, child: { ...v.child, parentPid: 200 } } : v)) },
    {
      commands: commands.map((v, i) =>
        i === 1 ? { ...v, child: { ...v.child, identityFileDigest: 'f'.repeat(64) } } : v
      ),
    },
    { commands: commands.map((v, i) => (i === 3 ? { ...v, httpStatus: 403 } : v)) },
    { draft: { ...viewer.draft, occurrences: 2 } },
    { productViewCurrentAfterRepair: false },
    { productViewCurrentAfterCallerRevoke: false },
    { currentAfterCallerGrantRevoked: false },
    { activeUnknownInputExercised: true },
    { unknownPipelineHistoryNativeQualified: true },
    { inputFences: { ...viewer.inputFences, savedTerminal: { present: false, value: true } } },
    { inputFences: { ...viewer.inputFences, savedTerminal: { present: true, value: null } } },
    { extraAuthority: true },
  ])
    expect(() => acceptViewer({ ...viewer, ...change })).toThrow();
  expect(
    acceptViewer({
      ...viewer,
      inputFences: { ...viewer.inputFences, savedTerminal: { present: true, value: true } },
      activeUnknownInputExercised: true,
    })
  ).toMatchObject({ activeUnknownInputExercised: true, unknownPipelineHistoryNativeQualified: false });
  expect(acceptViewer(viewer)).toMatchObject({ teamViewerRepairAccepted: true, recoveryGrantRevocationAccepted: true });
  expect(
    acceptViewer({
      ...viewer,
      commands: commands.map((v, i) =>
        i === 2 ? { ...v, child: { ...commands[0]!.child, childBirthTicks: '3000' } } : v
      ),
    })
  ).toMatchObject({ teamViewerRepairAccepted: true });
  expect(() => requirePlanOfficeCiAcceptance(result, receipt, root, employeeId, 'team-plan-move')).toThrow();
});
it('requires both separately completed opposite moves with linked new sessions to accept opt-in roundtrip', () => {
  const root = '/private/owned/office-' + instance;
  const first = {
    id: '22222222-2222-4222-8222-222222222222',
    employeeId,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
    sessionId: '33333333-3333-4333-8333-333333333333',
    sessionGeneration: 1,
    newSession: '44444444-4444-4444-8444-444444444444',
  };
  const returned = {
    ...first,
    id: '55555555-5555-4555-8555-555555555555',
    fromAccount: 'ci-plan-b',
    toAccount: 'ci-plan-a',
    sessionId: first.newSession,
    sessionGeneration: 2,
    newSession: '66666666-6666-4666-8666-666666666666',
  };
  const summary = {
    employeeId,
    firstMoveId: first.id,
    returnMoveId: returned.id,
    firstNewSession: first.newSession,
    returnNewSession: returned.newSession,
    accounts: ['ci-plan-a', 'ci-plan-b', 'ci-plan-a'],
    firstReceipt: 'first-self-move-completed',
    returnReceipt: 'self-move-' + returned.id + '-completed',
  };
  const result = {
    status: 0,
    baselineReady: true,
    planMovesAccepted: true,
    acceptedScenario: 'self-roundtrip',
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
    selfRoundtripAccepted: true,
  };
  const accept = (r: unknown, value: { returned: unknown; summary: unknown } | undefined) =>
    requirePlanOfficeCiAcceptance(r, first, root, employeeId, 'self-roundtrip', value);
  expect(accept(result, { returned, summary })).toMatchObject({
    selfRoundtripAccepted: true,
    returnScenarioId: returned.id,
    forceAccepted: false,
    teamAccepted: false,
  });
  expect(() => accept(result, undefined)).toThrow();
  expect(() => accept({ ...result, selfRoundtripAccepted: false }, { returned, summary })).toThrow();
  for (const change of [
    { id: first.id },
    { sessionId: first.sessionId },
    { sessionGeneration: 1 },
    { newSession: first.sessionId },
    { fromAccount: 'ci-plan-a' },
    { realCapsuleHmac: false },
  ])
    expect(() => accept(result, { returned: { ...returned, ...change }, summary })).toThrow();
  expect(() => accept(result, { returned, summary: { ...summary, returnMoveId: first.id } })).toThrow();
  expect(() => requirePlanOfficeCiAcceptance(result, first, root, employeeId)).toThrow();
  const nativeThreadId = '77777777-7777-4777-8777-777777777777';
  const forceFirst = { ...first, nativeThreadId, targetContainerId: 'a'.repeat(64) };
  const forceReturned = {
    ...returned,
    realCapsuleHmac: false,
    ownerApiForce: true,
    nativeThreadId,
    sourceContainerId: 'a'.repeat(64),
    targetContainerId: 'b'.repeat(64),
    targetOperationId: '88888888-8888-4888-8888-888888888888',
    physicalReceipt: 'physical-move-' + returned.id,
  };
  const forceSummary = {
    ...summary,
    returnKind: 'owner-force',
    returnReceipt: 'owner-force-move-' + returned.id + '-completed',
  };
  const forceResult = {
    ...result,
    acceptedScenario: 'self-owner-force',
    forceAccepted: true,
    ownerForceAccepted: true,
    selfRoundtripAccepted: false,
  };
  const physical = {
    sourceStopped: true,
    sourceId: forceReturned.sourceContainerId,
    targetId: 'b'.repeat(64),
    sessionId: returned.newSession,
    sessionGeneration: 3,
    nativeThreadId,
    operationId: forceReturned.targetOperationId,
    actualCallbacksAndConsumingCloses: true,
  };
  const acceptForce = (value: unknown) =>
    requirePlanOfficeCiAcceptance(forceResult, forceFirst, root, employeeId, 'self-owner-force', {
      returned: forceReturned,
      summary: forceSummary,
      physical: value,
    });
  expect(acceptForce(physical)).toMatchObject({
    ownerForceAccepted: true,
    forceAccepted: true,
    selfRoundtripAccepted: false,
    agentForceAccepted: false,
    exhaustedSourceAccepted: false,
    deadViewerAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { sourceStopped: false },
    { targetId: physical.sourceId },
    { sessionGeneration: 2 },
    { nativeThreadId: employeeId },
    { operationId: employeeId },
    { actualCallbacksAndConsumingCloses: false },
  ])
    expect(() => acceptForce({ ...physical, ...change })).toThrow();
  expect(() => acceptForce(undefined)).toThrow();
  expect(() =>
    requirePlanOfficeCiAcceptance(forceResult, forceFirst, root, employeeId, 'self-owner-force', {
      returned: { ...forceReturned, realCapsuleHmac: true },
      summary: forceSummary,
      physical,
    })
  ).toThrow();
  const sdkReceipt = {
    version: 1,
    purpose: 'reverie-ci-sdk-agent-force-v1',
    kind: 'prepared',
    id: returned.id,
    employeeId,
    sessionId: returned.sessionId,
    sessionGeneration: returned.sessionGeneration,
    fromAccount: 'ci-plan-b',
    toAccount: 'ci-plan-a',
    namespacePid: 42,
    nativeBirthTicks: '1234',
    identityFileDigest: 'c'.repeat(64),
    handoffDigest: 'd'.repeat(64),
    inheritedMuxPresent: true,
    childMuxAbsent: true,
    capabilitiesCheckedAt: 1000,
    moveOwnPlan: true,
    managePlans: false,
  };
  const spawned = {
    ...sdkReceipt,
    kind: 'spawned',
    child: {
      childPid: 43,
      parentPid: 42,
      childBirthTicks: '1235',
      nodeStage: '/opt/reverie-worker-client/bin/node',
      argsDigest: 'f'.repeat(64),
      sessionId: sdkReceipt.sessionId,
      identityFileDigest: sdkReceipt.identityFileDigest,
      childMuxAbsent: true,
      requiredEnvironmentMatched: true,
    },
  };
  const sdk = {
    prepared: sdkReceipt,
    issued: { ...sdkReceipt, kind: 'issued' },
    spawned,
    childClosed: {
      version: 1,
      purpose: 'sdk-force-child-proof-after-close-v1',
      id: sdkReceipt.id,
      proofDigest: createHash('sha256').update(JSON.stringify(spawned)).digest('hex'),
    },
    native: { panePid: 42, paneStartTicks: '1234' },
    inheritedMinusOnlyMux: true,
    actualCompletedForceJournal: true,
    forceBusy: true,
    handoffDigest: sdkReceipt.handoffDigest,
    journalHandoffDigest: 'e'.repeat(64),
    forceJournal: {
      id: returned.id,
      employeeId,
      oldSession: returned.sessionId,
      newSession: returned.newSession,
      phase: 'completed',
      sourceGeneration: returned.sessionGeneration,
      targetGeneration: 3,
      forceBusy: true,
      handoffDigest: sdkReceipt.handoffDigest,
      submittedHandoffDigest: 'e'.repeat(64),
    },
  };
  const agentReturned = { ...forceReturned, ownerApiForce: false, realCapsuleHmac: true, agentForce: sdk };
  const agentSummary = {
    ...forceSummary,
    returnKind: 'agent-force',
    returnReceipt: 'agent-force-move-' + returned.id + '-completed',
  };
  const agentResult = {
    ...forceResult,
    acceptedScenario: 'self-agent-force',
    ownerForceAccepted: false,
    agentForceAccepted: true,
  };
  const acceptAgent = (proof: unknown, extra: Record<string, unknown> = {}) =>
    requirePlanOfficeCiAcceptance(agentResult, forceFirst, root, employeeId, 'self-agent-force', {
      returned: { ...agentReturned, agentForce: proof, ...extra },
      summary: agentSummary,
      physical,
    });
  expect(acceptAgent(sdk)).toMatchObject({
    ordinarySelfAccepted: true,
    forceAccepted: true,
    agentForceAccepted: true,
    ownerForceAccepted: false,
    selfRoundtripAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { inheritedMinusOnlyMux: false },
    { actualCompletedForceJournal: false },
    { forceBusy: false },
    { native: { panePid: 43, paneStartTicks: '1234' } },
    { issued: { ...sdk.issued, childMuxAbsent: false } },
    { prepared: { ...sdkReceipt, managePlans: true } },
    { prepared: { ...sdkReceipt, sessionGeneration: 1 } },
    { handoffDigest: 'bad' },
    { forceJournal: { ...sdk.forceJournal, phase: 'recovery-required' } },
    { forceJournal: { ...sdk.forceJournal, handoffDigest: '0'.repeat(64) } },
    { forceJournal: { ...sdk.forceJournal, targetGeneration: 2 } },
    { spawned: undefined },
    { childClosed: { ...sdk.childClosed, proofDigest: '0'.repeat(64) } },
    { spawned: { ...spawned, child: { ...spawned.child, parentPid: 44 } } },
    { spawned: { ...spawned, child: { ...spawned.child, childMuxAbsent: false } } },
    { spawned: { ...spawned, child: { ...spawned.child, nodeStage: '/opt/reverie-worker-client/bin/reverie' } } },
  ])
    expect(() => acceptAgent({ ...sdk, ...change })).toThrow();
  expect(() => acceptAgent(undefined)).toThrow();
  expect(() => acceptAgent(sdk, { ownerApiForce: true })).toThrow();
});
it('requires both the ordinary-self result and separate real HMAC/physical-completion sentinel', () => {
  const root = '/private/owned/office-' + instance;
  const result = {
    status: 0,
    baselineReady: true,
    planMovesAccepted: true,
    acceptedScenario: 'ordinary-self',
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
  };
  const proof = {
    id: '22222222-2222-4222-8222-222222222222',
    employeeId,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
  };
  expect(requirePlanOfficeCiAcceptance(result, proof, root, employeeId)).toMatchObject({
    ordinarySelfAccepted: true,
    forceAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { status: 1 },
    { baselineReady: false },
    { planMovesAccepted: false },
    { acceptedScenario: 'baseline' },
    { evidence: '/foreign/office' },
    { forceAccepted: true },
    { ownerForceAccepted: true },
  ])
    expect(() => requirePlanOfficeCiAcceptance({ ...result, ...change }, proof, root, employeeId)).toThrow();
  for (const change of [
    { id: 'latest' },
    { employeeId: 'foreign' },
    { fromAccount: 'ci-plan-b' },
    { toAccount: 'ci-plan-a' },
    { realCapsuleHmac: false },
    { originalOnly: false },
  ])
    expect(() => requirePlanOfficeCiAcceptance(result, { ...proof, ...change }, root, employeeId)).toThrow();
  expect(() => requirePlanOfficeCiAcceptance(result, undefined, root, employeeId)).toThrow();
});
it.each([
  { mode: 'single', args: ['--ci'] },
  { mode: 'suite', args: ['--ci', '--scenario', 'all'] },
])('the actual executable refuses an unqualified host before fixtures ($mode)', ({ args }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-refusal-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.resolve('scripts/plan-office-ci.mts'), ...args],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: 'false',
          REVERIE_CI_RUNNER_ENVIRONMENT: 'github-hosted',
          RUNNER_TEMP: temp,
        },
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(temp)).toEqual([]);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});
