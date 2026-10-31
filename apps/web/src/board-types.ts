/**
 * @fileoverview The server's board: issues (the timeline and the kanban are both views of them), milestones, wins,
 * blockers, decisions, each member's focus and receipts, and timeline marks. One board per console server.
 *
 * Nothing on the board is ever deleted: a blocker or decision is cleared (`clearedAt`), and an issue ends as `done` or
 * `wontdo`. Times are epoch ms; a milestone's `due` is a date in the company time zone.
 */
import type { PlanAgentBurn } from './plan-agent-burn.js';
import { z } from 'zod';

export const ISSUE_STATUSES = ['triage', 'todo', 'doing', 'blocked', 'done', 'wontdo'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const LINK_KINDS = ['github-issue', 'github-pr', 'report', 'other'] as const;

/** Caps: a write past one is refused (409), never made room for by dropping older entries. */
export const BOARD_LIMITS = { issues: 2000, milestones: 200, wins: 500, blockers: 500, decisions: 500, receipts: 20, marks: 100 };

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'An id is 1-64 letters, digits or _ . : -');
const ms = z.number().int().nonnegative();

/** Plain http(s) URLs only: a `javascript:` or `data:` link would run in the console origin when clicked. */
const httpUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'A link is an http(s) URL');
export const LinkSchema = z.object({ url: httpUrl, kind: z.enum(LINK_KINDS).default('other') }).strict();

export const IssueSchema = z
  .object({
    id,
    title: text(300),
    /** Member (employee) id; unset while the issue waits in triage. */
    owner: z.string().max(100).optional(),
    /** Set only by an import when no employee matched the name. */
    ownerLabel: z.string().max(100).optional(),
    /** Who filed it (employee id, or the session id of a caller with no employee record). */
    requester: z.string().max(100).optional(),
    source: z.object({ roomId: z.string().min(1).max(100), messageId: z.string().min(1).max(100) }).strict().optional(),
    status: z.enum(ISSUE_STATUSES),
    /** Required for `wontdo` and `blocked`. */
    reason: z.string().trim().max(500).optional(),
    tags: z.array(text(40)).max(20).default([]),
    milestoneId: id.optional(),
    links: z.array(LinkSchema).max(20).default([]),
    start: ms.optional(),
    end: ms.optional(),
    scale: z.enum(['hour', 'day']).default('day'),
    createdAt: ms,
    updatedAt: ms,
    /** Stamped when the issue moves to done; cleared if it is reopened. */
    doneAt: ms.optional(),
  })
  .strict();
export type Issue = z.infer<typeof IssueSchema>;

export const MilestoneSchema = z
  .object({
    id,
    title: text(200),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due is YYYY-MM-DD'),
    createdAt: ms,
    updatedAt: ms,
  })
  .strict();
export type Milestone = z.infer<typeof MilestoneSchema>;

export const WinSchema = z.object({ id, at: ms, who: text(100), text: text(500) }).strict();
export type Win = z.infer<typeof WinSchema>;

export const BlockerSchema = z
  .object({
    id,
    since: ms,
    who: text(100),
    owner: text(100),
    sev: z.enum(['low', 'med', 'high']),
    text: text(500),
    clearedAt: ms.optional(),
    clearedBy: z.string().max(100).optional(),
  })
  .strict();
export type Blocker = z.infer<typeof BlockerSchema>;

/** Who recommends which option, and why. Written by the agent that raised the decision; the server never guesses one. */
export const RecommendationSchema = z
  .object({ option: text(200), reason: z.string().trim().max(300).default(''), by: text(100) })
  .strict();
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** The card text for a decision or a poll: a short summary, the recommendation and the trade-off of going the other way. */
export const CardNoteFields = {
  summary: z.string().trim().max(300).optional(),
  recommendation: RecommendationSchema.optional(),
  tradeoff: z.string().trim().max(300).optional(),
};
export const PollNoteSchema = z.object({ ...CardNoteFields, updatedAt: ms, updatedBy: z.string().max(100) }).strict();
export type PollNote = z.infer<typeof PollNoteSchema>;

export const DecisionOptionsSchema = z.array(text(200)).min(2, 'Give at least two decision options (CLI: repeat --option)').max(10)
  .refine(options => new Set(options.map(option => option.toLowerCase())).size === options.length, 'Decision options must be distinct');

