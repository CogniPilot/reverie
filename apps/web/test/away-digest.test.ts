import { describe, expect, it } from 'vitest';
import { buildAwayDigest, resolveAwayDigestRange } from '../src/web/away-digest.js';
import type { LifecycleEntry, RunSummary } from '../src/types.js';

const NOW = Date.UTC(2026, 5, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function summary(sessionId: string, events: RunSummary['events']): RunSummary {
  return {
    sessionId,
    sessionName: `${sessionId} name`,
    startedAt: NOW - 4 * HOUR,
    lastUpdatedAt: NOW - HOUR,
    events,
    stats: {
      totalRespawnCycles: 0,
      totalTokensUsed: 0,
      peakTokens: 0,
      totalTimeActiveMs: 0,
      totalTimeIdleMs: 0,
      errorCount: events.filter((event) => event.severity === 'error').length,
      warningCount: events.filter((event) => event.severity === 'warning').length,
      aiCheckCount: 0,
      lastIdleAt: null,
      lastWorkingAt: null,
      stateTransitions: 0,
    },
  };
}

describe('away digest', () => {
  it('resolves since-last-visit after the stored marker and defaults to 24h', () => {
    expect(resolveAwayDigestRange({ range: 'since-last-visit', lastViewed: NOW - HOUR, now: NOW })).toMatchObject({
      range: 'since-last-visit',
      since: NOW - HOUR,
      until: NOW,
    });

    expect(resolveAwayDigestRange({ range: 'since-last-visit', now: NOW })).toMatchObject({
      since: NOW - 24 * HOUR,
      until: NOW,
    });
  });

  it('separates action-required, completed, live, idle, and informational items', () => {
    const lifecycleEntries: LifecycleEntry[] = [
      { ts: NOW - 10_000, event: 'exit', sessionId: 'failed', name: 'Failed Session', exitCode: 2 },
      { ts: NOW - 9_000, event: 'exit', sessionId: 'clean', name: 'Clean Exit', exitCode: 0 },
      { ts: NOW - 8_000, event: 'mux_died', sessionId: 'mux', name: 'Mux Session' },
    ];

    const digest = buildAwayDigest({
      range: resolveAwayDigestRange({ range: '1h', now: NOW }),
      lifecycleEntries,
      runSummaries: [
        summary('ralph', [
          {
            id: 'complete-1',
            timestamp: NOW - 7_000,
            type: 'ralph_completion',
            severity: 'success',
            title: 'Ralph completion detected',
            details: 'Phrase: COMPLETE',
          },
        ]),
        summary('error-session', [
          {
            id: 'error-1',
            timestamp: NOW - 6_000,
            type: 'error',
            severity: 'error',
            title: 'Session error',
            details: 'Tool failed',
          },
        ]),
      ],
      sessions: [
        { id: 'active', name: 'Active Session', status: 'working' },
        { id: 'idle', name: 'Idle Session', status: 'idle' },
      ],
      dailyTokenStats: [
        {
          date: '2026-06-07',
          inputTokens: 1_000,
          outputTokens: 2_000,
          estimatedCost: 0.18,
          sessions: 2,
        },
      ],
      subagents: [
        {
          id: 'agent-1',
          sessionId: 'active',
          description: 'Research complete',
          status: 'completed',
          lastUpdated: NOW - 5_000,
        },
      ],
      now: NOW,
    });

    expect(digest.sections.needsAttention.map((item) => item.sessionId)).toEqual(['failed', 'mux', 'error-session']);
    expect(digest.sections.completed.map((item) => item.sessionId)).toEqual(['ralph']);
    expect(digest.sections.stillRunning.map((item) => item.sessionId)).toEqual(['active']);
    expect(digest.sections.idle.map((item) => item.sessionId)).toEqual(['idle']);
    expect(digest.sections.informational.map((item) => item.sessionId)).toContain('clean');
    expect(digest.sections.informational.some((item) => item.source === 'subagent')).toBe(true);
    expect(digest.totals).toMatchObject({
      needsAttention: 3,
      completed: 1,
      activeSessions: 2,
      inputTokens: 1_000,
      outputTokens: 2_000,
      estimatedCost: 0.18,
      tokenWindowPrecision: 'day',
    });
    expect(digest.dataFreshness).toMatchObject({
      lifecyclePersisted: true,
      tokenStatsPersisted: true,
      runSummariesLiveOnly: true,
      subagentsLiveOnly: true,
    });
  });

  it('excludes entries outside the selected range', () => {
    const digest = buildAwayDigest({
      range: resolveAwayDigestRange({ range: '1h', now: NOW }),
      lifecycleEntries: [
        { ts: NOW - 2 * HOUR, event: 'mux_died', sessionId: 'old' },
        { ts: NOW - 1000, event: 'mux_died', sessionId: 'recent' },
      ],
      runSummaries: [],
      sessions: [],
      dailyTokenStats: [],
      subagents: [],
      now: NOW,
    });

    expect(digest.sections.needsAttention.map((item) => item.sessionId)).toEqual(['recent']);
  });
});
