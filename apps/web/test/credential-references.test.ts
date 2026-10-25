/** Metadata-only synthetic files: no installer or real credential bindings. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubCredentialReferences } from '../src/cli-agent-capabilities.js';
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
async function fixture() {
  const home = await fs.mkdtemp(join(tmpdir(), 'reference-metadata-'));
  temporary.push(home);
  const dir = join(home, '.config/reverie/credentials/github');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const token = join(dir, 'example.token'),
    metadata = join(dir, 'example.json');
  await fs.writeFile(token, 'synthetic-unread-marker', { mode: 0o600 });
  await fs.writeFile(metadata, JSON.stringify({ repositories: ['ExampleOrg/project'] }), { mode: 0o600 });
  return { home, dir, token, metadata };
}
describe('stable bounded credential reference metadata', () => {
  it('reads a bounded private metadata descriptor but never opens a token', async () => {
    const f = await fixture(),
      open = fs.open.bind(fs),
      paths: string[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      paths.push(String(args[0]));
      return open(...args);
    });
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([
      { name: 'example', path: f.token, declaredRepositories: ['ExampleOrg/project'] },
    ]);
    expect(paths.some((path) => path.endsWith('.token'))).toBe(false);
  });
  it('refuses hardlink token/metadata alias without reading either file', async () => {
    const f = await fixture();
    await fs.unlink(f.metadata);
    await fs.link(f.token, f.metadata);
    const open = fs.open.bind(fs),
      paths: string[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      paths.push(String(args[0]));
      return open(...args);
    });
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([]);
    expect(paths.some((path) => /\.(json|token)$/.test(path))).toBe(false);
  });
  it.each(['oversize', 'mode', 'symlink'])('refuses %s metadata', async (kind) => {
    const f = await fixture();
    if (kind === 'oversize') await fs.writeFile(f.metadata, 'x'.repeat(16385));
    if (kind === 'mode') await fs.chmod(f.metadata, 0o644);
    if (kind === 'symlink') {
      await fs.unlink(f.metadata);
      await fs.symlink(f.token, f.metadata);
    }
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([]);
  });
  it('rejects a token renamed over metadata after its token inode was observed, before read', async () => {
    const f = await fixture(),
      other = join(f.dir, 'other.token');
    await fs.writeFile(other, 'synthetic-other-unread', { mode: 0o600 });
    const open = fs.open.bind(fs);
    let reads = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('/example.json')) await fs.rename(other, f.metadata);
      const handle = await open(...args);
      if (String(args[0]).endsWith('/example.json'))
        vi.spyOn(handle, 'read').mockImplementation(async () => {
          reads++;
          throw Error('token read forbidden');
        });
      return handle;
    });
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([]);
    expect(reads).toBe(0);
  });
  it('refuses a metadata replacement during the bounded descriptor read', async () => {
    const f = await fixture(),
      open = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('/example.json')) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
          if (!replaced) {
            replaced = true;
            await fs.rename(f.metadata, f.metadata + '.old');
            await fs.writeFile(f.metadata, '{}', { mode: 0o600 });
          }
          return (read as any)(...readArgs);
        });
      }
      return handle;
    });
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([]);
    expect(replaced).toBe(true);
  });
  it('refuses an ancestor replacement even though the retained directory descriptor still opens', async () => {
    const f = await fixture(),
      open = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('/example.json') && !changed) {
        changed = true;
        await fs.rename(f.dir, f.dir + '.old');
        await fs.mkdir(f.dir, { mode: 0o700 });
      }
      return handle;
    });
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([]);
    expect(changed).toBe(true);
  });
  it('bounds directory enumeration before opening metadata', async () => {
    const f = await fixture();
    for (let i = 0; i < 129; i++) await fs.writeFile(join(f.dir, `marker-${i}`), '');
    const open = fs.open.bind(fs),
      paths: string[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      paths.push(String(args[0]));
      return open(...args);
    });
    expect((await githubCredentialReferences(f.home)).bindings).toEqual([]);
    expect(paths.some((path) => path.endsWith('.json') || path.endsWith('.token'))).toBe(false);
  });

  it('refuses symlinked home ancestry rather than resolving it into another home', async () => {
    const f = await fixture(),
      alias = join(f.home, 'alias');
    await fs.symlink(f.home, alias);
    expect((await githubCredentialReferences(alias)).bindings).toEqual([]);
  });
});
