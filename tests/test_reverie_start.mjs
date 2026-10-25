import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dirname, '../scripts/reverie-start');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reverie-start-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls');
  mkdirSync(bin); mkdirSync(home);
  for (const name of ['docker', 'nix']) {
    const file = join(bin, name);
    writeFileSync(file, '#!' + process.execPath + '\n' +
      "const fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(process.env.CALLS,JSON.stringify([process.env.TOOL,a])+'\\n');" +
      (name === 'nix' ? "console.log('/nix/store/example-image.tar');" :
        "if(a[0]==='inspect'){if(process.env.INSPECT){console.log(process.env.INSPECT)}else if(a.includes('--type'))process.exit(1);else console.log(JSON.stringify({Id:'existing-image',Config:{}}))}"));
    // Each stub embeds its own tool identity without invoking a shell.
    writeFileSync(file, readFileSync(file, 'utf8').replace('process.env.TOOL', JSON.stringify(name)));
    chmodSync(file, 0o755);
  }
  const deploy = join(home, 'reverie');
  const run = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, REVERIE_ROOT: '', PATH: bin + ':' + process.env.PATH, CALLS: log, ...env },
  });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, home, deploy, run, calls };
}
test('first start with an existing image contains company state, workspace and scratch without source or control access', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(join(f.deploy, 'deployment.json'), 'utf8'));
  assert.equal(config.companyRoot, join(f.deploy, 'companies/default'));
  assert.equal(config.scratch, join(f.deploy, 'scratch/agents'));
  assert.ok(lstatSync(join(f.deploy, 'scratch')).isDirectory());
  const command = f.calls().find(([tool, args]) => tool === 'docker' && args[0] === 'run')[1];
  assert.ok(command.includes('--init'));
  for (const mount of [
    'type=bind,src=' + join(config.companyRoot, 'data') + ',dst=/instances/default',
    'type=bind,src=' + join(config.companyRoot, 'home') + ',dst=/home/agent',
    'type=bind,src=' + config.workspace + ',dst=/reverie_workspace',
    'type=bind,src=' + config.scratch + ',dst=/scratch',
    'type=bind,src=' + join(f.deploy, 'runtime/passwd') + ',dst=/etc/passwd,readonly',
  ]) assert.ok(command.includes(mount), mount);
  assert.equal(command[command.indexOf('--user') + 1], process.getuid() + ':' + process.getgid());
  assert.ok(command.includes('REVERIE_CASES_PATH=/reverie_workspace/cases'));
  assert.equal(command[command.indexOf('--workdir') + 1], '/reverie_workspace');
  assert.ok(!command.some(value => /dst=\/workspace(?:,|$)|reverie-control/.test(value)));
  const nix = f.calls().find(([tool]) => tool === 'nix')[1];
  assert.deepEqual(nix, ['build', realpathSync(resolve(import.meta.dirname, '..')) + '#dockerImage', '--no-link', '--print-out-paths']);
  assert.ok(!nix.some(value => value.startsWith('path:')));
});
test('project access requires an explicit grant and links only the selected checkout into the workspace', t => {
  const f = fixture(t), repo = join(f.root, 'chosen-repo'); mkdirSync(repo);
  const result = f.run(['--project', 'reverie=' + repo]);
  assert.equal(result.status, 0, result.stderr);
  const command = f.calls().find(([tool, args]) => tool === 'docker' && args[0] === 'run')[1];
  assert.ok(command.includes('type=bind,src=' + repo + ',dst=/projects/reverie'));
  const link = join(f.deploy, 'workspace/reverie');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), '/projects/reverie');
  assert.ok(!command.some(value => /dst=\/workspace(?:,|$)/.test(value)));
});
test('project grants reject traversal, duplicates and existing workspace files before creating containers', t => {
  for (const args of [['--project', '../bad=/'], ['--project', 'same=/', '--project', 'same=/']]) {
    const f = fixture(t), result = f.run(args);
    assert.equal(result.status, 1); assert.equal(f.calls().length, 0);
  }
  const f = fixture(t); mkdirSync(join(f.deploy, 'workspace'), { recursive: true });
  const file = join(f.deploy, 'workspace/reverie'); writeFileSync(file, 'owner data');
  const result = f.run(['--project', 'reverie=' + f.root]);
  assert.equal(result.status, 1); assert.match(result.stderr, /different contents/);
  assert.equal(readFileSync(file, 'utf8'), 'owner data'); assert.equal(f.calls().length, 0);
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

test('only a validated durable boolean enables Admin Harness phone wake', t => {
  for (const selection of [undefined, false, true]) {
    const f = fixture(t);
    assert.equal(f.run([], { REVERIE_ADMIN_PHONE_WAKE: 'enabled' }).status, 0);
    const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
    assert.equal(config.adminPhoneWake, false);
    if (selection === undefined) delete config.adminPhoneWake;
    else config.adminPhoneWake = selection;
    writeFileSync(file, JSON.stringify(config));
    const result = f.run([], { REVERIE_ADMIN_PHONE_WAKE: 'enabled' });
    assert.equal(result.status, 0, result.stderr);
    const command = f.calls().filter(([tool, a]) => tool === 'docker' && a[0] === 'run').at(-1)[1];
    assert.deepEqual(command.filter(value => value.startsWith('REVERIE_ADMIN_PHONE_WAKE=')),
      selection === true ? ['REVERIE_ADMIN_PHONE_WAKE=enabled'] : []);
  }
});
test('phone startup setting rejects string, number, null, object and unknown-field bypasses before engine calls', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  for (const value of ['enabled', 'true', 1, null, {}, []]) {
    config.adminPhoneWake = value; writeFileSync(file, JSON.stringify(config));
    const before = f.calls().length, result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /must be a boolean/);
    assert.equal(f.calls().length, before);
  }
  delete config.adminPhoneWake; config.REVERIE_ADMIN_PHONE_WAKE = 'enabled';
  writeFileSync(file, JSON.stringify(config));
  const before = f.calls().length;
  assert.equal(f.run().status, 1); assert.equal(f.calls().length, before);
});
test('changing the selected phone setting refuses reuse of an existing console without replacing it', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const command = f.calls().find(([tool, a]) => tool === 'docker' && a[0] === 'run')[1];
  const signature = command[command.indexOf('--label') + 1].split('=')[1];
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  config.adminPhoneWake = true; writeFileSync(file, JSON.stringify(config));
  const result = f.run([], { INSPECT: JSON.stringify({ Config: { Labels: { 'reverie.deployment': signature } }, State: { Running: true } }) });
  assert.equal(result.status, 1); assert.match(result.stderr, /nothing was replaced/);
  assert.ok(!f.calls().some(([, args]) => ['rm', 'stop'].includes(args[0])));
});

