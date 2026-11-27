import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const codexVersion = '0.172.0', claudeVersion = '2.1.326';
const claudePrefix = root => join(root, 'data/tools/claude', claudeVersion);
const codexPrefix = root => join(root, 'data/tools/codex', codexVersion);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reverie-clis-'));
  const bin = join(root, 'fake-bin'); mkdirSync(bin);
  const log = join(root, 'calls');
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), spec = args.at(-1), prefix = args[args.indexOf('--prefix')+1];
fs.appendFileSync(process.env.INSTALL_LOG, JSON.stringify(args)+'\\n');
console.log('synthetic private diagnostic must never reach application logs');
const at = spec.lastIndexOf('@'), pkg = spec.slice(0, at), version = spec.slice(at+1);
if (process.env.FAIL_PACKAGE === pkg) process.exit(1);
if (process.env.INSTALL_BARRIER) {
  fs.writeFileSync(process.env.INSTALL_BARRIER+'.started','ready');
  while (!fs.existsSync(process.env.INSTALL_BARRIER+'.release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
}
const name = pkg === '@anthropic-ai/claude-code' ? 'claude' : pkg === '@openai/codex' ? 'codex' : 'opencode';
const dir = path.join(prefix,'lib/node_modules',pkg); fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version}));
if(name==='claude' && process.env.CREATE_CLAUDE_NATIVE) { fs.mkdirSync(path.join(dir,'bin'),{recursive:true}); fs.writeFileSync(path.join(dir,'bin/claude.exe'),Buffer.from([127,69,76,70,0])); }
if(name==='opencode' && process.env.CREATE_NATIVE) { const native=path.join(dir,'node_modules/opencode-linux-'+process.arch+(process.arch==='x64'?'-baseline':''),'bin'); fs.mkdirSync(native,{recursive:true}); fs.writeFileSync(path.join(native,'opencode'),Buffer.from([127,69,76,70,0])); }
if(name==='opencode') fs.writeFileSync(path.join(dir,'postinstall.mjs'), "if(process.env.FAIL_POSTINSTALL) process.exit(1);");
fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
fs.writeFileSync(path.join(prefix,'bin',name),'#!${process.execPath}\\nconsole.log('+JSON.stringify(process.env.WRONG_BINARY_VERSION || version)+');\\n',{mode:0o700});
`, { mode: 0o700 });
  mkdirSync(join(root, 'home'));
  const env = { ...process.env, HOME: join(root, 'home'), PATH: bin+':'+process.env.PATH, REVERIE_DATA: join(root, 'data'), TMPDIR: join(root, 'tmp'), INSTALL_LOG: log };
  delete env.REVERIE_CLI_INSTALL_LOCKED;
  const run = extra => spawnSync(process.execPath, [resolve('scripts/reverie-install-clis.mjs')], { env: { ...env, ...extra }, encoding: 'utf8' });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, env, run, calls, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('first start installs exact pins on persistent storage and matching versions skip npm after restart', () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(f.calls().map(args => args.at(-1)), [`@anthropic-ai/claude-code@${claudeVersion}`, `@openai/codex@${codexVersion}`, 'opencode-ai@1.19.3']);
    assert.deepEqual(f.calls().map(args => args[args.indexOf('--prefix') + 1]), [claudePrefix(f.root), codexPrefix(f.root), join(f.root, 'data/tools')]);
    assert.ok(!first.stdout.includes('synthetic private diagnostic'));
    assert.equal(f.run().status, 0);
    assert.equal(f.calls().length, 3);
    assert.equal(JSON.parse(readFileSync(join(claudePrefix(f.root), '.install-claude.json'))).state, 'ready');
  } finally { f.clean(); }
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Fixture did not become ready'); await pause(20); }
}
function completion(child) {
  let stdout = '', stderr = '';
  child.stdout?.on('data', text => stdout += text); child.stderr?.on('data', text => stderr += text);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', status => resolve({ status, stdout, stderr })); });
}
function guarded(f, args = [], extra = {}, provider = 'codex') {
  const installer = join(f.root, 'installer');
  writeFileSync(installer, `#!${process.execPath}\nimport(${JSON.stringify('file://' + resolve('scripts/reverie-install-clis.mjs'))});\n`, { mode: 0o700 });
  return spawn('bash', [resolve('scripts/reverie-provider-cli'), provider, installer, provider === 'claude' ? claudeVersion : codexVersion, ...args], { env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('provider launch waits behind a blocked real installer and executes only the completed reviewed version', async () => {
  const f = fixture(); let installing, launching;
  const barrier = join(f.root, 'barrier'), oldStarted = join(f.root, 'old-started');
  try {
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex' }).status, 0);
    const tools = codexPrefix(f.root);
    writeFileSync(join(tools, 'lib/node_modules/@openai/codex/package.json'), JSON.stringify({ version: '0.146.0' }));
    writeFileSync(join(tools, 'bin/codex'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(oldStarted)},'wrong old version executed');process.exit(43);\n`, { mode: 0o700 });
    installing = spawn(process.execPath, [resolve('scripts/reverie-install-clis.mjs')], { env: { ...f.env, REVERIE_INSTALL_CLIS: 'codex', INSTALL_BARRIER: barrier }, stdio: ['ignore', 'pipe', 'pipe'] });
    const installed = completion(installing); await until(() => existsSync(barrier + '.started'));
    launching = guarded(f, ['--model', 'reviewed-model', '--version']); const launched = completion(launching);
    await pause(150); assert.equal(launching.exitCode, null); assert.equal(existsSync(oldStarted), false);
    writeFileSync(barrier + '.release', 'continue');
    assert.equal((await installed).status, 0);
    const result = await launched; assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), codexVersion);
    assert.equal(existsSync(oldStarted), false); assert.equal(f.calls().length, 2);
  } finally { writeFileSync(barrier + '.release', 'continue'); installing?.kill(); launching?.kill(); f.clean(); }
});

test('a busy installer timeout is an error for required launches, never permission to execute an old provider', async () => {
  const f = fixture(); let installing;
  const barrier = join(f.root, 'barrier');
  try {
    installing = spawn(process.execPath, [resolve('scripts/reverie-install-clis.mjs')], { env: { ...f.env, REVERIE_INSTALL_CLIS: 'codex', INSTALL_BARRIER: barrier }, stdio: ['ignore', 'pipe', 'pipe'] });
    const installed = completion(installing); await until(() => existsSync(barrier + '.started'));
    const result = await completion(guarded(f, [], { REVERIE_CLI_INSTALL_WAIT_SECONDS: '0.05' }));
    assert.equal(result.status, 75); assert.match(result.stderr, /timed out/);
    writeFileSync(barrier + '.release', 'continue'); await installed;
  } finally { writeFileSync(barrier + '.release', 'continue'); installing?.kill(); f.clean(); }
});

test('a newer container leaves the retained container’s Codex binary and pin intact', async () => {
  const f = fixture();
  try {
    const legacy = join(f.root, 'data/tools');
    const metadata = join(legacy, 'lib/node_modules/@openai/codex/package.json');
    mkdirSync(resolve(metadata, '..'), { recursive: true });
    mkdirSync(join(legacy, 'bin'), { recursive: true });
    writeFileSync(metadata, JSON.stringify({ version: '0.163.0' }));
    const binary = join(legacy, 'bin/codex');
    writeFileSync(binary, `#!${process.execPath}\nconsole.log('codex-cli 0.163.0');\n`, { mode: 0o700 });

    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex' }).status, 0);
    const current = await completion(guarded(f, ['--version']));
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.stdout.trim(), codexVersion);
    assert.equal(JSON.parse(readFileSync(metadata, 'utf8')).version, '0.163.0');
    assert.equal(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim(), 'codex-cli 0.163.0');
  } finally { f.clean(); }
});

test('a newer container leaves the retained container’s Claude binary and pin intact', async () => {
  const f = fixture();
  try {
    // The shared folder as an older image left it: Claude 2.1.308 at the legacy prefix, which that image's installer
    // insists on and would reinstall over anything else it found there.
    const legacy = join(f.root, 'data/tools');
    const metadata = join(legacy, 'lib/node_modules/@anthropic-ai/claude-code/package.json');
    mkdirSync(resolve(metadata, '..'), { recursive: true });
    mkdirSync(join(legacy, 'bin'), { recursive: true });
    writeFileSync(metadata, JSON.stringify({ version: '2.1.308' }));
    const binary = join(legacy, 'bin/claude');
    writeFileSync(binary, `#!${process.execPath}\nconsole.log('2.1.308 (Claude Code)');\n`, { mode: 0o700 });
    writeFileSync(join(legacy, '.install-claude.json'), JSON.stringify({ provider: 'claude', version: '2.1.308', state: 'ready' }));

    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'claude' }).status, 0);
    assert.deepEqual(f.calls().map(args => args[args.indexOf('--prefix') + 1]), [claudePrefix(f.root)]);
    const current = await completion(guarded(f, ['--version'], {}, 'claude'));
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.stdout.trim(), claudeVersion);
    assert.equal(JSON.parse(readFileSync(metadata, 'utf8')).version, '2.1.308');
    assert.equal(JSON.parse(readFileSync(join(legacy, '.install-claude.json'), 'utf8')).version, '2.1.308');
    assert.equal(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim(), '2.1.308 (Claude Code)');
    // A release name that is not a plain version never becomes a path.
    const odd = spawnSync('bash', [resolve('scripts/reverie-provider-cli'), 'claude', join(f.root, 'installer'), '../../escape', '--version'], { env: f.env, encoding: 'utf8' });
    assert.equal(odd.status, 2);
  } finally { f.clean(); }
});

