import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { IPty } from 'node-pty';

export const echoClientArgv = [
  process.execPath,
  '-e',
  'if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.pipe(process.stdout);',
];

function birth(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  if (['Z', 'X'].includes(fields[0]) || Number(fields[1]) !== process.pid || !/^[1-9]\d*$/.test(fields[19])) {
    throw new Error('Owned PTY child is not live under this test process');
  }
  return fields[19];
}

/** A real child response proves exec progress; spawn's PID alone does not. */
export async function ownedEchoArgv(client: IPty, current: () => boolean): Promise<string[]> {
  const pid = client.pid,
    original = birth(pid);
  const assertCurrent = () => {
    if (!current() || client.pid !== pid || birth(pid) !== original) {
      throw new Error('Owned PTY incarnation changed');
    }
  };
  assertCurrent();
  // Before raw mode, tty echo renders NUL as ^@; only the actual echo program
  // can return these literal delimiters. This never writes to a provider pane.
  const challenge = `\0owned-echo-${randomUUID()}\0`;
  await new Promise<void>((resolve, reject) => {
    let settled = false,
      output = '';
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      data.dispose();
      exit.dispose();
      if (error) reject(error);
      else resolve();
    };
    const data = client.onData((chunk) => {
      output = (output + chunk).slice(-4096);
      if (output.includes(challenge)) {
        try {
          assertCurrent();
          finish();
        } catch (error) {
          finish(error);
        }
      }
    });
    const exit = client.onExit(() => finish(new Error('Owned PTY exited before its echo acknowledgement')));
    const timer = setTimeout(() => finish(new Error('Owned PTY echo acknowledgement timed out')), 2_000);
    try {
      assertCurrent();
      client.write(challenge);
    } catch (error) {
      finish(error);
    }
  });
  assertCurrent();
  const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  const actual = statSync(`/proc/${pid}/exe`),
    expected = statSync(process.execPath);
  assertCurrent();
  if (!raw.endsWith('\0') || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('Owned PTY executable identity is unconfirmed');
  }
  return raw.slice(0, -1).split('\0');
}
