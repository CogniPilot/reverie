import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DockerPlanAccountSnapshot } from '../src/docker-plan-account.js';
import type { PlanAccount } from '../src/plan-accounts.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function fixture(provider: 'anthropic' | 'openai' = 'anthropic', auth = '{"synthetic":"account-b"}') {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'plan-account-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const name = provider === 'anthropic' ? '.credentials.json' : 'auth.json',
    file = join(root, name);
  fs.writeFileSync(file, auth, { mode: 0o600 });
  const profile = { id: 'account-b', label: 'B', provider, configDir: root, openCodeDataDir: join(root, 'data') };
  const account: PlanAccount = {
    id: 'account-b',
    label: 'B',
    provider,
    configDir: root,
    realDir: root,
    profileId: profile.id,
    isDefault: false,
    profile,
  };
  const plans = { account: vi.fn(async () => structuredClone(account)) };
  return { root, file, name, account, plans, auth };
}
describe('protected selected account snapshot', () => {
  it.each(['anthropic', 'openai'] as const)(
    'reads only the actual selected %s fixed auth file and exposes no secrets in descriptors',
    async (provider) => {
      const f = fixture(provider),
        before = fs.readFileSync(f.file),
        s = await DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {});
      expect(s.authText()).toBe(f.auth);
      const stat = fs.statSync(f.root, { bigint: true });
      expect(s.rootIdentity()).toMatchObject({ dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid) });
      expect(s.descriptor).toMatchObject({
        id: 'account-b',
        provider,
        authDigest: createHash('sha256').update(f.auth).digest('hex'),
      });
      expect(JSON.stringify(s.descriptor)).not.toContain(f.auth);
      expect(fs.readFileSync(f.file)).toEqual(before);
      s.close();
      expect(() => s.authText()).toThrow();
    }
  );
  it.each(['symlink', 'hardlink', 'writable', 'oversize', 'malformed'] as const)(
    'refuses %s material without changing files or exposing private parser diagnostics',
    async (change) => {
      const f = fixture();
      if (change === 'symlink') {
        fs.renameSync(f.file, f.file + '.original');
        fs.symlinkSync(f.file + '.original', f.file);
      }
      if (change === 'hardlink') fs.linkSync(f.file, f.file + '.other');
      if (change === 'writable') fs.chmodSync(f.file, 0o666);
      if (change === 'oversize') fs.writeFileSync(f.file, 'x'.repeat(128 * 1024 + 1));
      if (change === 'malformed') fs.writeFileSync(f.file, 'SECRET-DO-NOT-PRINT-ACCOUNT');
      const before = fs.readFileSync(f.file);
      await expect(DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {})).rejects.toMatchObject({
        code: 'DOCKER_PLAN_ACCOUNT_UNCONFIRMED',
        message: expect.not.stringContaining('SECRET-DO-NOT-PRINT'),
      });
      expect(fs.readFileSync(f.file)).toEqual(before);
    }
  );
  it('rejects changed canonical account/profile after the awaited second catalogue read', async () => {
    const f = fixture();
    f.plans.account
      .mockImplementationOnce(async () => structuredClone(f.account))
      .mockImplementationOnce(async () => ({
        ...structuredClone(f.account),
        profile: { ...f.account.profile, label: 'changed' },
      }));
    await expect(DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {})).rejects.toMatchObject({
      code: 'DOCKER_PLAN_ACCOUNT_UNCONFIRMED',
    });
  });
  it('does not convert a revoked grant after an await into private account authority', async () => {
    const f = fixture();
    let active = true;
    f.plans.account.mockImplementation(async () => {
      active = false;
      return structuredClone(f.account);
    });
    await expect(
      DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {
        if (!active) throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
  });
  it('holds a private FD but rejects atomic auth replacement and directory retargeting before payload use', async () => {
    const f = fixture(),
      s = await DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {});
    const original = s.descriptor.canonicalSnapshotDigest;
    fs.writeFileSync(f.file + '.next', '{"synthetic":"rotated"}', { mode: 0o600 });
    fs.renameSync(f.file + '.next', f.file);
    expect(() => s.authText()).toThrow();
    s.close();
    const fresh = await DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {});
    expect(fresh.descriptor.canonicalSnapshotDigest).not.toBe(original);
    fs.renameSync(f.root, f.root + '.retained');
    roots.push(f.root + '.retained');
    fs.mkdirSync(f.root, { mode: 0o700 });
    fs.writeFileSync(f.file, f.auth, { mode: 0o600 });
    expect(() => fresh.require()).toThrow();
    fresh.close();
  });
  it('consumes both exact held FDs once even if an actual close reports unknown, and publishes no usable snapshot afterward', async () => {
    const f = fixture(),
      open = fs.openSync.bind(fs),
      close = fs.closeSync.bind(fs);
    const held: number[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]) === f.root || String(args[0]).endsWith('/' + f.name)) held.push(fd);
      return fd;
    });
    const s = await DockerPlanAccountSnapshot.capture(f.plans, 'account-b', () => {});
    expect(held).toHaveLength(2);
    const closed: number[] = [];
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (held.includes(fd)) {
        closed.push(fd);
        close(fd);
        if (fd === held[1]) throw Error('actual close reply unknown');
      } else close(fd);
    });
    expect(() => s.close()).toThrow();
    expect(closed.sort()).toEqual([...held].sort());
    expect(() => s.authText()).toThrow();
    expect(() => s.close()).toThrow();
    expect(closed).toHaveLength(2);
  });
});
