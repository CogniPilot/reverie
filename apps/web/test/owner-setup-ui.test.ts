import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { OWNER_SCRIPT, SETUP_PAGE } from '../src/owner-auth/pages.js';

const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});
function fixture() {
  const dom = new JSDOM(SETUP_PAGE, { url: 'http://localhost/owner/setup', runScripts: 'outside-only' });
  windows.push(dom);
  const fetch = vi.fn(async () => ({
    ok: false,
    json: async () => ({ success: false, error: 'Synthetic retry message' }),
  }));
  dom.window.fetch = fetch as never;
  dom.window.eval(OWNER_SCRIPT);
  const field = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const submit = () =>
    dom.window.document
      .getElementById('setup-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, fetch, field, submit };
}
describe('welcome Create account browser form', () => {
  it('starts with an editable chosen username, new password and confirmation, and needs no bootstrap credentials', async () => {
    const f = fixture();
    expect(f.field('setup-user').value).toBe('');
    expect(f.field('setup-user').required).toBe(true);
    expect(f.dom.window.document.querySelectorAll('input[type="password"]')).toHaveLength(2);
    expect(f.dom.window.document.body.textContent).not.toContain('one-time password');
    expect(f.dom.window.document.body.textContent).not.toContain('Current password');
    f.field('setup-user').value = 'my_login';
    f.field('setup-password').value = 'strong-synthetic-permanent-72';
    f.field('setup-confirm').value = 'strong-synthetic-permanent-72';
    f.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0]).toBe('/api/owner/setup');
    expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({
      username: 'my_login',
      password: 'strong-synthetic-permanent-72',
      confirmation: 'strong-synthetic-permanent-72',
    });
    expect(f.dom.window.document.getElementById('setup-error')!.textContent).toBe('Synthetic retry message');
  });
  it('rejects mismatched confirmation before the request and preserves the chosen username', () => {
    const f = fixture();
    f.field('setup-user').value = 'chosen';
    f.field('setup-password').value = 'strong-synthetic-permanent-72';
    f.field('setup-confirm').value = 'different';
    f.submit();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.field('setup-user').value).toBe('chosen');
    expect(f.dom.window.document.getElementById('setup-error')!.textContent).toContain('differ');
  });
});
