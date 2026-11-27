import { z } from 'zod';
import { resourceCapacityHistory } from './helpers/docker-resource-capacity.js';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { DockerSingleAttemptTask } from '../src/docker-continuation-task.js';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import {
  DockerResourceRevisionStore,
  dockerRevisedPolicy,
  dockerDefaultPublicationRefusal,
  dockerAttemptPublicationRefusal,
  dockerResourceAttemptKey,
  dockerResourceCapacityWitnesses,
  DockerResourceAttempt,
  DockerResourceLeafIdentity,
  DockerResourceAttemptMaximumBytes,
  DockerResourceDesiredRevision,
  DockerResourceLedgerByteLimit,
  dockerResourceLedgerCapacity,
} from '../src/docker-resource-revisions.js';
const first = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222';
const desired = {
  revision: first,
  owner: null,
  scope: 'all-current-and-future' as const,
  memoryHighBytes: 48 * 1024 ** 3,
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function root() {
  const value = fs.mkdtempSync(join(tmpdir(), 'resource-ledger-'));
  cleanups.push(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
function fixture() {
  const directory = root(),
    path = join(directory, 'ledger'),
    store = new DockerResourceRevisionStore(path);
  cleanups.push(() => store.close());
  return { directory, path, store };
}
describe('durable owner desired/live revision ledger', () => {
  it('CAS publishes desired-only48 for current/future; unrelated state and old approvals remain intact', async () => {
    const f = fixture();
    fs.writeFileSync(join(f.directory, 'company.json'), 'unchanged');
    await f.store.approve(desired, null, () => {});
    expect(f.store.desired(undefined)).toEqual(desired);
    const before = fs.readFileSync(join(f.path, 'revisions.json'));
    await expect(f.store.approve({ ...desired, revision: second }, null, () => {})).rejects.toThrow('CHANGED');
    expect(fs.readFileSync(join(f.path, 'revisions.json'))).toEqual(before);
    expect(fs.readFileSync(join(f.directory, 'company.json'), 'utf8')).toBe('unchanged');
    expect(f.store.desired('different-owner')).toBeUndefined();
    const next = { ...desired, revision: second, memoryHighBytes: 32 * 1024 ** 3 };
    await f.store.approve(next, first, () => {});
    expect(f.store.desired(undefined)).toEqual(next);
    expect(f.store.revision(undefined, first)).toEqual(desired);
  });
  it('a journal known to exist cannot disappear and silently reset to no desired authority', async () => {
    const f = fixture();
    await f.store.approve(desired, null, () => {});
    fs.renameSync(join(f.path, 'revisions.json'), join(f.path, 'retained-original.json'));
    expect(() => f.store.desired(undefined)).toThrow('PUBLICATION_UNCONFIRMED');
    await expect(f.store.approve({ ...desired, revision: second }, null, () => {})).rejects.toThrow(
      'PUBLICATION_UNCONFIRMED'
    );
    expect(fs.existsSync(join(f.path, 'revisions.json'))).toBe(false);
  });
  it('soft48 never raises an original hard ceiling or changes another limit', () => {
    const policy = {
      memoryMaxBytes: 48 * 1024 ** 3,
      memoryHighBytes: 16 * 1024 ** 3,
      swapMaxBytes: 0,
      pidsMax: 512,
      cpuWeight: 100,
      allowedCpus: [0],
      pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0] },
    };
    expect(dockerRevisedPolicy(policy, desired)).toEqual({ ...policy, memoryHighBytes: desired.memoryHighBytes });
    expect(() => dockerRevisedPolicy({ ...policy, memoryMaxBytes: 8 * 1024 ** 3 }, desired)).toThrow('HARD_LIMIT');
    expect(policy.memoryHighBytes).toBe(16 * 1024 ** 3);
  });
  it('revoked owner refuses before publication', async () => {
    const f = fixture();
    await expect(
      f.store.approve(desired, null, () => {
        throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    expect(f.store.desired(undefined)).toBeUndefined();
  });
  it.each(['symlink', 'hardlink', 'malformed', 'duplicate'] as const)(
    'refuses %s without replacing or repairing',
    async (kind) => {
      const f = fixture(),
        path = join(f.path, 'revisions.json'),
        other = join(f.directory, 'other');
      if (kind === 'symlink') {
        fs.writeFileSync(other, 'private', { mode: 0o600 });
        fs.symlinkSync(other, path);
      } else if (kind === 'hardlink') {
        fs.writeFileSync(other, 'private', { mode: 0o600 });
        fs.linkSync(other, path);
      } else fs.writeFileSync(path, kind === 'duplicate' ? '{"version":1,"version":1}' : '{}', { mode: 0o600 });
      const before = fs.readFileSync(path);
      expect(() => f.store.desired(undefined)).toThrow();
      await expect(f.store.approve(desired, null, () => {})).rejects.toThrow();
      expect(fs.readFileSync(path)).toEqual(before);
    }
  );
  it('lost post-rename fsync reply holds writer; fresh reader sees only a complete record', async () => {
    const f = fixture(),
      native = fs.fsyncSync;
    let renamed = false;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      rename(...args);
      renamed = true;
    });
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      native(fd);
      if (renamed) throw Error('lost fsync reply');
    });
    await expect(f.store.approve(desired, null, () => {})).rejects.toThrow('lost fsync');
    expect(() => f.store.desired(undefined)).toThrow('PUBLICATION_UNCONFIRMED');
    spy.mockRestore();
    const fresh = new DockerResourceRevisionStore(f.path);
    cleanups.push(() => fresh.close());
    expect(fresh.desired(undefined)).toEqual(desired);
  });
  it('consuming close failure is retained without retrying its numeric descriptor', () => {
    const f = fixture(),
      native = fs.closeSync,
      error = Error('lost close');
    const spy = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      native(fd);
      throw error;
    });
    expect(() => f.store.close()).toThrow(error);
    const calls = spy.mock.calls.length;
    expect(() => f.store.close()).toThrow(error);
    expect(spy).toHaveBeenCalledTimes(calls);
    spy.mockRestore();
    cleanups.pop();
  });
});
let bundle: string, bundleRoot: string;
beforeAll(() => {
  bundleRoot = fs.mkdtempSync(join(tmpdir(), 'resource-ledger-child-'));
  bundle = join(bundleRoot, 'ledger.mjs');
  buildSync({
    entryPoints: [resolve('src/docker-resource-revisions.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
});
afterAll(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
const childProgram =
  "import fs from 'node:fs';\nconst [bundle,path,phase,revision] = process.argv.slice(1);\nconst {DockerResourceRevisionStore} = await import('file://' + bundle);\nlet renamed=false;\nconst pathOf=fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd)}catch{return ''}};\nconst die=()=>process.kill(process.pid,'SIGKILL');\nconst sync=fs.fsyncSync,close=fs.closeSync,rename=fs.renameSync;\nfs.fsyncSync=fd=>{const name=pathOf(fd);sync(fd);if(phase==='file-sync'&&name.includes('.stage-'))die();if(phase==='directory-sync'&&renamed)die()};\nfs.closeSync=fd=>{const name=pathOf(fd);close(fd);if(phase==='file-close'&&name.includes('.stage-'))die();if(phase==='lock-close'&&renamed&&name.endsWith('writer.lock'))die()};\nfs.renameSync=(...args)=>{if(phase==='before-rename')die();rename(...args);renamed=true;if(phase==='after-rename')die()};\nconst store=new DockerResourceRevisionStore(path);\ntry{await store.approve({revision,owner:null,scope:'all-current-and-future',memoryHighBytes:48*1024**3},null,()=>{});store.close()}\ncatch{process.exitCode=2;try{store.close()}catch{}}\n";

describe('actual child-process death and concurrent publication', () => {
  it.each(['file-sync', 'file-close', 'before-rename', 'after-rename', 'directory-sync', 'lock-close'])(
    'SIGKILL at %s leaves absent/complete publication and a working fresh restart',
    async (phase) => {
      const directory = root(),
        path = join(directory, 'ledger');
      let signal: unknown;
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', childProgram, bundle, path, phase, first], {
          timeout: 10_000,
          stdio: 'pipe',
          maxBuffer: 4096,
        });
      } catch (error) {
        signal = (error as { signal?: unknown }).signal;
      }
      expect(signal).toBe('SIGKILL');
      const published = ['after-rename', 'directory-sync', 'lock-close'].includes(phase);
      expect(fs.existsSync(join(path, 'revisions.json'))).toBe(published);
      const fresh = new DockerResourceRevisionStore(path);
      cleanups.push(() => fresh.close());
      if (published) expect(fresh.desired(undefined)).toEqual(desired);
      else {
        expect(fresh.desired(undefined)).toBeUndefined();
        expect(fs.readdirSync(path).some((name) => name.startsWith('.stage-'))).toBe(true);
        await fresh.approve({ ...desired, revision: second }, null, () => {});
        expect(fresh.desired(undefined)?.revision).toBe(second);
      }
      expect(fs.statSync(join(path, 'revisions.json')).nlink).toBe(1);
    }
  );
  it('two real constructors with the same expected revision publish one complete winner', async () => {
    const path = join(root(), 'ledger');
    const run = (revision: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', childProgram, bundle, path, 'normal', revision],
          { stdio: 'ignore' }
        );
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    expect((await Promise.all([run(first), run(second)])).sort()).toEqual([0, 2]);
    const fresh = new DockerResourceRevisionStore(path);
    cleanups.push(() => fresh.close());
    expect([first, second]).toContain(fresh.desired(undefined)?.revision);
    expect(fs.statSync(join(path, 'revisions.json')).nlink).toBe(1);
  });
});

describe('default approval advisory shares canonical publication refusal', () => {
  it('full retained desired history disables approval and refuses before any replacement', async () => {
    const f = fixture();
    const history = Array.from({ length: 256 }, (_, i) => ({
      ...desired,
      revision: '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'),
    }));
    const path = join(f.path, 'revisions.json');
    fs.writeFileSync(
      path,
      JSON.stringify({ version: 1, purpose: 'reverie-docker-resource-revisions-v1', desired: history, attempts: [] }),
      { mode: 0o600 }
    );
    const before = fs.readFileSync(path);
    expect(f.store.canApprove(undefined)).toBe(false);
    await expect(f.store.approve({ ...desired, revision: second }, history.at(-1)!.revision, () => {})).rejects.toThrow(
      'CAPACITY'
    );
    expect(fs.readFileSync(path)).toEqual(before);
  });
});

describe('default refusal is scoped to its own locked validation', () => {
  it('wire DATA cannot mint a not-issued outcome and a retained genuine error cannot describe a later publication', async () => {
    const f = fixture();
    await f.store.approve(desired, null, () => {});
    let retained: unknown;
    try {
      await f.store.approve({ ...desired, revision: second }, null, () => {});
    } catch (error) {
      retained = error;
    }
    const wire = dockerDefaultPublicationRefusal(retained);
    expect(wire).toMatchObject({ revision: second, publication: 'not-issued', action: 'approve-default' });
    expect(dockerDefaultPublicationRefusal(wire)).toBeUndefined();
    const native = fs.renameSync;
    let renamed = false;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      native(...args);
      renamed = true;
    });
    let failed: unknown;
    try {
      await f.store.approve({ ...desired, revision: second }, first, () => {
        if (renamed) throw retained;
      });
    } catch (error) {
      failed = error;
    } finally {
      rename.mockRestore();
    }
    expect(failed).toBeInstanceOf(AggregateError);
    expect(dockerDefaultPublicationRefusal(failed)).toBeUndefined();
    const actual = JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'));
    expect(actual.desired.at(-1).revision).toBe(second);
  });
});

