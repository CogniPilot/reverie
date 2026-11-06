// The engine CLI for the broker's real-viewer resize tests in tests/test_worker.py, run by Node.
//
// A non-attach exec runs the test's tmux (FAKE_TMUX on FAKE_TMUX_SOCKET), or reads a file as /bin/cat would. An
// attach exec runs the test's tmux client on this process's terminal, the broker's viewer PTY, and forwards SIGWINCH
// to it only once its handler is installed, FAKE_INSTALL_DELAY seconds after start. The viewer PTY is not the client's
// controlling terminal, so the client learns of a resize only through a forwarded signal; one sent before
// installation is lost, as one sent to an engine CLI that has not yet registered its handler can be.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] !== 'exec') throw new Error(`unexpected engine command ${args[0]}`);
const env: Record<string, string | undefined> = { ...process.env };
let attach = false;
let at = 1;
while (args[at]?.startsWith('-')) {
  if (args[at] === '-it') {
    attach = true;
    at += 1;
  } else if (args[at] === '--env') {
    const entry = args[at + 1];
    const split = entry.indexOf('=');
    env[entry.slice(0, split)] = entry.slice(split + 1);
    at += 2;
  } else {
    throw new Error(`unexpected engine option ${args[at]}`);
  }
}
const command = args.slice(at + 1);
if (command[0] === '/bin/cat') {
  try {
    process.stdout.write(readFileSync(command[1]));
  } catch {
    process.exitCode = 1;
  }
} else {
  if (command.slice(0, 4).join(' ') !== '/bin/tmux -u -L reverie-laptop') {
    throw new Error(`unexpected engine exec ${command.join(' ')}`);
  }
  const tmux = process.env.FAKE_TMUX;
  const socket = process.env.FAKE_TMUX_SOCKET;
  if (!tmux || !socket) throw new Error('FAKE_TMUX and FAKE_TMUX_SOCKET are required');
  const child = spawn(tmux, ['-u', '-S', socket, ...command.slice(4)], { stdio: 'inherit', env });
  if (attach) {
    const delay = Number(process.env.FAKE_INSTALL_DELAY ?? '0') * 1000;
    setTimeout(() => process.on('SIGWINCH', () => child.kill('SIGWINCH')), delay);
  }
  for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(name, () => child.kill(name));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
    process.exit();
  });
}
