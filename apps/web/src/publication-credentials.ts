/** Server-private named PAT storage. Repository labels describe owner intent, not GitHub-enforced scopes. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';

export const PUBLICATION_TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PUBLICATION_TOKEN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const Name = z.string().regex(PUBLICATION_TOKEN_NAME);
const Token = z.string().min(1).max(4096).regex(/^[!-~]+$/);
const Repositories = z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)).max(50)
  .refine(values => new Set(values).size === values.length);
const Label = z.string().trim().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const PublicationTokenCreateSchema = z.object({
  name: Name, token: Token, label: Label.optional(), repositories: Repositories.optional(),
}).strict();
export const PublicationTokenUpdateSchema = z.object({
  name: Name.optional(), token: Token.optional(), label: Label.nullable().optional(), repositories: Repositories.optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export interface PublicationTokenMetadata {
  id: string;
  name: string;
  label?: string;
  repositories: string[];
  createdAt: number;
  updatedAt: number;
}
const Entry = z.object({
  id: z.string().regex(PUBLICATION_TOKEN_ID), owner: z.string().regex(/^[0-9a-f]{64}$/), name: Name,
  label: Label.optional(), repositories: Repositories, createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(), token: Token,
}).strict();
const Document = z.object({ version: z.literal(1), entries: z.array(Entry).max(64) }).strict();
type DocumentValue = z.infer<typeof Document>;
type EntryValue = z.infer<typeof Entry>;
type Owner = string | undefined;
type ValidateAuthority = () => void;
type Code = 'PUBLICATION_INVALID' | 'PUBLICATION_FORBIDDEN' | 'PUBLICATION_NOT_FOUND' | 'PUBLICATION_CONFLICT' | 'PUBLICATION_UNAVAILABLE';
const ERRORS: Record<Code, [number, string]> = {
  PUBLICATION_INVALID: [400, 'Invalid publication credential request'],
  PUBLICATION_FORBIDDEN: [403, 'Publication credential access denied'],
  PUBLICATION_NOT_FOUND: [404, 'Publication credential not found'],
  PUBLICATION_CONFLICT: [409, 'Publication credential name or storage conflicts'],
  PUBLICATION_UNAVAILABLE: [503, 'Publication credential storage unavailable'],
};
export class PublicationVaultError extends Error {
  readonly status: number;
  constructor(readonly code: Code = 'PUBLICATION_UNAVAILABLE') {
    super(ERRORS[code][1]); this.status = ERRORS[code][0];
  }
}
export interface PublicationCredentialAudit {
  action: 'publication-token-create' | 'publication-token-update' | 'publication-token-delete';
  owner: string | null;
  tokenId: string;
}
export interface PublicationVaultOptions {
  /** Must persist locally before returning; never call back into this vault's writer. */
  audit: (entry: Readonly<PublicationCredentialAudit>) => void | Promise<void>;
}
const LIMIT = 2 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();
const uid = () => process.geteuid?.() ?? process.getuid?.() ?? -1;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const ownerKey = (owner: Owner) => {
  if (owner !== undefined && (typeof owner !== 'string' || !owner || owner.length > 200)) throw new PublicationVaultError('PUBLICATION_INVALID');
  return createHash('sha256').update(JSON.stringify([owner ?? null])).digest('hex');
};
const metadata = (entry: EntryValue): PublicationTokenMetadata => ({
  id: entry.id, name: entry.name, ...(entry.label ? { label: entry.label } : {}),
  repositories: [...entry.repositories], createdAt: entry.createdAt, updatedAt: entry.updatedAt,
});
const noSecretMetadata = (entry: EntryValue, secrets: readonly string[]) => {
  const values = [entry.name, entry.label ?? '', ...entry.repositories];
  if (secrets.some(secret => values.some(value => value === secret || (secret.length >= 8 && value.includes(secret)))))
    throw new PublicationVaultError('PUBLICATION_INVALID');
};

