/**
 * Phone-style alert mode in the member list: the server sends `alertMode: {mode, source, until?,
 * then?}` on a room member; the list shows 🔔 ring, 📳 vibrate or 🔕 silent after the name, with
 * a timed mode's end in ET. An ended lease shows the server's `then`; absent or unknown reads as
 * ring, so a stale page never shows a member muted on a guess. Display only: nothing here sets a mode.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const B = '00000035-0040-4000-8000-00000000005c';
const C = '0000003b-0049-4000-8000-00000000006a';
const D = '00000040-0050-4000-8000-000000000077';
const sessions = [
  { id: A, name: 'alpha', mode: 'claude' },
  { id: B, name: 'bravo', mode: 'opencode' },
  { id: C, name: 'carol', mode: 'codex' },
  { id: D, name: 'delta', mode: 'codex' },
];

describe('member alert mode', () => {
  it('shows timed alert modes in the chosen company timezone; expired or endless reads as ring', async () => {
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
    h.window.eval(readFileSync(new URL('../src/web/public/display-time.js', import.meta.url), 'utf8'));
    h.window.ReverieTime.setTimeZone('America/Indiana/Indianapolis');
    h.shell.renderMembers();
    const badge = (name: string) =>
      h.document.querySelector(`.ca-member[aria-label^="${name},"] .ca-member-alert`) as HTMLElement;
    const label = (name: string) => h.document.querySelector(`.ca-member[aria-label^="${name},"]`)!.getAttribute('aria-label');
    expect(badge('alpha').querySelector('svg')).not.toBeNull();
    expect(badge('alpha').textContent).toBe('');
    expect(badge('alpha').style.color).toContain('--text-muted');
    expect(badge('alpha').dataset.alertMode).toBe('ring');
    expect(label('alpha')).toBe('alpha, admin, idle');
    expect(badge('bravo').querySelector('path')?.getAttribute('d')).toContain('L2 9');
    expect(badge('bravo').title).toMatch(/^Vibrate until (\w{3} )?\d{1,2}:\d{2} [AP]M E[DS]T \(wakes on a direct @mention or the owner\)$/);
    expect(label('bravo')).toContain(', Vibrate until ');
    expect(badge('carol').querySelector('path')?.getAttribute('d')).toBe('M3 3l18 18');
    expect(badge('carol').title).toMatch(/^Silent until .* E[DS]T \(only an owner @mention or @everyone wakes it\)$/);
    expect(badge('delta').dataset.alertMode).toBe('ring');
    expect(label('delta')).not.toContain('Silent');
  });
  it("shows the server's default and owner-set modes, and an ended lease's fallback", async () => {
    const rooms = [
      room(
        'r1',
        'General',
        [
          member(A, 'alpha', { alertMode: { mode: 'vibrate', source: 'default' } }),
          member(B, 'bravo', { alertMode: { mode: 'silent', source: 'preference' } }),
          member(C, 'carol', { alertMode: { mode: 'ring', source: 'preference' } }),
          member(D, 'delta', {
            alertMode: { mode: 'ring', source: 'lease', until: Date.now() - 1000, then: 'vibrate' },
          }),
        ],
        {}
      ),
    ];
    const h = await createHarness({ sessions, rooms });
    const badge = (name: string) =>
      h.document.querySelector(`.ca-member[aria-label^="${name},"] .ca-member-alert`) as HTMLElement;
    expect(badge('alpha').dataset.alertMode).toBe('vibrate');
    expect(badge('alpha').title).toBe('Vibrate by default (wakes on a direct @mention or the owner)');
    expect(badge('bravo').dataset.alertMode).toBe('silent');
    expect(badge('bravo').title).toBe('Silent, set by the owner (only an owner @mention or @everyone wakes it)');
    expect(badge('carol').dataset.alertMode).toBe('ring');
    expect(badge('carol').title).toBe('Ring, set by the owner');
    expect(badge('delta').dataset.alertMode).toBe('vibrate');
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
