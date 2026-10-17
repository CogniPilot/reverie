import type { LifecycleEntry, RunSummary, RunSummaryEvent, TokenUsageEntry } from '../types.js';

export type AwayDigestRangeName = 'since-last-visit' | '1h' | 'today' | '24h' | 'custom';
export type AwayDigestCategory = 'needs_attention' | 'completed' | 'still_running' | 'idle' | 'informational';
export type AwayDigestSectionName = 'needsAttention' | 'completed' | 'stillRunning' | 'idle' | 'informational';
export type AwayDigestSeverity = 'info' | 'success' | 'warning' | 'error';
export type AwayDigestSource = 'lifecycle' | 'run_summary' | 'status' | 'token_stats' | 'subagent';
export type AwayDigestTokenWindowPrecision = 'day' | 'none';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const VALID_RANGES = new Set<AwayDigestRangeName>(['since-last-visit', '1h', 'today', '24h', 'custom']);

export interface AwayDigestRange {
  range: AwayDigestRangeName;
  since: number;
  until: number;
}

export interface AwayDigestRangeInput {
  range?: string;
  since?: number;
  until?: number;
  lastViewed?: number;
  now?: number;
}

export interface AwayDigestSession {
  id: string;
  name?: string;
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
}

export interface AwayDigestSubagent {
  id?: string;
  agentId?: string;
  sessionId?: string;
  description?: string;
  status?: string;
  lastUpdated?: number;
  updatedAt?: number;
  completedAt?: number;
  modifiedAt?: number;
  lastActivityAt?: number;
}

export interface AwayDigestItem {
  id: string;
  sessionId?: string;
  sessionName?: string;
  timestamp: number;
  category: AwayDigestCategory;
  severity: AwayDigestSeverity;
  title: string;
  detail?: string;
  source: AwayDigestSource;
  link?: {
    type: 'session' | 'run_summary' | 'lifecycle' | 'notification';
    sessionId?: string;
  };
}

export interface AwayDigestTotals {
  sessionsCreated: number;
  sessionsExited: number;
  activeSessions: number;
  needsAttention: number;
  completed: number;
  errors: number;
  warnings: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  tokenWindowPrecision: AwayDigestTokenWindowPrecision;
}

export interface AwayDigestResponse {
  range: AwayDigestRange;
  generatedAt: number;
  dataFreshness: {
    lifecyclePersisted: true;
    tokenStatsPersisted: true;
    runSummariesLiveOnly: true;
    subagentsLiveOnly: true;
  };
  totals: AwayDigestTotals;
  sections: Record<AwayDigestSectionName, AwayDigestItem[]>;
}

export interface AwayDigestInput {
  range: AwayDigestRange;
  lifecycleEntries: LifecycleEntry[];
  runSummaries: RunSummary[];
  sessions: AwayDigestSession[];
  dailyTokenStats: TokenUsageEntry[];
  subagents: AwayDigestSubagent[];
  now?: number;
}

export function resolveAwayDigestRange(input: AwayDigestRangeInput): AwayDigestRange {
  const now = input.now ?? Date.now();
  const range = (input.range ?? 'since-last-visit') as AwayDigestRangeName;
  if (!VALID_RANGES.has(range)) {
    throw new Error(`Invalid away digest range: ${input.range}`);
  }

  let since: number;
  const until = finiteOrDefault(input.until, now);

  switch (range) {
    case 'since-last-visit':
      since = finiteOrDefault(input.lastViewed, now - DAY_MS);
      break;
    case '1h':
      since = now - HOUR_MS;
      break;
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      since = start.getTime();
      break;
    }
    case '24h':
      since = now - DAY_MS;
      break;
    case 'custom':
      if (!Number.isFinite(input.since)) {
        throw new Error('Custom away digest range requires a finite since timestamp');
      }
      since = input.since as number;
      break;
  }

  if (until < since) {
    throw new Error('Away digest until timestamp must be greater than or equal to since');
  }

  return { range, since, until };
}

