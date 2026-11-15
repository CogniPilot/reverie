/** CI-only current-source tree producer; no server, Docker or model invocation. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
interface Lock {
  packages: Record<string, { version?: string; integrity?: string; link?: boolean; resolved?: string }>;
}
export function requirePlanOfficeDependencyLock(installed: Lock, source: Lock): void {
  if (!installed.packages || !source.packages) throw Error('Locked dependencies required');
  let count = 0;
  for (const [name, actual] of Object.entries(installed.packages)) {
    if (!name.startsWith('node_modules/')) continue;
    const expected = source.packages[name];
    count++;
    if (
      !expected ||
      (actual.link
        ? !expected.link ||
          actual.resolved !== expected.resolved ||
          (actual.resolved !== '' && !/^packages\/[A-Za-z0-9_-]+$/.test(actual.resolved ?? ''))
        : expected.link) ||
      actual.version !== expected.version ||
      actual.integrity !== expected.integrity
    )
      throw Error('CI dependency differs from owning source lock: ' + name);
  }
  if (count === 0) throw Error('Nonempty immutable dependency graph required');
}
export function planOfficeAssetSources(source: string) {
  return [
    { source: path.join(source, 'apps/web/scripts'), destination: 'scripts' },
    { source: path.join(source, 'apps/web/packages'), destination: 'packages' },
    { source: path.join(source, 'skills/reverie'), destination: 'skills/reverie' },
  ];
}
export function buildPlanOffice(args: readonly string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--source', '--modules', '--esbuild', '--node', '--docker', '--output'].includes(key) ||
      !value ||
      flags.has(key)
    )
      throw Error('Closed CI build inputs required');
    flags.set(key, value);
  }
  const input = (key: string, directory: boolean) => {
    const value = flags.get(key);
    if (!value) throw Error('Missing CI build input');
    const resolved = fs.realpathSync(value),
      st = fs.statSync(resolved);
    if (!resolved.startsWith('/nix/store/') || (directory ? !st.isDirectory() : !st.isFile()))
      throw Error('Immutable CI input required');
    return resolved;
  };
  const source = input('--source', true),
    modules = input('--modules', true),
    esbuild = input('--esbuild', false),
    node = input('--node', false),
    docker = input('--docker', false);
  const output = flags.get('--output');
  if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Fresh CI output required');
  const web = path.join(source, 'apps/web'),
    installed = JSON.parse(fs.readFileSync(path.join(modules, '.package-lock.json'), 'utf8')) as Lock;
  requirePlanOfficeDependencyLock(
    installed,
    JSON.parse(fs.readFileSync(path.join(web, 'package-lock.json'), 'utf8')) as Lock
  );
  const runtime = path.join(output, 'lib/reverie'),
    dist = path.join(runtime, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const selectedModules = path.join(runtime, 'node_modules');
  fs.mkdirSync(selectedModules);
  const select = (name: string) => {
    const actual = installed.packages['node_modules/' + name];
    const target = actual?.link ? path.join(runtime, actual.resolved!) : path.join(modules, name);
    fs.symlinkSync(target, path.join(selectedModules, name));
  };
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      fs.mkdirSync(path.join(selectedModules, entry.name));
      for (const child of fs.readdirSync(path.join(modules, entry.name))) select(entry.name + '/' + child);
    } else select(entry.name);
  }
  for (const file of ['package.json', 'package-lock.json', 'LICENSE'])
    fs.copyFileSync(path.join(web, file), path.join(runtime, file));
  for (const asset of planOfficeAssetSources(source)) {
    const target = path.join(runtime, asset.destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(asset.source, target, { recursive: true });
  }
  const run = (command: string, argv: readonly string[], cwd = runtime) => {
    const result = spawnSync(command, [...argv], {
      cwd,
      stdio: 'inherit',
      timeout: 120000,
      env: { ...process.env, NODE_PATH: modules, npm_config_offline: 'true', npm_config_yes: 'false' },
    });
    if (result.error || result.status !== 0 || result.signal) throw Error('Current-source CI build refused');
  };
  const files = (root: string): string[] =>
    fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const name = path.join(root, entry.name);
      if (entry.isSymbolicLink()) throw Error('Source-tree symlink refused');
      return entry.isDirectory()
        ? files(name)
        : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
          ? [name]
          : [];
    });
  // Preserve per-module import.meta paths. Flattening WebServer would change its public/ and helper roots.
  run(esbuild, [
    ...files(path.join(web, 'src')),
    '--outdir=' + dist,
    '--outbase=' + path.join(web, 'src'),
    '--platform=node',
    '--format=esm',
    '--target=node22',
  ]);
  fs.cpSync(path.join(web, 'src/web/public'), path.join(dist, 'web/public'), { recursive: true });
  fs.cpSync(path.join(web, 'src/templates'), path.join(dist, 'templates'), { recursive: true });
  run(node, [path.join(runtime, 'scripts/prepare-test-vendor.mjs'), path.join(dist, 'web/public/vendor')]);
  const banner = "import {createRequire as __ciRequire} from 'node:module';const require=__ciRequire(import.meta.url);";
  const bundle = (entry: string, destination: string) =>
    run(esbuild, [
      path.join(web, entry),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--banner:js=' + banner,
      '--outfile=' + destination,
    ]);
  const fake = path.join(output, 'opt/reverie-ci-plan-provider/bin/claude');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  bundle('test/fixtures/boxed-plan-provider.mts', fake);
  fs.chmodSync(fake, 0o555);
  const workerPrep = path.join(output, 'opt/reverie-ci-plan-provider/lib/prepare-home.mjs');
  fs.mkdirSync(path.dirname(workerPrep), { recursive: true });
  bundle('test/fixtures/prepare-plan-office-worker.mts', workerPrep);
  // This exact separate test-only entry seeds inactive DATA. Ordinary control startup is dist/index.js web.
  fs.symlinkSync('dist', path.join(runtime, 'src'));
  run(esbuild, [
    path.join(web, 'test/fixtures/plan-office-bootstrap.ts'),
    path.join(web, 'test/helpers/plan-office-bootstrap.ts'),
    path.join(web, 'test/helpers/plan-office-driver.ts'),
    path.join(web, 'test/helpers/docker-continuation-auth-canary.ts'),
    path.join(web, 'test/fixtures/plan-office-canary.mts'),
    '--outdir=' + path.join(runtime, 'test'),
    '--outbase=' + path.join(web, 'test'),
    '--platform=node',
    '--format=esm',
    '--target=node22',
  ]);
  fs.renameSync(
    path.join(runtime, 'test/fixtures/plan-office-canary.js'),
    path.join(runtime, 'test/fixtures/plan-office-canary.mjs')
  );
  fs.copyFileSync(
    path.join(web, 'test/fixtures/boxed-canary-fixture-contract.mjs'),
    path.join(runtime, 'test/fixtures/boxed-canary-fixture-contract.mjs')
  );
  fs.writeFileSync(
    path.join(runtime, 'plan-office-bootstrap.mjs'),
    "import './test/fixtures/plan-office-bootstrap.js';\n"
  );
  fs.writeFileSync(
    path.join(output, 'metadata.json'),
    JSON.stringify({
      version: 1,
      purpose: 'reverie-ci-plan-office-build-v1',
      sourcePath: source,
      dependencyModules: modules,
      nodeExecutable: node,
      dockerExecutable: docker,
      controlEntry: 'lib/reverie/dist/index.js',
      bootstrapEntry: 'lib/reverie/plan-office-bootstrap.mjs',
      fakeProvider: 'opt/reverie-ci-plan-provider/bin/claude',
      baselineDriver: 'lib/reverie/test/fixtures/plan-office-canary.mjs',
    }) + '\n'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  buildPlanOffice(process.argv.slice(2));
