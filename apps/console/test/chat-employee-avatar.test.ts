import { afterEach, describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const OLD = '0000002d-0035-4000-8000-000000000047';
const CURRENT = '00000038-0043-4000-8000-000000000060';
const TEMPORARY = '0000003e-004c-4000-8000-00000000006f';
const EMPLOYEE = 'employee-one';
const IMAGE = `data:image/png;base64,${'A'.repeat(64)}`;
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.window.close();
});

async function fixture(extra: Record<string, unknown> = {}) {
  const employee = { id: EMPLOYEE, sessionId: CURRENT, name: 'Stable name', icon: '📜', ...extra };
  const history = [
    message('old', 'room', { ...agent(OLD, 'Old signature'), employeeId: EMPLOYEE }, 'Before move', 1000),
    message('new', 'room', { ...agent(CURRENT, 'New signature'), employeeId: EMPLOYEE }, 'After move', 500000),
    message('temporary', 'room', agent(TEMPORARY, 'Temporary'), 'Session fallback', 1000000),
  ];
  const handle = await createHarness({
    rooms: [room('room', 'History', [member(CURRENT, 'Stable name'), member(TEMPORARY, 'Temporary')], { messages: history })],
    sessions: [{ id: CURRENT, name: 'Stable name' }, { id: TEMPORARY, name: 'Temporary' }],
    company: { employees: [employee], temporaryAgents: [{ sessionId: TEMPORARY, icon: '🔧' }], settings: {} },
  });
  handles.push(handle);
  return handle;
}

