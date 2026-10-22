import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const SESSION = '0000002d-0035-4000-8000-000000000047';
const ROLE = 'Reverie engineering lead';
const NAME = 'Reverie reviewer';
const OWNER = 'Reverie owner';
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
const i18n = readFileSync(new URL('../src/web/public/i18n.js', import.meta.url), 'utf8');

afterEach(() => {
  for (const handle of handles.splice(0)) handle.window.close();
});

async function fixture() {
  const employee = { id: 'employee-one', sessionId: SESSION, name: NAME, position: ROLE, expertise: ['Reverie review'], reportsTo: 'owner', available: true };
  const handle = await createHarness({
    rooms: [room('room', 'General', [member(SESSION, NAME)])],
    sessions: [{ id: SESSION, name: NAME, pid: 1000 }],
    company: { employees: [employee], temporaryAgents: [], settings: { ownerName: OWNER } },
  });
  handles.push(handle);
  handle.server.profiles = { [SESSION]: { employee, persona: null } };
  handle.window.eval(i18n);
  handle.window.ReverieI18n.configure({ language: 'en', displayName: 'Workspace' });
  handle.window.ReverieI18n.start();
  await handle.flush(10);
  return handle;
}

describe('employee values remain literal under UI branding', () => {
  it('keeps Company role, name, manager and reporting tree literal on asynchronous insertion', async () => {
    const handle = await fixture();
    await handle.shell.openCompany();
    await handle.flush(20);
    expect(handle.document.querySelector('.ca-company-role')!.textContent).toBe(ROLE);
    expect(handle.document.querySelector('.ca-company-person-title strong')!.textContent).toBe(NAME);
    expect(handle.document.querySelector('.ca-company-parent')!.textContent).toBe(OWNER);
    expect(handle.document.querySelector('.ca-company-tree')!.textContent).toContain(OWNER);
    expect(handle.document.querySelector('.ca-company-tree')!.textContent).toContain(NAME);
    handle.window.ReverieI18n.configure({ language: 'zh-CN', displayName: 'Other workspace' });
    await handle.flush(10);
    expect(handle.document.querySelector('.ca-company-role')!.textContent).toBe(ROLE);
    const control = handle.document.createElement('button');
    control.textContent = 'Settings saved';
    handle.document.body.append(control);
    await handle.flush(10);
    expect(control.textContent).toBe('设置已保存');
  });

  it('keeps the separate org chart role and names literal', async () => {
    const handle = await fixture();
    await handle.shell.openOrg();
    await handle.flush(20);
    expect(handle.document.querySelector('.ca-org-item--employee .ca-org-title')!.textContent).toBe(ROLE);
    expect(handle.document.querySelector('.ca-org-item--employee strong')!.textContent).toBe(NAME);
  });

  it('keeps member-card role and the runtime Role section literal', async () => {
    const handle = await fixture();
    const current = handle.shell.room.members.find((entry: { sessionId: string }) => entry.sessionId === SESSION);
    const anchor = handle.document.querySelector(`[data-key="member:${SESSION}"]`) as HTMLElement;
    handle.shell.openProfile(current, anchor);
    await handle.flush(30);
    expect(handle.document.querySelector('.ca-profile-who')!.textContent).toBe(ROLE);
    expect(handle.document.querySelector('.ca-profile-names strong')!.textContent).toBe(NAME);
    const values = [...handle.document.querySelectorAll('.ca-profile-full .ca-v')].map(node => node.textContent);
    expect(values).toContain(ROLE);
    expect(values).toContain('Reverie review');
  });
});
