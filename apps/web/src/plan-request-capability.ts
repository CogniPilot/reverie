/** Private one-time approval credentials. Never place them in a project, prompt, URL, argv or public DTO.
 * Permissions protect against accidental/public disclosure and other Unix users. Full-access experts
 * share the server's Unix principal; this is not isolation against a hostile same-UID process.
 */
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { dataPath } from './config/instance.js';

export const PlanRequestId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const Capability = z
  .object({ requestId: PlanRequestId, sessionId: PlanRequestId, nonce: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type PlanRequestCapability = z.infer<typeof Capability>;

export function planRequestCapabilityFile(
  sessionId: string,
  requestId: string,
  root = dataPath('plan-request-capabilities')
): string {
  return join(root, PlanRequestId.parse(sessionId), `${PlanRequestId.parse(requestId)}.json`);
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await fs.mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Approval directory is not private');
}

export class PlanRequestCapabilities {
  constructor(readonly root = dataPath('plan-request-capabilities')) {}

  private async directory(sessionId: string, create: boolean): Promise<void> {
    PlanRequestId.parse(sessionId);
    await privateDirectory(this.root, create);
    await privateDirectory(join(this.root, sessionId), create);
  }

  async write(input: PlanRequestCapability): Promise<string> {
    const value = Capability.parse(input);
    await this.directory(value.sessionId, true);
    const file = planRequestCapabilityFile(value.sessionId, value.requestId, this.root);
    const handle = await fs.open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return file;
  }

  async read(sessionId: string, requestId: string): Promise<PlanRequestCapability> {
    await this.directory(sessionId, false);
    const file = planRequestCapabilityFile(sessionId, requestId, this.root);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('Approval file is not private');
      const bytes = Buffer.alloc(4097),
        read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 4096) throw new Error('Approval file is too large');
      const value = Capability.parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')));
      if (value.sessionId !== sessionId || value.requestId !== requestId)
        throw new Error('Approval file belongs to another request or session');
      return value;
    } finally {
      await handle.close();
    }
  }

  async remove(sessionId: string, requestId: string): Promise<void> {
    const file = planRequestCapabilityFile(sessionId, requestId, this.root);
    try {
      await this.directory(sessionId, false);
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
