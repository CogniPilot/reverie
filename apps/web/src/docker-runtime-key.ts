/** Retained private instance key. Files and directory stay open; pathname
 * replacement, permission drift, malformed bytes and failed closure revoke it. */
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
const record = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-docker-worker-key-v1'),
    instanceId: z.string().uuid(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function same(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
export class DockerRuntimeKey {
  readonly instanceId: string;
  readonly key: Buffer;
  readonly #directory: number;
  readonly #file: number;
  readonly #directoryStat: fs.Stats;
  readonly #fileStat: fs.Stats;
  #closed = false;
  #closeState: { kind: 'open' | 'closing' | 'closed' } | { kind: 'failed'; cause: AggregateError } = { kind: 'open' };
  constructor(private readonly directory: string) {
    const uid = process.getuid?.();
    if (uid === undefined) throw Error('Docker runtime requires private Unix storage');
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let file: number | undefined;
    try {
      const stat = fs.fstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || !same(stat, fs.lstatSync(directory)))
        throw Error('Private Docker runtime directory custody refused');
      const path = directory + '/worker-identity.json';
      try {
        file = fs.openSync(
          path,
          fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600
        );
        fs.writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            purpose: 'reverie-docker-worker-key-v1',
            instanceId: randomUUID(),
            key: randomBytes(32).toString('hex'),
          })
        );
        fs.fsyncSync(file);
        fs.fsyncSync(dir);
      } catch (cause) {
        if (file !== undefined || (cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        file = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      }
      const before = fs.fstatSync(file);
      if (
        !before.isFile() ||
        before.uid !== uid ||
        (before.mode & 0o077) !== 0 ||
        before.nlink !== 1 ||
        before.size > 1024 ||
        !same(before, fs.lstatSync(path))
      )
        throw Error('Private Docker runtime key custody refused');
      const body = Buffer.alloc(before.size);
      if (fs.readSync(file, body, 0, body.length, 0) !== body.length)
        throw Error('Private Docker key read was incomplete');
      const text = body.toString('utf8'),
        value = record.parse(JSON.parse(text));
      if (!Buffer.from(text).equals(body) || JSON.stringify(value) !== text || !same(before, fs.fstatSync(file)))
        throw Error('Private Docker runtime key changed');
      this.instanceId = value.instanceId;
      this.key = Buffer.from(value.key, 'hex');
      this.#directory = dir;
      this.#file = file;
      this.#fileStat = before;
      this.#directoryStat = fs.fstatSync(dir);
      if (!this.current()) throw Error('Private Docker runtime key changed');
    } catch (cause) {
      const failures = [cause];
      if (file !== undefined)
        try {
          fs.closeSync(file);
        } catch (error) {
          failures.push(error);
        }
      try {
        fs.closeSync(dir);
      } catch (error) {
        failures.push(error);
      }
      throw failures.length === 1 ? cause : new AggregateError(failures, 'Docker key acquisition failed');
    }
  }
  current(): boolean {
    if (this.#closed) return false;
    try {
      const valid =
        same(this.#directoryStat, fs.fstatSync(this.#directory)) &&
        same(this.#directoryStat, fs.lstatSync(this.directory)) &&
        same(this.#fileStat, fs.fstatSync(this.#file)) &&
        same(this.#fileStat, fs.lstatSync(this.directory + '/worker-identity.json'));
      if (!valid) this.#closed = true;
      return valid;
    } catch {
      this.#closed = true;
      return false;
    }
  }
  close(): void {
    if (this.#closeState.kind === 'closed') return;
    if (this.#closeState.kind === 'failed') throw this.#closeState.cause;
    if (this.#closeState.kind === 'closing') throw Error('Original Docker key close is in progress');
    this.#closeState = { kind: 'closing' };
    this.#closed = true;
    this.key.fill(0);
    const errors: unknown[] = [];
    for (const fd of [this.#file, this.#directory])
      try {
        fs.closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) {
      const cause = new AggregateError(errors, 'Docker key close is unconfirmed');
      this.#closeState = { kind: 'failed', cause };
      throw cause;
    }
    this.#closeState = { kind: 'closed' };
  }
}
