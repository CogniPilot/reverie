/** Pure build construction/locked dependency checks. Never builds or calls Docker. */
import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildSync, transformSync } from 'esbuild';
import { readPlanOfficeStartupDiagnostic } from './helpers/plan-office-startup-diagnostic.js';
import {
  planOfficeAssetSources,
  requirePlanOfficeDependencyLock,
  requirePlanOfficeViewerExecutables,
  buildPlanOffice,
  PLAN_OFFICE_TEST_ENTRIES,
} from '../scripts/build-plan-office.mjs';
const repositorySource = path.resolve('../..');
const owningSource = fs.existsSync(path.join(repositorySource, 'nix/ci-plan-office-images.nix'))
  ? repositorySource
  : path.resolve('build-fixtures/plan-office-source');
const factory = path.join(owningSource, 'nix/ci-plan-office-images.nix');
// Real metadata-only files. No fake executable or native qualification is minted.
const clientFixture = path.join(owningSource, 'tests/fixtures/boxed_client_capsule');
const fixtureManifestDigest = createHash('sha256')
  .update(fs.readFileSync(path.join(clientFixture, 'opt/reverie-worker-client/manifest.json')))
  .digest('hex');
const good = 'sha256:' + 'a'.repeat(64),
  ns = 'reverie-ci-plan-office-' + 'b'.repeat(32);
