import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
describe('Claude plan usage errors', () => {
  it('keeps signed-in state and shows the quota error as text beside the plan', async () => {
    const page = new JSDOM(html, { url: 'http://localhost/company/plans', runScripts: 'outside-only' });
    try {
      Object.assign(page.window, {
        fetch: async (path: string) => ({ ok: true, status: 200, json: async () => ({ success: true, data: path === '/api/board' ? {
          built: Date.now(), issues: [], company: {}, timeZone: 'UTC',
          planBurn: [{ id: 'claude', name: 'Claude plan', signedIn: true, authState: 'signed-in', used: null, usageError: 'Claude usage is rate limited. <retry> in five minutes.' }],
        } : { accounts: [], employees: [] } }) }),
        matchMedia: () => ({ matches: false }), setInterval: () => 1,
      });
      page.window.eval(html.match(/<script>([\s\S]*)<\/script>/)![1]);
      await new Promise(done => setTimeout(done, 10));
      const card = page.window.document.querySelector('.plan')!;
      expect(card.querySelector('[data-auth-state]')?.textContent).toBe('Signed in');
      expect(card.querySelector('[data-usage-error]')?.textContent).toContain('<retry> in five minutes');
      expect(card.querySelector('retry')).toBeNull();
      expect(card.querySelector('[data-signin]')?.textContent).toBe('Sign in again');
    } finally { page.window.close(); }
  });
});
