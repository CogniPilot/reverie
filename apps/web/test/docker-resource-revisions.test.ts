import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';
import {
  DockerResourceRevisionStore,
  dockerRevisedPolicy,
  dockerDefaultPublicationRefusal,
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
