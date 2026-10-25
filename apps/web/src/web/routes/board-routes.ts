import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
/**
 * @fileoverview The server's board (board-types.ts): GET /api/board and its audited writes.
 *
 * Who may write: the owner (no agent header) and owner-made room coordinators may do anything; any member may file an issue (it
 * lands in triage), add a win, edit its own issues and set its own focus. Only the owner and coordinators import.
 * An agent is identified by its x-reverie-parent-session header, which must resolve to exactly itself (no prefix, and a
 * body field never stands in for it). Every write appends an audit line BEFORE the board is saved; if the audit
 * cannot be written the write is refused (500) and the board is unchanged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BoardError, type BoardStore } from '../../board-store.js';
import { boardOwnerIds, boardPace, importContent, importSchedule, upsertById, type ContentFile, type ScheduleFile } from '../../board-logic.js';
import {
  BlockerSchema,
  DecisionSchema,
  DecisionOptionsSchema,
  IssueSchema,
  LinkSchema,
  MarkSchema,
  MilestoneSchema,
  RecommendationSchema,
  ISSUE_STATUSES,
  type BoardPin,
  type BoardPoll,
  type BoardState,
  type BoardView,
  type Issue,
  type Recommendation,
  type PlanBurn,
  type RosterRow,
} from '../../board-types.js';
import { pollIsOpen, USER_RECIPIENT, type ChatRoom } from '../../chatroom-store.js';
import { waitingForOwner } from '../../decision-alert.js';
import { ownerMade } from '../../owner-auth/relations.js';
import { burnRate, type UsageSample } from '../../plan-pace.js';
import type { PlanRow } from '../../plan-accounts.js';
import type { SessionPort } from '../ports/session-port.js';
import type { EventPort } from '../ports/event-port.js';
import { isAdmin, ownerFor, resolveParentSessionId } from '../route-helpers.js';

interface Employee {
  id: string;
  name: string;
  icon?: string;
  avatar?: string;
  position?: string;
  sessionId?: string;
  permissions?: { recoverEmployees?: boolean; moveOwnPlan?: boolean; managePlans?: boolean };
}

export interface BoardDeps {
  verifiedOwner?: OwnerVerifier;
  store: BoardStore;
  /** Company employees and settings for the caller's owner (CompanyService.view). */
  company: (owner: string | undefined) => { employees: Employee[]; settings: { timeZone: string; ownerName: string } };
  /** Chat rooms through the chat service (never chatrooms.json). */
  rooms: () => readonly ChatRoom[];
  audit: (entry: Record<string, unknown>) => Promise<void>;
  /** Plan rows and usage history (admin-only data, like GET /api/plans). */
  plans?: () => Promise<PlanRow[]>;
  usageHistory?: () => Promise<Record<string, UsageSample[]>>;
  now?: () => number;
}

const HOUR = 3600_000;
const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;
const IfRev = z.object({ ifRev: z.number().int().nonnegative().optional() });

const IssueInput = IssueSchema.pick({
  title: true,
  owner: true,
  status: true,
  reason: true,
  tags: true,
  milestoneId: true,
  start: true,
  end: true,
  scale: true,
  source: true,
})
  .extend({ links: z.array(LinkSchema).max(20).optional(), status: z.enum(ISSUE_STATUSES).optional() })
  .partial({ title: true })
  .merge(IfRev)
  .strict();
const IssueCreate = IssueInput.required({ title: true });
// Create defaults must not turn omitted PATCH fields into destructive updates.
const IssuePatch = IssueInput.omit({ source: true })
  .extend({
    owner: z.string().max(100).nullable().optional(),
    tags: IssueSchema.shape.tags.unwrap().optional(),
    scale: IssueSchema.shape.scale.unwrap().optional(),
  })
  .strict();
