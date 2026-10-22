import { describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const sessions = [{ id: A, name: 'Expert', mode: 'claude' }];
const rooms = () => [
  room('one', 'General', [member(A, 'Expert')], {
    workspace: 'Project',
    category: 'Build',
    messages: [message('history', 'one', agent(A, 'Expert'), 'Keep this history', 500)],
  }),
  room('archived', 'Archive', [member(A, 'Expert')], { workspace: 'Project', archivedAt: 5 }),
  room('default', 'Default', [member(A, 'Expert')]),
];
async function fixture() {
  const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'one' } });
  h.shell.company = { canManage: true };
  h.shell.phoneStatus = { self: 'owner', canSetOwn: true };
  h.window.confirm = () => true;
  return h;
}
describe('delete workspace grouping without deleting channels', () => {
  it('offers deletion only to a verified owner for a named group, and preserves history, archived channels and active selection', async () => {
    const h = await fixture();
    let question = '';
    h.window.confirm = (text: string) => {
      question = text;
      return true;
    };
    h.shell.selectWorkspace('Project');
    expect(h.shell.workspaceEntries('Project').some((e) => e.label === 'Delete workspace')).toBe(true);
    expect(h.shell.workspaceEntries('').some((e) => e.label === 'Delete workspace')).toBe(false);
    const history = structuredClone(h.server.rooms[0].messages);
    expect(await h.shell.deleteWorkspace('Project')).toBe(true);
    expect(question).toContain('2 channels');
    expect(question).toContain(h.shell.defaultWorkspaceName());
    expect(question).toContain('All messages, members and channel categories will be kept');
    expect(h.server.rooms.map((r) => r.id)).toEqual(['one', 'archived', 'default']);
    expect(h.server.rooms[0].messages).toEqual(history);
    expect(h.server.rooms[0].category).toBe('Build');
    expect(h.server.rooms[1].archivedAt).toBe(5);
    expect(h.server.rooms.every((r) => !r.workspace)).toBe(true);
    expect(h.shell.workspace).toBe('');
    expect(h.shell.roomId).toBe('one');
    expect(h.server.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/api/chatrooms/'))).toBe(false);
    expect(h.document.querySelector('[data-key="ws:Project"]')).toBeNull();
  });
  it('removes an empty grouping appearance and notification choice without any channel mutations', async () => {
    const h = await fixture();
    h.window.localStorage.setItem(
      'reverie:chat:wsmeta',
      JSON.stringify({ Empty: { icon: 'E' }, Other: { icon: 'O' } })
    );
    h.window.localStorage.setItem(
      'reverie:chat:notify',
      JSON.stringify({ 'ws:Empty': { level: 'none', until: 0 }, 'ws:Other': { level: 'all', until: 0 } })
    );
    expect(await h.shell.deleteWorkspace('Empty')).toBe(true);
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta')!)).toEqual({ Other: { icon: 'O' } });
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:notify')!)).toEqual({
      'ws:Other': { level: 'all', until: 0 },
    });
    expect(h.server.calls.filter((c) => c.path.endsWith('/placement'))).toEqual([]);
  });
  it('never mutates channels on cancel or when a caller is an agent', async () => {
    const h = await fixture();
    h.window.confirm = () => false;
    expect(await h.shell.deleteWorkspace('Project')).toBe(false);
    h.window.confirm = () => true;
    h.shell.phoneStatus = { self: A, canSetOwn: true };
    expect(h.shell.workspaceEntries('Project').some((e) => e.label === 'Delete workspace')).toBe(false);
    expect(await h.shell.deleteWorkspace('Project')).toBe(false);
    expect(h.server.calls.filter((c) => c.path.endsWith('/placement'))).toEqual([]);
  });
  it('keeps the remaining group and its appearance after a partial move failure', async () => {
    const h = await fixture();
    h.window.localStorage.setItem('reverie:chat:wsmeta', JSON.stringify({ Project: { icon: 'P' } }));
    const api = h.app._chatApi.bind(h.app);
    h.app._chatApi = async (path, options) =>
      path === '/api/chatrooms/archived/placement' ? { ok: false, error: 'Move refused' } : api(path, options);
    expect(await h.shell.deleteWorkspace('Project')).toBe(false);
    expect(h.server.rooms[0].workspace).toBe('');
    expect(h.server.rooms[1].workspace).toBe('Project');
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta')!).Project).toEqual({ icon: 'P' });
    expect(h.server.rooms[0].messages[0].text).toBe('Keep this history');
  });
});