test('version discovery never queues preparation behind an installer lock', async () => {
  const f = fixture(); let installing;
  const barrier = join(f.root, 'barrier');
  try {
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex' }).status, 0);
    installing = spawn(process.execPath, [resolve('scripts/reverie-install-clis.mjs')], { env: { ...f.env, REVERIE_INSTALL_CLIS: 'claude', INSTALL_BARRIER: barrier }, stdio: ['ignore', 'pipe', 'pipe'] });
    const installed = completion(installing); await until(() => existsSync(barrier + '.started'));
    const result = await completion(guarded(f, ['--version'], { REVERIE_CLI_INSTALL_WAIT_SECONDS: '0.05' }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), codexVersion);
    writeFileSync(barrier + '.release', 'continue'); await installed;
  } finally { writeFileSync(barrier + '.release', 'continue'); installing?.kill(); f.clean(); }
});

test('required launches refuse mismatched native versions while ordinary offline setup stays retryable', () => {
  const f = fixture();
  try {
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex', WRONG_BINARY_VERSION: '0.146.0', REVERIE_CLI_INSTALL_REQUIRED: '1' }).status, 1);
    assert.equal(JSON.parse(readFileSync(join(codexPrefix(f.root), '.install-codex.json'), 'utf8')).state, 'unavailable');
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex', WRONG_BINARY_VERSION: '0.146.0' }).status, 0);
  } finally { f.clean(); }
});

