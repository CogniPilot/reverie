import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalNonceStore, type GoalNonceStoreOptions } from '../src/goal-nonce-store.js';
import { GoalBrokerAuthentication } from '../src/goal-broker-auth.js';
import { createHash, createHmac } from 'node:crypto';

const STORE_ID = '11111111-2222-4333-8444-555555555555';
const FLOCK = fs.realpathSync(
  (process.env.PATH ?? '')
    .split(':')
    .map((item) => join(item, 'flock'))
    .find((item) => fs.existsSync(item))!
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(capacity = 4) {
  const root = fs.mkdtempSync(join(tmpdir(), 'goal-nonce-fixture-'));
  roots.push(root);
  const file = join(root, 'nonces.json');
  // Explicit synthetic fixture preparation only, not a production initializer.
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, storeId: STORE_ID, capacity, revision: 0, clockFloor: 100_000, entries: [] })
  );
  fs.writeFileSync(file + '.lock', '');
  let now = 100_000;
  let custody = true;
  let checked = 0;
  let onCheck = () => {};
  const options: GoalNonceStoreOptions = {
    file,
    storeId: STORE_ID,
    capacity,
    flockExecutable: FLOCK,
    authorityNamespace: root + '/authority',
    now: () => now,
    assertPrivateCustody: (scope) => {
      checked++;
      expect(scope).toEqual({
        root,
        parent: dirname(root),
        file,
        lock: file + '.lock',
        temporary: file + '.pending',
        authorityNamespace: root + '/authority',
      });
      onCheck();
      if (!custody) throw Error('private synthetic custody absent');
    },
  };
  const store = new GoalNonceStore(options);
  return {
    root,
    file,
    options,
    store,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    setNow: (value: number) => {
      now = value;
    },
    setCustody: (value: boolean) => {
      custody = value;
    },
    setCheck: (value: () => void) => {
      onCheck = value;
    },
    checks: () => checked,
  };
}
const key = (letter = 'a', expiresAt = 110_000) => ({
  issuer: 'test-broker',
  epoch: 'test-epoch',
  nonce: letter.repeat(32),
  expiresAt,
});
const refused = (promise: Promise<unknown>) =>
  expect(promise).rejects.toThrow('Private durable Goal nonce storage unavailable');
function child(
  f: ReturnType<typeof fixture>,
  overrides = {}
): Promise<{ accepted?: boolean; refused?: boolean; crashed?: boolean; point?: string; audited?: number }> {
  return new Promise((done, reject) => {
    const process = spawn('node', ['--import', 'tsx', 'test/fixtures/goal-nonce-child.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: globalThis.process.env.PATH,
        HOME: globalThis.process.env.HOME,
        NODE_OPTIONS: '--max-old-space-size=96',
        GOMAXPROCS: '1',
        ESBUILD_WORKER_THREADS: '0',
      },
      timeout: 8000,
      killSignal: 'SIGKILL',
    });
    let output = '',
      errors = '';
    process.stdout.on('data', (bytes) => {
      output += bytes;
    });
    process.stderr.on('data', (bytes) => {
      errors += bytes;
    });
    process.once('error', reject);
    process.once('close', (code) => {
      if (code !== 0 && code !== 23) return reject(Error('synthetic child failed: ' + errors));
      try {
        done(JSON.parse(output));
      } catch {
        reject(Error('synthetic child output invalid'));
      }
    });
    process.stdin.end(
      JSON.stringify({
        file: f.file,
        capacity: f.options.capacity,
        storeId: STORE_ID,
        flockExecutable: FLOCK,
        now: 100_000,
        nonce: 'a'.repeat(32),
        expiresAt: 110_000,
        ...overrides,
      })
    );
  });
}