describe('employee-first message presentation', () => {
  const sessionHue = (sessionId: string) => {
    let hash = 2166136261;
    for (const character of sessionId) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 360;
  };

  it('uses the same employee hue in old/new messages, the member row and the profile card', async () => {
    const handle = await fixture();
    const expected = String(handle.app._chatHue(EMPLOYEE));
    const row = handle.document.querySelector(`[data-key="member:${CURRENT}"]`) as HTMLElement;
    expect(row.style.getPropertyValue('--chat-hue')).toBe(expected);
    expect((row.querySelector('.chatroom-avatar') as HTMLElement).style.getPropertyValue('--chat-hue')).toBe(expected);
    for (const id of ['old', 'new']) {
      const avatar = handle.document.querySelector(`[data-msg-id="${id}"] .chatroom-avatar`) as HTMLElement;
      expect(avatar.style.getPropertyValue('--chat-hue')).toBe(expected);
    }
    const current = handle.shell.room.members.find((entry: { sessionId: string }) => entry.sessionId === CURRENT);
    handle.shell.openProfile(current, row);
    const card = handle.document.querySelector('.ca-profile') as HTMLElement;
    expect(card.style.getPropertyValue('--chat-hue')).toBe(expected);
    expect((card.querySelector('.chatroom-avatar') as HTMLElement).style.getPropertyValue('--chat-hue')).toBe(expected);
  });

  it('keeps the session accent for temporary and unbound members', async () => {
    const handle = await fixture();
    expect(handle.app._chatAccent(TEMPORARY)).toBe(sessionHue(TEMPORARY));
    const row = handle.document.querySelector(`[data-key="member:${TEMPORARY}"]`) as HTMLElement;
    expect(row.style.getPropertyValue('--chat-hue')).toBe(String(sessionHue(TEMPORARY)));
    const avatar = handle.document.querySelector('[data-msg-id="temporary"] .chatroom-avatar') as HTMLElement;
    expect(avatar.style.getPropertyValue('--chat-hue')).toBe(String(sessionHue(TEMPORARY)));
  });

  it('keeps the employee hue through a session rebind without changing an unbound session accent', async () => {
    const handle = await fixture();
    const expected = handle.app._chatHue(EMPLOYEE);
    expect(handle.app._chatAccent(CURRENT)).toBe(expected);
    handle.server.company.employees[0].sessionId = OLD;
    await handle.shell.loadOwner();
    expect(handle.app._chatAccent(OLD)).toBe(expected);
    expect(handle.app._chatAccent(CURRENT)).toBe(sessionHue(CURRENT));
    for (const id of ['old', 'new']) {
      const avatar = handle.document.querySelector(`[data-msg-id="${id}"] .chatroom-avatar`) as HTMLElement;
      expect(avatar.style.getPropertyValue('--chat-hue')).toBe(String(expected));
    }
  });

  it('does not invent an employee hue when current bindings are ambiguous', async () => {
    const handle = await fixture();
    handle.server.company.employees.push({ id: 'employee-two', sessionId: CURRENT, name: 'Other employee' });
    await handle.shell.loadOwner();
    expect(handle.app._chatAccent(CURRENT)).toBe(sessionHue(CURRENT));
  });

  it('shows the same employee icon and name on old and new session messages, with temporary fallback', async () => {
    const handle = await fixture();
    for (const id of ['old', 'new']) {
      const node = handle.document.querySelector(`[data-msg-id="${id}"]`)!;
      expect(node.querySelector('.chatroom-avatar-glyph')!.textContent).toBe('📜');
      expect(node.querySelector('.ca-msg-from')!.textContent).toBe('Stable name');
    }
    expect(handle.document.querySelector('[data-msg-id="temporary"] .chatroom-avatar-glyph')!.textContent).toBe('🔧');
    expect(handle.document.querySelector('[data-msg-id="temporary"] .ca-msg-from')!.textContent).toBe('Temporary');
  });

  it('uses the employee picture on both sessions and retains the emoji when the image fails', async () => {
    const handle = await fixture({ avatar: IMAGE });
    for (const id of ['old', 'new']) {
      const node = handle.document.querySelector(`[data-msg-id="${id}"]`)!;
      const image = node.querySelector('img')!;
      expect(image.getAttribute('src')).toBe(IMAGE);
      image.dispatchEvent(new handle.window.Event('error'));
      expect(node.querySelector('.chatroom-avatar-glyph')!.textContent).toBe('📜');
    }
  });

  it('preserves employee presentation when the employee has no current session', async () => {
    const handle = await fixture({ sessionId: null });
    expect(handle.document.querySelector('[data-msg-id="old"] .chatroom-avatar-glyph')!.textContent).toBe('📜');
    expect(handle.document.querySelector('[data-msg-id="old"] .ca-msg-from')!.textContent).toBe('Stable name');
  });

  it('refreshes old and new messages together when the employee profile changes', async () => {
    const handle = await fixture();
    handle.server.company.employees[0].icon = '🪶';
    handle.server.company.employees[0].name = 'Renamed employee';
    await handle.shell.loadOwner();
    for (const id of ['old', 'new']) {
      expect(handle.document.querySelector(`[data-msg-id="${id}"] .chatroom-avatar-glyph`)!.textContent).toBe('🪶');
      expect(handle.document.querySelector(`[data-msg-id="${id}"] .ca-msg-from`)!.textContent).toBe('Renamed employee');
    }
  });

  it('does not guess by name or an unknown employee id', async () => {
    const handle = await fixture();
    const from = { ...agent(OLD, 'Stable name'), employeeId: 'unknown' };
    expect(handle.shell.authorOf(from)).toBe('Stable name');
    expect(handle.shell.avatarFor(from, 'Stable name', {}).querySelector('.chatroom-avatar-glyph').textContent).not.toBe('📜');
  });

  it('prefers stamped employeeId when the original session is now bound to another employee', async () => {
    const handle = await fixture();
    handle.server.company.employees.push({ id: 'employee-two', sessionId: OLD, name: 'Different employee', icon: '🧩' });
    await handle.shell.loadOwner();
    for (const id of ['old', 'new']) {
      const node = handle.document.querySelector(`[data-msg-id="${id}"]`)!;
      expect(node.querySelector('.ca-msg-from')!.textContent).toBe('Stable name');
      expect(node.querySelector('.chatroom-avatar-glyph')!.textContent).toBe('📜');
    }
    expect(handle.shell.authorOf({ ...agent(OLD, 'Other signature'), employeeId: 'employee-two' })).toBe('Different employee');
  });

  it('groups adjacent turns by employee while keeping different employees separate', async () => {
    const handle = await fixture();
    const continues = handle.window.eval('caContinues');
    const previous = message('first', 'room', { ...agent(OLD, 'Old signature'), employeeId: EMPLOYEE }, 'First', 1000);
    const next = message('next', 'room', { ...agent(CURRENT, 'New signature'), employeeId: EMPLOYEE }, 'Next', 2000);
    expect(continues(previous, next)).toBe(true);
    expect(continues(previous, { ...next, from: { ...next.from, employeeId: 'different' } })).toBe(false);
  });
});
