/**
 * The front's channel reaches TS on fd 3 and must reach nothing TS spawns: a process that held it could
 * write frames as if it were the front. This pins what Node does on this platform, for the ways TS spawns
 * children, with the channel opened as FrontChannel.fromInheritedFd opens it. The Rust launcher's own
 * placement of the channel on fd 3 is tested with the launcher.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

// The child: open fd 3 as the channel, then report what each kind of grandchild holds.
const child = String.raw`
const { spawn } = require('node:child_process');
const { readlinkSync } = require('node:fs');
const net = require('node:net');
const channel = readlinkSync('/proc/self/fd/3');
new net.Socket({ fd: 3, readable: true, writable: true }).pause();
const report = 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(fs.readdirSync("/proc/self/fd").map((fd) => { try { return fs.readlinkSync("/proc/self/fd/" + fd); } catch { return null; } })))';
const modes = {
  pipe: { stdio: 'pipe' },
  inherit: { stdio: ['ignore', 'pipe', 'inherit'] },
  detached: { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
  shell: { stdio: ['ignore', 'pipe', 'inherit'], shell: true },
  // The control: a grandchild given fd 3 explicitly must hold the channel, or the check proves nothing.
  explicit: { stdio: ['ignore', 'pipe', 'inherit', 3] },
};
const held = {};
let pending = Object.keys(modes).length;
for (const [mode, options] of Object.entries(modes)) {
  const args = options.shell ? ['-e', JSON.stringify(report)] : ['-e', report];
  const grandchild = spawn(options.shell ? JSON.stringify(process.execPath) : process.execPath, args, options);
  let out = '';
  grandchild.stdout.on('data', (chunk) => (out += chunk));
  grandchild.on('close', () => {
    held[mode] = JSON.parse(out);
    if (--pending === 0) {
      process.stdout.write(JSON.stringify({ channel, held }));
      process.exit(0);
    }
  });
}
`;

describe.runIf(process.platform === 'linux')('the front channel on fd 3', () => {
  it('reaches no grandchild TS spawns, while one given fd 3 explicitly holds it', async () => {
    const result = await new Promise<{ channel: string; held: Record<string, string[]> }>((resolve, reject) => {
      // Node creates a socket pair for an extra 'pipe' stdio entry and places the child's end on fd 3, as the
      // front does with its channel.
      const proc = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', (chunk: Buffer) => (out += chunk));
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
    });
    expect(result.channel).toMatch(/^socket:\[\d+\]$/);
    expect(result.held.explicit).toContain(result.channel);
    for (const mode of ['pipe', 'inherit', 'detached', 'shell'])
      expect(result.held[mode], mode).not.toContain(result.channel);
  }, 20_000);
});
