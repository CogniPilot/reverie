import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room, message, agent } from './helpers/chat-app-harness.mjs';

const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); });
async function fixture() {
  const h = await createHarness({ rooms: [room('general', 'General', [member('one', 'Alpha')]), room('other', 'Other room', [member('one', 'Alpha')])], sessions: [{ id: 'one', name: 'Alpha' }], stored: { 'reverie:chatroom': 'general' } });
  handles.push(h); return h;
}
function render(h: Awaited<ReturnType<typeof createHarness>>, text: string) {
  const node = h.shell.messageEl(message('message', 'general', agent('one', 'Alpha'), text, 100), true);
  h.document.body.append(node); return node;
}
function reference(node: Element, text: string) { return [...node.querySelectorAll<HTMLButtonElement>('.ca-chat-reference')].find(button => button.textContent === text)!; }

it('opens the existing profile and right-click/keyboard member menu from an agent mention', async () => {
  const h = await fixture(), node = render(h, 'Ask @Alpha.'), profile = vi.spyOn(h.shell, 'openProfile').mockImplementation(() => {}), menu = vi.spyOn(h.shell, 'openMemberMenu').mockImplementation(() => {});
  const button = reference(node, '@Alpha'); expect(button.tagName).toBe('BUTTON'); button.click();
  expect(profile).toHaveBeenCalledWith(h.shell.room.members[0], button);
  button.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }));
  button.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  expect(menu).toHaveBeenCalledTimes(2); expect(h.server.posts).toEqual([]);
});

it('refuses an old mention after membership removal or same-name replacement', async () => {
  const h = await fixture(), node = render(h, '@Alpha'), profile = vi.spyOn(h.shell, 'openProfile').mockImplementation(() => {});
  h.shell.room.members.splice(0, 1, member('replacement', 'Alpha')); reference(node, '@Alpha').click();
  expect(profile).not.toHaveBeenCalled();
});

it('leaves duplicate names and everyone as non-actionable highlights', async () => {
  const h = await fixture(); h.shell.room.members.push(member('two', 'alpha'));
  const node = render(h, '@Alpha @everyone'); expect(node.querySelectorAll('.ca-mention-tag')).toHaveLength(2); expect(node.querySelectorAll('button.ca-chat-reference')).toHaveLength(0);
});

it('reuses the current human member action without posting or creating a seat', async () => {
  const h = await fixture(); h.shell.humans = [{ id: 'human', name: 'Visitor', role: 'limited' }]; h.shell.humanRoomId = h.shell.roomId;
  const node = render(h, '@Visitor'); const mention = vi.spyOn(h.shell, 'mentionHuman').mockImplementation(() => {}); reference(node, '@Visitor').click();
  expect(mention).toHaveBeenCalledWith('human'); expect(h.server.posts).toEqual([]);
});

it('opens a known channel with spaces through normal navigation, leaving unknown channels alone', async () => {
  const h = await fixture(), node = render(h, 'See #Other room. #Unknown'), select = vi.spyOn(h.shell, 'selectRoom').mockResolvedValue(undefined);
  reference(node, '#Other room').click(); expect(select).toHaveBeenCalledWith('other'); expect(reference(node, '#Unknown')).toBeUndefined();
});

it('does not guess duplicate channel names or navigate a removed channel', async () => {
  const h = await fixture(), node = render(h, '#Other room'), select = vi.spyOn(h.shell, 'selectRoom').mockResolvedValue(undefined);
  h.app._chatRooms = h.app._chatRooms.filter((r: any) => r.id !== 'other'); reference(node, '#Other room').click(); expect(select).not.toHaveBeenCalled();
  h.app._chatRooms.push(room('a', 'Twin', []), room('b', 'Twin', [])); expect(reference(render(h, '#Twin'), '#Twin')).toBeUndefined();
});

it('ignores code, existing anchors, emails, URL fragments and ID prefixes', async () => {
  const h = await fixture(), root = h.document.createElement('div');
  root.innerHTML = '<code>@Alpha #Other room i-12345678</code><pre>@Alpha</pre><a href="/">@Alpha #Other room i-12345678</a>';
  root.append(' x@Alpha https://example.test/#Other room xi-12345678 i-123456789 report.i-12345678.md urn:i-12345678');
  h.shell.decorateMentions(root); h.shell.decorateChatReferences(root);
  expect(root.querySelectorAll('.ca-chat-reference')).toHaveLength(0);
});

