/** Actual fixed control /scratch custody. Host source strings are never opened. */
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { EphemeralDirectory, EphemeralLayout, type EphemeralProjection } from './docker-ephemeral-data.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
const ROOT = '/scratch';
const FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function fail(): never {
  throw new DockerEmployeeContinuationError('DOCKER_EPHEMERAL_DIRECTORY_CUSTODY');
}
function facts(fd: number): EphemeralDirectory {
  const s = fs.fstatSync(fd, { bigint: true });
  if (!s.isDirectory()) fail();
  return Object.freeze(
    EphemeralDirectory.parse({
      dev: String(s.dev),
      ino: String(s.ino),
      uid: Number(s.uid),
      gid: Number(s.gid),
      mode: Number(s.mode & 0o7777n),
    })
  );
}
export class EphemeralDirectoryOwner {
  readonly root: EphemeralDirectory;
  readonly #rootFd: number;
  readonly #mount: string;
  readonly #fds: number[] = [];
  readonly #identities: EphemeralDirectory[] = [];
  #projection?: EphemeralProjection;
  #closed = false;
  #revoked?: unknown;
  readonly #closeFailures: unknown[] = [];
  constructor() {
    const fd = fs.openSync(ROOT, FLAGS);
    this.#fds.push(fd);
    this.#rootFd = fd;
    try {
      this.root = facts(fd);
      this.#identities.push(this.root);
      this.#mount = this.#mountId(fd);
      if (this.root.uid !== process.getuid?.() || this.root.gid !== process.getgid?.()) fail();
      this.assertCurrent();
    } catch (cause) {
      try {
        this.close();
      } catch (close) {
        throw new AggregateError([cause, close]);
      }
      throw cause;
    }
  }
  #close(fd: number): void {
    try {
      fs.closeSync(fd);
    } catch (cause) {
      this.#closeFailures.push(cause);
      throw cause;
    }
  }
  #mountId(fd: number): string {
    const file = fs.openSync(
      '/proc/self/fdinfo/' + fd,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    let result: string | undefined, error: unknown;
    try {
      if (fs.statfsSync('/proc/self/fd/' + file, { bigint: true }).type !== 0x9fa0n) fail();
      const bytes = Buffer.alloc(4097);
      let count = 0;
      while (count < bytes.length) {
        const n = fs.readSync(file, bytes, count, bytes.length - count, count);
        if (!n) break;
        count += n;
      }
      if (count > 4096) fail();
      const matches = [
        ...bytes
          .subarray(0, count)
          .toString('utf8')
          .matchAll(/^mnt_id:\s*([1-9][0-9]*)\s*$/gm),
      ];
      if (matches.length !== 1) fail();
      result = matches[0]![1]!;
    } catch (cause) {
      error = cause;
    }
    try {
      this.#close(file);
    } catch (cause) {
      error = error === undefined ? cause : new AggregateError([error, cause]);
    }
    if (error !== undefined) throw error;
    return result!;
  }
  #probe(path: string, expected: EphemeralDirectory): void {
    const fd = fs.openSync(path, FLAGS);
    let error: unknown;
    try {
      if (!isDeepStrictEqual(facts(fd), expected) || this.#mountId(fd) !== this.#mount) fail();
    } catch (cause) {
      error = cause;
    }
    try {
      this.#close(fd);
    } catch (cause) {
      error = error === undefined ? cause : new AggregateError([error, cause]);
    }
    if (error !== undefined) throw error;
  }
  assertCurrent(): void {
    try {
      if (this.#closed || this.#revoked !== undefined || this.#closeFailures.length) fail();
      if (!isDeepStrictEqual(facts(this.#rootFd), this.root) || this.#mountId(this.#rootFd) !== this.#mount) fail();
      this.#probe(ROOT, this.root);
      if (this.#projection) {
        let parent = this.#rootFd;
        for (const [index, name] of this.#parts(this.#projection).entries()) {
          const fd = this.#fds[index + 1]!,
            expected = this.#identities[index + 1]!;
          if (!isDeepStrictEqual(facts(fd), expected) || this.#mountId(fd) !== this.#mount) fail();
          this.#probe('/proc/self/fd/' + parent + '/' + name, expected);
          parent = fd;
        }
      }
    } catch (cause) {
      this.#revoked ??= cause;
      throw cause;
    }
  }
  #parts(projection: EphemeralProjection): string[] {
    EphemeralLayout.parse(projection.layout);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(projection.identity)) fail();
    return ['laptops', projection.layout, projection.identity, 'tmp'];
  }
  #validate(fd: number, forbidden: readonly { dev: string; ino: string }[]): EphemeralDirectory {
    const value = facts(fd);
    if (
      value.uid !== this.root.uid ||
      value.gid !== this.root.gid ||
      this.#mountId(fd) !== this.#mount ||
      forbidden.some((item) => item.dev === value.dev && item.ino === value.ino)
    )
      fail();
    return value;
  }
  /** Read-only existing prefix check BEFORE a nonrecursive helper can hide submounts. */
  inspectExistingPrefix(projection: EphemeralProjection, forbidden: readonly { dev: string; ino: string }[]): boolean {
    this.assertCurrent();
    const temporary: number[] = [];
    let complete = true,
      error: unknown;
    try {
      this.#validate(this.#rootFd, forbidden);
      let parent = this.#rootFd;
      for (const name of this.#parts(projection)) {
        let fd: number;
        try {
          fd = fs.openSync('/proc/self/fd/' + parent + '/' + name, FLAGS);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            complete = false;
            break;
          }
          throw cause;
        }
        temporary.push(fd);
        this.#validate(fd, forbidden);
        parent = fd;
      }
    } catch (cause) {
      error = cause;
    }
    for (const fd of temporary.reverse())
      try {
        this.#close(fd);
      } catch (cause) {
        error = error === undefined ? cause : new AggregateError([error, cause]);
      }
    if (error !== undefined) {
      this.#revoked = error;
      throw error;
    }
    this.assertCurrent();
    return complete;
  }
  captureLeaves(projection: EphemeralProjection, forbidden: readonly { dev: string; ino: string }[]) {
    this.assertCurrent();
    if (this.#projection) {
      if (!isDeepStrictEqual(this.#projection, projection)) fail();
      return this.leaves();
    }
    try {
      this.#validate(this.#rootFd, forbidden);
      let parent = this.#rootFd;
      for (const name of this.#parts(projection)) {
        const fd = fs.openSync('/proc/self/fd/' + parent + '/' + name, FLAGS);
        this.#fds.push(fd);
        this.#identities.push(this.#validate(fd, forbidden));
        parent = fd;
      }
      this.#projection = Object.freeze({ ...projection });
      return this.leaves();
    } catch (cause) {
      this.#revoked = cause;
      try {
        this.close();
      } catch (close) {
        throw new AggregateError([cause, close]);
      }
      throw cause;
    }
  }
  leaves(): { scratch: EphemeralDirectory; tmp: EphemeralDirectory } {
    this.assertCurrent();
    if (!this.#projection) fail();
    return { scratch: this.#identities[3]!, tmp: this.#identities[4]! };
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      for (const fd of this.#fds.splice(0).reverse())
        try {
          this.#close(fd);
        } catch {
          /* attempt all independently */
        }
    }
    if (this.#closeFailures.length)
      throw new AggregateError(this.#closeFailures, 'Ephemeral directory closure unconfirmed');
  }
}
