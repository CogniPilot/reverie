/** Actual WebServer/config/key currency across listen, inside an owned root namespace.
 * No Engine socket, provider process, personal state or fabricated runtime. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exerciseNativeTmux } from './tmux-source-native.js';
import { DOCKER_PROVIDER_VIEW_TMUX } from '../../src/docker-employee-provider-view-native.js';

const selectedUrl = 'http://reverie:3000';

async function startup(): Promise<void> {
  assert.equal(process.env.REVERIE_TEST_BOXED_STARTUP, '1');
  assert.equal(process.getuid?.(), 0);
  assert.equal(process.cwd(), '/source');
  await exerciseNativeTmux('/fixture/tmp');
  const { WebServer } = await import('../../src/web/server.js');
  const server = new WebServer(0, false, true, '0.0.0.0');
  const internal = server as unknown as {
    app: { addHook(name: 'onReady', hook: () => Promise<void>): void };
    dockerEmployeeRuntime?: { current(): boolean };
  };
  let runtime: { current(): boolean } | undefined;
  internal.app.addHook('onReady', async () => {
    runtime = internal.dockerEmployeeRuntime;
    assert(runtime, 'The actual boxed runtime must be composed before listening');
    assert.equal(runtime.current(), true, 'Real configuration/key custody starts current');
  });
  try {
    await server.start();
    assert(runtime, 'The real ready hook must have run');
    assert(server.boundPort > 0, 'A real socket must be listening');
    assert.equal(process.env.REVERIE_API_URL, selectedUrl, 'Listening must preserve the selected worker API URL');
    assert.equal(runtime.current(), true, 'Listening must not revoke actual boxed configuration/key currency');
    console.log(JSON.stringify({ passed: true, boundPort: server.boundPort, selectedUrl, runtimeCurrent: true }));
  } finally {
    await server.stop();
  }
  assert.equal(runtime?.current(), false, 'Closing the server must revoke its runtime');
}

function isolated(): void {
  assert.equal(process.platform, 'linux', 'This mandatory native check requires Linux user namespaces');
  const source = resolve(import.meta.dirname, '../..');
  const modules = join(source, 'node_modules');
  const dependencies = realpathSync(modules);
  const dependencyTargets = [
    ...new Set([
      dependencies,
      ...(lstatSync(modules).isSymbolicLink() ? [resolve(dirname(modules), readlinkSync(modules))] : []),
    ]),
  ];
  const bash = realpathSync(process.env.SHELL || '/bin/bash');
  assert(bash.startsWith('/nix/store/'), 'Use the self-contained Nix development environment');
  let tmuxProgram: string | undefined;
  const toolDirectories = ['which', 'tmux'].map((command) => {
    const result = spawnSync('which', [command], { encoding: 'utf8', timeout: 1000 });
    assert.equal(result.status, 0, `Required development tool absent: ${command}`);
    const path = realpathSync(result.stdout.trim());
    assert(path.startsWith('/nix/store/'), 'Only immutable development tools enter the fixture');
    if (command === 'tmux') tmuxProgram = path;
    return dirname(path);
  });
  const base = mkdtempSync(join(tmpdir(), 'boxed-startup-'));
  const root = join(base, 'root');
  const fixture = join(base, 'fixture');
  for (const path of [
    'nix',
    'source',
    'bin',
    'fixture',
    'proc',
    'dev',
    'etc/reverie',
    'tmp',
    dirname(DOCKER_PROVIDER_VIEW_TMUX).slice(1),
    'opt/reverie-worker-tools/share/locale',
    ...dependencyTargets.map((path) => path.slice(1)),
  ])
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  for (const path of ['home', 'tmp', 'data']) mkdirSync(join(fixture, path), { recursive: true, mode: 0o700 });
  // This namespace tests the fixed native protocol with a protected copy of the
  // pinned development tool. The worker capsule's ELF closure has its own gate.
  assert(tmuxProgram);
  copyFileSync(tmuxProgram, join(root, DOCKER_PROVIDER_VIEW_TMUX));
  chmodSync(join(root, DOCKER_PROVIDER_VIEW_TMUX), 0o555);
  const archive = process.env.REVERIE_TEST_LOCALE_ARCHIVE || process.env.LOCALE_ARCHIVE;
  assert(archive, 'The Nix check must supply its immutable UTF-8 locale archive');
  const localeArchive = realpathSync(archive);
  assert(localeArchive.startsWith('/nix/store/'), 'Only the declared Nix locale archive enters this fixture');
  const copiedArchive = join(root, 'opt/reverie-worker-tools/share/locale/locale-archive');
  copyFileSync(localeArchive, copiedArchive);
  chmodSync(copiedArchive, 0o444);
  writeFileSync(
    join(root, 'etc/reverie/boxed-runtime.json'),
    JSON.stringify({
      version: 1,
      purpose: 'reverie-boxed-runtime-v1',
      deployment: 'synthetic-startup',
      workerImageId: 'sha256:' + 'a'.repeat(64),
      clientManifestDigest: 'b'.repeat(64),
      sourceImageIds: ['sha256:' + 'c'.repeat(64)],
      helperImageId: 'sha256:' + 'd'.repeat(64),
      apiUrl: selectedUrl,
    }),
    { mode: 0o444, flag: 'wx' }
  );
  const environment = {
    HOME: '/fixture/home',
    TMPDIR: '/fixture/tmp',
    PATH: [
      ...toolDirectories,
      ...(process.env.PATH || '').split(':').filter((path) => path.startsWith('/nix/store/')),
    ].join(':'),
    REVERIE_DATA_DIR: '/fixture/data',
    REVERIE_TEST_BOXED_STARTUP: '1',
    REVERIE_RUNTIME_BACKEND: 'boxed-docker-v1',
    REVERIE_API_URL: selectedUrl,
    REVERIE_ALLOWED_HOSTS: 'reverie,127.0.0.1',
    REVERIE_MULTIUSER: '0',
    REVERIE_OWNER_SETUP: '1',
    REVERIE_USERNAME: 'synthetic-startup',
    REVERIE_PASSWORD: 'Synthetic-startup-only-42!',
    DOCKER_HOST: 'unix:///fixture/no-engine.sock',
  };
  try {
    const result = spawnSync(
      'bwrap',
      [
        '--unshare-user',
        '--unshare-net',
        '--unshare-pid',
        '--die-with-parent',
        '--uid',
        '0',
        '--gid',
        '0',
        '--cap-drop',
        'ALL',
        '--clearenv',
        '--ro-bind',
        root,
        '/',
        '--ro-bind',
        '/nix',
        '/nix',
        '--bind',
        join(fixture, 'tmp'),
        '/tmp',
        '--ro-bind',
        source,
        '/source',
        ...dependencyTargets.flatMap((path) => ['--ro-bind', dependencies, path]),
        '--ro-bind',
        dirname(bash),
        '/bin',
        '--bind',
        fixture,
        '/fixture',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--chdir',
        '/source',
        ...Object.entries(environment).flatMap(([key, value]) => ['--setenv', key, value]),
        process.execPath,
        '--import',
        'tsx',
        '/source/test/fixtures/boxed-webserver-startup.ts',
        '--namespace',
      ],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    );
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'The actual startup must finish without a signal');
    assert.equal(result.status, 0, 'The actual boxed startup/currency regression failed');
  } finally {
    rmSync(base, { recursive: true });
  }
}

if (process.argv.includes('--namespace')) await startup();
else isolated();
