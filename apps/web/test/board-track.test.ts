/**
 * A PR's track record: a text GO binds the exact body it read and an applied body is checked against it; a new head
 * supersedes every earlier review; each head's gate checklist starts open, never carried forward as covered.
 */
import { describe, expect, it } from 'vitest';
import { applyTrackOp, approvedBody, currentReviews, describeTrack, TrackError, type TrackOp, type TrackRecord } from '../src/board-track.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BODY = '1'.repeat(64);
const OTHER = '2'.repeat(64);
const run = (ops: TrackOp[], start?: TrackRecord) =>
  ops.reduce<TrackRecord | undefined>((t, op, i) => applyTrackOp(t, op, 'Reviewer', 1000 + i), start)!;

describe('track record', () => {
  it('a text GO binds its body; an applied body says whether it is the approved one', () => {
    const track = run([
      { op: 'head', sha: A, branch: 'feature' },
      { op: 'review', head: A, kind: 'source', verdict: 'GO' },
      { op: 'review', head: A, kind: 'text', verdict: 'GO', bodySha256: BODY },
      { op: 'applied', head: A, bodySha256: OTHER },
      { op: 'applied', head: A, bodySha256: BODY },
    ]);
    expect(approvedBody(track)).toBe(BODY);
    expect(track.applied.map((a) => a.approved)).toEqual([false, true]);
    expect(describeTrack(track)).toEqual(
      expect.arrayContaining(['body applied 11111111: approved when applied', 'body 11111111: approved now'])
    );
  });

  it('refuses a text review with no body digest and a source review with one', () => {
    const track = run([{ op: 'head', sha: A }]);
    expect(() => applyTrackOp(track, { op: 'review', head: A, kind: 'text', verdict: 'GO' }, 'R', 1)).toThrow(TrackError);
    expect(() =>
      applyTrackOp(track, { op: 'review', head: A, kind: 'source', verdict: 'GO', bodySha256: BODY }, 'R', 1)
    ).toThrow(TrackError);
  });

  it('a later text HOLD withdraws the approval', () => {
    const track = run([
      { op: 'head', sha: A },
      { op: 'review', head: A, kind: 'text', verdict: 'GO', bodySha256: BODY },
      { op: 'review', head: A, kind: 'text', verdict: 'HOLD', bodySha256: BODY },
      { op: 'applied', head: A, bodySha256: BODY },
    ]);
    expect(approvedBody(track)).toBeUndefined();
    expect(track.applied[0]!.approved).toBe(false);
  });

  it('a new head supersedes every earlier review, so an old GO never reads as current', () => {
    const track = run([
      { op: 'head', sha: A },
      { op: 'review', head: A, kind: 'source', verdict: 'GO' },
      { op: 'review', head: A, kind: 'text', verdict: 'GO', bodySha256: BODY },
      { op: 'head', sha: B },
      { op: 'applied', head: B, bodySha256: BODY },
    ]);
    expect(track.reviews.every((r) => r.supersededAt !== undefined)).toBe(true);
    expect(currentReviews(track)).toEqual([]);
    expect(approvedBody(track)).toBeUndefined();
    expect(track.applied[0]).toMatchObject({ head: B, approved: false });
    expect(describeTrack(track)).toEqual(expect.arrayContaining(['source: no current review', '2 earlier review(s) superseded by a later head']));
  });

  it('refuses a review of a head that is not the latest, and the same head twice', () => {
    const track = run([{ op: 'head', sha: A }, { op: 'head', sha: B }]);
    expect(() => applyTrackOp(track, { op: 'review', head: A, kind: 'source', verdict: 'GO' }, 'R', 1)).toThrow(/latest head/);
    expect(() => applyTrackOp(track, { op: 'head', sha: B.slice(0, 8) }, 'R', 1)).toThrow(/already the latest head/);
    // A short id of the latest head reviews it.
    expect(applyTrackOp(track, { op: 'review', head: B.slice(0, 8), kind: 'source', verdict: 'GO' }, 'R', 1).reviews[0]!.head).toBe(B);
  });

  it('each head starts every gate named so far as open, never carried forward as covered', () => {
    const track = run([
      { op: 'head', sha: A },
      { op: 'gate', head: A, name: 'nix test registration', state: 'covered', note: 'partition test green' },
      { op: 'gate', head: A, name: 'legacy backend freeze', state: 'n/a' },
      { op: 'head', sha: B },
    ]);
    expect(track.heads[0]!.gates.map((g) => g.state)).toEqual(['covered', 'n/a']);
    expect(track.heads[1]!.gates.map((g) => [g.name, g.state])).toEqual([
      ['nix test registration', 'open'],
      ['legacy backend freeze', 'open'],
    ]);
    const updated = applyTrackOp(track, { op: 'gate', head: B, name: 'nix test registration', state: 'covered' }, 'R', 9);
    expect(updated.heads[1]!.gates[0]!.state).toBe('covered');
    expect(track.heads[1]!.gates[0]!.state).toBe('open');
  });

  it('keeps approval-when-applied as history and computes current approval: a later HOLD shows', () => {
    const track = run([
      { op: 'head', sha: A },
      { op: 'review', head: A, kind: 'text', verdict: 'GO', bodySha256: BODY },
      { op: 'applied', head: A, bodySha256: BODY },
      { op: 'review', head: A, kind: 'text', verdict: 'HOLD', bodySha256: BODY },
    ]);
    expect(track.applied[0]!.approved).toBe(true);
    const lines = describeTrack(track);
    expect(lines).toContain('body applied 11111111: approved when applied');
    expect(lines).toContain('body 11111111: NOT approved now (no current text GO)');
    expect(lines.join('\n')).not.toMatch(/approved now$/m);
  });

  it('a GO for another body after the old one was applied says the applied body is not approved now', () => {
    const track = run([
      { op: 'head', sha: A },
      { op: 'review', head: A, kind: 'text', verdict: 'GO', bodySha256: BODY },
      { op: 'applied', head: A, bodySha256: BODY },
      { op: 'review', head: A, kind: 'text', verdict: 'GO', bodySha256: OTHER },
    ]);
    expect(describeTrack(track)).toEqual(
      expect.arrayContaining([
        'body applied 11111111: approved when applied',
        'body 11111111: NOT approved now (the current text GO is for body 22222222)',
      ])
    );
  });

  it('refuses a gate result or applied body meant for an older head, leaving the latest head unchanged', () => {
    const track = run([
      { op: 'head', sha: A },
      { op: 'gate', head: A, name: 'nix test registration', state: 'open' },
      { op: 'head', sha: B },
    ]);
    // A check started on A finishes after B landed: it must not mark B.
    expect(() =>
      applyTrackOp(track, { op: 'gate', head: A, name: 'nix test registration', state: 'covered', note: 'checked A' }, 'R', 9)
    ).toThrow(/older head/);
    expect(() => applyTrackOp(track, { op: 'applied', head: A.slice(0, 8), bodySha256: BODY }, 'R', 9)).toThrow(/older head/);
    expect(track.heads[1]!.gates).toEqual([expect.objectContaining({ name: 'nix test registration', state: 'open' })]);
    expect(track.applied).toEqual([]);
    expect(applyTrackOp(track, { op: 'gate', head: B.slice(0, 8), name: 'nix test registration', state: 'covered' }, 'R', 9)
      .heads[1]!.gates[0]!.state).toBe('covered');
  });

  it('needs a head before a review, a body or a gate', () => {
    for (const op of [
      { op: 'review', head: A, kind: 'source', verdict: 'GO' },
      { op: 'applied', head: A, bodySha256: BODY },
      { op: 'gate', head: A, name: 'g', state: 'open' },
    ] as TrackOp[])
      expect(() => applyTrackOp(undefined, op, 'R', 1)).toThrow(/Record the head/);
  });
});
