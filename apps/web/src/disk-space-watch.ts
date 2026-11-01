/** Disk-space alarm: statfs levels per filesystem, posted on change. No shell, host path, model or employee wake. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ChatBot } from './chat-bots.js';
import type { ChatRoom, ChatMessage } from './chatroom-store.js';
import { BotWatchState, BotWatchPostRefused } from './bot-watch-state.js';
import { diskTargets, mountedScratchTargets, probeFilesystem, type DiskTarget } from './disk-stats.js';
import { displayTime } from './display-time.js';

export const DiskSpaceWatchConfig = z
  .object({
    version: z.literal(1),
    type: z.literal('disk-space'),
    enabled: z.boolean(),
    botId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    roomId: z.string().min(1).max(100),
    warnPercent: z.number().int().min(50).max(99),
    criticalPercent: z.number().int().min(51).max(100),
    rearmMarginPercent: z.number().min(0).max(10),
    intervalMinutes: z.number().int().min(1).max(1440),
    mention: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/).optional(),
  })
  .strict()
  .refine((c) => c.warnPercent < c.criticalPercent, 'warnPercent must be below criticalPercent');
type Config = z.infer<typeof DiskSpaceWatchConfig>;
const Level = z.enum(['ok', 'warn', 'critical']);
type Level = z.infer<typeof Level>;
export const DiskSpaceWatchStateSchema = z
  .object({
    version: z.literal(1),
    config: DiskSpaceWatchConfig.optional(),
    volumes: z.record(
      z.string().max(100),
      z.object({ level: Level, since: z.number().int(), labels: z.array(z.string().max(60)).max(8) }).strict()
    ),
    nextPollAt: z.number().int(),
    failures: z.number().int().min(0).max(1000),
    unavailableNoticed: z.boolean(),
    posts: z.array(z.number().int()).max(120),
    pending: z
      .object({
        id: z.string().uuid(),
        text: z.string().max(1500),
        critical: z.boolean(),
        pushed: z.boolean(),
        retried: z.boolean(),
        reservedAt: z.number().int(),
        phase: z.enum(['prepared', 'reserved', 'delivered', 'unknown']),
        messageId: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type State = z.infer<typeof DiskSpaceWatchStateSchema>;

/** One filesystem. `roots` are only for the consumer scan and never appear in a message or status. */
export interface DiskVolume { key: string; labels: string[]; totalBytes: number; availableBytes: number; roots: string[] }
export interface DiskConsumer { name: string; bytes: number }
export interface DiskConsumers { entries: DiskConsumer[]; partial: boolean }
export interface DiskSpaceWatchDeps {
  bot(id: string): ChatBot | undefined;
  room(id: string): ChatRoom | undefined;
  post(bot: ChatBot, roomId: string, text: string, recent: number): ChatMessage;
  /** The website's own filesystems; null when none could be read. */
  volumes?: () => Promise<DiskVolume[] | null>;
  /** Host or shared filesystems the website cannot see, wired by the operator. */
  hostVolumes?: () => Promise<DiskVolume[]>;
  consumers?: (volume: DiskVolume) => Promise<DiskConsumers>;
  /** Owner push (ignores chat quiet); used for critical only. Never throws. */
  push?: (text: string) => Promise<number>;
  timeZone?: () => string | undefined;
  now?: () => number;
}

const MESSAGE_CHARS = 1400;
const FAILED_READS_NOTICE = 3;
/** A consumer name as one plain path segment: no control characters or separators, at most 40 characters. */
const plainName = (name: string) =>
  [...name].filter((ch) => ch.charCodeAt(0) > 31 && ch !== '\u007f' && ch !== '/' && ch !== '\\').join('').slice(0, 40);
const usedPercent = (v: DiskVolume) => (100 * (v.totalBytes - v.availableBytes)) / v.totalBytes;

/** Level with hysteresis: a level is entered at its threshold and left only below threshold - margin. */
export function nextLevel(previous: Level, percent: number, c: Pick<Config, 'warnPercent' | 'criticalPercent' | 'rearmMarginPercent'>): Level {
  if (percent >= c.criticalPercent) return 'critical';
  if (previous === 'critical' && percent >= c.criticalPercent - c.rearmMarginPercent) return 'critical';
  if (percent >= c.warnPercent) return 'warn';
  if (previous !== 'ok' && percent >= c.warnPercent - c.rearmMarginPercent) return 'warn';
  return 'ok';
}
const RANK: Record<Level, number> = { ok: 0, warn: 1, critical: 2 };

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes), unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Bounded consumer scan: sizes of each root's immediate children, same device, symlinks not followed. */
export async function scanConsumers(roots: string[], { deadlineMs = 20_000, maxEntries = 200_000, top = 5, now = Date.now } = {}): Promise<DiskConsumers> {
  const stop = now() + deadlineMs;
  let seen = 0, partial = false;
  const totals = new Map<string, number>();
  for (const root of roots.slice(0, 8)) {
    let device: number;
    try { device = (await fs.lstat(root)).dev; } catch { partial = true; continue; }
    let children: string[];
    try { children = (await fs.readdir(root)).slice(0, 10_000); } catch { partial = true; continue; }
    for (const child of children) {
      const name = basename(child);
      const stack = [join(root, child)];
      let bytes = 0;
      while (stack.length) {
        if (seen >= maxEntries || now() > stop) { partial = true; break; }
        const path = stack.pop()!;
        seen++;
        let info;
        try { info = await fs.lstat(path); } catch { continue; }
        if (info.dev !== device) continue;
        bytes += info.blocks * 512;
        if (info.isDirectory()) {
          try { for (const entry of await fs.readdir(path)) stack.push(join(path, entry)); } catch { partial = true; }
        }
      }
      if (bytes > 0) totals.set(name, (totals.get(name) ?? 0) + bytes);
      if (partial && (seen >= maxEntries || now() > stop)) break;
    }
  }
  const entries = [...totals].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, top);
  return { entries, partial };
}

