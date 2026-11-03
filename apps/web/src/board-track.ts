/**
 * @fileoverview A pull request's track record, kept on its Board card: the heads it went through, the reviews of each
 * head, the PR bodies applied, and a per-head checklist of the gates a branch run does not prove. It replaces binding
 * heads, approvals and bodies again by hand from chat each time a PR moves.
 *
 * Three rules hold here, not in callers:
 * - A text GO names the exact body (sha256) it approved, and recording an applied body says whether a current text GO
 *   approved that exact body.
 * - A new head supersedes every review of an earlier head, so an old approval never reads as current.
 * - Each head starts its checklist with every gate named so far set to `open`: a pass on an earlier head is never
 *   carried forward as covered.
 *
 * Pure: the board route applies these inside its serialized write, and stamps who and when from the caller.
 */
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'A commit is 7-64 lowercase hex characters');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'A body digest is 64 lowercase hex characters (sha256)');
const ms = z.number().int().nonnegative();
const label = (max: number) => z.string().trim().min(1).max(max);
const ref = z.object({ roomId: label(100), messageId: label(100) }).strict();

/** Caps: a write past one is refused, never made room for by dropping older entries. */
export const TRACK_LIMITS = { heads: 50, reviews: 200, applied: 50, gates: 20 };
export const GATE_STATES = ['open', 'covered', 'n/a'] as const;
export const REVIEW_KINDS = ['source', 'text'] as const;
export const REVIEW_VERDICTS = ['GO', 'HOLD'] as const;

const GateSchema = z
  .object({ name: label(80), state: z.enum(GATE_STATES), note: label(300).optional(), at: ms, by: label(100) })
  .strict();
const HeadSchema = z.object({ sha, at: ms, by: label(100), gates: z.array(GateSchema).max(TRACK_LIMITS.gates) }).strict();
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
  .object({ head: sha, bodySha256: sha256, approved: z.boolean(), at: ms, by: label(100) })
  .strict();

export const TrackRecordSchema = z
  .object({
    branch: label(100).optional(),
    heads: z.array(HeadSchema).max(TRACK_LIMITS.heads),
    reviews: z.array(ReviewSchema).max(TRACK_LIMITS.reviews),
    applied: z.array(AppliedSchema).max(TRACK_LIMITS.applied),
  })
  .strict();
export type TrackRecord = z.infer<typeof TrackRecordSchema>;

/** One change to a track record, as the route accepts it; who and when come from the caller, never the body. */
export const TrackOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('head'), sha, branch: label(100).optional() }).strict(),
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
  z.object({ op: z.literal('applied'), bodySha256: sha256 }).strict(),
  z.object({ op: z.literal('gate'), name: label(80), state: z.enum(GATE_STATES), note: label(300).optional() }).strict(),
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
    case 'head': {
      if (head && sameCommit(head.sha, op.sha)) throw new TrackError(`${op.sha} is already the latest head`, 409);
      if (track.heads.length >= TRACK_LIMITS.heads) throw new TrackError('This track has the most heads it can hold', 409);
      for (const review of track.reviews) if (!review.supersededAt) review.supersededAt = at;
      const gates = (head?.gates ?? []).map((g) => ({ name: g.name, state: 'open' as const, at, by }));
      track.heads.push({ sha: op.sha, at, by, gates });
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
      if (!head) throw new TrackError('Record the head before applying a body', 409);
      if (track.applied.length >= TRACK_LIMITS.applied) throw new TrackError('This track has the most bodies it can hold', 409);
      track.applied.push({ head: head.sha, bodySha256: op.bodySha256, approved: approvedBody(track) === op.bodySha256, at, by });
      return track;
    }
    case 'gate': {
      if (!head) throw new TrackError('Record the head before checking a gate', 409);
      const gate = { name: op.name, state: op.state, ...(op.note ? { note: op.note } : {}), at, by };
      const i = head.gates.findIndex((g) => g.name === op.name);
      if (i >= 0) head.gates[i] = gate;
      else if (head.gates.length >= TRACK_LIMITS.gates) throw new TrackError('This head has the most gates it can hold', 409);
      else head.gates.push(gate);
      return track;
    }
  }
}

/** Plain lines for `reverie board track show`: the latest head, its current reviews and body, and its gates. */
export function describeTrack(track: TrackRecord | undefined): string[] {
  const head = latestHead(track);
  if (!track || !head) return ['No track record yet.'];
  const lines = [`head ${head.sha}${track.branch ? ` (${track.branch})` : ''}, ${track.heads.length} head(s) so far`];
  const reviews = currentReviews(track);
  for (const kind of REVIEW_KINDS) {
    const last = reviews.filter((r) => r.kind === kind).at(-1);
    lines.push(`${kind}: ${last ? `${last.verdict} by ${last.by}${last.bodySha256 ? ` on body ${last.bodySha256.slice(0, 8)}` : ''}` : 'no current review'}`);
  }
  const superseded = track.reviews.filter((r) => r.supersededAt).length;
  if (superseded) lines.push(`${superseded} earlier review(s) superseded by a later head`);
  const applied = track.applied.filter((a) => sameCommit(a.head, head.sha)).at(-1);
  if (applied)
    lines.push(`body applied ${applied.bodySha256.slice(0, 8)}: ${applied.approved ? 'matches the approved body' : 'NOT the approved body'}`);
  for (const gate of head.gates) lines.push(`gate ${gate.name}: ${gate.state}${gate.note ? ` (${gate.note})` : ''}`);
  return lines;
}
