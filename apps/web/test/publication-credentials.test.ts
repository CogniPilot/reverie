import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, chmod, lstat, symlink, link, writeFile, unlink, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PublicationCredentialVault, PublicationVaultError, type PublicationCredentialAudit } from '../src/publication-credentials.js';

const PAT = 'ghp_synthetic_owner_pat_0123456789';
const NEXT = 'github_pat_synthetic_rotated_9876543210';
const allow = () => {};

describe('private publication credential vault', () => {
  let root: string;
  let directory: string;
  let vault: PublicationCredentialVault;
  let audit: PublicationCredentialAudit[];
  let auditHook: (() => void | Promise<void>) | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(realpathSync(tmpdir()), 'publication-vault-'));
    directory = join(root, 'vault'); audit = []; auditHook = undefined;
    vault = new PublicationCredentialVault(directory, { audit: async entry => { audit.push({ ...entry }); await auditHook?.(); } });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('lists without provisioning and keeps PATs write-only across create, rotation and deletion', async () => {
    expect(await vault.metadata('owner-a')).toEqual([]);
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const token = await vault.create('owner-a', { name: 'publish', label: 'Release', token: PAT, repositories: ['example/project'] }, allow);
    expect(token).toMatchObject({ name: 'publish', label: 'Release', repositories: ['example/project'] });
    expect(JSON.stringify(token)).not.toContain(PAT);
    expect(await vault.metadata('owner-a')).toEqual([token]);
    expect(await vault.metadata('owner-b')).toEqual([]);
    expect((await vault.material('owner-a', token.id, allow)).toString()).toBe(PAT);
    await expect(vault.material('owner-b', token.id, allow)).rejects.toMatchObject({ code: 'PUBLICATION_FORBIDDEN' });
    const changed = await vault.update('owner-a', token.id, { token: NEXT, label: null }, allow);
    expect(changed.id).toBe(token.id); expect(changed).not.toHaveProperty('label');
    expect((await vault.material('owner-a', token.id, allow)).toString()).toBe(NEXT);
    expect(audit.map(row => row.action)).toEqual(['publication-token-create', 'publication-token-update']);
    expect(JSON.stringify(audit)).not.toContain(PAT); expect(JSON.stringify(audit)).not.toContain(NEXT);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, 'tokens.json'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(directory, 'vault.lock'))).mode & 0o777).toBe(0o600);
    expect(await vault.remove('owner-a', token.id, allow)).toEqual({ id: token.id, deleted: true });
    expect(await vault.metadata('owner-a')).toEqual([]);
    await expect(vault.material('owner-a', token.id, allow)).rejects.toMatchObject({ code: 'PUBLICATION_FORBIDDEN' });
  });

  it('binds grant IDs to their owner and refuses unknown, duplicate and malformed IDs', async () => {
    const token = await vault.create('owner-a', { name: 'publish', token: PAT }, allow);
    await vault.assertGrantIds('owner-a', [token.id]);
    for (const ids of [[token.id, token.id], ['not-an-id'], Array.from({ length: 65 }, () => randomUUID())])
      await expect(vault.assertGrantIds('owner-a', ids)).rejects.toMatchObject({ code: 'PUBLICATION_INVALID' });
    await expect(vault.assertGrantIds('owner-b', [token.id])).rejects.toMatchObject({ code: 'PUBLICATION_NOT_FOUND' });
    await expect(vault.assertGrantIds('owner-a', [randomUUID()])).rejects.toMatchObject({ code: 'PUBLICATION_NOT_FOUND' });
  });

  it('serializes distinct vault instances and rejects duplicate owner names without losing writes', async () => {
    const other = new PublicationCredentialVault(directory, { audit: () => {} });
    await Promise.all([
      vault.create('owner-a', { name: 'first', token: PAT }, allow),
      other.create('owner-a', { name: 'second', token: NEXT }, allow),
    ]);
    expect((await vault.metadata('owner-a')).map(row => row.name).sort()).toEqual(['first', 'second']);
    await expect(other.create('owner-a', { name: 'first', token: NEXT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    await other.create('owner-b', { name: 'first', token: NEXT }, allow);
    expect(await vault.metadata('owner-b')).toHaveLength(1);
  });

  it('retains existing bytes if audit fails or authority is revoked during audit', async () => {
    const token = await vault.create('owner-a', { name: 'publish', token: PAT }, allow);
    const file = join(directory, 'tokens.json'); const before = await readFile(file);
    auditHook = () => { throw new Error(NEXT); };
    try { await vault.update('owner-a', token.id, { token: NEXT }, allow); throw new Error('should refuse'); }
    catch (error) { expect(error).toBeInstanceOf(PublicationVaultError); expect(String(error)).not.toContain(NEXT); }
    expect(await readFile(file)).toEqual(before);
    let current = true;
    auditHook = () => { current = false; };
    await expect(vault.update('owner-a', token.id, { token: NEXT }, () => {
      if (!current) throw new PublicationVaultError('PUBLICATION_FORBIDDEN');
    })).rejects.toMatchObject({ code: 'PUBLICATION_FORBIDDEN' });
    expect(await readFile(file)).toEqual(before);
  });

  it('refuses a conflicting canonical write during audit instead of overwriting it', async () => {
    const token = await vault.create('owner-a', { name: 'publish', token: PAT }, allow);
    const file = join(directory, 'tokens.json');
    const external = Buffer.from('{"version":1,"entries":[]}');
    auditHook = async () => { await writeFile(file, external, { mode: 0o600 }); };
    await expect(vault.update('owner-a', token.id, { token: NEXT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_UNAVAILABLE' });
    expect(await readFile(file)).toEqual(external);
  });

  it('refuses an unlinked and replaced lock during audit before changing stored material', async () => {
    const token = await vault.create('owner-a', { name: 'publish', token: PAT }, allow);
    const file = join(directory, 'tokens.json'); const before = await readFile(file);
    auditHook = async () => {
      await unlink(join(directory, 'vault.lock'));
      await writeFile(join(directory, 'vault.lock'), '', { mode: 0o600 });
    };
    await expect(vault.update('owner-a', token.id, { token: NEXT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_UNAVAILABLE' });
    expect(await readFile(file)).toEqual(before);
  });

  it.each(['symlink', 'hardlink', 'public', 'corrupt', 'oversized'])(
    'refuses %s private material without exposing its bytes', async kind => {
      const token = await vault.create('owner-a', { name: 'publish', token: PAT }, allow);
      const file = join(directory, 'tokens.json');
      if (kind === 'symlink') { await unlink(file); await writeFile(join(root, 'foreign'), PAT); await symlink(join(root, 'foreign'), file); }
      if (kind === 'hardlink') await link(file, join(root, 'alias'));
      if (kind === 'public') await chmod(file, 0o644);
      if (kind === 'corrupt') await writeFile(file, PAT);
      if (kind === 'oversized') await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1));
      await expect(vault.material('owner-a', token.id, allow)).rejects.toMatchObject({ code: 'PUBLICATION_UNAVAILABLE' });
      await expect(vault.metadata('owner-a')).rejects.toMatchObject({ code: 'PUBLICATION_UNAVAILABLE' });
    }
  );

  it('refuses symlinked or writable vault directories, missing locks and nonempty lock contents', async () => {
    const token = await vault.create('owner-a', { name: 'publish', token: PAT }, allow);
    await chmod(directory, 0o770);
    await expect(vault.material('owner-a', token.id, allow)).rejects.toBeInstanceOf(PublicationVaultError);
    await chmod(directory, 0o700);
    await unlink(join(directory, 'vault.lock'));
    await expect(vault.update('owner-a', token.id, { token: NEXT }, allow)).rejects.toBeInstanceOf(PublicationVaultError);
    await expect(lstat(join(directory, 'vault.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(directory, 'vault.lock'), 'foreign', { mode: 0o600 });
    await expect(vault.update('owner-a', token.id, { token: NEXT }, allow)).rejects.toBeInstanceOf(PublicationVaultError);
    await mkdir(join(root, 'actual'), { mode: 0o700 }); await symlink(join(root, 'actual'), join(root, 'symlink-vault'));
    const aliased = new PublicationCredentialVault(join(root, 'symlink-vault'), { audit: () => {} });
    await expect(aliased.metadata('owner-a')).rejects.toBeInstanceOf(PublicationVaultError);
  });

  it('bounds tokens, visible-ASCII input and metadata that would reveal a PAT', async () => {
    for (const value of ['', 'x\ny', 'x y', 'x\0y', 'é', 'x'.repeat(4097)])
      await expect(vault.create('owner-a', { name: 'publish', token: value }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_INVALID' });
    await expect(vault.create('owner-a', { name: 'publish', token: PAT, label: PAT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_INVALID' });
    for (let i = 0; i < 64; i++) await vault.create('owner-a', { name: 'token-' + i, token: PAT }, allow);
    await expect(vault.create('owner-b', { name: 'one-more', token: NEXT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    expect(await vault.metadata('owner-a')).toHaveLength(64);
  });

  it('never projects another stored credential through a different metadata label', async () => {
    const first = await vault.create('owner-a', { name: 'first', token: PAT }, allow);
    await expect(vault.create('owner-a', { name: 'second', token: NEXT, label: PAT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_INVALID' });
    const second = await vault.create('owner-a', { name: 'second', token: NEXT }, allow);
    await expect(vault.update('owner-a', second.id, { label: PAT }, allow)).rejects.toMatchObject({ code: 'PUBLICATION_INVALID' });
    expect((await vault.metadata('owner-a')).map(entry => entry.id)).toEqual([first.id, second.id]);
  });
});