export const DecisionSchema = z
  .object({
    id,
    text: text(500),
    where: z.string().trim().max(200).default(''),
    ...CardNoteFields,
    // Optional only for legacy stored/imported cards. New requests require choices.
    options: DecisionOptionsSchema.optional(),
    chosen: text(200).optional(),
    at: ms,
    clearedAt: ms.optional(),
    clearedBy: z.string().max(100).optional(),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export const AgentNoteSchema = z
  .object({
    focus: z.string().trim().max(500).default(''),
    receipts: z.array(text(300)).max(BOARD_LIMITS.receipts).default([]),
    updatedAt: ms,
    updatedBy: z.string().max(100),
  })
  .strict();
export type AgentNote = z.infer<typeof AgentNoteSchema>;

export const MarkSchema = z.object({ t: ms, label: text(100) }).strict();
export type Mark = z.infer<typeof MarkSchema>;

/** content.json's `plans` map: a plan label -> the account's human name and who runs on it. */
export const PlanNoteSchema = z.object({ name: z.string().max(100).default(''), who: z.string().max(300).default('') }).strict();
export type PlanNote = z.infer<typeof PlanNoteSchema>;

export const BoardStateSchema = z
  .object({
    version: z.literal(1),
    rev: z.number().int().nonnegative(),
    issues: z.array(IssueSchema).max(BOARD_LIMITS.issues),
    milestones: z.array(MilestoneSchema).max(BOARD_LIMITS.milestones),
    wins: z.array(WinSchema).max(BOARD_LIMITS.wins),
    blockers: z.array(BlockerSchema).max(BOARD_LIMITS.blockers),
    decisions: z.array(DecisionSchema).max(BOARD_LIMITS.decisions),
    /** Keyed by member (employee) id. */
    agents: z.record(z.string(), AgentNoteSchema),
    marks: z.array(MarkSchema).max(BOARD_LIMITS.marks),
    plans: z.record(z.string(), PlanNoteSchema),
    /** Card notes for chat polls, keyed `roomId:messageId` (the poll itself stays in the chat room). */
    pollNotes: z.record(z.string(), PollNoteSchema).default({}),
  })
  .strict();
export type BoardState = z.infer<typeof BoardStateSchema>;

export const emptyBoard = (): BoardState => ({
  version: 1,
  rev: 0,
  issues: [],
  milestones: [],
  wins: [],
  blockers: [],
  decisions: [],
  agents: {},
  marks: [],
  plans: {},
  pollNotes: {},
});

/** Ahead/behind, derived from issues with an `end` (never stored). */
export interface Pace {
  /** Issues whose end is at or before now (wontdo excluded). */
  plannedToDate: number;
  /** Of those, how many are done. */
  doneOfPlanned: number;
  /** End at or before now and not done. */
  overdue: number;
  /** Sum of (now - end) over the overdue issues, in hours (one decimal). */
  overdueHours: number;
  /** Done before their end. */
  early: number;
  verdict: 'ahead' | 'on-track' | 'behind';
}

export interface RosterRow {
  id: string;
  name: string;
  icon?: string;
  avatar?: string;
  position?: string;
  sessionId?: string;
  state: 'running' | 'idle' | 'gone';
  coordinator: boolean;
}

export interface PlanBurn {
  /** Latest actual five-hour reading. Percent of that provider window, not weekly points or token counts. */
  fiveHour?: { used: number | null; reset: number | null; asOf: number | null; stale: boolean };
  /** Plan account id (for sign-in) and its subscription profile id; profileId is null for an account that exists only as an acct directory. */
  id: string;
  profileId: string | null;
  provider: string;
  isDefault: boolean;
  authState?: 'signed-in' | 'signed-out' | 'unavailable' | 'error';
  usageError?: string;
  signedIn: boolean;
  label: string;
  name: string;
  who: string;
  used: number | null;
  rate: number | null;
  proj: number | null;
  weekStart: number | null;
  reset: number | null;
  runsOut: number | null;
  /** Where `rate` comes from ('recent' samples or the weekly 'average'), null when there is no rate yet. */
  burnBasis: 'recent' | 'average' | null;
  /** Points left in the week, hours to the reset and the steady rate that would use exactly the rest by then. */
  remainingPct: number | null;
  hoursToReset: number | null;
  sustainablePctPerHour: number | null;
  at: number;
  /** Codex banked resets the account holds (count and earliest expiry, epoch ms); null when not read or not Codex. */
  banked: { count: number; expiresAt: number | null } | null;
  points: { t: number; used: number; rate: number | null; proj: number | null }[];
  /** Per-session burn from status-line cost and the realtime plan rate (Claude Code plans only); null without cost reports. */
  agentBurn?: PlanAgentBurn | null;
}

export interface BoardPoll {
  roomId: string;
  room: string;
  messageId: string;
  /** When the poll was asked (the message time). */
  createdAt: number;
  question: string;
  options: { id: string; label: string; votes: number }[];
  multi: boolean;
  closesAt?: number;
  /** Option id the poll's author marked when posting it. */
  recommended?: string;
  summary?: string;
  recommendation?: Recommendation;
  tradeoff?: string;
  /** The owner's current vote (option ids); empty until the owner votes. Only filled for the owner's own view. */
  ownerVote: string[];
}

export interface BoardPin {
  roomId: string;
  room: string;
  messageId: string;
  text: string;
  by: string;
  at: number;
  kind: 'user' | 'agent';
}

/** GET /api/board. */
export interface BoardView extends BoardState {
  /** Startup-only write availability; not persisted Board data or an authority grant. */
  structuredDecisionWrites?: boolean;
  /** Current authenticated caller; derived by the Board's actual write gates. */
  capabilities?: import('./agent-capabilities.js').AgentCapabilities;
  built: number;
  timeZone: string;
  ownerName: string;
  roster: RosterRow[];
  /** Per-issue resolved display owner; never an authorization or stored-owner replacement. */
  ownerIds: Record<string, string>;
  /** Same gate as GET /api/plans: null unless the caller is an admin. */
  planBurn: PlanBurn[] | null;
  polls: BoardPoll[];
  pins: BoardPin[];
  pace: { owners: Record<string, Pace>; milestones: Record<string, Pace & { done: number; total: number }> };
}
