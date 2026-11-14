#!/opt/reverie-worker-client/bin/node
/** Disposable provider fixture. Actual bound capsule/Console probes, no model or Engine. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setInterval } from 'node:timers';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('2.1.251 (Claude Code; synthetic boxed fixture)\n');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Synthetic boxed provider: --resume <thread>, --version\n');
  process.exit(0);
}
const entry = '/opt/reverie-worker-client/bin/reverie';
import { loadCanaryFixtureContract } from './boxed-canary-fixture-contract.mjs';
const contractFile = '/home/agent/.fixture/boxed-canary-contract.json';
const fixture = loadCanaryFixtureContract(fs.existsSync(contractFile) ? contractFile : undefined);
const sid = fixture.sessionId;
const thread = fixture.providerThread;
const currentHome = fs.lstatSync('/home/agent', { bigint: true });
if (
  !currentHome.isDirectory() ||
  currentHome.uid !== BigInt(fixture.home.uid) ||
  currentHome.gid !== BigInt(fixture.home.gid) ||
  (currentHome.mode & 0o777n) !== 0o700n ||
  String(currentHome.dev) !== fixture.home.dev ||
  String(currentHome.ino) !== fixture.home.ino
)
  throw Error('Actual synthetic HOME differs');
const digest = (value) => createHash('sha256').update(value).digest('hex');
if (process.env.HOME !== '/home/agent' || process.env.REVERIE_SESSION_ID !== sid)
  throw Error('Synthetic boxed identity required');
const marker = path.join(process.env.HOME, 'boxed-canary-provider-start.json');
const fd = fs.openSync(
  marker,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
  0o600
);
const report = {
  version: 2,
  purpose: 'synthetic-boxed-provider-probes-v2',
  pid: process.pid,
  sessionId: sid,
  startedAt: new Date().toISOString(),
  argvSha256: digest(JSON.stringify(args)),
  probes: [],
  completed: false,
  limitation: 'Fake external provider; callback ACKs prove transport only, never provider or native readiness.',
};
function checkpoint() {
  const bytes = Buffer.from(JSON.stringify(report) + '\n');
  fs.writeSync(fd, bytes, 0, bytes.length, 0);
  fs.ftruncateSync(fd, bytes.length);
  fs.fsyncSync(fd);
}
function oneValue(flag) {
  const matches = args.flatMap((value, index) => (value === flag ? [index] : []));
  if (matches.length !== 1 || typeof args[matches[0] + 1] !== 'string') throw Error('Canonical fixture launch refused');
  return args[matches[0] + 1];
}
function probe(command, expected, input) {
  if (command !== expected) throw Error('Generated capsule command differs');
  const words = command.split(' ');
  const result = spawnSync(words[0], words.slice(1), {
    input,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  const receipt = {
    command: expected,
    at: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    stdoutSha256: digest(result.stdout ?? ''),
    stderrSha256: digest(result.stderr ?? ''),
  };
  report.probes.push(receipt);
  checkpoint();
  if (result.error || result.status !== 0 || result.signal) throw Error('Actual capsule probe failed');
  return result.stdout;
}
function runProbes() {
  const actualThread = oneValue('--resume');
  if (actualThread !== thread) throw Error('Original synthetic provider thread differs');
  const rawSettings = oneValue('--settings');
  const settings = JSON.parse(rawSettings);
  report.resumeThread = actualThread;
  report.settingsSha256 = digest(rawSettings);
  const generation = process.env.REVERIE_HOOK_GENERATION;
  if (!generation || !/^[A-Za-z0-9_.:-]{1,256}$/.test(generation)) throw Error('Actual current hook generation absent');
  report.hookGenerationSha256 = digest(generation);
  checkpoint();
  const capabilities = JSON.parse(probe(entry + ' agent capabilities --json', entry + ' agent capabilities --json'));
  if (capabilities.identity?.kind !== 'agent' || capabilities.identity.sessionId !== sid)
    throw Error('Actual authenticated capsule identity differs');
  report.capabilityIdentity = { kind: capabilities.identity.kind, sessionId: capabilities.identity.sessionId };
  const policyCommand = entry + ' agent docker-policy ' + fixture.employeeId + ' --json';
  const selection = JSON.parse(probe(policyCommand, policyCommand));
  if (
    selection.sessionId !== sid ||
    selection.sessionGeneration !== fixture.generation ||
    selection.operationId !== fixture.operationId ||
    !selection.operation ||
    typeof selection.operation.phase !== 'string' ||
    typeof selection.operation.state !== 'string'
  )
    throw Error('Actual scoped operation read differs');
  report.operationRead = {
    sessionId: selection.sessionId,
    sessionGeneration: selection.sessionGeneration,
    phase: selection.operation.phase,
    state: selection.operation.state,
    observedBeforeReady: selection.operation.phase !== 'ready' && selection.operation.state !== 'ready',
    limitation:
      selection.operation.phase === 'ready' || selection.operation.state === 'ready'
        ? 'Read already observed ready; no before-Ready timing claim.'
        : 'Authenticated read of current operation phase only; not a native grant or effect dispatch.',
  };
  checkpoint();
  const hook = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
  if (hook?.type !== 'command' || settings.statusLine?.type !== 'command')
    throw Error('Actual generated callback settings absent');
  const hookOutput = probe(
    hook.command,
    entry + ' worker-callback hook-event --event prompt_submitted',
    JSON.stringify({ session_id: thread, source: 'synthetic-boxed-provider-canary' })
  );
  if (hookOutput !== '') throw Error('Hook output unexpectedly nonempty');
  report.hookTransportAcknowledged = true;
  const status = probe(
    settings.statusLine.command,
    entry + ' worker-callback status-telemetry',
    JSON.stringify({
      model: { display_name: 'Synthetic canary' },
      context_window: { used_percentage: 7, total_input_tokens: 1200, total_output_tokens: 12 },
    })
  );
  if (status !== 'Synthetic canary  in:1,200 out:12  ctx:7%\n') throw Error('Actual status callback text differs');
  report.statusTransportAcknowledged = true;
  report.statusText = status.trimEnd();
  report.completed = true;
  report.completedAt = new Date().toISOString();
  checkpoint();
}
let failed = false;
try {
  checkpoint();
  runProbes();
} catch {
  failed = true;
  report.failed = true;
  report.failedAt = new Date().toISOString();
  checkpoint();
} finally {
  fs.closeSync(fd);
}
if (failed) {
  process.stderr.write('Synthetic boxed provider probe failed; no retry.\n');
  process.exit(1);
}
function inputWitness(challenge) {
  const receiptPath = path.join(process.env.HOME, 'boxed-canary-provider-input.json');
  const receipt = {
    version: 1,
    purpose: 'synthetic-boxed-provider-input-v1',
    sessionId: sid,
    providerThread: thread,
    pid: process.pid,
    challenge,
    receivedAt: new Date().toISOString(),
    limitation: 'Actual synthetic provider stdin witness only; no shell, model or HTTP action.',
  };
  const file = fs.openSync(
    receiptPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.writeFileSync(file, JSON.stringify(receipt) + '\n');
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  const home = fs.openSync(
    process.env.HOME,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    fs.fsyncSync(home);
  } finally {
    fs.closeSync(home);
  }
  process.stdout.write('BOXED_CANARY_ACK_' + challenge.slice('BOXED_CANARY_INPUT_'.length) + '\n');
}
function listenForInputWitness() {
  let line = '',
    dropping = false,
    attempted = false;
  const accepted = /^BOXED_CANARY_INPUT_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (attempted) return;
    if (chunk.length > 4096) {
      line = '';
      dropping = true;
      return;
    }
    for (const character of chunk) {
      if (character === '\r' || character === '\n') {
        const candidate = line;
        line = '';
        if (dropping) {
          dropping = false;
          continue;
        }
        if (!accepted.test(candidate)) continue;
        attempted = true;
        try {
          inputWitness(candidate);
        } catch {
          process.stderr.write('Synthetic input witness unconfirmed; no retry.\n');
        }
        return;
      }
      if (dropping) continue;
      if (character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126 || line.length >= 128) {
        line = '';
        dropping = true;
      } else line += character;
    }
  });
}
listenForInputWitness();
process.stdout.write('Synthetic boxed provider; no model request.\n> ');
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 60_000);
