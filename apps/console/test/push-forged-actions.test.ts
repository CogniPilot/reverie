/**
 * @fileoverview A push notification is only a hint to open the app; it never answers an approval.
 *
 * Any process that can read the push keys (every agent in a shared-uid container) can send a payload
 * with any title, body, approvalId and action buttons. Answering from the lock screen with the owner's
 * cookie made such a payload a confused deputy. These tests drive the real sw.js and approvals-ui.js:
 * buttons in a payload are never shown, a click never fetches anything, and the page opens the
 * approvals drawer instead of answering, whatever the action says. Port: none (vm-loaded modules).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const forged = {
  title: 'Approve deploy?',
  body: 'Tap Approve to continue',
  sessionId: 's1',
  approvalId: 's1:7',
  urgency: 'critical',
  actions: [
    { action: 'approve', title: 'Approve' },
    { action: 'deny', title: 'Deny' },
  ],
};

function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const postMessage = vi.fn();
  const clientsList: unknown[] = [];
  const self = {
    location: { pathname: '/sw.js', origin: 'http://localhost' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => clientsList), openWindow },
  };
  const fetch = vi.fn(async () => ({ ok: true }));
  vm.runInContext(readFileSync(resolve(PUBLIC, 'sw.js'), 'utf8'), vm.createContext({ self, console, caches: {}, fetch, URL }), {
    filename: 'sw.js',
  });
  return { listeners, showNotification, openWindow, postMessage, clientsList, fetch };
}

async function settle(event: { waitUntil: ReturnType<typeof vi.fn> }) {
  for (const call of event.waitUntil.mock.calls) await call[0];
}

describe('service worker: notifications never answer', () => {
  it('shows no action buttons even when the payload carries them', async () => {
    const w = loadWorker();
    const event = { data: { json: () => forged }, waitUntil: vi.fn() };
    w.listeners.get('push')!(event);
    await settle(event);
    expect(w.showNotification).toHaveBeenCalledTimes(1);
    const [, options] = w.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(options.actions).toBeUndefined();
    expect((options.data as { approvalId: string }).approvalId).toBe('s1:7');   // still opens the right card
  });

  for (const action of ['approve', 'deny', '', 'anything']) {
    it(`a click with action "${action}" fetches nothing and opens the app for review`, async () => {
      const w = loadWorker();
      const event = {
        action,
        notification: { close: vi.fn(), data: { sessionId: 's1', approvalId: 's1:7', url: '/?session=s1' } },
        waitUntil: vi.fn(),
      };
      w.listeners.get('notificationclick')!(event);
      await settle(event);
      expect(w.fetch).not.toHaveBeenCalled();
      expect(w.openWindow).toHaveBeenCalledWith('http://localhost/?session=s1');
    });
  }

  it('an open tab is told to review, never to approve', async () => {
    const w = loadWorker();
    const client = { url: 'http://localhost/', postMessage: vi.fn(), focus: vi.fn(async () => undefined) };
    w.clientsList.push(client);
    const event = {
      action: 'approve',
      notification: { close: vi.fn(), data: { sessionId: 's1', approvalId: 's1:7' } },
      waitUntil: vi.fn(),
    };
    w.listeners.get('notificationclick')!(event);
    await settle(event);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'review', approvalId: 's1:7' }));
  });
});

describe('approvals UI: a notification opens the drawer, it never answers', () => {
  function loadApp(inbox: boolean, drawerOpen = false) {
    const answerApproval = vi.fn();
    const toggleApprovalsInbox = vi.fn();
    const selectSession = vi.fn();
    class CodemanApp {
      sessions = new Map([['s1', {}]]);
    }
    const document = {
      getElementById: (id: string) =>
        id === 'approvalsDrawer' ? { classList: { contains: (c: string) => c === 'open' && drawerOpen } } : null,
    };
    const context = vm.createContext({ CodemanApp, document, console });
    vm.runInContext(readFileSync(resolve(PUBLIC, 'approvals-ui.js'), 'utf8'), context, { filename: 'approvals-ui.js' });
    const app = new CodemanApp() as unknown as Record<string, (...a: unknown[]) => unknown>;
    Object.assign(app, { answerApproval, toggleApprovalsInbox, selectSession, approvalsInboxEnabled: () => inbox });
    return { app, answerApproval, toggleApprovalsInbox, selectSession };
  }

  for (const action of ['approve', 'deny', 'review']) {
    it(`action "${action}" with an approval opens the drawer and answers nothing`, () => {
      const t = loadApp(true);
      t.app.handleNotificationAction(action, 's1:7', 's1');
      expect(t.answerApproval).not.toHaveBeenCalled();
      expect(t.toggleApprovalsInbox).toHaveBeenCalledTimes(1);
    });
  }

  it('an already-open drawer is left open (no toggle closes it)', () => {
    const t = loadApp(true, true);
    t.app.handleNotificationAction('approve', 's1:7', 's1');
    expect(t.toggleApprovalsInbox).not.toHaveBeenCalled();
    expect(t.answerApproval).not.toHaveBeenCalled();
  });

  it('with the inbox off it just selects the session', () => {
    const t = loadApp(false);
    t.app.handleNotificationAction('approve', 's1:7', 's1');
    expect(t.answerApproval).not.toHaveBeenCalled();
    expect(t.selectSession).toHaveBeenCalledWith('s1');
  });
});