export function buildAwayDigest(input: AwayDigestInput): AwayDigestResponse {
  const now = input.now ?? Date.now();
  const sections: Record<AwayDigestSectionName, AwayDigestItem[]> = {
    needsAttention: [],
    completed: [],
    stillRunning: [],
    idle: [],
    informational: [],
  };

  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const lifecycleEntries = input.lifecycleEntries.filter((entry) => isInRange(entry.ts, input.range));

  for (const entry of lifecycleEntries) {
    addItem(sections, lifecycleEntryToItem(entry));
  }

  for (const summary of input.runSummaries) {
    for (const event of summary.events) {
      if (!isInRange(event.timestamp, input.range)) continue;
      addItem(sections, runSummaryEventToItem(summary, event));
    }
  }

  for (const session of input.sessions) {
    const item = sessionToItem(session, now);
    addItem(sections, item);
  }

  for (const subagent of input.subagents) {
    const timestamp = subagentTimestamp(subagent, now);
    if (!isInRange(timestamp, input.range) || subagent.status !== 'completed') continue;
    addItem(sections, subagentToItem(subagent, sessionsById, timestamp));
  }

  const tokenTotals = aggregateTokenStats(input.dailyTokenStats, input.range);
  const totals = calculateTotals(sections, lifecycleEntries, input.sessions, tokenTotals);

  return {
    range: input.range,
    generatedAt: now,
    dataFreshness: {
      lifecyclePersisted: true,
      tokenStatsPersisted: true,
      runSummariesLiveOnly: true,
      subagentsLiveOnly: true,
    },
    totals,
    sections,
  };
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function isInRange(timestamp: number, range: AwayDigestRange): boolean {
  return timestamp >= range.since && timestamp <= range.until;
}

function addItem(sections: Record<AwayDigestSectionName, AwayDigestItem[]>, item: AwayDigestItem): void {
  sections[sectionNameForCategory(item.category)].push(item);
}

function sectionNameForCategory(category: AwayDigestCategory): AwayDigestSectionName {
  switch (category) {
    case 'needs_attention':
      return 'needsAttention';
    case 'still_running':
      return 'stillRunning';
    case 'completed':
    case 'idle':
    case 'informational':
      return category;
  }
}

function lifecycleEntryToItem(entry: LifecycleEntry): AwayDigestItem {
  const needsAttention = entry.event === 'mux_died' || (entry.event === 'exit' && (entry.exitCode ?? 0) !== 0);
  return {
    id: `lifecycle-${entry.ts}-${entry.event}-${entry.sessionId}`,
    sessionId: entry.sessionId,
    sessionName: entry.name,
    timestamp: entry.ts,
    category: needsAttention ? 'needs_attention' : 'informational',
    severity: needsAttention ? 'error' : entry.event === 'exit' ? 'info' : 'info',
    title: lifecycleTitle(entry),
    detail: lifecycleDetail(entry),
    source: 'lifecycle',
    link: { type: 'lifecycle', sessionId: entry.sessionId },
  };
}

function lifecycleTitle(entry: LifecycleEntry): string {
  if (entry.event === 'exit') {
    return (entry.exitCode ?? 0) === 0 ? 'Session exited' : 'Session exited with error';
  }
  if (entry.event === 'mux_died') return 'Tmux session died';
  return `Session ${entry.event.replaceAll('_', ' ')}`;
}

function lifecycleDetail(entry: LifecycleEntry): string | undefined {
  if (entry.reason) return entry.reason;
  if (entry.event === 'exit' && entry.exitCode !== undefined && entry.exitCode !== null) {
    return `Exit code ${entry.exitCode}`;
  }
  return undefined;
}

function runSummaryEventToItem(summary: RunSummary, event: RunSummaryEvent): AwayDigestItem {
  const category = runSummaryCategory(event);
  return {
    id: `run-summary-${summary.sessionId}-${event.id}`,
    sessionId: summary.sessionId,
    sessionName: summary.sessionName,
    timestamp: event.timestamp,
    category,
    severity: runSummarySeverity(event, category),
    title: event.title,
    detail: event.details,
    source: 'run_summary',
    link: { type: 'run_summary', sessionId: summary.sessionId },
  };
}

function runSummaryCategory(event: RunSummaryEvent): AwayDigestCategory {
  if (event.type === 'ralph_completion') return 'completed';
  if (event.severity === 'error' || event.severity === 'warning' || event.type === 'state_stuck') {
    return 'needs_attention';
  }
  return 'informational';
}

function runSummarySeverity(event: RunSummaryEvent, category: AwayDigestCategory): AwayDigestSeverity {
  if (category === 'completed') return 'success';
  return event.severity;
}

function sessionToItem(session: AwayDigestSession, now: number): AwayDigestItem {
  const isIdle = session.status === 'idle';
  return {
    id: `status-${session.id}`,
    sessionId: session.id,
    sessionName: session.name,
    timestamp: now,
    category: isIdle ? 'idle' : 'still_running',
    severity: isIdle ? 'info' : 'success',
    title: isIdle ? 'Session idle' : 'Session still running',
    detail: session.status ? `Status: ${session.status}` : undefined,
    source: 'status',
    link: { type: 'session', sessionId: session.id },
  };
}

function subagentToItem(
  subagent: AwayDigestSubagent,
  sessionsById: Map<string, AwayDigestSession>,
  timestamp: number
): AwayDigestItem {
  const session = subagent.sessionId ? sessionsById.get(subagent.sessionId) : undefined;
  const agentId = subagent.id ?? subagent.agentId ?? 'unknown';
  return {
    id: `subagent-${agentId}`,
    sessionId: subagent.sessionId,
    sessionName: session?.name,
    timestamp,
    category: 'informational',
    severity: 'success',
    title: 'Subagent completed',
    detail: subagent.description,
    source: 'subagent',
    link: subagent.sessionId ? { type: 'session', sessionId: subagent.sessionId } : undefined,
  };
}

function subagentTimestamp(subagent: AwayDigestSubagent, fallback: number): number {
  return (
    subagent.completedAt ??
    subagent.lastUpdated ??
    subagent.updatedAt ??
    subagent.modifiedAt ??
    subagent.lastActivityAt ??
    fallback
  );
}

function aggregateTokenStats(
  dailyTokenStats: TokenUsageEntry[],
  range: AwayDigestRange
): { inputTokens: number; outputTokens: number; estimatedCost: number; precision: AwayDigestTokenWindowPrecision } {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCost = 0;

  for (const day of dailyTokenStats) {
    if (!dayOverlapsRange(day.date, range)) continue;
    inputTokens += day.inputTokens;
    outputTokens += day.outputTokens;
    estimatedCost += day.estimatedCost;
  }

  return {
    inputTokens,
    outputTokens,
    estimatedCost,
    precision: inputTokens > 0 || outputTokens > 0 || estimatedCost > 0 ? 'day' : 'none',
  };
}

function dayOverlapsRange(date: string, range: AwayDigestRange): boolean {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = dayStart + DAY_MS - 1;
  return dayStart <= range.until && dayEnd >= range.since;
}

function calculateTotals(
  sections: Record<AwayDigestSectionName, AwayDigestItem[]>,
  lifecycleEntries: LifecycleEntry[],
  sessions: AwayDigestSession[],
  tokenTotals: ReturnType<typeof aggregateTokenStats>
): AwayDigestTotals {
  const allItems = Object.values(sections).flat();
  return {
    sessionsCreated: lifecycleEntries.filter((entry) => entry.event === 'created').length,
    sessionsExited: lifecycleEntries.filter((entry) => entry.event === 'exit').length,
    activeSessions: sessions.length,
    needsAttention: sections.needsAttention.length,
    completed: sections.completed.length,
    errors: allItems.filter((item) => item.severity === 'error').length,
    warnings: allItems.filter((item) => item.severity === 'warning').length,
    inputTokens: tokenTotals.inputTokens,
    outputTokens: tokenTotals.outputTokens,
    estimatedCost: tokenTotals.estimatedCost,
    tokenWindowPrecision: tokenTotals.precision,
  };
}
