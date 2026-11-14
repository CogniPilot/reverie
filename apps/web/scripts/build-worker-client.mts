/** Build-time agent-only bundle. No instance environment, credential or server startup. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
const flags = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]!,
    value = process.argv[index + 1];
  if (
    !['--entry', '--esbuild', '--node', '--source', '--modules', '--output'].includes(key) ||
    !value ||
    flags.has(key)
  )
    throw Error('Closed worker-client build arguments required');
  flags.set(key, value);
}
for (const key of ['--entry', '--esbuild', '--node', '--source', '--modules', '--output'])
  if (!flags.has(key)) throw Error('Missing worker-client build input');
function fixedFile(value: string): string {
  const file = fs.realpathSync(value);
  if (!file.startsWith('/nix/store/') || !fs.statSync(file).isFile()) throw Error('Immutable build input required');
  return file;
}
const entry = fixedFile(flags.get('--entry')!),
  esbuild = fixedFile(flags.get('--esbuild')!),
  node = fixedFile(flags.get('--node')!);
const source = fs.realpathSync(flags.get('--source')!);
if (!source.startsWith('/nix/store/')) throw Error('Immutable source notice input required');
const modules = fs.realpathSync(flags.get('--modules')!);
if (!modules.startsWith('/nix/store/') || !fs.statSync(modules).isDirectory())
  throw Error('Immutable dependency modules required');
const installedLock = JSON.parse(fs.readFileSync(join(modules, '.package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; integrity?: string }>;
};
const sourceLock = JSON.parse(fs.readFileSync(join(source, 'apps/web/package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; integrity?: string }>;
};
const output = resolve(flags.get('--output')!);
fs.mkdirSync(output);
const bundle = join(output, 'agent.mjs'),
  metadata = join(output, 'metafile.json'),
  working = dirname(entry);
const args = [
  entry,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  '--legal-comments=linked',
  '--outfile=' + bundle,
  '--metafile=' + metadata,
  "--banner:js=import {createRequire as __reverieCreateRequire} from 'node:module';const require=__reverieCreateRequire(import.meta.url);",
];
const built = spawnSync(esbuild, args, {
  cwd: working,
  stdio: 'inherit',
  timeout: 120000,
  env: { ...process.env, NODE_PATH: modules },
});
if (built.status !== 0) throw Error('Worker client bundle refused');
const meta = JSON.parse(fs.readFileSync(metadata, 'utf8')) as {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports: { external: boolean; path: string }[] }>;
};
if (
  Object.values(meta.outputs).some((value) =>
    value.imports.some((item) => item.external && !item.path.startsWith('node:'))
  )
)
  throw Error('Only Node builtin runtime imports are supported');
const noticeRoot = join(output, 'notices');
fs.mkdirSync(noticeRoot);
for (const [file, name] of [
  [source + '/apps/web/LICENSE', 'Reverie-LICENSE'],
  [source + '/THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
]) {
  fs.copyFileSync(fixedFile(file!), join(noticeRoot, name!));
}
const packages = new Set<string>();
for (const input of Object.keys(meta.inputs)) {
  let current = dirname(resolve(working, input));
  while (current.startsWith('/nix/store/')) {
    if (fs.existsSync(join(current, 'package.json'))) {
      packages.add(current);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
let serial = 0;
for (const root of [...packages].sort()) {
  if (root.startsWith(modules + '/')) {
    const key = 'node_modules/' + root.slice(modules.length + 1),
      actual = installedLock.packages[key],
      expected = sourceLock.packages[key];
    if (!actual || !expected || actual.version !== expected.version || actual.integrity !== expected.integrity)
      throw Error('Selected package differs from the locked source dependency');
  }
  const names = fs
    .readdirSync(root)
    .filter((name) => /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(name))
    .sort();
  for (const name of names) {
    const file = fixedFile(join(root, name));
    if (fs.statSync(file).size > 1024 * 1024) throw Error('Bounded license input required');
    const directory = join(noticeRoot, 'package-' + String(serial).padStart(3, '0'));
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(file, join(directory, basename(name)));
  }
  serial++;
}
if (!fs.existsSync(bundle + '.LEGAL.txt')) fs.writeFileSync(bundle + '.LEGAL.txt', '');
const settings = spawnSync(node, [bundle, 'worker-client', 'hook-settings'], {
  encoding: 'utf8',
  timeout: 15000,
  maxBuffer: 128 * 1024,
});
if (settings.status !== 0) throw Error('Current worker-client role required; old bundles refused');
const parsed = JSON.parse(settings.stdout) as { hooks?: unknown; statusLine?: unknown };
if (!parsed.hooks || !parsed.statusLine) throw Error('Managed worker hook settings required');
fs.writeFileSync(join(output, 'claude-hooks.json'), JSON.stringify(parsed));
