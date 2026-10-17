/**
 * Regression tests for stripInkRedrawBloat() in session-routes.ts.
 *
 * Background: this helper trims the dense VPA (CSI n d) escape clusters that
 * Ink emits while animating the spinner / status bar so terminal-tail responses
 * stay manageable. The previous implementation collapsed *everything* after
 * the first VPA, which silently discarded 100KB+ of legitimate streamed
 * response text. The clustering rewrite shipped silently inside the v0.6.7
 * "chore: version packages" commit (dcc814f) — these tests lock the algorithm
 * down so neither the silent data-loss bug nor the threshold constants
 * (FRAME_GAP=8KB, MIN_BLOAT_SIZE=32KB) regress.
 *
 * Pure (string)=>string helper, no I/O — synchronous tests, no port needed.
 */

import { describe, it, expect } from 'vitest';
import { stripInkRedrawBloat } from '../src/web/routes/session-routes.js';

const VPA = '\x1b[10d'; // VPA escape: move cursor to row 10. 5 bytes.
const VPA_LEN = VPA.length;
// Single counting regex shared across tests so the no-control-regex
// disable lives in one place.
// eslint-disable-next-line no-control-regex
const VPA_RE = /\x1b\[\d+d/g;
function countVpa(s: string): number {
  return (s.match(VPA_RE) || []).length;
}

/** Build a buffer of `count` VPAs with `gap` bytes of filler between them. */
function vpaCluster(count: number, gap: number, fillerChar = ' '): string {
  const filler = fillerChar.repeat(gap);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) parts.push(filler);
    parts.push(VPA);
  }
  return parts.join('');
}

/** Span (bytes from first VPA's start to last VPA's start) of a cluster
 * built by vpaCluster(count, gap). */
function clusterSpan(count: number, gap: number): number {
  return (count - 1) * (gap + VPA_LEN);
}

