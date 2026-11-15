/** Actual unprivileged FD/filesystem execution with no-new-privileges. Only
 * fixed mount paths are projected to private owned test dirs. This does not
 * claim Docker mount or image acceptance. Fault hooks exist only in the test. */
import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DOCKER_PLAN_SOURCE_READ_PROGRAM } from '../src/docker-plan-source-native.js';
import { dockerPlanContextForProvider } from '../src/docker-plan-source-data.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
const nativeId = '12345678-1234-4234-8234-123456789abc',
  operation = '87654321-1234-4234-8234-123456789abc';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture(provider: 'anthropic' | 'openai' = 'anthropic') {
  const root = fs.mkdtempSync(join(tmpdir(), 'plan-source-native-'));
  roots.push(root);
  const home = join(root, 'home'),
    account = join(root, 'account');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(account, { mode: 0o700 });
  const dir = join(home, provider === 'anthropic' ? '.claude' : '.codex'),
    history = provider === 'anthropic' ? 'projects' : 'sessions';
  fs.mkdirSync(join(dir, history, 'unencoded-project'), { recursive: true, mode: 0o700 });
  const file = join(
    dir,
    history,
    'unencoded-project',
    provider === 'anthropic' ? nativeId + '.jsonl' : 'rollout-' + nativeId + '.jsonl'
  );
  fs.writeFileSync(file, 'SYNTHETIC_SELECTED_THREAD\n', { mode: 0o600 });
  fs.writeFileSync(join(dir, provider === 'anthropic' ? 'CLAUDE.md' : 'AGENTS.md'), 'own instructions', {
    mode: 0o600,
  });
  const stat = fs.statSync(home, { bigint: true });
  return { root, home, account, dir, file, provider, dev: String(stat.dev), ino: String(stat.ino) };
}
function run(
  f: ReturnType<typeof fixture>,
  options: {
    mode?: string;
    kind?: string;
    prefix?: string;
    protected?: boolean;
    operation?: string;
    projection?: string;
    accountId?: string;
    nativeId?: string;
    accountDev?: string;
    accountIno?: string;
    historical?: string;
    dev?: string;
    ino?: string;
  } = {}
) {
  const declaration = "const HOME='/home/agent',ACCOUNT='/source-account';";
  expect(DOCKER_PLAN_SOURCE_READ_PROGRAM.split(declaration)).toHaveLength(2);
  const program =
    (options.prefix ?? '') +
    DOCKER_PLAN_SOURCE_READ_PROGRAM.replace(
      declaration,
      'const HOME=' + JSON.stringify(f.home) + ',ACCOUNT=' + JSON.stringify(f.account) + ';'
    );
  const args = [
    '--input-type=commonjs',
    '-e',
    program,
    '--',
    options.mode ?? 'context',
    options.dev ?? f.dev,
    options.ino ?? f.ino,
    f.provider,
    options.kind ?? 'legacy',
    options.operation ?? '',
    options.projection ?? '',
    options.accountId ?? '',
    options.nativeId ?? nativeId,
    options.accountDev ?? '',
    options.accountIno ?? '',
    options.historical ?? '',
  ];
  return spawnSync(
    options.protected === false ? process.execPath : '/run/current-system/sw/bin/setpriv',
    options.protected === false ? args : ['--no-new-privs', process.execPath, ...args],
    {
      encoding: 'utf8',
      timeout: 11000,
      maxBuffer: 512 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        OPENSSL_CONF: '',
        OPENSSL_MODULES: '',
        OPENSSL_ENGINES: '',
        LD_PRELOAD: '',
        LD_AUDIT: '',
        LD_LIBRARY_PATH: '',
      },
    }
  );
}
function generation(f: ReturnType<typeof fixture>) {
  const history = f.provider === 'anthropic' ? 'projects' : 'sessions',
    role = f.provider === 'anthropic' ? 'claude-projects' : 'codex-sessions';
  const material = {
    version: 1,
    purpose: 'reverie-plan-material-v1',
    operationId: operation,
    sessionId: nativeId,
    provider: f.provider,
    accountId: 'account-a',
    authDigest: sha('{"synthetic":"initial"}'),
    context: {
      source: {
        kind: 'home',
        relative: [f.provider === 'anthropic' ? '.claude' : '.codex'],
        dev: f.dev,
        ino: String(fs.statSync(f.dir, { bigint: true }).ino),
      },
      roles: [role],
      conversation: {
        nativeId,
        relative: [history, 'unencoded-project', f.file.split('/').at(-1)],
        sha256: sha(fs.readFileSync(f.file, 'utf8')),
      },
    },
  };
  const projection = digest(material),
    parent = join(f.home, '.reverie', 'plan-moves', operation, 'generation-' + projection),
    config = join(parent, f.provider === 'anthropic' ? 'claude' : 'codex');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.symlinkSync(
    '/home/agent/' + (f.provider === 'anthropic' ? '.claude' : '.codex') + '/' + history,
    join(config, history)
  );
  const hs = fs.statSync(join(f.dir, history), { bigint: true }),
    context = {
      roles: [{ role, dev: String(hs.dev), ino: String(hs.ino) }],
      conversationDigest: material.context.conversation.sha256,
    };
  fs.writeFileSync(
    join(parent, 'manifest.json'),
    JSON.stringify({ version: 1, purpose: 'reverie-plan-generation-v1', material, context }),
    { mode: 0o600 }
  );
  const auth = join(config, f.provider === 'anthropic' ? '.credentials.json' : 'auth.json');
  fs.writeFileSync(auth, '{"synthetic":"initial"}', { mode: 0o600 });
  const cs = fs.statSync(config, { bigint: true });
  return {
    projection,
    parent,
    config,
    auth,
    historical: sha(JSON.stringify(context)),
    configDev: String(cs.dev),
    configIno: String(cs.ino),
  };
}
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)('fixed source metadata protocol', () => {
  it('checks genuine no-new-privileges before returning HOME custody', () => {
    const f = fixture(),
      good = run(f, { mode: 'home' }),
      bad = run(f, { mode: 'home', protected: false });
    expect(good.status, good.stderr).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({
      purpose: 'reverie-plan-source-home-v1',
      homeDev: f.dev,
      homeIno: f.ino,
      uid: process.getuid!(),
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
  });
  it.each(['anthropic', 'openai'] as const)(
    'finds only the exact %s thread without assuming project encoding',
    (provider) => {
      const f = fixture(provider),
        r = run(f);
      expect(r.status, r.stderr).toBe(0);
      const context = dockerPlanContextForProvider(JSON.parse(r.stdout).context, provider);
      expect(context.conversation).toMatchObject({ nativeId, sha256: sha(fs.readFileSync(f.file, 'utf8')) });
      expect(context.roles).toEqual(
        provider === 'anthropic' ? ['claude-projects', 'claude-instructions'] : ['codex-sessions', 'codex-instructions']
      );
      expect(fs.readFileSync(f.file, 'utf8')).toBe('SYNTHETIC_SELECTED_THREAD\n');
    }
  );
  it('takes external account intake only from the actual root inode and excludes account-wide instructions', () => {
    const f = fixture(),
      history = join(f.account, 'projects', 'external');
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    fs.copyFileSync(f.file, join(history, nativeId + '.jsonl'));
    fs.writeFileSync(join(f.account, 'CLAUDE.md'), 'FOREIGN_INSTRUCTIONS', { mode: 0o600 });
    const s = fs.statSync(f.account, { bigint: true }),
      r = run(f, { kind: 'account', accountDev: String(s.dev), accountIno: String(s.ino) });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).context.roles).toEqual(['claude-projects']);
    expect(run(f, { kind: 'account', accountDev: String(s.dev), accountIno: '99999' }).stdout).toBe('');
  });
  it('refuses ambiguous matching threads rather than selecting by timestamp or directory name', () => {
    const f = fixture();
    fs.mkdirSync(join(f.dir, 'projects', 'duplicate'), { mode: 0o700 });
    fs.copyFileSync(f.file, join(f.dir, 'projects', 'duplicate', nativeId + '.jsonl'));
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
  it.each(['symlink', 'hardlink', 'writable', 'wrong-home'] as const)(
    'refuses %s custody without modifying the selected thread',
    (change) => {
      const f = fixture(),
        before = fs.readFileSync(f.file);
      if (change === 'symlink') {
        fs.renameSync(f.file, f.file + '.original');
        fs.symlinkSync(f.file + '.original', f.file);
      }
      if (change === 'hardlink') fs.linkSync(f.file, f.file + '.alias');
      if (change === 'writable') fs.chmodSync(f.file, 0o666);
      const r = run(f, change === 'wrong-home' ? { ino: '99999' } : {});
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(fs.readFileSync(f.file)).toEqual(before);
    }
  );
  it.each(['anthropic', 'openai'] as const)(
    'keeps installed %s auth historical while reading SDK-rotated private auth',
    (provider) => {
      const f = fixture(provider),
        g = generation(f),
        rotated = '{"synthetic":"SDK-rotated"}';
      fs.writeFileSync(g.auth, rotated, { mode: 0o600 });
      const options = {
        kind: 'generation',
        operation,
        projection: g.projection,
        accountId: 'account-a',
        historical: g.historical,
        accountDev: g.configDev,
        accountIno: g.configIno,
      };
      const r = run(f, { ...options, mode: 'auth' });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        installedAuthDigest: sha('{"synthetic":"initial"}'),
        observedAuthDigest: sha(rotated),
        auth: rotated,
      });
      expect(run(f, { ...options, mode: 'context' }).status).toBe(0);
      expect(run(f, { ...options, historical: '0'.repeat(64), mode: 'auth' }).stdout).toBe('');
      expect(fs.readFileSync(g.auth, 'utf8')).toBe(rotated);
    }
  );
  it('does not emit readable auth or context after a consuming close loses its acknowledgement', () => {
    const f = fixture(),
      g = generation(f),
      prefix =
        "const faultFs=require('node:fs');const actualClose=faultFs.closeSync;faultFs.closeSync=(fd)=>{actualClose(fd);throw Error('lost consuming close');};";
    const r = run(f, {
      mode: 'auth',
      kind: 'generation',
      operation,
      projection: g.projection,
      accountId: 'account-a',
      historical: g.historical,
      accountDev: g.configDev,
      accountIno: g.configIno,
      prefix,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('synthetic');
    const context = run(f, { prefix });
    expect(context.status).toBe(1);
    expect(context.stdout).toBe('');
  });
  it('detects real selected file replacement during a held FD read and emits no private material', () => {
    const f = fixture(),
      g = generation(f),
      prefix =
        "const faultFs=require('node:fs');const actualRead=faultFs.readSync;let changed=false;faultFs.readSync=(fd,...args)=>{const n=actualRead(fd,...args);if(!changed&&faultFs.readlinkSync('/proc/self/fd/'+fd).endsWith('.credentials.json')){changed=true;faultFs.writeFileSync(" +
        JSON.stringify(g.auth) +
        ",'{}');}return n;};";
    const r = run(f, {
      mode: 'auth',
      kind: 'generation',
      operation,
      projection: g.projection,
      accountId: 'account-a',
      historical: g.historical,
      accountDev: g.configDev,
      accountIno: g.configIno,
      prefix,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
  it('pins the historical generation config directory while allowing the auth file itself to rotate', () => {
    const f = fixture(),
      g = generation(f),
      renamed = g.config + '.retained';
    fs.renameSync(g.config, renamed);
    fs.mkdirSync(g.config, { mode: 0o700 });
    fs.copyFileSync(join(renamed, '.credentials.json'), join(g.config, '.credentials.json'));
    const r = run(f, {
      mode: 'auth',
      kind: 'generation',
      operation,
      projection: g.projection,
      accountId: 'account-a',
      historical: g.historical,
      accountDev: g.configDev,
      accountIno: g.configIno,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
  it('refuses nonprivate generation auth without silently changing its permissions', () => {
    const f = fixture(),
      g = generation(f);
    fs.chmodSync(g.auth, 0o644);
    const r = run(f, {
      mode: 'auth',
      kind: 'generation',
      operation,
      projection: g.projection,
      accountId: 'account-a',
      historical: g.historical,
      accountDev: g.configDev,
      accountIno: g.configIno,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(fs.statSync(g.auth).mode & 0o777).toBe(0o644);
  });
  it('refuses a local walk whose protected mount identity differs from its parent', () => {
    const f = fixture(),
      prefix =
        "const faultFs=require('node:fs');const actualReadFile=faultFs.readFileSync;let rootFd;faultFs.readFileSync=(p,...args)=>{const r=actualReadFile(p,...args);if(String(p).startsWith('/proc/self/fdinfo/')){rootFd??=p;if(p!==rootFd)return r.replace(/^mnt_id:.*$/m,'mnt_id: 999999999');}return r;};";
    const r = run(f, { prefix });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('reads newly created native history in an originally empty held generation without inventing old role proof', () => {
    const f = fixture('openai'),
      g = generation(f);
    const manifest = JSON.parse(fs.readFileSync(join(g.parent, 'manifest.json'), 'utf8'));
    manifest.material.context = { source: { kind: 'none' }, roles: [], conversation: null };
    manifest.context = { roles: [], conversationDigest: null };
    const projection = digest(manifest.material),
      parent = g.parent.replace(g.projection, projection);
    fs.renameSync(g.parent, parent);
    const config = join(parent, 'codex');
    fs.unlinkSync(join(config, 'sessions'));
    fs.mkdirSync(join(config, 'sessions'), { mode: 0o700 });
    fs.copyFileSync(f.file, join(config, 'sessions', 'rollout-' + nativeId + '.jsonl'));
    fs.writeFileSync(join(parent, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    const r = run(f, {
      kind: 'generation',
      operation,
      projection,
      accountId: 'account-a',
      historical: sha(JSON.stringify(manifest.context)),
      accountDev: g.configDev,
      accountIno: g.configIno,
    });
    expect(r.status, r.stderr).toBe(0);
    const context = dockerPlanContextForProvider(JSON.parse(r.stdout).context, 'openai');
    expect(context.source).toMatchObject({
      kind: 'home',
      relative: ['.reverie', 'plan-moves', operation, 'generation-' + projection, 'codex'],
    });
    expect(context.conversation?.nativeId).toBe(nativeId);
  });
});
