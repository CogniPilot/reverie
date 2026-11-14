/** Closed fixture DATA and actual private contract files; no API/provider/Engine effects. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  type CanaryFixture,
  LEGACY,
  decodeCanaryFixture,
  loadCanaryFixtureContract,
  validateCanaryFixture,
} from './fixtures/boxed-canary-fixture-contract.mjs';
import { enrollDockerCanaryOwner, loginDockerCanaryOwner } from './helpers/docker-continuation-auth-canary.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
type MutableFixture = { -readonly [K in keyof CanaryFixture]: CanaryFixture[K] } & {
  home: { -readonly [K in keyof CanaryFixture['home']]: CanaryFixture['home'][K] };
};
function fresh(): MutableFixture {
  return {
    ...LEGACY,
    employeeId: '55555555-5555-4555-8555-555555555555',
    sessionId: '66666666-6666-4666-8666-666666666666',
    providerThread: '77777777-7777-4777-8777-777777777777',
    operationId: '88888888-8888-4888-8888-888888888888',
    sourceTask: 'boxed-provider-source3-fixture-20261114',
    sourceFixtureId: '9efa15b2b0b88ce475fad8e3eda4aaf3',
    sourceCid: '87a2a3ca71ae99a73abdd3087c48c6550c64a314641634e44976d6c55c83408b',
    home: { ...LEGACY.home, path: '/tmp/reverie/tasks/boxed-provider-source3-fixture-20261114/home', ino: '93865801' },
  };
}
function file(raw: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'fixture-contract-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const name = path.join(root, 'boxed-canary-contract.json');
  fs.writeFileSync(name, raw, { mode: 0o600, flag: 'wx' });
  return name;
}
const encode = (value: unknown) => JSON.stringify(value) + '\n';
describe('explicit synthetic office contract', () => {
  it('loads the maintained ESM provider through its extensionless installed entry', () => {
    const name = file(encode(fresh()));
    const entry = path.join(path.dirname(name), 'claude');
    fs.copyFileSync(new URL('./fixtures/boxed-fake-provider.mjs', import.meta.url), entry);
    fs.copyFileSync(
      new URL('./fixtures/boxed-canary-fixture-contract.mjs', import.meta.url),
      path.join(path.dirname(name), 'boxed-canary-fixture-contract.mjs')
    );
    const result = spawnSync(process.execPath, [entry, '--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('2.1.251 (Claude Code; synthetic boxed fixture)\n');
  });

  it('preserves immutable legacy defaults and decodes the independent fresh office', () => {
    expect(loadCanaryFixtureContract()).toBe(LEGACY);
    const selected = loadCanaryFixtureContract(file(encode(fresh())));
    expect(selected).toEqual(fresh());
    expect(Object.isFrozen(selected.home)).toBe(true);
    expect(LEGACY.sessionId).toBe('22222222-2222-4222-8222-222222222222');
  });
  it('supports future synthetic CI UUIDs, generations, images and exact observed account IDs', () => {
    const value = fresh();
    value.employeeId = '99999999-9999-4999-8999-999999999999';
    value.sourceTask = 'ci-agent-office-runner42';
    value.home = { ...value.home, path: '/tmp/reverie/tasks/ci-agent-office-runner42/home', uid: 1001, gid: 121 };
    value.generation = 3;
    value.imageId = 'sha256:' + 'a'.repeat(64);
    expect(decodeCanaryFixture(encode(value))).toEqual(value);
  });
  it('refuses open fields, mixed source provenance, invalid identities and malformed frames', () => {
    for (const change of [
      (v: ReturnType<typeof fresh> & Record<string, unknown>) => {
        v.endpoint = 'http://example.test';
      },
      (v: ReturnType<typeof fresh>) => {
        v.sourceTask = '../private';
      },
      (v: ReturnType<typeof fresh>) => {
        v.home.path = '/home/personal';
      },
      (v: ReturnType<typeof fresh>) => {
        v.home.uid = -1;
      },
      (v: ReturnType<typeof fresh>) => {
        v.home.ino = '0';
      },
      (v: ReturnType<typeof fresh>) => {
        v.generation = 0;
      },
      (v: ReturnType<typeof fresh>) => {
        v.sessionId = v.employeeId;
      },
      (v: ReturnType<typeof fresh>) => {
        v.imageId = 'arbitrary-tag';
      },
    ]) {
      const value = fresh();
      change(value);
      expect(() => validateCanaryFixture(value)).toThrow();
    }
    const raw = encode(fresh());
    for (const altered of [
      raw.trimEnd(),
      raw.replace('"version":1', '"version":1,"version":1'),
      raw.slice(0, -4),
      ' '.repeat(4097),
    ])
      expect(() => decodeCanaryFixture(altered)).toThrow();
  });
  it('uses an actual bounded private file and refuses wrong mode or symlink custody', () => {
    const name = file(encode(fresh()));
    fs.chmodSync(name, 0o644);
    expect(() => loadCanaryFixtureContract(name)).toThrow();
    fs.chmodSync(name, 0o600);
    const link = path.join(path.dirname(name), 'alias');
    fs.renameSync(name, link);
    fs.symlinkSync(link, name);
    expect(() => loadCanaryFixtureContract(name)).toThrow();
  });
  it('refuses an invalid explicit contract before any enrollment or login request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const name = file(encode({ ...fresh(), endpoint: 'http://example.test' }));
    await expect(enrollDockerCanaryOwner('http://127.0.0.1:32799', path.dirname(name), name)).rejects.toThrow();
    await expect(
      loginDockerCanaryOwner('http://127.0.0.1:32799', path.dirname(name), 'a'.repeat(64), 'owner-session.json', name)
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
