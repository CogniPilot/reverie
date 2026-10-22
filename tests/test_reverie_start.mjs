import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dirname, '../scripts/reverie-start');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reverie-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls');
  mkdirSync(bin); mkdirSync(home);
  for (const name of ['docker', 'nix']) {
    const file = join(bin, name);
    writeFileSync(file, '#!' + process.execPath + '\n' +
      "const fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(process.env.CALLS,JSON.stringify([process.env.TOOL,a])+'\\n');" +
      (name === 'nix' ? "console.log('/nix/store/example-image.tar');" :
        "if(a[0]==='inspect'){if(process.env.INSPECT){console.log(process.env.INSPECT)}else process.exit(1)}"));
    // Each stub embeds its own tool identity without invoking a shell.
    writeFileSync(file, readFileSync(file, 'utf8').replace('process.env.TOOL', JSON.stringify(name)));
    chmodSync(file, 0o755);
  }
  const deploy = join(home, 'reverie');
  const run = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, CALLS: log, ...env },
  });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, home, deploy, run, calls };
}
test('first start contains company state, workspace and scratch with no source or control mount', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(join(f.deploy, 'deployment.json'), 'utf8'));
  assert.equal(config.companyRoot, join(f.deploy, 'companies/default'));
  assert.equal(config.scratch, join(f.deploy, 'scratch/agents'));
  assert.ok(lstatSync(join(f.deploy, 'scratch')).isSymbolicLink());
  const command = f.calls().find(([tool, args]) => tool === 'docker' && args[0] === 'run')[1];
  for (const mount of [
    'type=bind,src=' + join(config.companyRoot, 'data') + ',dst=/instances/default',
    'type=bind,src=' + join(config.companyRoot, 'home') + ',dst=/home/agent',
    'type=bind,src=' + config.workspace + ',dst=/reverie_workspace',
    'type=bind,src=' + config.scratch + ',dst=/scratch',
    'type=bind,src=' + join(f.deploy, 'runtime/passwd') + ',dst=/etc/passwd,readonly',
  ]) assert.ok(command.includes(mount), mount);
  assert.equal(command[command.indexOf('--user') + 1], process.getuid() + ':' + process.getgid());
  assert.ok(command.includes('REVERIE_CASES_PATH=/reverie_workspace/cases'));
  assert.ok(!command.some(value => /dst=\/workspace(?:,|$)|reverie-control/.test(value)));
  assert.ok(f.calls().find(([tool, args]) => tool === 'nix' && args.includes('path:' + resolve(import.meta.dirname, '..') + '#dockerImage')));
});
test('edited JSON is preserved and explicit source and update access are opt in', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  config.port = 3456; config.containerName = 'work-agents'; config.memoryMiB = 3072;
  const original = JSON.stringify(config, null, 2) + '\n'; writeFileSync(file, original);
  const source = join(f.root, 'chosen-project'); mkdirSync(source);
  const result = f.run(['--source', source, '--allow-updates']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), original);
  const command = f.calls().filter(([tool, a]) => tool === 'docker' && a[0] === 'run').at(-1)[1];
  assert.ok(command.includes('type=bind,src=' + source + ',dst=/workspace'));
  assert.ok(command.includes('type=bind,src=' + join(f.deploy, 'runtime/control') + ',dst=/run/reverie-control'));
  assert.ok(command.includes('3072m')); assert.ok(command.includes('127.0.0.1:3456:3000'));
});
test('an existing matching deployment is reused without builds; mismatch is refused without replacement', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const run = f.calls().find(([tool, a]) => tool === 'docker' && a[0] === 'run')[1];
  const signature = run[run.indexOf('--label') + 1].split('=')[1];
  const before = f.calls().length;
  const matching = { Config: { Labels: { 'reverie.deployment': signature } }, State: { Running: true } };
  assert.equal(f.run([], { INSPECT: JSON.stringify(matching) }).status, 0);
  assert.equal(f.calls().length, before + 1);
  const result = f.run([], { INSPECT: JSON.stringify({ Config: {}, State: { Running: true } }) });
  assert.equal(result.status, 1); assert.match(result.stderr, /nothing was replaced/);
  assert.ok(!f.calls().some(([, args]) => ['rm', 'stop'].includes(args[0])));
});
test('unknown config fields and mount syntax are rejected as data before build or creation', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  config.arbitraryFlags = '--privileged'; writeFileSync(file, JSON.stringify(config));
  let before = f.calls().length, result = f.run();
  assert.equal(result.status, 1); assert.equal(f.calls().length, before);
  delete config.arbitraryFlags; config.workspace = '/somewhere,readonly'; writeFileSync(file, JSON.stringify(config));
  before = f.calls().length; result = f.run();
  assert.equal(result.status, 1); assert.equal(f.calls().length, before);
});
