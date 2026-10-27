/** Metadata-only credential references. Token paths are only statted; metadata aliases are refused before any read. */
import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';

const privateFile = (s: Stats, cap: number) =>
  s.isFile() && s.uid === process.getuid?.() && s.nlink === 1 && !(s.mode & 0o077) && s.size >= 0 && s.size <= cap;
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const stableFile = (a: Stats, b: Stats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.nlink === b.nlink &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const descriptorPath = (handle: FileHandle, name = '') => `/proc/self/fd/${handle.fd}${name ? '/' + name : ''}`;

async function anchoredDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw Error('Noncanonical directory');
  const handles: FileHandle[] = [];
  const edges: { parent: FileHandle; name: string; child: FileHandle }[] = [];
  const close = async () => {
    for (const handle of handles.reverse()) await handle.close();
  };
  const check = async () => {
    const final = await handles[handles.length - 1].stat();
    if (final.uid !== process.getuid?.() || final.mode & 0o077) throw Error('Directory privacy changed');
    for (const edge of edges) {
      const named = await fs.lstat(descriptorPath(edge.parent, edge.name));
      if (!named.isDirectory() || !sameIdentity(named, await edge.child.stat())) throw Error('Directory changed');
    }
  };
  try {
    let current = await fs.open(
      parse(directory).root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    handles.push(current);
    for (const name of directory.slice(parse(directory).root.length).split('/').filter(Boolean)) {
      const child = await fs.open(
        descriptorPath(current, name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(child);
      edges.push({ parent: current, name, child });
      current = child;
    }
    const info = await current.stat();
    if (info.uid !== process.getuid?.() || info.mode & 0o077) throw Error('Directory is not private');
    await check();
    return { handle: current, check, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function metadata(directory: FileHandle, name: string, tokenInodes: Stats[]) {
  const path = descriptorPath(directory, name + '.json');
  let handle: FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !privateFile(before, 16384) ||
      tokenInodes.some((token) => sameIdentity(token, before)) ||
      !stableFile(before, await fs.lstat(path))
    )
      throw Error('Unsafe metadata');
    const buffer = Buffer.alloc(16385);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 16384 || !stableFile(before, await handle.stat()) || !stableFile(before, await fs.lstat(path)))
      throw Error('Metadata changed or exceeded its bound');
    const value = JSON.parse(buffer.subarray(0, used).toString('utf8'));
    return Array.isArray(value.repositories)
      ? value.repositories
          .slice(0, 50)
          .filter(
            (repo: unknown): repo is string =>
              typeof repo === 'string' && /^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]{1,100}$/.test(repo)
          )
      : undefined;
  } finally {
    await handle.close();
  }
}

export async function credentialReferences(directory: string) {
  const anchor = await anchoredDirectory(directory);
  try {
    const entries: string[] = [];
    // Stop enumeration itself at the bound, before collecting an unbounded directory.
    for await (const entry of await fs.opendir(descriptorPath(anchor.handle))) {
      if (entries.length === 128) throw Error('Credential directory exceeds its bound');
      entries.push(entry.name);
    }
    const tokens = [];
    for (const name of entries.sort()) {
      if (!/^[a-z][a-z0-9-]{0,47}\.token$/.test(name)) continue;
      const info = await fs.lstat(descriptorPath(anchor.handle, name));
      if (privateFile(info, 65536) && info.size > 0) tokens.push({ name, info });
    }
    const bindings = [];
    for (const token of tokens.slice(0, 64)) {
      try {
        await anchor.check();
        const name = token.name.slice(0, -6);
        const declaredRepositories = await metadata(
          anchor.handle,
          name,
          tokens.map((t) => t.info)
        );
        if (!stableFile(token.info, await fs.lstat(descriptorPath(anchor.handle, token.name)))) continue;
        await anchor.check();
        bindings.push({
          name,
          path: join(directory, token.name),
          ...(declaredRepositories ? { declaredRepositories } : {}),
        });
      } catch {
        /* Invalid/aliased/drifting metadata never produces a binding or a scope claim. */
      }
    }
    await anchor.check();
    return bindings;
  } finally {
    await anchor.close();
  }
}
