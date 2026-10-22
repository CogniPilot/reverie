import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const FIRST = '0000002d-0035-4000-8000-000000000047';
const SECOND = '0000002d-0035-4000-8000-000000000048';
const THIRD = '0000002d-0035-4000-8000-000000000049';
const fixtures = () => [room('room-one', 'A long channel name', [
  member(FIRST, 'Reviewer'),
  member(SECOND, 'Builder', { working: true }),
  member(THIRD, 'Mapper', { alive: false }),
])];

describe('members header chip using the existing drawer', () => {
  it('shows server member count and includes working members as online', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      expect(button.querySelector('.ca-members-chip-count')?.textContent).toBe('3');
      expect(button.querySelector('.ca-members-chip-dot')?.getAttribute('data-online')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe('Show member list (3 members, 2 online)');
      expect(button.getAttribute('aria-controls')).toBe(harness.document.querySelector('.ca-members')?.id);
      expect(harness.document.querySelectorAll('.ca-members')).toHaveLength(1);
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-pressed')).toBe('false');
    } finally { harness.dom.window.close(); }
  });

  it('opens and closes the existing drawer without changing desktop preference', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true, stored: { 'reverie:chat:members': '0' } });
    try {
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      const list = harness.document.querySelector('.ca-members');
      button.click();
      expect(harness.shell.drawer).toBe('members');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(list?.hasAttribute('inert')).toBe(false);
      expect(harness.shell.membersOpen).toBe(false);
      expect(harness.window.localStorage.getItem('reverie:chat:members')).toBe('0');
      button.click();
      expect(harness.shell.drawer).toBeNull();
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(list?.hasAttribute('inert')).toBe(true);
      expect(harness.document.querySelector('.ca-members')).toBe(list);
    } finally { harness.dom.window.close(); }
  });

  it('updates expansion after outside dismissal and returns Escape focus to the chip', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      button.click();
      (harness.document.querySelector('.ca-scrim') as HTMLElement).click();
      expect(button.getAttribute('aria-expanded')).toBe('false');
      button.click();
      harness.document.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(harness.shell.drawer).toBeNull();
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(harness.document.activeElement).toBe(button);
    } finally { harness.dom.window.close(); }
  });

  it('updates counts and offline dot from current room membership and presence', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      harness.shell.room.members.splice(1);
      harness.shell.room.members[0].alive = false;
      harness.shell.renderMembers();
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      expect(button.querySelector('.ca-members-chip-count')?.textContent).toBe('1');
      expect(button.querySelector('.ca-members-chip-dot')?.getAttribute('data-online')).toBe('false');
      expect(button.getAttribute('aria-label')).toBe('Show member list (1 member, 0 online)');
    } finally { harness.dom.window.close(); }
  });

  it('bounds visual counts while keeping the full accessible count', async () => {
    const harness = await createHarness({ rooms: [room('room-one', 'Large room', Array.from({ length: 105 }, (unused, index) =>
      member(`session-${index}`, `Member ${index}`, { alive: false })))], narrow: true });
    try {
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      expect(button.querySelector('.ca-members-chip-count')?.textContent).toBe('99+');
      expect(button.getAttribute('aria-label')).toContain('105 members, 0 online');
    } finally { harness.dom.window.close(); }
  });

  it('keeps desktop toggle persistence and does not open a drawer', async () => {
    const harness = await createHarness({ rooms: fixtures(), stored: { 'reverie:chat:members': '1' } });
    try {
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      expect(button.getAttribute('aria-expanded')).toBe('true');
      button.click();
      expect(harness.shell.drawer).toBeNull();
      expect(harness.shell.membersOpen).toBe(false);
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(harness.window.localStorage.getItem('reverie:chat:members')).toBe('0');
    } finally { harness.dom.window.close(); }
  });

  it('hides the control outside a room, on pages, during creation and in external views', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      harness.shell.embed = 'board';
      harness.shell.renderHeader();
      expect(button.hidden).toBe(true);
      harness.shell.embed = null;
      harness.app._chatCreating = true;
      harness.shell.renderHeader();
      expect(button.hidden).toBe(true);
      harness.app._chatCreating = false;
      harness.shell.embassy = { selected: 'external' };
      harness.shell.renderMemberChip();
      expect(button.hidden).toBe(true);
      harness.shell.embassy = null;
      harness.shell.renderMemberChip();
      expect(button.hidden).toBe(false);
      harness.app._chatRoom = null;
      harness.app._chatRoomId = null;
      harness.shell.renderMemberChip();
      expect(button.hidden).toBe(true);
    } finally { harness.dom.window.close(); }
  });

  it('resynchronizes expansion and inertness when the breakpoint changes', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true, stored: { 'reverie:chat:members': '1' } });
    try {
      let listener: (() => void) | undefined;
      let compact = true;
      harness.window.matchMedia = (query: string) => ({ matches: query === '(max-width: 899px)' && compact,
        addEventListener: (_event: string, callback: () => void) => { listener = callback; } }) as MediaQueryList;
      harness.shell.installViewport();
      const button = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      expect(button.getAttribute('aria-expanded')).toBe('false');
      compact = false;
      listener?.();
      expect(button.getAttribute('aria-expanded')).toBe('true');
      compact = true;
      listener?.();
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(harness.document.querySelector('.ca-members')?.hasAttribute('inert')).toBe(true);
    } finally { harness.dom.window.close(); }
  });

  it('refreshes the online count on the existing session-presence update path', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      harness.app.sessions.set(FIRST, { id: FIRST, status: 'stopped' });
      harness.shell.schedulePresence();
      await new Promise<void>(done => harness.window.requestAnimationFrame(() => done()));
      expect(harness.document.querySelector('.ca-head-members')?.getAttribute('aria-label'))
        .toBe('Show member list (3 members, 1 online)');
    } finally { harness.dom.window.close(); }
  });

  it('scopes the compact control to the existing drawer breakpoint and hides chip text on desktop', () => {
    const css = postcss.parse(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.css'), 'utf8'));
    const compact = new Map<string, string>();
    let fixedDrawer = false;
    let desktopHidden = false;
    css.walkRules(rule => {
      if (rule.selectors.includes('.ca-members-chip-dot') && rule.selectors.includes('.ca-members-chip-count')) {
        desktopHidden = rule.nodes.some(node => node.type === 'decl' && node.prop === 'display' && node.value === 'none');
      }
    });
    css.walkAtRules('media', media => {
      if (media.params !== '(max-width: 899px)') return;
      media.walkRules(rule => {
        if (rule.selector === '.ca-root .ca-head .ca-head-members') {
          rule.walkDecls(declaration => { compact.set(declaration.prop, declaration.value); });
        }
        if (rule.selector === '.ca-members') {
          rule.walkDecls('position', declaration => { fixedDrawer = declaration.value === 'fixed'; });
        }
      });
    });
    expect(desktopHidden).toBe(true);
    expect(compact.get('display')).toBe('inline-flex');
    expect(compact.get('min-width')).toBe('60px');
    expect(compact.get('width')).toBe('auto');
    expect(fixedDrawer).toBe(true);
  });
});
