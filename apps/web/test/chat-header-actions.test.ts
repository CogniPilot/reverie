import { describe, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const SESSION = '0000002d-0035-4000-8000-000000000047';
const fixtures = () => [room('room-one', 'A long channel name for a narrow phone', [member(SESSION, 'Alpha')])];

describe('compact header secondary actions', () => {
  it('keeps the people control separate and exposes only available actions in More', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      const more = harness.document.querySelector('.ca-head-more') as HTMLButtonElement;
      expect(more.getAttribute('aria-haspopup')).toBe('menu');
      const members = harness.document.querySelector('.ca-head-members') as HTMLButtonElement;
      expect(members.hidden).toBe(false);
      members.click();
      expect(harness.shell.drawer).toBe('members');
      harness.shell.toggleDrawer(null);
      more.click();
      const labels = [...harness.document.querySelectorAll('.ca-head-menu [role="menuitem"]')].map(item => item.textContent);
      // Channel notification settings left the header with its bell button; they are in the channel menu.
      expect(labels).toEqual(['Add people to A long channel name for a narrow phone', 'Pinned messages', 'Install app and notifications']);
      expect(labels).not.toContain('Show member list');
    } finally { harness.dom.window.close(); }
  });

  it('keeps the install launcher out of the persistent header; the phone More menu still opens it', async () => {
    for (const narrow of [false, true]) {
      const harness = await createHarness({ rooms: fixtures(), narrow });
      try {
        expect(harness.document.querySelector('.ca-head .ca-head-phone')).toBeNull();
        const open = vi.fn();
        (harness.window as any).ReverieMobile = { open };
        (harness.document.querySelector('.ca-head-more') as HTMLButtonElement).click();
        const item = [...harness.document.querySelectorAll('.ca-head-menu [role="menuitem"]')].find(button => button.textContent === 'Install app and notifications') as HTMLButtonElement;
        item.click();
        expect(open).toHaveBeenCalledTimes(1);
      } finally { harness.dom.window.close(); }
    }
  });

  it('runs the original invite and pin actions and returns focus to the visible More button', async () => {
    const harness = await createHarness({ rooms: fixtures(), narrow: true });
    try {
      let invited = 0, pinned = 0;
      harness.shell.openInviteDialog = () => { invited++; };
      harness.shell.openPinsDialog = () => { pinned++; };
      const more = harness.document.querySelector('.ca-head-more') as HTMLButtonElement;
      const choose = (label: string) => {
        more.click();
        const item = [...harness.document.querySelectorAll('.ca-head-menu [role="menuitem"]')].find(button => button.textContent === label) as HTMLButtonElement;
        expect(item).toBeDefined(); item.click();
      };
      choose('Add people to A long channel name for a narrow phone');
      choose('Pinned messages');
      expect(invited).toBe(1); expect(pinned).toBe(1);
      more.click();
      expect(harness.document.querySelector('.ca-head-menu')).not.toBeNull();
      harness.document.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(harness.document.activeElement).toBe(more);
    } finally { harness.dom.window.close(); }
  });

  it('omits unavailable controls on older servers and page views', async () => {
    const harness = await createHarness({ rooms: fixtures(), features: { pins: false } });
    try {
      const more = harness.document.querySelector('.ca-head-more') as HTMLButtonElement;
      more.click();
      expect(harness.document.querySelector('.ca-head-menu')?.textContent).not.toContain('Pinned messages');
      harness.shell.closeMenus();
      harness.shell.embed = 'board';
      harness.shell.renderHeader();
      more.click();
      expect([...harness.document.querySelectorAll('.ca-head-menu [role="menuitem"]')].map(item => item.textContent)).toEqual(['Install app and notifications']);
    } finally { harness.dom.window.close(); }
  });
});
