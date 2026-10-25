/** Real worker-thread/private pipe transport. Owned helper fixtures only; no sockets or authority. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalCustodyChannel } from '../src/goal-custody-channel.js';

describe('closed persistent Goal helper transport', () => {
  let root: string, executable: string;
  const channels: GoalCustodyChannel[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'goal-channel-fixture-'));
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    expect(python.status).toBe(0);
    executable = join(root, 'closed-helper');
    fs.writeFileSync(
      executable,
      `#!${python.stdout.trim()}
import json, os, struct, sys, time
assert sys.argv[1:] == ['--goal-custody-stream']
assert 'SYNTHETIC_CHANNEL_PARENT' not in os.environ
mode = os.environ['REVERIE_WORKER_SOCKET']
counter = 0
while sys.stdin.buffer.read(1) == b'G':
    counter += 1
    if mode == '/timeout': time.sleep(10)
    if mode == '/exit': sys.exit(1)
    if mode == '/oversize':
        sys.stdout.buffer.write(b'J' + struct.pack('!I', 32769)); sys.stdout.buffer.flush(); continue
    payload = json.dumps({'counter': counter}).encode()
    sys.stdout.buffer.write((b'E' if mode == '/invalid' else b'J') + struct.pack('!I', len(payload)) + payload)
    sys.stdout.buffer.flush()
`,
      { mode: 0o700 }
    );
  });
  afterEach(() => {
    for (const channel of channels.splice(0)) channel.close();
    if (root.startsWith(join(tmpdir(), 'goal-channel-fixture-'))) fs.rmSync(root, { recursive: true, force: true });
  });
  const channel = (executable: string, scope: string) => {
    const item = new GoalCustodyChannel(executable, scope);
    channels.push(item);
    return item;
  };
  it('retains one helper but obtains a NEW closed response for every call, and refuses after close', () => {
    process.env.SYNTHETIC_CHANNEL_PARENT = 'must-not-reach-helper';
    const item = channel(executable, '/fresh');
    try {
      expect(JSON.parse(item.project())).toEqual({ counter: 1 });
      expect(JSON.parse(item.project())).toEqual({ counter: 2 });
    } finally {
      delete process.env.SYNTHETIC_CHANNEL_PARENT;
    }
    item.close();
    expect(() => item.project()).toThrow(/unavailable/);
  });
  it.each(['/invalid', '/oversize', '/exit'])(
    'refuses %s output and permanently closes rather than returning a cached prior response',
    (mode) => {
      const item = channel(executable, mode);
      expect(() => item.project()).toThrow(/refused|unavailable/);
      expect(() => item.project()).toThrow(/unavailable/);
    }
  );
  it('enforces whole roundtrip deadline even while main thread is synchronously waiting', () => {
    const item = channel(executable, '/timeout');
    const started = performance.now();
    expect(() => item.project()).toThrow(/refused|deadline|unavailable/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1500);
    expect(() => item.project()).toThrow(/unavailable/);
  }, 5000);
});
