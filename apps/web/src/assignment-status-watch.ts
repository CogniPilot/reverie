/** Typed assignment check-ins. No model, shell, employee wake, permission grant or completion inference. */
import { createHash, randomUUID } from 'node:crypto';
import { displayTime, displayTimeZone, offsetTimestamp, parseOffsetTimestamp } from './display-time.js';
import { z } from 'zod';
import type { ChatBot } from './chat-bots.js';
import type { BoardStore } from './board-store.js';
import type { Issue } from './board-types.js';
import { MAX_MESSAGE_CHARS, type ChatMessage, type ChatRoom } from './chatroom-store.js';
import { BotWatchState, BotWatchPostRefused } from './bot-watch-state.js';

export const AssignmentWatchConfig = z
  .object({
    version: z.literal(1),
    type: z.literal('assignment-status'),
    enabled: z.boolean(),
    botId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    roomIds: z.array(z.string().min(1).max(100)).min(1).max(20),
    intervalMinutes: z.number().int().min(15).max(10080),
    responseMinutes: z.number().int().min(5).max(1440),
  })
  .strict();
const response = z
  .object({
    messageId: z.string().max(100),
    at: z.number().int(),
    status: z.enum(['on-track', 'new-eta', 'blocked']),
    reason: z.string().max(500),
    extendUntil: z.number().int().optional(),
    applied: z.boolean().default(false),
    planApplied: z.boolean().default(false),
    ackAttempted: z.boolean().optional(),
    priorEnd: z.number().int().optional(),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    withdrawn: z.literal(true).optional(),
  })
  .strict();
const checkin = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().max(64),
    employeeId: z.string().max(100),
    sessionId: z.string().max(100),
    generation: z.number().int(),
    roomId: z.string().max(100),
    owner: z.string().optional(),
    createdAt: z.number().int(),
    deadline: z.number().int(),
    askedAt: z.number().int().optional(),
    responseWindowMs: z.number().int().positive().optional(),
    suspendedAt: z.number().int().optional(),
    suspendedMs: z.number().int().optional(),
    originalEnd: z.number().int().optional(),
    priorStatus: z.string().max(20),
    phase: z.enum(['reserved', 'asked', 'not-delivered', 'unknown', 'answered', 'cancelled']),
    promptId: z.string().max(100).optional(),
    response: response.optional(),
    history: z.array(response).max(100).default([]),
    attentionPending: z.boolean().default(false),
    attentionId: z.string().max(64).optional(),
    notifiedManager: z.string().max(100).optional(),
  })
  .strict();
export const AssignmentWatchStateSchema = z
  .object({
    version: z.literal(1),
    config: AssignmentWatchConfig.optional(),
    entries: z.array(checkin).max(4000),
    lastTickAt: z.number().int().optional(),
    posts: z.array(z.number().int()).max(120),
  })
  .strict();
