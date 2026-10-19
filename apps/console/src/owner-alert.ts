/**
 * @fileoverview Alerts for the owner when chat itself cannot carry them: chat refused to start, chat
 * went read-only, a nightly chat backup failed, or (from the supervisor, through owner-alert-cli) the
 * console keeps failing. Sent as web push to the owner's existing subscriptions (the same store and
 * keys as chat notifications), whatever their chat preferences; in multi-user mode only to admins.
 */

import { deliver } from './chat-push.js';
import type { OwnedPushSubscriptionRecord, PushSubscriptionStore } from './push-store.js';

export type PushSend = (sub: OwnedPushSubscriptionRecord, payload: object) => Promise<boolean>;

export interface OwnerAlertOptions {
  multiUser: boolean;
  /** For tests; the default is the chat push sender. */
  send?: PushSend;
  /** Give up waiting after this long (the console may be about to exit). */
  timeoutMs?: number;
  /** Replace the default title, and ask a tap to open the Board. */
  title?: string;
  board?: boolean;
}

/** Push `text` to the owner's devices. Resolves to how many accepted it; never throws. */
export async function sendOwnerAlert(store: PushSubscriptionStore, text: string, opts: OwnerAlertOptions): Promise<number> {
  try {
    const subs = store.getAll().filter((sub) => !opts.multiUser || sub.role === 'admin');
    if (!subs.length) return 0;
    const send: PushSend = opts.send ?? ((sub, payload) => deliver(store, sub, payload));
    const payload = {
      title: opts.title ?? 'Reverie alert',
      body: text.slice(0, 220),
      tag: opts.board ? 'reverie-decisions' : 'reverie-alert',
      urgency: 'critical',
      ...(opts.board ? { board: true } : {}),
    };
    const sent = Promise.all(subs.map((sub) => send(sub, payload).catch(() => false))).then((ok) => ok.filter(Boolean).length);
    if (!opts.timeoutMs) return await sent;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(0), opts.timeoutMs);
    });
    try {
      return await Promise.race([sent, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('[owner-alert] push failed:', err);
    return 0;
  }
}
