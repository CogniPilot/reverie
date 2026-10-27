import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const avatar = `/api/avatars/${sessionId}?v=7`;
const ownerAvatar = `/api/owner-avatar/${'a'.repeat(32)}?v=8`;
const windows: { close(): void }[] = [];
async function setup({ picture = avatar, narrow = false } = {}) {
  const worker = member(sessionId, 'Alex', { avatar: picture });
  const h = await createHarness({ rooms: [room('room', 'General', [worker])], narrow });
  if (narrow) Object.defineProperty(h.window, 'innerWidth', { value: 360 });
  windows.push(h.window);
  return { ...h, worker };
}
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

describe('profile portrait preview', () => {
  it('opens the stored member image without thumbnail conversion and returns keyboard focus to its button', async () => {
    const h = await setup({ narrow: true });
    const anchor = h.document.querySelector('.ca-member') as HTMLButtonElement;
    anchor.click();
    const card = h.document.querySelector('.ca-profile')!;
    expect(card.classList.contains('ca-profile--sheet')).toBe(true);
    const picture = card.querySelector<HTMLButtonElement>('.ca-profile-picture')!;
    expect(picture.tagName).toBe('BUTTON');
    expect(picture.getAttribute('aria-label')).toBe("View Alex's picture");
    expect(card.querySelector('.ca-profile--compact .ca-profile-top > .ca-profile-picture .ca-profile-avatar')).not.toBeNull();
    picture.focus();
    picture.click();
    const viewer = h.document.querySelector<HTMLDialogElement>('.ca-profile-image-view')!;
    expect(viewer.open).toBe(true);
    expect(viewer.querySelector('img')!.getAttribute('src')).toBe(avatar);
    expect(viewer.querySelector('img')!.alt).toBe("Alex's picture");
    const close = viewer.querySelector<HTMLButtonElement>('button')!;
    expect(h.document.activeElement).toBe(close);
    // The underlying card's document-level Tab trap must not steal modal focus.
    const tab = new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    close.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    viewer.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
    expect(viewer.isConnected).toBe(false);
    expect(h.document.activeElement).toBe(picture);
    expect(card.isConnected).toBe(true);
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.isConnected).toBe(false);
    expect(h.document.activeElement).toBe(anchor);
  });

  it('does not revive a dismissed profile when its image viewer closes', async () => {
    const h = await setup();
    (h.document.querySelector('.ca-member') as HTMLButtonElement).click();
    (h.document.querySelector('.ca-profile-picture') as HTMLButtonElement).click();
    const viewer = h.document.querySelector('.ca-profile-image-view')!;
    h.shell.closeProfile();
    (viewer.querySelector('button') as HTMLButtonElement).click();
    expect(h.document.querySelector('.ca-profile')).toBeNull();
    const event = new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    h.document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('preserves the reverse-proxy image URL and lets the Close button dismiss the viewer', async () => {
    const h = await setup();
    h.window.ReverieBase = { url: (path: string) => `/console${path}` };
    (h.document.querySelector('.ca-member') as HTMLButtonElement).click();
    (h.document.querySelector('.ca-profile-picture') as HTMLButtonElement).click();
    const viewer = h.document.querySelector('.ca-profile-image-view')!;
    expect(viewer.querySelector('img')!.getAttribute('src')).toBe(`/console${avatar}`);
    (viewer.querySelector('button') as HTMLButtonElement).click();
    expect(viewer.isConnected).toBe(false);
  });

  it('keeps initials large without offering an image action, including after an image load failure', async () => {
    const h = await setup({ picture: '' });
    (h.document.querySelector('.ca-member') as HTMLButtonElement).click();
    expect(h.document.querySelector('.ca-profile-avatar')).not.toBeNull();
    expect(h.document.querySelector('.ca-profile-picture')).toBeNull();
    h.shell.closeProfile();
    h.shell.profileAvatars = new Map([[sessionId, avatar]]);
    h.shell.openProfile({ ...h.worker, avatar }, h.document.querySelector('.ca-member'));
    const picture = h.document.querySelector('.ca-profile-picture')!;
    picture.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    expect(h.document.querySelector('.ca-profile-picture')).toBeNull();
    expect(h.document.querySelector('.ca-profile-avatar .chatroom-avatar-glyph')).not.toBeNull();
  });

  it('shows the owner picture in both the profile card and editor, and refreshes the editor preview when initials are chosen', async () => {
    const h = await setup();
    h.shell.ownerAvatar = ownerAvatar;
    h.shell.openMyProfile(h.document.querySelector('.ca-user-btn'));
    expect(h.document.querySelector('.ca-profile-avatar img')!.getAttribute('src')).toBe(ownerAvatar);
    h.shell.closeProfile();
    h.shell.openProfileEditor();
    const editor = h.document.querySelector('.ca-profile-edit')!;
    const picture = editor.querySelector<HTMLButtonElement>('.ca-owner-portrait .ca-profile-picture')!;
    picture.click();
    const viewer = h.document.querySelector('.ca-profile-image-view')!;
    expect(viewer.querySelector('img')!.getAttribute('src')).toBe(ownerAvatar);
    (viewer.querySelector('button') as HTMLButtonElement).click();
    expect(h.document.activeElement).toBe(picture);
    const initials = [...editor.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Use initials'
    )!;
    initials.click();
    expect(editor.querySelector('.ca-owner-portrait .ca-profile-picture')).toBeNull();
    expect(editor.querySelector('.ca-owner-portrait .ca-profile-avatar')).not.toBeNull();
    const replacement = 'data:image/png;base64,iVBORw0KGgo=';
    h.shell.imageToIcon = async () => replacement;
    const input = editor.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      value: [new h.window.File(['image'], 'avatar.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new h.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.querySelector('.ca-owner-portrait img')!.getAttribute('src')).toBe(replacement);
  });
});


describe('editable picture load failures', () => {
  async function fixture(fallback = true) {
    const h = await setup();
    const changes: string[] = [];
    const field = h.shell.pictureField('Picture', avatar, (value: string) => changes.push(value), fallback ? { fallback: () => 'A' } : {});
    h.document.body.append(field.wrap);
    const preview = field.wrap.querySelector('.ca-picture-preview')!;
    const warning = () => [...field.wrap.querySelectorAll('[role=status]')].find((node: any) => !node.hidden && node.textContent.includes('unavailable'));
    return { h, field, changes, preview, warning };
  }
  it('restores the glyph with a status hint without clearing or saving the failed selection', async () => {
    const { h, field, changes, preview, warning } = await fixture();
    const calls = h.server.calls.length;
    preview.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.textContent).toBe('A');
    expect(warning()?.textContent).toContain('selection is unchanged');
    expect(field.value()).toBe(avatar); expect(changes).toEqual([]);
    expect(h.server.calls.length).toBe(calls);
  });
  it('preserves a successful preview without displaying an error', async () => {
    const { h, field, changes, preview, warning } = await fixture();
    preview.querySelector('img')!.dispatchEvent(new h.window.Event('load'));
    expect(preview.querySelector('img')!.getAttribute('src')).toBe(avatar);
    expect(warning()).toBeUndefined(); expect(field.value()).toBe(avatar); expect(changes).toEqual([]);
  });
  it('ignores a late error from an image replaced by a newer selection', async () => {
    const { h, field, preview, warning } = await fixture();
    const old = preview.querySelector('img')!;
    field.set(ownerAvatar); old.dispatchEvent(new h.window.Event('error'));
    expect(preview.querySelector('img')!.getAttribute('src')).toBe(ownerAvatar);
    expect(field.value()).toBe(ownerAvatar); expect(warning()).toBeUndefined();
  });
  it('clears the load warning when a new picture is selected', async () => {
    const { h, field, changes, preview, warning } = await fixture();
    preview.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    field.set(ownerAvatar);
    expect(preview.querySelector('img')!.getAttribute('src')).toBe(ownerAvatar);
    expect(warning()).toBeUndefined(); expect(changes).toEqual([]);
  });
  it('retains explicit Remove semantics after a failed load', async () => {
    const { h, field, changes, preview, warning } = await fixture();
    preview.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    [...field.wrap.querySelectorAll('button')].find((button: any) => button.textContent === 'Remove')!.click();
    expect(field.value()).toBe(''); expect(changes).toEqual(['']);
    expect(preview.textContent).toBe('A'); expect(warning()).toBeUndefined();
  });
  it('shows readable fallback text when no glyph callback was provided', async () => {
    const { h, field, preview, warning } = await fixture(false);
    preview.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    expect(preview.textContent).toBe('none'); expect(warning()).toBeDefined(); expect(field.value()).toBe(avatar);
  });
  it('preserves the file conversion and selection callback after a preview error', async () => {
    const { h, field, changes, preview, warning } = await fixture();
    preview.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    const replacement = 'data:image/png;base64,iVBORw0KGgo=';
    h.shell.imageToIcon = async () => replacement;
    const input = field.wrap.querySelector('input')!;
    Object.defineProperty(input, 'files', { value: [new h.window.File(['image'], 'new.png', { type: 'image/png' })] });
    input.dispatchEvent(new h.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(field.pending()).toBe(false); expect(field.value()).toBe(replacement);
    expect(preview.querySelector('img')!.getAttribute('src')).toBe(replacement);
    expect(changes).toEqual([replacement]); expect(warning()).toBeUndefined();
  });
});
