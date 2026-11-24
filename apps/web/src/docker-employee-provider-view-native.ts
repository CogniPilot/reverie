/** Fixed read/attach-only native protocol. These bytes and returned descriptors
 * are DATA; the original Engine-minted view still owns application admission. */
import { PROVIDER_EXIT_MAX_LINES } from './docker-provider-exit.js';
export type DockerProviderRuntimeNamespace = 'session-v1';
/** Placement DATA only. Callers retain their original private native authority. */
export function dockerProviderSocketLabel(
  sessionId: string,
  runtimeNamespace?: DockerProviderRuntimeNamespace
): string {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId) ||
    (runtimeNamespace !== undefined && runtimeNamespace !== 'session-v1')
  )
    throw Error('Fixed Docker provider namespace required');
  return runtimeNamespace === 'session-v1' ? 'reverie-docker-' + sessionId : 'reverie-docker';
}
export function dockerProviderRuntimeArguments(runtimeNamespace?: DockerProviderRuntimeNamespace): readonly string[] {
  if (runtimeNamespace === undefined) return [];
  if (runtimeNamespace !== 'session-v1') throw Error('Fixed Docker provider namespace required');
  return ['--runtime-namespace=session-v1'];
}
export function dockerPlanProviderSelection(
  plan: Readonly<{
    account: Readonly<{ provider: 'anthropic' | 'openai'; projectionDigest: string }>;
    runtimeNamespace?: DockerProviderRuntimeNamespace;
  }>
) {
  dockerProviderRuntimeArguments(plan.runtimeNamespace);
  return Object.freeze({
    provider: plan.account.provider,
    projectionDigest: plan.account.projectionDigest,
    ...(plan.runtimeNamespace ? { runtimeNamespace: plan.runtimeNamespace } : {}),
  });
}
export const DOCKER_PROVIDER_VIEW_ENV = Object.freeze([
  '--env',
  'TMUX=',
  '--env',
  'TMUX_TMPDIR=/tmp',
  '--env',
  'TERMINFO=/opt/reverie-worker-tools/share/terminfo',
  '--env',
  'TERMINFO_DIRS=/opt/reverie-worker-tools/share/terminfo',
  '--env',
  'LOCALE_ARCHIVE=/opt/reverie-worker-tools/share/locale/locale-archive',
  '--env',
  'GCONV_PATH=',
  '--env',
  'LOCPATH=',
  '--env',
  'GLIBC_TUNABLES=',
  '--env',
  'OPENSSL_CONF=',
  '--env',
  'OPENSSL_MODULES=',
  '--env',
  'OPENSSL_ENGINES=',
  '--env',
  'LD_ORIGIN_PATH=',
  '--env',
  'NODE_OPTIONS=',
  '--env',
  'NODE_PATH=',
  '--env',
  'LD_PRELOAD=',
  '--env',
  'LD_AUDIT=',
  '--env',
  'LD_LIBRARY_PATH=',
]);
export const DOCKER_PROVIDER_VIEW_TMUX = '/opt/reverie-worker-tools/bin/tmux';
export const DOCKER_PROVIDER_VIEW_PROGRAM = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(1);
const runtimeNamespace = argv[0] === '--runtime-namespace=session-v1' ? (argv.shift(), 'session-v1') : undefined;
const [mode, sid, operation, hookKind, pane, pidText, ticks, expectedGeneration] = argv;
const socketLabel = (${dockerProviderSocketLabel.toString()})(sid, runtimeNamespace);
const tmuxProgram = ${JSON.stringify(DOCKER_PROVIDER_VIEW_TMUX)};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function refuse() { throw Error('Existing Docker provider view unavailable'); }
if (!uuid.test(sid || '') || !uuid.test(operation || '') ||
    !['presence', 'observe', 'attach'].includes(mode) ||
    !['none', 'generation'].includes(hookKind) ||
    argv.length !== (mode === 'attach' ? 8 : 4)) refuse();
for (const path of ['/', '/opt', '/opt/reverie-worker-tools', '/opt/reverie-worker-tools/bin']) {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) refuse();
}
const tool = fs.lstatSync(tmuxProgram);
if (!tool.isFile() || tool.uid !== 0 || (tool.mode & 0o222) !== 0 || (tool.mode & 0o111) === 0) refuse();
if (fs.statfsSync('/proc').type !== 0x9fa0) refuse();
const privileges = fs.readFileSync('/proc/self/status', 'utf8');
if (!/^NoNewPrivs:\s+1$/m.test(privileges) ||
    !['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].every(key =>
      new RegExp('^' + key + ':\\s+0+$', 'm').test(privileges))) refuse();
