/** Real tmux IPC in the startup fixture's private PID/network/root namespace.
 * No Engine, employee, provider or personal configuration is available here. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmuxSourceCommands } from '../../src/tmux-source-command.js';
import { shellescape } from '../../src/docker-hosts.js';
import {
  DOCKER_PROVIDER_VIEW_ENV,
  DOCKER_PROVIDER_VIEW_PROGRAM,
} from '../../src/docker-employee-provider-view-native.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function exerciseNativeTmux(directory: string): Promise<void> {
  assert.equal(process.env.REVERIE_TEST_BOXED_STARTUP, '1');
  assert.equal(process.getuid?.(), 0);
  assert.equal(process.cwd(), '/source');
  const root = mkdtempSync(join(directory, 'tmux-native-'));
  const writer = join(root, 'argv.cjs');
  // A completed receipt is renamed only after close. Reading a partially written
  // file must never be confused with a failed native dispatch.
  writeFileSync(
    writer,
    `const fs = require('node:fs');
const [file, ...args] = process.argv.slice(2);
const frame = JSON.stringify(args.map(value => Buffer.from(value).toString('hex')));
fs.appendFileSync(file + '.executions', frame + String.fromCharCode(10), { mode: 0o600 });
fs.writeFileSync(file + '.writing', frame, { flag: 'wx', mode: 0o600 });
fs.renameSync(file + '.writing', file);
setInterval(() => {}, 1000);
`,
    { flag: 'wx', mode: 0o600 }
  );
  const sockets = ['cold', 'warm'].map((name) => join(root, name));
  const providerSocket = '/tmp/tmux-' + process.getuid() + '/reverie-docker';
  sockets.push(providerSocket);
  const closed = new Set<string>();
  const environment = { PATH: process.env.PATH, HOME: root, TMPDIR: root, SHELL: '/bin/bash', LANG: 'C.UTF-8' };
  const run = (socket: string, args: string[], input?: string) =>
    spawnSync('tmux', ['-u', '-f', '/dev/null', '-S', socket, ...args], {
      encoding: 'utf8',
      env: environment,
      input,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  const success = (result: ReturnType<typeof run>) => {
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'The actual tmux command must complete successfully');
  };
  const receipt = async (file: string, args: string[]) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(file) && Date.now() < deadline) await pause(10);
    assert(existsSync(file), 'The actual child must finish its receipt');
    assert.deepEqual(
      JSON.parse(readFileSync(file, 'utf8')),
      args.map((value) => Buffer.from(value).toString('hex'))
    );
    assert.equal(
      readFileSync(file + '.executions', 'utf8')
        .trim()
        .split('\n').length,
      1,
      'Exactly one child ran'
    );
  };
  const literals = [
    '',
    'quote\'"',
    '\\',
    '$HOME',
    '#{session_name}',
    '%if 1',
    '{x};',
    'line\nnext',
    '\t\r',
    'Ada 🦆 日本語',
  ];
  let failure: unknown;
  try {
    const large = 'x'.repeat(40 * 1024);
    const canonical = (file: string, args: string[]) =>
      [process.execPath, writer, file, ...args].map(shellescape).join(' ');
    const cold = sockets[0]!;
    const coldReceipt = join(root, 'cold.json');
    assert(!existsSync(cold), 'Cold startup must have no previous server socket');
    const coldSource = tmuxSourceCommands([
      ['new-session', '-d', '-s', 'native', '-c', root, canonical(coldReceipt, [large, ...literals])],
      ['set', '-t', 'native', 'status', 'off'],
    ]);
    // Exercise the same printf/shell-quoted stdin framing as the inner worker.
    // Only the final interactive attach is outside this parser/IPC check.
    const coldCommand = `printf %s ${shellescape(coldSource)} | tmux -u -f /dev/null -S ${shellescape(cold)} start-server ${shellescape(';')} source-file -`;
    success(
      spawnSync('/bin/bash', ['-lc', coldCommand], {
        encoding: 'utf8',
        env: environment,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    );
    await receipt(coldReceipt, [large, ...literals]);

    const warm = sockets[1]!;
    const inertReceipt = join(root, 'inert.json');
    success(
      run(warm, ['new-session', '-d', '-s', 'native', '-c', root, process.execPath, writer, inertReceipt, 'inert'])
    );
    await receipt(inertReceipt, ['inert']);
    const refusedReceipt = join(root, 'refused.json');
    const old = run(warm, ['respawn-pane', '-k', '-t', 'native', 'bash', '-c', canonical(refusedReceipt, [large])]);
    assert.ifError(old.error);
    assert.equal(old.signal, null);
    assert.equal(old.status, 1, 'The old IPC path must reproduce the pinned tmux size refusal');
    assert.match(old.stderr, /command too long/);
    assert(
      !existsSync(refusedReceipt) && !existsSync(refusedReceipt + '.executions'),
      'Refused IPC must not launch a child'
    );
    const largeReceipt = join(root, 'large.json');
    success(
      run(
        warm,
        ['source-file', '-'],
        tmuxSourceCommands([
          ['respawn-pane', '-k', '-t', 'native', 'bash', '-c', canonical(largeReceipt, [large, ...literals])],
        ])
      )
    );
    await receipt(largeReceipt, [large, ...literals]);
    assert(!existsSync(refusedReceipt + '.executions'), 'The refused attempt must remain unissued');
    const sid = 'd0000000-0000-4000-8000-000000000001';
    const operation = 'e0000000-0000-4000-8000-000000000002';
    const generation = 'native-observed-generation:1';
    const target = 'reverie-dkr-' + sid;
    const providerReceipt = join(root, 'provider.json');
    mkdirSync(dirname(providerSocket), { recursive: true, mode: 0o700 });
    success(
      run(
        providerSocket,
        ['start-server', ';', 'source-file', '-'],
        tmuxSourceCommands([
          ['set-environment', '-g', 'REVERIE_HOOK_GENERATION', generation],
          ['new-session', '-d', '-s', target, '-c', root, canonical(providerReceipt, ['provider'])],
          ['set-environment', '-t', target, 'REVERIE_SESSION_ID', sid],
          ['set-environment', '-t', target, 'REVERIE_DOCKER_OPERATION_ID', operation],
        ])
      )
    );
    await receipt(providerReceipt, ['provider']);
    const nativeEnvironment = { ...environment } as NodeJS.ProcessEnv;
    for (let index = 0; index < DOCKER_PROVIDER_VIEW_ENV.length; index += 2) {
      assert.equal(DOCKER_PROVIDER_VIEW_ENV[index], '--env');
      const setting = DOCKER_PROVIDER_VIEW_ENV[index + 1]!;
      nativeEnvironment[setting.slice(0, setting.indexOf('='))] = setting.slice(setting.indexOf('=') + 1);
    }
    const probe = (...args: string[]) =>
      spawnSync(process.execPath, ['--input-type=commonjs', '-e', DOCKER_PROVIDER_VIEW_PROGRAM, '--', ...args], {
        encoding: 'utf8',
        env: nativeEnvironment,
        timeout: 5000,
        maxBuffer: 65536,
      });
    const inspected = probe('observe', sid, operation, 'generation');
    success(inspected);
    const observed = JSON.parse(inspected.stdout) as {
      paneId: string;
      panePid: number;
      paneStartTicks: string;
      hooks: { kind: 'generation'; generation: string };
    };
    assert.deepEqual(observed.hooks, { kind: 'generation', generation });
    const present = probe('presence', sid, operation, 'generation');
    success(present);
    assert.deepEqual(JSON.parse(present.stdout), observed);
    const absent = probe('presence', 'a0000000-0000-4000-8000-000000000004', operation, 'generation');
    success(absent);
    assert.equal(absent.stdout, 'ABSENT\n');
    assert.equal(
      observed.paneStartTicks,
      readFileSync('/proc/' + observed.panePid + '/stat', 'utf8')
        .split(') ')
        .at(-1)!
        .trim()
        .split(/\s+/)[19]
    );
    assert.equal(
      probe('observe', sid, 'f0000000-0000-4000-8000-000000000003', 'generation').status,
      1,
      'Wrong operation must be refused'
    );
    assert.equal(
      probe(
        'attach',
        sid,
        operation,
        'generation',
        observed.paneId,
        String(observed.panePid + 1),
        observed.paneStartTicks,
        generation
      ).status,
      1,
      'A changed PID must not attach'
    );
    // A stock NONE provider has no hook generation. Its existing channel still
    // requires SID/op/pane/PID birth, while always-hook modes remain refused.
    success(run(providerSocket, ['set-environment', '-gu', 'REVERIE_HOOK_GENERATION']));
    assert.equal(
      probe('observe', sid, operation, 'generation').status,
      1,
      'Generation mode must refuse absent hook evidence'
    );
    const noHooks = probe('observe', sid, operation, 'none');
    success(noHooks);
    const none = JSON.parse(noHooks.stdout) as {
      paneId: string;
      panePid: number;
      paneStartTicks: string;
      hooks: { kind: string };
    };
    assert.deepEqual(none.hooks, { kind: 'none' });
    assert.equal(none.panePid, observed.panePid);
    assert.equal(none.paneStartTicks, observed.paneStartTicks);
    assert.equal(probe('observe', sid, 'f0000000-0000-4000-8000-000000000003', 'none').status, 1);
    assert.equal(
      probe('attach', sid, operation, 'none', none.paneId, String(none.panePid + 1), none.paneStartTicks, '').status,
      1
    );
    const { spawn: spawnPty } = await import('node-pty');
    const viewer = spawnPty(
      process.execPath,
      [
        '--input-type=commonjs',
        '-e',
        DOCKER_PROVIDER_VIEW_PROGRAM,
        '--',
        'attach',
        sid,
        operation,
        'none',
        none.paneId,
        String(none.panePid),
        none.paneStartTicks,
        '',
      ],
      { env: nativeEnvironment, cwd: root, cols: 80, rows: 24 }
    );
    let viewerExited = false;
    const viewerExit = new Promise<{ exitCode: number }>((resolve) =>
      viewer.onExit((event) => {
        viewerExited = true;
        resolve(event);
      })
    );
    try {
      let client: string | undefined;
      const deadline = Date.now() + 5000;
      while (!client && Date.now() < deadline) {
        const clients = run(providerSocket, ['list-clients', '-F', '#{client_pid} #{client_name}']);
        assert.ifError(clients.error);
        client = clients.stdout
          .split('\n')
          .find((line) => {
            const pid = Number(line.split(' ')[0]);
            if (!Number.isSafeInteger(pid) || pid <= 0) return false;
            try {
              const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
              return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === viewer.pid;
            } catch {
              return false;
            }
          })
          ?.split(' ')[1];
        if (!client) await pause(10);
      }
      assert(client, 'The actual NONE viewer must attach before timeout');
      success(run(providerSocket, ['detach-client', '-t', client]));
      const result = await Promise.race([
        viewerExit,
        pause(5000).then(() => {
          throw Error('Owned native viewer did not exit');
        }),
      ]);
      assert.equal(result.exitCode, 0);
      const after = probe('observe', sid, operation, 'none');
      success(after);
      assert.deepEqual(JSON.parse(after.stdout), none, 'Attaching/detaching must keep the original provider PID birth');
    } finally {
      if (!viewerExited) {
        viewer.kill('SIGKILL');
        await viewerExit;
      }
    }
    await receipt(providerReceipt, ['provider']);
    success(run(providerSocket, ['kill-server']));
    closed.add(providerSocket);
    assert.equal(probe('observe', sid, operation, 'generation').status, 1, 'Missing provider must not create a server');
    console.log(
      JSON.stringify({
        nativeTmux: true,
        cold: true,
        literalArguments: literals.length,
        largeBytes: large.length,
        oldRefusedWithoutChild: true,
        streamedExecutions: 1,
        providerViewNative: true,
      })
    );
  } catch (cause) {
    failure = cause;
  }
  const closes: unknown[] = [];
  for (const socket of sockets) {
    if (closed.has(socket) || !existsSync(socket)) continue;
    try {
      success(run(socket, ['kill-server']));
      const stopped = run(socket, ['list-sessions']);
      assert.ifError(stopped.error);
      assert.equal(stopped.status, 1, 'The private server must be stopped');
    } catch (cause) {
      closes.push(cause);
    }
  }
  if (failure !== undefined || closes.length)
    throw new AggregateError([...(failure === undefined ? [] : [failure]), ...closes], 'Native tmux fixture failed');
}
