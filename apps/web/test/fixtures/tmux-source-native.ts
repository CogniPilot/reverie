/** Real tmux IPC in the startup fixture's private PID/network/root namespace.
 * No Engine, employee, provider or personal configuration is available here. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmuxSourceCommands } from '../../src/tmux-source-command.js';
import { shellescape } from '../../src/docker-hosts.js';

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
    console.log(
      JSON.stringify({
        nativeTmux: true,
        cold: true,
        literalArguments: literals.length,
        largeBytes: large.length,
        oldRefusedWithoutChild: true,
        streamedExecutions: 1,
      })
    );
  } catch (cause) {
    failure = cause;
  }
  const closes: unknown[] = [];
  for (const socket of sockets) {
    if (!existsSync(socket)) continue;
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