/** The website's own configured filesystems, deduplicated by device, each probe bounded. */
export async function readWebsiteVolumes(targets?: DiskTarget[], timeoutMs = 2_000): Promise<DiskVolume[] | null> {
  const list = targets ?? [...diskTargets(), ...await mountedScratchTargets(2)];
  const devices = new Map<string, DiskVolume>();
  let read = 0;
  for (const target of list.slice(0, 8)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = await Promise.race([
      probeFilesystem(target.path, target.requireExisting).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!probe || !(probe.blocks > 0) || !(probe.blockSize > 0) || probe.availableBlocks < 0 || probe.availableBlocks > probe.blocks) continue;
    read++;
    const existing = devices.get(probe.device);
    if (existing) {
      if (!existing.labels.includes(target.label)) existing.labels.push(target.label);
      existing.roots.push(target.path);
      continue;
    }
    devices.set(probe.device, {
      key: `dev-${probe.device}`, labels: [target.label], roots: [target.path],
      totalBytes: probe.blocks * probe.blockSize, availableBytes: probe.availableBlocks * probe.blockSize,
    });
  }
  return read ? [...devices.values()] : null;
}

export class DiskSpaceWatch {
  readonly store: BotWatchState<State>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(file: string, private deps: DiskSpaceWatchDeps) {
    this.store = new BotWatchState(file, DiskSpaceWatchStateSchema, {
      version: 1, volumes: {}, nextPollAt: 0, failures: 0, unavailableNoticed: false, posts: [],
    });
  }
  init() { return this.store.init(); }
  status() {
    const s = this.store.snapshot();
    return { config: s.config, volumes: s.volumes, failures: s.failures, pending: s.pending?.phase };
  }
  async configure(raw: unknown, beforeCommit: () => void = () => {}) {
    const cfg = DiskSpaceWatchConfig.parse(raw), bot = this.deps.bot(cfg.botId), room = this.deps.room(cfg.roomId);
    if (!bot || !bot.rooms.includes(cfg.roomId) || !room || room.kind === 'dm' || room.archivedAt)
      throw Error('Allowed ordinary bot room required');
    await this.store.update((s) => { s.config = cfg; s.nextPollAt = 0; }, beforeCommit);
  }
  tick(): Promise<void> {
    const run = this.chain.then(() => this.poll());
    this.chain = run.catch(() => undefined);
    return run;
  }
  private now() { return Math.trunc((this.deps.now ?? Date.now)()); }

  private async readAll(): Promise<DiskVolume[] | null> {
    const own = await (this.deps.volumes ?? readWebsiteVolumes)().catch(() => null);
    const host = this.deps.hostVolumes ? await this.deps.hostVolumes().catch(() => []) : [];
    const valid = [...(own ?? []), ...host].filter((v) =>
      v && typeof v.key === 'string' && v.key.length <= 100 && Number.isSafeInteger(v.totalBytes) && v.totalBytes > 0 &&
      Number.isSafeInteger(v.availableBytes) && v.availableBytes >= 0 && v.availableBytes <= v.totalBytes);
    const byKey = new Map(valid.map((v) => [v.key, v]));
    return byKey.size ? [...byKey.values()].slice(0, 16) : null;
  }

  private async poll() {
    const s = this.store.snapshot(), c = s.config;
    if (!c?.enabled) return;
    if (s.pending) { await this.deliver(); return; }
    if (this.now() < s.nextPollAt) return;
    await this.store.update((x) => { x.nextPollAt = this.now() + c.intervalMinutes * 60_000; });
    const volumes = await this.readAll();
    if (!volumes) {
      const failures = Math.min(1000, s.failures + 1);
      const notice = failures >= FAILED_READS_NOTICE && !s.unavailableNoticed;
      await this.prepare(notice ? [`${this.mention(c)}❔ Disk readings unavailable for ${failures} checks in a row; alarms are paused until a reading succeeds.`] : [], false, (x) => {
        x.failures = failures;
        if (notice) x.unavailableNoticed = true;
      });
      return;
    }
    const lines: string[] = [];
    let critical = false;
    const levels: State['volumes'] = {};
    for (const v of volumes) {
      const percent = usedPercent(v);
      const previous = s.volumes[v.key]?.level ?? 'ok';
      const level = nextLevel(previous, percent, c);
      levels[v.key] = { level, since: level === previous ? s.volumes[v.key]?.since ?? this.now() : this.now(), labels: v.labels.slice(0, 8).map((l) => l.slice(0, 60)) };
      if (level === previous) continue;
      const name = v.labels.join(' / ') || 'Volume';
      const usage = `${Math.floor(percent)}% used, ${formatBytes(v.availableBytes)} free of ${formatBytes(v.totalBytes)}`;
      if (RANK[level] > RANK[previous]) {
        if (level === 'critical') critical = true;
        const top = await this.top(v);
        lines.push(`${level === 'critical' ? '🛑 Disk critical' : '⚠️ Disk warning'}: ${name} is at ${usage}.${top}` +
          (level === 'critical' ? ' Writes may start failing.' : ''));
      } else {
        lines.push(`✅ Disk ${level === 'ok' ? 'recovered' : 'back below critical'}: ${name} is at ${usage}.`);
      }
    }
    const text = lines.length ? [`${this.mention(c)}${lines.join('\n')}`] : [];
    await this.prepare(text, critical, (x) => {
      x.volumes = levels;
      x.failures = 0;
      x.unavailableNoticed = false;
    });
  }

  private mention(c: Config) { return c.mention ? `@${c.mention} ` : ''; }

  private async top(v: DiskVolume): Promise<string> {
    if (!this.deps.consumers && !v.roots.length) return '';
    try {
      const found = await (this.deps.consumers ?? ((x: DiskVolume) => scanConsumers(x.roots)))(v);
      const entries = found.entries.filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.bytes)).slice(0, 5);
      if (!entries.length) return '';
      const list = entries.map((e) => `${plainName(e.name)} ${formatBytes(e.bytes)}`).join(', ');
      return ` Top consumers: ${list}${found.partial ? ' (partial scan, sizes are at least these)' : ''}.`;
    } catch {
      return ' Top consumers: unavailable.';
    }
  }

  /** Levels and the message are saved together before any post; critical pushes first, since chat may not write. */
  private async prepare(lines: string[], critical: boolean, change: (x: State) => void) {
    const c = this.store.snapshot().config!;
    let text = lines.join('\n');
    if (text) {
      text += `\n(${displayTime(this.now(), this.deps.timeZone?.())} · warn ${c.warnPercent}%, critical ${c.criticalPercent}%)`;
      if (text.length > MESSAGE_CHARS) text = text.slice(0, MESSAGE_CHARS - 1) + '…';
    }
    let pushed = false;
    if (text && critical && this.deps.push) {
      await this.deps.push(text.slice(0, 220)).catch(() => 0);
      pushed = true;
    }
    await this.store.update((x) => {
      change(x);
      if (text) x.pending = { id: randomUUID(), text, critical, pushed, retried: false, reservedAt: this.now(), phase: 'prepared' };
    });
    if (text) await this.deliver();
  }

  private async deliver() {
    const s = this.store.snapshot(), c = s.config, p = s.pending;
    if (!c?.enabled || !p) return;
    const b = this.deps.bot(c.botId), r = this.deps.room(c.roomId);
    if (!b || !r || r.archivedAt || r.kind === 'dm' || !b.rooms.includes(r.id)) return;
    if (p.phase === 'reserved' || p.phase === 'unknown') {
      // An interrupted post that landed is adopted, never re-sent. One that did not is retried once, then dropped,
      // so an alarm can never wedge the watch (the level is already saved).
      const matching = r.messages.filter((m) => m.from.kind === 'bot' && m.from.botId === b.id && m.text === p.text && !m.deleted);
      if (matching.length) {
        await this.store.update((x) => { delete x.pending; });
        return;
      }
      if (p.phase === 'reserved') {
        await this.store.update((x) => { x.pending!.phase = 'unknown'; });
        return;
      }
      await this.store.update((x) => {
        if (x.pending!.retried) delete x.pending;
        else { x.pending!.retried = true; x.pending!.phase = 'prepared'; }
      });
      return;
    }
    const posts = s.posts.filter((t) => t > this.now() - 3_600_000);
    if (posts.length >= b.maxPerHour) return;
    await this.store.update((x) => { x.pending!.phase = 'reserved'; x.posts = [...posts, this.now()]; });
    try {
      this.deps.post(b, r.id, p.text, posts.length);
      await this.store.update((x) => { delete x.pending; });
    } catch (error) {
      await this.store.update((x) => { x.pending!.phase = error instanceof BotWatchPostRefused ? 'prepared' : 'unknown'; });
    }
  }
}
