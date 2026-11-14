/** Real unprivileged child + actual filesystem/FD checks. Only fixed HOME is
 * projected into an owned unit directory; production has no path option. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DOCKER_OWNER_STOP_NATIVE_PROGRAM, DOCKER_OWNER_STOP_NATIVE_ENV } from '../src/docker-owner-stop-native.js';
const sid = '58b141f3-ae52-4fc9-9c32-0c4e0ccd0605',
  source = 'f'.repeat(64),
  fence = 'a'.repeat(32);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'owner-stop-native-'));
  roots.push(root);
  const home = join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const s = fs.statSync(home, { bigint: true });
  return {
    root,
    home,
    dir: join(home, '.reverie-stop'),
    file: join(home, '.reverie-stop', 'reverie-stop-' + fence),
    dev: String(s.dev),
    ino: String(s.ino),
  };
}
function run(
  f: ReturnType<typeof fixture>,
  mode: 'observe-home' | 'fence' = 'fence',
  options: { prefix?: string; input?: string | Buffer; dev?: string; ino?: string; home?: string } = {}
) {
  const declaration = "const HOME = '/home/agent';";
  expect(DOCKER_OWNER_STOP_NATIVE_PROGRAM.split(declaration)).toHaveLength(2);
  const program =
    (options.prefix ?? '') +
    DOCKER_OWNER_STOP_NATIVE_PROGRAM.replace(
      declaration,
      'const HOME = ' + JSON.stringify(options.home ?? f.home) + ';'
    );
  const args = [mode, sid, '9', source, ...(mode === 'fence' ? [options.dev ?? f.dev, options.ino ?? f.ino] : [])];
  return spawnSync(process.execPath, ['--input-type=commonjs', '-e', program, '--', ...args], {
    input: options.input ?? fence + '\n',
    encoding: 'utf8',
    timeout: 11000,
    maxBuffer: 65536,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      OPENSSL_CONF: '',
      OPENSSL_MODULES: '',
      OPENSSL_ENGINES: '',
      LD_PRELOAD: '',
      LD_AUDIT: '',
      LD_LIBRARY_PATH: '',
    },
  });
}
function existing(f: ReturnType<typeof fixture>, bytes: string) {
  fs.mkdirSync(f.dir, { mode: 0o700 });
  fs.writeFileSync(f.file, bytes, { mode: 0o600 });
}
describe('fixed owner-stop protocol environment', () => {
  it('contains only Config.Env values and clears pre-JS code loading inputs', () => {
    expect(DOCKER_OWNER_STOP_NATIVE_ENV).toContain('OPENSSL_CONF=');
    expect(DOCKER_OWNER_STOP_NATIVE_ENV).toContain('NODE_OPTIONS=');
    expect(DOCKER_OWNER_STOP_NATIVE_ENV.every((value) => value.includes('=') && !value.startsWith('--'))).toBe(true);
  });
});
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)(
  'actual Linux common-HOME fence primitive',
  () => {
    it('observes actual HOME identity after its close without making a fence directory', () => {
      const f = fixture(),
        r = run(f, 'observe-home');
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        version: 1,
        purpose: 'reverie-owner-stop-home-v1',
        sessionId: sid,
        sessionGeneration: 9,
        sourceContainerId: source,
        homeDev: f.dev,
        homeIno: f.ino,
        uid: process.getuid!(),
        gid: process.getgid!(),
        mode: '0700',
      });
      expect(fs.existsSync(f.dir)).toBe(false);
    });
    it('earns fenced only after exact O_EXCL publication, readback and closed private FD owners', () => {
      const f = fixture(),
        r = run(f);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toMatchObject({
        purpose: 'reverie-owner-stop-fenced-v1',
        sessionId: sid,
        sessionGeneration: 9,
        sourceContainerId: source,
        homeDev: f.dev,
        homeIno: f.ino,
        outcome: 'fenced',
        fenceSha256: createHash('sha256').update(fence).digest('hex'),
      });
      expect(r.stdout).not.toContain(fence);
      expect(fs.readFileSync(f.file, 'utf8')).toBe('fenced\n');
      expect(fs.statSync(f.file).nlink).toBe(2);
      expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(f.dir).mode & 0o777).toBe(0o700);
    });
    it('blocks the original shell O_EXCL signal claim without invoking any signal', () => {
      const f = fixture();
      expect(run(f).status).toBe(0);
      const claim =
        'set -C; if ! { echo \'signal 123\' > "$1"; } 2>/dev/null; then [ -e "$1" ] && exit 4; exit 6; fi; exit 0';
      const legacy = spawnSync('/bin/sh', ['-c', claim, 'stop-agent-claim', f.file], {
        encoding: 'utf8',
        timeout: 2000,
      });
      expect(legacy.status, legacy.stderr).toBe(4);
      expect(fs.readFileSync(f.file, 'utf8')).toBe('fenced\n');
    });
    it('reads an existing canonical fenced outcome without replacing its inode or bytes', () => {
      const f = fixture();
      existing(f, 'fenced\n');
      const before = fs.statSync(f.file, { bigint: true });
      expect(run(f).status).toBe(0);
      const after = fs.statSync(f.file, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(fs.readFileSync(f.file, 'utf8')).toBe('fenced\n');
    });
    it.each(['signal 12345\n', '', 'fenced', 'opaque\n'])('preserves an uncertain existing outcome %j', (bytes) => {
      const f = fixture();
      existing(f, bytes);
      const before = fs.statSync(f.file, { bigint: true });
      const r = run(f);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).not.toContain(fence);
      const after = fs.statSync(f.file, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
    });
    it.each(['dev', 'ino'] as const)('refuses wrong actual HOME %s before any fence effects', (key) => {
      const f = fixture(),
        r = run(f, 'fence', { [key]: '999999999999999999' });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(fs.existsSync(f.dir)).toBe(false);
    });
    it.each(['bad', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(34), fence + '\nextra', Buffer.alloc(32, 0xe1)])(
      'refuses malformed bounded stdin before fence effects',
      (input) => {
        const f = fixture(),
          r = run(f, 'fence', { input });
        expect(r.status).toBe(1);
        expect(r.stdout).toBe('');
        expect(fs.existsSync(f.dir)).toBe(false);
      }
    );
    it('refuses HOME and stop-directory symlinks without touching their targets', () => {
      const f = fixture(),
        alias = join(f.root, 'alias');
      fs.symlinkSync(f.home, alias);
      expect(run(f, 'fence', { home: alias }).status).toBe(1);
      expect(fs.existsSync(f.dir)).toBe(false);
      const other = join(f.root, 'other');
      fs.mkdirSync(other, { mode: 0o700 });
      fs.symlinkSync(other, f.dir);
      expect(run(f).status).toBe(1);
      expect(fs.readdirSync(other)).toEqual([]);
    });
    it('refuses unsafe directory permissions and symlink markers while allowing complete marker links', () => {
      const f = fixture();
      fs.chmodSync(f.home, 0o755);
      expect(run(f).status).toBe(1);
      expect(fs.existsSync(f.dir)).toBe(false);
      fs.chmodSync(f.home, 0o700);
      existing(f, 'fenced\n');
      fs.chmodSync(f.dir, 0o755);
      expect(run(f).status).toBe(1);
      fs.chmodSync(f.dir, 0o700);
      const link = join(f.root, 'linked');
      fs.linkSync(f.file, link);
      expect(run(f).status).toBe(0); // Nonsecret canonical stop markers may retain own staging links.
      fs.unlinkSync(link);
      const target = join(f.root, 'target');
      fs.renameSync(f.file, target);
      fs.symlinkSync(target, f.file);
      expect(run(f).status).toBe(1);
      expect(fs.readFileSync(target, 'utf8')).toBe('fenced\n');
    });
    it.each(['stdin', 'file', 'directory', 'home'])(
      'withholds ACK after a lost actual %s consuming-close reply and never retries that FD',
      (role) => {
        const f = fixture(),
          marker = join(f.root, 'closes.json');
        const selected = role === 'file' ? f.file : role === 'directory' ? f.dir : f.home;
        const prefix = `(()=>{const fs=require('node:fs'),original=fs.close;let target,start=0,attempts=[];fs.close=(fd,cb)=>{let path='';try{path=fs.readlinkSync('/proc/self/fd/'+fd)}catch{};attempts.push(fd);if(target===undefined&&(${JSON.stringify(role)}==='stdin'?fd===0:path===${JSON.stringify(selected)})){target=fd;start=attempts.length-1;}const lose=target===fd;original(fd,error=>cb(error|| (lose?Object.assign(Error('lost close'),{code:'EIO'}):null)));};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({attempts:attempts.slice(start).filter(fd=>fd===target).length}),{mode:0o600}));})();`;
        const r = run(f, 'fence', { prefix });
        expect(r.status).toBe(1);
        expect(r.stdout).toBe('');
        expect(JSON.parse(fs.readFileSync(marker, 'utf8')).attempts).toBe(1);
        if (role === 'stdin') expect(fs.existsSync(f.dir)).toBe(false);
        else expect(fs.readFileSync(f.file, 'utf8')).toBe('fenced\n');
      }
    );
    it.each(['open', 'sync', 'close', 'before-link', 'after-link', 'directory-sync'])(
      'survives an actual child crash at %s with final absent or complete and fresh initialization live',
      (boundary) => {
        const f = fixture();
        const prefix = `(()=>{const fs=require('node:fs');const boundary=${JSON.stringify(boundary)};const stage=path=>String(path).includes('/.fenced-stage-');const named=fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd)}catch{return ''}};const crash=()=>process.kill(process.pid,'SIGKILL');
      const open=fs.open;fs.open=(path,...args)=>{const cb=args.pop();open(path,...args,(error,fd)=>{if(!error&&boundary==='open'&&stage(path))crash();cb(error,fd)})};
      const sync=fs.fsync;fs.fsync=(fd,cb)=>{const path=named(fd);sync(fd,error=>{if(!error&&((boundary==='sync'&&stage(path))||(boundary==='directory-sync'&&path===${JSON.stringify(f.dir)}&&fs.existsSync(${JSON.stringify(f.file)}))))crash();cb(error)})};
      const close=fs.close;fs.close=(fd,cb)=>{const path=named(fd);close(fd,error=>{if(!error&&boundary==='close'&&stage(path))crash();cb(error)})};
      const link=fs.link;fs.link=(from,to,cb)=>{if(boundary==='before-link')crash();link(from,to,error=>{if(!error&&boundary==='after-link')crash();cb(error)})};})();`;
        const lost = run(f, 'fence', { prefix });
        expect(lost.signal).toBe('SIGKILL');
        expect(lost.stdout).toBe('');
        const published = boundary === 'after-link' || boundary === 'directory-sync';
        expect(fs.existsSync(f.file)).toBe(published);
        if (published) expect(fs.readFileSync(f.file, 'utf8')).toBe('fenced\n');
        const orphanNames = fs.readdirSync(f.dir).filter((name) => name.startsWith('.fenced-stage-'));
        expect(orphanNames).toHaveLength(1);
        const orphan = join(f.dir, orphanNames[0]!);
        const original = fs.readFileSync(orphan);
        const ino = fs.statSync(orphan).ino;
        const fresh = run(f);
        expect(fresh.status, fresh.stderr).toBe(0);
        expect(fs.readFileSync(f.file, 'utf8')).toBe('fenced\n');
        expect(fs.statSync(orphan).ino).toBe(ino);
        expect(fs.readFileSync(orphan)).toEqual(original);
      }
    );
    it('bounds a caller that never finishes stdin without touching HOME', () => {
      const f = fixture(),
        r = run(f, 'fence', { prefix: "require('node:fs').read=()=>{};" });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(fs.existsSync(f.dir)).toBe(false);
    }, 12000);
  }
);
