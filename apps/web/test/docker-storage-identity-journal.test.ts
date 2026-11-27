import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerStorageIdentityJournal } from '../src/docker-storage-identity-journal.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'storage-identity-'));
  directories.push(directory);
  return join(directory, 'docker-storage-identity.jsonl');
}
const A = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222';
const identity = (employeeId: string, device = '4', filesystemId = '9988') => ({
  employeeId,
  home: { ino: '5', uid: 1000, gid: 100, mode: 448 },
  nix: { ino: '6', uid: 1000, gid: 100, mode: 448 },
  device,
  filesystemId,
});

describe('the office’s own record of employee storage', () => {
  it('keeps the newest record of each employee in a private file, and writes the same facts once', () => {
    const path = file();
    let now = 100;
    const journal = new DockerStorageIdentityJournal(path, () => now);
    expect(journal.read(A)).toBeUndefined();
    journal.remember(identity(A));
    journal.remember(identity(B, '4', '77'));
    now = 200;
    journal.remember(identity(A));
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    journal.remember(identity(A, '7'));
    expect(journal.read(A)).toEqual({ version: 1, ...identity(A, '7'), recordedAt: 200 });
    expect(journal.read(B)).toMatchObject({ filesystemId: '77', recordedAt: 100 });
    // Another process reads the same.
    expect(new DockerStorageIdentityJournal(path).read(A)?.device).toBe('7');
  });

  it('proves nothing with a file it cannot trust: a readable one, or a malformed one', () => {
    const path = file();
    const journal = new DockerStorageIdentityJournal(path);
    journal.remember(identity(A));
    chmodSync(path, 0o644);
    expect(journal.read(A)).toBeUndefined();
    expect(() => journal.remember(identity(A, '7'))).toThrow('DOCKER_STORAGE_IDENTITY_JOURNAL_UNCONFIRMED');
    chmodSync(path, 0o600);
    expect(journal.read(A)?.device).toBe('4');
    writeFileSync(path, '{"version":1}\n', { mode: 0o600 });
    expect(journal.read(A)).toBeUndefined();
  });

  it('refuses facts that could not be verified later', () => {
    const journal = new DockerStorageIdentityJournal(file());
    expect(() => journal.remember(identity(A, '4', '0'))).toThrow();
    expect(() => journal.remember({ ...identity(A), home: { ino: '0', uid: 1000, gid: 100, mode: 448 } })).toThrow();
    expect(() => journal.remember({ ...identity('not-an-employee') })).toThrow();
    expect(journal.read(A)).toBeUndefined();
  });

  it('sets a full file aside and carries the newest record of everyone into the new one', () => {
    const path = file();
    const journal = new DockerStorageIdentityJournal(path);
    // A file that is almost full of superseded records of one employee, after one record of another.
    const line = (value: ReturnType<typeof identity>) => JSON.stringify({ ...value, version: 1, recordedAt: 1 }) + '\n';
    let lines = line(identity(B, '4', '77'));
    for (let device = 10; lines.length < 511 * 1024; device++) lines += line(identity(A, String(device)));
    writeFileSync(path, lines, { mode: 0o600 });
    const before = statSync(path).size;
    for (let device = 1; device < 9; device++) journal.remember(identity(A, String(device)));
    expect(statSync(path).size).toBeLessThan(before);
    expect(statSync(path + '.previous').size).toBeGreaterThan(500 * 1024);
    expect(journal.read(A)?.device).toBe('8');
    expect(journal.read(B)?.filesystemId).toBe('77');
  });
});
