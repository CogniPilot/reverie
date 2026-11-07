import { spawnSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const identity = (fd) => {
  const { dev, ino } = fstatSync(fd, { bigint: true });
  return `${dev}:${ino}`;
};
const channelIdentity = identity(3);
if (identity(0) === channelIdentity) throw Error('Channel occupies stdin');
const entrypoint = fileURLToPath(new URL('./fd-grandchild.mjs', import.meta.url));
const modes = [
  { stdio: ['pipe', 'pipe', 'pipe'] },
  { stdio: ['inherit', 'pipe', 'inherit'] },
  { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
  { stdio: ['ignore', 'pipe', 'ignore', 3] },
];
for (const [index, options] of modes.entries()) {
  const result = spawnSync(process.execPath, [entrypoint, channelIdentity], {
    ...options,
    timeout: 3000,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) throw Error(`grandchild failed: ${result.stderr}`);
  if (result.stdout.trim() !== String(index === 3)) throw Error(`channel inheritance: ${index}`);
}
const channel = new Socket({ fd: 3, readable: true, writable: true });
channel.once('data', (challenge) => channel.end(Buffer.concat([Buffer.from('qualified:'), challenge])));
