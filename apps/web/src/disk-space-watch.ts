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
    failures: z.number().int().min(0).max(1000),
    unavailableNoticed: z.boolean(),
    posts: z.array(z.number().int()).max(120),
    pending: z
      .object({
        id: z.string().uuid(),
        text: z.string().max(1500),
        retried: z.boolean(),
        reservedAt: z.number().int(),
        phase: z.enum(['prepared', 'reserved', 'delivered', 'unknown']),
        messageId: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    /** Notices raised while a post was in flight; they become the next post. */
    queued: z.string().max(1500).optional(),
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
/** One consumer-scan time budget per reading, shared by all volumes. */
const SCAN_BUDGET_MS = 20_000;
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


/**
 * The watch decides from an in-memory copy of its state, so a failed state write (a full data volume) never stops
 * readings or the critical push; it only loses restart dedup until the process restarts. Chat delivery never gates
 * readings: new notices coalesce into the one pending post.
 */
export class DiskSpaceWatch {
  readonly store: BotWatchState<State>;
  private chain: Promise<unknown> = Promise.resolve();
  private mem!: State;
  private nextPollAt = 0;
  private durable = true;
  /** Volumes whose current critical episode already pushed, for this process. */
  private pushed = new Set<string>();
  constructor(file: string, private deps: DiskSpaceWatchDeps) {
    this.store = new BotWatchState(file, DiskSpaceWatchStateSchema, {
      version: 1, volumes: {}, failures: 0, unavailableNoticed: false, posts: [],
    });
  }
  async init() {
    await this.store.init();
    this.mem = this.store.snapshot();
    // A critical level saved before a restart was already pushed.
    for (const [key, v] of Object.entries(this.mem.volumes)) if (v.level === 'critical') this.pushed.add(key);
  }
  status() {
    const s = this.mem;
    return { config: s.config, volumes: s.volumes, failures: s.failures, pending: s.pending?.phase, durable: this.durable };
  }
  async configure(raw: unknown, beforeCommit: () => void = () => {}) {
    const cfg = DiskSpaceWatchConfig.parse(raw), bot = this.deps.bot(cfg.botId), room = this.deps.room(cfg.roomId);
    if (!bot || !bot.rooms.includes(cfg.roomId) || !room || room.kind === 'dm' || room.archivedAt)
      throw Error('Allowed ordinary bot room required');
    await this.store.update((s) => { s.config = cfg; }, beforeCommit);
    this.mem.config = cfg;
    this.nextPollAt = 0;
  }
  tick(): Promise<void> {
    const run = this.chain.then(() => this.poll());
    this.chain = run.catch(() => undefined);
    return run;
  }
  private now() { return Math.trunc((this.deps.now ?? Date.now)()); }

  /** Best-effort save of the in-memory state; a failure degrades only restart dedup. */
  private async save() {
    if (!this.durable) return;
    const next = structuredClone(this.mem);
    try {
      await this.store.update((x) => { Object.assign(x, next); });
    } catch {
      this.durable = false;
      console.warn('[disk-space-watch] state not saved; alarms continue from memory');
    }
  }

  private async readAll(): Promise<DiskVolume[] | null> {
    const own = await (this.deps.volumes ?? readWebsiteVolumes)().catch(() => null);
    // Host keys are namespaced so an operator-supplied key can never replace a website filesystem.
    const host = this.deps.hostVolumes
      ? (await this.deps.hostVolumes().catch(() => [])).map((v) => ({ ...v, key: `host:${String(v?.key)}`.slice(0, 100) }))
      : [];
    const valid = [...(own ?? []), ...host].filter((v) =>
      v && typeof v.key === 'string' && v.key.length <= 100 && Number.isSafeInteger(v.totalBytes) && v.totalBytes > 0 &&
      Number.isSafeInteger(v.availableBytes) && v.availableBytes >= 0 && v.availableBytes <= v.totalBytes);
    const byKey = new Map(valid.map((v) => [v.key, v]));
    return byKey.size ? [...byKey.values()].slice(0, 16) : null;
  }

  private async poll() {
    const c = this.mem.config;
    if (!c?.enabled) return;
    if (this.now() >= this.nextPollAt) {
      this.nextPollAt = this.now() + c.intervalMinutes * 60_000;
      await this.read(c);
    }
    await this.deliver();
  }

  private async read(c: Config) {
    const s = this.mem;
    const volumes = await this.readAll();
    if (!volumes) {
      s.failures = Math.min(1000, s.failures + 1);
      if (s.failures >= FAILED_READS_NOTICE && !s.unavailableNoticed) {
        s.unavailableNoticed = true;
        this.queue([`❔ Disk readings unavailable for ${s.failures} checks in a row; alarms are paused until a reading succeeds.`], c);
      }
      await this.save();
      return;
    }
    s.failures = 0;
    s.unavailableNoticed = false;
    const lines: string[] = [], critical: string[] = [];
    const levels: State['volumes'] = {};
    const scanStop = this.now() + SCAN_BUDGET_MS;
    for (const v of volumes) {
      const percent = usedPercent(v);
      const previous = s.volumes[v.key]?.level ?? 'ok';
      const level = nextLevel(previous, percent, c);
      levels[v.key] = { level, since: level === previous ? s.volumes[v.key]?.since ?? this.now() : this.now(), labels: v.labels.slice(0, 8).map((l) => l.slice(0, 60)) };
      if (level !== 'critical') this.pushed.delete(v.key);
      if (level === previous) continue;
      const name = v.labels.join(' / ') || 'Volume';
      const usage = `${Math.floor(percent)}% used, ${formatBytes(v.availableBytes)} free of ${formatBytes(v.totalBytes)}`;
      if (RANK[level] > RANK[previous]) {
        const line = `${level === 'critical' ? '🛑 Disk critical' : '⚠️ Disk warning'}: ${name} is at ${usage}.`;
        if (level === 'critical' && !this.pushed.has(v.key)) critical.push(line);
        lines.push(line + await this.top(v, scanStop) + (level === 'critical' ? ' Writes may start failing.' : ''));
      } else {
        lines.push(`✅ Disk ${level === 'ok' ? 'recovered' : 'back below critical'}: ${name} is at ${usage}.`);
      }
    }
    s.volumes = levels;
    // The push needs no disk and no chat, so it goes before any state write and whether or not chat can post.
    if (critical.length && this.deps.push) {
      await this.deps.push(critical.join(' ').slice(0, 220)).catch(() => 0);
      for (const v of volumes) if (levels[v.key]?.level === 'critical') this.pushed.add(v.key);
    }
    if (lines.length) this.queue(lines, c);
    await this.save();
  }

  private mention(c: Config) { return c.mention ? `@${c.mention} ` : ''; }

  private async top(v: DiskVolume, stop: number): Promise<string> {
    if (!this.deps.consumers && !v.roots.length) return '';
    const left = stop - this.now();
    if (left <= 0) return ' Top consumers: not scanned (time budget used).';
    try {
      const found = await (this.deps.consumers ?? ((x: DiskVolume) => scanConsumers(x.roots, { deadlineMs: left, now: () => this.now() })))(v);
      const entries = found.entries.filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.bytes)).slice(0, 5);
      if (!entries.length) return '';
      const list = entries.map((e) => `${plainName(e.name)} ${formatBytes(e.bytes)}`).join(', ');
      return ` Top consumers: ${list}${found.partial ? ' (partial scan, sizes are at least these)' : ''}.`;
    } catch {
      return ' Top consumers: unavailable.';
    }
  }

  /** New notices join the one pending post (bounded) rather than waiting behind it. */
  private queue(lines: string[], c: Config) {
    const s = this.mem;
    const stamp = `(${displayTime(this.now(), this.deps.timeZone?.())} · warn ${c.warnPercent}%, critical ${c.criticalPercent}%)`;
    const body = lines.join('\n');
    // A post in flight (reserved or unknown) is settled first; new notices wait in `queued` until then.
    const inFlight = !!s.pending && s.pending.phase !== 'prepared';
    const base = inFlight ? s.queued : s.pending?.text;
    const text = this.join(base, `${this.mention(c)}${body}\n${stamp}`);
    if (inFlight) s.queued = text;
    else s.pending = { id: randomUUID(), text, retried: false, reservedAt: this.now(), phase: 'prepared' };
  }

  private async deliver() {
    const s = this.mem, c = s.config, p = s.pending;
    if (!c?.enabled || !p) return;
    const b = this.deps.bot(c.botId), r = this.deps.room(c.roomId);
    if (!b || !r || r.archivedAt || r.kind === 'dm' || !b.rooms.includes(r.id)) {
      // The bot can no longer post here: drop the notices (any critical push already went) rather than wedge.
      delete s.pending;
      delete s.queued;
      await this.save();
      return;
    }
    if (p.phase === 'reserved' || p.phase === 'unknown') {
      // An interrupted post that landed is adopted, never re-sent. One that did not is retried once, then dropped.
      const landed = r.messages.some((m) => m.from.kind === 'bot' && m.from.botId === b.id && m.text === p.text && !m.deleted);
      if (landed || (p.phase === 'unknown' && p.retried)) delete s.pending;
      else if (p.phase === 'reserved') p.phase = 'unknown';
      else { p.retried = true; p.phase = 'prepared'; }
      this.promote();
      await this.save();
      if (s.pending?.phase !== 'prepared') return;
    }
    const posts = s.posts.filter((t) => t > this.now() - 3_600_000);
    if (posts.length >= b.maxPerHour) return;
    const pending = s.pending!;
    pending.phase = 'reserved';
    s.posts = [...posts, this.now()];
    await this.save();
    try {
      this.deps.post(b, r.id, pending.text, posts.length);
      delete s.pending;
    } catch (error) {
      pending.phase = error instanceof BotWatchPostRefused ? 'prepared' : 'unknown';
    }
    this.promote();
    await this.save();
  }

  /** Earlier text plus a new notice, one mention, bounded: when too long the newest notice wins. */
  private join(earlier: string | undefined, next: string): string {
    if (!earlier) return next.slice(0, MESSAGE_CHARS);
    const mention = this.mem.config ? this.mention(this.mem.config) : '';
    const bare = next.startsWith(mention) ? next.slice(mention.length) : next;
    const text = `${earlier}\n${bare}`;
    return text.length <= MESSAGE_CHARS ? text : `${mention}…earlier notices omitted\n${bare}`.slice(0, MESSAGE_CHARS);
  }

  /** Notices queued while a post was in flight join, or become, the next pending post. */
  private promote() {
    const s = this.mem;
    if (!s.queued) return;
    if (!s.pending) s.pending = { id: randomUUID(), text: s.queued, retried: false, reservedAt: this.now(), phase: 'prepared' };
    else if (s.pending.phase === 'prepared') s.pending.text = this.join(s.pending.text, s.queued);
    else return;
    delete s.queued;
  }
}
