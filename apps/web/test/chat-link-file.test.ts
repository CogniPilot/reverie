/**
 * Linked files: a chat attachment that references a file on the shared drive instead of uploading a copy. Only a regular
 * file under the shared drive root qualifies (no symlink below the root, no hidden path, nothing laptop-local); it is checked
 * when linked and again on every read, read live with no size limit, never counted against the room and never removed.
 */
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLinkedFile } from '../src/chat-linked-files.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { agentChatSay, formatChatMessage } from '../src/cli-agent.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createHarness, member, message, room, user } from './helpers/chat-app-harness.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function drive() {
  const base = mkdtempSync(join(tmpdir(), 'link-file-'));
  roots.push(base);
  const shared = join(base, 'shared'), laptop = join(base, 'laptop');
  await fs.mkdir(join(shared, 'reports'), { recursive: true });
  await fs.mkdir(join(shared, '.private'), { recursive: true });
  await fs.mkdir(laptop);
  await fs.writeFile(join(shared, 'reports', 'plan.pdf'), '%PDF-1.4 first');
  await fs.writeFile(join(shared, '.private', 'notes.txt'), 'hidden');
  await fs.writeFile(join(laptop, 'local.txt'), 'local');
  await fs.symlink(join(laptop, 'local.txt'), join(shared, 'reports', 'escape.txt'));
  await fs.symlink(join(shared, 'reports', 'plan.pdf'), join(shared, 'reports', 'alias.pdf'));
  return { base, shared, laptop, plan: join(shared, 'reports', 'plan.pdf') };
}

describe('which paths can be linked', () => {
  it('accepts a regular file on the shared drive, as written, with its type and current size', async () => {
    const d = await drive();
    expect(await checkLinkedFile(d.plan, d.shared)).toMatchObject({ path: d.plan, real: d.plan, name: 'plan.pdf', size: 14, type: 'application/pdf' });
  });

  it('refuses laptop-local, relative, hidden, symlinked, folder and missing paths, and works only with a shared drive', async () => {
    const d = await drive();
    const refused = async (path: unknown, status: number, root: string | undefined = d.shared) => {
      await expect(checkLinkedFile(path, root)).rejects.toMatchObject({ status });
    };
    await refused(join(d.laptop, 'local.txt'), 403);
    await refused('reports/plan.pdf', 400);
    await refused(`${d.shared}/reports/../reports/plan.pdf`, 400);
    await refused(join(d.shared, '.private', 'notes.txt'), 403);
    await refused(join(d.shared, 'reports', 'escape.txt'), 403);
    await refused(join(d.shared, 'reports', 'alias.pdf'), 403);
    await refused(join(d.shared, 'reports'), 400);
    await refused(join(d.shared, 'reports', 'gone.pdf'), 404);
    await refused(d.shared, 403);
    vi.stubEnv('REVERIE_SHARED_WORKSPACE_PATH', '');
    await expect(checkLinkedFile(d.plan)).rejects.toMatchObject({ status: 409 });
  });

  it('keeps the path as laptops see it when the shared root is itself a link, and opens the real file', async () => {
    const d = await drive();
    const mount = join(d.base, 'mount');
    await fs.symlink(d.shared, mount);
    expect(await checkLinkedFile(join(mount, 'reports', 'plan.pdf'), mount)).toMatchObject({ path: join(mount, 'reports', 'plan.pdf'), real: d.plan });
  });
});

describe('the room file store', () => {
  it('records a link without a copy, never counts it against the room, and never removes its target', async () => {
    const d = await drive();
    const store = new ChatFileStore(join(d.base, 'instance'), { maxRoom: 100 });
    const link = await store.addLink('room-1', { path: d.plan, name: 'plan.pdf', size: 10_000_000_000, type: 'application/pdf', by: 'user' });
    expect(await store.get('room-1', link.id)).toMatchObject({ path: d.plan, link: d.plan, stored: '' });
    // A 10 GB link leaves the 100-byte room budget untouched.
    const upload = await store.add('room-1', { name: 'small.txt', type: 'text/plain', data: Buffer.from('fits'), by: 'user' });
    expect(await fs.readdir(join(d.base, 'instance', 'chatroom-files', 'room-1'))).toEqual(expect.arrayContaining([upload.stored, 'index.json']));
    expect(await store.pruneUnreferenced('room-1', new Set(), Date.now() + 1e9)).toBe(2);
    expect(await store.list('room-1')).toEqual([]);
    expect(await fs.readFile(d.plan, 'utf8')).toBe('%PDF-1.4 first');
  });
});