test('guarded direct Codex commands suppress updates, retain arguments, and keep npm globals on persistent storage', async () => {
  const f = fixture();
  try {
    const bin = join(codexPrefix(f.root), 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),prefix:process.env.npm_config_prefix}));\n`, { mode: 0o700 });
    const result = await completion(guarded(f, ['--model', 'gpt-6.1-sol', 'resume', 'saved-thread'], { REVERIE_INSTALL_CLIS: 'none' }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: ['--config', 'check_for_update_on_startup=false', '--model', 'gpt-6.1-sol', 'resume', 'saved-thread'], prefix: join(f.root, 'data/tools') });
    const update = await completion(guarded(f, ['update'])); assert.equal(update.status, 2); assert.match(update.stderr, /manages pinned Codex updates/);
    assert.equal(f.calls().length, 0);
  } finally { f.clean(); }
});

test('offline install failure is nonfatal and retries only the missing provider on a later start', () => {
  const f = fixture();
  try {
    assert.equal(f.run({ FAIL_PACKAGE: '@anthropic-ai/claude-code' }).status, 0);
    assert.equal(JSON.parse(readFileSync(join(claudePrefix(f.root), '.install-claude.json'))).state, 'unavailable');
    assert.equal(JSON.parse(readFileSync(join(codexPrefix(f.root), '.install-codex.json'))).state, 'ready');
    assert.equal(f.run().status, 0);
    assert.equal(f.calls().length, 4);
    assert.equal(f.calls().at(-1).at(-1), `@anthropic-ai/claude-code@${claudeVersion}`);
  } finally { f.clean(); }
});

test('none disables downloads and explicit selection installs only the requested provider', () => {
  const f = fixture();
  try {
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'none' }).status, 0);
    assert.equal(f.calls().length, 0);
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex' }).status, 0);
    assert.deepEqual(f.calls().map(args => args.at(-1)), [`@openai/codex@${codexVersion}`]);
  } finally { f.clean(); }
});

test('reviewed Codex and Claude upgrades preserve accounts, workspace state, and already-running processes', () => {
  const f = fixture();
  const active = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.equal(f.run().status, 0);
    const tools = join(f.root, 'data/tools');
    for (const [prefix, pkg, version] of [[codexPrefix(f.root), '@openai/codex', '0.146.0'], [claudePrefix(f.root), '@anthropic-ai/claude-code', '2.1.284']])
      writeFileSync(join(prefix, 'lib/node_modules', pkg, 'package.json'), JSON.stringify({ version }));
    const preserved = [join(f.env.HOME, '.codex/auth.json'), join(f.env.HOME, '.claude/.credentials.json'), join(f.root, 'data/subscription-profiles.json'), join(f.root, 'data/company.json')];
    for (const file of preserved) {
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, 'synthetic private fixture: retain unchanged\n', { mode: 0o600 });
    }
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex claude' }).status, 0);
    assert.deepEqual(f.calls().slice(3).map(args => args.at(-1)), [`@anthropic-ai/claude-code@${claudeVersion}`, `@openai/codex@${codexVersion}`]);
    for (const [id, version, integrity] of [
      ['codex', codexVersion, 'sha512-yHf/6wbw4Zvha2M2ylDhDrU9FgfKLYgV6xSzSjlz3gxQNsiVLkXo+fPGwBqvP0A5geLtZs9wAbq+1v7+ZVWJ0g=='],
      ['claude', claudeVersion, 'sha512-F7OqxXKogQYUs+RN1903IWlXGuxn8iwAykx+umRbDKvoBeK0Xm6cdgQx9auu5dtsB+DczN58/EFrlaU8pLfgJg=='],
    ]) {
      const status = JSON.parse(readFileSync(join(id === 'codex' ? codexPrefix(f.root) : claudePrefix(f.root), `.install-${id}.json`), 'utf8'));
      assert.equal(status.version, version); assert.equal(status.registryIntegrity, integrity); assert.equal(status.state, 'ready');
    }
    for (const file of preserved) assert.equal(readFileSync(file, 'utf8'), 'synthetic private fixture: retain unchanged\n');
    assert.ok(active.pid); assert.doesNotThrow(() => process.kill(active.pid, 0));
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex claude' }).status, 0);
    assert.equal(f.calls().length, 5, 'Matching reviewed pins should not reinstall');
  } finally { active.kill('SIGTERM'); f.clean(); }
});

test('optional ELF compatibility patches owned dynamic binaries and ignores static files or symlink escapes', () => {
  const f = fixture();
  try {
    const modules = join(codexPrefix(f.root), 'lib/node_modules/native'); mkdirSync(modules, { recursive: true });
    const dynamic = join(modules, 'dynamic'); const staticFile = join(modules, 'static');
    const outside = join(f.root, 'outside');
    for (const file of [dynamic, staticFile, outside]) writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
    symlinkSync(outside, join(modules, 'escape'));
    const patchLog = join(f.root, 'patch-calls'); const patcher = join(f.root, 'patchelf');
    writeFileSync(patcher, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(patchLog)}, JSON.stringify(args)+'\\n');
if (args[0] === '--print-interpreter') { if (args.at(-1).endsWith('/static')) process.exit(1); console.log('/old/loader'); }
if (args[0] === '--print-rpath') console.log('$ORIGIN');
`, { mode: 0o700 });
    const result = f.run({ REVERIE_INSTALL_CLIS: 'codex', REVERIE_ELF_PATCHER: patcher, REVERIE_ELF_INTERPRETER: '/nix/test/loader', REVERIE_ELF_LIBRARY_PATH: '/nix/test/lib' });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(patchLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const changes = calls.filter(args => args[0] === '--set-interpreter');
    assert.ok(changes.length > 0);
    assert.ok(changes.every(args => args.at(-1) === dynamic));
    assert.deepEqual(changes[0], ['--set-interpreter', '/nix/test/loader', '--set-rpath', '$ORIGIN:/nix/test/lib', dynamic]);
    assert.ok(!calls.some(args => args.at(-1) === outside || args.at(-1).endsWith('/escape')));
  } finally { f.clean(); }
});

