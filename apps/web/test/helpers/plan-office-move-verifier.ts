/** Read-only physical acceptance adapter for the owned synthetic office.
 * This constructs no application proof, launches nothing and exposes no main. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DockerEmployeeContinuationRecord,
  DockerEmployeeBinding,
} from '../../src/docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from '../../src/docker-employee-engine-data.js';
import { dockerContinuationDigest } from '../../src/docker-employee-continuation.js';
import { DockerPlanInstaller } from '../../src/docker-plan-installer.js';
import {
  DOCKER_PROVIDER_VIEW_ENV,
  DOCKER_PROVIDER_VIEW_PROGRAM,
  DOCKER_PROVIDER_VIEW_TMUX,
} from '../../src/docker-employee-provider-view-native.js';
import { planFixtureTurnBarrier, type PlanProviderFixtureReport } from './boxed-plan-provider.js';
import { PlanOfficeMoveScenario } from './plan-office-move-driver.js';
import { planOfficeSession } from './plan-office-driver.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid(),
  image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
type Json = Record<string, unknown>;
type Row = Extract<DockerEmployeeContinuationRecord, { version: 3 }>;
export interface PlanOfficePhysicalPorts {
  current(): void;
  /** Actual fixed Docker metadata command; output remains private evidence. */
  metadata(args: readonly string[]): Promise<string>;
  /** Real private CompanyStore/StateStore read, not a route-selected replacement. */
  snapshot(): { employee: Json; row: unknown };
  ownerGet(path: string): Promise<Response>;
  record(name: string, value: unknown): void;
}
export interface PlanOfficeBeforeMove {
  readonly scenario: PlanOfficeMoveScenario;
  readonly namespace: string;
  readonly fixtureRoot: string;
  readonly workerImageId: string;
  readonly clientManifestDigest: string;
  readonly boxId: string;
  readonly nativeThreadId: string;
  /** Recorded from actual source inspection immediately before the sole request. */
  readonly sourceRow: DockerEmployeeContinuationRecord;
  readonly sourceInspect: DockerEmployeeInspect;
  readonly home: { source: string; dev: string; ino: string; user: string };
  readonly canonicalAuthDigest: string;
}
function stamp(stat: fs.Stats) {
  return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(
    ':'
  );
}
function directory(file: string) {
  assert.equal(fs.realpathSync(file), file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    assert.ok(s.isDirectory());
    assert.equal(s.uid, process.getuid!());
    assert.equal(s.gid, process.getgid!());
    assert.equal(s.mode & 0o777, 0o700);
    return { fd, dev: String(s.dev), ino: String(s.ino) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function privateBytes(file: string, maximum: number) {
  const parent = directory(path.dirname(file));
  let fd: number | undefined, bytes: Buffer | undefined;
  const failures: unknown[] = [];
  try {
    fd = fs.openSync(
      '/proc/self/fd/' + parent.fd + '/' + path.basename(file),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    const st = fs.fstatSync(fd);
    assert.ok(st.isFile());
    assert.equal(st.uid, process.getuid!());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.nlink, 1);
    assert.ok(st.size > 0 && st.size <= maximum);
    bytes = fs.readFileSync(fd);
    assert.equal(bytes.length, st.size);
    assert.equal(stamp(fs.fstatSync(fd)), stamp(st));
    assert.equal(stamp(fs.lstatSync(file)), stamp(st));
  } catch (error) {
    failures.push(error);
  }
  if (fd !== undefined) {
    const owned = fd;
    fd = undefined;
    try {
      fs.closeSync(owned);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    fs.closeSync(parent.fd);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Private fixture read/close unconfirmed');
  assert.ok(bytes);
  return bytes;
}
/** Capture this before dispatch; canonical changes later are not silently accepted. */
export function planOfficeCanonicalAuthDigest(fixtureRoot: string, account: 'ci-plan-a' | 'ci-plan-b') {
  z.enum(['ci-plan-a', 'ci-plan-b']).parse(account);
  return createHash('sha256')
    .update(
      privateBytes(
        path.join(fixtureRoot, 'accounts', account === 'ci-plan-a' ? 'plan-a' : 'plan-b', '.credentials.json'),
        128 * 1024
      )
    )
    .digest('hex');
}
function subject(row: DockerEmployeeContinuationRecord) {
  return {
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    owner: row.owner,
    sourceDigest: row.sourceDigest,
    providerSourceDigest: row.version === 1 ? row.sourceDigest : row.providerSourceDigest,
    onVacation: false,
    desiredRunning: true,
  };
}
function bound(row: DockerEmployeeContinuationRecord) {
  assert.ok(row.destination);
  return DockerEmployeeBinding.parse({
    version: 1,
    operationId: row.request.operationId,
    credentialId: row.credentialId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    containerId: row.destination.containerId,
    imageId: row.destination.imageId,
    originalDigest: dockerContinuationDigest(row.destination),
    policyDigest: dockerContinuationDigest(row.policy),
  });
}
const pane = z
  .object({
    paneId: z.string().regex(/^%[0-9]{1,10}$/),
    panePid: z.number().int().min(2),
    paneStartTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
    hooks: z.object({ kind: z.literal('generation'), generation: z.string().min(1).max(256) }).strict(),
  })
  .strict();
function nodeRead(row: DockerEmployeeContinuationRecord) {
  return [
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
  ];
}
function liveRead(row: Row, home: PlanOfficeBeforeMove['home']) {
  return [
    'exec',
    row.destination!.containerId,
    '/opt/reverie-worker-client/bin/reverie',
    'worker-client',
    'plan-status',
    '--expected-digest',
    row.workerImage.clientManifestDigest,
    '--projection-digest',
    row.planReplacement.account.projectionDigest,
    '--operation',
    row.request.operationId,
    '--container-id',
    row.destination!.containerId,
    '--read-mode',
    'live',
    '--home-dev',
    home.dev,
    '--home-ino',
    home.ino,
  ];
}
/** Every accepted command is a complete fixed read argv, never a verb prefix. */
export function planOfficeVerifierReadAllowed(args: readonly string[], reads: readonly (readonly string[])[]) {
  return reads.some((read) => isDeepStrictEqual(args, read));
}
export async function verifyPlanOfficeMovedProvider(
  before: PlanOfficeBeforeMove,
  record: Json,
  ports: PlanOfficePhysicalPorts
) {
  const scenario = PlanOfficeMoveScenario.parse(before.scenario),
    old = DockerEmployeeContinuationRecord.parse(before.sourceRow),
    source = DockerEmployeeInspect.parse(before.sourceInspect);
  hash.parse(before.boxId);
  hash.parse(before.clientManifestDigest);
  hash.parse(before.canonicalAuthDigest);
  image.parse(before.workerImageId);
  uuid.parse(before.nativeThreadId);
  assert.match(before.namespace, /^reverie-ci-plan-office-[a-f0-9]{32}$/);
  assert.ok(path.isAbsolute(before.fixtureRoot));
  assert.equal(path.basename(before.fixtureRoot), 'office-' + before.namespace.slice('reverie-ci-plan-office-'.length));
  assert.equal(record.id, scenario.id);
  assert.equal(record.employeeId, scenario.employeeId);
  assert.equal(record.phase, 'completed');
  const newSession = uuid.parse(record.newSession);
  assert.notEqual(newSession, scenario.sessionId);
  assert.equal(old.phase, 'ready');
  assert.equal(old.employeeId, scenario.employeeId);
  assert.equal(old.request.sessionId, scenario.sessionId);
  assert.equal(old.request.sessionGeneration, scenario.sessionGeneration);
  assert.deepEqual(boxedOriginal(source, subject(old), before.namespace, true), old.destination);
  assert.equal(source.Id, old.destination!.containerId);
  assert.equal(before.home.source, path.join(before.fixtureRoot, 'workers', scenario.employeeId, 'home'));
  assert.equal(old.original.home.source, before.home.source);
  assert.equal(source.Config.User, before.home.user);
  assert.equal(source.State.Running, true);
  assert.ok(Number.isSafeInteger(source.State.Pid) && Number(source.State.Pid) > 0);
  assert.ok(typeof source.State.StartedAt === 'string' && source.State.StartedAt.length > 0);
  const root = directory(before.home.source);
  let result: unknown;
  try {
    assert.equal(root.dev, before.home.dev);
    assert.equal(root.ino, before.home.ino);
    assert.equal(before.home.user, process.getuid!() + ':' + process.getgid!());
    const currentSnapshot = ports.snapshot(),
      row = DockerEmployeeContinuationRecord.parse(currentSnapshot.row);
    assert.equal(row.version, 3);
    if (row.version !== 3) throw Error('Published plan replacement required');
    assert.equal(row.phase, 'ready');
    assert.equal(row.employeeId, scenario.employeeId);
    assert.equal(row.request.sessionId, newSession);
    assert.equal(row.request.sessionGeneration, scenario.sessionGeneration + 1);
    assert.equal(row.planReplacement.moveId, scenario.id);
    assert.deepEqual(row.planReplacement.source.binding, bound(old));
    assert.equal(row.planReplacement.account.id, scenario.toAccount);
    assert.equal(row.planReplacement.account.provider, 'anthropic');
    assert.equal(row.workerImage.imageId, before.workerImageId);
    assert.equal(row.workerImage.clientManifestDigest, before.clientManifestDigest);
    assert.deepEqual(row.original, old.destination);
    assert.deepEqual(row.original.home, old.original.home);
    const rowDigest = dockerContinuationDigest(row),
      employeeDigest = dockerContinuationDigest(currentSnapshot.employee);
    const current = () => {
      ports.current();
      const actual = ports.snapshot();
      assert.equal(dockerContinuationDigest(actual.row), rowDigest);
      assert.equal(dockerContinuationDigest(actual.employee), employeeDigest);
      assert.equal(planOfficeCanonicalAuthDigest(before.fixtureRoot, scenario.toAccount), before.canonicalAuthDigest);
      const st = fs.fstatSync(root.fd),
        named = fs.lstatSync(before.home.source);
      for (const s of [st, named]) {
        assert.equal(String(s.dev), root.dev);
        assert.equal(String(s.ino), root.ino);
        assert.equal(s.uid, process.getuid!());
        assert.equal(s.gid, process.getgid!());
        assert.equal(s.mode & 0o777, 0o700);
        assert.ok(s.isDirectory());
      }
      assert.ok(!named.isSymbolicLink());
    };
    current();
    assert.equal(currentSnapshot.employee.sessionId, newSession);
    assert.equal(currentSnapshot.employee.sessionGeneration, row.request.sessionGeneration);
    assert.deepEqual(currentSnapshot.employee.dockerBinding, bound(row));
    const helper = row.tasks?.find((task) => task.role === 'identity-helper');
    assert.ok(helper && helper.phase === 'completed');
    if (!helper || helper.phase !== 'completed') throw Error('Original installer completion required');
    const reads: string[][] = [
      ['container', 'inspect', source.Id],
      ['container', 'inspect', row.destination!.containerId],
      ['container', 'inspect', helper.containerId],
      ['image', 'inspect', before.workerImageId],
      ['logs', helper.containerId],
      nodeRead(row),
      liveRead(row, before.home),
    ];
    const metadata = async (args: readonly string[]) => {
      current();
      assert.ok(planOfficeVerifierReadAllowed(args, reads), 'Read-only fixture command refused');
      const text = await ports.metadata(args);
      assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
      current();
      return text;
    };
    const inspect = async (id: string) =>
      z
        .array(DockerEmployeeInspect)
        .length(1)
        .parse(JSON.parse(await metadata(['container', 'inspect', id])))[0]!;
    const closed = await inspect(source.Id);
    assert.equal(closed.Id, source.Id);
    assert.deepEqual(boxedOriginal(closed, subject(old), before.namespace, true), old.destination);
    assert.deepEqual(closed.Config, source.Config);
    assert.deepEqual(closed.HostConfig, source.HostConfig);
    assert.equal(closed.State.Status, 'exited');
    assert.equal(closed.State.Running, false);
    assert.equal(closed.State.Pid, 0);
    assert.equal(closed.State.Restarting, false);
    assert.equal(closed.State.Dead, false);
    assert.equal(closed.State.Paused, false);
    assert.equal(closed.State.StartedAt, source.State.StartedAt);
    const restart = z.object({ Name: z.literal('no'), MaximumRetryCount: z.literal(0) }).strict();
    restart.parse(closed.HostConfig.RestartPolicy);
    const target = await inspect(row.destination!.containerId);
    assert.equal(target.Image, before.workerImageId);
    assert.equal(target.State.Running, true);
    assert.equal(target.Config.User, before.home.user);
    assert.deepEqual(boxedOriginal(target, subject(row), before.namespace, true), row.destination);
    assert.equal(target.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(target.HostConfig.CapDrop, ['ALL']);
    assert.equal(target.HostConfig.PidMode, '');
    restart.parse(target.HostConfig.RestartPolicy);
    const installer = new DockerPlanInstaller(
      {
        run: metadata,
        create: async () => {
          throw Error('Fixture verifier cannot CREATE');
        },
      },
      {
        read: () => helper,
        publish: async () => {
          throw Error('Fixture verifier cannot publish');
        },
      },
      async () => {
        current();
        return before.home;
      },
      before.boxId
    );
    const installation = await installer.observe(row, current);
    current();
    assert.equal(installation.initial.installedAuthDigest, before.canonicalAuthDigest);
    assert.equal(
      installation.live.observedAuthDigest,
      before.canonicalAuthDigest,
      'Changed canonical authentication is held; no principal inference'
    );
    const nativeBefore = pane.parse(JSON.parse(await metadata(nodeRead(row))));
    const capture = [
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
      nativeBefore.paneId,
    ];
    reads.push(capture);
    const output = await metadata(capture);
    assert.ok(output.trimEnd().endsWith('❯'), 'Target empty composer unconfirmed');
    const session = await planOfficeSession(await ports.ownerGet('/api/sessions/' + newSession), newSession);
    current();
    assert.equal(session.providerInputHeld, false);
    assert.equal(session.isWorking, false);
    assert.equal(session.status, 'idle');
    assert.equal(session.claudeSessionId, before.nativeThreadId);
    const resourcesResponse = await ports.ownerGet(
      '/api/company/employees/' + scenario.employeeId + '/docker-resources'
    );
    current();
    assert.equal(resourcesResponse.status, 200);
    const resources = z
      .object({
        success: z.literal(true),
        data: z
          .object({
            employeeId: z.literal(scenario.employeeId),
            sessionId: z.literal(newSession),
            sessionGeneration: z.literal(row.request.sessionGeneration),
            operationId: z.literal(row.request.operationId),
            containerId: z.literal(row.destination!.containerId),
            enforcement: z.literal('fresh-native-readback'),
            actualMemoryHighBytes: z.literal(row.policy.memoryHighBytes),
            memoryMaxBytes: z.literal(row.policy.memoryMaxBytes),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(await resourcesResponse.json());
    current();
    const names = fs
      .readdirSync(path.join(before.home.source, '.fixture'))
      .filter((name) => name.startsWith('plan-turn-' + newSession + '-'));
    assert.ok(names.length > 0 && names.length <= 128);
    const reports = names
      .map(
        (name) =>
          JSON.parse(
            privateBytes(path.join(before.home.source, '.fixture', name), 65536).toString()
          ) as PlanProviderFixtureReport
      )
      .filter(
        (report) =>
          report.purpose === 'synthetic-plan-provider-turn-v1' &&
          report.employeeId === scenario.employeeId &&
          report.sessionId === newSession &&
          report.providerThread === before.nativeThreadId &&
          report.namespacePid === nativeBefore.panePid &&
          report.hookGenerationSha256 === createHash('sha256').update(nativeBefore.hooks.generation).digest('hex')
      );
    const probe = (report: PlanProviderFixtureReport, args: string) =>
      Array.isArray(report.probes) &&
      report.probes.some((p) => Array.isArray(p.args) && p.args.join(' ') === args && p.exitCode === 0);
    assert.ok(
      reports.some(
        (report) =>
          probe(report, 'agent capabilities --json') &&
          probe(report, 'worker-callback hook-event --event stop') &&
          output.includes(planFixtureTurnBarrier(report))
      ),
      'Target startup consuming-close/capsule proof unconfirmed'
    );
    const handoff = reports.find(
      (report) =>
        report.state === 'idle' &&
        report.accountId === scenario.toAccount &&
        probe(report, 'plans --json') &&
        probe(report, 'worker-callback hook-event --event prompt_submitted') &&
        probe(report, 'worker-callback hook-event --event stop') &&
        output.includes(planFixtureTurnBarrier(report))
    );
    assert.ok(handoff, 'Target handoff turn consuming-close/real callback proof unconfirmed');
    const nativeAfter = pane.parse(JSON.parse(await metadata(nodeRead(row))));
    assert.deepEqual(nativeAfter, nativeBefore);
    const final = await inspect(row.destination!.containerId);
    assert.deepEqual(boxedOriginal(final, subject(row), before.namespace, true), row.destination);
    current();
    const finalSource = await inspect(source.Id);
    assert.deepEqual(finalSource.State, closed.State);
    assert.deepEqual(boxedOriginal(finalSource, subject(old), before.namespace, true), old.destination);
    current();
    result = {
      sourceId: source.Id,
      sourceStopped: true,
      targetId: row.destination!.containerId,
      sessionId: newSession,
      sessionGeneration: row.request.sessionGeneration,
      operationId: row.request.operationId,
      nativeThreadId: before.nativeThreadId,
      pane: nativeAfter,
      canonicalAuthDigest: before.canonicalAuthDigest,
      installerInitial: installation.initial,
      installerLive: installation.live,
      resources: resources.data,
      handoffTurnId: handoff.turnId,
      actualCallbacksAndConsumingCloses: true,
      limitation:
        'Synthetic external provider; unchanged canonical auth only, no refreshed-principal/paid vendor proof.',
    };
  } finally {
    fs.closeSync(root.fd);
  }
  ports.record('physical-move-' + scenario.id, result);
}

/** Actual native source observation and joined terminal barrier; this grants no product authority. */
export async function verifyPlanOfficeReadyNative(
  rowValue: unknown,
  nativeThreadId: string,
  report: PlanProviderFixtureReport,
  ports: Pick<PlanOfficePhysicalPorts, 'current' | 'metadata'>
) {
  const row = DockerEmployeeContinuationRecord.parse(rowValue);
  uuid.parse(nativeThreadId);
  assert.equal(row.phase, 'ready');
  assert.ok(row.destination);
  ports.current();
  const before = pane.parse(JSON.parse(await ports.metadata(nodeRead(row))));
  ports.current();
  const output = await ports.metadata([
    'exec',
    ...DOCKER_PROVIDER_VIEW_ENV,
    row.destination.containerId,
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
    before.paneId,
  ]);
  ports.current();
  const after = pane.parse(JSON.parse(await ports.metadata(nodeRead(row))));
  ports.current();
  assert.deepEqual(after, before, 'Actual provider incarnation changed');
  assert.equal(report.employeeId, row.employeeId);
  assert.equal(report.sessionId, row.request.sessionId);
  assert.equal(report.providerThread, nativeThreadId);
  assert.equal(report.namespacePid, before.panePid);
  assert.equal(report.hookGenerationSha256, createHash('sha256').update(before.hooks.generation).digest('hex'));
  assert.equal(report.state, 'idle');
  assert.equal(report.requestId, null);
  for (const args of [
    ['agent', 'capabilities', '--json'],
    ['worker-callback', 'hook-event', '--event', 'stop'],
  ])
    assert.ok(report.probes.some((p) => p.exitCode === 0 && isDeepStrictEqual(p.args, args)));
  assert.ok(output.includes(planFixtureTurnBarrier(report)), 'Original checked-close turn barrier absent');
  assert.ok(output.trimEnd().endsWith('❯'), 'Original empty native composer absent');
  return { native: before, outputSha256: createHash('sha256').update(output).digest('hex') };
}
