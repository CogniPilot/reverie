/**
 * @fileoverview A pull request's track record, kept on its Board card: the heads it went through, the reviews of each
 * head, the PR bodies applied, and a per-head checklist of the gates a branch run does not prove. It replaces binding
 * heads, approvals and bodies again by hand from chat each time a PR moves.
 *
 * Three rules hold here, not in callers:
 * - A text GO names the exact body (sha256) it approved, and recording an applied body says whether a current text GO
 *   approved that exact body. That answer is kept as history; whether the body is approved now is always computed
 *   from the current reviews, so a later HOLD or a GO for another body shows.
 * - A new head supersedes every review of an earlier head, so an old approval never reads as current.
 * - Each head starts its checklist with every gate named so far set to `open`: a pass on an earlier head is never
 *   carried forward as covered.
 * - A gate result and an applied body name the head they are for, and are refused unless it is the latest head, so a
 *   check that finishes after a new head lands cannot mark the new head.
 * - The pull request's repository and number are set once and never change. CI results are observations stamped with
 *   who recorded them and when, bound to the latest head and appended, never authority to merge.
 *
 * Pure: the board route applies these inside its serialized write, and stamps who and when from the caller.
 */
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'A commit is 7-64 lowercase hex characters');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'A body digest is 64 lowercase hex characters (sha256)');
const ms = z.number().int().nonnegative();
const label = (max: number) => z.string().trim().min(1).max(max);
const ref = z.object({ roomId: label(100), messageId: label(100) }).strict();
const repository = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'A repository is owner/name');
/** Plain http(s) URLs only, as everywhere on the board. */
const httpUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'A link is an http(s) URL');

/** Caps: a write past one is refused, never made room for by dropping older entries. */
export const TRACK_LIMITS = { heads: 50, reviews: 200, applied: 50, gates: 20, ci: 50 };
export const GATE_STATES = ['open', 'covered', 'n/a'] as const;
export const REVIEW_KINDS = ['source', 'text'] as const;
export const REVIEW_VERDICTS = ['GO', 'HOLD'] as const;
export const CI_CONCLUSIONS = ['success', 'failure', 'cancelled', 'pending', 'skipped'] as const;

const GateSchema = z
  .object({ name: label(80), state: z.enum(GATE_STATES), note: label(300).optional(), at: ms, by: label(100) })
  .strict();
const CiSchema = z
  .object({ name: label(80), conclusion: z.enum(CI_CONCLUSIONS), url: httpUrl.optional(), at: ms, by: label(100) })
  .strict();
const HeadSchema = z
  .object({
    sha,
    /** The commit the head was built on, when the author names it. */
    base: sha.optional(),
    /** sha256 of the sealed packet's SHA256SUMS manifest for this head. */
    seal: sha256.optional(),
    at: ms,
    by: label(100),
    gates: z.array(GateSchema).max(TRACK_LIMITS.gates),
    /** CI results as observed, appended in order; never authority to merge. */
    ci: z.array(CiSchema).max(TRACK_LIMITS.ci).default([]),
  })
  .strict();
const ReviewSchema = z
  .object({
    head: sha,
    kind: z.enum(REVIEW_KINDS),
    verdict: z.enum(REVIEW_VERDICTS),
    /** Required for a text review: the exact body it read. */
    bodySha256: sha256.optional(),
    /** The chat message carrying the verdict. */
    source: ref.optional(),
    at: ms,
    by: label(100),
    /** Stamped when a later head lands. */
    supersededAt: ms.optional(),
  })
  .strict();
const AppliedSchema = z
  .object({
    head: sha,
    bodySha256: sha256,
    /** Whether a current text GO approved this body when it was applied: history, not the current state. */
    approved: z.boolean(),
    at: ms,
    by: label(100),
  })
  .strict();

export const TrackRecordSchema = z
  .object({
    /** The pull request this card tracks; set once. */
    pr: z.object({ repository, number: z.number().int().positive() }).strict().optional(),
    branch: label(100).optional(),
    heads: z.array(HeadSchema).max(TRACK_LIMITS.heads),
    reviews: z.array(ReviewSchema).max(TRACK_LIMITS.reviews),
    applied: z.array(AppliedSchema).max(TRACK_LIMITS.applied),
  })
  .strict();
export type TrackRecord = z.infer<typeof TrackRecordSchema>;

