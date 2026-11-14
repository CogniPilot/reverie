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