const MilestoneInput = MilestoneSchema.pick({ title: true, due: true }).partial().merge(IfRev).strict();
const WinInput = z.object({ text: z.string().trim().min(1).max(500), who: z.string().trim().max(100).optional() }).merge(IfRev).strict();
const BlockerInput = BlockerSchema.pick({ who: true, owner: true, text: true })
  .extend({ sev: BlockerSchema.shape.sev.default('med') })
  .merge(IfRev)
  .strict();
/** Card text for a decision or poll; null clears a field. An agent's `by` is always itself; the owner may name the author. */
const CardNote = z.object({
  summary: z.string().trim().max(300).nullable().optional(),
  recommendation: RecommendationSchema.extend({ by: RecommendationSchema.shape.by.optional() }).nullable().optional(),
  tradeoff: z.string().trim().max(300).nullable().optional(),
});
const CardNoteInput = CardNote.merge(IfRev).strict();
const DecisionInput = DecisionSchema.pick({ text: true, where: true })
  .extend({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional(), options: DecisionOptionsSchema })
  .merge(CardNote)
  .merge(IfRev)
  .strict();
const DecisionNoteInput = CardNoteInput.extend({ options: DecisionOptionsSchema.optional() }).strict();
const AgentInput = z
  .object({ focus: z.string().trim().max(500).optional(), receipts: z.array(z.string().trim().min(1).max(300)).max(20).optional() })
  .merge(IfRev)
  .strict();
const MarksInput = z.object({ marks: z.array(MarkSchema).max(100) }).merge(IfRev).strict();
const ImportInput = z.object({ content: z.unknown().optional(), schedule: z.unknown().optional(), dryRun: z.boolean().optional() }).merge(IfRev).strict();

type Caller =
  | { kind: 'owner'; by: string; owner: string | undefined }
  | { kind: 'agent'; by: string; sessionId: string; memberId: string | undefined; coordinator: boolean; owner: string | undefined };