test('direct native installer uses the same portable root as the native launcher', () => {
  const f = fixture();
  try {
    const result = f.run({ REVERIE_DATA: '', REVERIE_ROOT: join(f.root, 'portable'), REVERIE_CONTAINER: '0', REVERIE_INSTALL_CLIS: 'codex' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls()[0].includes(join(f.root, 'portable/companies/default/data/tools/codex', codexVersion)));
  } finally { f.clean(); }
});

test('OpenCode defers official postinstall until after extraction and failure never marks ready', () => {
  const f = fixture();
  try {
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'opencode', FAIL_POSTINSTALL: '1' }).status, 0);
    assert.ok(f.calls()[0].includes('--ignore-scripts'));
    assert.equal(JSON.parse(readFileSync(join(f.root,'data/tools/.install-opencode.json'))).state, 'unavailable');
  } finally { f.clean(); }
});

test('Nix OpenCode launches untouched baseline ELF through its loader before any postinstall probe', () => {
  const f = fixture();
  try {
    const loader = join(f.root, 'loader');
    writeFileSync(loader, `#!${process.execPath}\nconsole.log('1.19.3');\n`, { mode: 0o700 });
    const result = f.run({ REVERIE_INSTALL_CLIS: 'opencode', CREATE_NATIVE: '1', FAIL_POSTINSTALL: '1', REVERIE_ELF_INTERPRETER: loader, REVERIE_ELF_LIBRARY_PATH: '/nix/test/lib' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root,'data/tools/.install-opencode.json'))).state, 'ready');
    const launcher = readFileSync(join(f.root,'data/tools/bin/.reverie-opencode.mjs'), 'utf8');
    assert.ok(launcher.includes('--library-path'));
    assert.ok(launcher.includes(process.arch === 'x64' ? 'opencode-linux-x64-baseline' : 'opencode-linux-arm64'));
  } finally { f.clean(); }
});

