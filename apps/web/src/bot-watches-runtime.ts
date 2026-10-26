/** One website-owned dispatcher over the existing bot registry, Board and normal room delivery. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChatBotRegistry } from './chat-bots.js';
import type { ChatroomService } from './chatroom-service.js';
import type { BoardStore } from './board-store.js';
import type { CompanyEmployee } from './company-types.js';
import type { OwnerVerifier } from './owner-auth/marks.js';
import { effectiveBoardPermissions, isBoardCoordinator } from './board-permissions.js';
import { BotWatchPostRefused } from './bot-watch-state.js';
import { AssignmentStatusWatch } from './assignment-status-watch.js';
import { PublicIssueWatch } from './cron/public-issue-watch.js';

export interface BotWatchesRuntimeDeps {
  dataPath(name: string): string;
  bots: ChatBotRegistry;
  chat: ChatroomService;
  board: BoardStore;
  employees(): CompanyEmployee[];
  coordinatorId?(owner: string | undefined): string | undefined;
  running(sessionId: string): boolean;
  verifiedOwner: OwnerVerifier;
  /** Single-user instance only until the Board itself has an explicit owner partition. */
  multiUser: boolean;
  now?: () => number;
}
export async function registerBotWatches(app: FastifyInstance, d: BotWatchesRuntimeDeps) {
  const post = (
    bot: ReturnType<ChatBotRegistry['list']>[number],
    roomId: string,
    text: string,
    to: string[],
    recent: number
  ) => {
    const current = d.bots.get(bot.id);
    if (!current) throw new BotWatchPostRefused('Current bot removed');
    bot = current;
    const existing = d.chat
      .rooms()
      .flatMap((r) => r.messages)
      .filter((m) => m.from.kind === 'bot' && m.from.botId === bot.id && m.at > (d.now ?? Date.now)() - 3600000).length;
    try {
      d.chat.checkBotPost(bot, roomId, recent + existing);
    } catch {
      throw new BotWatchPostRefused('Bot post admission refused');
    }
    return d.chat.postDurableBotMessage(bot, roomId, text, recent + existing, to, true);
  };
  const assignments = new AssignmentStatusWatch(d.dataPath('assignment-status-watch.json'), {
    board: d.board,
    employees: d.employees,
    running: d.running,
    bot: (id) => d.bots.get(id),
    room: (id) => d.chat.room(id),
    canDeliver: (sid, rid) => {
      const r = d.chat.room(rid);
      return (
        !d.multiUser &&
        d.chat.adminPhoneWakeEnabled &&
        d.running(sid) &&
        !!r &&
        !r.archivedAt &&
        r.kind !== 'dm' &&
        r.owner === undefined &&
        r.members.some((m) => m.sessionId === sid) &&
        (!d.chat.alertMode(sid) || d.chat.alertMode(sid)?.mode === 'ring')
      );
    },
    coordinatorId: d.coordinatorId,
    canEdit: (id) => {
      const e = d.employees().find((e) => e.id === id);
      return effectiveBoardPermissions(e, e ? isBoardCoordinator(d.chat.rooms(), e.sessionId) : false).editBoardIssues;
    },
    post,
    delivered: (sid, rid, id) => d.chat.phoneAccepts(sid, rid, id),
    audit: (entry) => d.chat.auditEntry(entry),
    now: d.now,
  });
  const issues = new PublicIssueWatch(d.dataPath('public-issue-watch.json'), {
    bot: (id) => d.bots.get(id),
    room: (id) => d.chat.room(id),
    // Public issue notices never wake providers or create owed replies.
    post: (bot, rid, text, recent) => {
      const current = d.bots.get(bot.id);
      if (!current) throw new BotWatchPostRefused('Current bot removed');
      bot = current;
      const existing = d.chat
        .rooms()
        .flatMap((r) => r.messages)
        .filter(
          (m) => m.from.kind === 'bot' && m.from.botId === bot.id && m.at > (d.now ?? Date.now)() - 3600000
        ).length;
      try {
        d.chat.checkBotPost(bot, rid, recent + existing);
      } catch {
        throw new BotWatchPostRefused('Bot post admission refused');
      }
      return d.chat.postDurableBotMessage(bot, rid, text, recent + existing, 'all', false);
    },
    now: d.now,
  });
  const unavailable: string[] = [];
  for (const [name, service] of [
    ['assignments', assignments],
    ['github-issues', issues],
  ] as const) {
    try {
      await service.init();
    } catch {
      unavailable.push(name);
    }
  }
  const allowed = (req: FastifyRequest) => !d.multiUser && !!d.verifiedOwner(req);
  const safeStatus = (service: AssignmentStatusWatch | PublicIssueWatch) => {
    try {
      return service.status();
    } catch {
      return { state: 'HOLD', reason: 'durable-state-unavailable' };
    }
  };
  const status = () => ({
    assignments: unavailable.includes('assignments') ? { state: 'HOLD' } : safeStatus(assignments),
    githubIssues: unavailable.includes('github-issues') ? { state: 'HOLD' } : safeStatus(issues),
    unavailable,
  });
  app.get('/api/bot-watches', async (req, reply) => {
    if (!allowed(req)) return reply.code(403).send({ success: false, error: 'Verified owner required' });
    return { success: true, data: status() };
  });
  app.put('/api/bot-watches/:type', async (req, reply) => {
    if (!allowed(req)) return reply.code(403).send({ success: false, error: 'Verified owner required' });
    const type = (req.params as { type: string }).type;
    if (!['assignments', 'github-issues'].includes(type))
      return reply.code(404).send({ success: false, error: 'Unknown typed bot watch' });
    if (unavailable.includes(type))
      return reply.code(503).send({ success: false, error: 'Bot state requires reconciliation' });
    try {
      await (type === 'assignments' ? assignments : issues).configure(req.body);
      return { success: true, data: status() };
    } catch {
      return reply.code(400).send({ success: false, error: 'Invalid typed bot watch configuration' });
    }
  });
  let running = false;
  return {
    assignments,
    issues,
    async tick() {
      if (running || d.multiUser) return;
      running = true;
      try {
        for (const [name, service] of [
          ['assignments', assignments],
          ['github-issues', issues],
        ] as const) {
          if (unavailable.includes(name)) continue;
          try {
            await service.tick();
          } catch {
            console.warn(`[bot-watches] ${name} held; inspect owner status`);
          }
        }
      } finally {
        running = false;
      }
    },
  };
}
