/** Actual production metadata I/O only; every external process port is denied. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as storage from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MuxSessionMetadataStore,
  MuxMetadataPublicationUnconfirmedError,
  MuxMetadataReconciliationRefusedError,
} from '../src/mux-session-metadata-store.js';
import type { MuxSession } from '../src/mux-interface.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof storage>('node:fs/promises');
  vi.mocked(storage.open).mockReset().mockImplementation(actual.open);
  vi.mocked(storage.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(storage.unlink).mockReset().mockImplementation(actual.unlink);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function row(name: string): MuxSession {
  return {
    sessionId: 'synthetic-original',
    muxName: 'reverie-synthetic',
    pid: 999_999_997,
    createdAt: 1,
    workingDir: '/synthetic',
    mode: 'shell',
    attached: false,
    name,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mux-writer-'));
  directories.push(directory);
  const file = join(directory, 'mux-sessions.json');
  return { directory, file, store: new MuxSessionMetadataStore(file) };
}

function incident(store: MuxSessionMetadataStore) {
  const status = store.getStatus();
  if (status.kind !== 'unconfirmed') throw new Error('Expected an actual held writer');
  expect(status).toEqual({
    version: 1,
    writerId: expect.any(String),
    kind: 'unconfirmed',
    incidentId: expect.any(String),
    incidentOrdinal: expect.stringMatching(/^[1-9]\d*$/),
  });
  return { status, selector: { writerId: status.writerId, expectedIncidentId: status.incidentId } };
}

const originalManagerCollision = String.raw`
import assert from 'node:assert/strict';
import child from 'node:child_process';
import asyncFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [directory, moduleUrl] = process.argv.slice(1);
assert.ok(directory && moduleUrl);
delete process.env.VITEST;
process.env.REVERIE_DATA_DIR = directory;
const destination = join(directory, 'mux-sessions.json');
const processes = [];
const deny = (...args) => { processes.push(args); throw new Error('No process allowed in metadata fixture'); };
Object.assign(child, {exec:deny, execSync:deny, execFile:deny, execFileSync:deny, spawn:deny, spawnSync:deny});
let release;
const gate = new Promise(resolve => { release = resolve; });
let firstEntered, firstSettled, secondSettled;
const entered = new Promise(resolve => { firstEntered = resolve; });
const firstDone = new Promise(resolve => { firstSettled = resolve; });
const secondDone = new Promise(resolve => { secondSettled = resolve; });
let renames = 0;
const originalRename = asyncFs.rename;
asyncFs.rename = async (from, to) => {
  if (to !== destination) return originalRename(from, to);
  const original = ++renames;
  if (original === 1) { firstEntered(); await gate; }
  try { return await originalRename(from, to); }
  finally { if (original === 1) firstSettled(); else secondSettled(); }
};
syncBuiltinESMExports();
const diagnostics = [];
const originalError = console.error;
console.error = (...args) => {
  diagnostics.push(args.map(value => value instanceof Error ? {name:value.name,code:value.code,message:value.message} : value));
  originalError(...args); // Preserve the real failure diagnostic; never suppress it.
};
const {TmuxManager} = await import(moduleUrl);
const manager = new TmuxManager();
const row = {sessionId:'synthetic-original',muxName:'reverie-synthetic',pid:999999997,
  createdAt:1,workingDir:directory,mode:'shell',attached:false};
manager.registerSession({...row,name:'first'});
await entered;
manager.registerSession({...row,name:'intermediate'});
const latest = {...row,name:'latest'};
manager.registerSession(latest);
latest.name = 'not-requested';
assert.equal(renames,1);
release();
await manager.flushSessionMetadata();
await Promise.all([firstDone,secondDone]);
manager.destroy();
console.log(JSON.stringify({renames,diagnostics,processes:processes.length}));
assert.equal(processes.length,0);
assert.deepEqual(diagnostics,[]);
assert.equal(renames,2);
assert.equal(JSON.parse(await asyncFs.readFile(destination,'utf8'))[0].name,'latest');
`;

it('orders actual manager metadata publications without losing an original temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mux-metadata-'));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        originalManagerCollision,
        directory,
        new URL('../src/tmux-manager.ts', import.meta.url).href,
      ],
      { timeout: 10_000, maxBuffer: 128 * 1024 }
    );
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ diagnostics: [], processes: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains a committed-but-unconfirmed original error and refuses later metadata writes', async () => {
  const f = await fixture(),
    primary = new Error('private response failure after rename');
  const actual = await vi.importActual<typeof storage>('node:fs/promises');
  vi.mocked(storage.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args);
    throw primary;
  });
  const notice = vi.fn();
  f.store.onStatus(notice);
  f.store.request([row('original')]);
  const failure = await f.store.flush().catch((error) => error);
  expect(failure).toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  expect(failure).toMatchObject({ cause: { error: { error: primary, renameIssued: true } } });
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('original');
  f.store.request([row('later')]);
  await expect(f.store.flush()).rejects.toBe(failure);
  expect(storage.rename).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('original');
  expect(notice).toHaveBeenCalledOnce();
  expect(notice).toHaveBeenCalledWith(incident(f.store).status);
  expect(JSON.stringify(f.store.getStatus())).not.toContain(f.directory);
  expect(JSON.stringify(f.store.getStatus())).not.toContain(primary.message);
});

it('consumes a failed close once and retains its primary plus cleanup error without closing a fresh descriptor', async () => {
  const f = await fixture(),
    primary = new Error('private close answer lost'),
    cleanup = new Error('private unlink refusal');
  const actual = await vi.importActual<typeof storage>('node:fs/promises');
  let fresh: Awaited<ReturnType<typeof actual.open>> | undefined;
  let consumingClose: FileHandle['close'] | undefined;
  vi.mocked(storage.open).mockImplementationOnce(async (...args) => {
    const original = await actual.open(...args),
      close = original.close.bind(original);
    consumingClose = vi.spyOn(original, 'close').mockImplementationOnce(async () => {
      await close();
      fresh = await actual.open(join(f.directory, 'fresh-descriptor'), 'wx+', 0o600);
      await fresh.writeFile('kept');
      throw primary;
    });
    return original;
  });
  vi.mocked(storage.unlink).mockRejectedValueOnce(cleanup);
  try {
    f.store.request([row('original')]);
    const failure = await f.store.flush().catch((error) => error);
    expect(failure).toMatchObject({
      cause: { error: { error: primary, cleanupErrors: [cleanup], renameIssued: false } },
    });
    expect(consumingClose).toHaveBeenCalledOnce();
    expect(storage.rename).not.toHaveBeenCalled();
    expect(fresh).toBeDefined();
    const bytes = Buffer.alloc(4);
    await fresh!.read(bytes, 0, 4, 0);
    expect(bytes.toString()).toBe('kept');
    await expect(f.store.flush()).rejects.toBe(failure);
    expect(consumingClose).toHaveBeenCalledOnce();
  } finally {
    await fresh?.close();
  }
});

it('isolates a failing diagnostic and observers after installing the original hold', async () => {
  const f = await fixture(),
    primary = new Error('private rename failure');
  vi.mocked(storage.rename).mockRejectedValueOnce(primary);
  vi.spyOn(console, 'error').mockImplementationOnce(() => {
    throw new Error('logger failed');
  });
  const delivered = vi.fn();
  f.store.onStatus(() => {
    throw new Error('observer failed');
  });
  f.store.onStatus(delivered);
  f.store.request([row('original')]);
  const failure = await f.store.flush().catch((error) => error);
  expect(failure).toMatchObject({ cause: { error: { error: primary } } });
  expect(delivered).toHaveBeenCalledOnce();
  incident(f.store);
});

it.each(['write', 'file-sync', 'directory-sync', 'directory-close'] as const)(
  'does not acknowledge publication when its actual descriptor %s boundary fails',
  async (phase) => {
    const f = await fixture(),
      primary = new Error('private descriptor boundary failure');
    const actual = await vi.importActual<typeof storage>('node:fs/promises');
    const boundary = vi.fn();
    vi.mocked(storage.open).mockImplementation(async (...args) => {
      const original = await actual.open(...args),
        directory = args[0] === f.directory;
      if (phase === 'write' && !directory)
        vi.spyOn(original, 'writeFile').mockImplementationOnce(async () => {
          boundary();
          throw primary;
        });
      if ((phase === 'file-sync' && !directory) || (phase === 'directory-sync' && directory))
        vi.spyOn(original, 'sync').mockImplementationOnce(async () => {
          boundary();
          throw primary;
        });
      if (phase === 'directory-close' && directory) {
        const close = original.close.bind(original);
        vi.spyOn(original, 'close').mockImplementationOnce(async () => {
          boundary();
          await close();
          throw primary;
        });
      }
      return original;
    });
    f.store.request([row('original')]);
    const failure = await f.store.flush().catch((error) => error);
    expect(boundary).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({
      cause: { error: { error: primary, renameIssued: phase.startsWith('directory') } },
    });
    incident(f.store);
    if (phase.startsWith('directory')) expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('original');
    else expect(storage.rename).not.toHaveBeenCalled();
  }
);

it('joins the original pending I/O after a later snapshot serialization fails', async () => {
  const f = await fixture(),
    actual = await vi.importActual<typeof storage>('node:fs/promises');
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  vi.mocked(storage.open).mockImplementationOnce(async (...args) => {
    const original = await actual.open(...args),
      write = original.writeFile.bind(original);
    vi.spyOn(original, 'writeFile').mockImplementationOnce(async (...data) => {
      entered();
      await held;
      return write(...data);
    });
    return original;
  });
  f.store.request([row('original')]);
  await writing;
  f.store.request([Object.assign(row('not-serializable'), { unsupported: 1n })]);
  incident(f.store);
  let settled = false;
  const originalOutcome = f.store.flush().then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    }
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); // A notice cannot cancel the already-owned write.
  } finally {
    release();
  }
  expect(await originalOutcome).toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('original');
  expect(storage.rename).toHaveBeenCalledOnce();
});

it('repairs only fresh current observations and returns the same known receipt without replay after reply loss', async () => {
  const f = await fixture();
  vi.mocked(storage.rename).mockRejectedValueOnce(new Error('original rename refused'));
  f.store.request([row('old-attempt')]);
  await expect(f.store.flush()).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  const original = incident(f.store);
  f.store.request([row('queued-but-obsolete')]);
  const rows = vi.fn(() => [row('current-observation')]);
  await expect(
    f.store.reconcile({ ...original.selector, writerId: 'another-writer' }, rows, () => true)
  ).rejects.toBeInstanceOf(MuxMetadataReconciliationRefusedError);
  expect(rows).not.toHaveBeenCalled();
  const receipt = await f.store.reconcile(original.selector, rows, () => true);
  expect(receipt).toEqual({
    version: 1,
    writerId: original.status.writerId,
    kind: 'reconciled',
    repairedIncidentId: original.status.incidentId,
    repairedThrough: '1',
  });
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('current-observation');
  expect(storage.rename).toHaveBeenCalledTimes(2);
  const readsBeforeReplyRetry = rows.mock.calls.length;
  expect(await f.store.reconcile(original.selector, rows, () => true)).toBe(receipt);
  expect(rows).toHaveBeenCalledTimes(readsBeforeReplyRetry);
  expect(storage.rename).toHaveBeenCalledTimes(2);
  await expect(f.store.reconcile(original.selector, rows, () => false)).rejects.toBeInstanceOf(
    MuxMetadataReconciliationRefusedError
  );
  f.store.request([row('normal-later')]);
  await f.store.flush();
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('normal-later');
  expect(f.store.getStatus()).toBe(receipt); // Known repair evidence survives later ordinary observations.
});

it('joins an original active write before repairing and denies a concurrent repair owner', async () => {
  const f = await fixture(),
    actual = await vi.importActual<typeof storage>('node:fs/promises');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(storage.rename).mockImplementationOnce(async (...args) => {
    enter();
    await gate;
    return actual.rename(...args);
  });
  f.store.request([row('original-pending')]);
  await entered;
  f.store.request([Object.assign(row('bad-snapshot'), { unsupported: 1n })]);
  const original = incident(f.store),
    rows = vi.fn(() => [row('fresh-after-settlement')]);
  const repair = f.store.reconcile(original.selector, rows, () => true);
  try {
    await expect(f.store.reconcile(original.selector, rows, () => true)).rejects.toMatchObject({ reason: 'busy' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rows).not.toHaveBeenCalled();
    expect(storage.rename).toHaveBeenCalledOnce();
  } finally {
    release();
  }
  await repair;
  expect(rows).toHaveBeenCalled();
  expect(storage.rename).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('fresh-after-settlement');
});

it('refuses revoked repair before rename without clearing the original incident or retrying a consumed close', async () => {
  const f = await fixture(),
    actual = await vi.importActual<typeof storage>('node:fs/promises');
  vi.mocked(storage.rename).mockRejectedValueOnce(new Error('original held'));
  f.store.request([row('old')]);
  await expect(f.store.flush()).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  const original = incident(f.store);
  let allowed = true;
  const closeCalls = vi.fn();
  vi.mocked(storage.open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args),
      close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      closeCalls();
      await close();
      allowed = false;
    });
    return file;
  });
  await expect(
    f.store.reconcile(
      original.selector,
      () => [row('current')],
      () => allowed
    )
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(closeCalls).toHaveBeenCalledOnce();
  expect(storage.rename).toHaveBeenCalledOnce();
  expect(f.store.getStatus()).toEqual(original.status);
  await expect(f.store.flush()).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  allowed = true;
  await f.store.reconcile(
    original.selector,
    () => [row('current')],
    () => allowed
  );
  expect(closeCalls).toHaveBeenCalledOnce();
});

it('retains uncertainty after an issued repair changes and never clears a newer incident with an old receipt', async () => {
  const f = await fixture(),
    actual = await vi.importActual<typeof storage>('node:fs/promises');
  vi.mocked(storage.rename).mockRejectedValueOnce(new Error('first held'));
  f.store.request([row('first')]);
  await expect(f.store.flush()).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  const first = incident(f.store);
  vi.mocked(storage.rename).mockImplementationOnce(async (...args) => {
    await actual.rename(...args);
    f.store.request([row('changed-during-issued-repair')]);
  });
  await expect(
    f.store.reconcile(
      first.selector,
      () => [row('issued-current')],
      () => true
    )
  ).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  expect(f.store.getStatus()).toEqual(first.status);
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('issued-current');
  const firstReceipt = await f.store.reconcile(
    first.selector,
    () => [row('latest-current')],
    () => true
  );
  vi.mocked(storage.rename).mockRejectedValueOnce(new Error('second held'));
  f.store.request([row('second')]);
  await expect(f.store.flush()).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  const second = incident(f.store);
  expect(second.status.writerId).toBe(first.status.writerId);
  expect(second.status.incidentOrdinal).toBe('2');
  expect(second.status.incidentId).not.toBe(first.status.incidentId);
  await expect(
    f.store.reconcile(
      first.selector,
      () => [row('must-not-write')],
      () => true
    )
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(f.store.getStatus()).toEqual(second.status);
  expect(firstReceipt.repairedThrough).toBe('1');
  const secondReceipt = await f.store.reconcile(
    second.selector,
    () => [row('current-second')],
    () => true
  );
  expect(secondReceipt.repairedThrough).toBe('2');
  expect(secondReceipt.writerId).toBe(firstReceipt.writerId);
});

it('gives a post-repair observer publication its own original queue operation', async () => {
  const f = await fixture();
  vi.mocked(storage.rename).mockRejectedValueOnce(new Error('original held'));
  f.store.request([row('first')]);
  await expect(f.store.flush()).rejects.toBeInstanceOf(MuxMetadataPublicationUnconfirmedError);
  const original = incident(f.store);
  f.store.onStatus((status) => {
    if (status.kind === 'reconciled') f.store.request([row('observer-current')]);
  });
  await f.store.reconcile(
    original.selector,
    () => [row('repair-current')],
    () => true
  );
  await f.store.flush();
  expect(JSON.parse(await readFile(f.file, 'utf8'))[0].name).toBe('observer-current');
  expect(storage.rename).toHaveBeenCalledTimes(3);
});