it('keeps the bundled fake SDK graph free of website Session and native PTY implementation', () => {
  const graph = buildSync({
    entryPoints: ['test/fixtures/boxed-plan-provider.mts'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  expect(Object.keys(graph.metafile!.inputs).filter((file) => /(?:^|\/)node-pty\//.test(file))).toEqual([]);
  expect(Object.keys(graph.metafile!.inputs)).not.toContain('src/session.ts');
});
it('runs the actual bundled fake SDK version through its entry and symlink without native addons', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sdk-bundle-'));
  try {
    const entry = path.join(root, 'claude.mjs'),
      alias = path.join(root, 'claude-alias.mjs');
    buildSync({
      entryPoints: ['test/fixtures/boxed-plan-provider.mts'],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: {
        js: "import {createRequire as __ciRequire} from 'node:module';const require=__ciRequire(import.meta.url);",
      },
      logLevel: 'silent',
    });
    fs.symlinkSync(entry, alias);
    for (const program of [entry, alias]) {
      const reply = spawnSync(process.execPath, ['--no-addons', program, '--version'], {
        cwd: root,
        env: { HOME: root, TMPDIR: root, PATH: path.dirname(process.execPath), LANG: 'C.UTF-8' },
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 65536,
      });
      expect(reply.error).toBeUndefined();
      expect(reply.signal).toBeNull();
      expect(reply.stderr).toBe('');
      expect(reply.status).toBe(0);
      expect(reply.stdout).toBe('2.1.251 (Claude Code; synthetic plan fixture)\n');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('closes viewer executable metadata over the packaged wrapper and actual leaf ABI', () => {
  const prefix = '/nix/store/' + 'a'.repeat(32) + '-';
  const manifest = {
    version: 1,
    purpose: 'reverie-docker-viewer-executables-v1',
    executables: {
      '/bin/docker': {
        entry: prefix + 'docker-29.6.1/bin/docker',
        executable: prefix + 'docker-29.6.1/libexec/docker/docker',
        argv0: prefix + 'docker-29.6.1/libexec/docker/docker',
      },
      '/bin/bash': { entry: prefix + 'bash/bin/bash', executable: prefix + 'bash/bin/bash', argv0: '/bin/bash' },
      '/bin/tmux': { entry: prefix + 'tmux/bin/tmux', executable: prefix + 'tmux/bin/tmux', argv0: '/bin/tmux' },
    },
  };
  expect(() => requirePlanOfficeViewerExecutables(manifest, manifest.executables['/bin/docker'].entry)).not.toThrow();
  expect(() => requirePlanOfficeViewerExecutables(manifest, prefix + 'another/bin/docker')).toThrow();
  for (const mutate of [
    (m: typeof manifest) => {
      m.version = 2;
    },
    (m: typeof manifest) => {
      m.purpose = 'instance-selected';
    },
    (m: typeof manifest) => {
      Object.assign(m, { extra: true });
    },
    (m: typeof manifest) => {
      Object.assign(m.executables, { '/bin/other': m.executables['/bin/docker'] });
    },
    (m: typeof manifest) => {
      Object.assign(m.executables['/bin/docker'], { extra: true });
    },
    (m: typeof manifest) => {
      m.executables['/bin/docker'].argv0 = '/bin/docker';
    },
    (m: typeof manifest) => {
      m.executables['/bin/docker'].executable = prefix + 'foreign/libexec/docker/docker';
    },
    (m: typeof manifest) => {
      m.executables['/bin/docker'].entry = '/usr/bin/docker';
    },
    (m: typeof manifest) => {
      m.executables['/bin/bash'].argv0 = prefix + 'bash/bin/bash';
    },
    (m: typeof manifest) => {
      m.executables['/bin/tmux'].executable = prefix + 'foreign/bin/tmux';
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    expect(() => requirePlanOfficeViewerExecutables(changed)).toThrow();
  }
  for (const malformed of [null, [], {}, { ...manifest, executables: null }])
    expect(() => requirePlanOfficeViewerExecutables(malformed)).toThrow();
});

it('wires the one immutable viewer executable producer into console and current-source CI output', () => {
  const producer = fs.readFileSync(path.join(owningSource, 'nix/docker-viewer-executables.nix'), 'utf8');
  expect(producer).toContain('executable = "${pkgs.docker-client}/libexec/docker/docker";');
  expect(producer).toContain('argv0 = "${pkgs.docker-client}/libexec/docker/docker";');
  const consolePath = fs.existsSync(path.join(repositorySource, 'nix/package.nix'))
    ? path.join(repositorySource, 'nix/package.nix')
    : path.resolve('test/fixtures/nix-package/package.nix');
  const consoleSource = fs.readFileSync(consolePath, 'utf8');
  const ciSource = fs.readFileSync(factory, 'utf8');
  for (const source of [consoleSource, ciSource])
    expect(source).toContain('import ./docker-viewer-executables.nix { inherit pkgs; }');
  expect(consoleSource).toContain('"$out/lib/reverie/dist/docker-viewer-executables.json"');
  expect(ciSource).toContain('--viewer-executables ${dockerViewerExecutables}');
  expect(ciSource).toContain('--docker ${pkgs.docker-client}/bin/docker');
});

it('refuses a mismatched executable ABI before the actual current-source builder creates output', () => {
  const prefix = '/nix/store/' + 'a'.repeat(32) + '-build-input',
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-executable-input-')),
    output = path.join(root, 'output');
  const inputs = ['source', 'modules', 'esbuild', 'node', 'docker', 'viewer-executables'];
  const realpath = fs.realpathSync,
    stat = fs.statSync,
    read = fs.readFileSync;
  const malformed = {
    version: 1,
    purpose: 'reverie-docker-viewer-executables-v1',
    executables: Object.fromEntries(
      ['docker', 'bash', 'tmux'].map((name) => [
        '/bin/' + name,
        {
          entry: prefix + '/bin/' + name,
          executable: prefix + '/bin/' + name,
          argv0: '/bin/' + name,
        },
      ])
    ),
  };
  const flags = inputs.flatMap((name) => ['--' + name, '/selected/' + name]).concat(['--output', output]);
  try {
    vi.spyOn(fs, 'realpathSync').mockImplementation(((file: fs.PathLike) => {
      const text = String(file);
      return inputs.some((name) => text === '/selected/' + name) ? prefix + '/' + path.basename(text) : realpath(file);
    }) as typeof fs.realpathSync);
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const name = String(file).slice(prefix.length + 1);
      return String(file).startsWith(prefix + '/') && inputs.includes(name)
        ? {
            size: 4096,
            isDirectory: () => ['source', 'modules'].includes(name),
            isFile: () => !['source', 'modules'].includes(name),
          }
        : stat(file, options as never);
    }) as typeof fs.statSync);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) =>
      file === prefix + '/viewer-executables'
        ? JSON.stringify(malformed)
        : read(file, options as never)) as typeof fs.readFileSync);
    expect(() => buildPlanOffice(flags)).toThrow('Fixed viewer executable ABI required');
    expect(fs.existsSync(output)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('imports the actual unbundled canary graph without Driver and closes startup argument/import failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-canary-import-'));
  const web = process.cwd(),
    runtime = path.join(root, 'lib/reverie');
  const instance = 'a'.repeat(32),
    token = 'HOSTILE_AUTH_TOKEN_DO_NOT_PUBLISH';
  try {
    const graph = buildSync({
      entryPoints: [...PLAN_OFFICE_TEST_ENTRIES],
      absWorkingDir: web,
      outdir: path.join(root, 'graph'),
      bundle: true,
      write: false,
      metafile: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.symlinkSync(path.join(web, 'node_modules'), path.join(runtime, 'node_modules'));
    let bytes = 0;
    for (const file of Object.keys(graph.metafile!.inputs)) {
      let output: string;
      if (file.startsWith('src/') && file.endsWith('.ts')) output = 'dist/' + file.slice(4).replace(/\.ts$/, '.js');
      else if ((PLAN_OFFICE_TEST_ENTRIES as readonly string[]).includes(file))
        output = file.replace(/\.[cm]?ts$/, '.js');
      else if (file === 'test/fixtures/boxed-canary-fixture-contract.mjs') output = file;
      else throw Error('Actual driver graph contains an unshipped module');
      const text = fs.readFileSync(path.join(web, file), 'utf8');
      const compiled =
        file.endsWith('.ts') || file.endsWith('.mts')
          ? transformSync(text, { loader: 'ts', format: 'esm', target: 'node22' }).code
          : text;
      bytes += Buffer.byteLength(compiled);
      expect(bytes).toBeLessThan(16 * 1024 * 1024);
      const target = path.join(runtime, output);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, compiled);
    }
    fs.symlinkSync('dist', path.join(runtime, 'src'));
    const entry = path.join(runtime, 'test/fixtures/plan-office-canary.mjs');
    fs.renameSync(entry.replace(/\.mjs$/, '.js'), entry);
    let serial = 0;
    const run = (text: string, extra: string[] = [], correlation = instance, mode = '--check-import') => {
      const parent = path.join(root, 'case-' + serial++);
      fs.mkdirSync(parent, { mode: 0o700 });
      const contract = path.join(parent, 'contract.json');
      fs.writeFileSync(contract, text, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        [entry, '--contract', contract, mode, ...extra, '--diagnostic-instance', correlation],
        {
          cwd: parent,
          env: { HOME: parent, TMPDIR: parent, PATH: path.dirname(process.execPath), LANG: 'C.UTF-8' },
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 65536,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      // Even this minimal contract cannot admit Driver. No office state is created.
      expect(fs.existsSync(path.join(parent, 'office-' + instance))).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(token);
      return { ...result, parent };
    };
    const valid = run(JSON.stringify({ instance }));
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual({
      version: 1,
      purpose: 'reverie-ci-plan-office-import-smoke-v1',
      instance,
      imported: true,
    });
    // The real entry recognizes the dedicated local facade and reaches the
    // owning decoder. A non-fixture contract earns no Driver or Engine access.
    const force = run(JSON.stringify({ instance }), [], instance, '--ready-owner-force');
    expect(force.status).toBe(1);
    expect(readPlanOfficeStartupDiagnostic(force.stdout, instance)).toMatchObject({
      stage: 'ready-self-admission',
      errorClass: 'ZodError',
    });
    for (const extra of [['--extra'], ['--ready-self'], ['--ready-owner-force'], ['--diagnostic-instance', instance]]) {
      const bad = run(JSON.stringify({ instance }), extra);
      expect(bad.status).toBe(1);
      expect(readPlanOfficeStartupDiagnostic(bad.stdout, instance)?.stage).toBe('entry-arguments');
      expect(fs.readdirSync(bad.parent)).toEqual(['contract.json']);
    }
    const mismatch = run(JSON.stringify({ instance: 'b'.repeat(32) }));
    expect(mismatch.status).toBe(1);
    expect(readPlanOfficeStartupDiagnostic(mismatch.stdout, instance)).toMatchObject({
      stage: 'entry-contract',
      errorClass: 'AssertionError',
      errorCode: 'ERR_ASSERTION',
    });
    expect(fs.readdirSync(mismatch.parent)).toEqual(['contract.json']);
    const malformed = run('{"instance":' + token);
    expect(malformed.status).toBe(1);
    expect(readPlanOfficeStartupDiagnostic(malformed.stdout, instance)).toMatchObject({
      stage: 'entry-contract',
      errorClass: 'SyntaxError',
    });
    const badCorrelation = run(JSON.stringify({ instance }), [], token);
    expect(badCorrelation.status).toBe(1);
    expect(readPlanOfficeStartupDiagnostic(badCorrelation.stdout, instance)).toBeUndefined();
    expect(fs.readdirSync(badCorrelation.parent)).toEqual(['contract.json']);
    const driver = path.join(runtime, 'test/helpers/plan-office-driver.js');
    fs.renameSync(driver, driver + '.held');
    try {
      const missing = run(JSON.stringify({ instance }));
      expect(missing.status).toBe(1);
      expect(readPlanOfficeStartupDiagnostic(missing.stdout, instance)).toMatchObject({
        stage: 'entry-driver-import',
        errorClass: 'Error',
        errorCode: 'ERR_MODULE_NOT_FOUND',
      });
    } finally {
      fs.renameSync(driver + '.held', driver);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function evaluate(
  overrides = '',
  expression = 'builtins.toJSON { metadata=f.metadata; worker=f.workerImage; source=f.sourceImage; helper=f.helperImage; control=f.mkControl {workerImageId="' +
    good +
    '";sourceImageIds=["' +
    good +
    '"];helperImageId="' +
    good +
    '";}; }'
) {
  const code = `let pkgs={lib.optionalAttrs=condition: value: if condition then value else {};runCommand=name: attrs:  script: "/fake/"+name;buildEnv=attrs: "/fake/platform";closureInfo=attrs: "/fake/closure";writeText=name: text: if name == "reverie-helper-image-identity" then "/fake/identity-" + builtins.hashString "sha256" text else "/fake/config";dockerTools.buildLayeredImage=x: x;nodejs_22="/fake/node";esbuild="/fake/esbuild";bashInteractive="/fake/bash";coreutils="/fake/core";findutils="/fake/find";gnugrep="/fake/grep";gnused="/fake/sed";gawk="/fake/awk";util-linux="/fake/util";python3="/fake/python";docker-client="/fake/docker";tmux="/fake/tmux";which="/fake/which";procps="/fake/procps";}; f=import ${JSON.stringify(factory)} ({inherit pkgs;src="/owning/source";dependencyConsole="/deps-only";imageNamespace="${ns}";clientCapsule=${JSON.stringify(clientFixture)};clientManifestDigest="${fixtureManifestDigest}";initCapsule="/init";workerTools="/tools";resourceHelper="/helper";} // {${overrides}}); in ${expression}`;
  const result = spawnSync('nix-instantiate', ['--store', 'dummy://', '--eval', '--strict', '--expr', code], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  expect(result.error, 'nix-instantiate must be present and finish actual evaluation').toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(typeof result.status, result.stderr).toBe('number');
  return result;
}
it('preserves ordinary current-source control and fixed unprivileged worker image contracts in unique CI namespaces', () => {
  const r = evaluate();
  expect(r.status, r.stderr).toBe(0);
  const v = JSON.parse(JSON.parse(r.stdout));
  expect(v.metadata.sourcePath).toBe('/owning/source');
  expect(v.metadata.controlPort).toBe(3000);
  for (const role of ['source', 'worker', 'helper', 'control']) expect(v[role].name).toBe(ns + '-' + role);
  expect(v.worker.config.Entrypoint).toEqual(['/opt/reverie/perf/bin/reverie-worker-init']);
  expect(v.worker.config.Cmd).toEqual([]);
  expect(v.worker.config.Env).toContain('TERMINFO=/opt/reverie-worker-tools/share/terminfo');
  expect(v.worker.fakeRootCommands).toContain('cp /helper/bin/reverie-docker-resources');
  expect(v.control.config.Cmd).toEqual(['web', '--host', '0.0.0.0', '--port', '3000']);
  expect(v.control.fromImage.contents).toEqual(
    expect.arrayContaining([
      '/fake/bash',
      '/fake/core',
      '/fake/util',
      '/fake/tmux',
      '/fake/which',
      '/fake/grep',
      '/fake/sed',
      '/fake/awk',
      '/fake/find',
      '/fake/procps',
    ])
  );
  expect(v.control.fromImage.contents).not.toContain('/fake/platform'); // Its /etc symlink cannot host the protected config.
  expect(v.control.fromImage.config).toEqual(v.control.config);
  expect(v.control.fromImage.fakeRootCommands).not.toContain('reverie-worker-client');
  expect(v.control.extraCommands).toContain(
    `cp -r ${clientFixture}/opt/reverie-worker-client/. opt/reverie-worker-client/`
  );
  expect(v.control.extraCommands).toContain('touch opt/reverie-worker-client/.wh..wh..opq');
  expect(v.control.extraCommands).toContain('chmod -R a-w opt/reverie-worker-client');
  expect(v.control.fakeRootCommands).toContain('chown -R 0:0 opt/reverie-worker-client');
  expect(v.control.passthru.clientManifestDigest).toBe(fixtureManifestDigest);
  expect(v.control.config.Entrypoint).toEqual([
    '/fake/node/bin/node',
    '/fake/reverie-ci-plan-office-runtime/lib/reverie/dist/index.js',
  ]);
  expect(v.control.passthru.runtimeConfiguration).toEqual({
    version: 1,
    purpose: 'reverie-boxed-runtime-v1',
    deployment: ns,
    workerImageId: good,
    sourceImageIds: [good],
    helperImageId: good,
    clientManifestDigest: fixtureManifestDigest,
    apiUrl: 'http://reverie:3000',
  });
  expect(v.control.config.Env).toContain('REVERIE_RUNTIME_BACKEND=boxed-docker-v1');
  expect(v.control.config.Env).toContain('REVERIE_DATA_DIR=/fixture/data');
  expect(v.control.config.Env).toContain('REVERIE_ALLOWED_HOSTS=reverie');
  expect(v.control.config.Env).not.toContainEqual(expect.stringMatching(/BROKER|WORKER_SOCKET/));
});
it.each(['source', 'worker', 'helper', 'control'] as const)(
  'separates %s immutable image inputs across successive office namespaces without weakening its program contract',
  (role) => {
    const next = 'reverie-ci-plan-office-' + 'd'.repeat(32);
    const first = evaluate(),
      second = evaluate(`imageNamespace="${next}";`);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const a = JSON.parse(JSON.parse(first.stdout))[role];
    const b = JSON.parse(JSON.parse(second.stdout))[role];
    if (role === 'helper') {
      // Helper CREATE has an exact runtime configuration. Image labels inherit
      // into containers, so namespace identity belongs in immutable image data.
      expect(a.config).toEqual(b.config);
      expect(a.config.Labels).toEqual({ 'org.reverie.purpose': 'boxed-resource-helper-v1' });
      expect(a.extraCommands).not.toBe(b.extraCommands);
      const eraseIdentity = (script: string) =>
        script.replace(/\/fake\/identity-[a-f0-9]{64}/g, '/fake/fixed-identity');
      expect(eraseIdentity(a.extraCommands)).toBe(eraseIdentity(b.extraCommands));
      expect(a.extraCommands).toContain('share/reverie/helper-image-identity.json');
      expect(a.extraCommands).toContain('chmod 0444 share/reverie/helper-image-identity.json');
      return;
    }
    const label = 'org.reverie.fixture.namespace';
    expect(a.config.Labels[label]).toBe(ns);
    expect(b.config.Labels[label]).toBe(next);
    // RepoTags/name alone do not distinguish the same Docker config identity.
    // Evaluate the actual Nix factory with a dummy store; this is construction
    // evidence, never a fabricated image ID or physical Docker acceptance.
    expect(a.config).not.toEqual(b.config);
    delete a.config.Labels[label];
    delete b.config.Labels[label];
    expect(a.config).toEqual(b.config); // Root, program, arguments and environment stay fixed.
  }
);
it('rejects generic/invalid namespaces and malformed manifest or actual Engine IDs before image construction', () => {
  for (const override of [
    'imageNamespace="reverie-boxed";',
    'imageNamespace="' + ns.toUpperCase() + '";',
    'clientManifestDigest="short";',
  ]) {
    const result = evaluate(override);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/assertion .*failed/s);
  }
  for (const tuple of [
    'workerImageId="latest";sourceImageIds=["' + good + '"];helperImageId="' + good + '";',
    'workerImageId="' + good + '";sourceImageIds=[];helperImageId="' + good + '";',
    'workerImageId="' + good + '";sourceImageIds=["tag:latest"];helperImageId="' + good + '";',
  ]) {
    const result = evaluate('', 'builtins.toJSON (f.mkControl {' + tuple + '})');
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/assertion .*failed/s);
  }
});
it.each(['missing', 'mismatched'] as const)(
  'refuses a %s actual client manifest before constructing a control overlay',
  (kind) => {
    const result = evaluate(
      kind === 'missing'
        ? 'clientCapsule="/no-such-reverie-test-capsule";'
        : 'clientManifestDigest="' + 'c'.repeat(64) + '";'
    );
    expect(result.status, result.stderr).not.toBe(0);
  }
);
it('accepts only dependency versions and integrity from the same current source lock', () => {
  const source = { packages: { 'node_modules/zod': { version: '4.3.6', integrity: 'sha512-fixture' } } };
  expect(() => requirePlanOfficeDependencyLock(source, source)).not.toThrow();
  const workspace = {
    packages: { 'node_modules/xterm-zerolag-input': { link: true, resolved: 'packages/xterm-zerolag-input' } },
  };
  expect(() => requirePlanOfficeDependencyLock(workspace, workspace)).not.toThrow();
  expect(() =>
    requirePlanOfficeDependencyLock(
      { packages: { 'node_modules/x': { link: true, resolved: '../outside' } } },
      { packages: { 'node_modules/x': { link: true, resolved: '../outside' } } }
    )
  ).toThrow();
  for (const entry of [
    { version: '4.3.7', integrity: 'sha512-fixture' },
    { version: '4.3.6', integrity: 'changed' },
    { link: true, version: '4.3.6', integrity: 'sha512-fixture' },
  ])
    expect(() => requirePlanOfficeDependencyLock({ packages: { 'node_modules/zod': entry } }, source)).toThrow();
  expect(() => requirePlanOfficeDependencyLock({ packages: {} }, source)).toThrow();
  expect(() =>
    requirePlanOfficeDependencyLock({ packages: { 'node_modules/unlocked': { version: '1' } } }, source)
  ).toThrow();
});

it('resolves mandatory assets against the actual monorepo layout and canonical root skill', () => {
  const source = owningSource,
    assets = planOfficeAssetSources(source);
  expect(assets.map((asset) => [path.relative(source, asset.source), asset.destination])).toEqual([
    ['apps/web/scripts', 'scripts'],
    ['apps/web/packages', 'packages'],
    ['skills/reverie', 'skills/reverie'],
  ]);
  for (const asset of assets) expect(fs.lstatSync(asset.source).isDirectory(), asset.source).toBe(true);
  const skill = assets.find((asset) => asset.destination === 'skills/reverie')!;
  expect(fs.statSync(path.join(skill.source, 'SKILL.md')).isFile()).toBe(true);
  expect(fs.readFileSync(path.join(skill.source, 'SKILL.md'), 'utf8').length).toBeGreaterThan(100);
});

it('ships and compiles the actual inert scenario module beside every relative driver helper import', () => {
  const selected = new Set<string>(PLAN_OFFICE_TEST_ENTRIES);
  expect(selected.size).toBe(PLAN_OFFICE_TEST_ENTRIES.length);
  expect(selected.has('test/helpers/plan-office-move-driver.ts')).toBe(true);
  for (const entry of selected) {
    const source = fs.readFileSync(path.resolve(entry), 'utf8');
    const compiled = transformSync(source, { loader: 'ts', format: 'esm', platform: 'node', target: 'node22' }).code;
    expect(compiled.length).toBeGreaterThan(0);
    if (entry === 'test/helpers/plan-office-driver.ts') {
      for (const match of compiled.matchAll(/(?:from\s+)["'](\.\/[^"']+\.js)["']/g))
        expect(
          selected.has(path.posix.join(path.posix.dirname(entry), match[1]!.replace(/\.js$/, '.ts'))),
          match[1]
        ).toBe(true);
    }
  }
});
