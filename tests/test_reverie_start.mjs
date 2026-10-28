import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, lstatSync, readlinkSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { acceptedCreateSpec, checkSourceHost } from '../scripts/owner-terminal-lifecycle.mjs';

const script = resolve(import.meta.dirname, '../scripts/reverie-start');
// Controlled compiler/engine ports; fixed helper phases still use actual
// owned files and inherited FD9/flock. This is not native image qualification.
function hTool(tool, a) {
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
  const root = process.env.H_TEST, state = path.join(root, 'h-state.json');
  const image = { Id: 'sha256:' + 'b'.repeat(64), RootFS: { Type: 'layers', Layers: [] }, Architecture: 'amd64', Os: 'linux', Created: '2026-01-01T00:00:00Z',
    Config: { Cmd: ['fixed-node'], Entrypoint: ['fixed-entry'], Env: ['BASE=one'], Labels: { 'org.reverie.website.runtime': process.env.H_PROFILE }, ExposedPorts: { '3000/tcp': {} } } };
  function helper() {
    const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), path = require('node:path');
    const a = process.argv.slice(2), configPath = a[a.indexOf('--installation') + 1], raw = fs.readFileSync(configPath), config = JSON.parse(raw);
    const phase = a.find(value => ['describe', 'settle', 'preflight-created', 'prepare-created', 'start-listener', 'await-ready'].includes(value));
    fs.appendFileSync(process.env.CALLS, JSON.stringify(['helper', phase]) + '\n');
    if (phase === 'describe') {
      const lock = config.lockPath, p = fs.statSync(path.dirname(lock), { bigint: true });
      console.log(JSON.stringify({ version: 1, purpose: 'reverie-owner-terminal-lifecycle-v1', workerEffects: false,
        installationSHA256: crypto.createHash('sha256').update(raw).digest('hex'), hasGeneration: false, enabled: true,
        lockPath: lock, lockIdentity: null, lockParentIdentity: { device: String(p.dev), inode: String(p.ino) },
        profile: { name: process.env.H_PROFILE, imageProvenance: { path: '/controlled/not-native-image' } },
        bootstrapMount: { Type: 'bind', Source: config.bootstrapRoot, Target: '/run/reverie-owner-terminal', ReadOnly: true, BindOptions: { CreateMountpoint: false } } })); return;
    }
    const held = fs.fstatSync(9), named = fs.statSync(config.lockPath);
    if (a[a.indexOf('--lock-fd') + 1] !== '9' || held.dev !== named.dev || held.ino !== named.ino) throw Error('Wrong inherited OFD');
    if (cp.spawnSync('flock', ['--exclusive', '--nonblock', config.lockPath, 'true']).status === 0) throw Error('Parent did not retain exclusive lock');
    if (process.env.H_FAIL_PHASE === phase) process.exit(7);
    if (phase === 'prepare-created' || phase === 'preflight-created') {
      const bytes = fs.readFileSync(a[a.indexOf('--spec') + 1]);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== a[a.indexOf('--spec-sha') + 1]) throw Error('Spec binding mismatch');
    }
    if (phase === 'preflight-created') {
      console.log(JSON.stringify({ version: 1, state: 'STOPPED_WEBSITE_CAPACITY_QUALIFIED', workerEffects: false,
        containerId: a[a.indexOf('--container-id') + 1], specSHA256: a[a.indexOf('--spec-sha') + 1] })); return;
    }
    console.log(JSON.stringify({ version: 1, workerEffects: false, state: phase }));
  }
  if (tool === 'nix' && /#(?:ownerTerminalLifecycle|resourceTerminalLifecycle|resourceTerminalRefresh)$/.test(a[1])) {
    const pkg = path.join(root, 'controlled-h-package'); fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'bin/reverie-owner-terminal-lifecycle'), '#!' + process.execPath + '\n(' + helper.toString() + ')();\n', { mode: 0o700 });
    fs.writeFileSync(path.join(pkg, 'bin/reverie-resource-terminal-refresh'), '#!' + process.execPath + '\nrequire("node:fs").fstatSync(9);require("node:fs").appendFileSync(process.env.CALLS,JSON.stringify(["resource-refresh",process.argv.slice(2)])+"\\n");\n', { mode: 0o700 });
    const link = a[a.indexOf('--out-link') + 1]; fs.symlinkSync(pkg, link); console.log(pkg); return true;
  }
  if (tool !== 'docker') return false;
  let item = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : null;
  if (a[0] === 'image' && a[1] === 'inspect') { console.log(JSON.stringify(image)); return true; }
  if (a[0] === 'inspect') { if (!item) process.exit(1); console.log(JSON.stringify(item)); return true; }
  if (a[0] === 'create') {
    const get = key => a[a.indexOf(key) + 1], values = key => a.flatMap((value, index) => value === key ? [a[index + 1]] : []);
    const mounts = values('--mount').map(value => {
      const fields = Object.fromEntries(value.split(',').map(item => item.includes('=') ? item.split('=') : [item, true]));
      return { Type: fields.type, Source: fields.src, Target: fields.dst, ReadOnly: fields.readonly === true };
    });
    const tmpfs = Object.fromEntries(values('--tmpfs').map(value => { const colon = value.indexOf(':'); return [value.slice(0, colon), value.slice(colon + 1)]; }));
    const environment = new Map(image.Config.Env.map(value => [value.split('=')[0], value]));
    for (const value of values('--env')) environment.set(value.split('=')[0], value);
    const cid = 'a'.repeat(64);
    item = { Id: cid, Name: '/' + get('--name'), Image: image.Id, State: { Running: false, Pid: 0 },
      Config: { ...image.Config, Hostname: cid.slice(0, 12), Domainname: '', Image: a.at(-1), User: get('--user'), WorkingDir: get('--workdir'),
        Env: [...environment.values()], Labels: { ...image.Config.Labels, ...Object.fromEntries(values('--label').map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; })) }, Tty: false, OpenStdin: false, StdinOnce: false, AttachStdin: false },
      HostConfig: { Memory: Number(get('--memory').replace(/m$/, '')) * 1048576, MemorySwap: Number(get('--memory-swap').replace(/m$/, '')) * 1048576,
        PidsLimit: Number(get('--pids-limit')), ReadonlyRootfs: true, Privileged: false, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidMode: '', IpcMode: 'private', Init: true, NetworkMode: 'default',
        PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: get('--publish').split(':')[1] }] }, Tmpfs: tmpfs, Mounts: mounts,
        LogConfig: { Type: 'json-file', Config: {} }, RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, MaskedPaths: [], ReadonlyPaths: [], ShmSize: 67108864, Runtime: 'runc', CgroupnsMode: 'private' },
      Mounts: [...mounts.map(m => ({ Type: m.Type, Source: m.Source, Destination: m.Target, RW: !m.ReadOnly })), ...Object.keys(tmpfs).map(Destination => ({ Type: 'tmpfs', Source: '', Destination, RW: true }))] };
    if (process.env.H_BAD_CREATE === 'private-root') item.HostConfig.ReadonlyRootfs = false;
    if (process.env.H_BAD_CREATE === 'device') item.HostConfig.Devices = [{ PathOnHost: '/dev/controlled-fixture' }];
    if (process.env.H_BAD_CREATE === 'new-field') item.HostConfig.FutureAuthoritySurface = true;
    fs.writeFileSync(state, JSON.stringify(item)); console.log(cid); return true;
  }
  if (a[0] === 'start') { if (a.at(-1) !== item.Id) throw Error('Start selected a name rather than exact created CID'); item.State = { Running: true, Pid: 4242 }; fs.writeFileSync(state, JSON.stringify(item)); return true; }
  if (a[0] === 'load') return true;
  throw Error('Unexpected controlled H engine operation: ' + a[0]);
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reverie-start-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls');
  mkdirSync(bin); mkdirSync(home);
  for (const name of ['docker', 'nix']) {
    const file = join(bin, name);
    writeFileSync(file, '#!' + process.execPath + '\n' +
      "const fs=require('node:fs'); let a=process.argv.slice(2); if(process.env.H_TEST&&a[0]==='--host'){if(process.env.DOCKER_CONTEXT||process.env.DOCKER_HOST)throw Error('Ambient context was retained');fs.appendFileSync(process.env.CALLS,JSON.stringify(['engine-endpoint',a[1]])+'\\n');a=a.slice(2)} fs.appendFileSync(process.env.CALLS,JSON.stringify([process.env.TOOL,a])+'\\n');" +
      `if(process.env.H_TEST&&require(process.env.H_TOOL)(${JSON.stringify(name)},a))process.exit(0);` +
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
  const enableH = profile => {
    assert.equal(run().status, 0);
    const ledger = join(root, 'h-ledger'), boot = join(root, 'h-bootstrap');
    mkdirSync(ledger, { mode: 0o700 }); mkdirSync(boot, { mode: 0o700 });
    const installation = join(root, 'h-initial.json');
    writeFileSync(installation, JSON.stringify({ ledgerBase: ledger, bootstrapRoot: boot,
      lockPath: join(deploy, 'runtime/update-state/update.lock'), workerConfig: join(root, 'worker-private.json'), engine: { socket: '/controlled/no-engine' } }), { mode: 0o600 });
    const config = JSON.parse(readFileSync(join(deploy, 'deployment.json')));
    Object.assign(config, { websiteRuntime: profile, protectedWebsite: true, ownerTerminalConfig: installation });
    writeFileSync(join(deploy, 'deployment.json'), JSON.stringify(config));
    const hook = join(root, 'h-tool.cjs'); writeFileSync(hook, 'module.exports=' + hTool.toString());
    return { H_TEST: root, H_TOOL: hook, H_PROFILE: profile };
  };
  return { root, home, deploy, run, calls, enableH };
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
test('owner website runtime selection uses only fixed images and requires protection', t => {
  for (const [runtime, attribute, image] of [
    ['default', 'dockerImage', 'reverie:latest'],
    ['resource', 'resourceActorImage', 'reverie:latest'],
    ['terminal', 'ownerTerminalImage', 'reverie-owner-terminal:latest'],
    ['resource-terminal', 'resourceTerminalImage', 'reverie-owner-terminal:latest'],
  ]) {
    const f = fixture(t); const hEnv = ['terminal', 'resource-terminal'].includes(runtime) ? f.enableH(runtime) : {};
    if (!Object.keys(hEnv).length) assert.equal(f.run().status, 0);
    const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
    config.websiteRuntime = runtime; config.protectedWebsite = true; writeFileSync(file, JSON.stringify(config));
    const result = f.run([], hEnv); assert.equal(result.status, 0, result.stderr);
    const build = f.calls().filter(([tool, args]) => tool === 'nix' && args[1].endsWith('#' + attribute)).at(-1)[1];
    assert.ok(build[1].endsWith('#' + attribute));
    const run = f.calls().filter(([tool, args]) => tool === 'docker' && args[0] === (Object.keys(hEnv).length ? 'create' : 'run')).at(-1)[1];
    assert.equal(run.at(-1), image); assert.ok(run.includes('--read-only'));
    if (runtime !== 'default') {
      delete config.protectedWebsite; writeFileSync(file, JSON.stringify(config));
      const before = f.calls().length; assert.equal(f.run().status, 1); assert.equal(f.calls().length, before);
    }
  }
});
test('website runtime rejects arbitrary attributes, inherited names and nonstrings before engine access', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  for (const value of ['__proto__', 'constructor', 'dockerImage; touch owned', '', null, false, {}, []]) {
    config.websiteRuntime = value; writeFileSync(file, JSON.stringify(config));
    const before = f.calls().length, result = f.run();
    assert.equal(result.status, 1); assert.equal(f.calls().length, before);
  }
});
test('protected H cold creation holds actual inherited OFD through prepare/listen/exact-CID start/ready', t => {
  const f = fixture(t), env = f.enableH('terminal'), result = f.run([], env);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls(), stages = calls.filter(([tool]) => tool === 'helper').map(([, phase]) => phase);
  assert.deepEqual(stages, ['describe', 'settle', 'preflight-created', 'prepare-created', 'start-listener', 'await-ready']);
  const created = calls.findIndex(([tool, args]) => tool === 'docker' && args[0] === 'create');
  const prepared = calls.findIndex(([tool, phase]) => tool === 'helper' && phase === 'prepare-created');
  const listener = calls.findIndex(([tool, phase]) => tool === 'helper' && phase === 'start-listener');
  const started = calls.findIndex(([tool, args]) => tool === 'docker' && args[0] === 'start');
  assert.ok(created < prepared && prepared < listener && listener < started);
  assert.equal(calls[started][1].at(-1), 'a'.repeat(64));
  assert.ok(calls.filter(([tool]) => tool === 'engine-endpoint').every(([, endpoint]) => endpoint === 'unix:///controlled/no-engine'));
  assert.ok(!calls.slice(created).some(([tool, args]) => tool === 'docker' && args[0] === 'run'));
});
test('H failed listener or invalid native grants retain stopped candidates and never use legacy start', t => {
  for (const mutation of ['private-root', 'device', 'new-field', 'listener']) {
    const f = fixture(t), env = f.enableH('terminal');
    const result = f.run([], { ...env, ...(mutation === 'listener' ? { H_FAIL_PHASE: 'start-listener' } : { H_BAD_CREATE: mutation }) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'h-state.json'))).State.Running, false);
    const calls = f.calls();
    assert.ok(!calls.some(([tool, args]) => tool === 'docker' && args[0] === 'start'));
    if (mutation !== 'listener') assert.ok(!calls.some(([tool, phase]) => tool === 'helper' && phase === 'prepare-created'));
  }
});
test('staged H initial selection does not alter default signatures or read a missing private installation', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const configPath = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(configPath));
  config.ownerTerminalConfig = join(f.root, 'not-installed-yet.json'); writeFileSync(configPath, JSON.stringify(config));
  assert.equal(f.run().status, 0);
  const commands = f.calls().filter(([tool, args]) => tool === 'docker' && args[0] === 'run').map(([, args]) => args);
  assert.equal(commands[0][commands[0].indexOf('--label') + 1], commands[1][commands[1].indexOf('--label') + 1]);
  assert.equal(existsSync(config.ownerTerminalConfig), false);
  assert.ok(!f.calls().some(([tool, args]) => tool === 'nix' && /Lifecycle/.test(args[1])));
});
test('dangling retained H unit cannot be treated as an absent/default installation', t => {
  const f = fixture(t), units = join(f.home, '.config/systemd/user'); mkdirSync(units, { recursive: true });
  symlinkSync(join(f.root, 'missing-private-unit-target'), join(units, 'reverie-owner-terminal.service'));
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /registered unit/);
  assert.equal(f.calls().length, 0);
});
test('full H native-spec qualifier refuses authority, malformed defaults, precision loss and changed immutable commands', t => {
  const f = fixture(t), env = f.enableH('terminal'); assert.equal(f.run([], env).status, 0);
  const base = join(f.root, 'h-ledger/standard-operations');
  const operation = join(base, readdirSync(base)[0]);
  const container = JSON.parse(readFileSync(join(operation, 'CREATED-READBACK.json')));
  const image = JSON.parse(readFileSync(join(operation, 'IMAGE-READBACK.json')));
  const intent = JSON.parse(readFileSync(join(operation, 'GENERATED-INTENT.json')));
  assert.equal(acceptedCreateSpec(container, image, intent).Image, image.Id);
  checkSourceHost(container, intent.port);
  const mutations = [
    value => { value.HostConfig.Devices = {}; },
    value => { value.HostConfig.CpuQuota = 50000; },
    value => { value.HostConfig.Memory = 2 ** 60; },
    value => { value.HostConfig.NetworkMode = 'host'; },
    value => { value.HostConfig.PortBindings['3000/tcp'][0].HostIp = '0.0.0.0'; },
    value => { value.HostConfig.Mounts[0].BindOptions = { CreateMountpoint: true }; },
    value => { value.HostConfig.Mounts[0].VolumeOptions = false; },
    value => { value.HostConfig.FutureAuthoritySurface = false; },
    value => { value.Config.Cmd = ['caller-selected-command']; },
  ];
  for (const change of mutations) {
    const copy = structuredClone(container); change(copy);
    assert.throws(() => acceptedCreateSpec(copy, image, intent));
  }
  for (const change of mutations.slice(0, 4)) {
    const copy = structuredClone(container); change(copy);
    assert.throws(() => checkSourceHost(copy, intent.port));
  }
  const reversed = structuredClone(container); reversed.Mounts.reverse(); reversed.HostConfig.Mounts.reverse();
  assert.equal(acceptedCreateSpec(reversed, image, intent).Image, image.Id);
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

test('coding evidence staging uses only the strict durable boolean and defaults on', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  for (const choice of [undefined, true, false]) {
    if (choice === undefined) delete config.ownerCodingEvidence;
    else config.ownerCodingEvidence = choice;
    writeFileSync(file, JSON.stringify(config));
    const result = f.run([], { REVERIE_OWNER_CODING_EVIDENCE: 'disabled' });
    assert.equal(result.status, 0, result.stderr);
    const command = f.calls().filter(([tool, a]) => tool === 'docker' && a[0] === 'run').at(-1)[1];
    assert.deepEqual(command.filter(v => v.startsWith('REVERIE_OWNER_CODING_EVIDENCE=')),
      ['REVERIE_OWNER_CODING_EVIDENCE=' + (choice === false ? 'disabled' : 'enabled')]);
  }
  for (const invalid of ['false', 0, null, {}, []]) {
    config.ownerCodingEvidence = invalid; writeFileSync(file, JSON.stringify(config));
    const before = f.calls().length, result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /ownerCodingEvidence must be a boolean/);
    assert.equal(f.calls().length, before);
  }
});

