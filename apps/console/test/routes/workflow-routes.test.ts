/**
 * Route tests for the ultracode workflow endpoints:
 *   GET /api/workflows            → run summaries (no agents[])
 *   GET /api/workflows/:runId     → full run (with agents[]) or 404
 *
 * Uses app.inject() — no real ports. The workflow-run-watcher singleton is mocked
 * so we control the returned data (positive + not-found) without touching ~/.claude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';
import { vi } from 'vitest';

// ── Mocks required by registerSystemRoutes ──────────────────────────
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(async () => '{}'), writeFile: vi.fn(async () => undefined) },
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});
vi.mock('../../src/subagent-watcher.js', () => ({
  subagentWatcher: {
    getSubagents: vi.fn(() => []),
    getRecentSubagents: vi.fn(() => []),
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock('../../src/image-watcher.js', () => ({
  imageWatcher: { isRunning: vi.fn(() => false), start: vi.fn(), stop: vi.fn(), watchSession: vi.fn() },
}));
vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn(() => ({ log: vi.fn(), query: vi.fn(async () => []) })),
}));
vi.mock('../../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => false),
  resolveOpenCodeDir: vi.fn(() => null),
}));

const SUMMARY = {
  runId: 'wf_abc123',
  workflowName: 'review-open-prs',
  status: 'completed',
  summary: 'Deep review',
  agentCount: 2,
  totalTokens: 1000,
  totalToolCalls: 10,
  phases: [{ title: 'Review', detail: 'one per PR' }],
  sessionUuid: 'sess-1',
  projectHash: 'proj-1',
  lastActivityAt: 123,
};
const FULL_RUN = {
  ...SUMMARY,
  agents: [
    {
      index: 1,
      label: 'review:pr-1',
      phaseIndex: 1,
      phaseTitle: 'Review',
      model: 'opus',
      state: 'done',
      tokens: 500,
      toolCalls: 5,
    },
    {
      index: 2,
      label: 'review:pr-2',
      phaseIndex: 1,
      phaseTitle: 'Review',
      model: 'opus',
      state: 'done',
      tokens: 500,
      toolCalls: 5,
    },
  ],
};

vi.mock('../../src/workflow-run-watcher.js', () => ({
  workflowRunWatcher: {
    getAllRunSummaries: vi.fn(() => [SUMMARY]),
    getRecentRunSummaries: vi.fn(() => [SUMMARY]),
    getRun: vi.fn((runId: string) => (runId === 'wf_abc123' ? FULL_RUN : undefined)),
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

describe('workflow routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
  });
  afterEach(async () => {
    await harness.app.close();
  });

  it('GET /api/workflows returns the envelope with summaries (no agents[])', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].runId).toBe('wf_abc123');
    expect('agents' in body.data[0]).toBe(false);
  });

  it('GET /api/workflows/:runId returns the full run with agents[]', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/workflows/wf_abc123' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.agents).toHaveLength(2);
    expect(body.data.agents[0].tokens).toBe(500);
  });

  it('GET /api/workflows/:runId 404s for an unknown run', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/workflows/wf_nope' });
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });
});