describe('linking through the room', () => {
  async function server() {
    const d = await drive();
    vi.stubEnv('REVERIE_SHARED_WORKSPACE_PATH', d.shared);
    let service!: ChatroomService;
    const harness = await createRouteTestHarness((app, ctx) => {
      service = new ChatroomService({ file: join(d.base, 'chatrooms.json'), database: join(d.base, 'chat.db'), getSession: (id) => ctx.sessions.get(id), broadcast: () => {} });
      registerChatroomRoutes(app, ctx, service, new ChatFileStore(join(d.base, 'files')), trustedFixtureOwner);
    });
    await service.init();
    const room = service.createRoom('Office', undefined);
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => harness.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    return { d, service, room, call, close: async () => { await service.stop(); await harness.app.close(); } };
  }

  it('links a shared-drive file, posts it, serves it live and refuses it once it is no longer the file itself', async () => {
    const s = await server();
    try {
      const linked = await s.call('POST', `/api/chatrooms/${s.room.id}/links`, { path: s.d.plan });
      expect(linked.statusCode).toBe(200);
      const file = linked.json().data.file;
      expect(file).toMatchObject({ name: 'plan.pdf', type: 'application/pdf', linked: true });
      const posted = await s.call('POST', `/api/chatrooms/${s.room.id}/messages`, { text: 'the plan', attachments: [file.id] });
      expect(posted.statusCode).toBe(200);
      expect(s.service.room(s.room.id)!.messages.at(-1)!.attachments).toEqual([{ id: file.id, name: 'plan.pdf', size: 14, type: 'application/pdf', path: s.d.plan, linked: true }]);
      const url = `/api/chatrooms/${s.room.id}/files/${file.id}`;
      let read = await s.call('GET', url);
      expect([read.statusCode, read.body, read.headers['cache-control']]).toEqual([200, '%PDF-1.4 first', 'no-store']);
      // Live: an edit on the shared drive is what the room reads next, larger than when it was linked.
      await fs.writeFile(s.d.plan, '%PDF-1.4 second, longer');
      read = await s.call('GET', url);
      expect(read.body).toBe('%PDF-1.4 second, longer');
      // Replaced by a symlink to a laptop file: refused, never followed.
      await fs.rm(s.d.plan);
      await fs.symlink(join(s.d.laptop, 'local.txt'), s.d.plan);
      read = await s.call('GET', url);
      expect(read.statusCode).toBe(403);
      expect(read.body).not.toContain('local');
      await fs.rm(s.d.plan);
      expect((await s.call('GET', url)).statusCode).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('refuses paths off the shared drive and records nothing for them', async () => {
    const s = await server();
    try {
      for (const [path, status] of [[join(s.d.laptop, 'local.txt'), 403], [join(s.d.shared, 'reports', 'escape.txt'), 403], ['plan.pdf', 400], [join(s.d.shared, 'nope.pdf'), 404]] as const) {
        const res = await s.call('POST', `/api/chatrooms/${s.room.id}/links`, { path });
        expect(res.statusCode, path).toBe(status);
      }
      expect((await s.call('POST', `/api/chatrooms/${s.room.id}/links`, { path: s.d.plan, extra: 1 })).statusCode).toBe(400);
      expect(await new ChatFileStore(join(s.d.base, 'files')).list(s.room.id)).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe('agents', () => {
  it('chat say --link-file links each path (made absolute) and attaches it to the message', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const room = { id: '11111111-1111-4111-8111-111111111111', name: 'Office' };
    const deps = {
      ctx: { selfId: 'self' },
      json: false,
      io: { out: () => {}, err: () => {} },
      request: async (_ctx: unknown, options: { method: string; path: string; body?: unknown }) => {
        calls.push(options);
        if (options.path.endsWith('/links')) return { status: 200, json: { success: true, data: { file: { id: 'link-' + calls.length } } } };
        if (options.path.endsWith('/messages') && options.method === 'POST') return { status: 200, json: { success: true, data: { message: { id: 'm' } } } };
        return { status: 200, json: { success: true, data: { rooms: [room] } } };
      },
    };
    await agentChatSay(deps as never, { room: room.id, text: 'see these', links: ['/shared/a.pdf', 'b.txt'] });
    const links = calls.filter((c) => c.path.endsWith('/links'));
    expect(links.map((c) => c.body)).toEqual([{ path: '/shared/a.pdf' }, { path: join(process.cwd(), 'b.txt') }]);
    const post = calls.find((c) => c.path.endsWith('/messages') && c.method === 'POST')!;
    expect((post.body as { attachments: string[] }).attachments).toEqual(['link-' + (calls.indexOf(links[0]) + 1), 'link-' + (calls.indexOf(links[1]) + 1)]);
  });

  it('show a linked file by its shared-drive path, the way to read it', () => {
    const roomId = '11111111-1111-4111-8111-111111111111';
    const text = formatChatMessage({ id: 'm', at: 1, from: { kind: 'user', name: 'Owner' }, to: 'all', text: 'the plan',
      attachments: [{ id: '22222222-2222-4222-8222-222222222222', name: 'plan.pdf', type: 'application/pdf', size: 1, path: '/shared/reports/plan.pdf', linked: true }] }, [], roomId);
    expect(text).toContain('[linked file: "/shared/reports/plan.pdf"]');
  });
});

describe('Link a File in the chat app', () => {
  const A = '0000002d-0035-4000-8000-0000000000d1';
  const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));
  it('links a shared-drive path from the + menu, shows it as linked in the tray, and refusals stay in the dialog', async () => {
    const linkedMessage = message('m1', 'r1', user, 'the plan', 1000, {
      attachments: [{ id: 'f1', name: 'plan.pdf', type: 'application/pdf', size: 14, path: '/shared/reports/plan.pdf', linked: true }],
    });
    const h = await createHarness({ sessions: [{ id: A, name: 'alpha', mode: 'claude' }], rooms: [room('r1', 'General', [member(A, 'alpha')], { messages: [linkedMessage] })] });
    try {
      // A linked file in the feed is labelled as one, without a size (it is read live).
      const card = h.document.querySelector('.chatroom-file') as HTMLElement;
      expect(card.textContent).toContain('plan.pdf');
      expect(card.textContent).toContain('Linked file');
      expect(card.title).toContain('/shared/reports/plan.pdf');
      const sent: { url: string; body: unknown }[] = [];
      let refuse = '';
      h.window.fetch = async (url: string, options: { method?: string; body?: string }) => {
        sent.push({ url: String(url), body: JSON.parse(options.body || 'null') });
        if (refuse) return { ok: false, status: 403, json: async () => ({ success: false, error: { message: refuse } }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { file: { id: 'link-1', name: 'notes.md', size: 12, type: 'text/markdown', linked: true } } }) };
      };
      const open = () => {
        (h.document.querySelector('.chatroom-composer-row .ca-plus, .ca-plus') as HTMLButtonElement).click();
        ([...h.document.querySelectorAll('.ca-plus-menu button')].find((b) => b.textContent!.includes('Link a File')) as HTMLButtonElement).click();
        return h.document.querySelector('.ca-link-dialog') as HTMLDialogElement;
      };
      let dialog = open();
      const input = dialog.querySelector('input') as HTMLInputElement;
      input.value = '/shared/laptop-only.txt';
      refuse = 'Only files on the shared drive (/shared) can be linked. Attach a copy of a laptop-local file instead.';
      dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
      await settle();
      expect(dialog.isConnected).toBe(true);
      expect(dialog.querySelector('.ca-form-error')!.textContent).toContain('Only files on the shared drive');
      expect(h.document.querySelector('.chatroom-tray-item')).toBeNull();
      dialog.close();
      dialog = open();
      (dialog.querySelector('input') as HTMLInputElement).value = '/shared/notes.md';
      refuse = '';
      dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
      await settle();
      expect(sent.at(-1)).toEqual({ url: expect.stringContaining('/api/chatrooms/r1/links'), body: { path: '/shared/notes.md' } });
      expect(dialog.isConnected).toBe(false);
      const chip = h.document.querySelector('.chatroom-tray-item') as HTMLElement;
      expect(chip.textContent).toContain('notes.md');
      expect(chip.textContent).toContain('linked');
      expect(h.app._takeChatAttachments()).toEqual(['link-1']);
    } finally {
      h.dom.window.close();
    }
  });
});