export function registerBoardRoutes(app: FastifyInstance, ctx: SessionPort & Partial<EventPort>, deps: BoardDeps): void {
  const now = () => (deps.now ?? Date.now)();
  const isCoordinator = (sessionId: string) =>
    deps.rooms().some((r) => !r.archivedAt && r.members.some((m) => m.sessionId === sessionId && m.role === 'coordinator' && ownerMade(m)));

  // Apply current membership before reading any room messages, including counts and poll metadata.
  const visibleRooms = (c: Caller) =>
    deps.rooms().filter((r) => !r.archivedAt && (c.kind === 'owner' || r.members.some((m) => m.sessionId === c.sessionId)));

  const caller = (req: FastifyRequest): Caller => {
    const owner = ownerFor(req);
    const header = req.headers['x-reverie-parent-session'];
    if ((deps.verifiedOwner ?? NO_OWNER)(req)) return { kind: 'owner', by: 'owner', owner };
    if (header === undefined || req.headers['x-reverie-service-token'] !== undefined) throw new BoardError('Verified owner or agent session required', 403);
    const sessionId = resolveParentSessionId(ctx, req, undefined, owner);
    // The header must name exactly this session: no prefix, no body field standing in for it.
    if (!sessionId || header !== sessionId) throw new BoardError('Unknown caller session', 403);
    const memberId = deps.company(owner).employees.find((e) => e.sessionId === sessionId)?.id;
    return { kind: 'agent', by: memberId ?? sessionId, sessionId, memberId, coordinator: isCoordinator(sessionId), owner };
  };
  const lead = (c: Caller) => c.kind === 'owner' || c.coordinator;
  /** The caller's display name, for "recommended by". */
  const nameOf = (c: Caller) =>
    c.kind === 'owner' ? deps.company(c.owner).settings.ownerName || 'owner' : (deps.company(c.owner).employees.find((e) => e.id === c.memberId)?.name ?? c.by);
  /** Apply a card note to a target: a field given as null is removed, one left out is kept. */
  const applyNote = (c: Caller, target: { summary?: string; recommendation?: Recommendation; tradeoff?: string }, note: z.infer<typeof CardNote>) => {
    for (const key of ['summary', 'tradeoff'] as const) {
      const v = note[key];
      if (v === null || v === '') delete target[key];
      else if (v !== undefined) target[key] = v;
    }
    if (note.recommendation === null) delete target.recommendation;
    // An agent is always credited as itself; only the owner may name who wrote it (e.g. loading an agent's file).
    else if (note.recommendation) {
      const by = c.kind === 'owner' && note.recommendation.by ? note.recommendation.by : nameOf(c);
      target.recommendation = { option: note.recommendation.option, reason: note.recommendation.reason ?? '', by };
    }
  };
  const requireLead = (c: Caller, what: string) => {
    if (!lead(c)) throw new BoardError(`Only the owner or a coordinator may ${what}`, 403);
  };
  const normalizeDecisionRecommendation = (decision: BoardState['decisions'][number]) => {
    if (!decision.options || !decision.recommendation) return;
    const option = decision.options.find(o => o.toLowerCase() === decision.recommendation!.option.toLowerCase());
    if (!option) throw new BoardError('Recommendation must name one of the decision options', 400);
    decision.recommendation.option = option;
  };

  const run = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return { success: true, data: await work() };
    } catch (error) {
      if (!(error instanceof BoardError)) throw error;
      reply.code(error.status);
      return { success: false, error: error.message };
    }
  };
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const out = schema.safeParse(body ?? {});
    if (!out.success) {
      const issue = out.error.issues[0];
      throw new BoardError(`${issue?.path.join('.') || 'body'}: ${issue?.message}`, 400);
    }
    return out.data;
  };

  /** One audited write: the audit line goes first; if it fails, nothing is saved. */
  const write = async <T>(c: Caller, op: string, ifRev: number | undefined, detail: Record<string, unknown>, mutate: (s: BoardState) => T) => {
    const { rev, result } = await deps.store.update(
      {
        ifRev,
        beforeSave: async () => {
          try {
            await deps.audit({ action: `board-${op}`, by: c.by, ...(c.kind === 'agent' ? { session: c.sessionId } : {}), ...detail });
          } catch {
            throw new BoardError('Could not write the audit line; nothing was changed', 500);
          }
        },
      },
      mutate
    );
    ctx.broadcast?.('board:changed', { rev });
    return { rev, item: result };
  };

  const findIssue = (s: BoardState, id: string) => {
    const issue = s.issues.find((i) => i.id === id);
    if (!issue) throw new BoardError(`No issue ${id}`, 404);
    return issue;
  };
  const checkIssue = (s: BoardState, issue: Issue) => {
    if ((issue.status === 'wontdo' || issue.status === 'blocked') && !issue.reason) {
      throw new BoardError(`An issue moved to ${issue.status} needs a reason`, 400);
    }
    if (issue.milestoneId && !s.milestones.some((m) => m.id === issue.milestoneId)) throw new BoardError(`No milestone ${issue.milestoneId}`, 400);
    if (issue.start !== undefined && issue.end !== undefined && issue.end < issue.start) throw new BoardError('end is before start', 400);
  };
  const stampDone = (issue: Issue, previous: Issue['status'] | undefined, at: number) => {
    if (issue.status === 'done' && previous !== 'done') issue.doneAt = at;
    if (issue.status !== 'done') delete issue.doneAt;
  };

  // ---- read ----
  // What waits on the owner: open decisions and open polls without an owner vote. Backs the Board badge and the push.
  app.get('/api/board/waiting', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      return waitingForOwner(deps.store.snapshot(), visibleRooms(c), now());
    })
  );
  app.get('/api/board', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      const company = deps.company(c.owner);
      const state = deps.store.snapshot();
      const at = now();
      const rooms = visibleRooms(c);
      const roster: RosterRow[] = company.employees.map((e) => {
        const s = e.sessionId ? ctx.sessions.get(e.sessionId) : undefined;
        const alive = !!s && s.pid !== null;
        return {
          id: e.id,
          name: e.name,
          icon: e.icon,
          avatar: e.avatar,
          position: e.position,
          sessionId: e.sessionId,
          state: !alive ? 'gone' : s?.isWorking ? 'running' : 'idle',
          coordinator: !!e.sessionId && isCoordinator(e.sessionId),
        };
      });
      const polls: BoardPoll[] = [];
      const pins: BoardPin[] = [];
      const pollNotes: BoardState['pollNotes'] = c.kind === 'owner' ? state.pollNotes : {};
      for (const room of rooms) {
        for (const m of room.messages) {
          if (c.kind === 'agent') {
            const key = `${room.id}:${m.id}`;
            if (state.pollNotes[key]) pollNotes[key] = state.pollNotes[key];
          }
          if (m.deleted) continue;
          if (m.poll && pollIsOpen(m.poll, at)) {
            const counts = new Map<string, number>();
            for (const chosen of Object.values(m.poll.votes)) for (const o of chosen) counts.set(o, (counts.get(o) ?? 0) + 1);
            const note = state.pollNotes[`${room.id}:${m.id}`];
            polls.push({
              roomId: room.id,
              room: room.name,
              messageId: m.id,
              createdAt: m.at,
              question: m.poll.question,
              options: m.poll.options.map((o) => ({ id: o.id, label: o.label, votes: counts.get(o.id) ?? 0 })),
              multi: !!m.poll.multi,
              closesAt: m.poll.closesAt,
              recommended: m.poll.recommended,
              ...(note?.summary ? { summary: note.summary } : {}),
              ...(note?.recommendation ? { recommendation: note.recommendation } : {}),
              ...(note?.tradeoff ? { tradeoff: note.tradeoff } : {}),
              ownerVote: c.kind === 'owner' ? [...(m.poll.votes[USER_RECIPIENT] ?? [])] : [],
            });
          }
          if (m.pinned) {
            pins.push({ roomId: room.id, room: room.name, messageId: m.id, text: m.text, by: m.pinned.by, at: m.pinned.at, kind: m.pinned.kind });
          }
        }
      }
      pins.sort((a, b) => b.at - a.at);
      const ownerIds = boardOwnerIds(state.issues, company.employees);
      const view: BoardView = {
        ...state,
        pollNotes,
        built: at,
        timeZone: company.settings.timeZone,
        ownerName: company.settings.ownerName,
        roster,
        capabilities: {
          checkedAt: at,
          identity: { kind: c.kind, name: nameOf(c), ...(c.kind === 'agent' ? { sessionId: c.sessionId, employeeId: c.memberId } : {}) },
          board: { read: true, fileIssue: true, createDecision: lead(c), clearDecision: lead(c), manageBoard: c.kind === 'owner', reason: c.kind === 'owner' ? 'Verified owner.' : c.coordinator ? 'Active owner-made coordinator membership; the Board uses this same gate for decision creation.' : 'Decision creation requires an active owner-made coordinator membership. Company plan/recovery grants and titles do not grant it.' },
          company: {
            recoverEmployees: c.kind === 'owner' || company.employees.find(e => e.id === c.memberId)?.permissions?.recoverEmployees === true,
            moveOwnPlan: c.kind === 'owner' || !!company.employees.find(e => e.id === c.memberId && (e.permissions?.moveOwnPlan === true || e.permissions?.managePlans === true)),
            managePlans: c.kind === 'owner' || company.employees.find(e => e.id === c.memberId)?.permissions?.managePlans === true,
            planPreconditions: 'Grant admission only. Current owned live source/target bindings, non-vacation employees, supported single-company plan/account and handoff approval are checked again by the plan action.',
          },
        },
        ownerIds,
        // Same gate as GET /api/plans.
        planBurn: isAdmin(req) ? await planBurn(state) : null,
        polls,
        pins,
        pace: boardPace(state, at, ownerIds),
      };
      return view;
    })
  );

  const planBurn = async (state: BoardState): Promise<PlanBurn[] | null> => {
    if (!deps.plans) return null;
    const [rows, history] = await Promise.all([deps.plans(), deps.usageHistory?.() ?? Promise.resolve({})]);
    return rows.map((row) => {
      // The plan name is the account label itself (renamed on the Board); only `who` still comes from the note.
      const who = state.plans[row.label]?.who ?? '';
      const weekStart = row.pace.weekStart;
      const reset = row.pace.weekReset;
      const samples = ((history as Record<string, UsageSample[]>)[row.id] ?? []).filter((s) => !s.misattributed && (weekStart === null || s.at >= weekStart));
      const points = samples.map((s, i) => {
        const rate = burnRate(samples.slice(0, i + 1), s.at, weekStart, reset);
        const proj = rate === null || reset === null ? null : Math.round((s.weekly + (rate * (reset - s.at)) / HOUR) * 10) / 10;
        return { t: s.at, used: s.weekly, rate, proj };
      });
      return {
        id: row.id,
        profileId: row.profileId,
        provider: row.provider,
        isDefault: row.isDefault,
        signedIn: row.signedIn,
        authState: row.authState,
        usageError: row.usageError,
        label: row.label,
        name: row.label,
        who,
        used: row.pace.weekly,
        rate: row.pace.burnPerHour,
        proj: row.pace.projected,
        weekStart,
        reset,
        runsOut: row.pace.runsOutAt,
        burnBasis: row.pace.burnBasis,
        remainingPct: row.pace.remainingPct,
        hoursToReset: row.pace.hoursToReset,
        sustainablePctPerHour: row.pace.sustainablePctPerHour,
        at: row.updatedAt,
        banked: row.bankedResets ? { count: row.bankedResets.availableCount, expiresAt: row.bankedResets.earliestExpiresAt } : null,
        points,
      };
    });
  };

  // ---- issues ----
  app.post('/api/board/issues', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      const body = parse(IssueCreate, req.body);
      const at = now();
      const id = newId('i');
      // A non-coordinator files into triage; the owner and coordinators may file straight onto the plan.
      const status = lead(c) ? (body.status ?? (body.owner ? 'todo' : 'triage')) : 'triage';
      return write(c, 'issue-add', body.ifRev, { id, title: body.title, status }, (s) => {
        const issue: Issue = {
          id,
          title: body.title,
          ...(body.owner ? { owner: body.owner } : {}),
          requester: c.by,
          ...(body.source ? { source: body.source } : {}),
          status,
          ...(body.reason ? { reason: body.reason } : {}),
          tags: body.tags ?? [],
          ...(body.milestoneId ? { milestoneId: body.milestoneId } : {}),
          links: body.links ?? [],
          ...(body.start !== undefined ? { start: body.start } : {}),
          ...(body.end !== undefined ? { end: body.end } : {}),
          scale: body.scale ?? 'day',
          createdAt: at,
          updatedAt: at,
        };
        stampDone(issue, undefined, at);
        checkIssue(s, issue);
        s.issues.push(issue);
        return issue;
      });
    })
  );

  app.patch<{ Params: { id: string } }>('/api/board/issues/:id', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      const body = parse(IssuePatch, req.body);
      const { ifRev, ...change } = body;
      if (Object.keys(change).length === 0) throw new BoardError('Nothing to change', 400);
      const at = now();
      return write(c, 'issue-update', ifRev, { id: req.params.id, ...change }, (s) => {
        const issue = findIssue(s, req.params.id);
        // Checked inside the write chain, against the issue as it is now. A member edits only its own issues (by
        // member id); the owner and coordinators edit all.
        if (!lead(c) && !(c.kind === 'agent' && c.memberId && issue.owner === c.memberId)) {
          throw new BoardError('Only the issue owner or a coordinator may change it', 403);
        }
        if (!lead(c) && change.owner !== undefined && change.owner !== issue.owner) {
          throw new BoardError('Only a coordinator may reassign an issue', 403);
        }
        const previous = issue.status;
        const { owner, ...rest } = change;
        Object.assign(issue, rest, { updatedAt: at });
        if (owner === null) delete issue.owner;
        else if (owner !== undefined) issue.owner = owner;
        if (issue.status !== 'wontdo' && issue.status !== 'blocked' && change.reason === undefined) delete issue.reason;
        stampDone(issue, previous, at);
        checkIssue(s, issue);
        return issue;
      });
    })
  );

  // ---- milestones ----
  app.post('/api/board/milestones', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'add a milestone');
      const body = parse(MilestoneInput.required({ title: true, due: true }), req.body);
      const at = now();
      const id = newId('m');
      return write(c, 'milestone-add', body.ifRev, { id, title: body.title, due: body.due }, (s) => {
        const m = { id, title: body.title, due: body.due, createdAt: at, updatedAt: at };
        s.milestones.push(m);
        return m;
      });
    })
  );
  app.patch<{ Params: { id: string } }>('/api/board/milestones/:id', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'change a milestone');
      const { ifRev, ...change } = parse(MilestoneInput, req.body);
      return write(c, 'milestone-update', ifRev, { id: req.params.id, ...change }, (s) => {
        const m = s.milestones.find((x) => x.id === req.params.id);
        if (!m) throw new BoardError(`No milestone ${req.params.id}`, 404);
        Object.assign(m, change, { updatedAt: now() });
        return m;
      });
    })
  );

  // ---- wins, blockers, decisions ----
  app.post('/api/board/wins', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      const body = parse(WinInput, req.body);
      const id = newId('w');
      const who = body.who && lead(c) ? body.who : c.kind === 'owner' ? (body.who ?? 'owner') : (deps.company(c.owner).employees.find((e) => e.id === c.memberId)?.name ?? c.by);
      return write(c, 'win-add', body.ifRev, { id, who, text: body.text }, (s) => {
        const win = { id, at: now(), who, text: body.text };
        s.wins.push(win);
        return win;
      });
    })
  );
  app.post('/api/board/blockers', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'add a blocker');
      const body = parse(BlockerInput, req.body);
      const id = newId('b');
      return write(c, 'blocker-add', body.ifRev, { id, owner: body.owner, sev: body.sev, text: body.text }, (s) => {
        const blocker = { id, since: now(), who: body.who, owner: body.owner, sev: body.sev, text: body.text };
        s.blockers.push(blocker);
        return blocker;
      });
    })
  );
  app.post('/api/board/decisions', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'add a decision');
      if (!req.body || typeof req.body !== 'object' || !('options' in req.body))
        throw new BoardError('Decision options are required: --option "Approve" --option "Hold" (optional --recommend "Approve"). Prose does not create buttons. An older laptop CLI may lack these flags; use its existing scoped API client in /handbook/operations (Older laptop CLI), or update the CLI from the project flake.', 400);
      const body = parse(DecisionInput, req.body);
      const id = body.id ?? newId('d');
      return write(c, 'decision-add', body.ifRev, { id, text: body.text }, (s) => {
        if (s.decisions.some((d) => d.id === id)) throw new BoardError(`Decision ${id} exists`, 409);
        const decision: BoardState['decisions'][number] = { id, text: body.text, where: body.where ?? '', options: body.options, at: now() };
        applyNote(c, decision, body);
        normalizeDecisionRecommendation(decision);
        s.decisions.push(decision);
        return decision;
      });
    })
  );
  app.patch<{ Params: { id: string } }>('/api/board/decisions/:id', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'annotate a decision');
      const { ifRev, ...note } = parse(DecisionNoteInput, req.body);
      if (Object.keys(note).length === 0) throw new BoardError('Nothing to change', 400);
      return write(c, 'decision-note', ifRev, { id: req.params.id, ...note }, (s) => {
        const d = s.decisions.find((x) => x.id === req.params.id);
        if (!d) throw new BoardError(`No decision ${req.params.id}`, 404);
        if (note.options) {
          if (d.clearedAt) throw new BoardError('A decided or dismissed card cannot change its options', 409);
          d.options = note.options;
        }
        applyNote(c, d, note);
        normalizeDecisionRecommendation(d);
        return d;
      });
    })
  );
  app.post<{ Params: { id: string } }>('/api/board/decisions/:id/choose', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      if (c.kind !== 'owner') throw new BoardError('Only the verified owner may choose a decision option', 403);
      const body = parse(z.object({ option: z.string().trim().min(1).max(200) }).merge(IfRev).strict(), req.body);
      return write(c, 'decision-choose', body.ifRev, { id: req.params.id, option: body.option }, s => {
        const decision = s.decisions.find(d => d.id === req.params.id);
        if (!decision) throw new BoardError(`No decision ${req.params.id}`, 404);
        if (decision.clearedAt) throw new BoardError('This decision is already decided or dismissed', 409);
        const option = decision.options?.find(o => o === body.option);
        if (!option) throw new BoardError('Choose one of the options provided by the author', 400);
        decision.chosen = option;
        decision.clearedAt = now();
        decision.clearedBy = c.by;
        return decision;
      });
    })
  );
  app.put<{ Params: { roomId: string; messageId: string } }>('/api/board/polls/:roomId/:messageId/note', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'annotate a poll');
      const { ifRev, ...note } = parse(CardNoteInput, req.body);
      const { roomId, messageId } = req.params;
      const room = deps.rooms().find((r) => r.id === roomId && !r.archivedAt);
      const message = room?.messages.find((m) => m.id === messageId && !m.deleted);
      if (!message?.poll) throw new BoardError(`No poll ${messageId} in room ${roomId}`, 404);
      const options = message.poll.options;
      if (note.recommendation && !options.some((o) => o.id === note.recommendation!.option || o.label.toLowerCase() === note.recommendation!.option.toLowerCase())) {
        throw new BoardError(`Not an option of this poll: ${note.recommendation.option.slice(0, 40)}`, 400);
      }
      return write(c, 'poll-note', ifRev, { roomId, messageId, ...note }, (s) => {
        const key = `${roomId}:${messageId}`;
        const prev = s.pollNotes[key];
        const next = { ...(prev ?? {}), updatedAt: now(), updatedBy: c.by };
        applyNote(c, next, note);
        // Store the option as its id, whatever the caller typed.
        if (next.recommendation) {
          const hit = options.find((o) => o.id === next.recommendation!.option || o.label.toLowerCase() === next.recommendation!.option.toLowerCase());
          if (hit) next.recommendation = { ...next.recommendation, option: hit.id };
        }
        s.pollNotes[key] = next;
        return next;
      });
    })
  );
  for (const kind of ['blockers', 'decisions'] as const) {
    app.post<{ Params: { id: string } }>(`/api/board/${kind}/:id/clear`, async (req, reply) =>
      run(reply, async () => {
        const c = caller(req);
        requireLead(c, `clear ${kind}`);
        const { ifRev } = parse(IfRev.strict(), req.body);
        return write(c, `${kind.slice(0, -1)}-clear`, ifRev, { id: req.params.id }, (s) => {
          const item = s[kind].find((x) => x.id === req.params.id);
          if (!item) throw new BoardError(`No ${kind.slice(0, -1)} ${req.params.id}`, 404);
          if (item.clearedAt) throw new BoardError(`${req.params.id} is already cleared`, 409);
          item.clearedAt = now();
          item.clearedBy = c.by;
          return item;
        });
      })
    );
  }

  // ---- focus / receipts, marks ----
  app.put<{ Params: { memberId: string } }>('/api/board/agents/:memberId', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      if (!lead(c) && !(c.kind === 'agent' && c.memberId === req.params.memberId)) {
        throw new BoardError('A member sets only its own focus (coordinators set anyone’s)', 403);
      }
      if (!deps.company(c.owner).employees.some((e) => e.id === req.params.memberId)) throw new BoardError(`No member ${req.params.memberId}`, 404);
      const { ifRev, ...change } = parse(AgentInput, req.body);
      return write(c, 'agent-update', ifRev, { member: req.params.memberId, ...change }, (s) => {
        const prev = s.agents[req.params.memberId] ?? { focus: '', receipts: [] };
        const note = { focus: change.focus ?? prev.focus, receipts: change.receipts ?? prev.receipts, updatedAt: now(), updatedBy: c.by };
        s.agents[req.params.memberId] = note;
        return note;
      });
    })
  );
  app.put('/api/board/marks', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'set timeline marks');
      const { ifRev, marks } = parse(MarksInput, req.body);
      return write(c, 'marks-set', ifRev, { count: marks.length }, (s) => {
        s.marks = marks;
        return marks;
      });
    })
  );

  // ---- import (migration from runtime/board files) ----
  app.post('/api/board/import', async (req, reply) =>
    run(reply, async () => {
      const c = caller(req);
      requireLead(c, 'import');
      const body = parse(ImportInput, req.body);
      if (body.content === undefined && body.schedule === undefined) throw new BoardError('Give content and/or schedule', 400);
      const company = deps.company(c.owner);
      const tz = company.settings.timeZone;
      const byName = new Map(company.employees.map((e) => [e.name.toLowerCase(), e.id]));
      const memberByName = (name: string) => byName.get(name.trim().toLowerCase());
      const at = now();
      let content: ReturnType<typeof importContent> | undefined;
      let schedule: ReturnType<typeof importSchedule> | undefined;
      try {
        if (body.content !== undefined) content = importContent(body.content as ContentFile, memberByName, tz, at, c.by);
        if (body.schedule !== undefined) schedule = importSchedule(body.schedule as ScheduleFile, memberByName, tz, at);
      } catch (error) {
        throw new BoardError(`Import failed: ${(error as Error).message}`, 400);
      }
      for (const decision of content?.decisions ?? []) {
        if (decision.options) decision.options = parse(DecisionOptionsSchema, decision.options);
      }
      const requireImportedChoices = (state: BoardState) => {
        for (const decision of content?.decisions ?? [])
          if (!decision.options && !state.decisions.some(existing => existing.id === decision.id))
            throw new BoardError(`New imported decision ${decision.id} needs 2–10 options. Preserve legacy cards in place; add choices with decision update.`, 400);
      };
      requireImportedChoices(deps.store.snapshot());
      const summary = {
        issues: schedule?.issues.length ?? 0,
        marks: schedule?.marks.length ?? 0,
        wins: content?.wins.length ?? 0,
        blockers: content?.blockers.length ?? 0,
        decisions: content?.decisions.length ?? 0,
        agents: Object.keys(content?.agents ?? {}).length,
        plans: Object.keys(content?.plans ?? {}).length,
        unmatched: [...new Set([...(content?.unmatched ?? []), ...(schedule?.unmatched ?? [])])],
      };
      if (body.dryRun) return { rev: deps.store.snapshot().rev, item: summary, dryRun: true };
      return write(c, 'import', body.ifRev, summary, (s) => {
        requireImportedChoices(s);
        if (schedule) {
          // A re-import updates an issue in place (the file is the truth for status) but keeps createdAt and the first doneAt.
          s.issues = upsertById(s.issues, schedule.issues, (old, next) => ({ ...next, createdAt: old.createdAt, ...(next.status === 'done' ? { doneAt: old.doneAt ?? next.doneAt } : { doneAt: undefined }) }));
          s.marks = schedule.marks;
        }
        if (content) {
          s.wins = upsertById(s.wins, content.wins);
          s.blockers = upsertById(s.blockers, content.blockers, (old, next) => ({ ...next, clearedAt: old.clearedAt, clearedBy: old.clearedBy }));
          s.decisions = upsertById(s.decisions, content.decisions, (old, next) => ({ ...old, ...next, ...(old.chosen ? { options: old.options, chosen: old.chosen } : {}), at: old.at, clearedAt: old.clearedAt, clearedBy: old.clearedBy }));
          s.agents = { ...s.agents, ...content.agents };
          s.plans = { ...s.plans, ...content.plans };
        }
        return summary;
      });
    })
  );
}
