/** Runs one owned fixture under reverie-workspaces. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = import.meta.dirname;
const workspace = realpathSync(process.argv[2]!);
const evidence = realpathSync(process.argv[3]!);
const tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
const brokerExecutable = realpathSync(process.env.NIX_TEST_VIEWER_FIXTURE!);
const workerExecutable = realpathSync(process.env.NIX_TEST_GOAL_WORKER_EXEC!);
const provider = join(dir, 'native-worker-viewer-provider.ts');
const acceptance = join(dir, 'native-worker-viewer-program.ts');
const tsx = resolve(dir, '../../node_modules/tsx/dist/cli.mjs');
const socket = join(workspace, 'inner.sock');
const outer = 'v' + process.pid;

for (const name of ['home', 'data', 'runtime', 'bin', 'control', 'work']) {
  mkdirSync(join(workspace, name), { mode: 0o700 });
}
symlinkSync(workerExecutable, join(workspace, 'bin/reverie-worker-exec'));

const inherited = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'NIX_LD_LIBRARY_PATH', 'NIX_LD'].map((name) => [
    name,
    process.env[name],
  ])
);
const env = {
  ...inherited,
  PATH: join(workspace, 'bin') + ':' + (process.env.PATH ?? ''),
  HOME: join(workspace, 'home'),
  TMPDIR: workspace,
  TMUX_TMPDIR: join(workspace, 'runtime'),
  TERM: 'xterm-256color',
  REVERIE_DATA_DIR: join(workspace, 'data'),
  REVERIE_INSTANCE: 'owned-viewer-fixture',
  REVERIE_TMUX_SOCKET: outer,
  REVERIE_WORKER_SOCKET: join(workspace, 'control/broker.sock'),
  FIXTURE_ROOT: workspace,
  FIXTURE_SID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  FIXTURE_TMUX: tmux,
  FIXTURE_WORKER_EXEC: workerExecutable,
  FIXTURE_VIEWER_TEST_BIN: brokerExecutable,
  FIXTURE_RESULT: join(evidence, 'result.json'),
};

function runTmux(args: string[]): string {
  return execFileSync(tmux, args, { env, encoding: 'utf8', timeout: 5000 }).trim();
}

function start(program: string, args: string[], log: string): ChildProcess {
  const output = openSync(join(evidence, log), 'w', 0o600);
  try {
    return spawn(program, args, { cwd: workspace, env, stdio: ['pipe', output, output] });
  } finally {
    closeSync(output);
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return once(child, 'exit').then(([code]) => code as number | null);
}

async function bounded<T>(task: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      task,
      sleep(milliseconds, undefined, { signal: abort.signal }).then(() => {
        throw Error(label);
      }),
    ]);
  } finally {
    abort.abort();
  }
}

type Birth = { pid: number; start: string };
function processState(pid: number): { state: string; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state, ...fields] = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/);
    return { state, start: fields[18]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function birth(raw: string): Birth {
  const pid = Number(raw);
  assert(Number.isSafeInteger(pid) && pid > 1);
  const current = processState(pid);
  assert(current && current.start);
  return { pid, start: current.start };
}

function remains(original: Birth): boolean {
  const current = processState(original.pid);
  return current?.start === original.start && current.state !== 'Z' && current.state !== 'X';
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = performance.now() + 5000;
  while (!predicate()) {
    assert(performance.now() < end, label);
    await sleep(25);
  }
}

function killTmux(args: string[]): void {
  try {
    runTmux([...args, 'kill-server']);
  } catch {
    // The following exact PID and start-tick check owns the settlement result.
  }
}

let providerBirth: Birth | undefined;
let serverBirth: Birth | undefined;
let broker: ChildProcess | undefined;
let brokerExit: Promise<number | null> | undefined;
let web: ChildProcess | undefined;
let webExit: Promise<number | null> | undefined;
try {
  runTmux([
    '-f',
    '/dev/null',
    '-S',
    socket,
    'new-session',
    '-d',
    '-x',
    '160',
    '-y',
    '40',
    '-s',
    'office',
    process.execPath,
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    provider,
    workspace,
  ]);
  runTmux(['-S', socket, 'set-option', '-t', 'office', 'remain-on-exit', 'on']);
  providerBirth = birth(runTmux(['-S', socket, 'display-message', '-p', '-t', 'office', '#{pane_pid}']));
  serverBirth = birth(runTmux(['-S', socket, 'display-message', '-p', '-t', 'office', '#{pid}']));
  writeFileSync(
    join(workspace, 'helper-ready.json'),
    JSON.stringify({
      provider_pid: providerBirth.pid,
      provider_start_tick: providerBirth.start,
      inner_socket: socket,
    }),
    { mode: 0o600 }
  );
  broker = start(
    brokerExecutable,
    [
      '--ignored',
      '--exact',
      'worker_laptop::tests::existing_viewer::transport::web_fixture::serve_web_viewer_fixture',
      '--nocapture',
    ],
    'helper.log'
  );
  brokerExit = exited(broker);
  await Promise.race([
    brokerExit.then((code) => {
      throw Error(`Owned broker exited before readiness (${code})`);
    }),
    until(() => existsSync(join(workspace, 'broker-ready')), 'Owned broker readiness timed out'),
  ]);
  web = start(process.execPath, [tsx, acceptance], 'node.log');
  webExit = exited(web);
  assert.equal(await bounded(webExit, 70_000, 'Owned web driver timed out'), 0);
} finally {
  try {
    if (web?.exitCode === null && web.signalCode === null) {
      web.kill('SIGTERM');
      await bounded(webExit!, 3000, 'Owned web driver did not stop');
    }
    killTmux(['-L', outer]);
    broker?.stdin?.end();
    if (brokerExit) assert.equal(await bounded(brokerExit, 5000, 'Owned broker did not close'), 0);
  } finally {
    killTmux(['-S', socket]);
    if (providerBirth && serverBirth) {
      const originalProvider = providerBirth;
      const originalServer = serverBirth;
      await until(() => !remains(originalProvider) && !remains(originalServer), 'Owned tmux processes did not stop');
      writeFileSync(
        join(evidence, 'native-settlement.json'),
        JSON.stringify({ provider_and_inner_server_settled: true }) + '\n',
        { mode: 0o600 }
      );
    }
  }
}
