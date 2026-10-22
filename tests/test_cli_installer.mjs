import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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
const name = pkg === '@anthropic-ai/claude-code' ? 'claude' : pkg === '@openai/codex' ? 'codex' : 'opencode';
const dir = path.join(prefix,'lib/node_modules',pkg); fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version}));
if(name==='claude' && process.env.CREATE_CLAUDE_NATIVE) { fs.mkdirSync(path.join(dir,'bin'),{recursive:true}); fs.writeFileSync(path.join(dir,'bin/claude.exe'),Buffer.from([127,69,76,70,0])); }
if(name==='opencode' && process.env.CREATE_NATIVE) { const native=path.join(dir,'node_modules/opencode-linux-'+process.arch+(process.arch==='x64'?'-baseline':''),'bin'); fs.mkdirSync(native,{recursive:true}); fs.writeFileSync(path.join(native,'opencode'),Buffer.from([127,69,76,70,0])); }
if(name==='opencode') fs.writeFileSync(path.join(dir,'postinstall.mjs'), "if(process.env.FAIL_POSTINSTALL) process.exit(1);");
fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
fs.writeFileSync(path.join(prefix,'bin',name),'#!${process.execPath}\\nconsole.log('+JSON.stringify(version)+');\\n',{mode:0o700});
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
    assert.deepEqual(f.calls().map(args => args.at(-1)), ['@anthropic-ai/claude-code@2.1.308', '@openai/codex@0.163.0', 'opencode-ai@1.19.3']);
    assert.ok(f.calls().every(args => args.includes(join(f.root,'data/tools'))));
    assert.ok(!first.stdout.includes('synthetic private diagnostic'));
    assert.equal(f.run().status, 0);
    assert.equal(f.calls().length, 3);
    assert.equal(JSON.parse(readFileSync(join(f.root,'data/tools/.install-claude.json'))).state, 'ready');
  } finally { f.clean(); }
});

test('offline install failure is nonfatal and retries only the missing provider on a later start', () => {
  const f = fixture();
  try {
    assert.equal(f.run({ FAIL_PACKAGE: '@anthropic-ai/claude-code' }).status, 0);
    assert.equal(JSON.parse(readFileSync(join(f.root,'data/tools/.install-claude.json'))).state, 'unavailable');
    assert.equal(JSON.parse(readFileSync(join(f.root,'data/tools/.install-codex.json'))).state, 'ready');
    assert.equal(f.run().status, 0);
    assert.equal(f.calls().length, 4);
    assert.equal(f.calls().at(-1).at(-1), '@anthropic-ai/claude-code@2.1.308');
  } finally { f.clean(); }
});

test('none disables downloads and explicit selection installs only the requested provider', () => {
  const f = fixture();
  try {
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'none' }).status, 0);
    assert.equal(f.calls().length, 0);
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex' }).status, 0);
    assert.deepEqual(f.calls().map(args => args.at(-1)), ['@openai/codex@0.163.0']);
  } finally { f.clean(); }
});

test('reviewed Codex and Claude upgrades preserve accounts, workspace state, and already-running processes', () => {
  const f = fixture();
  const active = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.equal(f.run().status, 0);
    const tools = join(f.root, 'data/tools');
    for (const [pkg, version] of [['@openai/codex', '0.146.0'], ['@anthropic-ai/claude-code', '2.1.284']])
      writeFileSync(join(tools, 'lib/node_modules', pkg, 'package.json'), JSON.stringify({ version }));
    const preserved = [join(f.env.HOME, '.codex/auth.json'), join(f.env.HOME, '.claude/.credentials.json'), join(f.root, 'data/subscription-profiles.json'), join(f.root, 'data/company.json')];
    for (const file of preserved) {
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, 'synthetic private fixture: retain unchanged\n', { mode: 0o600 });
    }
    assert.equal(f.run({ REVERIE_INSTALL_CLIS: 'codex claude' }).status, 0);
    assert.deepEqual(f.calls().slice(3).map(args => args.at(-1)), ['@anthropic-ai/claude-code@2.1.308', '@openai/codex@0.163.0']);
    for (const [id, version, integrity] of [
      ['codex', '0.163.0', 'sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw=='],
      ['claude', '2.1.308', 'sha512-b2HnszgyN73wRTFP+IYPDJNn9ADXnG6jr26ibL+w03HSKqfb6GqE8Jnfr4mz37Zv4AT/NP+B5/3c1F89WTdWSA=='],
    ]) {
      const status = JSON.parse(readFileSync(join(tools, `.install-${id}.json`), 'utf8'));
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
    const modules = join(f.root, 'data/tools/lib/node_modules/native'); mkdirSync(modules, { recursive: true });
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
    assert.ok(f.calls()[0].includes(join(f.root, 'portable/companies/default/data/tools')));
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
    writeFileSync(loader, `#!${process.execPath}\nconsole.log('2.1.308');\n`, { mode: 0o700 });
    const result = f.run({ REVERIE_INSTALL_CLIS: 'claude', CREATE_CLAUDE_NATIVE: '1', REVERIE_ELF_INTERPRETER: loader, REVERIE_ELF_LIBRARY_PATH: '/nix/test/lib' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root,'data/tools/.install-claude.json'))).state, 'ready');
    assert.ok(readFileSync(join(f.root,'data/tools/bin/.reverie-claude.mjs'), 'utf8').includes('--library-path'));
    assert.deepEqual(readFileSync(join(f.root,'data/tools/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')), Buffer.from([127,69,76,70,0]));
  } finally { f.clean(); }
});