it('shows the current assignment description as text through the authorized read API only', async () => {
  const h = await fixture(), node = render(h, 'Assignment i-12345678.'), original = h.app._chatApi.bind(h.app);
  const api = vi.spyOn(h.app, '_chatApi').mockImplementation(async (path: string, options?: object) => path === '/api/board' ? { ok: true, data: { issues: [{ id: 'i-12345678', title: '<img src=x onerror=alert(1)>', status: 'blocked', reason: 'Detailed\nassignment', owner: 'owner' }], roster: [{ id: 'owner', name: 'Owner' }] } } : original(path, options));
  reference(node, 'i-12345678').click(); await h.flush();
  const dialog = h.document.querySelector('.ca-assignment-dialog')!;
  expect(dialog.textContent).toContain('Detailed\nassignment'); expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>'); expect(dialog.querySelector('img')).toBeNull();
  expect(api.mock.calls.filter(([path]) => path === '/api/board')).toHaveLength(1); expect(h.server.posts).toEqual([]);
});

it.each([false, true])('explains unauthorized or missing assignments without stale details (authorized=%s)', async authorized => {
  const h = await fixture(), node = render(h, 'i-12345678'); const original = h.app._chatApi.bind(h.app);
  vi.spyOn(h.app, '_chatApi').mockImplementation(async (path: string, opts?: object) => path === '/api/board' ? { ok: authorized, data: { issues: [] } } : original(path, opts));
  reference(node, 'i-12345678').click(); await h.flush(); expect(h.document.querySelector('.ca-assignment-dialog')?.textContent).toContain('unavailable');
});

it('aborts on close, suppresses a late assignment response, and restores anchor focus', async () => {
  const h = await fixture(), node = render(h, 'i-12345678'); let complete!: (value: any) => void; let signal: AbortSignal | undefined; const original = h.app._chatApi.bind(h.app);
  vi.spyOn(h.app, '_chatApi').mockImplementation((path: string, opts: any) => path === '/api/board' ? (signal = opts.signal, new Promise(resolve => { complete = resolve; })) : original(path, opts));
  const anchor = reference(node, 'i-12345678'); anchor.click(); const dialog = h.document.querySelector<HTMLDialogElement>('.ca-assignment-dialog')!; dialog.close();
  complete({ ok: true, data: { issues: [{ id: 'i-12345678', title: 'LATE PRIVATE DETAILS', reason: 'late' }] } }); await h.flush();
  expect(signal?.aborted).toBe(true); expect(h.document.querySelector('.ca-assignment-dialog')).toBeNull(); expect(h.document.body.textContent).not.toContain('LATE PRIVATE DETAILS'); expect(h.document.activeElement).toBe(anchor);
});

it('rejects a late response after the authenticated identity changes', async () => {
  const h = await fixture(), node = render(h, 'i-12345678'); let complete!: (value: any) => void; const original = h.app._chatApi.bind(h.app);
  vi.spyOn(h.app, '_chatApi').mockImplementation((path: string, opts?: object) => path === '/api/board' ? new Promise(resolve => { complete = resolve; }) : original(path, opts));
  reference(node, 'i-12345678').click(); h.app._chatSelf = 'replacement';
  complete({ ok: true, data: { issues: [{ id: 'i-12345678', title: 'OLD IDENTITY DATA' }] } }); await h.flush();
  expect(h.document.querySelector('.ca-assignment-dialog')).toBeNull(); expect(h.document.body.textContent).not.toContain('OLD IDENTITY DATA');
});

it('does not turn a Unicode name prefix or scripted/button text into a mention action', async () => {
  const h = await fixture(), root = h.document.createElement('div'); root.innerHTML = '<button>@Alpha</button><script>@Alpha</script><style>@Alpha</style>';
  root.append(' @Alphaé café@Alpha'); h.shell.decorateMentions(root); expect(root.querySelectorAll('.ca-chat-reference')).toHaveLength(0);
});

it('does not open an old detached assignment after channel navigation', async () => {
  const h = await fixture(), node = render(h, 'i-12345678'), open = vi.spyOn(h.shell, 'openAssignment').mockResolvedValue(undefined);
  node.remove(); reference(node, 'i-12345678').click(); expect(open).not.toHaveBeenCalled();
});

it('replaces a pending assignment without letting its old response overwrite the new one', async () => {
  const h = await fixture(), node = render(h, 'i-12345678 i-87654321'), pending: ((value: any) => void)[] = [], original = h.app._chatApi.bind(h.app);
  vi.spyOn(h.app, '_chatApi').mockImplementation((path: string, opts?: object) => path === '/api/board' ? new Promise(resolve => { pending.push(resolve); }) : original(path, opts));
  reference(node, 'i-12345678').click(); reference(node, 'i-87654321').click();
  pending[1]({ ok: true, data: { issues: [{ id: 'i-87654321', title: 'CURRENT', reason: 'Current description' }] } }); await h.flush();
  pending[0]({ ok: true, data: { issues: [{ id: 'i-12345678', title: 'STALE', reason: 'Old description' }] } }); await h.flush();
  expect(h.document.querySelectorAll('.ca-assignment-dialog')).toHaveLength(1); expect(h.document.querySelector('.ca-assignment-dialog')?.textContent).toContain('Current description'); expect(h.document.querySelector('.ca-assignment-dialog')?.textContent).not.toContain('STALE');
});