test('coding evidence omitted and true keep the legacy signature; false and env drift refuse reuse', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const command = f.calls().find(([tool, a]) => tool === 'docker' && a[0] === 'run')[1];
  const signature = command[command.indexOf('--label') + 1].split('=')[1];
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  const matching = { Config: { Labels: { 'reverie.deployment': signature } }, State: { Running: false } };
  config.ownerCodingEvidence = true; writeFileSync(file, JSON.stringify(config));
  assert.equal(f.run([], { INSPECT: JSON.stringify(matching) }).status, 0);
  config.ownerCodingEvidence = false; writeFileSync(file, JSON.stringify(config));
  let before = f.calls().length;
  assert.equal(f.run([], { INSPECT: JSON.stringify(matching) }).status, 1);
  assert.equal(f.calls().length, before + 1);
  config.ownerCodingEvidence = true; writeFileSync(file, JSON.stringify(config));
  matching.Config.Env = ['REVERIE_OWNER_CODING_EVIDENCE=disabled'];
  before = f.calls().length;
  const result = f.run([], { INSPECT: JSON.stringify(matching) });
  assert.equal(result.status, 1); assert.match(result.stderr, /coding evidence startup setting differs/);
  assert.equal(f.calls().length, before + 1);
});

test('protected website is strict opt-in and an explicit false preserves legacy reuse', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const first = f.calls().find(([tool, a]) => tool === 'docker' && a[0] === 'run')[1];
  assert.ok(!first.includes('--read-only')); assert.ok(!first.includes('--tmpfs'));
  const signature = first[first.indexOf('--label') + 1].split('=')[1];
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  config.protectedWebsite = false; writeFileSync(file, JSON.stringify(config));
  const prior = {Config: {Labels: {'reverie.deployment': signature}}, State: {Running: true}};
  assert.equal(f.run([], {INSPECT: JSON.stringify(prior)}).status, 0);
  for (const value of ['true', 1, null, {}, []]) {
    config.protectedWebsite = value; writeFileSync(file, JSON.stringify(config));
    const before = f.calls().length, result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /protectedWebsite must be a boolean/);
    assert.equal(f.calls().length, before);
  }
  config.protectedWebsite = true; writeFileSync(file, JSON.stringify(config));
  assert.equal(f.run([], {INSPECT: JSON.stringify(prior)}).status, 1);
  assert.ok(!f.calls().some(([, a]) => ['rm', 'stop', 'start'].includes(a[0])));
});