const childEnvironment = {
  HOME: '/home/agent', PATH: '/opt/reverie-worker-client/bin:/bin',
  TERM: /^[A-Za-z0-9_.-]{1,128}$/.test(process.env.TERM || '') ? process.env.TERM : 'xterm-256color',
  TMUX_TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  TERMINFO: '/opt/reverie-worker-tools/share/terminfo',
  TERMINFO_DIRS: '/opt/reverie-worker-tools/share/terminfo',
  LOCALE_ARCHIVE: '/opt/reverie-worker-tools/share/locale/locale-archive',
};
const target = '=reverie-dkr-' + sid;
function tmux(args, optional = false, maxBuffer = 4096) {
  const result = spawnSync(tmuxProgram, ['-N', '-f', '/dev/null', '-L', socketLabel, ...args],
    { encoding: 'utf8', env: childEnvironment, timeout: 3000, killSignal: 'SIGKILL', maxBuffer });
  if (result.error || result.signal) refuse();
  if (optional && result.status === 1) return undefined;
  if (result.status !== 0) refuse();
  return result.stdout;
}
function selected() {
  const value = tmux(['display-message', '-p', '-t', target + ':', '#{pane_id} #{pane_dead} #{pane_pid}']);
  const match = /^(%[0-9]{1,10}) 0 ([1-9][0-9]{0,9})\n$/.exec(value);
  if (!match || Number(match[2]) > 2147483647) refuse();
  if (tmux(['show-environment', '-t', target, 'REVERIE_DOCKER_OPERATION_ID']) !==
      'REVERIE_DOCKER_OPERATION_ID=' + operation + '\n' ||
      tmux(['show-environment', '-t', target, 'REVERIE_SESSION_ID']) !==
      'REVERIE_SESSION_ID=' + sid + '\n') refuse();
  if (hookKind === 'none') return { paneId: match[1], panePid: Number(match[2]), hooks: { kind: 'none' } };
  const generation = tmux(['show-environment', '-t', target, 'REVERIE_HOOK_GENERATION'], true) ??
    tmux(['show-environment', '-g', 'REVERIE_HOOK_GENERATION']);
  const hook = /^REVERIE_HOOK_GENERATION=([A-Za-z0-9_.:-]{1,256})\n$/.exec(generation || '');
  if (!hook) refuse();
  return { paneId: match[1], panePid: Number(match[2]), hooks: { kind: 'generation', generation: hook[1] } };
}
if (mode === 'presence') {
  try {
    const directory = '/tmp/tmux-' + process.getuid();
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0) refuse();
    const socket = fs.lstatSync(directory + '/' + socketLabel);
    if (!socket.isSocket() || socket.uid !== process.getuid()) refuse();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    process.stdout.write('ABSENT\n');
    process.exit(0);
  }
  // A socket file outlives its server across a container replacement or host
  // restart. tmux names that exact condition; no provider can be attached to it.
  const listed = spawnSync(tmuxProgram, ['-N', '-f', '/dev/null', '-L', socketLabel, 'list-sessions', '-F', '#{session_name}'],
    { encoding: 'utf8', env: childEnvironment, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 4096 });
  if (listed.error || listed.signal) refuse();
  if (listed.status === 1 && listed.stdout === '' &&
      listed.stderr === 'no server running on /tmp/tmux-' + process.getuid() + '/' + socketLabel + '\n') {
    process.stdout.write('ABSENT\n');
    process.exit(0);
  }
  if (listed.status !== 0) refuse();
  const matches = listed.stdout.split('\n')
    .filter(value => value === 'reverie-dkr-' + sid);
  if (matches.length === 0) {
    process.stdout.write('ABSENT\n');
    process.exit(0);
  }
  if (matches.length !== 1) refuse();
  // A provider that exited non-zero inside its launch window keeps its pane for
  // a bounded time. That pane proves the exit and holds the last screen; it is
  // reported as such and is never a running provider.
  const ended = () => /^1\|([0-9]{0,3})\|([0-9]{0,3})\n$/.exec(
    tmux(['display-message', '-p', '-t', target + ':', '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}']));
  const dead = ended();
  if (dead) {
    if (tmux(['show-environment', '-t', target, 'REVERIE_DOCKER_OPERATION_ID']) !==
        'REVERIE_DOCKER_OPERATION_ID=' + operation + '\n' ||
        tmux(['show-environment', '-t', target, 'REVERIE_SESSION_ID']) !==
        'REVERIE_SESSION_ID=' + sid + '\n') refuse();
    const screen = tmux(['capture-pane', '-p', '-J', '-S', '-200', '-t', target + ':'], false, 262144);
    const again = ended();
    if (!again || again[0] !== dead[0]) refuse();
    const lines = screen.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
      .slice(-${PROVIDER_EXIT_MAX_LINES}).map(line => line.slice(0, 1024));
    process.stdout.write('EXITED ' + JSON.stringify({
      status: dead[1] === '' ? null : Number(dead[1]),
      signal: dead[2] === '' ? null : Number(dead[2]),
      lines,
    }) + '\n');
    process.exit(0);
  }
}
function birth(pid) {
  const directory = '/proc/' + pid;
  if (fs.statSync(directory).uid !== process.getuid()) refuse();
  const raw = fs.readFileSync(directory + '/stat', 'utf8');
  const end = raw.lastIndexOf(') ');
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || ['Z', 'X', 'x'].includes(fields[0]) ||
      !/^[1-9][0-9]{0,19}$/.test(fields[19] || '')) refuse();
  return fields[19];
}
const first = selected();
const start = birth(first.panePid);
const second = selected();
if (JSON.stringify(first) !== JSON.stringify(second) || start !== birth(second.panePid)) refuse();
const result = { ...first, paneStartTicks: start };
if (mode !== 'attach') process.stdout.write(JSON.stringify(result) + '\n');
else {
  if (pane !== result.paneId || pidText !== String(result.panePid) || ticks !== start || expectedGeneration !== (result.hooks.kind === 'generation' ? result.hooks.generation : '')) refuse();
  const attached = spawnSync(tmuxProgram, ['-u', '-N', '-f', '/dev/null', '-L', socketLabel, 'attach-session', '-t', target],
    { stdio: 'inherit', env: childEnvironment });
  if (attached.error || attached.signal || attached.status === null) refuse();
  process.exit(attached.status);
}
`;
