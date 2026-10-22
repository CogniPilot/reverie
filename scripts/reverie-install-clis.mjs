#!/usr/bin/env node
/** Install user-requested provider tools on persistent storage, never into the image.
 * Exact versions/integrities verified against registry.npmjs.org version metadata.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const providers = [
  { id: 'claude', package: '@anthropic-ai/claude-code', version: '2.1.308', integrity: 'sha512-b2HnszgyN73wRTFP+IYPDJNn9ADXnG6jr26ibL+w03HSKqfb6GqE8Jnfr4mz37Zv4AT/NP+B5/3c1F89WTdWSA==' },
  { id: 'codex', package: '@openai/codex', version: '0.163.0', integrity: 'sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw==' },
  { id: 'opencode', package: 'opencode-ai', version: '1.19.3', integrity: 'sha512-wDRcUlMDibaLzecIGvVGUA9naghXVqzCWcUE7N3qagpGiLSUlU4VbixI+bpsErwJp+AAuSO2lhSr/XxJl7XbrQ==' },
];
process.umask(0o077);
const root = process.env.REVERIE_ROOT || join(homedir(), 'reverie');
const data = process.env.REVERIE_DATA || (process.env.REVERIE_CONTAINER === '1' ? '/instances/default' : join(root, 'companies/default/data'));
const prefix = join(data, 'tools');
const requested = (process.env.REVERIE_INSTALL_CLIS || 'claude codex opencode').trim().split(/\s+/);
if (requested.length === 1 && requested[0] === 'none') process.exit(0);
if (process.argv.length !== 2 || requested.some(id => !providers.some(provider => provider.id === id))) {
  console.error('reverie-install-clis: choose claude, codex, opencode, or none using REVERIE_INSTALL_CLIS.');
  process.exit(2);
}
mkdirSync(prefix, { recursive: true });
if (process.env.REVERIE_CLI_INSTALL_LOCKED !== '1') {
  const wait = process.env.REVERIE_CLI_INSTALL_WAIT === '1';
  const requestedWait = Number(process.env.REVERIE_CLI_INSTALL_WAIT_SECONDS || 180);
  const waitSeconds = Number.isFinite(requestedWait) && requestedWait >= 0.05 && requestedWait <= 180 ? requestedWait : 180;
  const child = spawnSync('flock', [ ...(wait ? ['-w', String(waitSeconds)] : ['-n']), '-E', '75', join(prefix, '.install.lock'), process.execPath, fileURLToPath(import.meta.url)], {
    env: { ...process.env, REVERIE_CLI_INSTALL_LOCKED: '1' }, stdio: 'inherit',
  });
  if (child.status === 75) console.log(wait ? 'reverie-install-clis: provider preparation timed out; retry when installation finishes.' : 'reverie-install-clis: an installer is already running.');
  else if (child.error) console.error('reverie-install-clis: installer could not start.');
  process.exit(child.status === 75 && !wait ? 0 : child.status ?? 1);
}
const timeoutSeconds = 120;
const cache = process.env.npm_config_cache || join(process.env.TMPDIR || join(process.env.REVERIE_ROOT || join(homedir(), 'reverie'), 'scratch/tmp'), 'npm-provider-clis');
mkdirSync(cache, { recursive: true });
const env = { ...process.env, npm_config_cache: cache };
const patchOwnedElfs = () => {
  const patcher = process.env.REVERIE_ELF_PATCHER;
  if (!patcher) return;
  const interpreter = process.env.REVERIE_ELF_INTERPRETER;
  const libraries = process.env.REVERIE_ELF_LIBRARY_PATH;
  if (!isAbsolute(patcher) || !interpreter || !isAbsolute(interpreter) || !libraries || libraries.split(':').some(path => !isAbsolute(path))) {
    console.log('reverie-install-clis: ELF compatibility configuration is incomplete.');
    return;
  }
  const deadline = Date.now() + 120_000;
  const walk = directory => {
    if (Date.now() > deadline) return;
    let stat;
    try { stat = lstatSync(directory); } catch { return; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      let info;
      try { info = lstatSync(path); } catch { continue; }
      if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) continue;
      // Bun standalone executables contain appended payloads: ELF rewriting can corrupt them.
      if (info.isDirectory()) { if (name !== 'opencode-ai' && !name.startsWith('opencode-linux-') && name !== 'claude-code' && !name.startsWith('claude-code-linux-')) walk(path); continue; }
      if (!info.isFile() || info.nlink > 1 || Date.now() > deadline) continue;
      const magic = Buffer.alloc(4);
      let descriptor;
      try { descriptor = openSync(path, 'r'); readSync(descriptor, magic, 0, 4, 0); } catch { continue; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
      const current = spawnSync(patcher, ['--print-interpreter', path], { encoding: 'utf8', timeout: 10_000 });
      // Static ELF files have no interpreter and need no loader change.
      if (current.status !== 0 || !current.stdout.trim()) continue;
      const oldRpath = spawnSync(patcher, ['--print-rpath', path], { encoding: 'utf8', timeout: 10_000 });
      const rpath = [...new Set([...(oldRpath.stdout || '').trim().split(':'), ...libraries.split(':')].filter(Boolean))].join(':');
      if (current.stdout.trim() === interpreter && (oldRpath.stdout || '').trim() === rpath) continue;
      spawnSync(patcher, ['--set-interpreter', interpreter, '--set-rpath', rpath, path], { stdio: 'ignore', timeout: 10_000 });
    }
  };
  const base = join(prefix, 'lib/node_modules');
  try { if (realpathSync(base) !== join(realpathSync(prefix), 'lib/node_modules')) return; } catch { return; }
  walk(base);
};
const prepareClaude = () => {
  if (process.platform !== 'linux' || !process.env.REVERIE_ELF_INTERPRETER) return false;
  const binary = join(prefix, 'lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  try {
    const info = lstatSync(binary);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) return false;
    const magic = Buffer.alloc(4);
    const descriptor = openSync(binary, 'r');
    try { readSync(descriptor, magic, 0, 4, 0); } finally { closeSync(descriptor); }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return false;
  } catch { return false; }
  const launcher = join(prefix, 'bin/.reverie-claude.mjs');
  writeFileSync(launcher, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst r=spawnSync(${JSON.stringify(process.env.REVERIE_ELF_INTERPRETER)},['--library-path',${JSON.stringify(process.env.REVERIE_ELF_LIBRARY_PATH || '')},${JSON.stringify(binary)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exit(r.status ?? 1);\n`, { mode: 0o700 });
  try { unlinkSync(join(prefix, 'bin/claude')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  symlinkSync('.reverie-claude.mjs', join(prefix, 'bin/claude'));
  return true;
};
const prepareOpenCode = () => {
  if (process.platform !== 'linux' || !process.env.REVERIE_ELF_INTERPRETER) return false;
  const arch = process.arch;
  if (!['x64', 'arm64'].includes(arch)) return false;
  const platform = `opencode-linux-${arch}${arch === 'x64' ? '-baseline' : ''}`;
  const binary = join(prefix, 'lib/node_modules/opencode-ai/node_modules', platform, 'bin/opencode');
  try { const info = lstatSync(binary); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) return false; } catch { return false; }
  // Invoke the unchanged vendor ELF through the runtime loader, preserving Bun's payload.
  const launcher = join(prefix, 'bin/.reverie-opencode.mjs');
  const code = `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst r=spawnSync(${JSON.stringify(process.env.REVERIE_ELF_INTERPRETER)},['--library-path',${JSON.stringify(process.env.REVERIE_ELF_LIBRARY_PATH || '')},${JSON.stringify(binary)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exit(r.status ?? 1);\n`;
  writeFileSync(launcher, code, { mode: 0o700 });
  const link = join(prefix, 'bin/opencode');
  try { unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  symlinkSync('.reverie-opencode.mjs', link);
  return true;
};
patchOwnedElfs();
const runnable = provider => {
  const binary = join(prefix, 'bin', provider.id);
  try { accessSync(binary, constants.X_OK); } catch { return false; }
  const result = spawnSync('timeout', ['--kill-after=2s', '10s', binary, '--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16384 });
  const version = provider.version.replaceAll('.', '\\.');
  return result.status === 0 && new RegExp(`\\b${version}\\b`).test(result.stdout || '');
};
const status = (provider, state) => {
  const path = join(prefix, `.install-${provider.id}.json`);
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ provider: provider.id, package: provider.package, version: provider.version, registryIntegrity: provider.integrity, state, checkedAt: new Date().toISOString() })+'\n', { mode: 0o600 });
  renameSync(temporary, path);
};
for (const provider of providers.filter(provider => requested.includes(provider.id))) {
  let installed;
  try { installed = JSON.parse(readFileSync(join(prefix, 'lib/node_modules', provider.package, 'package.json'), 'utf8')).version; } catch {}
  if (provider.id === 'claude' && installed === provider.version) prepareClaude();
  if (provider.id === 'opencode' && installed === provider.version) prepareOpenCode();
  if (installed === provider.version && runnable(provider)) {
    status(provider, 'ready');
    console.log(`reverie-install-clis: ${provider.id} ${provider.version} ready.`);
    continue;
  }
  console.log(`reverie-install-clis: installing ${provider.id} ${provider.version}.`);
  // npm verifies downloaded package integrity using the official registry metadata.
  // Subprocess output is deliberately not relayed: no account/token data enters logs.
  const result = spawnSync('timeout', ['--kill-after=5s', `${timeoutSeconds}s`, 'npm', 'install', '--global', '--prefix', prefix,
    '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=30000', ...(provider.id === 'opencode' ? ['--ignore-scripts'] : []), `${provider.package}@${provider.version}`], { env, stdio: 'ignore' });
  if (result.status === 0) { patchOwnedElfs(); if (provider.id === 'claude') prepareClaude(); }
  // OpenCode's postinstall probes an ELF before Nix loader compatibility exists.
  // Use a loader wrapper on Nix; run the official platform setup elsewhere.
  const setup = result.status === 0 && provider.id === 'opencode'
    ? (prepareOpenCode() ? { status: 0 } : spawnSync('timeout', ['--kill-after=5s', `${timeoutSeconds}s`, process.execPath, join(prefix, 'lib/node_modules/opencode-ai/postinstall.mjs')], { env, stdio: 'ignore' }))
    : result;
  const ready = result.status === 0 && setup.status === 0 && runnable(provider);
  status(provider, ready ? 'ready' : 'unavailable');
  if (!ready && process.env.REVERIE_CLI_INSTALL_REQUIRED === '1') process.exitCode = 1;
  console.log(`reverie-install-clis: ${provider.id} ${ready ? 'ready' : 'unavailable; retry with reverie-install-clis when the network/runtime is ready'}.`);
}