export class PublicationCredentialVault {
  readonly directory: string;
  private readonly file: string;
  private readonly lock: string;
  constructor(directory: string, private readonly options: PublicationVaultOptions) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) throw new PublicationVaultError();
    this.directory = directory; this.file = join(directory, 'tokens.json'); this.lock = join(directory, 'vault.lock');
  }

  private checkRoot(create = false): Stats | undefined {
    // Real canonical ancestry avoids silently selecting a symlinked private instance.
    let path = parse(this.directory).root;
    const parts = this.directory.slice(path.length).split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]!);
      let info: Stats;
      try { info = lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || index !== parts.length - 1) throw new PublicationVaultError();
        if (!create) return undefined;
        try {
          mkdirSync(path, { mode: 0o700 });
          const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { fsyncSync(parent); } finally { closeSync(parent); }
        }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw new PublicationVaultError(); }
        info = lstatSync(path);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid()].includes(info.uid)) throw new PublicationVaultError();
      // Root-owned sticky shared ancestors protect their existing owned children.
      if ((info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000))) throw new PublicationVaultError();
      if (index === parts.length - 1) {
        if (info.uid !== uid() || (info.mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new PublicationVaultError();
        return info;
      }
    }
    throw new PublicationVaultError();
  }

  private checkPrivateFile(info: Stats, empty = false): void {
    if (!info.isFile() || info.uid !== uid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        info.size > LIMIT || (empty && info.size !== 0)) throw new PublicationVaultError();
  }

  private read(): { value: DocumentValue; bytes: Buffer | undefined; stamp: Stats | undefined } {
    const root = this.checkRoot();
    if (!root) return { value: { version: 1, entries: [] }, bytes: undefined, stamp: undefined };
    let before: Stats;
    try { before = lstatSync(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PublicationVaultError();
      return { value: { version: 1, entries: [] }, bytes: undefined, stamp: undefined };
    }
    this.checkPrivateFile(before);
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd); this.checkPrivateFile(info);
      if (!same(info, before)) throw new PublicationVaultError();
      const buffer = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = readSync(fd, buffer, count, buffer.length - count, count);
        if (!read) break;
        count += read;
      }
      const bytes = buffer.subarray(0, count);
      const currentRoot = this.checkRoot();
      if (bytes.length > LIMIT || bytes.length !== info.size || !same(info, fstatSync(fd)) ||
          !same(info, lstatSync(this.file)) || currentRoot?.ino !== root.ino || currentRoot.dev !== root.dev) throw new PublicationVaultError();
      const parsed = Document.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success || new Set(parsed.data.entries.map(entry => entry.id)).size !== parsed.data.entries.length ||
          new Set(parsed.data.entries.map(entry => entry.owner + ':' + entry.name)).size !== parsed.data.entries.length)
        throw new PublicationVaultError();
      const secrets = parsed.data.entries.map(entry => entry.token);
      for (const entry of parsed.data.entries) noSecretMetadata(entry, secrets);
      return { value: parsed.data, bytes, stamp: info };
    } finally { closeSync(fd); }
  }

  private async writer<T>(work: (checkLock: () => void) => Promise<T>, validate: ValidateAuthority): Promise<T> {
    const previous = queues.get(this.directory) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      validate(); this.checkRoot(true);
      let fd: number | undefined;
      try {
        try {
          if (existsSync(this.file) && !existsSync(this.lock)) throw new PublicationVaultError();
          fd = openSync(this.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          fsyncSync(fd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          fd = openSync(this.lock, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        const stamp = fstatSync(fd); this.checkPrivateFile(stamp, true);
        const checkLock = () => {
          this.checkPrivateFile(fstatSync(fd!), true);
          if (!same(stamp, fstatSync(fd!)) || !same(stamp, lstatSync(this.lock))) throw new PublicationVaultError();
        };
        checkLock();
        await new Promise<void>((resolveLock, reject) => {
          const child = spawn('flock', ['--exclusive', '--wait', '5', '--conflict-exit-code', '75', '3'], {
            stdio: ['ignore', 'ignore', 'ignore', fd!], env: { PATH: process.env.PATH },
          });
          const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new PublicationVaultError()); }, 7000);
          child.once('error', () => { clearTimeout(timeout); reject(new PublicationVaultError()); });
          child.once('close', code => { clearTimeout(timeout); code === 0 ? resolveLock() : reject(new PublicationVaultError()); });
        });
        checkLock();
        const result = await work(checkLock);
        checkLock();
        return result;
      } finally { if (fd !== undefined) closeSync(fd); }
    });
    const tail = pending.catch(() => undefined); queues.set(this.directory, tail);
    try { return await pending; }
    catch (error) { throw error instanceof PublicationVaultError ? error : new PublicationVaultError(); }
    finally { if (queues.get(this.directory) === tail) queues.delete(this.directory); }
  }

  private async change<T>(owner: Owner, action: PublicationCredentialAudit['action'], validate: ValidateAuthority,
    mutate: (document: DocumentValue, key: string) => { result: T; id: string }): Promise<T> {
    return this.writer(async checkLock => {
      validate(); checkLock(); const before = this.read(); const root = this.checkRoot()!;
      const { result, id } = mutate(before.value, ownerKey(owner));
      const secrets = before.value.entries.map(entry => entry.token);
      for (const entry of before.value.entries) noSecretMetadata(entry, secrets);
      const raw = Buffer.from(JSON.stringify(before.value));
      if (raw.length > LIMIT) throw new PublicationVaultError('PUBLICATION_CONFLICT');
      await this.options.audit(Object.freeze({ action, owner: owner ?? null, tokenId: id }));
      validate(); checkLock();
      const current = this.read();
      if ((before.bytes === undefined) !== (current.bytes === undefined) ||
          (before.bytes && !before.bytes.equals(current.bytes!)) ||
          (before.stamp && (!current.stamp || !same(before.stamp, current.stamp)))) throw new PublicationVaultError();
      const temporary = join(this.directory, `.tokens-${randomUUID()}.tmp`);
      let fd: number | undefined;
      let temporaryStamp: Stats | undefined;
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryStamp = fstatSync(fd); writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = undefined;
        validate(); checkLock();
        const now = this.checkRoot();
        if (!now || now.dev !== root.dev || now.ino !== root.ino) throw new PublicationVaultError();
        renameSync(temporary, this.file);
        const directory = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(directory); } finally { closeSync(directory); }
        return result;
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (temporaryStamp && existsSync(temporary)) {
          const named = lstatSync(temporary);
          if (named.dev === temporaryStamp.dev && named.ino === temporaryStamp.ino) unlinkSync(temporary);
        }
      }
    }, validate);
  }

  async metadata(owner: Owner): Promise<PublicationTokenMetadata[]> {
    try { const key = ownerKey(owner); return this.read().value.entries.filter(entry => entry.owner === key).map(metadata); }
    catch (error) { throw error instanceof PublicationVaultError ? error : new PublicationVaultError(); }
  }

  async assertGrantIds(owner: Owner, ids: readonly string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !PUBLICATION_TOKEN_ID.test(id)))
      throw new PublicationVaultError('PUBLICATION_INVALID');
    const available = new Set((await this.metadata(owner)).map(entry => entry.id));
    if (ids.some(id => !available.has(id))) throw new PublicationVaultError('PUBLICATION_NOT_FOUND');
  }

  async create(owner: Owner, input: unknown, validate: ValidateAuthority): Promise<PublicationTokenMetadata> {
    const parsed = PublicationTokenCreateSchema.safeParse(input);
    if (!parsed.success) throw new PublicationVaultError('PUBLICATION_INVALID');
    return this.change(owner, 'publication-token-create', validate, (document, key) => {
      if (document.entries.length >= 64 || document.entries.some(entry => entry.owner === key && entry.name === parsed.data.name))
        throw new PublicationVaultError('PUBLICATION_CONFLICT');
      const now = Date.now(); const entry = { ...parsed.data, id: randomUUID(), owner: key, repositories: parsed.data.repositories ?? [], createdAt: now, updatedAt: now };
      noSecretMetadata(entry, [entry.token]); document.entries.push(entry);
      return { result: metadata(entry), id: entry.id };
    });
  }

  async update(owner: Owner, id: string, input: unknown, validate: ValidateAuthority): Promise<PublicationTokenMetadata> {
    const parsed = PublicationTokenUpdateSchema.safeParse(input);
    if (!PUBLICATION_TOKEN_ID.test(id) || !parsed.success) throw new PublicationVaultError('PUBLICATION_INVALID');
    return this.change(owner, 'publication-token-update', validate, (document, key) => {
      const index = document.entries.findIndex(entry => entry.id === id && entry.owner === key);
      if (index < 0) throw new PublicationVaultError('PUBLICATION_NOT_FOUND');
      const old = document.entries[index]!; const { label, ...rest } = parsed.data;
      const next = { ...old, ...rest, updatedAt: Date.now() };
      if (label === null) delete next.label; else if (label !== undefined) next.label = label;
      if (document.entries.some(entry => entry.id !== id && entry.owner === key && entry.name === next.name)) throw new PublicationVaultError('PUBLICATION_CONFLICT');
      noSecretMetadata(next, [old.token, next.token]); document.entries[index] = next;
      return { result: metadata(next), id };
    });
  }

  async remove(owner: Owner, id: string, validate: ValidateAuthority): Promise<{ id: string; deleted: true }> {
    if (!PUBLICATION_TOKEN_ID.test(id)) throw new PublicationVaultError('PUBLICATION_INVALID');
    return this.change(owner, 'publication-token-delete', validate, (document, key) => {
      const index = document.entries.findIndex(entry => entry.id === id && entry.owner === key);
      if (index < 0) throw new PublicationVaultError('PUBLICATION_NOT_FOUND');
      document.entries.splice(index, 1); return { result: { id, deleted: true }, id };
    });
  }

  async material(owner: Owner, id: string, validate: ValidateAuthority): Promise<Buffer> {
    try {
      validate();
      if (!PUBLICATION_TOKEN_ID.test(id)) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
      const entry = this.read().value.entries.find(value => value.owner === ownerKey(owner) && value.id === id);
      if (!entry) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
      validate(); return Buffer.from(entry.token, 'ascii');
    } catch (error) { throw error instanceof PublicationVaultError ? error : new PublicationVaultError(); }
  }
}
