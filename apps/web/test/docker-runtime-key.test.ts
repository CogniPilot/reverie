import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerRuntimeKey } from '../src/docker-runtime-key.js';
function fixture() {
  return fs.mkdtempSync(join(tmpdir(), 'docker-key-'));
}
describe('private container-owned callback key', () => {
  it('initializes once and reopens the exact persisted key', () => {
    const dir = fixture(),
      first = new DockerRuntimeKey(dir),
      id = first.instanceId,
      bytes = first.key.toString('hex');
    expect(first.current()).toBe(true);
    first.close();
    const second = new DockerRuntimeKey(dir);
    expect(second.instanceId).toBe(id);
    expect(second.key.toString('hex')).toBe(bytes);
    second.close();
    fs.rmSync(dir, { recursive: true });
  });
  it('rejects an existing public directory without chmod repair', () => {
    const dir = fixture();
    fs.chmodSync(dir, 0o755);
    expect(() => new DockerRuntimeKey(dir)).toThrow();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    fs.rmSync(dir, { recursive: true });
  });
  it('retains original FD and revokes on same-byte pathname replacement', () => {
    const dir = fixture(),
      key = new DockerRuntimeKey(dir),
      path = join(dir, 'worker-identity.json'),
      body = fs.readFileSync(path);
    fs.renameSync(path, path + '.original');
    fs.writeFileSync(path, body, { mode: 0o600 });
    expect(key.current()).toBe(false);
    key.close();
    fs.rmSync(dir, { recursive: true });
  });
  it('revocation is sticky even when original inode is restored', () => {
    const dir = fixture(),
      key = new DockerRuntimeKey(dir),
      path = join(dir, 'worker-identity.json');
    fs.renameSync(path, path + '.original');
    expect(key.current()).toBe(false);
    fs.renameSync(path + '.original', path);
    expect(key.current()).toBe(false);
    key.close();
    fs.rmSync(dir, { recursive: true });
  });
  it('rejects symlink keys without following their target', () => {
    const dir = fixture();
    fs.writeFileSync(join(dir, 'target'), 'private', { mode: 0o600 });
    fs.symlinkSync(join(dir, 'target'), join(dir, 'worker-identity.json'));
    expect(() => new DockerRuntimeKey(dir)).toThrow();
    expect(fs.readFileSync(join(dir, 'target'), 'utf8')).toBe('private');
    fs.rmSync(dir, { recursive: true });
  });
  it('rejects nested duplicate or noncanonical private key records', () => {
    const dir = fixture();
    fs.writeFileSync(join(dir, 'worker-identity.json'), '{"version":1,"version":1}', { mode: 0o600 });
    expect(() => new DockerRuntimeKey(dir)).toThrow();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('consuming original key closure', () => {
  it('a second successful cleanup never closes a descriptor reused by another owner', () => {
    const dir = fixture(),
      key = new DockerRuntimeKey(dir);
    key.close();
    const other = fs.openSync(join(dir, 'unrelated'), 'w', 0o600);
    key.close();
    expect(fs.fstatSync(other).isFile()).toBe(true);
    fs.closeSync(other);
    fs.rmSync(dir, { recursive: true });
  });
  it('retains a genuine consuming-close error and never retries the original numeric descriptor', () => {
    const dir = fixture(),
      key = new DockerRuntimeKey(dir),
      native = fs.closeSync,
      first = Error('unknown consuming close');
    let injected = false;
    const spy = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      native(fd);
      if (!injected) {
        injected = true;
        throw first;
      }
    });
    let actual: unknown;
    try {
      key.close();
    } catch (error) {
      actual = error;
    }
    const calls = spy.mock.calls.length;
    expect(actual).toBeInstanceOf(AggregateError);
    expect(() => key.close()).toThrow(actual as Error);
    expect(spy).toHaveBeenCalledTimes(calls);
    expect(key.current()).toBe(false);
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true });
  });
});
describe('what a new office process would read, for the office’s own restart', () => {
  it('says the same identity is on disk after a change that revoked the key but left its bytes alone', () => {
    const dir = fixture(),
      key = new DockerRuntimeKey(dir),
      stamp = key.stamp();
    expect(key.sameOnDisk()).toBe(true);
    // A file made beside the key changes the directory, which revokes the key for good.
    fs.writeFileSync(join(dir, 'stray'), '');
    expect(key.current()).toBe(false);
    expect(key.stamp()).not.toBe(stamp);
    expect(key.sameOnDisk()).toBe(true);
    // Reading changes nothing, and does not make the key current again.
    expect(key.stamp()).toBe(key.stamp());
    expect(key.current()).toBe(false);
    const again = new DockerRuntimeKey(dir);
    expect(again.instanceId).toBe(key.instanceId);
    again.close();
    key.close();
    fs.rmSync(dir, { recursive: true });
  });
  it('says no when another key, no key or a public key is on disk, and creates nothing', () => {
    const dir = fixture(),
      key = new DockerRuntimeKey(dir),
      path = join(dir, 'worker-identity.json'),
      body = fs.readFileSync(path, 'utf8');
    const other = JSON.parse(body) as { key: string };
    other.key = other.key.startsWith('0') ? '1' + other.key.slice(1) : '0' + other.key.slice(1);
    fs.writeFileSync(path, JSON.stringify(other));
    expect(key.sameOnDisk()).toBe(false);
    fs.writeFileSync(path, body);
    expect(key.sameOnDisk()).toBe(true);
    fs.chmodSync(path, 0o644);
    expect(key.sameOnDisk()).toBe(false);
    fs.chmodSync(path, 0o600);
    fs.chmodSync(dir, 0o755);
    expect(key.sameOnDisk()).toBe(false);
    fs.chmodSync(dir, 0o700);
    fs.rmSync(path);
    expect(key.sameOnDisk()).toBe(false);
    expect(fs.existsSync(path)).toBe(false);
    expect(key.stamp()).toMatch(/\|unreadable$/);
    key.close();
    fs.rmSync(dir, { recursive: true });
  });
});
