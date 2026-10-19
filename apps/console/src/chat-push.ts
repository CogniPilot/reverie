/** Background message notifications for the human owner's devices. */
import webpush from 'web-push';
import { isDm, USER_RECIPIENT, type ChatMessage, type ChatRoom } from './chatroom-store.js';
import type { PushSubscriptionStore, OwnedPushSubscriptionRecord } from './push-store.js';
import { isSafePushEndpoint } from './utils/push-endpoint-validation.js';

export function chatPushKind(room: ChatRoom, message: ChatMessage): 'mention' | 'message' | null {
  if (room.archivedAt || message.from.kind !== 'agent') return null;
  if (isDm(room)) return room.dm?.includes(USER_RECIPIENT) ? 'mention' : null;
  if (message.to !== 'all') return message.to.includes(USER_RECIPIENT) ? 'mention' : null;
  return 'message';
}

export async function deliver(
  store: PushSubscriptionStore,
  sub: OwnedPushSubscriptionRecord,
  payload: object
): Promise<boolean> {
  if (!isSafePushEndpoint(sub.endpoint)) return false;
  const keys = store.getVapidKeys();
  webpush.setVapidDetails('mailto:notifications@reverie.invalid', keys.publicKey, keys.privateKey);
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 3600 });
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) store.removeByEndpoint(sub.endpoint);
    return false;
  }
}

export async function sendChatPush(
  store: PushSubscriptionStore,
  room: ChatRoom,
  message: ChatMessage,
  multiUser: boolean
): Promise<void> {
  const kind = chatPushKind(room, message);
  if (!kind) return;
  const sender = message.from.name;
  const channel = isDm(room) ? 'Direct message' : `#${room.name}`;
  await Promise.all(
    store.getAll().map(async (sub) => {
      // A privileged account is not a participant in another owner's private chat.
      if (multiUser && (!room.owner || !sub.username || sub.username !== room.owner)) return;
      if (
        kind === 'mention'
          ? sub.pushPreferences['chat:mentions'] === false
          : sub.pushPreferences['chat:messages'] !== true
      )
        return;
      const preview = sub.pushPreferences['chat:preview'] === true;
      await deliver(store, sub, {
        title: `${sender} · ${channel}`,
        body: preview
          ? (message.text || 'Sent an attachment').slice(0, 220)
          : kind === 'mention'
            ? 'A message for you in Reverie'
            : 'New message in Reverie',
        tag: `reverie-chat-${room.id}`,
        roomId: room.id,
        messageId: message.id,
        urgency: kind === 'mention' ? 'warning' : 'info',
      });
    })
  );
}

/** A test goes to exactly the device selected by the human, never a broadcast. */
export async function sendDeviceTest(store: PushSubscriptionStore, sub: OwnedPushSubscriptionRecord): Promise<boolean> {
  return deliver(store, sub, {
    title: 'Reverie is ready',
    body: 'Message notifications can reach this device.',
    tag: 'reverie-device-test',
  });
}