/** One change to a track record, as the route accepts it; who and when come from the caller, never the body. */
export const TrackOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('identify'), repository, number: z.number().int().positive() }).strict(),
  z
    .object({ op: z.literal('head'), sha, branch: label(100).optional(), base: sha.optional(), seal: sha256.optional() })
    .strict(),
  z
    .object({
      op: z.literal('review'),
      head: sha,
      kind: z.enum(REVIEW_KINDS),
      verdict: z.enum(REVIEW_VERDICTS),
      bodySha256: sha256.optional(),
      source: ref.optional(),
    })
    .strict(),
  z.object({ op: z.literal('applied'), head: sha, bodySha256: sha256 }).strict(),
  z
    .object({ op: z.literal('gate'), head: sha, name: label(80), state: z.enum(GATE_STATES), note: label(300).optional() })
    .strict(),
  z
    .object({ op: z.literal('ci'), head: sha, name: label(80), conclusion: z.enum(CI_CONCLUSIONS), url: httpUrl.optional() })
    .strict(),
]);
export type TrackOp = z.infer<typeof TrackOpSchema>;

export class TrackError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const empty = (): TrackRecord => ({ heads: [], reviews: [], applied: [] });
/** Two spellings of one commit (a short and a full id) are the same head. */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Refuse a write meant for a head that is no longer the latest (a check or body that arrived late). */
function requireLatest<H extends { sha: string }>(head: H | undefined, intended: string, what: string): H {
  if (!head) throw new TrackError(`Record the head before ${what}`, 409);
  if (!sameCommit(head.sha, intended))
    throw new TrackError(`The latest head is ${head.sha}, not ${intended}; ${what} is for an older head`, 409);
  return head;
}

export function latestHead(track: TrackRecord | undefined) {
  return track?.heads.at(-1);
}

/** Reviews of the latest head that no later head superseded. */
export function currentReviews(track: TrackRecord | undefined) {
  const head = latestHead(track);
  return head ? track!.reviews.filter((r) => !r.supersededAt && sameCommit(r.head, head.sha)) : [];
}

/** The body digest of the newest current text GO, if any. A text HOLD after it withdraws it. */
export function approvedBody(track: TrackRecord | undefined): string | undefined {
  const text = currentReviews(track).filter((r) => r.kind === 'text');
  const last = text.at(-1);
  return last?.verdict === 'GO' ? last.bodySha256 : undefined;
}

/**
 * Apply one change, returning the new record (the input is not changed). `by` and `at` describe the caller; the route
 * decides beforehand whether the caller may make this kind of change.
 */