function protectedFixture(t) {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const file = join(f.deploy, 'deployment.json'), config = JSON.parse(readFileSync(file));
  config.protectedWebsite = true; writeFileSync(file, JSON.stringify(config));
  const result = f.run(['--allow-updates']); assert.equal(result.status, 0, result.stderr);
  const command = f.calls().filter(([tool, a]) => tool === 'docker' && a[0] === 'run').at(-1)[1];
  const signature = command[command.indexOf('--label') + 1].split('=')[1];
  const tmpfs = {};
  command.forEach((value, i) => {if (value === '--tmpfs') {
    const [path, ...rest] = command[i + 1].split(':'); tmpfs[path] = rest.join(':');
  }});
  const container = {Config: {Labels: {'reverie.deployment': signature}, Env: ['HOME=/home/agent']},
    State: {Running: false}, Mounts: [{Destination: '/instances/default'}, {Destination: '/run/reverie-control'}],
    HostConfig: {ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
      PidMode: '', IpcMode: 'private', SecurityOpt: ['no-new-privileges:true'], Tmpfs: tmpfs,
      MaskedPaths: ['/proc/kcore'], ReadonlyPaths: ['/proc/sys']}};
  return {...f, command, container};
}
test('protected website has bounded private writable temporaries and preserves selected durable binds', t => {
  const f = protectedFixture(t), a = f.command;
  assert.ok(a.includes('--read-only'));
  assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL'); assert.ok(!a.includes('--cap-add'));
  assert.equal(a[a.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.equal(a[a.indexOf('--ipc') + 1], 'private'); assert.ok(!a.includes('--pid'));
  assert.deepEqual(f.container.HostConfig.Tmpfs, {
    '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777',
    '/run': `rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=${process.getuid()},gid=${process.getgid()}`,
  });
  assert.ok(a.some(value => value.endsWith(',dst=/instances/default')));
  assert.ok(a.some(value => value.endsWith(',dst=/home/agent')));
  assert.ok(a.some(value => value.endsWith(',dst=/run/reverie-control')));
  assert.ok(!a.some(value => /dst=\/nix(?:,|\/)/.test(value)));
  const result = f.run(['--allow-updates'], {INSPECT: JSON.stringify(f.container)});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().at(-1)[1][0], 'start');
});
test('protected reuse rejects unknown or weakened actual facts despite a matching deployment label', t => {
  const f = protectedFixture(t);
  const changes = [
    c => {delete c.HostConfig;}, c => {c.HostConfig.ReadonlyRootfs = false;},
    c => {c.HostConfig.Privileged = true;}, c => {c.HostConfig.CapDrop = [];},
    c => {delete c.HostConfig.CapAdd;}, c => {c.HostConfig.CapAdd = ['SYS_ADMIN'];}, c => {c.HostConfig.PidMode = 'host';},
    c => {c.HostConfig.IpcMode = 'host';}, c => {c.HostConfig.SecurityOpt = ['seccomp=unconfined'];},
    c => {c.HostConfig.SecurityOpt.push('seccomp=unconfined');},
    c => {c.HostConfig.Tmpfs['/run'] = 'rw';}, c => {c.HostConfig.Tmpfs['/nix'] = 'rw';},
    c => {c.HostConfig.MaskedPaths.push('/nix/store');}, c => {c.HostConfig.ReadonlyPaths.push('/nix');},
    c => {c.Mounts.push({Destination: '/nix/store/hidden'});}, c => {c.Mounts.push({Destination: '/'});},
    c => {c.Config.Env.push('LD_PRELOAD=/scratch/replace.so');},
    c => {c.Config.Env.push('NODE_OPTIONS=--require=/scratch/replace.js');},
    c => {c.Config.Env.push('GCONV_PATH=/scratch/code');},
    c => {c.Config.Env.push('OPENSSL_CONF=/scratch/config');},
    c => {c.Config.Env.push('OPENSSL_MODULES=/scratch/code');},
    c => {c.Config.Env.push('LD_custom=/scratch/code');},
    c => {c.Config.Env.push('NODE_OPTIONS');},
    c => {delete c.Config.Env;},
  ];
  for (const change of changes) {
    const value = structuredClone(f.container); change(value);
    const before = f.calls().length;
    const result = f.run(['--allow-updates'], {INSPECT: JSON.stringify(value)});
    assert.equal(result.status, 1, JSON.stringify(value)); assert.match(result.stderr, /protected website settings/);
    assert.equal(f.calls().length, before + 1); // inspect only, never start/remove/replace
  }
});
