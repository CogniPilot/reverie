import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function planMemberHtml('), html.indexOf('// Codex banked resets:'));

function harness() {
  const dom = new JSDOM('<div data-plan-members="work"></div><div data-plan-members="cogni"></div>', { pretendToBeVisual: true });
  const fetch = vi.fn();
  const context = {
    document: dom.window.document, window: dom.window, fetch, AbortController, setTimeout, clearTimeout,
    B: { planBurn: [{ id: 'work', who: 'Stale Person' }, { id: 'cogni', who: 'Another Stale Person' }] },
    planAllocations: null, pendingPlanRequests: [], planMembersBusy: false, planMembersError: false,
    esc: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!),
  };
  const methods = vm.runInNewContext(`${source}\n({renderPlanMembers, refreshPlanMembers})`, context) as { renderPlanMembers(): void; refreshPlanMembers(): Promise<void> };
  const employees = [{ id: 'person-casey', sessionId: 'session-casey', name: 'Casey', icon: '🧩', avatar: '/api/avatars/session-casey?v=1' }];
  const snapshot = (account: string, members = employees) => ({ generatedAt: 1, employees: members, accounts: ['work', 'cogni'].map((id) => ({ id, sessionIds: id === account ? members.map((member) => member.sessionId) : [] })) });
  const respond = (data: unknown) => fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  const row = (account: string) => dom.window.document.querySelector(`[data-plan-members="${account}"]`)!;
  return { dom, context, fetch, methods, employees, snapshot, respond, row };
}

describe('live plan-member avatars', () => {
  it('moves the bound employee between plans without a full Board redraw or stale who-notes', async () => {
    const test = harness();
    try {
      test.respond(test.snapshot('work'));
      await test.methods.refreshPlanMembers();
      expect(test.row('work').querySelector('button')?.getAttribute('aria-label')).toBe('Casey');
      expect(test.row('work').querySelector('img')?.getAttribute('src')).toBe('/api/avatars/session-casey?v=1');
      expect(test.row('cogni').textContent).toContain('No employees allocated');
      const updated = [{ ...test.employees[0], sessionId: 'new-session-casey', avatar: '/api/avatars/new-session-casey?v=2' }];
      test.respond(test.snapshot('cogni', updated));
      await test.methods.refreshPlanMembers();
      expect(test.row('work').querySelector('button')).toBeNull();
      expect(test.row('cogni').querySelector('button')?.getAttribute('aria-label')).toBe('Casey');
      expect(test.row('cogni').querySelector('img')?.getAttribute('src')).toBe('/api/avatars/new-session-casey?v=2');
      expect(test.dom.window.document.body.textContent).not.toMatch(/Stale Person/);
      expect(test.fetch.mock.calls.every(([path]) => ['/api/plans/allocations', '/api/plans/requests/recent'].includes(path))).toBe(true);
    } finally { test.dom.window.close(); }
  });

  it('preserves existing avatar nodes and focus when the snapshot is unchanged', async () => {
    const test = harness();
    try {
      test.respond(test.snapshot('work'));
      await test.methods.refreshPlanMembers();
      const button = test.row('work').querySelector('button')!;
      button.focus();
      await test.methods.refreshPlanMembers();
      expect(test.row('work').querySelector('button')).toBe(button);
      expect(test.dom.window.document.activeElement).toBe(button);
    } finally { test.dom.window.close(); }
  });

  it('escapes names, refuses external images and retains the icon when an image fails', async () => {
    const test = harness();
    try {
      const malicious = [{ ...test.employees[0], name: '<img src=x onerror=alert(1)>', avatar: 'https://outside.test/avatar' }];
      test.respond(test.snapshot('work', malicious));
      await test.methods.refreshPlanMembers();
      expect(test.row('work').querySelector('img')).toBeNull();
      expect(test.row('work').querySelector('button')?.getAttribute('aria-label')).toBe(malicious[0].name);
      expect(test.row('work').querySelector('[onerror]')).toBeNull();
      test.respond(test.snapshot('work'));
      await test.methods.refreshPlanMembers();
      test.row('work').querySelector('img')!.dispatchEvent(new test.dom.window.Event('error'));
      expect(test.row('work').querySelector('img')).toBeNull();
      expect(test.row('work').querySelector('.plan-member-face')?.textContent).toBe('🧩');
    } finally { test.dom.window.close(); }
  });

  it('clears identity data after authorization is lost and labels transient failures as stale', async () => {
    const test = harness();
    try {
      test.respond(test.snapshot('work'));
      await test.methods.refreshPlanMembers();
      test.fetch.mockRejectedValue(new Error('offline'));
      await test.methods.refreshPlanMembers();
      expect(test.row('work').querySelector('button')).not.toBeNull();
      expect(test.row('work').textContent).toContain('Updates paused');
      test.fetch.mockResolvedValue({ ok: false, status: 403 });
      await test.methods.refreshPlanMembers();
      expect(test.row('work').querySelector('button')).toBeNull();
      expect(test.row('work').textContent).toBe('Members unavailable');
    } finally { test.dom.window.close(); }
  });

  it('does not overlap allocation requests', async () => {
    const test = harness();
    try {
      let finish: (value: unknown) => void = () => {};
      test.fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const pending = test.methods.refreshPlanMembers();
      await test.methods.refreshPlanMembers();
      expect(test.fetch).toHaveBeenCalledTimes(1);
      finish({ ok: true, status: 200, json: async () => ({ success: true, data: test.snapshot('work') }) });
      await pending;
      expect(test.context.planMembersBusy).toBe(false);
    } finally { test.dom.window.close(); }
  });
});
