/** Mandatory hosted acceptance. All model executables and credentials are synthetic;
 * the ordinary owner API, HMAC client, Docker lifecycle and native verifier are real.
 * --ci keeps the ordinary-self gate; --ci --scenario self-roundtrip is an explicit extension. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;
const imageId = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type PlanOfficeCiSelection = 'ordinary-self' | 'self-roundtrip';
function requireSelection(value: string): asserts value is PlanOfficeCiSelection {
  assert.ok(value === 'ordinary-self' || value === 'self-roundtrip');
}
function object(value: unknown): Json {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Json;
}
export function requireHostedPlanOffice(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  arch = process.arch
) {
  const selection = args.length === 1 ? 'ordinary-self' : args[2];
  assert.ok(selection);
  requireSelection(selection);
  assert.deepEqual(args, args.length === 1 ? ['--ci'] : ['--ci', '--scenario', selection]);
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.REVERIE_CI_RUNNER_ENVIRONMENT, 'github-hosted', 'Never use a self-hosted employee Engine');
  assert.equal(platform, 'linux');
  assert.equal(arch, 'x64');
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP));
  return selection;
}
export function planOfficeCiNamespace(instance: string) {
  assert.match(instance, /^[a-f0-9]{32}$/);
  return 'reverie-ci-plan-office-' + instance;
}
export function planOfficeCiImage(value: unknown, namespace: string, role: string) {
  assert.match(namespace, /^reverie-ci-plan-office-[a-f0-9]{32}$/);
  assert.ok(['source', 'worker', 'helper', 'control'].includes(role));
  const image = object(value);
  assert.match(String(image.Id), imageId);
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, 'amd64');
  assert.ok(Array.isArray(image.RepoTags));
  assert.ok(image.RepoTags.includes(namespace + '-' + role + ':latest'));
  assert.ok(image.RepoTags.every((tag: unknown) => typeof tag === 'string' && tag.startsWith(namespace + '-')));
  return image.Id as string;
}
export function planOfficeCiContract(
  metadata: unknown,
  instance: string,
  ids: Record<string, string>,
  selection: PlanOfficeCiSelection = 'ordinary-self'
) {
  requireSelection(selection);
  const m = object(metadata);
  assert.equal(m.version, 1);
  assert.equal(m.purpose, 'reverie-ci-plan-office-inputs-v1');
  assert.equal(m.imageNamespace, planOfficeCiNamespace(instance));
  for (const key of ['sourcePath', 'runtimePath', 'platformClosure'])
    assert.match(String(m[key]), /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/);
  assert.match(String(m.clientManifestDigest), /^[a-f0-9]{64}$/);
  for (const role of ['source', 'worker', 'helper', 'control']) assert.match(ids[role] ?? '', imageId);
  const employeeId = randomUUID(),
    sessionId = randomUUID(),
    nativeThreadId = randomUUID();
  return {
    version: 1,
    purpose: 'reverie-ci-plan-office-baseline-v1',
    acceptance: selection,
    instance,
    sourcePath: m.sourcePath,
    runtimePath: m.runtimePath,
    platformClosure: m.platformClosure,
    sourceImageId: ids.source,
    workerImageId: ids.worker,
    helperImageId: ids.helper,
    controlImageId: ids.control,
    clientManifestDigest: m.clientManifestDigest,
    bootstrap: {
      version: 1,
      purpose: 'reverie-ci-plan-office-bootstrap-v1',
      employees: [
        {
          employeeId,
          sessionId,
          nativeThreadId,
          name: 'CI Ordinary Self',
          account: 'ci-plan-a',
          permissions: { moveOwnPlan: true, managePlans: false },
        },
      ],
    },
    sourceProviders: [{ employeeId, mode: 'ordinary' }],
    sourceLayouts: [{ employeeId, layout: 'operator-recovery', missingEphemeral: true }],
  };
}
/** Baseline readiness or an HTTP acknowledgement can never satisfy this gate. */
export function requirePlanOfficeCiAcceptance(
  result: unknown,
  receipt: unknown,
  root: string,
  employeeId: string,
  selection: PlanOfficeCiSelection = 'ordinary-self',
  roundtrip?: { returned: unknown; summary: unknown }
) {
  requireSelection(selection);
  const r = object(result),
    proof = object(receipt);
  assert.equal(r.status, 0);
  assert.equal(r.baselineReady, true);
  assert.equal(r.planMovesAccepted, true);
  assert.equal(r.acceptedScenario, selection);
  assert.equal(r.evidence, root);
  assert.equal(r.forceAccepted, false);
  assert.equal(r.refreshReuseAccepted, false);
  assert.match(String(proof.id), uuid);
  assert.equal(proof.employeeId, employeeId);
  assert.equal(proof.fromAccount, 'ci-plan-a');
  assert.equal(proof.toAccount, 'ci-plan-b');
  assert.equal(proof.realCapsuleHmac, true);
  assert.equal(proof.originalOnly, true);
  const acceptance = {
    scenarioId: proof.id,
    employeeId,
    ordinarySelfAccepted: true,
    forceAccepted: false,
    teamAccepted: false,
    permissionMatrixAccepted: false,
    officeReentryAccepted: false,
  };
  if (selection === 'ordinary-self') {
    assert.notEqual(r.selfRoundtripAccepted, true);
    assert.equal(roundtrip, undefined);
    return { ...acceptance, selfRoundtripAccepted: false };
  }
  assert.equal(r.selfRoundtripAccepted, true);
  assert.ok(roundtrip);
  const returned = object(roundtrip.returned),
    summary = object(roundtrip.summary);
  assert.match(String(returned.id), uuid);
  assert.notEqual(returned.id, proof.id);
  assert.equal(returned.employeeId, employeeId);
  assert.equal(returned.fromAccount, 'ci-plan-b');
  assert.equal(returned.toAccount, 'ci-plan-a');
  assert.equal(returned.realCapsuleHmac, true);
  assert.equal(returned.originalOnly, true);
  for (const value of [proof.sessionId, proof.newSession, returned.sessionId, returned.newSession])
    assert.match(String(value), uuid);
  assert.ok(Number.isSafeInteger(proof.sessionGeneration) && Number(proof.sessionGeneration) > 0);
  assert.equal(returned.sessionId, proof.newSession);
  assert.equal(returned.sessionGeneration, Number(proof.sessionGeneration) + 1);
  assert.notEqual(returned.newSession, proof.sessionId);
  assert.notEqual(returned.newSession, returned.sessionId);
  assert.equal(summary.employeeId, employeeId);
  assert.equal(summary.firstMoveId, proof.id);
  assert.equal(summary.returnMoveId, returned.id);
  assert.equal(summary.firstNewSession, proof.newSession);
  assert.equal(summary.returnNewSession, returned.newSession);
  assert.deepEqual(summary.accounts, ['ci-plan-a', 'ci-plan-b', 'ci-plan-a']);
  assert.equal(summary.firstReceipt, 'first-self-move-completed');
  assert.equal(summary.returnReceipt, 'self-move-' + returned.id + '-completed');
  return { ...acceptance, selfRoundtripAccepted: true, returnScenarioId: returned.id };
}
function save(file: string, value: unknown) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export async function runPlanOfficeCi(args: readonly string[], env = process.env) {
  const selection = requireHostedPlanOffice(args, env);
  assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
  const source = fileURLToPath(new URL('../../..', import.meta.url));
  const instance = randomBytes(16).toString('hex'),
    namespace = planOfficeCiNamespace(instance);
  const evidence = path.join(env.RUNNER_TEMP!, namespace);
  fs.mkdirSync(evidence, { mode: 0o700 });
  const dockerConfig = path.join(evidence, 'docker-config');
  fs.mkdirSync(dockerConfig, { mode: 0o700 });
  const published = path.join(source, 'acceptance', 'plan-office');
  fs.mkdirSync(path.dirname(published), { recursive: true });
  assert.equal(fs.realpathSync(path.dirname(published)), path.dirname(published));
  fs.mkdirSync(published, { mode: 0o700 });
  let serial = 0,
    lastStage = 'admission';
  const run = (label: string, program: string, argv: string[], timeout = 120000) => {
    lastStage = label;
    console.log('Plan office: ' + label);
    const key = String(++serial).padStart(3, '0') + '-' + label;
    save(path.join(evidence, key + '-intent.json'), { program, argv });
    const result = spawnSync(program, argv, {
      cwd: source,
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...env, DOCKER_CONFIG: dockerConfig, DOCKER_HOST: 'unix:///var/run/docker.sock' },
    });
    // Raw replies can contain synthetic passwords/tokens. They stay outside artifacts and console logs.
    save(path.join(evidence, key + '-result.json'), {
      status: result.status,
      signal: result.signal,
      errorName: result.error?.name,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.equal(result.error, undefined, label + ' outcome unconfirmed');
    assert.equal(result.signal, null, label + ' interrupted');
    assert.equal(result.status, 0, label + ' failed; private raw replies are not published');
    return result.stdout;
  };
  const docker = (label: string, argv: string[]) =>
    run(label, 'docker', ['--host', 'unix:///var/run/docker.sock', ...argv]);
  const build = (label: string, expression: string, output: string) =>
    run(
      label,
      'nix',
      [
        'build',
        '--expr',
        expression,
        '--no-write-lock-file',
        '--max-jobs',
        '1',
        '--cores',
        '2',
        '--out-link',
        output,
        '-L',
      ],
      2700000
    );
  try {
    const head = run('head', 'git', ['rev-parse', 'HEAD']).trim();
    run('tracked-entry', 'git', [
      'ls-files',
      '--error-unmatch',
      'apps/web/scripts/plan-office-ci.mts',
      'nix/ci-plan-office-inputs.nix',
    ]);
    assert.equal(run('clean', 'git', ['status', '--porcelain', '--untracked-files=no']), '');
    const archived = object(
      JSON.parse(run('archive-source', 'nix', ['flake', 'archive', '--json', '--no-write-lock-file', source]))
    );
    assert.match(String(archived.path), /^\/nix\/store\/[a-z0-9]{32}-source$/);
    const locked = object(
      JSON.parse(
        run('lock-source', 'nix', ['flake', 'metadata', '--json', '--no-write-lock-file', String(archived.path)])
      )
    );
    const lockedValue = object(locked.locked);
    assert.equal(lockedValue.type, 'path');
    assert.equal(lockedValue.path, archived.path);
    assert.match(String(lockedValue.narHash), /^sha256-[A-Za-z0-9+/]+=*$/);
    assert.ok(String(locked.url).startsWith('path:' + archived.path + '?'));
    const expression = `let source = builtins.getFlake ${JSON.stringify(locked.url)}; pkgs = import source.inputs.nixpkgs { system = "x86_64-linux"; }; src = import (source.outPath + "/nix/source-filter.nix") { lib = pkgs.lib; src = source.outPath; }; in import (source.outPath + "/nix/ci-plan-office-inputs.nix") { inherit pkgs src; dependencyConsole = source.packages.x86_64-linux.console; imageNamespace = ${JSON.stringify(namespace)}; }`;
    const stage = path.join(evidence, 'inputs');
    build('build-fixture-inputs', '(' + expression + ').stage', stage);
    const metadata = object(JSON.parse(fs.readFileSync(path.join(stage, 'metadata.json'), 'utf8')));
    const ids: Record<string, string> = {};
    const load = (role: string, archive: string) => {
      const tag = namespace + '-' + role + ':latest';
      assert.equal(docker('tag-absent-' + role, ['image', 'ls', '--quiet', '--filter', 'reference=' + tag]).trim(), '');
      const file = fs.realpathSync(archive),
        stat = fs.statSync(file);
      assert.ok(file.startsWith('/nix/store/') && stat.isFile() && stat.uid === 0 && (stat.mode & 0o222) === 0);
      // Full archived size, including already-known layers, can consume daemon staging/chain storage.
      const free = fs.statfsSync(evidence);
      assert.ok(
        free.bavail * free.bsize > 3 * 1024 ** 3 + 5 * stat.size,
        'Insufficient disposable runner disk reserve'
      );
      docker('load-' + role, ['image', 'load', '--input', file]);
      const rows: unknown[] = JSON.parse(docker('inspect-' + role, ['image', 'inspect', tag]));
      assert.equal(rows.length, 1);
      ids[role] = planOfficeCiImage(rows[0], namespace, role);
    };
    for (const role of ['source', 'worker', 'helper']) load(role, path.join(stage, role + '.tar.gz'));
    const control = path.join(evidence, 'control-image');
    build(
      'build-control',
      '(' +
        expression +
        ').mkControl ' +
        `{ workerImageId = ${JSON.stringify(ids.worker)}; sourceImageIds = [${JSON.stringify(ids.source)}]; helperImageId = ${JSON.stringify(ids.helper)}; }`,
      control
    );
    load('control', control);
    const contract = planOfficeCiContract(metadata, instance, ids, selection);
    const file = path.join(evidence, 'contract.json');
    save(file, contract);
    assert.equal(run('head-current', 'git', ['rev-parse', 'HEAD']).trim(), head);
    assert.equal(run('clean-current', 'git', ['status', '--porcelain', '--untracked-files=no']), '');
    const runtime = String(metadata.runtimePath);
    const runtimeMetadata = object(JSON.parse(fs.readFileSync(path.join(runtime, 'metadata.json'), 'utf8')));
    const stdout = run(
      'actual-' + selection,
      String(runtimeMetadata.nodeExecutable),
      [path.join(runtime, 'lib/reverie/test/fixtures/plan-office-canary.mjs'), '--contract', file],
      600000
    );
    const root = path.join(evidence, 'office-' + instance);
    const proof = JSON.parse(fs.readFileSync(path.join(root, 'first-self-move-completed.json'), 'utf8'));
    let roundtrip: { returned: unknown; summary: unknown } | undefined;
    if (selection === 'self-roundtrip') {
      const summary = object(JSON.parse(fs.readFileSync(path.join(root, 'self-roundtrip-completed.json'), 'utf8')));
      assert.match(String(summary.returnMoveId), uuid);
      roundtrip = {
        summary,
        returned: JSON.parse(
          fs.readFileSync(path.join(root, 'self-move-' + summary.returnMoveId + '-completed.json'), 'utf8')
        ),
      };
    }
    const acceptance = requirePlanOfficeCiAcceptance(
      JSON.parse(stdout),
      proof,
      root,
      contract.bootstrap.employees[0]!.employeeId,
      selection,
      roundtrip
    );
    save(path.join(published, 'result.json'), {
      status: 0,
      head,
      namespace,
      ...acceptance,
      recoveryMatrixAccepted: false,
    });
  } catch {
    // Publish a closed diagnostic only. Do not serialize exceptions, raw replies, owner cookies or fixture homes.
    save(path.join(published, 'failure.json'), {
      status: 1,
      namespace,
      failedStage: lastStage,
      ordinarySelfAccepted: false,
      selfRoundtripAccepted: false,
      selectedScenario: selection,
    });
    throw Error('Actual ordinary self plan acceptance failed at ' + lastStage);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  await runPlanOfficeCi(process.argv.slice(2));