type Entry = z.infer<typeof checkin>;
export interface AssignmentEmployee {
  id: string;
  name: string;
  owner?: string;
  sessionId: string;
  sessionGeneration: number;
  desiredRunning?: boolean;
  onVacation: boolean;
  bindingMigration?: unknown;
  reportsTo?: string;
}
export interface AssignmentWatchDeps {
  board: BoardStore;
  employees(): readonly AssignmentEmployee[];
  timeZone?(owner: string | undefined): string | undefined;
  running(sessionId: string): boolean;
  bot(id: string): ChatBot | undefined;
  room(id: string): ChatRoom | undefined;
  /** Must use current permission + phone policy; returns false for unknown delivery eligibility. */
  canDeliver(sessionId: string, roomId: string): boolean;
  canEdit(employeeId: string): boolean;
  coordinatorId?(owner: string | undefined): string | undefined;
  post(bot: ChatBot, roomId: string, text: string, recipients: string[], recent: number): ChatMessage;
  delivered(sessionId: string, roomId: string, messageId: string): boolean;
  audit(entry: Record<string, unknown>): Promise<void>;
  now?: () => number;
}
const ended = (issue: Issue) => issue.status === 'done' || issue.status === 'wontdo';
const attentionId = (id: string) => 'attention-' + createHash('sha256').update(id).digest('hex').slice(0, 24);
const marker = (entry: Entry) => `[assignment-checkin:${entry.id}]`;
const safeName = (s: string) => s.replace(/[@\r\n`<>]/g, '').slice(0, 80);
/** Why an attention item exists, said with the assignee's name: the manager is not the one who was asked. */
const escalationReason = (entry: Entry) =>
  entry.response?.status === 'blocked' ? 'reported Blocked on'
    : entry.response?.status === 'new-eta' ? 'gave a new ETA that is not on the Board yet for'
      : 'did not answer the status check-in in time for';
/** Why this reader gets it: the assignee's listed manager, the coordinator standing in for one, or the owner. */
const escalationRole = (employee: AssignmentEmployee, manager: AssignmentEmployee | undefined) =>
  !manager ? `no manager is set for ${safeName(employee.name)}`
    : employee.reportsTo === manager.id ? `you are listed as ${safeName(employee.name)}'s manager`
      : `you coordinate ${safeName(employee.name)}'s work; no manager is set`;
// Board reasons stay bounded; the exact explanation remains in its correlated
// source message, whose current identity/content digest is checked before use.
const boardReason = (messageId: string, reason: string, prefix = '') => {
  const text = prefix + reason;
  return text.length <= 500
    ? text
    : `${prefix}Read the full explanation in correlated assignee reply ${messageId} (${reason.length} characters).`;
};

export class AssignmentStatusWatch {
  readonly store: BotWatchState<z.infer<typeof AssignmentWatchStateSchema>>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    file: string,
    private deps: AssignmentWatchDeps
  ) {
    this.store = new BotWatchState(file, AssignmentWatchStateSchema, { version: 1, entries: [], posts: [] });
  }
  init() {
    return this.store.init();
  }
  status() {
    const state = this.store.snapshot();
    const config = state.config;
    const gaps: { taskId: string; reason: string }[] = [];
    let eligible = 0;
    for (const task of this.deps.board.snapshot().issues) {
      if (
        ended(task) ||
        !task.owner ||
        !['doing', 'blocked'].includes(task.status) ||
        task.tags.includes('assignment-attention')
      )
        continue;
      const employee = this.deps.employees().find((e) => e.id === task.owner);
      if (!employee || !this.active(employee)) {
        gaps.push({ taskId: task.id, reason: 'assignee-off-vacation-migrating-or-not-running' });
        continue;
      }
      const room = config?.roomIds
        .map((id) => this.roomFor(task, employee, id))
        .find((r) => r && this.deps.canDeliver(employee.sessionId, r.id));
      if (!room) {
        gaps.push({ taskId: task.id, reason: 'no-allowed-private-source-room-or-phone-delivery' });
        continue;
      }
      eligible++;
    }
    return {
      ...state,
      coverage: { eligible, gaps },
      pending: state.entries
        .filter((e) => ['asked', 'reserved', 'unknown'].includes(e.phase))
        .map((e) => ({
          taskId: e.taskId,
          employeeId: e.employeeId,
          ageMs: Math.max(0, this.now() - e.createdAt),
          deadline: e.deadline,
          phase: e.phase,
        })),
      scheduleAssurance:
        'Fair per-task queue; interval is a minimum cooldown, not a delivery SLA; bot cap and phone/privacy gates take precedence.',
      assurance: 'typed-checkin-and-self-report-only' as const,
    };
  }
  async configure(raw: unknown) {
    const config = AssignmentWatchConfig.parse(raw);
    const bot = this.deps.bot(config.botId);
    if (
      config.enabled &&
      (!bot ||
        config.roomIds.some(
          (id) => !bot.rooms.includes(id) || !this.deps.room(id) || this.deps.room(id)?.kind === 'dm'
        ))
    )
      throw Error('Bot and ordinary allowed rooms required');
    await this.store.update((s) => {
      s.config = config;
      if (!config.enabled)
        for (const e of s.entries)
          if (e.phase === 'asked' && !e.response && e.suspendedAt === undefined) e.suspendedAt = this.now();
    });
  }
  tick(): Promise<void> {
    const run = this.chain.then(() => this.run());
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async audit(value: Record<string, unknown>) {
    if (!this.enabled()) throw Error('Automation disabled');
    await this.deps.audit(value);
    if (!this.enabled()) throw Error('Automation disabled before Board commit');
    if (value.action === 'assignment-attention-opened' || value.action === 'assignment-attention-manager-updated') {
      const entry = this.store.snapshot().entries.find((e) => e.id === value.checkinId);
      if (!entry || !this.routingCurrent(entry, value.managerId as string | undefined))
        throw Error('Reporting route changed before Board commit');
    }
  }
  private enabled() {
    return this.store.snapshot().config?.enabled === true;
  }
  private post(bot: ChatBot, roomId: string, text: string, recipients: string[], recent: number) {
    const config = this.store.snapshot().config;
    const current = config && this.deps.bot(config.botId);
    if (
      !config?.enabled ||
      config.botId !== bot.id ||
      !config.roomIds.includes(roomId) ||
      !current ||
      !current.rooms.includes(roomId)
    )
      throw new BotWatchPostRefused('Current bot policy refused');
    return this.deps.post(current, roomId, text, recipients, recent);
  }
  private now() {
    return Math.trunc((this.deps.now ?? Date.now)());
  }
  private current(entry: Entry, observed?: ReadonlyMap<string, Issue>) {
    const task = observed
      ? observed.get(entry.taskId)
      : this.deps.board.snapshot().issues.find((t) => t.id === entry.taskId);
    const employee = this.deps.employees().find((e) => e.id === entry.employeeId);
    if (
      !task ||
      !employee ||
      task.owner !== employee.id ||
      employee.sessionId !== entry.sessionId ||
      employee.sessionGeneration !== entry.generation ||
      employee.owner !== entry.owner
    )
      return undefined;
    return { task, employee };
  }
  private active(e: AssignmentEmployee) {
    return e.desiredRunning !== false && !e.onVacation && !e.bindingMigration && this.deps.running(e.sessionId);
  }
  private roomFor(task: Issue, employee: AssignmentEmployee, roomId: string) {
    const room = this.deps.room(roomId);
    if (
      !room ||
      room.kind === 'dm' ||
      room.archivedAt ||
      room.owner !== employee.owner ||
      !room.members.some((m) => m.sessionId === employee.sessionId)
    )
      return undefined;
    // An assignment originating in another private room is never copied out of it.
    if (task.source && task.source.roomId !== roomId) return undefined;
    return room;
  }
  private async save(entry: Entry) {
    await this.store.update((s) => {
      const i = s.entries.findIndex((e) => e.id === entry.id);
      if (i < 0) s.entries.push(entry);
      else s.entries[i] = entry;
    });
  }
  /** Only the typed pre-post refusal proves that this attempt had no chat effect. */
  private async saveRefusedPost(entry: Entry, reservation: readonly number[]) {
    await this.store.update((s) => {
      const i = s.entries.findIndex((e) => e.id === entry.id);
      if (i < 0) s.entries.push(entry);
      else s.entries[i] = entry;
      // Ticks serialize quota writers; configure does not change posts. Match the
      // entire reserved array before removing only our appended slot, including
      // when earlier attempts have the same timestamp. Unexpected drift retains
      // quota conservatively rather than releasing somebody else's reservation.
      if (s.posts.length === reservation.length && s.posts.every((t, n) => t === reservation[n]))
        s.posts.pop();
    });
  }
  private async run() {
    let state = this.store.snapshot();
    const cfg = state.config;
    if (!cfg?.enabled) return;
    const bot = this.deps.bot(cfg.botId);
    if (!bot) {
      await this.store.update((s) => {
        for (const e of s.entries)
          if (e.phase === 'asked' && !e.response && e.suspendedAt === undefined) e.suspendedAt = this.now();
      });
      return;
    }
    await this.store.update((s) => {
      s.lastTickAt = this.now();
    });
    const observedTasks = new Map(this.deps.board.snapshot().issues.map((t) => [t.id, t]));
    for (const saved of state.entries) {
      const entry = structuredClone(saved);
      const current = this.current(entry, observedTasks);
      if (!current || ended(current.task)) {
        if (entry.phase !== 'cancelled') {
          entry.phase = 'cancelled';
          await this.save(entry);
        }
        await this.resolveAttention(
          entry,
          !current ? 'Assignment changed; check-in cancelled' : 'Assigned work completed'
        );
        continue;
      }
      const room = this.roomFor(current.task, current.employee, entry.roomId);
      const receivable =
        !!room &&
        bot.rooms.includes(room.id) &&
        this.active(current.employee) &&
        this.deps.canDeliver(entry.sessionId, entry.roomId);
      if (entry.phase === 'asked' && !entry.response) {
        if (!receivable && entry.suspendedAt === undefined) {
          entry.suspendedAt = this.now();
          await this.save(entry);
        } else if (receivable && entry.suspendedAt !== undefined) {
          const paused = Math.max(0, this.now() - entry.suspendedAt);
          entry.deadline += paused;
          entry.suspendedMs = (entry.suspendedMs ?? 0) + paused;
          delete entry.suspendedAt;
          await this.save(entry);
        }
      }
      if (!room || !bot.rooms.includes(room.id) || !this.active(current.employee)) continue;
      if (entry.phase === 'reserved' || entry.phase === 'unknown') {
        const matches = room.messages.filter(
          (m) => m.from.kind === 'bot' && m.from.botId === bot.id && m.text.includes(marker(entry)) && !m.deleted
        );
        if (matches.length !== 1) {
          if (entry.phase !== 'unknown') {
            entry.phase = 'unknown';
            await this.save(entry);
          }
          continue;
        }
        entry.promptId = matches[0]!.id;
        this.stampAsked(entry, matches[0]!);
        entry.phase = this.deps.delivered(entry.sessionId, room.id, entry.promptId) ? 'asked' : 'not-delivered';
        await this.save(entry);
      }
      if (entry.promptId && (entry.phase === 'asked' || entry.phase === 'answered')) {
        const replies = room.messages
          .filter(
            (m) =>
              m.replyTo === entry.promptId &&
              !m.deleted &&
              !m.edited &&
              m.at >= entry.createdAt &&
              (!entry.response || m.at > entry.response.at)
          )
          .sort((a, b) => a.at - b.at);
        for (const message of replies) {
          const parsed = this.parseReply(entry, message);
          if (!parsed) continue;
          if (entry.response) {
            if (entry.history.length >= 100) throw Error('Check-in response history full');
            entry.history.push(entry.response);
          }
          entry.response = { ...parsed, sourceDigest: this.replyDigest(entry, message) };
          entry.phase = 'answered';
          await this.save(entry);
          break;
        }
      }
      if (entry.response && !entry.response.applied) await this.applyResponse(entry);
      if (entry.response && (entry.response.withdrawn || !this.responseCurrent(entry))) {
        if (!entry.response.withdrawn) {
          entry.response.withdrawn = true;
          await this.save(entry);
        }
        continue;
      }
      if (entry.response?.applied) await this.acknowledge(entry, bot);
      if (
        entry.response?.applied &&
        !entry.response.withdrawn &&
        this.responseCurrent(entry) &&
        entry.response.status !== 'blocked' &&
        (entry.response.status !== 'new-eta' || entry.response.planApplied)
      )
        await this.resolveAttention(entry, 'Assignee answered check-in');
      else if (
        entry.phase === 'asked' &&
        this.now() >= entry.deadline &&
        this.deps.canDeliver(entry.sessionId, room.id)
      )
        await this.escalate(entry, bot, current.task, current.employee);
      else if (
        entry.response?.status === 'blocked' ||
        (entry.response?.status === 'new-eta' && !entry.response.planApplied)
      )
        await this.escalate(entry, bot, current.task, current.employee);
    }
    state = this.store.snapshot();
    if (state.entries.length >= 1000) {
      const latest = new Map<string, Entry>();
      for (const e of state.entries) {
        if (!latest.has(e.taskId) || latest.get(e.taskId)!.createdAt < e.createdAt) latest.set(e.taskId, e);
      }
      const candidates = state.entries
        .filter(
          (e) =>
            latest.get(e.taskId)?.id !== e.id &&
            !e.attentionPending &&
            (['cancelled', 'not-delivered'].includes(e.phase) || (e.phase === 'answered' && e.response?.applied))
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      const archived = candidates.slice(0, Math.max(0, state.entries.length - 500));
      if (archived.length) {
        await this.store.archive(archived);
        const ids = new Set(archived.map((e) => e.id));
        await this.store.update((s) => {
          s.entries = s.entries.filter((e) => !ids.has(e.id));
        });
        state = this.store.snapshot();
      }
    }
    const askedAt = new Map<string, number>();
    for (const e of state.entries) askedAt.set(e.taskId, Math.max(askedAt.get(e.taskId) ?? -1, e.createdAt));
    const lastAsked = (id: string) => askedAt.get(id) ?? -1;
    const queue = this.deps.board
      .snapshot()
      .issues.sort(
        (a, b) => lastAsked(a.id) - lastAsked(b.id) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      );
    for (const task of queue) {
      if (
        ended(task) ||
        !task.owner ||
        task.tags.includes('assignment-attention') ||
        !['doing', 'blocked'].includes(task.status)
      )
        continue;
      const employee = this.deps.employees().find((e) => e.id === task.owner);
      if (!employee || !this.active(employee)) continue;
      if (
        this.store
          .snapshot()
          .entries.some(
            (e) =>
              e.employeeId === employee.id && ['reserved', 'asked', 'unknown'].includes(e.phase) && !e.attentionPending
          )
      )
        continue;
      const previous = state.entries.filter((e) => e.taskId === task.id).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (previous?.response && !previous.response.applied) continue;
      if (
        previous &&
        (!['answered', 'cancelled', 'not-delivered'].includes(previous.phase) ||
          previous.attentionPending ||
          this.now() < previous.createdAt + cfg.intervalMinutes * 60000)
      )
        continue;
      if (state.entries.length >= 4000) throw Error('Assignment history full; preserved, no eviction');
      const room = cfg.roomIds
        .map((id) => this.roomFor(task, employee, id))
        .find((r) => r && bot.rooms.includes(r.id) && this.deps.canDeliver(employee.sessionId, r.id));
      if (!room) continue;
      const at = this.now();
      const recent = this.store.snapshot().posts.filter((t) => t > at - 3600000);
      if (recent.length >= bot.maxPerHour) return;
      const reservation = [...recent, at];
      const entry: Entry = {
        id: randomUUID(),
        taskId: task.id,
        employeeId: employee.id,
        sessionId: employee.sessionId,
        generation: employee.sessionGeneration,
        roomId: room.id,
        owner: employee.owner,
        createdAt: at,
        deadline: at + cfg.responseMinutes * 60000,
        responseWindowMs: cfg.responseMinutes * 60000,
        originalEnd: task.end,
        priorStatus: task.status,
        phase: 'reserved',
        history: [],
        attentionPending: false,
      };
      await this.store.update((s) => {
        s.entries.push(entry);
        s.posts = reservation;
      }); // Durable quota + attempt before chat IO.
      try {
        const fresh = this.current(entry);
        if (
          !fresh ||
          !this.active(fresh.employee) ||
          !this.roomFor(fresh.task, fresh.employee, room.id) ||
          !this.deps.canDeliver(employee.sessionId, room.id)
        ) {
          entry.phase = 'cancelled';
          await this.save(entry);
          continue;
        }
        const zone = displayTimeZone(this.deps.timeZone?.(employee.owner));
        const text = `${marker(entry)} ${safeName(employee.name)}: status for assigned Board task ${task.id}? Reply directly to this message with On track (optionally ': reason'), New ETA: ISO timestamp with offset | reason (example ${offsetTimestamp(entry.deadline, zone)}; legacy Z accepted), or Blocked: reason. Due ${displayTime(entry.deadline, zone)} (${zone}). This does not mark the work complete.`;
        const message = this.post(bot, room.id, text, [employee.sessionId], recent.length);
        entry.promptId = message.id;
        this.stampAsked(entry, message);
        entry.phase = this.deps.delivered(employee.sessionId, room.id, message.id) ? 'asked' : 'not-delivered';
        await this.save(entry);
      } catch (error) {
        entry.phase = error instanceof BotWatchPostRefused ? 'not-delivered' : 'unknown';
        if (error instanceof BotWatchPostRefused) await this.saveRefusedPost(entry, reservation);
        else await this.save(entry);
      }
    }
  }
  private replyDigest(entry: Entry, message: ChatMessage) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          id: message.id,
          replyTo: message.replyTo,
          from: message.from,
          text: message.text,
          at: message.at,
          deleted: message.deleted,
          edited: message.edited,
          employeeId: entry.employeeId,
          sessionId: entry.sessionId,
          generation: entry.generation,
          roomId: entry.roomId,
          owner: entry.owner,
        })
      )
      .digest('hex');
  }
  private responseCurrent(entry: Entry) {
    const current = this.current(entry),
      response = entry.response;
    if (!current || !response?.sourceDigest) return false;
    const config = this.store.snapshot().config,
      bot = config && this.deps.bot(config.botId);
    if (!config?.enabled || !config.roomIds.includes(entry.roomId) || !bot || !bot.rooms.includes(entry.roomId))
      return false;
    const room = this.roomFor(current.task, current.employee, entry.roomId),
      message = room?.messages.find((m) => m.id === response.messageId),
      prompt = room?.messages.find((m) => m.id === entry.promptId);
    if (!prompt || prompt.deleted || prompt.edited || prompt.from.kind !== 'bot' || prompt.from.botId !== config.botId)
      return false;
    return (
      !!message &&
      !message.deleted &&
      !message.edited &&
      message.replyTo === entry.promptId &&
      message.from.kind === 'agent' &&
      message.from.sessionId === current.employee.sessionId &&
      message.from.employeeId === current.employee.id &&
      this.replyDigest(entry, message) === response.sourceDigest
    );
  }
  private stampAsked(entry: Entry, message: ChatMessage) {
    if (!Number.isSafeInteger(message.at) || message.at < entry.createdAt || message.at > this.now() + 1000)
      throw Error('Durable prompt timestamp differs');
    const window = entry.responseWindowMs ?? entry.deadline - entry.createdAt;
    if (window < 300000 || window > 86400000) throw Error('Reply window differs');
    entry.askedAt = message.at;
    entry.responseWindowMs = window;
    entry.deadline = message.at + window;
  }
  private parseReply(entry: Entry, m: ChatMessage): Entry['response'] | undefined {
    const current = this.current(entry);
    if (
      !current ||
      m.from.kind !== 'agent' ||
      m.from.sessionId !== current.employee.sessionId ||
      m.from.employeeId !== current.employee.id ||
      m.at > this.now() + 1000 ||
      m.text.length > MAX_MESSAGE_CHARS
    )
      return;
    const text = m.text.trim();
    // Keep the typed status at the start, but retain a source-slice qualifier.
    // Existing direct replies also use "On track for ..."; these are not missing
    // responses simply because they explain the scope of their progress.
    const onTrack = /^on track(?:[.!]?|:\s*(\S[\s\S]*)|\s+(for\s+\S[\s\S]*))$/i.exec(text);
    if (onTrack)
      return {
        messageId: m.id,
        at: m.at,
        status: 'on-track',
        reason: boardReason(m.id, (onTrack[1] ?? onTrack[2] ?? '').trim()),
        applied: false,
        planApplied: false,
      };
    const blocked = /^blocked:\s*([\s\S]+)$/i.exec(text);
    if (blocked && blocked[1]!.trim())
      return {
        messageId: m.id,
        at: m.at,
        status: 'blocked',
        reason: boardReason(m.id, blocked[1]!.trim()),
        applied: false,
        planApplied: false,
      };
    const eta = /^new eta:\s*(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d))\s*\|\s*([\s\S]+)$/i.exec(text);
    const etaAt = eta ? parseOffsetTimestamp(eta[1]!) : undefined;
    if (
      eta &&
      eta[2]!.trim() &&
      etaAt !== undefined &&
      etaAt > this.now() &&
      etaAt > (current.task.end ?? 0)
    )
      return {
        messageId: m.id,
        at: m.at,
        status: 'new-eta',
        reason: boardReason(m.id, eta[2]!.trim()),
        extendUntil: etaAt,
        priorEnd: current.task.end,
        applied: false,
        planApplied: false,
      };
    return undefined;
  }
  private async applyResponse(entry: Entry) {
    const response = entry.response!;
    const current = this.current(entry);
    if (!current || ended(current.task) || !this.enabled()) return;
    if (!this.responseCurrent(entry)) {
      response.withdrawn = true;
      await this.save(entry);
      return;
    }
    // A scoped progress report records a response, not whole-task readiness.
    // Keep the existing bare-form policy; qualifiers must not clear a blocker,
    // change the task status/reason/dates, or touch its updatedAt timestamp.
    if (this.deps.canEdit(current.employee.id) && !(response.status === 'on-track' && response.reason.length > 0)) {
      let planApplied = false;
      await this.deps.board.update(
        {
          beforeSave: async () => {
            if (!this.current(entry) || !this.deps.canEdit(entry.employeeId))
              throw Error('Current assignment/grant changed');
            await this.audit({
              action: 'assignment-checkin-response',
              by: `agent:${entry.employeeId}`,
              checkinId: entry.id,
              taskId: entry.taskId,
              originalEnd: entry.originalEnd,
              response,
            });
            if (!this.responseCurrent(entry)) throw Error('Canonical check-in reply withdrawn or edited');
            if (!this.enabled() || !this.current(entry) || !this.deps.canEdit(entry.employeeId))
              throw Error('Current assignment or automation grant revoked');
          },
        },
        (s) => {
          const task = s.issues.find((t) => t.id === entry.taskId);
          if (!task || task.owner !== entry.employeeId || ended(task)) throw Error('Assignment changed');
          if (response.status === 'new-eta') {
            if (task.end !== response.priorEnd && task.end !== response.extendUntil)
              throw Error('Plan changed; response requires new review');
            task.end = response.extendUntil;
            task.reason = response.reason;
            planApplied = true;
          } else if (response.status === 'blocked') {
            task.status = 'blocked';
            task.reason = response.reason;
          } else if (task.status === 'blocked') {
            task.status = 'doing';
            delete task.reason;
          }
          task.updatedAt = this.now();
        }
      );
      response.planApplied = planApplied;
    }
    response.applied = true;
    await this.save(entry);
  }
  private async acknowledge(entry: Entry, bot: ChatBot) {
    const response = entry.response!;
    if (response.ackAttempted || response.withdrawn) return;
    if (!this.responseCurrent(entry)) {
      response.withdrawn = true;
      await this.save(entry);
      return;
    }
    const current = this.current(entry);
    if (
      !current ||
      !this.active(current.employee) ||
      !this.roomFor(current.task, current.employee, entry.roomId) ||
      !this.deps.canDeliver(entry.sessionId, entry.roomId)
    )
      return;
    const at = this.now(),
      recent = this.store.snapshot().posts.filter((t) => t > at - 3600000);
    if (recent.length >= bot.maxPerHour) return;
    const reservation = [...recent, at];
    response.ackAttempted = true;
    await this.store.update((s) => {
      s.entries[s.entries.findIndex((e) => e.id === entry.id)] = entry;
      s.posts = reservation;
    });
    try {
      if (!this.responseCurrent(entry)) {
        response.withdrawn = true;
        await this.save(entry);
        return;
      }
      this.post(
        bot,
        entry.roomId,
        `[assignment-response:${entry.id}] Recorded ${response.status} for task ${entry.taskId}.${response.status === 'on-track' && response.reason ? ' Scoped progress recorded; task status, reason and dates unchanged.' : ''}${response.status === 'new-eta' && !response.planApplied ? ' Reported ETA retained; canonical commitment unchanged because plan editing is not granted.' : ''} Work completion was not inferred.`,
        [entry.sessionId],
        recent.length
      );
    } catch (error) {
      if (error instanceof BotWatchPostRefused) {
        response.ackAttempted = false;
        await this.saveRefusedPost(entry, reservation);
      } else throw error;
    }
  }
  private async resolveAttention(entry: Entry, reason: string) {
    if (!entry.attentionId && !entry.attentionPending) return;
    const id = attentionId(entry.taskId);
    const issue = this.deps.board.snapshot().issues.find((t) => t.id === id);
    if (
      issue &&
      !ended(issue) &&
      issue.tags.includes('assignment-attention') &&
      (issue.source?.messageId === entry.promptId || reason === 'Assigned work completed')
    ) {
      await this.deps.board.update(
        {
          beforeSave: () =>
            this.audit({
              action: 'assignment-attention-resolved',
              by: 'bot:assignment-status',
              checkinId: entry.id,
              taskId: entry.taskId,
              reason,
            }),
        },
        (s) => {
          const row = s.issues.find((t) => t.id === id)!;
          row.status = 'done';
          row.reason = reason;
          row.doneAt = this.now();
          row.updatedAt = this.now();
        }
      );
    }
    if (entry.attentionPending) {
      entry.attentionPending = false;
      await this.save(entry);
    }
  }
  private routingCurrent(entry: Entry, managerId: string | undefined) {
    const current = this.current(entry),
      cfg = this.store.snapshot().config;
    if (!current || !cfg?.enabled || !this.active(current.employee) || !cfg.roomIds.includes(entry.roomId))
      return false;
    const room = this.roomFor(current.task, current.employee, entry.roomId);
    if (!room) return false;
    const coordinator = this.deps.coordinatorId?.(current.employee.owner),
      expected =
        current.employee.reportsTo ?? (current.employee.id === coordinator ? 'owner' : (coordinator ?? 'owner'));
    if (expected === 'owner') return managerId === undefined;
    const manager = this.deps.employees().find((e) => e.id === expected && e.owner === current.employee.owner);
    return (
      !!manager &&
      manager.id === managerId &&
      this.active(manager) &&
      room.members.some((m) => m.sessionId === manager.sessionId) &&
      this.deps.canDeliver(manager.sessionId, room.id)
    );
  }
  private async escalate(entry: Entry, bot: ChatBot, task: Issue, employee: AssignmentEmployee) {
    // A historical Blocked report must not reopen attention for a newer check-in.
    if (this.store.snapshot().entries.some((other) =>
      other.taskId === entry.taskId && other.id !== entry.id && other.createdAt >= entry.createdAt)) return;
    const coordinator = this.deps.coordinatorId?.(employee.owner);
    const managerId = employee.reportsTo ?? (employee.id === coordinator ? 'owner' : (coordinator ?? 'owner'));
    const manager = this.deps.employees().find((e) => e.id === managerId && e.owner === employee.owner);
    if (managerId !== 'owner' && !manager) return; // Unknown reporting links never become owner authority.
    const room = this.roomFor(task, employee, entry.roomId);
    if (
      !room ||
      (manager &&
        (!this.active(manager) ||
          !room.members.some((m) => m.sessionId === manager.sessionId) ||
          !this.deps.canDeliver(manager.sessionId, room.id)))
    )
      return;
    const id = attentionId(task.id);
    const observedBoard = this.deps.board.snapshot();
    const existing = observedBoard.issues.find((i) => i.id === id);
    if (existing && !existing.tags.includes('assignment-attention')) throw Error('Attention identity conflict');
    if (existing && ended(existing) && existing.source?.roomId === entry.roomId && existing.source.messageId === entry.promptId) {
      // Closing this check-in's attention does not complete the work. It remains
      // closed, while the normal interval can issue an independent fresh check-in.
      const changed = entry.attentionId !== id || entry.attentionPending || entry.phase === 'asked';
      entry.attentionId = id;
      entry.attentionPending = false;
      if (entry.phase === 'asked') entry.phase = 'cancelled';
      if (changed) await this.save(entry);
      return;
    }
    entry.attentionId = id;
    entry.attentionPending = true;
    await this.save(entry);
    if (!existing || ended(existing)) {
      await this.deps.board.update(
        {
          ifRev: observedBoard.rev,
          beforeSave: () =>
            this.audit({
              action: 'assignment-attention-opened',
              by: `bot:${bot.id}`,
              taskId: task.id,
              checkinId: entry.id,
              managerId: manager?.id,
              originalEnd: entry.originalEnd,
            }),
        },
        (s) => {
          if (!this.current(entry)) throw Error('Assignment changed');
          const row: Issue = {
            id,
            title: `Assignment status needs attention: ${task.id}`,
            owner: manager?.id,
            status: 'todo',
            reason: entry.response
              ? boardReason(entry.response.messageId, entry.response.reason, entry.response.status === 'new-eta'
                  ? 'Assignee reported a new ETA; canonical commitment unchanged without plan-edit permission. '
                  : 'Assignee reported blocked. ')
              : 'No correlated assignee response by check-in deadline',
            tags: ['assignment-attention'],
            source: { roomId: entry.roomId, messageId: entry.promptId! },
            links: [],
            createdAt: existing?.createdAt ?? this.now(),
            updatedAt: this.now(),
            scale: 'hour',
          };
          const index = s.issues.findIndex((i) => i.id === id);
          if (index < 0) s.issues.push(row);
          else s.issues[index] = row;
        }
      );
    } else if (existing.owner !== manager?.id) {
      await this.deps.board.update(
        {
          beforeSave: () =>
            this.audit({
              action: 'assignment-attention-manager-updated',
              checkinId: entry.id,
              by: `bot:${bot.id}`,
              taskId: task.id,
              managerId: manager?.id,
            }),
        },
        (s) => {
          s.issues.find((i) => i.id === id)!.owner = manager?.id;
        }
      );
    }
    if (!this.routingCurrent(entry, manager?.id)) return;
    const recipient = manager?.sessionId ?? 'user';
    if (entry.notifiedManager === recipient) return;
    const at = this.now(),
      recent = this.store.snapshot().posts.filter((t) => t > at - 3600000);
    if (recent.length >= bot.maxPerHour) return;
    const reservation = [...recent, at];
    entry.notifiedManager = recipient;
    await this.store.update((s) => {
      s.entries[s.entries.findIndex((e) => e.id === entry.id)] = entry;
      s.posts = reservation;
    });
    try {
      if (!this.routingCurrent(entry, manager?.id)) return;
      this.post(
        bot,
        room.id,
        `Assignment attention ${id} tracks task ${task.id}, check-in ${entry.id}. ${manager ? safeName(manager.name) : 'Owner'}: ` +
          `${safeName(employee.name)} ${escalationReason(entry)} ${task.id} (${escalationRole(employee, manager)}). ` +
          'Please review the Board attention item. No work completion was inferred.',
        [recipient],
        recent.length
      );
    } catch (error) {
      if (error instanceof BotWatchPostRefused) {
        delete entry.notifiedManager;
        await this.saveRefusedPost(entry, reservation);
      } else throw error;
    }
  }
}
