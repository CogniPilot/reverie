/** Publication authority is a fixed kernel mount root with a protected ancestor namespace.
 * Directory descriptors alone cannot authorize writes through renameable ancestors. */
import { constants } from 'node:fs';
import { readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkspaceError, type WorkspaceOperation } from './workspace-operation.js';

export interface WorkspacePublisherContext {
  root: string;
  configured: string;
  handle: FileHandle;
  mount: string;
  operation: WorkspaceOperation;
}
export type WorkspacePublisherVerifier = (context: WorkspacePublisherContext) => Promise<void>;
const refuse = (reason: string): never => {
  throw new WorkspaceError(403, 'Uploads unavailable: ' + reason);
};
export const verifyWorkspacePublisher: WorkspacePublisherVerifier = async ({
  root,
  configured,
  handle,
  mount,
  operation: op,
}) => {
  if (configured !== root) refuse('configure the canonical mount root directly, without symlink aliases.');
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) refuse('the publisher must run as a non-root user.');
  const status = await op.io(() => readFile('/proc/self/status', 'utf8'));
  const caps = status.match(/^CapEff:\s*([a-fA-F0-9]+)$/m)?.[1];
  if (!caps || BigInt('0x' + caps) !== 0n) refuse('the publisher must have no effective Linux capabilities.');
  const mounts = await op.io(() => readFile('/proc/self/mountinfo', 'utf8'));
  const entry = mounts
    .split('\n')
    .map((line) => line.split(' '))
    .find((fields) => fields[0] === mount);
  const point = entry?.[4]?.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
  if (point !== root) refuse('the shared workspace must be a kernel mount root; browsing remains available.');
  // Walk '/' through the mount's parent using O_NOFOLLOW; every ancestor is root-owned and immutable to this uid.
  let ancestor = await op.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parts = dirname(root).split('/').filter(Boolean);
  try {
    for (let i = 0; i <= parts.length; i++) {
      const info = await op.io(() => ancestor.stat());
      if (info.uid !== 0 || (info.mode & 0o022) !== 0)
        refuse('workspace ancestors must be root-owned and not group/other writable.');
      if (i < parts.length) {
        const next = await op.open(
          `/proc/self/fd/${ancestor.fd}/${parts[i]}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        await op.close(ancestor);
        ancestor = next;
      }
    }
    const name = root.slice(root.lastIndexOf('/') + 1);
    const current = await op.open(
      `/proc/self/fd/${ancestor.fd}/${name}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      const actual = await op.io(() => current.stat()),
        pinned = await op.io(() => handle.stat());
      if (actual.dev !== pinned.dev || actual.ino !== pinned.ino)
        refuse('the configured mount changed during verification.');
    } finally {
      await op.close(current);
    }
  } finally {
    await op.close(ancestor);
  }
};