describe('stripInkRedrawBloat', () => {
  // ─── Early-out paths ─────────────────────────────────────────────────────

  it('returns empty buffer unchanged', () => {
    expect(stripInkRedrawBloat('')).toBe('');
  });

  it('returns buffer with no VPA escapes unchanged', () => {
    const buf = 'Hello, this is a normal Claude response.\n'.repeat(100);
    expect(stripInkRedrawBloat(buf)).toBe(buf);
  });

  it('returns buffer with fewer than 10 VPAs unchanged (even if total is large)', () => {
    // 9 VPAs is below the early-out threshold; helper returns input verbatim
    // regardless of how much filler sits between them.
    const buf = vpaCluster(9, 50_000); // ~450KB of filler
    expect(stripInkRedrawBloat(buf)).toBe(buf);
  });

  // ─── Small cluster preserved ─────────────────────────────────────────────

  it('preserves a cluster smaller than MIN_BLOAT_SIZE (32KB span)', () => {
    // 50 VPAs, 100B apart -> span ~5.2KB, well under 32KB
    const cluster = vpaCluster(50, 100);
    expect(clusterSpan(50, 100)).toBeLessThan(32 * 1024);
    const buf = 'PREFIX\n' + cluster + '\nSUFFIX';
    expect(stripInkRedrawBloat(buf)).toBe(buf);
  });

  // ─── Big cluster collapsed ───────────────────────────────────────────────

  it('collapses a single big cluster but preserves bytes before and after', () => {
    // 50 VPAs, 700B apart -> span 49*(700+5) = 34_545B, comfortably over 32KB
    const cluster = vpaCluster(50, 700);
    expect(clusterSpan(50, 700)).toBeGreaterThanOrEqual(32 * 1024);
    const prefix = 'BEFORE_THE_BLOAT\n';
    const suffix = '\nAFTER_THE_BLOAT_THIS_IS_THE_RESPONSE_TEXT_THAT_USED_TO_BE_LOST';
    const buf = prefix + cluster + suffix;

    const out = stripInkRedrawBloat(buf);

    // Both ends survive — that was the silent bug
    expect(out.startsWith(prefix)).toBe(true);
    expect(out.endsWith(suffix)).toBe(true);
    // Output is much shorter than the input
    expect(out.length).toBeLessThan(buf.length);
    // Exactly one VPA remains (the last frame's), not all 50
    expect(countVpa(out)).toBe(1);
  });

  // ─── THE REGRESSION: response text BETWEEN big clusters survives ─────────

  it('preserves response text between two big clusters (the silent-data-loss bug)', () => {
    // Make each cluster large enough that an old "keep just the tail" approach
    // (the audit described it as "keep only the last 64KB after the first VPA")
    // would push any in-between response text out of the kept window.
    // 200 VPAs at 700B gap -> ~140KB span per cluster, total buffer >300KB.
    const clusterA = vpaCluster(200, 700);
    const clusterB = vpaCluster(200, 700);
    expect(clusterSpan(200, 700)).toBeGreaterThan(64 * 1024);

    const responseText =
      '\n\n## Here is my detailed answer\n\n' +
      'This is the kind of streamed response text that the old first-VPA\n' +
      'algorithm silently dropped. Multiple paragraphs of it. Indented blocks,\n' +
      'code samples, the entire conversation. Losing this was a silent bug\n' +
      'that the changelog mentioned but no test had ever locked down.\n\n' +
      '```ts\n' +
      'function example() { return 42; }\n' +
      '```\n\n' +
      'And a closing paragraph.';
    // Gap between clusters must exceed FRAME_GAP (8KB) so they're treated
    // as separate clusters, not merged into one giant one.
    const padded = responseText + '\n' + ' '.repeat(8 * 1024 + 100);
    const buf = 'INTRO\n' + clusterA + padded + clusterB + '\nOUTRO';
    expect(buf.length).toBeGreaterThan(280 * 1024); // sanity: well past any 64KB window

    const out = stripInkRedrawBloat(buf);

    // Every paragraph of response text survives intact. This is the assertion
    // that would have caught the silent-data-loss bug — under a "keep the last
    // 64KB after the first VPA" approach, all of responseText falls outside
    // the kept window and is lost.
    expect(out).toContain('Here is my detailed answer');
    expect(out).toContain('the old first-VPA');
    expect(out).toContain('function example() { return 42; }');
    expect(out).toContain('And a closing paragraph.');
    // Bookends survive too.
    expect(out.startsWith('INTRO\n')).toBe(true);
    expect(out.endsWith('\nOUTRO')).toBe(true);
    // Each big cluster collapses to a single VPA (its last frame).
    expect(countVpa(out)).toBe(2);
  });

  // ─── Mixed: small clusters preserved alongside big ones ──────────────────

  it('preserves small clusters when a big cluster is also present', () => {
    const small = vpaCluster(50, 100); // ~5.2KB span, kept as-is
    const big = vpaCluster(50, 700); // ~34KB span, collapsed
    // Separate them with > FRAME_GAP filler so they stay distinct clusters.
    const gap = ' '.repeat(8 * 1024 + 100);
    const buf = small + gap + 'MID_CONTENT' + gap + big + 'TAIL';

    const out = stripInkRedrawBloat(buf);

    // Small cluster survives intact: all 50 VPAs still there.
    // Big cluster collapsed to 1 VPA. Total = 50 + 1 = 51.
    expect(countVpa(out)).toBe(51);
    expect(out).toContain('MID_CONTENT');
    expect(out.endsWith('TAIL')).toBe(true);
  });

  // ─── FRAME_GAP boundary: two clusters separated by exactly > 8KB ─────────

  it('treats VPAs separated by > FRAME_GAP (8KB) as different clusters', () => {
    // Two big clusters with a 9KB gap between them must NOT be merged.
    const clusterA = vpaCluster(50, 700);
    const clusterB = vpaCluster(50, 700);
    const gap = ' '.repeat(9 * 1024); // > 8KB FRAME_GAP

    const buf = clusterA + gap + clusterB;
    const out = stripInkRedrawBloat(buf);

    // Two separate big clusters -> 2 VPAs survive.
    expect(countVpa(out)).toBe(2);
    // Gap content survives.
    expect(out).toContain(gap);
  });

  it('treats VPAs separated by <= FRAME_GAP (8KB) as the same cluster', () => {
    // Two would-be-separate clusters with a 1KB gap merge into one big cluster.
    const left = vpaCluster(30, 700);
    const right = vpaCluster(30, 700);
    const gap = ' '.repeat(1024); // well under 8KB FRAME_GAP
    const buf = left + gap + right;

    const out = stripInkRedrawBloat(buf);
    // Merged into one big cluster -> 1 VPA survives, gap content is gone too.
    expect(countVpa(out)).toBe(1);
  });

  // ─── Big cluster at end of buffer ────────────────────────────────────────

  it('preserves the last frame when a big cluster is at the end of the buffer', () => {
    const cluster = vpaCluster(50, 700);
    const buf = 'HEAD\n' + cluster;
    const out = stripInkRedrawBloat(buf);

    expect(out.startsWith('HEAD\n')).toBe(true);
    // Exactly one VPA (the last frame's) at the tail.
    expect(countVpa(out)).toBe(1);
    expect(out.endsWith(VPA)).toBe(true);
  });

  // ─── Idempotency ─────────────────────────────────────────────────────────

  it('is idempotent: stripping an already-stripped buffer is a no-op', () => {
    // After one pass a big cluster shrinks to ~1 VPA, putting the buffer
    // below the early-out threshold (positions.length < 10), so a second
    // pass returns it untouched.
    const buf = 'A' + vpaCluster(50, 700) + 'B';
    const once = stripInkRedrawBloat(buf);
    const twice = stripInkRedrawBloat(once);
    expect(twice).toBe(once);
  });

  // ─── Realistic size guardrail ────────────────────────────────────────────

  it('shrinks a 200KB Ink-bloat buffer down by an order of magnitude', () => {
    // Roughly the shape of a real "Claude is thinking" terminal buffer.
    const cluster = vpaCluster(300, 700); // ~210KB span
    const buf = 'Question: Tell me about TypeScript.\n' + cluster + '\nAnswer: TypeScript is...';

    const out = stripInkRedrawBloat(buf);
    expect(buf.length).toBeGreaterThan(200 * 1024);
    expect(out.length).toBeLessThan(buf.length / 10);
    expect(out).toContain('Question: Tell me about TypeScript.');
    expect(out).toContain('Answer: TypeScript is...');
  });
});
