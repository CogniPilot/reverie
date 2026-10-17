/**
 * Covers `queryTmuxWindowSize()`, the helper extracted from `_attachToMux`
 * in PR #80 ("prevent tmux flicker on restart by matching existing window size").
 *
 * Before #80, the PTY was hardcoded to 120x40 on every attach. If a previous
 * client had resized the tmux window to e.g. 200x50, the re-attach would
 * shrink the window back to 120x40, then xterm.js would resize it again on
 * the next frame — visible flicker and one lost repaint of scrollback.
 *
 * The fix queries tmux for the actual window geometry first via
 * `tmux -L <socket> display -t <name> -p '#{window_width} #{window_height}'`
 * (the `-L <socket>` targets the isolated Codeman socket). We cover:
 *   - Happy path: tmux reports valid geometry → those numbers are used.
 *   - Browser-resize-between-attaches: tmux reports a non-default size
 *     (because a prior client resized it) → the helper picks that up.
 *   - Query-then-die race: tmux dies between query and attach → the query
 *     either throws or returns garbage; either way the helper falls back to
 *     120x40 so the attach can still proceed (the pty.spawn that follows has
 *     its own try/catch for the actual failed-attach case).
 *   - Defensive paths: empty output, non-numeric output, zero/negative
 *     dimensions, trailing whitespace.
 *   - Security: muxName is passed as an argv element (no shell), so a
 *     malicious mux name can't inject options.
 *
 * Strategy: mock `node:child_process.execFileSync` and assert both the call
 * shape (argv, timeout) and the parsed return.
 *
 * Port: N/A (no server / no real tmux)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync };
});

import { queryTmuxWindowSize } from '../src/session.js';

const DEFAULT = { cols: 120, rows: 40 };

beforeEach(() => {
  execFileSync.mockReset();
});

describe('queryTmuxWindowSize — happy path', () => {
  it('returns the geometry tmux reports', () => {
    execFileSync.mockReturnValue('200 50\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual({ cols: 200, rows: 50 });
  });

  it('picks up a non-default size left behind by a prior client (browser-resize-between-attaches)', () => {
    // Scenario: client A attached at 220x60, resized tmux to that, then disconnected.
    // tmux keeps the last-attached geometry. Client B re-attaches and should spawn
    // its PTY at 220x60, not 120x40 — that's the whole point of #80.
    execFileSync.mockReturnValue('220 60');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual({ cols: 220, rows: 60 });
  });

  it('tolerates trailing whitespace and newlines in tmux output', () => {
    execFileSync.mockReturnValue('  180 45  \n\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual({ cols: 180, rows: 45 });
  });
});

describe('queryTmuxWindowSize — fallback paths', () => {
  it('falls back to 120x40 when tmux exits non-zero (process not found)', () => {
    // execFileSync throws when the child exits non-zero. Simulates `tmux` binary
    // missing or `display -t` failing because the target session doesn't exist.
    execFileSync.mockImplementation(() => {
      const err = new Error('Command failed: tmux display -t bogus') as Error & { status: number };
      err.status = 1;
      throw err;
    });
    expect(queryTmuxWindowSize('bogus', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when tmux dies between query and parse (ETIMEDOUT / ENOENT)', () => {
    // Query-then-die race: simulates the tmux server being killed mid-call.
    execFileSync.mockImplementation(() => {
      const err = new Error('spawn ETIMEDOUT') as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      throw err;
    });
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when tmux returns empty output', () => {
    execFileSync.mockReturnValue('');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when tmux returns whitespace-only output', () => {
    execFileSync.mockReturnValue('   \n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when tmux returns non-numeric output', () => {
    execFileSync.mockReturnValue('not a size\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when only one dimension is present', () => {
    execFileSync.mockReturnValue('200\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when a dimension is zero (degenerate geometry)', () => {
    // tmux reporting `0` would crash node-pty downstream — must not propagate.
    execFileSync.mockReturnValue('0 40\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
    execFileSync.mockReturnValue('120 0\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when a dimension is negative', () => {
    execFileSync.mockReturnValue('-200 -50\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });

  it('falls back when tmux returns NaN-producing tokens', () => {
    execFileSync.mockReturnValue('abc def\n');
    expect(queryTmuxWindowSize('codeman-abc', 'codeman')).toEqual(DEFAULT);
  });
});

describe('queryTmuxWindowSize — call shape', () => {
  it('invokes tmux on the dedicated socket via argv (not a shell)', () => {
    execFileSync.mockReturnValue('120 40\n');
    queryTmuxWindowSize('codeman-abc', 'codeman');
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = execFileSync.mock.calls[0];
    expect(bin).toBe('tmux');
    // `-L <socket>` MUST lead: querying the default server would never find a
    // session that lives on the isolated Codeman socket (the #80 regression).
    expect(argv).toEqual(['-L', 'codeman', 'display', '-t', 'codeman-abc', '-p', '#{window_width} #{window_height}']);
    // execFileSync — not execSync — so muxName is never substituted into a shell string.
    expect(opts).toMatchObject({ encoding: 'utf8' });
  });

  it('uses a bounded timeout so a hung tmux server cannot block startup forever', () => {
    execFileSync.mockReturnValue('120 40\n');
    queryTmuxWindowSize('codeman-abc', 'codeman');
    const [, , opts] = execFileSync.mock.calls[0];
    // Whatever the exact constant, the contract is: ≤5s so the user-visible
    // attach path can't hang on a stuck tmux server.
    expect(typeof opts?.timeout).toBe('number');
    expect(opts?.timeout).toBeGreaterThan(0);
    expect(opts?.timeout).toBeLessThanOrEqual(5000);
  });

  it('passes a muxName that looks like a tmux flag as an argv element (no option injection)', () => {
    execFileSync.mockReturnValue('120 40\n');
    queryTmuxWindowSize('-x 1 -y 1; rm -rf', 'codeman');
    const [, argv] = execFileSync.mock.calls[0];
    // The whole "name" lives in a single argv slot (index 4, after `-L codeman
    // display -t`), so tmux interprets it as a target session name, not as
    // additional flags. The `-t` flag preceding it pins it as the target.
    expect(argv?.[4]).toBe('-x 1 -y 1; rm -rf');
    expect((argv as string[]).indexOf('-x')).toBe(-1);
  });
});