test('the optional false phone default keeps the existing deployment digest compatible', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const first = f.calls().find(([tool, a]) => tool === 'docker' && a[0] === 'run')[1];
  const signature = first[first.indexOf('--label') + 1].split('=')[1];
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  delete config.adminPhoneWake; writeFileSync(file, JSON.stringify(config));
  const matching = { Config: { Labels: { 'reverie.deployment': signature } }, State: { Running: true } };
  const before = f.calls().length;
  const result = f.run([], { INSPECT: JSON.stringify(matching) });
  assert.equal(result.status, 0, result.stderr); assert.equal(f.calls().length, before + 1);
});

test('matching deployment labels cannot hide an activated phone override', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const command = f.calls().find(([tool, a]) => tool === 'docker' && a[0] === 'run')[1];
  const signature = command[command.indexOf('--label') + 1].split('=')[1];
  const matching = { Config: { Labels: { 'reverie.deployment': signature }, Env: ['REVERIE_ADMIN_PHONE_WAKE=enabled'] }, State: { Running: false } };
  const before = f.calls().length;
  const result = f.run([], { INSPECT: JSON.stringify(matching) });
  assert.equal(result.status, 1); assert.match(result.stderr, /phone startup setting differs/);
  assert.equal(f.calls().length, before + 1);
});
