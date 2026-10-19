/**
 * Owner alerts: a web push to the owner's existing subscriptions (admins only in multi-user mode),
 * whatever their chat preferences; never throws; bounded wait; and the CLI the supervisor runs.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sendOwnerAlert, type PushSend } from '../src/owner-alert.js';
import type { OwnedPushSubscriptionRecord, PushSubscriptionStore } from '../src/push-store.js';

function sub(endpoint: string, extra: Partial<OwnedPushSubscriptionRecord> = {}): OwnedPushSubscriptionRecord {
  return { endpoint, keys: { p256dh: 'k', auth: 'a' }, pushPreferences: { 'chat:mentions': false, 'chat:messages': false }, ...extra } as OwnedPushSubscriptionRecord;
}

function store(subs: OwnedPushSubscriptionRecord[]): PushSubscriptionStore {
  return { getAll: () => subs } as unknown as PushSubscriptionStore;
}

describe('owner alert', () => {
  it('pushes to every device of the owner, chat preferences aside', async () => {
    const sent: Array<{ endpoint: string; payload: object }> = [];
    const send: PushSend = async (s, payload) => {
      sent.push({ endpoint: s.endpoint, payload });
      return true;
    };
    expect(await sendOwnerAlert(store([sub('https://a'), sub('https://b')]), 'Chat is read-only', { multiUser: false, send })).toBe(2);
    expect(sent.map((s) => s.endpoint)).toEqual(['https://a', 'https://b']);
    expect(sent[0].payload).toEqual({ title: 'Reverie alert', body: 'Chat is read-only', tag: 'reverie-alert', urgency: 'critical' });
  });

  it('in multi-user mode goes only to admins', async () => {
    const to: string[] = [];
    const send: PushSend = async (s) => (to.push(s.endpoint), true);
    const subs = [sub('https://admin', { username: 'james', role: 'admin' }), sub('https://user', { username: 'stu', role: 'user' }), sub('https://none')];
    expect(await sendOwnerAlert(store(subs), 'x', { multiUser: true, send })).toBe(1);
    expect(to).toEqual(['https://admin']);
  });

  it('counts refusals, never throws, and stops waiting at the cap', async () => {
    const send: PushSend = async (s) => {
      if (s.endpoint === 'https://gone') return false;
      if (s.endpoint === 'https://broken') throw new Error('boom');
      return true;
    };
    expect(await sendOwnerAlert(store([sub('https://ok'), sub('https://gone'), sub('https://broken')]), 'x', { multiUser: false, send })).toBe(1);
    const broken = { getAll: () => { throw new Error('store unreadable'); } } as unknown as PushSubscriptionStore;
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      expect(await sendOwnerAlert(broken, 'x', { multiUser: false })).toBe(0);
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(1);
    const hang: PushSend = () => new Promise(() => {});
    const started = Date.now();
    expect(await sendOwnerAlert(store([sub('https://slow')]), 'x', { multiUser: false, send: hang, timeoutMs: 50 })).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('with no device sends nothing', async () => {
    let called = false;
    expect(await sendOwnerAlert(store([]), 'x', { multiUser: false, send: async () => (called = true) })).toBe(0);
    expect(called).toBe(false);
  });

  it('the CLI the supervisor runs reads the console data dir, writes nothing, exits 2 with no device and 1 without text', () => {
    const data = mkdtempSync(join(tmpdir(), 'owner-alert-'));
    const cli = resolve('src/owner-alert-cli.ts');
    const tsx = resolve('node_modules/.bin/tsx');
    const env = { PATH: process.env.PATH ?? '', HOME: data, FLEET_DATA_DIR: data };
    const none = spawnSync(tsx, [cli, 'console keeps failing'], { env, encoding: 'utf-8' });
    expect(none.stdout).toContain('owner alert: 0 device(s)');
    expect(none.status).toBe(2);
    expect(spawnSync(tsx, [cli], { env, encoding: 'utf-8' }).status).toBe(1);
    // It never writes the console's push files.
    expect(readdirSync(data)).toEqual([]);
  });
});