test('Nix Claude native hardlink layout gets a nonmutating loader launcher', () => {
  const f = fixture();
  try {
    const loader = join(f.root, 'loader');
    writeFileSync(loader, `#!${process.execPath}\nconsole.log('${claudeVersion}');\n`, { mode: 0o700 });
    const result = f.run({ REVERIE_INSTALL_CLIS: 'claude', CREATE_CLAUDE_NATIVE: '1', REVERIE_ELF_INTERPRETER: loader, REVERIE_ELF_LIBRARY_PATH: '/nix/test/lib' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(claudePrefix(f.root), '.install-claude.json'))).state, 'ready');
    assert.ok(readFileSync(join(claudePrefix(f.root), 'bin/.reverie-claude.mjs'), 'utf8').includes('--library-path'));
    assert.deepEqual(readFileSync(join(claudePrefix(f.root), 'lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')), Buffer.from([127,69,76,70,0]));
  } finally { f.clean(); }
});

function claudeDispatchFixture(callback) {
  const f = fixture();
  try {
    const loader = join(f.root, 'loader');
    writeFileSync(loader, `#!${process.execPath}\nconsole.log('${claudeVersion}');\n`, { mode: 0o700 });
    const result = f.run({ REVERIE_INSTALL_CLIS: 'claude', CREATE_CLAUDE_NATIVE: '1', REVERIE_ELF_INTERPRETER: loader, REVERIE_ELF_LIBRARY_PATH: '/nix/test/lib' });
    assert.equal(result.status, 0, result.stderr);
    const native = join(claudePrefix(f.root), 'lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    const before = readFileSync(native);
    const source = readFileSync(join(claudePrefix(f.root), 'bin/.reverie-claude.mjs'), 'utf8')
      .replace(/^#![^\n]*\n/, '').replace(/^import [^\n]*\n/gm, '');
    const dispatch = (kind, status = 0, libraryPath = '/caller/lib') => {
      let call, exit;
      const env = { CLAUDE_CODE_EXECPATH: '/old/loader', SYNTHETIC_ACCOUNT: 'unchanged' };
      if (libraryPath !== null) env.LD_LIBRARY_PATH = libraryPath;
      runInNewContext(source, {
        realpathSync(path) {
          if (path === loader) return '/nix/pinned/ld.so';
          assert.ok(['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1'].includes(path));
          if (kind === 'missing') throw new Error('missing image interpreter');
          return kind === 'match' ? '/nix/pinned/ld.so' : '/other/ld.so';
        },
        spawnSync(command, args, options) { call = { command, args: Array.from(args), options }; return { status }; },
        process: { argv: ['node', 'launcher', '--model', 'fixture model', 'resume', 'saved-thread', ';literal'], env, exit(code) { exit = code; } },
      });
      return { call, exit, env };
    };
    callback({ dispatch, native, loader });
    assert.deepEqual(readFileSync(native), before, 'vendor ELF must remain byte-identical');
  } finally { f.clean(); }
}

test('matching image interpreter kernel-starts Claude and points bundled tools at the real binary', () => {
  claudeDispatchFixture(({ dispatch, native }) => {
    const { call, exit } = dispatch('match');
    assert.equal(call.command, native);
    assert.deepEqual(call.args, ['--model', 'fixture model', 'resume', 'saved-thread', ';literal']);
    assert.equal(call.options.env.CLAUDE_CODE_EXECPATH, native);
    assert.equal(call.options.env.LD_LIBRARY_PATH, '/caller/lib');
    assert.equal(call.options.env.SYNTHETIC_ACCOUNT, 'unchanged');
    assert.equal(call.options.stdio, 'inherit');
    assert.equal(exit, 0);
  });
});

test('direct Claude launch does not introduce library-path environment variables', () => {
  claudeDispatchFixture(({ dispatch }) => {
    const { call } = dispatch('match', 0, null);
    assert.equal('LD_LIBRARY_PATH' in call.options.env, false);
    assert.equal('NIX_LD_LIBRARY_PATH' in call.options.env, false);
    assert.equal('LD_PRELOAD' in call.options.env, false);
  });
});

for (const kind of ['missing', 'mismatch']) {
  test(`Claude keeps compatibility loader when image interpreter is ${kind}`, () => {
    claudeDispatchFixture(({ dispatch, native, loader }) => {
      const { call, exit, env } = dispatch(kind);
      assert.equal(call.command, loader);
      assert.deepEqual(call.args, ['--library-path', '/nix/test/lib', native, '--model', 'fixture model', 'resume', 'saved-thread', ';literal']);
      assert.equal(call.options.env, env);
      assert.equal(exit, 0);
    });
  });
}

test('direct Claude launcher preserves failure status and refuses a spawn error as success', () => {
  claudeDispatchFixture(({ dispatch }) => {
    assert.equal(dispatch('match', 37).exit, 37);
    assert.equal(dispatch('match', null).exit, 1);
  });
});
