/** Real worker-thread/private pipe transport. Owned helper fixtures only; no sockets or authority. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalCustodyChannel } from '../src/goal-custody-channel.js';

describe('closed persistent Goal helper transport', () => {
  let root: string, executable: string;
  const channels: GoalCustodyChannel[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'goal-channel-fixture-'));
    executable = join(root, 'closed-helper');
    fs.writeFileSync(
      executable,
      `#!${process.execPath}
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['--goal-custody-stream']);
assert.equal(process.env.SYNTHETIC_CHANNEL_PARENT, undefined);
const mode = process.env.REVERIE_WORKER_SOCKET;
let counter = 0;
function reply() {
  const payload = Buffer.from(JSON.stringify({ counter }));
  const header = Buffer.alloc(5);
  header.write(mode === '/invalid' ? 'E' : 'J');
  header.writeUInt32BE(mode === '/oversize' ? 32769 : payload.length, 1);
  process.stdout.write(mode === '/oversize' ? header : Buffer.concat([header, payload]));
}
process.stdin.on('data', (bytes) => {
  for (const byte of bytes) {
    if (byte !== 71) return process.stdin.destroy();
    if (mode === '/exit') process.exit(1);
    counter += 1;
    if (mode === '/timeout') setTimeout(reply, 10000);
    else reply();
  }
});
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
