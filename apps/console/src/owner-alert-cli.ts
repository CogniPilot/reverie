#!/usr/bin/env node
/**
 * @fileoverview `node dist/owner-alert-cli.js TEXT`: push one alert to the owner's devices, for the
 * supervisor (standard-library Python, which cannot sign or encrypt a web push) when the console keeps
 * failing. Reads the console's push store from the same data dir, so it runs with the console's
 * environment. Exit 0: at least one device took it; 2: no device did (none subscribed, or all
 * refused); 1: bad usage.
 */

import { isMultiUserMode } from './config/multiuser.js';
import { sendOwnerAlert } from './owner-alert.js';
import { PushSubscriptionStore } from './push-store.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('usage: owner-alert-cli TEXT');
  process.exit(1);
}
const store = new PushSubscriptionStore();
const sent = await sendOwnerAlert(store, text, { multiUser: isMultiUserMode(), timeoutMs: 15_000 });
// No save: this never writes the console's subscription file (a device that is gone is pruned by the
// console on its next push); the exit drops the store's pending save timer.
console.log(`owner alert: ${sent} device(s)`);
process.exit(sent > 0 ? 0 : 2);
