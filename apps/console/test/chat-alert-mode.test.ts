/**
 * Phone-style alert mode in the member list (prototype of i-bab914de): the server sends
 * `alertMode: {mode, until}` on a room member; the list shows 🔔 ring, 📳 vibrate or 🔕 silent
 * after the name, with the end time in ET. Absent, unknown, endless or expired modes read as
 * ring, so a stale page never shows a member muted. Display only: nothing here sets a mode.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const A = 'a1111111-0000-4000-8000-000000000001';
const B = 'b2222222-0000-4000-8000-000000000002';
const C = 'c3333333-0000-4000-8000-000000000003';
const D = 'd4444444-0000-4000-8000-000000000004';
const sessions = [
  { id: A, name: 'alpha', mode: 'claude' },
  { id: B, name: 'bravo', mode: 'opencode' },
  { id: C, name: 'carol', mode: 'codex' },
  { id: D, name: 'delta', mode: 'codex' },
];

describe('member alert mode', () => {
  it('shows ring, vibrate and silent with an ET end time; expired or endless reads as ring', async () => {
    const hour = 3600e3;
    const rooms = [
      room('r1', 'General', [
        member(A, 'alpha', { role: 'coordinator' }),
        member(B, 'bravo', { alertMode: { mode: 'vibrate', until: Date.now() + hour } }),
        member(C, 'carol', { alertMode: { mode: 'silent', until: Date.now() + 2 * hour } }),
        member(D, 'delta', { alertMode: { mode: 'silent', until: Date.now() - 1000 } }),
      ], {}),
    ];
    const h = await createHarness({ sessions, rooms });
    const badge = (name: string) =>
      h.document.querySelector(`.ca-member[aria-label^="${name},"] .ca-member-alert`) as HTMLElement;
    const label = (name: string) => h.document.querySelector(`.ca-member[aria-label^="${name},"]`)!.getAttribute('aria-label');
    expect(badge('alpha').querySelector('svg')).not.toBeNull();
    expect(badge('alpha').textContent).toBe('');
    expect(badge('alpha').style.color).toContain('--text-muted');
    expect(badge('alpha').dataset.alertMode).toBe('ring');
    expect(label('alpha')).toBe('alpha, admin, idle');
    expect(badge('bravo').querySelector('path')?.getAttribute('d')).toContain('L2 9');
    expect(badge('bravo').title).toMatch(/^Vibrate until (\w{3} )?\d{1,2}:\d{2} [AP]M ET \(wakes on a direct @mention or the owner\)$/);
    expect(label('bravo')).toContain(', Vibrate until ');
    expect(badge('carol').querySelector('path')?.getAttribute('d')).toBe('M3 3l18 18');
    expect(badge('carol').title).toMatch(/^Silent until .* ET \(only the owner wakes it\)$/);
    expect(badge('delta').dataset.alertMode).toBe('ring');
    expect(label('delta')).not.toContain('Silent');
  });
  it('reads an inherited key such as constructor or __proto__ as ring and never throws', async () => {
    const until = Date.now() + 3600e3;
    const odd = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
    const ids = odd.map((_, i) => `e${i}000000-0000-4000-8000-00000000000${i}`);
    const rooms = [
      room('r1', 'General', odd.map((mode, i) => member(ids[i], `odd${i}`, { alertMode: { mode, until } })), {}),
    ];
    const h = await createHarness({ sessions: odd.map((_, i) => ({ id: ids[i], name: `odd${i}`, mode: 'codex' })), rooms });
    for (let i = 0; i < odd.length; i++) {
      const row = h.document.querySelector(`.ca-member[aria-label^="odd${i},"]`)!;
      const badge = row.querySelector('.ca-member-alert') as HTMLElement;
      expect(badge.querySelector('svg')).not.toBeNull();
      expect(badge.textContent).toBe('');
      expect(badge.dataset.alertMode).toBe('ring');
      expect(badge.title).toBe('Ring');
      expect(row.getAttribute('aria-label')).not.toContain('Ring');
    }
  });
});
