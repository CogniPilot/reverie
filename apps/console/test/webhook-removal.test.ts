import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn(async () => undefined) }));
vi.mock('web-push', () => ({
  default: {
    sendNotification,
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: vi.fn(),
  },
}));
import { WebServer } from '../src/web/server.js';
import { getDataDir } from '../src/config/instance.js';
import { ChatroomStore, USER_RECIPIENT } from '../src/chatroom-store.js';
import { sendChatPush } from '../src/chat-push.js';
import type { PushSubscriptionStore } from '../src/push-store.js';

const source = (file: string) => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
type Sender = { sendPushNotifications(event: string, data: Record<string, unknown>): Promise<void> };
function server(subscribed: boolean): Sender {
  const result = new WebServer(0, false, true, '127.0.0.1', 'removal-test');
  (result as unknown as { pushStore: unknown }).pushStore = {
    getAll: () =>
      subscribed
        ? [
            {
              endpoint: 'https://push.example.com/device',
              keys: { p256dh: 'public', auth: 'auth' },
              pushPreferences: {},
            },
          ]
        : [],
    getVapidKeys: () => ({ publicKey: 'public', privateKey: 'private', generatedAt: 0 }),
    removeByEndpoint: vi.fn(),
  };
  return result as unknown as Sender;
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('outbound webhook removal preserves Web Push', () => {
  it('removes webhook controls and handlers while retaining the notification settings', () => {
    const dom = new JSDOM(source('src/web/public/index.html'));
    expect(dom.window.document.querySelector('#settings-notifications')).not.toBeNull();
    expect(dom.window.document.querySelector('#webhookGroup')).toBeNull();
    expect(dom.window.document.querySelector('[onclick*="Webhook"]')).toBeNull();
    expect(source('src/web/public/settings-ui.js')).not.toMatch(
      /loadWebhook|saveWebhook|testWebhook|clearWebhook|_webhookPending|\/api\/webhook/
    );
    dom.window.close();
  });
  it('does not wire the removed routes or notifier into the server', () => {
    expect(source('src/web/server.ts')).not.toMatch(/WebhookNotifier|registerWebhookRoutes|webhookNotifier/);
    expect(source('src/web/routes/index.ts')).not.toContain('webhook-routes');
  });
  it('still sends a session alert by Web Push even if an old webhook file is present', async () => {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(
      join(getDataDir(), 'webhook.json'),
      JSON.stringify({ enabled: true, kind: 'generic', url: 'http://127.0.0.1:9/old' })
    );
    const fetcher = vi.fn(() => {
      throw new Error('outbound webhook request attempted');
    });
    vi.stubGlobal('fetch', fetcher);
    await server(true).sendPushNotifications('hook:permission_prompt', {
      sessionId: 'worker',
      sessionName: 'Worker',
      tool_name: 'Read',
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1] as string)).toMatchObject({
      title: 'Permission Required',
      sessionId: 'worker',
      urgency: 'critical',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('still sends a chat mention through Web Push independently of session-event hooks', async () => {
    const rooms = new ChatroomStore();
    const room = rooms.create('alerts', undefined);
    rooms.addMember(room.id, 'watcher');
    const message = rooms.post(room.id, { kind: 'agent', name: 'Watcher', sessionId: 'watcher' }, 'Owner alert', [
      USER_RECIPIENT,
    ]);
    const store = {
      getAll: () => [
        { endpoint: 'https://push.example.com/device', keys: { p256dh: 'public', auth: 'auth' }, pushPreferences: {} },
      ],
      getVapidKeys: () => ({ publicKey: 'public', privateKey: 'private', generatedAt: 0 }),
    } as unknown as PushSubscriptionStore;
    await sendChatPush(store, room, message, false);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1] as string)).toMatchObject({
      roomId: room.id,
      messageId: message.id,
    });
  });
  it('makes no outbound request when no browser is subscribed', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await server(false).sendPushNotifications('session:error', { sessionId: 'worker', error: 'failed' });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