describe('private durable Goal nonce store', () => {
  it('constructor performs no custody or filesystem operations, unavailable default denies', async () => {
    const f = fixture();
    expect(f.checks()).toBe(0);
    await refused(new GoalNonceStore().claim(key()));
    f.setCustody(false);
    const before = fs.readFileSync(f.file, 'utf8');
    await refused(f.store.claim(key()));
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    expect(fs.existsSync(f.file + '.pending')).toBe(false);
  });

  it('does not treat0777 file mode or private-looking paths as custody', async () => {
    const f = fixture();
    fs.chmodSync(f.file, 0o777);
    f.setCustody(false);
    await refused(f.store.claim(key()));
    expect(f.read().entries).toEqual([]);
  });

  it('atomically inserts and checks an opaque exact claim against durable state', async () => {
    const f = fixture();
    const handle = (await f.store.claim(key()))!;
    expect(handle).toEqual({});
    expect(Object.isFrozen(handle)).toBe(true);
    f.store.assertCurrent(handle, key());
    expect(() => f.store.assertCurrent({}, key())).toThrow();
    expect(() => f.store.assertCurrent(handle, key('b'))).toThrow();
    expect(() => f.store.assertCurrent(handle, key('a', 109_999))).toThrow();
    expect(f.read().entries).toHaveLength(1);
    expect(fs.readFileSync(f.file, 'utf8')).not.toContain('a'.repeat(32));
    expect(f.checks()).toBeGreaterThan(10);
  });

  it('duplicate attempts and replacement instances cannot reclaim a persisted nonce', async () => {
    const f = fixture();
    expect(await f.store.claim(key())).toBeTruthy();
    expect(await f.store.claim(key())).toBeUndefined();
    expect(await new GoalNonceStore(f.options).claim(key())).toBeUndefined();
  });

  it('two actual simultaneous processes elect one winner; restart still refuses replay', async () => {
    const f = fixture();
    const results = await Promise.all([child(f), child(f)]);
    expect(results.filter((item) => item.accepted)).toHaveLength(1);
    expect(results.filter((item) => item.accepted === false)).toHaveLength(1);
    expect(await child(f)).toEqual({ accepted: false });
    expect(f.read().entries).toHaveLength(1);
  });

  it('separate processes do not lose distinct acknowledged nonce inserts', async () => {
    const f = fixture();
    const results = await Promise.all([child(f), child(f, { nonce: 'b'.repeat(32) })]);
    expect(results).toEqual([{ accepted: true }, { accepted: true }]);
    expect(f.read().entries).toHaveLength(2);
  });

  it('process death after durable commit but before acknowledgement still burns the nonce', async () => {
    const f = fixture();
    expect(await child(f, { crashPoint: 'durable' })).toEqual({ crashed: true, point: 'durable' });
    expect(f.read().entries).toHaveLength(1);
    expect(await child(f)).toEqual({ accepted: false });
    expect(await child(f, { nonce: 'b'.repeat(32) })).toEqual({ accepted: true });
  });

  it('process death before rename leaves one staging file and no false acknowledgement', async () => {
    const f = fixture();
    expect(await child(f, { crashPoint: 'temporary' })).toEqual({ crashed: true, point: 'temporary' });
    expect(f.read().entries).toHaveLength(0);
    expect(fs.existsSync(f.file + '.pending')).toBe(true);
    expect(await child(f)).toEqual({ refused: true });
    expect(f.read().entries).toHaveLength(0);
    expect(fs.readdirSync(f.root).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
  });

  it('actual storage syscalls each have a new whole-namespace custody proof', async () => {
    const f = fixture();
    const result = await child(f, { auditIO: true });
    expect(result.accepted).toBe(true);
    expect(result.audited).toBeGreaterThan(15);
  });

  it('held cross-process lock refuses boundedly, and process death releases it for later work', async () => {
    const f = fixture();
    const handle = (await f.store.claim(key()))!;
    const held = spawn('node', ['--import', 'tsx', 'test/fixtures/goal-nonce-child.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
      killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--max-old-space-size=96', GOMAXPROCS: '1' },
    });
    const ended = new Promise<void>((done) => held.once('close', () => done()));
    try {
      const ready = new Promise<void>((done, reject) => {
        let text = '';
        held.stdout.on('data', (bytes) => {
          text += bytes;
          if (text.includes('LOCKED\n')) done();
        });
        held.once('error', reject);
        held.once('close', (code) => {
          if (!text.includes('LOCKED\n')) reject(Error('fixture lock unavailable: ' + code));
        });
      });
      held.stdin.end(
        JSON.stringify({
          file: f.file,
          capacity: f.options.capacity,
          storeId: STORE_ID,
          flockExecutable: FLOCK,
          now: 100_000,
          holdLock: true,
        })
      );
      await ready;
      await refused(f.store.claim(key('b')));
      expect(() => f.store.assertCurrent(handle, key())).toThrow();
    } finally {
      held.kill('SIGKILL');
      await ended;
    }
    f.store.assertCurrent(handle, key());
    expect(await f.store.claim(key('b'))).toBeTruthy();
  });

  it('rejects malformed nonce metadata before any private storage access', async () => {
    const f = fixture();
    for (const supplied of [
      { ...key(), nonce: 'short' },
      { ...key(), issuer: 'test-broker\n' },
      { ...key(), expiresAt: NaN },
      { ...key(), unknown: 'not stored' },
    ]) {
      await refused(f.store.claim(supplied));
    }
    expect(f.checks()).toBe(0);
  });

  it('fixed capacity refuses new claims without evicting an unexpired owner', async () => {
    const f = fixture(1);
    const handle = (await f.store.claim(key()))!;
    expect(await f.store.claim(key('b'))).toBeUndefined();
    f.store.assertCurrent(handle, key());
    expect(f.read().entries).toHaveLength(1);
    await refused(new GoalNonceStore({ ...f.options, capacity: 2 }).claim(key('b')));
  });

  it('only expired records are pruned, including by another process', async () => {
    const f = fixture(2);
    const expired = (await f.store.claim(key('a', 100_005)))!;
    const active = (await f.store.claim(key('b')))!;
    expect(await child(f, { nonce: 'c'.repeat(32), now: 100_006, expiresAt: 110_006 })).toEqual({ accepted: true });
    f.setNow(100_006);
    expect(() => f.store.assertCurrent(expired, key('a', 100_005))).toThrow();
    f.store.assertCurrent(active, key('b'));
    expect(f.read().entries).toHaveLength(2);
  });

  it('synchronous current checks read fresh state rather than cached claims', async () => {
    const f = fixture();
    const handle = (await f.store.claim(key()))!;
    const state = f.read();
    state.entries[0].claimId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    fs.writeFileSync(f.file, JSON.stringify(state));
    expect(() => f.store.assertCurrent(handle, key())).toThrow();
  });

  it('persists accepted clock floors across current checks, restart and processes', async () => {
    const f = fixture();
    const handle = (await f.store.claim(key()))!;
    f.setNow(100_050);
    f.store.assertCurrent(handle, key());
    expect(f.read().clockFloor).toBe(100_050);
    expect(await child(f, { nonce: 'b'.repeat(32), now: 100_049 })).toEqual({ refused: true });
    f.setNow(100_049);
    expect(() => f.store.assertCurrent(handle, key())).toThrow();
  });

  it.each([NaN, Infinity, -1, 100_000.5])('invalid clock%s refuses without acknowledging a claim', async (now) => {
    const f = fixture();
    f.setNow(now);
    await refused(f.store.claim(key()));
    expect(f.read().entries).toEqual([]);
  });

  it('throws on a clock-source error and on expiry', async () => {
    const f = fixture();
    await refused(
      new GoalNonceStore({
        ...f.options,
        now: () => {
          throw Error('synthetic');
        },
      }).claim(key())
    );
    const handle = (await f.store.claim(key()))!;
    f.setNow(110_000);
    expect(() => f.store.assertCurrent(handle, key())).toThrow();
    await refused(f.store.claim(key('b', 110_000)));
  });

  it.each(['missing', 'corrupt', 'unknown-field', 'wrong-id', 'oversize'] as const)(
    'refuses%s ledger rather than rebuilding it',
    async (mode) => {
      const f = fixture();
      if (mode === 'missing') fs.unlinkSync(f.file);
      if (mode === 'corrupt') fs.writeFileSync(f.file, 'not JSON');
      if (mode === 'unknown-field') fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), untrusted: true }));
      if (mode === 'wrong-id')
        fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), storeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
      if (mode === 'oversize') fs.writeFileSync(f.file, ' '.repeat(4096));
      await refused(f.store.claim(key()));
      expect(fs.existsSync(f.file + '.pending')).toBe(false);
      if (mode === 'missing') expect(fs.existsSync(f.file)).toBe(false);
    }
  );

  it.each(['ledger', 'lock', 'root'] as const)('refuses a symlinked%s', async (mode) => {
    const f = fixture();
    const target = mode === 'ledger' ? f.file : mode === 'lock' ? f.file + '.lock' : f.root;
    const renamed = target + '.original';
    fs.renameSync(target, renamed);
    fs.symlinkSync(renamed, target);
    try {
      await refused(f.store.claim(key()));
    } finally {
      fs.unlinkSync(target);
      fs.renameSync(renamed, target);
    }
  });

  it('missing lock and an existing pending file fail closed without overwrite', async () => {
    const f = fixture();
    fs.unlinkSync(f.file + '.lock');
    await refused(f.store.claim(key()));
    expect(fs.existsSync(f.file + '.lock')).toBe(false);
    fs.writeFileSync(f.file + '.lock', '');
    fs.writeFileSync(f.file + '.pending', 'preserve interrupted staging');
    await refused(f.store.claim(key()));
    expect(fs.readFileSync(f.file + '.pending', 'utf8')).toBe('preserve interrupted staging');
    expect(f.read().entries).toEqual([]);
  });

  it('custody revocation after staging refuses rename and bounded cleanup without authority', async () => {
    const f = fixture();
    f.setCheck(() => {
      if (fs.existsSync(f.file + '.pending')) f.setCustody(false);
    });
    await refused(f.store.claim(key()));
    expect(f.read().entries).toEqual([]);
    expect(fs.existsSync(f.file + '.pending')).toBe(true);
    f.setCheck(() => {});
    f.setCustody(true);
    await refused(f.store.claim(key()));
  });

  it('queued admission is bounded and a rejected slot does not poison later work', async () => {
    const f = fixture(64);
    const results = await Promise.allSettled(
      Array.from({ length: 33 }, (_, index) => f.store.claim({ ...key(), nonce: index.toString(16).padStart(32, '0') }))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await f.store.claim(key('f'))).toBeTruthy();
  });

  it('plugs into real broker authentication and persists replay denial after backend replacement', async () => {
    const f = fixture();
    const body = Buffer.from('{}');
    const secret = Buffer.alloc(32, 7);
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const fields = [
      1,
      'goal-request',
      'test-broker',
      'test-epoch',
      sid,
      7,
      'POST',
      '/api/goals',
      createHash('sha256').update(body).digest('hex'),
      100_000,
      110_000,
      'a'.repeat(32),
    ];
    const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
    const assertion =
      encoded +
      '.' +
      createHmac('sha256', secret)
        .update('reverie-goal-request-v1\n' + encoded)
        .digest('hex');
    const compose = (nonces: GoalNonceStore) =>
      new GoalBrokerAuthentication({
        canonicalFile: f.root + '/company.json',
        issuer: () => ({ epoch: 'test-epoch', key: secret }),
        binding: () => ({ employeeId: 'worker', sessionId: sid, sessionGeneration: 7 }),
        assertPrivateCustody: () =>
          f.options.assertPrivateCustody({
            root: f.root,
            parent: dirname(f.root),
            file: f.file,
            lock: f.file + '.lock',
            temporary: f.file + '.pending',
            authorityNamespace: f.root + '/authority',
          }),
        now: () => 100_000,
        nonces,
      });
    const context = {};
    const auth = compose(f.store);
    const request = { method: 'POST', target: '/api/goals', body, assertion };
    await auth.verify(context, request);
    const principal = (await auth.authenticate(context))!;
    auth.assertCurrent(principal, context);
    await expect(compose(new GoalNonceStore(f.options)).verify({}, request)).rejects.toMatchObject({ status: 403 });
    f.setCustody(false);
    expect(() => auth.assertCurrent(principal, context)).toThrow();
  });
});
