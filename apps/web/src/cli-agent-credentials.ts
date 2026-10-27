/** Explicit named-PAT retrieval. Material is never decoded into diagnostics or CLI output. */
import { constants, type Stats } from 'node:fs';
import { open, lstat, mkdir, link, unlink, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';

const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REPO = /^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]{1,100}$/;
export interface GrantedCredentialMetadata {
  id: string;
  name: string;
  repositories: string[];
  label?: string;
  createdAt: number;
  updatedAt: number;
}
export interface GrantedCredentials {
  employeeId: string;
  sessionId: string;
  credentials: GrantedCredentialMetadata[];
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const descriptor = (f: FileHandle, name = '') => `/proc/self/fd/${f.fd}${name ? '/' + name : ''}`;

function refusal(deps: AgentDeps, unknown = false): number {
  const error = unknown
    ? 'Credential installation unconfirmed. The same install can verify or finish matching private files; differing files are refused.'
    : 'Credential access or private destination refused. Existing files were not replaced.';
  if (deps.json) deps.io.out(JSON.stringify({ success: false, error }));
  else deps.io.err(error);
  return unknown ? AGENT_EXIT.error : AGENT_EXIT.refused;
}

/** Metadata only; independently binds current Board identity to the granted-name list. Never retrieves material. */
export async function fetchGrantedCredentials(
  deps: Pick<AgentDeps, 'ctx' | 'request'>,
  /** Internal reuse of the same command's already validated Board identity; never a CLI option. */
  expectedIdentity?: { kind: 'owner' | 'agent'; sessionId?: string; employeeId?: string }
): Promise<GrantedCredentials> {
  let actor: unknown = expectedIdentity;
  if (actor === undefined) {
    const identity = await deps.request(deps.ctx, {
      method: 'GET',
      path: '/api/board',
      bounds: { maxBytes: 1024 * 1024, deadlineMs: 10000 },
    });
    if (identity.status !== 200 || !identity.json?.success) throw Error();
    const data = identity.json.data;
    actor = object(data) && object(data.capabilities) ? data.capabilities.identity : undefined;
  }
  if (
    !object(actor) ||
    actor.kind !== 'agent' ||
    actor.sessionId !== deps.ctx.selfId ||
    typeof actor.employeeId !== 'string' ||
    !actor.employeeId
  )
    throw Error();
  const result = await deps.request(deps.ctx, {
    method: 'GET',
    path: '/api/publication/credentials',
    bounds: { maxBytes: 128 * 1024, deadlineMs: 10000 },
  });
  const list = result.json?.data;
  if (
    result.status !== 200 ||
    !result.json?.success ||
    !object(list) ||
    list.employeeId !== actor.employeeId ||
    list.sessionId !== deps.ctx.selfId ||
    !Array.isArray(list.credentials) ||
    list.credentials.length > 64
  )
    throw Error();
  const ids = new Set<string>(),
    names = new Set<string>();
  const credentials = list.credentials.map((value): GrantedCredentialMetadata => {
    if (
      !object(value) ||
      typeof value.id !== 'string' ||
      !UUID.test(value.id) ||
      typeof value.name !== 'string' ||
      !NAME.test(value.name) ||
      ids.has(value.id) ||
      names.has(value.name) ||
      !Array.isArray(value.repositories) ||
      value.repositories.length > 50 ||
      value.repositories.some((r) => typeof r !== 'string' || !REPO.test(r)) ||
      (value.label !== undefined &&
        (typeof value.label !== 'string' || value.label.length > 120 || /[\r\n\x00-\x1f]/.test(value.label))) ||
      !Number.isSafeInteger(value.createdAt) ||
      (value.createdAt as number) < 0 ||
      !Number.isSafeInteger(value.updatedAt) ||
      (value.updatedAt as number) < 0
    )
      throw Error();
    ids.add(value.id);
    names.add(value.name);
    // Select metadata explicitly: a malformed server cannot smuggle material through an extra field.
    return {
      id: value.id,
      name: value.name,
      repositories: value.repositories as string[],
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      createdAt: value.createdAt as number,
      updatedAt: value.updatedAt as number,
    };
  });
  return { employeeId: actor.employeeId, sessionId: deps.ctx.selfId, credentials };
}

export async function agentCredentialsList(deps: AgentDeps): Promise<number> {
  try {
    const list = await fetchGrantedCredentials(deps);
    if (deps.json) deps.io.out(JSON.stringify(list));
    else
      deps.io.out(
        list.credentials.length
          ? list.credentials
              .map((c) => `${c.name} (${c.id})${c.repositories.length ? ' — ' + c.repositories.join(', ') : ''}`)
              .join('\n')
          : 'No named GitHub credentials are granted to this expert.'
      );
    return AGENT_EXIT.ok;
  } catch {
    return refusal(deps);
  }
}

/** Anchored directory FDs reject symbolic ancestors and retain the namespace through publication. */
async function destination(home: string) {
  if (!isAbsolute(home) || resolve(home) !== home || process.getuid?.() === undefined) throw Error();
  const uid = process.getuid!();
  const handles: FileHandle[] = [],
    edges: { parent: FileHandle; child: FileHandle; name: string }[] = [];
  const close = async () => {
    for (const h of handles.reverse()) await h.close();
  };
  try {
    let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(current);
    for (const name of home.slice(1).split('/').filter(Boolean)) {
      const child = await open(
        descriptor(current, name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(child);
      edges.push({ parent: current, child, name });
      current = child;
    }
    if ((await current.stat()).uid !== uid) throw Error();
    for (const h of handles) {
      const s = await h.stat();
      if (!s.isDirectory() || ![0, uid].includes(s.uid) || s.mode & 0o022) throw Error();
    }
    for (const name of ['.config', 'reverie', 'credentials', 'github']) {
      const parent = await current.stat();
      if (![0, uid].includes(parent.uid) || parent.mode & 0o022) throw Error();
      try {
        await mkdir(descriptor(current, name), { mode: 0o700 });
        await current.sync();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const child = await open(
        descriptor(current, name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(child);
      edges.push({ parent: current, child, name });
      current = child;
    }
    const check = async () => {
      for (const h of handles) {
        const s = await h.stat();
        if (!s.isDirectory() || ![0, uid].includes(s.uid) || s.mode & 0o022) throw Error();
      }
      for (const edge of edges) {
        const named = await lstat(descriptor(edge.parent, edge.name));
        if (!named.isDirectory() || !same(named, await edge.child.stat())) throw Error();
      }
      const final = await current.stat();
      if (final.uid !== uid || (final.mode & 0o777) !== 0o700) throw Error();
    };
    await check();
    return { handle: current, check, close, path: join(home, '.config/reverie/credentials/github') };
  } catch (e) {
    await close();
    throw e;
  }
}

async function localLock(parent: FileHandle, name: string) {
  const file = await open(
    descriptor(parent, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600
  );
  try {
    const s = await file.stat();
    if (!s.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || s.size !== 0 || (s.mode & 0o777) !== 0o600)
      throw Error();
    await new Promise<void>((yes, no) => {
      const child = spawn(process.env.REVERIE_FLOCK_BIN || 'flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
        env: { PATH: process.env.PATH },
      });
      child.once('error', no);
      child.once('close', (code) => (code === 0 ? yes() : no(Error())));
    });
    if (!same(s, await lstat(descriptor(parent, name)))) throw Error();
    await parent.sync();
    return file;
  } catch (e) {
    await file.close();
    throw e;
  }
}

/** Open/check BOTH targets before reading either: metadata must not alias a token or another secret. */
async function existingPair(parent: FileHandle, names: readonly [string, string], desired: readonly [Buffer, Buffer]) {
  const files: { file: FileHandle; before: Stats; name: string; index: number }[] = [];
  const exists = [false, false];
  try {
    for (const [index, name] of names.entries()) {
      let file: FileHandle;
      try {
        file = await open(descriptor(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      const before = await file.stat();
      files.push({ file, before, name, index });
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > (index === 0 ? 16384 : 4096) ||
        !same(before, await lstat(descriptor(parent, name)))
      )
        throw Error();
      exists[index] = true;
    }
    if (files.length === 2 && same(files[0].before, files[1].before)) throw Error();
    for (const entry of files) {
      const bytes = Buffer.alloc(entry.before.size + 1);
      try {
        const { bytesRead } = await entry.file.read(bytes, 0, bytes.length, 0);
        const after = await entry.file.stat();
        if (
          bytesRead !== entry.before.size ||
          !same(entry.before, after) ||
          after.size !== entry.before.size ||
          after.mtimeMs !== entry.before.mtimeMs ||
          after.ctimeMs !== entry.before.ctimeMs ||
          after.nlink !== 1 ||
          !same(after, await lstat(descriptor(parent, entry.name))) ||
          !bytes.subarray(0, bytesRead).equals(desired[entry.index])
        )
          throw Error();
      } finally {
        bytes.fill(0);
      }
    }
    return exists;
  } finally {
    for (const entry of files) await entry.file.close();
  }
}

/** Exported only to support owned-file fixtures; the CLI never accepts a destination option. */
export async function agentCredentialsInstall(deps: AgentDeps, reference: string, home = homedir()): Promise<number> {
  let anchor: Awaited<ReturnType<typeof destination>> | undefined;
  let lock: FileHandle | undefined;
  let material: Buffer | undefined;
  let publication = false;
  try {
    if (!NAME.test(reference) && !UUID.test(reference)) throw Error();
    const list = await fetchGrantedCredentials(deps);
    const matches = list.credentials.filter((c) => c.id === reference || c.name === reference);
    if (matches.length !== 1) throw Error();
    const selected = matches[0];
    anchor = await destination(home);
    const tokenName = selected.name + '.token',
      metadataName = selected.name + '.json';
    lock = await localLock(anchor.handle, '.' + selected.name + '.install.lock');
    const result = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/publication/credentials/${encodeURIComponent(selected.id)}/material`,
      binary: { maxBytes: 4096, deadlineMs: 10000 },
      headers: { Accept: 'application/octet-stream' },
    });
    material = result.bytes;
    const h = result.headers;
    if (
      result.status !== 200 ||
      !material ||
      material.length < 1 ||
      material.length > 4096 ||
      material.some((byte) => byte < 0x21 || byte > 0x7e) ||
      h?.['content-type']?.split(';')[0] !== 'application/octet-stream' ||
      h?.['cache-control'] !== 'no-store' ||
      h?.['x-reverie-employee-id'] !== list.employeeId ||
      h?.['x-reverie-session-id'] !== list.sessionId ||
      h?.['x-reverie-credential-id'] !== selected.id
    )
      throw Error();
    await anchor.check();
    const names = [metadataName, tokenName] as const;
    const bytes = [
      Buffer.from(JSON.stringify({ id: selected.id, name: selected.name, repositories: selected.repositories }) + '\n'),
      material,
    ] as const;
    const exists = await existingPair(anchor.handle, names, bytes);
    for (const [index, name] of names.entries()) {
      if (exists[index]) continue;
      const temp = '.' + selected.name + '.' + randomUUID() + '.tmp';
      const file = await open(
        descriptor(anchor.handle, temp),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await file.writeFile(bytes[index]);
        await file.sync();
      } finally {
        await file.close();
      }
      await anchor.check();
      publication = true;
      // link is an atomic no-replace publication, even if another writer races the name.
      await link(descriptor(anchor.handle, temp), descriptor(anchor.handle, name));
      await unlink(descriptor(anchor.handle, temp));
      await anchor.handle.sync();
      const s = await lstat(descriptor(anchor.handle, name));
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600) throw Error();
    }
    await anchor.check();
    await existingPair(anchor.handle, names, bytes);
    await lock.close();
    lock = undefined;
    await anchor.close();
    anchor = undefined;
    const receipt = {
      installed: true,
      state: exists.every(Boolean) ? 'ALREADY_INSTALLED' : 'INSTALLED',
      employeeId: list.employeeId,
      sessionId: list.sessionId,
      credential: { id: selected.id, name: selected.name, repositories: selected.repositories },
      path: join(home, '.config/reverie/credentials/github', tokenName),
      note: 'Repositories are owner-declared. Revocation prevents new retrieval; it cannot recall an installed copy.',
    };
    deps.io.out(
      deps.json
        ? JSON.stringify(receipt)
        : `Installed named credential ${selected.name} in the private GitHub credential directory.`
    );
    return AGENT_EXIT.ok;
  } catch {
    return refusal(deps, publication);
  } finally {
    material?.fill(0);
    try {
      await lock?.close();
    } catch {
      /* Never print secret-adjacent errors. */
    }
    try {
      await anchor?.close();
    } catch {
      /* Outcome already classified above. */
    }
  }
}
