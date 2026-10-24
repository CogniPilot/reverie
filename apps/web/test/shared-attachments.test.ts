import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatFileStore } from '../src/chatroom-files.js';
import { sharedAttachmentPath } from '../src/shared-attachments.js';
import { formatChatMessage } from '../src/cli-agent.js';

const owned: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const path of owned.splice(0)) await fs.rm(path, { recursive: true, force: true }); });
describe('shared upload paths across laptops', () => {
  it('imports existing uploads, preserves rollback originals, and stores new uploads on the same drive', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'reverie-shared-upload-')); owned.push(root);
    const privateRoot = join(root, 'instance'), shared = join(root, 'workspace', 'attachments');
    const store = new ChatFileStore(privateRoot);
    const file = await store.add('room-1', { name: 'old.png', type: 'image/png', data: Buffer.from('old-image'), by: 'user' });
    const old = await store.get('room-1', file.id);
    vi.stubEnv('REVERIE_SHARED_ATTACHMENTS_PATH', shared);
    await store.initializeShared();
    const current = await store.get('room-1', file.id);
    expect(current.path).toBe(join(shared, 'room-1', file.stored));
    expect(await fs.readFile(current.path, 'utf8')).toBe('old-image');
    expect(await fs.readFile(old.path, 'utf8')).toBe('old-image');
    expect(sharedAttachmentPath('room-1', old)).toBe(current.path);
    const added = await store.add('room-1', { name: 'new.txt', type: 'text/plain', data: Buffer.from('new-content'), by: 'agent' });
    await store.initializeShared(); // restart must not replace the new index with the frozen legacy index
    expect((await store.list('room-1')).map(file => file.id)).toEqual([file.id, added.id]);
    expect(await fs.readFile((await store.get('room-1', added.id)).path, 'utf8')).toBe('new-content');
  });
  it('makes plain CLI history show the path instead of hiding attachments from the agent', () => {
    const text = formatChatMessage({ id: 'message', at: 1, from: { kind: 'user', name: 'Owner' }, to: 'all', text: '',
      attachments: [{ id: 'image', name: 'test.png', type: 'image/png', size: 10, path: '/reverie_workspace/attachments/room/image-test.png' }] }, []);
    expect(text).toContain('(attachment only)');
    expect(text).toContain('/reverie_workspace/attachments/room/image-test.png');
  });
  it('refuses a symlinked shared root instead of importing instance files into it', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'reverie-shared-upload-')); owned.push(root);
    const target = join(root, 'target'); await fs.mkdir(target);
    const shared = join(root, 'linked'); await fs.symlink(target, shared);
    vi.stubEnv('REVERIE_SHARED_ATTACHMENTS_PATH', shared);
    await expect(new ChatFileStore(join(root, 'instance')).initializeShared()).rejects.toThrow('symlink');
  });
});
