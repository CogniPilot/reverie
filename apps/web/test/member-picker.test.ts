import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const B = '00000035-0040-4000-8000-00000000005c';
const C = '0000003b-0049-4000-8000-00000000006a';
type Harness = Awaited<ReturnType<typeof createHarness>>;
const opened: Harness[] = [];
const setup = async (extra: object[] = []) => {
  const h = await createHarness({
    sessions: [{ id: A, name: 'Maple', mode: 'claude' }, { id: B, name: 'River', mode: 'claude' }, ...extra],
    rooms: [room('r1', 'General', [member(A, 'Maple')])],
  });
  opened.push(h);
  return h;
};
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
const button = (h: Harness) => h.document.querySelector('.ca-add-button') as HTMLButtonElement;
const open = (h: Harness) => { button(h).click(); return h.document.querySelector('.ca-member-picker') as HTMLElement; };
const key = (h: Harness, key: string) => h.document.activeElement!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
/** Waits until `ready()` holds, bounded: a fixed sleep is outlasted by the page on a loaded runner. */
const until = async (ready: () => unknown, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the page did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
/** An add has finished: the reloaded list shows the member and focus is on the new plus button. */
const added = (h: Harness, id: string) => () => h.document.querySelector(`[data-key="member:${id}"]`) && h.document.activeElement === button(h);

describe('the member-list add button', () => {
  it('replaces the native select with a labelled plus button', async () => {
    const h = await setup();
    expect(h.document.querySelector('.ca-members select')).toBeNull();
    expect(button(h).getAttribute('aria-label')).toBe('Add an agent');
    expect(button(h).title).toBe('Add an agent');
    expect(button(h).querySelector('svg')).not.toBeNull();
  });

  it('lists candidates with their icon and kind, excluding members, post-only sessions and bare shells', async () => {
    const h = await setup([
      { id: C, name: 'Reporter', mode: 'claude', postOnly: true },
      { id: 'plain-terminal', name: 'Terminal', mode: 'shell' },
    ]);
    const picker = open(h);
    expect(picker.querySelectorAll('button')).toHaveLength(1);
    expect(picker.querySelector('.ca-menu-label')!.textContent).toBe('River');
    expect(picker.querySelector('.ca-menu-hint')!.textContent).toBe('claude');
    expect(picker.querySelector('.chatroom-avatar')).not.toBeNull();
    expect(picker.querySelector('input')).toBeNull();
  });

  it('sends the existing add POST once, refreshes the list and focuses the new plus button', async () => {
    const h = await setup();
    // The room reload after the add answers slowly, as on a loaded runner. Focus moves to the new plus button only
    // once it lands; before that, the re-render has removed the old button and focus is on the body.
    const handle = h.server.handle;
    let posted = false;
    h.server.handle = async (path: string, opts: { method?: string } = {}) => {
      if (posted && (opts.method || 'GET') === 'GET') await new Promise((resolve) => setTimeout(resolve, 300));
      const res = await handle(path, opts);
      if (opts.method === 'POST' && path.endsWith('/members')) posted = true;
      return res;
    };
    open(h).querySelector('button')!.click();
    await until(added(h, B));
    const calls = h.server.calls.filter((c: { method: string; path: string }) => c.method === 'POST' && c.path === '/api/chatrooms/r1/members');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ sessionId: B });
    expect(h.document.querySelector(`[data-key="member:${B}"]`)).not.toBeNull();
    expect(h.document.querySelector('.ca-member-picker')).toBeNull();
    expect(h.document.activeElement).toBe(button(h));
  });

  it('keeps the plus button and explains when no other sessions can be added', async () => {
    const h = await setup();
    h.app.sessions.delete(B);
    const picker = open(h);
    expect(picker.textContent).toBe('No other agents to add');
    expect(picker.querySelector('button')).toBeNull();
    key(h, 'Escape');
    expect(h.document.querySelector('.ca-member-picker')).toBeNull();
    expect(h.document.activeElement).toBe(button(h));
  });

  it('supports arrows and Enter, and Escape or outside click restore the plus button', async () => {
    const h = await setup([{ id: C, name: 'Birch', mode: 'claude' }]);
    open(h);
    key(h, 'ArrowDown');
    expect(h.document.activeElement!.textContent).toContain('Birch');
    key(h, 'Escape');
    expect(h.document.activeElement).toBe(button(h));
    open(h);
    h.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
    expect(h.document.querySelector('.ca-member-picker')).toBeNull();
    expect(h.document.activeElement).toBe(button(h));
    open(h);
    key(h, 'Enter');
    await until(added(h, B));
    expect(h.server.invited).toEqual([{ id: 'r1', sessionId: B }]);
  });

  it('shows search only for a long list and skips filtered rows during keyboard selection', async () => {
    const h = await setup(Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `Candidate ${i}`, mode: 'claude' })));
    const picker = open(h);
    const search = picker.querySelector('input')!;
    expect(h.document.activeElement).toBe(search);
    search.value = 'candidate 7';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect([...picker.querySelectorAll('button')].filter((b) => !b.hidden)).toHaveLength(1);
    key(h, 'ArrowUp');
    expect(h.document.activeElement!.textContent).toContain('Candidate 7');
    key(h, 'Enter');
    await until(added(h, 's7'));
    expect(h.server.invited).toEqual([{ id: 'r1', sessionId: 's7' }]);
  });

  it('has an empty search state without changing the candidate list', async () => {
    const h = await setup(Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `Candidate ${i}`, mode: 'claude' })));
    const picker = open(h);
    const search = picker.querySelector('input')!;
    search.value = 'unmatched';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect((picker.querySelector('.ca-member-empty') as HTMLElement).hidden).toBe(false);
    expect(picker.textContent).toContain('No agents match');
    key(h, 'Enter');
    expect(h.server.invited).toBeUndefined();
    search.value = '';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect((picker.querySelector('.ca-member-empty') as HTMLElement).hidden).toBe(true);
    expect([...picker.querySelectorAll('button')].filter((b) => !b.hidden)).toHaveLength(10);
  });

  it('hides add from a viewer, keeps it for a channel lead, and defers role assignments to the badge card', async () => {
    const h = await setup();
    h.app._chatSelf = B;
    h.shell.renderMembers();
    expect(button(h)).toBeNull();
    h.app._chatSelf = A;
    h.shell.room.members[0].role = 'coordinator';
    h.shell.renderMembers();
    expect(button(h)).not.toBeNull();
  });

  it('reports a refused add without inserting a member', async () => {
    const h = await setup();
    vi.spyOn(h.app, '_chatApi').mockResolvedValue({ ok: false, error: 'Permission denied' });
    open(h).querySelector('button')!.click();
    await h.flush();
    expect(h.app.toasts.at(-1).text).toBe('Chat: Permission denied');
    expect(h.document.querySelector(`[data-key="member:${B}"]`)).toBeNull();
    expect(h.document.activeElement).toBe(button(h));
  });
});

describe('polling delivery in the normal member picker',()=>{
 it('includes a positively declared polling agent already post-only elsewhere; posts only sessionId',async()=>{
  const h=await createHarness({sessions:[{id:A,name:'Maple',mode:'claude'},{id:B,name:'Poller',mode:'poll-agent',postOnly:true}],rooms:[room('r1','Office',[member(A,'Maple')]),room('r2','Break',[member(B,'Poller',{postOnly:true})])],features:{pollingModes:['poll-agent']}});
  opened.push(h);
  const picker=open(h);expect(picker.textContent).toContain('Poller');picker.querySelector('button')!.click();await until(added(h,B));
  const calls=h.server.calls.filter((c:any)=>c.method==='POST'&&c.path==='/api/chatrooms/r1/members');expect(calls).toHaveLength(1);expect(calls[0].body).toEqual({sessionId:B});
 });
 it('does not infer polling support from acceptsChat=false or a post-only flag',async()=>{
  const h=await setup([{id:C,name:'NotAPoller',mode:'plain-agent',postOnly:true}]);expect(open(h).textContent).not.toContain('NotAPoller');
 });
});