export function applyTrackOp(current: TrackRecord | undefined, op: TrackOp, by: string, at: number): TrackRecord {
  const track = structuredClone(current ?? empty());
  const head = latestHead(track);
  switch (op.op) {
    case 'identify': {
      if (track.pr && (track.pr.repository !== op.repository || track.pr.number !== op.number))
        throw new TrackError(`This card already tracks ${track.pr.repository}#${track.pr.number}`, 409);
      track.pr = { repository: op.repository, number: op.number };
      return track;
    }
    case 'head': {
      if (head && sameCommit(head.sha, op.sha)) throw new TrackError(`${op.sha} is already the latest head`, 409);
      if (track.heads.length >= TRACK_LIMITS.heads) throw new TrackError('This track has the most heads it can hold', 409);
      for (const review of track.reviews) if (!review.supersededAt) review.supersededAt = at;
      const gates = (head?.gates ?? []).map((g) => ({ name: g.name, state: 'open' as const, at, by }));
      track.heads.push({
        sha: op.sha,
        ...(op.base ? { base: op.base } : {}),
        ...(op.seal ? { seal: op.seal } : {}),
        at,
        by,
        gates,
        ci: [],
      });
      if (op.branch) track.branch = op.branch;
      return track;
    }
    case 'review': {
      if (!head) throw new TrackError('Record the head before reviewing it', 409);
      if (!sameCommit(head.sha, op.head))
        throw new TrackError(`The latest head is ${head.sha}, not ${op.head}; review the latest head`, 409);
      if (op.kind === 'text' && !op.bodySha256) throw new TrackError('A text review names the body sha256 it read', 400);
      if (op.kind === 'source' && op.bodySha256) throw new TrackError('A source review carries no body digest', 400);
      if (track.reviews.length >= TRACK_LIMITS.reviews) throw new TrackError('This track has the most reviews it can hold', 409);
      track.reviews.push({
        head: head.sha,
        kind: op.kind,
        verdict: op.verdict,
        ...(op.bodySha256 ? { bodySha256: op.bodySha256 } : {}),
        ...(op.source ? { source: op.source } : {}),
        at,
        by,
      });
      return track;
    }
    case 'applied': {
      const latest = requireLatest(head, op.head, 'applying a body');
      if (track.applied.length >= TRACK_LIMITS.applied) throw new TrackError('This track has the most bodies it can hold', 409);
      track.applied.push({ head: latest.sha, bodySha256: op.bodySha256, approved: approvedBody(track) === op.bodySha256, at, by });
      return track;
    }
    case 'gate': {
      const latest = requireLatest(head, op.head, 'checking a gate');
      const gate = { name: op.name, state: op.state, ...(op.note ? { note: op.note } : {}), at, by };
      const i = latest.gates.findIndex((g) => g.name === op.name);
      if (i >= 0) latest.gates[i] = gate;
      else if (latest.gates.length >= TRACK_LIMITS.gates) throw new TrackError('This head has the most gates it can hold', 409);
      else latest.gates.push(gate);
      return track;
    }
    case 'ci': {
      const latest = requireLatest(head, op.head, 'recording a CI result');
      // A head stored before CI results existed has no list yet.
      const observed = (latest.ci ??= []);
      if (observed.length >= TRACK_LIMITS.ci) throw new TrackError('This head has the most CI results it can hold', 409);
      observed.push({ name: op.name, conclusion: op.conclusion, ...(op.url ? { url: op.url } : {}), at, by });
      return track;
    }
  }
}

/**
 * The applied body on two lines: whether it was approved when applied (history), and whether it is approved now
 * (computed from the current reviews, so a later HOLD or a GO for another body shows).
 */
function describeApplied(track: TrackRecord, applied: TrackRecord['applied'][number]): string[] {
  const body = applied.bodySha256.slice(0, 8);
  const current = approvedBody(track);
  const now =
    current === applied.bodySha256
      ? 'approved now'
      : current
        ? `NOT approved now (the current text GO is for body ${current.slice(0, 8)})`
        : 'NOT approved now (no current text GO)';
  return [`body applied ${body}: ${applied.approved ? 'approved when applied' : 'NOT approved when applied'}`, `body ${body}: ${now}`];
}

/** Plain lines for `reverie board track show`: the latest head, its current reviews and body, and its gates. */
export function describeTrack(track: TrackRecord | undefined): string[] {
  const head = latestHead(track);
  if (!track || !head) return ['No track record yet.'];
  const lines = [
    ...(track.pr ? [`pull request ${track.pr.repository}#${track.pr.number}`] : []),
    `head ${head.sha}${track.branch ? ` (${track.branch})` : ''}, ${track.heads.length} head(s) so far`,
    ...(head.base ? [`base ${head.base}`] : []),
    ...(head.seal ? [`packet seal ${head.seal.slice(0, 8)}`] : []),
  ];
  const reviews = currentReviews(track);
  for (const kind of REVIEW_KINDS) {
    const last = reviews.filter((r) => r.kind === kind).at(-1);
    lines.push(`${kind}: ${last ? `${last.verdict} by ${last.by}${last.bodySha256 ? ` on body ${last.bodySha256.slice(0, 8)}` : ''}` : 'no current review'}`);
  }
  const superseded = track.reviews.filter((r) => r.supersededAt).length;
  if (superseded) lines.push(`${superseded} earlier review(s) superseded by a later head`);
  const applied = track.applied.filter((a) => sameCommit(a.head, head.sha)).at(-1);
  if (applied) lines.push(...describeApplied(track, applied));
  for (const gate of head.gates) lines.push(`gate ${gate.name}: ${gate.state}${gate.note ? ` (${gate.note})` : ''}`);
  // The newest observation per check, labelled as what it is.
  const latestCi = new Map((head.ci ?? []).map((c) => [c.name, c]));
  for (const c of latestCi.values()) lines.push(`CI ${c.name}: ${c.conclusion} (observed by ${c.by}; not merge authority)`);
  return lines;
}
