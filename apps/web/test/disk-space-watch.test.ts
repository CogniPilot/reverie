/**
 * Disk-space alarm: levels with hysteresis, one post per change, a recovered line on re-arm, critical push first,
 * restart safety, bounded retry, read-failure notice and the consumer scan. Synthetic volumes; no real disk is read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiskSpaceWatch, nextLevel, scanConsumers, formatBytes, type DiskVolume, type DiskSpaceWatchDeps } from '../src/disk-space-watch.js';
import { BotWatchPostRefused } from '../src/bot-watch-state.js';
import type { ChatBot } from '../src/chat-bots.js';
import type { ChatMessage, ChatRoom } from '../src/chatroom-store.js';

const GB = 1_000_000_000;
const config = {
  version: 1, type: 'disk-space', enabled: true, botId: 'disk', roomId: 'boardroom',
  warnPercent: 90, criticalPercent: 99, rearmMarginPercent: 1, intervalMinutes: 5, mention: 'James',
};
const volume = (percent: number, key = 'dev-1', labels = ['Workspace']): DiskVolume => ({
  key, labels, totalBytes: 1000 * GB, availableBytes: Math.round((100 - percent) * 10 * GB), roots: [],
});

let root: string, clock: number, percent: number, posted: string[], pushed: string[], room: ChatRoom, bot: ChatBot;
let fail: unknown;
const make = (extra: Partial<DiskSpaceWatchDeps> = {}) =>
  new DiskSpaceWatch(path.join(root, 'disk.json'), {
    bot: (id) => (id === bot.id ? bot : undefined),
    room: (id) => (id === room.id ? room : undefined),
    post: (_b, _r, text) => {
      if (fail) throw fail;
      posted.push(text);
      const message = { id: `m${posted.length}`, at: clock, text, from: { kind: 'bot', botId: 'disk', name: 'Disk' } } as unknown as ChatMessage;
      room.messages.push(message);
      return message;
    },
    volumes: async () => [volume(percent)],
    consumers: async () => ({ entries: [{ name: 'cases', bytes: 700 * GB }, { name: 'images', bytes: 120 * GB }], partial: true }),
    push: async (text) => (pushed.push(text), 1),
    timeZone: () => 'UTC',
    now: () => clock,
    ...extra,
  });
const step = async (w: DiskSpaceWatch, next: number) => {
  percent = next;
  clock += 5 * 60_000;
  await w.tick();
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-space-watch-'));
  clock = Date.UTC(2026, 10, 1, 2, 0);
  percent = 50;
  posted = [];
  pushed = [];
  fail = undefined;
  room = { id: 'boardroom', name: 'Boardroom', members: [], messages: [] } as unknown as ChatRoom;
  bot = { id: 'disk', name: 'Disk', rooms: ['boardroom'], maxPerHour: 30 };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('nextLevel hysteresis', () => {
  const c = { warnPercent: 90, criticalPercent: 99, rearmMarginPercent: 1 };
  it('enters at the threshold and leaves only below threshold minus margin', () => {
    expect(nextLevel('ok', 89.9, c)).toBe('ok');
    expect(nextLevel('ok', 90, c)).toBe('warn');
    expect(nextLevel('warn', 89.5, c)).toBe('warn');
    expect(nextLevel('warn', 88.9, c)).toBe('ok');
    expect(nextLevel('warn', 99, c)).toBe('critical');
    expect(nextLevel('critical', 98.2, c)).toBe('critical');
    expect(nextLevel('critical', 97.9, c)).toBe('warn');
    expect(nextLevel('critical', 50, c)).toBe('ok');
    expect(nextLevel('ok', 99.5, c)).toBe('critical');
  });
});

describe('DiskSpaceWatch', () => {
  it('warns once, does not flap near the threshold, posts recovered, and warns again', async () => {
    const w = make();
    await w.init();
    await w.configure(config);
    await step(w, 89);
    await step(w, 91);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('@James ⚠️ Disk warning: Workspace is at 91% used, 90.0 GB free of 1.0 TB.');
    expect(posted[0]).toContain('Top consumers: cases 700 GB, images 120 GB (partial scan, sizes are at least these).');
    expect(posted[0]).toContain('warn 90%, critical 99%');
    for (const p of [89.5, 90.5, 89.2, 91]) await step(w, p);
    expect(posted).toHaveLength(1);
    await step(w, 88);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain('✅ Disk recovered: Workspace is at 88% used');
    await step(w, 92);
    expect(posted).toHaveLength(3);
    expect(posted[2]).toContain('Disk warning');
    expect(pushed).toEqual([]);
  });

  it('posts critical once with a push first, re-arms below critical, and never posts warn and critical together', async () => {
    const w = make();
    await w.init();
    await w.configure(config);
    await step(w, 99.4);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('🛑 Disk critical: Workspace is at 99% used');
    expect(posted[0]).toContain('Writes may start failing.');
    expect(posted[0]).not.toContain('Disk warning');
    expect(pushed).toHaveLength(1);
    await step(w, 99.8);
    expect(posted).toHaveLength(1);
    await step(w, 95);
    expect(posted[1]).toContain('✅ Disk back below critical: Workspace is at 95% used');
    await step(w, 99);
    expect(posted[2]).toContain('Disk critical');
    expect(pushed).toHaveLength(2);
  });

  it('still pushes when the chat post fails, retries the post once, then drops it without wedging', async () => {
    const w = make();
    await w.init();
    await w.configure(config);
    fail = new Error('disk full');
    await step(w, 99.5);
    expect(pushed).toHaveLength(1);
    expect(w.status().pending).toBe('unknown');
    fail = undefined;
    clock += 60_000;
    await w.tick(); // unknown, no matching message: back to prepared once
    await w.tick(); // retried post lands
    expect(posted).toHaveLength(1);
    expect(w.status().pending).toBeUndefined();
    expect(pushed).toHaveLength(1);
    fail = new Error('still full');
    await step(w, 50);
    await w.tick();
    await w.tick();
    await w.tick();
    expect(w.status().pending).toBeUndefined();
    fail = undefined;
    await step(w, 91);
    expect(posted.at(-1)).toContain('Disk warning');
  });

  it('keeps a refused post prepared until the bot may post again', async () => {
    const w = make();
    await w.init();
    await w.configure(config);
    fail = new BotWatchPostRefused('cap');
    await step(w, 92);
    expect(w.status().pending).toBe('prepared');
    fail = undefined;
    await w.tick();
    expect(posted).toHaveLength(1);
  });

  it('does not re-post a raised alarm after a restart', async () => {
    let w = make();
    await w.init();
    await w.configure(config);
    await step(w, 95);
    expect(posted).toHaveLength(1);
    w = make();
    await w.init();
    await step(w, 95);
    await step(w, 96);
    expect(posted).toHaveLength(1);
  });

  it('posts one notice after three failed readings and re-arms it after a good one', async () => {
    let none = true;
    const w = make({ volumes: async () => (none ? null : [volume(percent)]) });
    await w.init();
    await w.configure(config);
    for (let i = 0; i < 5; i++) await step(w, 50);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Disk readings unavailable for 3 checks in a row');
    none = false;
    await step(w, 50);
    none = true;
    for (let i = 0; i < 3; i++) await step(w, 50);
    expect(posted).toHaveLength(2);
  });

  it('reports several volumes in one post, adds host volumes, and never shows a root path', async () => {
    const w = make({
      volumes: async () => [{ ...volume(percent), roots: ['/srv/private/root-path'] }],
      hostVolumes: async () => [volume(92, 'host-images', ['Host images'])],
      consumers: async (v) => ({ entries: [{ name: v.key === 'host-images' ? 'layers/../x' : 'cases', bytes: 5 * GB }], partial: false }),
    });
    await w.init();
    await w.configure(config);
    await step(w, 95);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Workspace is at 95%');
    expect(posted[0]).toContain('Host images is at 92%');
    expect(posted[0]).not.toContain('/srv/private');
    expect(posted[0]).not.toContain('layers/');
    expect(posted[0].length).toBeLessThanOrEqual(1400);
  });

  it('refuses warn at or above critical and a bot that cannot post in the room', async () => {
    const w = make();
    await w.init();
    await expect(w.configure({ ...config, warnPercent: 99 })).rejects.toThrow();
    await expect(w.configure({ ...config, roomId: 'elsewhere' })).rejects.toThrow();
    expect(w.status().config).toBeUndefined();
  });

  it('does nothing while disabled', async () => {
    const w = make();
    await w.init();
    await w.configure({ ...config, enabled: false });
    await step(w, 99.9);
    expect(posted).toEqual([]);
    expect(pushed).toEqual([]);
  });
});

describe('scanConsumers', () => {
  it('sums each child, ranks them, and says partial when a cap stops it', async () => {
    const big = path.join(root, 'scan', 'big');
    await fs.mkdir(path.join(big, 'deep'), { recursive: true });
    await fs.mkdir(path.join(root, 'scan', 'small'));
    await fs.writeFile(path.join(big, 'deep', 'a'), Buffer.alloc(256 * 1024, 1));
    await fs.writeFile(path.join(root, 'scan', 'small', 'b'), Buffer.alloc(8 * 1024, 1));
    await fs.symlink('/', path.join(root, 'scan', 'link'));
    const full = await scanConsumers([path.join(root, 'scan')]);
    expect(full.partial).toBe(false);
    expect(full.entries.map((e) => e.name)).toEqual(['big', 'small']);
    expect(full.entries[0]!.bytes).toBeGreaterThanOrEqual(256 * 1024);
    const capped = await scanConsumers([path.join(root, 'scan')], { maxEntries: 2 });
    expect(capped.partial).toBe(true);
  });

  it('formats bytes in decimal units', () => {
    expect(formatBytes(93 * GB)).toBe('93.0 GB');
    expect(formatBytes(1_800 * GB)).toBe('1.8 TB');
    expect(formatBytes(512)).toBe('512 B');
  });
});