describe('consuming close cannot replay an earlier default refusal', () => {
  it('a genuine retained prewrite error thrown after a successful publication is unknown', async () => {
    const f = fixture();
    await f.store.approve(desired, null, () => {});
    let retained: unknown;
    try {
      await f.store.approve({ ...desired, revision: second }, null, () => {});
    } catch (error) {
      retained = error;
    }
    const native = fs.closeSync;
    const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      let own = false;
      try {
        own = fs.readlinkSync('/proc/self/fd/' + fd) === join(f.path, 'writer.lock');
      } catch {
        /* Unrelated descriptor. */
      }
      native(fd);
      if (own) throw retained;
    });
    let error: unknown;
    try {
      await f.store.approve({ ...desired, revision: second }, first, () => {});
    } catch (cause) {
      error = cause;
    } finally {
      close.mockRestore();
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect(dockerDefaultPublicationRefusal(error)).toBeUndefined();
    const actual = JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'));
    expect(actual.desired.at(-1).revision).toBe(second);
  });
});

function capacityRow(index = 0) {
  const employeeId = '10000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
  const sid = '20000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
  const operationId = '30000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
  const original = {
    containerId: 'a'.repeat(64),
    imageId: 'sha256:' + 'b'.repeat(64),
    deployment: 'capacity-fixture',
    employeeId,
    sessionId: sid,
    home: { type: 'bind', source: '/synthetic/home', destination: '/home/agent', readWrite: true },
    mountDigest: 'e'.repeat(64),
    storageDigest: 'f'.repeat(64),
    configurationDigest: 'e'.repeat(64),
  };
  const policy = {
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  };
  return DockerEmployeeContinuationRecord.parse({
    version: 1,
    purpose: 'docker-employee-continuation-v1',
    employeeId,
    request: {
      operationId,
      sessionId: sid,
      sessionGeneration: Number.MAX_SAFE_INTEGER,
      containerId: original.containerId,
      imageId: original.imageId,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: 'sha256:' + 'd'.repeat(64),
      enterOffice: true,
    },
    original,
    destination: {
      ...original,
      containerId: (index === 0 ? 'c' : 'd').repeat(64),
      imageId: 'sha256:' + 'd'.repeat(64),
    },
    sourceDigest: 'e'.repeat(64),
    credentialId: '40000000-0000-4000-8000-000000000000',
    workerImage: {
      imageId: 'sha256:' + 'd'.repeat(64),
      sourceImageId: original.imageId,
      clientManifestDigest: 'f'.repeat(64),
    },
    policy,
    phase: 'ready',
  });
}
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const capacityHistory = (freeBytes: number) => resourceCapacityHistory(desired, freeBytes);
describe('schema-derived settlement capacity', () => {
  it('covers every schema variant and task phase at maximal JSON encoding', () => {
    const witnesses = dockerResourceCapacityWitnesses();
    expect(new Set(witnesses.map((value) => value.state))).toEqual(
      new Set(DockerResourceAttempt.options.map((option) => option.shape.state.value))
    );
    expect(
      new Set(witnesses.filter((value) => 'task' in value).map((value) => 'task' in value && value.task.phase))
    ).toEqual(new Set(DockerSingleAttemptTask.options.map((option) => option.shape.phase.value)));
    expect(Math.max(...witnesses.map(byteSize))).toBe(DockerResourceAttemptMaximumBytes);
    expect(DockerResourceAttemptMaximumBytes).toBe(150170);
    const maximum = witnesses.find((value) => byteSize(value) === DockerResourceAttemptMaximumBytes)!;
    expect(maximum.state).toBe('observed-after-closure');
    if (maximum.state !== 'observed-after-closure') throw Error('Actual maximum variant required');
    expect(byteSize(maximum.identity)).toBeGreaterThan(3 * 4096 * 6);
    expect(maximum.identity).toEqual(maximum.closure.identity);
    expect(
      DockerResourceLeafIdentity.safeParse({
        ...maximum.identity,
        parent: { ...maximum.identity.parent, path: '\0'.repeat(4097) },
      }).success
    ).toBe(false);
    expect(
      DockerResourceLeafIdentity.safeParse({
        ...maximum.identity,
        anchor: { ...maximum.identity.anchor, pid: Number.MAX_SAFE_INTEGER + 1 },
      }).success
    ).toBe(false);
    expect(
      DockerResourceLeafIdentity.safeParse({
        ...maximum.identity,
        worker: { ...maximum.identity.worker, ino: '9'.repeat(21) },
      }).success
    ).toBe(false);
    expect(DockerSingleAttemptTask.safeParse({ ...maximum.task, name: maximum.task.name + 'z' }).success).toBe(false);
    expect(
      DockerResourceAttempt.safeParse({ ...maximum, sessionGeneration: Number.MAX_SAFE_INTEGER + 1 }).success
    ).toBe(false);
    const keys = (value: object, schema: { shape: Record<string, unknown> }) =>
      expect(Object.keys(value).sort()).toEqual(Object.keys(schema.shape).sort());
    const checkIdentity = (value: DockerResourceLeafIdentity, schema: typeof DockerResourceLeafIdentity) => {
      keys(value, schema);
      keys(value.parent, schema.shape.parent);
      keys(value.anchor, schema.shape.anchor);
      keys(value.worker, schema.shape.worker);
    };
    const scalarLeaves = (value: object, prefix: string[] = []): Array<{ path: string[]; value: string | number }> =>
      Object.entries(value).flatMap(([key, item]) =>
        typeof item === 'object' && item !== null
          ? scalarLeaves(item as object, [...prefix, key])
          : typeof item === 'string' || typeof item === 'number'
            ? [{ path: [...prefix, key], value: item }]
            : []
      );
    for (const witness of witnesses) {
      const schema = DockerResourceAttempt.options.find((option) => option.shape.state.value === witness.state)!;
      keys(witness, schema);
      if ('task' in witness)
        keys(
          witness.task,
          DockerSingleAttemptTask.options.find((option) => option.shape.phase.value === witness.task.phase)!
        );
      if ('identity' in witness && 'identity' in schema.shape) checkIdentity(witness.identity, schema.shape.identity);
      if ('closure' in witness && 'closure' in schema.shape) {
        keys(witness.closure, schema.shape.closure);
        checkIdentity(witness.closure.identity, schema.shape.closure.shape.identity);
      }
      if ('retirement' in witness && 'retirement' in schema.shape) keys(witness.retirement, schema.shape.retirement);
      if ('originalClosure' in witness && 'originalClosure' in schema.shape) {
        keys(witness.originalClosure, schema.shape.originalClosure);
        keys(witness.originalClosure.originalKey, schema.shape.originalClosure.shape.originalKey);
      }
      if ('originalRetirement' in witness && 'originalRetirement' in schema.shape) {
        keys(witness.originalRetirement, schema.shape.originalRetirement);
        keys(witness.originalRetirement.originalKey, schema.shape.originalRetirement.shape.originalKey);
      }
      for (const leaf of scalarLeaves(witness)) {
        const mutate = (replacement: string | number) => {
          const copy = structuredClone(witness);
          let target = copy as unknown as Record<string, unknown>;
          for (const key of leaf.path.slice(0, -1)) target = target[key] as Record<string, unknown>;
          target[leaf.path.at(-1)!] = replacement;
          return copy;
        };
        const extended = typeof leaf.value === 'number' ? leaf.value + 1 : leaf.value + (leaf.value.at(-1) ?? 'x');
        expect({ path: leaf.path, accepted: DockerResourceAttempt.safeParse(mutate(extended)).success }).toEqual({
          path: leaf.path,
          accepted: false,
        });
        if (typeof leaf.value === 'string' && !leaf.value.includes('\0'))
          expect(DockerResourceAttempt.safeParse(mutate('\0'.repeat(leaf.value.length))).success).toBe(false);
      }
    }
    const maxDesired = { ...desired, owner: '\0'.repeat(200), memoryHighBytes: 1024 ** 4 };
    expect(DockerResourceDesiredRevision.safeParse(maxDesired).success).toBe(true);
    expect(DockerResourceDesiredRevision.safeParse({ ...maxDesired, owner: '\0'.repeat(201) }).success).toBe(false);
    expect(DockerResourceDesiredRevision.safeParse({ ...maxDesired, memoryHighBytes: 1024 ** 4 + 4096 }).success).toBe(
      false
    );
  });
  it('refuses a small initial intent before publication when its complete settlement cannot fit', async () => {
    const f = fixture(),
      row = capacityRow(),
      state = capacityHistory(1024);
    fs.writeFileSync(join(f.path, 'revisions.json'), JSON.stringify(state), { mode: 0o600 });
    const before = fs.readFileSync(join(f.path, 'revisions.json'));
    const task = dockerResourceCapacityWitnesses().find(
      (value) => value.state === 'helper' && value.task.phase === 'create-issued'
    )!;
    if (task.state !== 'helper') throw Error('Actual initial task required');
    let error: unknown;
    try {
      await f.store.publish(
        row,
        desired,
        undefined,
        { ...dockerResourceAttemptKey(row, first), state: 'helper', task: task.task },
        () => {}
      );
    } catch (cause) {
      error = cause;
    }
    expect(dockerAttemptPublicationRefusal(error)).toMatchObject({
      code: 'DOCKER_RESOURCE_REVISION_CAPACITY',
      action: 'apply',
      publication: 'not-issued',
      employeeId: row.employeeId,
      sessionId: row.request.sessionId,
      operationId: row.request.operationId,
      revision: first,
    });
    expect(fs.readFileSync(join(f.path, 'revisions.json'))).toEqual(before);
    expect(f.store.attempt(row, first)).toBeUndefined();
    expect(dockerAttemptPublicationRefusal(dockerAttemptPublicationRefusal(error))).toBeUndefined();
  });
  it('an admitted intent can reach the largest settlement despite another capacity contender', async () => {
    const f = fixture(),
      row = capacityRow(),
      state = capacityHistory(DockerResourceAttemptMaximumBytes + 1024);
    fs.writeFileSync(join(f.path, 'revisions.json'), JSON.stringify(state), { mode: 0o600 });
    const key = dockerResourceAttemptKey(row, first);
    const initial = dockerResourceCapacityWitnesses().find(
      (value) => value.state === 'helper' && value.task.phase === 'create-issued'
    )!;
    if (initial.state !== 'helper') throw Error('Actual task required');
    let before: DockerResourceAttempt = { ...key, state: 'helper', task: initial.task };
    await f.store.publish(row, desired, undefined, before, () => {});
    const reserved = dockerResourceLedgerCapacity(JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8')));
    expect(reserved.reservedBytes).toBe(DockerResourceAttemptMaximumBytes - byteSize(before));
    const other = capacityRow(1);
    await expect(
      f.store.publish(
        other,
        desired,
        undefined,
        {
          ...dockerResourceAttemptKey(other, first),
          state: 'helper',
          task: initial.task,
        },
        () => {}
      )
    ).rejects.toThrow('CAPACITY');
    for (const phase of ['created', 'start-issued', 'completed'] as const) {
      const nextTask = dockerResourceCapacityWitnesses().find(
        (value) => value.state === 'helper' && value.task.phase === phase
      )!;
      if (nextTask.state !== 'helper') throw Error('Actual task required');
      const next: DockerResourceAttempt = { ...key, state: 'helper', task: nextTask.task };
      await f.store.publish(row, desired, before, next, () => {});
      before = next;
    }
    const maximum = dockerResourceCapacityWitnesses().find(
      (value) => byteSize(value) === DockerResourceAttemptMaximumBytes
    )!;
    if (maximum.state !== 'observed-after-closure') throw Error('Maximum schema variant required');
    maximum.identity.worker.id = row.destination!.containerId;
    maximum.closure.identity.worker.id = row.destination!.containerId;
    const closed: DockerResourceAttempt = {
      ...key,
      state: 'closed-writer',
      task: maximum.task,
      closure: maximum.closure,
    };
    await f.store.publish(row, desired, before, closed, () => {});
    const completed: DockerResourceAttempt = { ...maximum, ...key };
    await f.store.publish(row, desired, closed, completed, () => {});
    const actual = JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'));
    expect(byteSize(f.store.attempt(row, first))).toBe(DockerResourceAttemptMaximumBytes);
    expect(dockerResourceLedgerCapacity(actual).requiredBytes).toBeLessThanOrEqual(DockerResourceLedgerByteLimit);
    expect(dockerResourceLedgerCapacity(actual).reservedBytes).toBe(0);
  });
  it('releases only old immutable terminal reserve when a fresh owner revision is published', async () => {
    const f = fixture(),
      row = capacityRow();
    await f.store.approve(desired, null, () => {});
    const key = dockerResourceAttemptKey(row, first);
    let before: DockerResourceAttempt | undefined;
    for (const phase of ['create-issued', 'created', 'start-issued', 'completed'] as const) {
      const sample = dockerResourceCapacityWitnesses().find(
        (value) => value.state === 'helper' && value.task.phase === phase
      )!;
      if (sample.state !== 'helper') throw Error('Actual task required');
      const next: DockerResourceAttempt = { ...key, state: 'helper', task: sample.task };
      await f.store.publish(row, desired, before, next, () => {});
      before = next;
    }
    const sample = dockerResourceCapacityWitnesses().find(
      (value) => value.state === 'closed-writer' && value.task.phase === 'completed'
    )!;
    if (sample.state !== 'closed-writer') throw Error('Actual terminal record required');
    sample.closure.identity.worker.id = row.destination!.containerId;
    const closed: DockerResourceAttempt = { ...sample, ...key };
    await f.store.publish(row, desired, before, closed, () => {});
    const firstBytes = fs.readFileSync(join(f.path, 'revisions.json'), 'utf8');
    expect(dockerResourceLedgerCapacity(JSON.parse(firstBytes)).reservedBytes).toBeGreaterThan(0);
    const reserved = dockerResourceLedgerCapacity(JSON.parse(firstBytes)).reservedBytes;
    await f.store.approve(
      { ...desired, owner: 'other-owner', revision: '33333333-3333-4333-8333-333333333333' },
      null,
      () => {}
    );
    expect(
      dockerResourceLedgerCapacity(JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'))).reservedBytes
    ).toBe(reserved);
    await f.store.approve({ ...desired, revision: second }, first, () => {});
    const after = JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'));
    expect(dockerResourceLedgerCapacity(after).reservedBytes).toBe(0);
    expect(f.store.attempt(row, first)).toEqual(closed);
  });
  it('byte-full default history disables approval with a genuine prewrite refusal', async () => {
    const f = fixture(),
      state = capacityHistory(50);
    fs.writeFileSync(join(f.path, 'revisions.json'), JSON.stringify(state), { mode: 0o600 });
    expect(f.store.canApprove(undefined)).toBe(false);
    let error: unknown;
    try {
      await f.store.approve({ ...desired, revision: second }, first, () => {});
    } catch (cause) {
      error = cause;
    }
    expect(dockerDefaultPublicationRefusal(error)).toMatchObject({ revision: second, publication: 'not-issued' });
  });
});

describe('reserve-aware journal version publication', () => {
  it('reads accepted version1 without rewriting, then publishes2 preserving existing histories', async () => {
    const f = fixture(),
      old = { version: 1, purpose: 'reverie-docker-resource-revisions-v1', desired: [desired], attempts: [] };
    const bytes = Buffer.from(JSON.stringify(old));
    fs.writeFileSync(join(f.path, 'revisions.json'), bytes, { mode: 0o600 });
    expect(f.store.desired(undefined)).toEqual(desired);
    expect(fs.readFileSync(join(f.path, 'revisions.json'))).toEqual(bytes);
    await f.store.approve({ ...desired, revision: second }, first, () => {});
    const actual = JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'));
    expect(actual.version).toBe(2);
    expect(actual.desired).toEqual([desired, { ...desired, revision: second }]);
    // This is the exact earliest frozen-fourth envelope guard, not a native-effect simulation.
    expect(
      z
        .object({ version: z.literal(1) })
        .passthrough()
        .safeParse(actual).success
    ).toBe(false);
  });
  it('an observed version2 cannot be downgraded to1 or rewritten through that reader', async () => {
    const f = fixture();
    await f.store.approve(desired, null, () => {});
    const actual = JSON.parse(fs.readFileSync(join(f.path, 'revisions.json'), 'utf8'));
    expect(actual.version).toBe(2);
    const changed = Buffer.from(JSON.stringify({ ...actual, version: 1 }));
    fs.writeFileSync(join(f.path, 'revisions.json'), changed);
    expect(() => f.store.desired(undefined)).toThrow('FORMAT_CHANGED');
    await expect(f.store.approve({ ...desired, revision: second }, first, () => {})).rejects.toThrow(
      'PUBLICATION_UNCONFIRMED'
    );
    expect(fs.readFileSync(join(f.path, 'revisions.json'))).toEqual(changed);
  });
});

describe('cross-constructor settlement reservation', () => {
  it('admits only one concurrent intent, then makes room after its bounded immutable settlement', async () => {
    const f = fixture(),
      state = capacityHistory(DockerResourceAttemptMaximumBytes + 8192),
      row = capacityRow(),
      otherRow = capacityRow(1);
    fs.writeFileSync(join(f.path, 'revisions.json'), JSON.stringify(state), { mode: 0o600 });
    const other = new DockerResourceRevisionStore(f.path);
    cleanups.push(() => other.close());
    const sample = dockerResourceCapacityWitnesses().find(
      (value) => value.state === 'helper' && value.task.phase === 'create-issued'
    )!;
    if (sample.state !== 'helper') throw Error('Initial task DATA required');
    const publish = (store: DockerResourceRevisionStore, target: ReturnType<typeof capacityRow>) =>
      store.publish(
        target,
        desired,
        undefined,
        {
          ...dockerResourceAttemptKey(target, first),
          state: 'helper',
          task: sample.task,
        },
        () => {}
      );
    const outcomes = await Promise.allSettled([publish(f.store, row), publish(other, otherRow)]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes[0]!.status === 'fulfilled' ? { store: f.store, row } : { store: other, row: otherRow };
    const loser = outcomes[0]!.status === 'fulfilled' ? { store: other, row: otherRow } : { store: f.store, row };
    const rejected = outcomes.find((value) => value.status === 'rejected');
    expect(rejected?.status === 'rejected' && dockerAttemptPublicationRefusal(rejected.reason)).toMatchObject({
      publication: 'not-issued',
    });
    const key = dockerResourceAttemptKey(winner.row, first);
    let before = winner.store.attempt(winner.row, first)!;
    for (const phase of ['created', 'start-issued', 'completed'] as const) {
      const task = dockerResourceCapacityWitnesses().find(
        (value) => value.state === 'helper' && value.task.phase === phase
      )!;
      if (task.state !== 'helper') throw Error('Actual phase DATA required');
      const next: DockerResourceAttempt = { ...key, state: 'helper', task: task.task };
      await winner.store.publish(winner.row, desired, before, next, () => {});
      before = next;
    }
    if (before.state !== 'helper' || before.task.phase !== 'completed') throw Error('Completed task DATA required');
    const identity = dockerResourceCapacityWitnesses().find((value) => value.state === 'observed')!;
    if (identity.state !== 'observed') throw Error('Identity DATA required');
    for (const where of [identity.identity.parent, identity.identity.anchor, identity.identity.worker])
      where.path = '/';
    identity.identity.worker.id = winner.row.destination!.containerId;
    await winner.store.publish(
      winner.row,
      desired,
      before,
      { ...key, state: 'applied', task: before.task, identity: identity.identity, observationDigest: 'f'.repeat(64) },
      () => {}
    );
    await expect(publish(loser.store, loser.row)).resolves.toBeUndefined();
  });
});
