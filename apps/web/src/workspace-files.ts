/** Bounded shared-drive IO. Linux directory descriptors pin every traversal component;
 * symlinks, hardlinked files, hidden paths and nested mounts are deliberately unavailable. */
import { constants } from 'node:fs';
import { readFile, realpath, link, opendir, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { isSensitivePathAt } from './web/sensitive-path.js';
import { configuredDataDir } from './config/instance.js';
import { workspaceOperation, WorkspaceOperation, WorkspaceError } from './workspace-operation.js';
import { verifyWorkspacePublisher, type WorkspacePublisherVerifier } from './workspace-publisher.js';
import { inlineVideoType, VIDEO_EXTENSION_TYPES } from './video-container.js';
export { WorkspaceError } from './workspace-operation.js';

export const WORKSPACE_MAX_FILE = 32 * 1024 * 1024;
export const WORKSPACE_MAX_TEXT = 256 * 1024;
export const WORKSPACE_MAX_IMAGE = 5 * 1024 * 1024;
export const WORKSPACE_MAX_PDF = 16 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.ts',
  '.js',
  '.mjs',
  '.py',
  '.mo',
  '.xml',
  '.html',
  '.css',
  '.yaml',
  '.yml',
  '.toml',
  '.log',
  '.sh',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.svg',
]);
function fail(status: number, message: string): never {
  throw new WorkspaceError(status, message);
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function segments(path: unknown): string[] {
  // eslint-disable-next-line no-control-regex -- Reject NUL and all control characters in untrusted names.
  if (typeof path !== 'string' || path.length > 2048 || isAbsolute(path) || /[\\\x00-\x1f\x7f]/.test(path))
    fail(400, 'Use a contained relative workspace path.');
  if (path === '') return [];
  const parts = path.split('/');
  if (
    parts.length > 32 ||
    parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || Buffer.byteLength(p) > 255)
  )
    fail(403, 'Hidden or invalid workspace paths are unavailable.');
  return parts;
}
function fdPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}
function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
function visible(root: string, path: string, dataRoots: string[]): void {
  if (!contained(root, path)) fail(403, 'This workspace path is unavailable.');
  segments(relative(root, path).split(sep).join('/'));
  if (isSensitivePathAt(path, dataRoots)) fail(403, 'This workspace path is unavailable.');
}
interface Located {
  configured: string;
  handle: FileHandle;
  root: string;
  path: string;
  mount: string;
  dataRoots: string[];
  rootIdentity: string;
}
export class WorkspaceFiles {
  constructor(
    private readonly root: () => string | undefined,
    private readonly timeoutMs = 120_000,
    private readonly publisher: WorkspacePublisherVerifier = verifyWorkspacePublisher
  ) {}
  private async location(op: WorkspaceOperation, path: unknown, directory: boolean): Promise<Located> {
    const parts = segments(path),
      configured = this.root();
    if (!configured) fail(503, 'The shared workspace is not configured.');
    if (process.platform !== 'linux') fail(503, 'Workspace files currently require Linux descriptor support.');
    const root = await op.io(() => realpath(configured));
    const dataDir = resolve(configuredDataDir()),
      dataRoots = [dataDir];
    try {
      dataRoots.push(await op.io(() => realpath(dataDir)));
    } catch (error) {
      op.check();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const privateRoots = [homedir(), ...dataRoots, '/etc', '/proc', '/sys', '/dev'];
    if (
      root === '/' ||
      root === '/home' ||
      root === '/root' ||
      /^\/(?:home|Users)\/[^/]+$/.test(root) ||
      root.split(sep).some((part) => part.startsWith('.')) ||
      privateRoots.some((p) => contained(root, p) || (contained(p, root) && p !== homedir()))
    )
      fail(403, 'Choose a dedicated shared workspace directory.');
    let handle = await op.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const mountId = async (fd: FileHandle): Promise<string> => {
      const id = (await op.io(() => readFile(`/proc/self/fdinfo/${fd.fd}`, 'utf8'))).match(/^mnt_id:\s*(\d+)$/m)?.[1];
      if (!id) fail(503, 'Workspace mount verification is unavailable.');
      return id;
    };
    try {
      const rootStat = await op.io(() => handle.stat({ bigint: true })),
        rootIdentity = `${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`,
        device = Number(rootStat.dev),
        mount = await mountId(handle);
      for (let i = 0; i < parts.length; i++) {
        const actualParent = await op.io(() => realpath(fdPath(handle))),
          target = resolve(actualParent, parts[i]);
        visible(root, actualParent, dataRoots);
        visible(root, target, dataRoots);
        const next = await op.open(
          `${fdPath(handle)}/${parts[i]}`,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (i < parts.length - 1 || directory ? constants.O_DIRECTORY : 0)
        );
        await op.close(handle);
        handle = next;
        const stat = await op.io(() => handle.stat());
        if (
          stat.dev !== device ||
          (await mountId(handle)) !== mount ||
          (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
        )
          fail(403, 'Links, mounts and special files are unavailable.');
      }
      const actual = await op.io(() => realpath(fdPath(handle)));
      visible(root, actual, dataRoots);
      return { configured: resolve(configured), handle, root, path: actual, mount, dataRoots, rootIdentity };
    } catch (error) {
      await op.close(handle);
      throw error;
    }
  }
  private async snapshot(op: WorkspaceOperation, located: Located) {
    const stat = await op.io(() => located.handle.stat({ bigint: true }));
    const binding = createHash('sha256')
      .update(JSON.stringify([located.configured, located.root, located.rootIdentity, located.mount,
        located.path, stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
        stat.mtimeNs.toString(), stat.ctimeNs.toString()]))
      .digest('hex');
    return { stat, binding };
  }
  private async current(op: WorkspaceOperation, path: unknown, binding: string) {
    // Rewalk the configured root, not the old FD alone: a replacement root or
    // directory entry must not supply another file under the old preview title.
    const located = await this.location(op, path, false);
    try {
      if ((await this.snapshot(op, located)).binding !== binding)
        fail(409, 'The workspace file changed. Refresh and try again.');
    } finally {
      await op.close(located.handle);
    }
  }
  async resolve(path: unknown) {
    return workspaceOperation(this.timeoutMs, async (op) => {
      if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) ||
        /[\\\x00-\x1f\x7f]/.test(path) || resolve(path) !== path)
        fail(400, 'Use an absolute shared workspace file path.');
      const configured = this.root();
      if (!configured) fail(503, 'The shared workspace is not configured.');
      const selectedRoot = resolve(configured);
      if (!contained(selectedRoot, path)) fail(403, 'This workspace path is unavailable.');
      const relativePath = relative(selectedRoot, path).split(sep).join('/');
      const parts = segments(relativePath);
      const located = await this.location(op, relativePath, false);
      try {
        if (located.configured !== selectedRoot) fail(409, 'Workspace configuration changed. Refresh and try again.');
        const { stat, binding } = await this.snapshot(op, located);
        if (!stat.isFile()) fail(400, 'Select a file.');
        if (stat.size > BigInt(WORKSPACE_MAX_FILE)) fail(413, 'Files are limited to 32 MiB.');
        await this.current(op, relativePath, binding);
        return { kind: 'workspace', path: relativePath, name: basename(relativePath), size: Number(stat.size),
          absolutePath: resolve(selectedRoot, relativePath), binding,
          crumbs: [{ name: selectedRoot, path: '' }, ...parts.slice(0, -1).map((name, i) =>
            ({ name, path: parts.slice(0, i + 1).join('/') }))] };
      } finally {
        await op.close(located.handle);
      }
    });
  }
  async list(path: unknown) {
    return workspaceOperation(this.timeoutMs, async (op) => {
      const located = await this.location(op, path, true);
      const dir = await op.acquire(
        () => opendir(fdPath(located.handle)),
        (dir) => dir.close()
      );
      const entries: Array<{ name: string; path: string; kind: string; size: number; modified: string;
        binding?: string; absolutePath?: string }> = [];
      let scanned = 0,
        limited = false;
      while (true) {
        const entry = await op.io(() => dir.read());
        if (!entry) break;
        if (++scanned > MAX_ENTRIES) {
          limited = true;
          break;
        }
        if ((!entry.isDirectory() && !entry.isFile()) || entry.name.startsWith('.')) continue;
        const child = [...segments(path), entry.name].join('/');
        try {
          const item = await this.location(op, child, entry.isDirectory());
          try {
            const stat = await op.io(() => item.handle.stat());
            entries.push({
              name: entry.name,
              path: child,
              kind: stat.isDirectory() ? 'directory' : 'file',
              size: stat.size,
              modified: stat.mtime.toISOString(),
              ...(stat.isFile() ? { binding: (await this.snapshot(op, item)).binding,
                absolutePath: resolve(item.configured, child) } : {}),
            });
          } finally {
            await op.close(item.handle);
          }
        } catch {
          op.check(); /* Unavailable entries never reveal metadata. */
        }
      }
      entries.sort(
        (a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name)
      );
      let upload = {
        enabled: false,
        reason: 'Uploads go to the shared workspace root only. Open Workspace to upload.',
      };
      if (path === '') {
        try {
          await this.publisher({ ...located, operation: op });
          op.check();
          upload = { enabled: true, reason: 'Uploads go to the shared workspace root only.' };
        } catch (error) {
          op.check();
          upload.reason =
            error instanceof WorkspaceError
              ? error.message
              : 'Uploads unavailable: stable mount-root authority could not be verified.';
        }
      }
      return { path, entries, limited, maxFileBytes: WORKSPACE_MAX_FILE, upload };
    });
  }
  async file(path: unknown, preview: boolean, expectedBinding?: unknown) {
    if (expectedBinding !== undefined && (typeof expectedBinding !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBinding)))
      fail(400, 'Invalid workspace file binding.');
    return workspaceOperation<{ stream: PassThrough; size: number; mime: string; name: string; binding: string }>(
      this.timeoutMs,
      async (op, ready) => {
        const located = await this.location(op, path, false),
          { stat, binding } = await this.snapshot(op, located),
          size = Number(stat.size);
        if (!stat.isFile()) fail(400, 'Select a file.');
        if (stat.size > BigInt(WORKSPACE_MAX_FILE)) fail(413, 'Files are limited to 32 MiB.');
        if (expectedBinding !== undefined && binding !== expectedBinding)
          fail(409, 'The workspace file changed. Refresh and try again.');
        let mime = 'application/octet-stream';
        if (preview) {
          const head = Buffer.alloc(16);
          await op.io(() => located.handle.read(head, 0, 16, 0));
          const image = imageType(head);
          // A movie plays where it is clicked, streamed like a download (within the same file limit), never as text.
          const video = inlineVideoType(VIDEO_EXTENSION_TYPES[extname(located.path).slice(1).toLowerCase()] ?? '', head);
          if (image) {
            if (size > WORKSPACE_MAX_IMAGE) fail(413, 'Image previews are limited to 5 MiB.');
            mime = image;
          } else if (video) {
            mime = video;
          } else if (/^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(head.toString('ascii'))) {
            if (size > WORKSPACE_MAX_PDF) fail(413, 'PDF previews are limited to 16 MiB.');
            mime = 'application/pdf';
          } else {
            if (size > WORKSPACE_MAX_TEXT)
              fail(413, 'Text previews are limited to 256 KiB. Download to view the full file.');
            if (!TEXT_EXT.has(extname(located.path).toLowerCase()) && extname(located.path) !== '')
              fail(415, 'Preview unavailable. Download this file to open it.');
            const bytes = Buffer.alloc(size);
            await op.io(() => located.handle.read(bytes, 0, bytes.length, 0));
            try {
              if (bytes.includes(0)) throw new Error();
              new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              fail(415, 'Preview supports UTF-8 text and common raster images.');
            }
            mime = 'text/plain; charset=utf-8';
          }
        }
        const stream = new PassThrough({ highWaterMark: 65536 });
        const complete = finished(stream);
        void complete.catch((error) => {
          if (!op.signal.aborted) op.controller.abort(error);
        });
        const abort = () => stream.destroy(op.signal.reason);
        op.signal.addEventListener('abort', abort, { once: true });
        const cancelStreamCleanup = op.cleanup(async () => {
          op.signal.removeEventListener('abort', abort);
          stream.destroy();
        });
        stream.once('end', () => {
          op.signal.removeEventListener('abort', abort);
          cancelStreamCleanup();
          op.completeStream(); // End is emitted only after all bytes are consumed; the file FD was already closed.
        });
        await this.current(op, path, binding);
        ready({ stream, size, mime, name: basename(located.path), binding });
        try {
          let position = 0;
          while (position < size) {
            const bytes = Buffer.alloc(Math.min(65536, size - position));
            const { bytesRead } = await op.io(() => located.handle.read(bytes, 0, bytes.length, position));
            if (!bytesRead) fail(409, 'The file changed during download. Refresh and try again.');
            position += bytesRead;
            if (stream.destroyed) fail(499, 'Download disconnected.');
            if (!stream.write(bytes.subarray(0, bytesRead))) await once(stream, 'drain', { signal: op.signal });
            op.check();
          }
          // Check the original FD and the current root/path before signaling EOF.
          if ((await this.snapshot(op, located)).binding !== binding)
            fail(409, 'The workspace file changed. Refresh and try again.');
          await this.current(op, path, binding);
          await op.close(located.handle);
          op.check();
          stream.end();
          await complete;
          op.check();
        } catch (error) {
          stream.destroy(error as Error);
          throw error;
        }
        return undefined;
      }
    );
  }
  async upload(path: unknown, name: unknown, source: Readable, expected: number): Promise<void> {
    return workspaceOperation<void>(this.timeoutMs, async (op) => {
      if (path !== '') fail(403, 'Uploads go to the shared workspace root only.');
      if (typeof name !== 'string' || segments(name).length !== 1) fail(400, 'Choose a single filename.');
      if (!Number.isSafeInteger(expected) || expected < 0 || expected > WORKSPACE_MAX_FILE)
        fail(413, 'Uploads are limited to 32 MiB and require a known size.');
      const located = await this.location(op, '', true);
      if (isSensitivePathAt(resolve(located.path, name), located.dataRoots)) fail(403, 'This filename is unavailable.');
      await this.publisher({ ...located, operation: op });
      op.check();
      const temporary = `${fdPath(located.handle)}/.reverie-upload-${randomUUID()}`,
        target = `${fdPath(located.handle)}/${name}`;
      const output = await op.temporary(temporary);
      const abort = () => source.destroy(op.signal.reason);
      source.on('error', () => undefined);
      op.signal.addEventListener('abort', abort, { once: true });
      op.cleanup(async () => {
        op.signal.removeEventListener('abort', abort);
        source.destroy();
      });
      let received = 0;
      for await (const value of source) {
        op.check();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        received += chunk.length;
        if (received > expected || received > WORKSPACE_MAX_FILE) fail(413, 'Upload exceeded its declared size.');
        let position = 0;
        while (position < chunk.length) {
          const { bytesWritten } = await op.io(() => output.write(chunk, position, chunk.length - position));
          if (!bytesWritten) fail(507, 'Workspace storage could not accept this upload.');
          position += bytesWritten;
        }
      }
      op.check();
      if (received !== expected) fail(400, 'Upload was incomplete. Try again.');
      await op.close(output);
      op.check();
      // Authority is the verified stable mount root, never a renameable subdirectory/pathname recheck.
      op.committing = true;
      await op.io(() => link(temporary, target));
    });
  }
}
