import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import {
  DockerEmployeeContinuation,
  dockerContinuationDigest,
  type DockerContinuationEngine,
  type DockerContinuationStore,
} from '../src/docker-employee-continuation.js';
/** Real private filesystem and original native code; Docker is a recording physical port only. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync, stop } from 'esbuild';
afterAll(() => stop());
import { fileURLToPath } from 'node:url';
import {
  EphemeralRequest,
  EphemeralAck,
  EphemeralRestoration,
  ephemeralProjection,
  ephemeralRetainedProjection,
  ephemeralContinuationProjection,
  allowedEphemeralTransition,
  type EphemeralJournal,
  type EphemeralAttempt,
} from '../src/docker-ephemeral-data.js';
import { EPHEMERAL_PREPARE_PROGRAM, EPHEMERAL_DESTINATION_PROGRAM } from '../src/docker-ephemeral-native.js';
import { DockerEmployeeInspect } from '../src/docker-employee-engine-data.js';
import {
  DockerEmployeeContinuationRecord,
  DockerEmployeePlanReplacementWorkRecord,
} from '../src/docker-employee-continuation-data.js';
import type { DockerEphemeralRestoration } from '../src/docker-ephemeral-restoration.js';
import type { EphemeralDirectoryOwner } from '../src/docker-ephemeral-directory.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
const eid = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000002',
  oid = '30000000-0000-4000-8000-000000000003',
  image = 'sha256:' + 'e'.repeat(64);
const roots: string[] = [];
const owners: Array<{ close(): void }> = [];
afterEach(() => {
  for (const owner of owners.splice(0))
    try {
      owner.close();
    } catch {
      /* lost-close cases are asserted by their test */
    }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(layout: 'employees' | 'operator-recovery' | 'operator-sessions' = 'employees') {
  const parent = fs.mkdtempSync(join(tmpdir(), 'ephemeral-unit-'));
  roots.push(parent);
  const root = join(parent, 'scratch');
  fs.mkdirSync(root, { mode: 0o700 });
  const stat = fs.statSync(root, { bigint: true });
  const fact = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: 0o700 as const,
  };
  const request = EphemeralRequest.parse({
    version: 1,
    purpose: 'reverie-ephemeral-directory-restore-v1',
    operationId: oid,
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: 7,
    invocation: 1,
    layout,
    root: fact,
    forbidden: [],
  });
  const identity = layout === 'employees' ? eid : sid;
  const scratch = join(root, 'laptops', layout, identity),
    tmp = join(scratch, 'tmp');
  const projection = {
    rootSource: '/untrusted-locator',
    layout,
    identity,
    scratchSource: '/untrusted-locator/laptops/' + layout + '/' + identity,
    tmpSource: '/untrusted-locator/laptops/' + layout + '/' + identity + '/tmp',
  };
  return { parent, root, fact, request, scratch, tmp, projection };
}
function native(f: ReturnType<typeof fixture>, options: { prefix?: string; request?: unknown; root?: string } = {}) {
  const declaration = "const ROOT='/restore-root',";
  expect(EPHEMERAL_PREPARE_PROGRAM.split(declaration)).toHaveLength(2);
  return (
    (options.prefix ?? '') +
    EPHEMERAL_PREPARE_PROGRAM.replace(declaration, 'const ROOT=' + JSON.stringify(options.root ?? f.root) + ',')
  );
}
let pipeOrdinal = 0;
/** Docker's container stdin is a FIFO, unlike Node child_process's socketpair. */
function inputPipe(f: ReturnType<typeof fixture>, bytes?: string): number {
  const name = join(f.parent, 'stdin-' + ++pipeOrdinal);
  const created = spawnSync('mkfifo', ['--mode=600', name], { encoding: 'utf8', timeout: 3000 });
  if (created.status !== 0) throw Error('Private fixture FIFO unavailable');
  const fd = fs.openSync(name, fs.constants.O_RDWR | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  if (bytes !== undefined) {
    const body = Buffer.from(bytes).subarray(0, 8192);
    fs.writeSync(fd, body);
  }
  return fd;
}
function run(f: ReturnType<typeof fixture>, options: Parameters<typeof native>[1] = {}) {
  const fd = inputPipe(f, JSON.stringify(options.request ?? f.request) + '\n');
  try {
    return spawnSync(process.execPath, ['--input-type=commonjs', '-e', native(f, options)], {
      stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 11000,
      maxBuffer: 16384,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', LD_PRELOAD: '', LD_LIBRARY_PATH: '', OPENSSL_CONF: '' },
    });
  } finally {
    fs.closeSync(fd);
  }
}
function load<T>(filename: string, f: ReturnType<typeof fixture>, physical: typeof fs = fs): T {
  const path = fileURLToPath(new URL('../src/' + filename, import.meta.url));
  const source = fs.readFileSync(path, 'utf8');
  const input = source.replace("const ROOT = '/scratch';", 'const ROOT = ' + JSON.stringify(f.root) + ';');
  const output = buildSync({
    stdin: { contents: input, resolveDir: dirname(path), sourcefile: path, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  }).outputFiles[0]!.text.replaceAll('var ROOT = "/scratch";', 'var ROOT = ' + JSON.stringify(f.root) + ';');
  const module = { exports: {} };
  runInNewContext(output, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'node:fs' ? physical : createRequire(import.meta.url)(name)),
    process,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    URL,
    TextEncoder,
    TextDecoder,
  });
  return module.exports as T;
}
function owner(f: ReturnType<typeof fixture>, physical?: typeof fs) {
  const Constructor = load<{ EphemeralDirectoryOwner: typeof EphemeralDirectoryOwner }>(
    'docker-ephemeral-directory.ts',
    f,
    physical
  ).EphemeralDirectoryOwner;
  const result = new Constructor();
  owners.push(result);
  return result;
}
function source(f: ReturnType<typeof fixture>) {
  return DockerEmployeeInspect.parse({
    Id: 'a'.repeat(64),
    Image: image,
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
    Config: {
      User: process.getuid!() + ':' + process.getgid!(),
      Entrypoint: ['/inert'],
      Cmd: null,
      Env: [],
      Labels: {},
    },
    HostConfig: {},
    Mounts: [
      { Type: 'bind', Source: f.projection.scratchSource, Destination: '/scratch', RW: true },
      { Type: 'bind', Source: f.projection.tmpSource, Destination: '/tmp', RW: true },
      { Type: 'bind', Source: '/persistent/private-home', Destination: '/home/agent', RW: true },
    ],
  });
}
function row() {
  const pool = { memoryMaxBytes: 2 ** 30, swapMaxBytes: 0, pidsMax: 32, cpuWeight: 100, allowedCpus: [0] };
  return DockerEmployeeContinuationRecord.parse({
    version: 1,
    purpose: 'docker-employee-continuation-v1',
    employeeId: eid,
    request: {
      operationId: oid,
      sessionId: sid,
      sessionGeneration: 7,
      containerId: 'a'.repeat(64),
      imageId: image,
      expectedPolicyDigest: 'b'.repeat(64),
      expectedDestinationImageId: image,
      enterOffice: false,
    },
    sourceDigest: 'c'.repeat(64),
    original: {
      containerId: 'a'.repeat(64),
      imageId: image,
      deployment: 'unit',
      employeeId: eid,
      sessionId: sid,
      home: { type: 'bind', source: '/persistent/private-home', destination: '/home/agent', readWrite: true },
      mountDigest: 'd'.repeat(64),
      storageDigest: 'f'.repeat(64),
      configurationDigest: '1'.repeat(64),
    },
    workerImage: { imageId: image, sourceImageId: image, clientManifestDigest: '2'.repeat(64) },
    policy: { ...pool, memoryHighBytes: null, pool },
    credentialId: '40000000-0000-4000-8000-000000000004',
    phase: 'pool-ready',
  });
}
function replacementRow(f: ReturnType<typeof fixture>, previousSession = sid) {
  const before = row(),
    original = {
      ...before.original,
      sessionId: previousSession,
      mountDigest: dockerContinuationDigest(
        [...source(f).Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination))
      ),
    };
  return DockerEmployeePlanReplacementWorkRecord.parse({
    ...before,
    version: 3,
    purpose: 'docker-employee-plan-replacement-v3',
    credentialId: '70000000-0000-4000-8000-000000000007',
    original,
    request: { ...before.request, sessionId: '60000000-0000-4000-8000-000000000006', sessionGeneration: 8 },
    providerSourceDigest: before.sourceDigest,
    planReplacement: {
      version: 1,
      purpose: 'docker-plan-replacement-provenance-v1',
      moveId: 'synthetic-move',
      source: {
        binding: {
          version: 1,
          operationId: '50000000-0000-4000-8000-000000000005',
          credentialId: before.credentialId,
          sessionId: previousSession,
          sessionGeneration: 7,
          containerId: original.containerId,
          imageId: original.imageId,
          originalDigest: dockerContinuationDigest(original),
          policyDigest: dockerContinuationDigest(before.policy),
        },
        continuationDigest: '1'.repeat(64),
        providerSourceDigest: before.sourceDigest,
        ephemeralSessionId: sid,
      },
      account: {
        id: 'synthetic-plan',
        provider: 'anthropic',
        projectionDigest: '2'.repeat(64),
        contextDigest: '3'.repeat(64),
      },
    },
  });
}
describe('closed ephemeral projection DATA', () => {
  it.each(['employees', 'operator-recovery', 'operator-sessions'] as const)(
    'accepts only exact current %s identity/pair',
    (layout) => {
      const f = fixture(layout);
      expect(ephemeralProjection(source(f), eid, sid)).toEqual(f.projection);
      const wrong = source(f);
      wrong.Mounts[0]!.Source = wrong.Mounts[0]!.Source.replace(f.projection.identity, oid);
      expect(ephemeralProjection(wrong, eid, sid)).toBeUndefined();
    }
  );
  it('does not infer HOME, workspace, arbitrary layouts or missing-root authority', () => {
    const f = fixture(),
      s = source(f);
    s.Mounts[0]!.Source = '/persistent/private-home';
    expect(ephemeralProjection(s, eid, sid)).toBeUndefined();
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('rejects mismatched tmp and lexical persistent overlap', () => {
    const f = fixture(),
      s = source(f);
    s.Mounts[1]!.Source += '/different';
    expect(() => ephemeralProjection(s, eid, sid)).toThrow('PAIR_INVALID');
    s.Mounts[1]!.Source = f.projection.tmpSource;
    s.Mounts[2]!.Source = f.projection.rootSource;
    expect(() => ephemeralProjection(s, eid, sid)).toThrow('PERSISTENT_OVERLAP');
  });
});
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)('actual fixed mkdir-only native', () => {
  it.each(['employees', 'operator-recovery', 'operator-sessions'] as const)(
    'creates missing complete %s chain, preserves private data and repeats idempotently',
    (layout) => {
      const f = fixture(layout);
      fs.writeFileSync(join(f.parent, 'persistent'), 'unchanged', { mode: 0o600 });
      const result = run(f);
      expect(result.status, result.stderr).toBe(0);
      const ack = EphemeralAck.parse(JSON.parse(result.stdout));
      const { forbidden: _forbidden, ...correlation } = f.request;
      expect(ack).toMatchObject({ ...correlation, purpose: 'reverie-ephemeral-directories-ready-v1' });
      expect(fs.statSync(f.tmp).mode & 0o7777).toBe(0o700);
      const before = fs.statSync(f.scratch, { bigint: true }),
        again = run(f);
      expect(again.status, again.stderr).toBe(0);
      expect(fs.statSync(f.scratch, { bigint: true }).ino).toBe(before.ino);
      expect(again.stdout).toBe(result.stdout);
      expect(fs.readFileSync(join(f.parent, 'persistent'), 'utf8')).toBe('unchanged');
    }
  );
  it('pins its own creation umask without changing any preexisting permissions', () => {
    const f = fixture(),
      result = run(f, { prefix: 'process.umask(0o777);' });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(f.tmp).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(f.root).mode & 0o7777).toBe(0o700);
  });
  it('concurrent EEXIST verifies rather than replaces the same chain', async () => {
    const f = fixture();
    const launch = () =>
      new Promise<number | null>((resolve, reject) => {
        const fd = inputPipe(f, JSON.stringify(f.request) + '\n');
        const child = spawn(process.execPath, ['-e', native(f)], { stdio: [fd, 'pipe', 'pipe'] });
        child.on('error', reject);
        child.on('close', (code) => {
          fs.closeSync(fd);
          resolve(code);
        });
      });
    expect(await Promise.all([launch(), launch()])).toEqual([0, 0]);
    expect(fs.readdirSync(f.scratch)).toEqual(['tmp']);
  });
  it.each(['dev', 'ino', 'uid', 'gid'] as const)('refuses root %s mismatch before mkdir', (key) => {
    const f = fixture(),
      request = structuredClone(f.request);
    (request.root as Record<string, unknown>)[key] =
      typeof request.root[key] === 'number' ? Number(request.root[key]) + 1 : String(BigInt(request.root[key]) + 1n);
    expect(run(f, { request }).status).toBe(1);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('never creates a missing candidate root', () => {
    const f = fixture();
    fs.rmdirSync(f.root);
    expect(run(f).status).toBe(1);
    expect(fs.existsSync(f.root)).toBe(false);
  });
  it.each(['symlink', 'file', 'mode'] as const)('refuses preexisting %s without changing it or its target', (kind) => {
    const f = fixture(),
      first = join(f.root, 'laptops'),
      other = join(f.parent, 'private-home');
    fs.mkdirSync(other, { mode: 0o700 });
    if (kind === 'symlink') fs.symlinkSync(other, first);
    else if (kind === 'file') fs.writeFileSync(first, 'data', { mode: 0o600 });
    else fs.mkdirSync(first, { mode: 0o755 });
    expect(run(f).status).toBe(1);
    expect(fs.readdirSync(other)).toEqual([]);
    if (kind === 'file') expect(fs.readFileSync(first, 'utf8')).toBe('data');
    if (kind === 'mode') expect(fs.statSync(first).mode & 0o777).toBe(0o755);
  });
  it('refuses physically forbidden persistent-root identity before mkdir', () => {
    const f = fixture(),
      request = { ...f.request, forbidden: [{ dev: f.fact.dev, ino: f.fact.ino }] };
    expect(run(f, { request }).status).toBe(1);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('refuses malformed/oversize input and wrong layout identity', () => {
    const f = fixture();
    for (const request of [
      { ...f.request, layout: '../home' },
      { ...f.request, employeeId: '../x' },
      { ...f.request, extra: true },
      { ...f.request, forbidden: Array(17).fill({ dev: '1', ino: '1' }) },
      'x'.repeat(9000),
    ]) {
      expect(run(f, { request }).status).toBe(1);
      expect(fs.readdirSync(f.root)).toEqual([]);
    }
  });
  it('lost directory-close ACK emits no success, and a new metadata attempt can verify EEXIST safely', () => {
    const f = fixture(),
      prefix = `const fsc=require('node:fs'),original=fsc.close;let lost=false;fsc.close=(fd,cb)=>original(fd,error=>{if(!lost&&fd>2){lost=true;cb(Error('lost close'));}else cb(error);});`;
    const result = run(f, { prefix });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(run(f).status).toBe(0);
  });
  it('missing stdin cannot trap a blocking libuv read beyond the native8s deadline', async () => {
    const f = fixture(),
      fd = inputPipe(f),
      child = spawn(process.execPath, ['-e', native(f)], { stdio: [fd, 'pipe', 'pipe'] });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 11000);
    const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(watchdog);
      fs.closeSync(fd);
    });
    expect(outcome).toEqual({ code: 1, signal: null });
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('read-only destination probe returns actual mount-root identities after consuming closes', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    const program = EPHEMERAL_DESTINATION_PROGRAM.replace("'/scratch'", JSON.stringify(f.scratch)).replace(
      "'/tmp'",
      JSON.stringify(f.tmp)
    );
    const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).tmp.ino).toBe(String(fs.statSync(f.tmp, { bigint: true }).ino));
  });
});
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)('actual control directory FD owner', () => {
  it('preflights missing prefixes without mkdir then retains all created leaves', () => {
    const f = fixture(),
      held = owner(f);
    expect(held.inspectExistingPrefix(f.projection, [])).toBe(false);
    expect(fs.readdirSync(f.root)).toEqual([]);
    expect(run(f).status).toBe(0);
    expect(held.captureLeaves(f.projection, []).tmp.ino).toBe(String(fs.statSync(f.tmp, { bigint: true }).ino));
  });
  it('revokes same-byte named-root substitution and never reacquires through it', () => {
    const f = fixture(),
      held = owner(f);
    fs.renameSync(f.root, f.root + '-old');
    fs.mkdirSync(f.root, { mode: 0o700 });
    expect(() => held.assertCurrent()).toThrow();
    fs.rmdirSync(f.root);
    fs.renameSync(f.root + '-old', f.root);
    expect(() => held.assertCurrent()).toThrow();
    held.close();
  });
  it('refuses existing child symlink and inode-alias persistent roots before helper issuance', () => {
    const f = fixture(),
      held = owner(f);
    fs.symlinkSync(f.parent, join(f.root, 'laptops'));
    expect(() => held.inspectExistingPrefix(f.projection, [])).toThrow();
    const g = fixture(),
      other = owner(g);
    expect(() => other.inspectExistingPrefix(g.projection, [g.fact])).toThrow();
  });
  it('rejects a differing local mount id, with checked FD closure', () => {
    const f = fixture();
    let reads = 0;
    const physical = {
      ...fs,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        const n = (fs.readSync as (...values: unknown[]) => number)(...args);
        if (n > 0 && ++reads === 2 && Buffer.isBuffer(args[1])) {
          const b = args[1];
          const text = b
            .subarray(0, n)
            .toString()
            .replace(/mnt_id:\s*\d+/, 'mnt_id: 99999999');
          b.write(text);
          return Buffer.byteLength(text);
        }
        return n;
      },
    } as typeof fs;
    expect(() => owner(f, physical)).toThrow();
  });
  it('consumes root FD once even if actual close ACK is lost, preserving a reused FD', () => {
    const f = fixture();
    let armed = false,
      failed = false;
    const physical = {
      ...fs,
      closeSync: (fd: number) => {
        fs.closeSync(fd);
        if (armed && !failed) {
          failed = true;
          throw Error('lost close');
        }
      },
    } as typeof fs;
    const held = owner(f, physical);
    armed = true;
    expect(() => held.close()).toThrow();
    const fd = fs.openSync(join(f.parent, 'new-file'), fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
    expect(() => held.close()).toThrow();
    fs.writeSync(fd, 'live');
    fs.closeSync(fd);
    expect(fs.readFileSync(join(f.parent, 'new-file'), 'utf8')).toBe('live');
  });
});
function adapter(f: ReturnType<typeof fixture>) {
  const Constructor = load<{ DockerEphemeralRestoration: typeof DockerEphemeralRestoration }>(
    'docker-ephemeral-restoration.ts',
    f
  ).DockerEphemeralRestoration;
  let cursor: EphemeralRestoration | undefined,
    lostCreate = false,
    lostStart = false,
    beforeCreate = false,
    staleAck = false,
    revoked = false;
  const saved = new Map<
    string,
    {
      name: string;
      config: Record<string, unknown>;
      running: boolean;
      started: boolean;
      logs: string;
      exit: number;
      invocations: number[];
    }
  >();
  const intoVm = Constructor.constructor(
    'value',
    'return value===undefined?undefined:JSON.parse(JSON.stringify(value));'
  ) as (value: unknown) => EphemeralRestoration | undefined;
  const journal: EphemeralJournal = {
    readEphemeral: () => intoVm(cursor),
    publishEphemeral: async (_row, before, next, current) => {
      current();
      expect(before).toEqual(cursor);
      const checked = EphemeralRestoration.parse(structuredClone(next));
      expect(
        allowedEphemeralTransition(
          before === undefined ? undefined : EphemeralRestoration.parse(structuredClone(before)),
          checked
        )
      ).toBe(true);
      cursor = checked;
    },
  };
  const command: DockerEngineCommand = {
    create: vi.fn(async (name, config, current) => {
      current();
      if (beforeCreate) {
        beforeCreate = false;
        throw Error('lost before CREATE');
      }
      const id = (saved.size + 1).toString(16).padStart(64, '0');
      saved.set(id, {
        name,
        config: structuredClone(config),
        running: false,
        started: false,
        logs: '',
        exit: 0,
        invocations: [],
      });
      if (lostCreate) {
        lostCreate = false;
        throw Error('lost CREATE reply');
      }
      return id;
    }),
    run: vi.fn(async (args, input) => {
      if (args[0] === 'image')
        return JSON.stringify([
          { Id: image, Config: { Env: ['IMAGE_DEFAULT=safe'], Labels: { 'image-label': 'preserved' } } },
        ]);
      if (args[0] === 'container' && args[1] === 'ls') return [...saved.keys()].join('\n');
      const id = args.at(-1)!,
        entry = saved.get(id);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!entry) throw Error('unknown helper');
        const c = entry.config,
          h = c.HostConfig as Record<string, unknown>;
        return JSON.stringify([
          {
            Id: id,
            Name: '/' + entry.name,
            Image: c.Image,
            Config: {
              ...c,
              Env: [...(c.Env as string[]), 'IMAGE_DEFAULT=safe'],
              Labels: { 'image-label': 'preserved', ...(c.Labels as object) },
            },
            HostConfig: {
              ...h,
              Mounts: (h.Mounts as Array<Record<string, unknown>>).map((m) =>
                Object.fromEntries(Object.entries(m).filter(([key, value]) => key !== 'ReadOnly' || value !== false))
              ),
              RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
            },
            Mounts: [{ Type: 'bind', Source: f.projection.rootSource, Destination: '/restore-root', RW: true }],
            State: {
              Running: entry.running,
              Paused: false,
              Dead: false,
              OOMKilled: false,
              Restarting: false,
              Status: entry.started ? 'exited' : 'created',
              ExitCode: entry.exit,
            },
          },
        ]);
      }
      if (args[0] === 'container' && args[1] === 'start') {
        if (!entry) throw Error('missing helper');
        const invocation = JSON.parse(input!).invocation;
        if (entry.invocations.includes(invocation)) throw Error('START replay');
        entry.invocations.push(invocation);
        entry.started = true;
        const result = run(f, { request: JSON.parse(input!) });
        entry.logs = result.stdout;
        entry.exit = result.status ?? 1;
        if (lostStart) {
          lostStart = false;
          throw Error('lost START reply');
        }
        return entry.logs;
      }
      if (args[0] === 'container' && args[1] === 'wait') return entry!.exit + '\n';
      if (args[0] === 'logs') {
        const value = saved.get(id)!.logs;
        if (staleAck) {
          staleAck = false;
          return JSON.stringify({ ...JSON.parse(value), invocation: 1 }) + '\n';
        }
        return value;
      }
      if (args[0] === 'exec') {
        const program = EPHEMERAL_DESTINATION_PROGRAM.replace("'/scratch'", JSON.stringify(f.scratch)).replace(
          "'/tmp'",
          JSON.stringify(f.tmp)
        );
        const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 3000 });
        if (result.status !== 0) throw Error('probe refused');
        return result.stdout;
      }
      throw Error('Unexpected physical command ' + args[0]);
    }),
  };
  let target: DockerEmployeeInspect | null = null;
  let service = new Constructor(
    command,
    journal,
    '7'.repeat(64),
    image,
    async () => source(f),
    async () => target,
    async () => []
  );
  owners.push(service);
  return {
    get service() {
      return service;
    },
    command,
    saved,
    journal,
    restart(nativeImage = image) {
      service.close();
      service = new Constructor(
        command,
        journal,
        '7'.repeat(64),
        nativeImage,
        async () => source(f),
        async () => target,
        async () => []
      );
      owners.push(service);
    },
    get cursor() {
      return cursor;
    },
    loseBeforeCreate() {
      beforeCreate = true;
    },
    staleAck() {
      staleAck = true;
    },
    loseCreate() {
      lostCreate = true;
    },
    loseStart() {
      lostStart = true;
    },
    revoke() {
      revoked = true;
    },
    current() {
      if (revoked) throw Error('revoked');
    },
    runningTarget() {
      target = source(f);
      target.Id = 'd'.repeat(64);
      target.State.Running = true;
    },
  };
}
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)('canonical metadata-attempt integration', () => {
  it.each(['operator-recovery', 'operator-sessions'] as const)(
    'retains %s directories through distinct target and repeated source session identities',
    async (layout) => {
      const f = fixture(layout),
        a = adapter(f),
        r = replacementRow(f, oid);
      expect(ephemeralRetainedProjection(source(f), r.original)).toEqual(f.projection);
      await a.service.prepare(r, a.current);
      const completed = a.cursor!.attempts.at(-1)!;
      expect(completed.request.sessionId).toBe(sid);
      expect(completed.request.sessionGeneration).toBe(8);
      expect(completed.phase).toBe('completed');
      const recorded = DockerEmployeePlanReplacementWorkRecord.parse({ ...r, ephemeralRestoration: a.cursor });
      expect(recorded.request.sessionId).not.toBe(completed.request.sessionId);
      expect(fs.existsSync(f.tmp)).toBe(true);
      const before = fs.statSync(f.tmp, { bigint: true });
      a.runningTarget();
      await a.service.verifyDestination(recorded);
      expect(fs.statSync(f.tmp, { bigint: true }).ino).toBe(before.ino);
      const wrong = structuredClone(recorded);
      if (wrong.version !== 3) throw Error('Replacement required');
      wrong.planReplacement.source.ephemeralSessionId = oid;
      expect(() => ephemeralContinuationProjection(source(f), wrong)).toThrow('ORIGINAL_CHANGED');
      expect(() => ephemeralRetainedProjection({ ...source(f), Id: 'f'.repeat(64) }, r.original)).toThrow(
        'ORIGINAL_CHANGED'
      );
    }
  );
  it('reads a published old-image projection after an upgrade without issuing metadata effects', async () => {
    const f = fixture(),
      a = adapter(f),
      r = row();
    await a.service.prepare(r, a.current);
    a.runningTarget();
    r.phase = 'ready';
    a.restart('sha256:' + '9'.repeat(64));
    vi.mocked(a.command.create).mockClear();
    vi.mocked(a.command.run).mockClear();
    expect(await a.service.observe(r)).toBe('ready');
    await a.service.verifyDestination(r);
    expect(a.command.create).not.toHaveBeenCalled();
    expect(vi.mocked(a.command.run).mock.calls.every(([args]) => args[1] !== 'start')).toBe(true);
    await expect(a.service.prepare(r, a.current)).rejects.toThrow('IMAGE_CHANGED');
  });
  it('holds original root and leaves through preparation; configs have only exact nonrecursive root bind', async () => {
    const f = fixture(),
      a = adapter(f),
      r = row();
    await a.service.prepare(r, a.current);
    expect(a.cursor?.attempts.at(-1)?.phase).toBe('completed');
    expect(await a.service.observe(r)).toBe('ready');
    const c = [...a.saved.values()][0]!.config,
      h = c.HostConfig as Record<string, unknown>;
    expect(h.Mounts).toEqual([
      {
        Type: 'bind',
        Source: f.projection.rootSource,
        Target: '/restore-root',
        ReadOnly: false,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      },
    ]);
    expect(h.NetworkMode).toBe('none');
    a.runningTarget();
    await a.service.verifyDestination(r);
    expect(a.command.run).not.toHaveBeenCalledWith(expect.arrayContaining(['provider']));
  });
  it.each(['CREATE', 'START'] as const)(
    'lost %s retains original intent/CID and makes at most one FRESH metadata attempt next request',
    async (phase) => {
      const f = fixture(),
        a = adapter(f),
        r = row();
      if (phase === 'CREATE') a.loseCreate();
      else a.loseStart();
      await expect(a.service.prepare(r, a.current)).rejects.toThrow('lost');
      expect(a.cursor?.attempts).toHaveLength(1);
      await a.service.prepare(r, a.current);
      expect(a.cursor?.attempts).toHaveLength(2);
      const [old, next] = a.cursor!.attempts;
      expect(old!.phase).toBe(phase === 'CREATE' ? 'create-issued' : 'start-issued');
      expect(old).toHaveProperty('containerId');
      expect(next!.phase).toBe('completed');
      expect([...a.saved.values()].filter((value) => value.started)).toHaveLength(phase === 'CREATE' ? 1 : 2);
      expect(a.command.create).toHaveBeenCalledTimes(2);
    }
  );
  it('rejects current grant revocation before any helper creation', async () => {
    const f = fixture(),
      a = adapter(f);
    a.revoke();
    await expect(a.service.prepare(row(), a.current)).rejects.toThrow('revoked');
    expect(a.command.create).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('completed journal bytes alone grant nothing after restart; running actual destination re-earns leaf identity', async () => {
    const f = fixture(),
      a = adapter(f),
      r = row();
    await a.service.prepare(r, a.current);
    a.service.close();
    const Constructor = load<{ DockerEphemeralRestoration: typeof DockerEphemeralRestoration }>(
      'docker-ephemeral-restoration.ts',
      f
    ).DockerEphemeralRestoration;
    let target: DockerEmployeeInspect | null = null;
    const restored = new Constructor(
      a.command,
      a.journal,
      '7'.repeat(64),
      image,
      async () => source(f),
      async () => target,
      async () => []
    );
    owners.push(restored);
    expect(await restored.observe(r)).toBe('unissued');
    target = source(f);
    target.State.Running = true;
    expect(await restored.observe(r)).toBe('ready');
    fs.renameSync(f.tmp, f.tmp + '-old');
    fs.mkdirSync(f.tmp, { mode: 0o700 });
    await expect(restored.verifyDestination(r)).rejects.toThrow();
  });

  it('all32 pre-CREATE crashes remain recoverable through the retained deterministic name, including late CREATE reply', async () => {
    const f = fixture(),
      a = adapter(f),
      r = row();
    for (let index = 0; index < 32; index++) {
      a.loseBeforeCreate();
      await expect(a.service.prepare(r, a.current)).rejects.toThrow('before CREATE');
    }
    expect(a.cursor?.attempts).toHaveLength(32);
    expect(a.saved.size).toBe(0);
    expect(fs.readdirSync(f.root)).toEqual([]);
    const original = structuredClone(a.cursor!.attempts);
    a.loseCreate();
    await a.service.prepare(r, a.current);
    expect(a.cursor?.attempts).toHaveLength(32);
    expect(a.cursor?.continuation).toMatchObject({ attemptOrdinal: 32, invocation: 33, phase: 'completed' });
    expect(a.saved.size).toBe(1);
    expect(a.cursor!.attempts.slice(0, 31)).toEqual(original.slice(0, 31));
    expect(a.cursor!.attempts[31]).toMatchObject({ ...original[31], phase: 'create-issued' });
    a.restart();
    await a.service.prepare(r, a.current);
    expect(a.cursor?.continuation).toMatchObject({ invocation: 34, phase: 'completed' });
    expect(a.saved.size).toBe(1);
  });
  it('all32 EXITED lost START replies remain unknown; fresh same-CID counters make progress and reject stale ACK', async () => {
    const f = fixture(),
      a = adapter(f),
      r = row();
    for (let index = 0; index < 32; index++) {
      a.loseStart();
      await expect(a.service.prepare(r, a.current)).rejects.toThrow('lost START');
    }
    const original = structuredClone(a.cursor!.attempts);
    expect(original.every((value) => value.phase === 'start-issued')).toBe(true);
    await a.service.prepare(r, a.current);
    expect(a.cursor!.attempts).toEqual(original);
    expect(a.cursor?.continuation).toMatchObject({ invocation: 33, phase: 'completed' });
    expect(a.saved.size).toBe(32);
    expect([...a.saved.values()].at(-1)!.invocations).toEqual([32, 33]);
    a.restart();
    a.staleAck();
    await expect(a.service.prepare(r, a.current)).rejects.toThrow('ACK_CHANGED');
    expect(a.cursor?.continuation).toMatchObject({ invocation: 34, phase: 'start-issued' });
    await a.service.prepare(r, a.current);
    expect(a.cursor?.continuation).toMatchObject({ invocation: 35, phase: 'completed', ack: { invocation: 35 } });
    expect(a.cursor!.attempts).toEqual(original);
    expect(a.saved.size).toBe(32);
  });
  it('cap continuation refuses a Running prior helper and a disappeared recorded CID', async () => {
    const f = fixture(),
      a = adapter(f),
      r = row();
    for (let index = 0; index < 32; index++) {
      a.loseStart();
      await expect(a.service.prepare(r, a.current)).rejects.toThrow();
    }
    for (const helper of a.saved.values()) helper.running = true;
    await expect(a.service.prepare(r, a.current)).rejects.toThrow('CONTINUATION_UNCONFIRMED');
    a.saved.delete([...a.saved.keys()][0]!);
    await expect(a.service.prepare(r, a.current)).rejects.toThrow('CENSUS_UNCONFIRMED');
    expect(a.command.create).toHaveBeenCalledTimes(32);
  });
  it.each(['readonly', 'recursive', 'create-root', 'healthcheck'] as const)(
    'rejects changed metadata helper %s before issuing any successor',
    async (kind) => {
      const f = fixture(),
        a = adapter(f);
      a.loseStart();
      await expect(a.service.prepare(row(), a.current)).rejects.toThrow('lost START');
      const config = [...a.saved.values()][0]!.config,
        host = config.HostConfig as { Mounts: Array<{ ReadOnly: boolean; BindOptions: Record<string, unknown> }> };
      if (kind === 'readonly') host.Mounts[0]!.ReadOnly = true;
      if (kind === 'recursive') host.Mounts[0]!.BindOptions.NonRecursive = false;
      if (kind === 'create-root') host.Mounts[0]!.BindOptions.CreateMountpoint = true;
      if (kind === 'healthcheck') config.Healthcheck = { Test: ['CMD', 'unapproved'] };
      await expect(a.service.prepare(row(), a.current)).rejects.toThrow('HELPER_CHANGED');
      expect(a.command.create).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['prepare', 'observe', 'verifyDestination'] as const)(
    'record DATA cannot choose the native executable image during %s',
    async (method) => {
      const f = fixture(),
        a = adapter(f),
        bad = row();
      bad.workerImage.imageId = 'sha256:' + '9'.repeat(64);
      bad.request.expectedDestinationImageId = bad.workerImage.imageId;
      expect(() => DockerEmployeeContinuationRecord.parse(bad)).not.toThrow();
      if (method === 'prepare') await expect(a.service.prepare(bad, a.current)).rejects.toThrow('IMAGE_CHANGED');
      else await expect(a.service[method](bad)).rejects.toThrow('IMAGE_CHANGED');
      expect(a.command.create).not.toHaveBeenCalled();
      expect(a.command.run).not.toHaveBeenCalled();
      expect(fs.readdirSync(f.root)).toEqual([]);
    }
  );
  it('append-only bounded cursor refuses history rewrite, phase replay and foreign record correlation', () => {
    const f = fixture();
    const attempt: EphemeralAttempt = {
      ordinal: 1,
      name: 'reverie-boxed-ephemeral-' + '1'.repeat(64),
      imageId: image,
      configurationDigest: '2'.repeat(64),
      rootSource: f.projection.rootSource,
      request: f.request,
      phase: 'create-issued',
    };
    const before = EphemeralRestoration.parse({
      version: 1,
      purpose: 'reverie-ephemeral-restoration-v1',
      attempts: [attempt],
    });
    expect(
      allowedEphemeralTransition(before, { ...before, attempts: [{ ...attempt, configurationDigest: '3'.repeat(64) }] })
    ).toBe(false);
    expect(() => EphemeralRestoration.parse({ ...before, attempts: Array(33).fill(attempt) })).toThrow();
    expect(() =>
      DockerEmployeeContinuationRecord.parse({
        ...row(),
        ephemeralRestoration: {
          ...before,
          attempts: [{ ...attempt, request: { ...attempt.request, sessionId: oid } }],
        },
      })
    ).toThrow();
  });
});

describe('canonical store and paid-phase separation', () => {
  it('publishes only the ephemeral CAS subcursor, preserves source/policy, rejects stale cursor/currentness', async () => {
    const f = fixture(),
      companyStore = new CompanyStore(join(f.parent, 'company.json'));
    await companyStore.init();
    const company = new CompanyService(companyStore, {
      getSession: () => undefined,
      chatrooms: { rooms: () => [] },
      research: {},
    } as unknown as CompanyServiceDeps);
    const r = row();
    await companyStore.update((state) => {
      state.dockerEmployeeContinuations = [r];
    });
    const journal = new CompanyDockerContinuationStore(company, () => undefined);
    const attempt: EphemeralAttempt = {
      ordinal: 1,
      name: 'reverie-boxed-ephemeral-' + '1'.repeat(64),
      imageId: image,
      configurationDigest: '2'.repeat(64),
      rootSource: f.projection.rootSource,
      request: f.request,
      phase: 'create-issued',
    };
    const next = EphemeralRestoration.parse({
      version: 1,
      purpose: 'reverie-ephemeral-restoration-v1',
      attempts: [attempt],
    });
    await journal.publishEphemeral(r, undefined, next, () => {});
    expect(journal.readEphemeral(r)).toEqual(next);
    const persisted = JSON.parse(fs.readFileSync(companyStore.file, 'utf8'));
    expect(persisted.dockerEmployeeContinuations[0]).toEqual({ ...r, ephemeralRestoration: next });
    await expect(journal.publishEphemeral(r, undefined, next, () => {})).rejects.toThrow('cursor');
    const created = { ...next, attempts: [{ ...attempt, phase: 'created' as const, containerId: '3'.repeat(64) }] };
    await expect(
      journal.publishEphemeral(r, next, created, () => {
        throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    expect(journal.readEphemeral(r)).toEqual(next);
    const changed = { ...r, sourceDigest: '4'.repeat(64) };
    await expect(journal.publishEphemeral(changed, next, created, () => {})).rejects.toThrow('cursor');
  });
  it.each(['destination-issued', 'start-issued', 'provider-issued'] as const)(
    'fresh metadata preparation never repeats paid %s effect',
    async (phase) => {
      let actual = row();
      actual.phase = phase;
      actual.pool = {
        containerId: '5'.repeat(64),
        cgroupParent: '/owned',
        physicalDigest: '6'.repeat(64),
        policyDigest: dockerContinuationDigest(actual.policy.pool),
      };
      if (phase !== 'destination-issued') actual.destination = { ...actual.original, containerId: 'd'.repeat(64) };
      actual.request.expectedPolicyDigest = dockerContinuationDigest(actual.policy);
      const subject = {
        employeeId: eid,
        sessionId: sid,
        sessionGeneration: 7,
        owner: undefined,
        sourceDigest: actual.sourceDigest,
        providerSourceDigest: actual.sourceDigest,
        onVacation: false,
        desiredRunning: true,
      };
      const store: DockerContinuationStore = {
        subject: () => subject,
        existingSubject: (_employeeId, original) => (original === actual ? subject : undefined),
        policy: () => actual.policy,
        record: () => actual,
        replace: async (_before, next, current) => {
          current();
          actual = next;
        },
        enterOffice: async () => {
          throw Error('office effect');
        },
        bind: async () => {
          throw Error('binding effect');
        },
      };
      let prepared = false;
      const engine: DockerContinuationEngine = {
        image: vi.fn(async () => actual.workerImage),
        observeSource: vi.fn(async () => ({ original: actual.original, state: 'stopped' as const })),
        validateCapabilities: vi.fn(async () => {}),
        observeStorage: vi.fn(async () => (prepared ? 'ready' : 'ephemeral-unissued')),
        prepareStorage: vi.fn(async (_r, current) => {
          current();
          prepared = true;
        }),
        preparePool: vi.fn(async () => {
          throw Error('pool replay');
        }),
        observePool: vi.fn(async () => actual.pool!),
        createDestination: vi.fn(async () => {
          throw Error('CREATE replay');
        }),
        observeDestination: vi.fn(async () => null),
        start: vi.fn(async () => {
          throw Error('START replay');
        }),
        configureResources: vi.fn(async () => {
          throw Error('resource replay');
        }),
        provisionIdentity: vi.fn(async () => {
          throw Error('identity replay');
        }),
      };
      const provider = {
        launch: vi.fn(async () => {
          throw Error('provider replay');
        }),
      };
      const service = new DockerEmployeeContinuation(store, engine, provider, {
        issue: () => {
          throw Error('identity issue');
        },
      });
      const authority = {
        owner: undefined,
        require: () => {},
        requireOffice: () => {
          throw Error('office');
        },
      };
      const held = await service.observe(eid, oid, authority);
      expect(held.code).toBe('DOCKER_EPHEMERAL_PREPARATION_REQUIRED');
      expect(held.allowedActions).toContain('continue');
      await service.begin(eid, actual.request, authority);
      expect(engine.prepareStorage).toHaveBeenCalledTimes(1);
      for (const effect of [
        engine.createDestination,
        engine.start,
        provider.launch,
        engine.configureResources,
        engine.provisionIdentity,
      ])
        expect(effect).not.toHaveBeenCalled();
      expect(actual.phase).toBe(phase);
    }
  );
});
