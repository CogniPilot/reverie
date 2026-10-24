/** One process-wide shared-drive job. A caller deadline never frees an uncancellable FS job. */
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
let occupied: WorkspaceOperation | undefined;
export class WorkspaceOperation {
  constructor(private readonly release: () => void = () => undefined) {}
  readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  committing = false;
  private activeIO = false;
  private async rawIO<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeIO) throw new Error('Concurrent workspace filesystem jobs are forbidden');
    this.activeIO = true;
    try {
      return await work();
    } finally {
      this.activeIO = false;
    }
  }
  private readonly handles = new Map<FileHandle, Promise<void> | undefined>();
  private readonly cleanupTasks: Array<() => Promise<void>> = [];
  check(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
  async io<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    const result = await this.rawIO(work);
    this.check();
    return result;
  }
  async open(...args: Parameters<typeof open>): Promise<FileHandle> {
    this.check();
    const handle = await this.rawIO(() => open(...args));
    this.handles.set(handle, undefined);
    this.check();
    return handle;
  }
  async temporary(path: string): Promise<FileHandle> {
    this.check();
    const handle = await this.rawIO(() =>
      open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    );
    this.handles.set(handle, undefined);
    this.cleanup(() => unlink(path));
    this.check();
    return handle;
  }
  async acquire<T>(work: () => Promise<T>, cleanup: (value: T) => Promise<void>): Promise<T> {
    this.check();
    const value = await this.rawIO(work);
    this.cleanup(() => cleanup(value));
    this.check();
    return value;
  }
  async close(handle: FileHandle): Promise<void> {
    let closing = this.handles.get(handle);
    if (!closing) {
      closing = this.rawIO(() => handle.close());
      this.handles.set(handle, closing);
    }
    await closing;
    this.handles.delete(handle);
  }
  cleanup(work: () => Promise<void>): () => void {
    this.cleanupTasks.push(work);
    return () => {
      const index = this.cleanupTasks.indexOf(work);
      if (index >= 0) this.cleanupTasks.splice(index, 1);
    };
  }
  completeStream(): void {
    if (this.activeIO || this.handles.size || this.cleanupTasks.length)
      throw new Error('Workspace resources have not settled');
    this.release();
  }
  async settle(): Promise<void> {
    let failure: unknown;
    // Temporary names and directory iterators need their pinned directory descriptors alive.
    for (const task of this.cleanupTasks.reverse()) {
      try {
        await this.rawIO(task);
      } catch (error) {
        failure ??= error;
      }
    }
    for (const handle of [...this.handles.keys()].reverse()) {
      try {
        await this.close(handle);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}

export function workspaceOperation<T>(
  timeoutMs: number,
  work: (op: WorkspaceOperation, ready: (result: T) => void) => Promise<T | undefined>
): Promise<T> {
  const pool = process.env.UV_THREADPOOL_SIZE ?? '4';
  if (!/^\d+$/.test(pool) || Number(pool) < 4)
    return Promise.reject(new WorkspaceError(503, 'Workspace files require at least four libuv workers.'));
  if (occupied)
    return Promise.reject(new WorkspaceError(429, 'Workspace filesystem work is still running. Try again shortly.'));
  const release = () => {
    if (occupied === op) occupied = undefined;
    clearTimeout(timer);
  };
  const op = new WorkspaceOperation(release);
  occupied = op;
  let resolve!: (result: T) => void, reject!: (error: unknown) => void;
  const caller = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const timer = setTimeout(() => {
    const error = new WorkspaceError(
      408,
      op.committing
        ? 'Upload confirmation timed out; file may have arrived. Refresh before retrying.'
        : 'Workspace operation timed out. Filesystem work is still settling; try again shortly.'
    );
    op.controller.abort(error);
    reject(error);
  }, timeoutMs);
  // Keep admission until the actual operation AND all cleanup have settled, even after caller timeout.
  void (async () => {
    let result: T | undefined, failure: unknown;
    try {
      result = await work(op, (value) => {
        op.check();
        resolve(value);
      });
    } catch (error) {
      failure = error;
    }
    try {
      await op.settle();
    } catch (error) {
      failure ??= error;
    }
    release();
    if (failure) reject(failure);
    else {
      try {
        op.check();
        resolve(result as T);
      } catch (error) {
        reject(error);
      }
    }
  })();
  return caller;
}
