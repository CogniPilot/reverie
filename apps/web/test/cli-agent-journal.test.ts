import { describe, expect, it } from 'vitest';
import { agentJournalMap, agentJournalRecall, agentJournalSave, elapsed } from '../src/cli-agent-journal.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';

function fixture(json: boolean, reply: { status: number; json: Record<string, unknown> }) {
  const output: string[] = [], errors: string[] = [], calls: RequestOptions[] = [];
  const deps: AgentDeps = { ctx: { selfId: 'self-session', apiUrl: 'http://synthetic.test' }, json, now: () => Date.parse('2026-10-30T14:00:00Z'),
    io: { out: text => output.push(text), err: text => errors.push(text) },
    request: async (_ctx, request) => { calls.push(request); return { status: reply.status, text: '', json: reply.json as never }; } };
  return { deps, output, errors, calls };
}
const entry = { entryId: 4, turnId: 'm-turn', roomId: 'room-one', committedAt: '2026-10-30T04:00:00.000Z', text: 'Re-test ran.', tags: ['lesson'],
  supersededBy: [], interpretation: "the agent's own account, not verified",
  sources: [{ roomId: 'room-one', id: 'm-source', quote: 're-test', status: 'checked', detail: 'quote matches' }] };

describe('journal CLI', () => {
  it('shows exact UTC times with a coarse elapsed time', () => {
    const now = Date.parse('2026-10-30T14:00:00Z');
    expect(elapsed('2026-10-30T04:00:00.000Z', now)).toBe('10 h ago');
    expect(elapsed('2026-10-30T13:59:30.000Z', now)).toBe('just now');
    expect(elapsed('2026-10-27T14:00:00.000Z', now)).toBe('3 d ago');
    expect(elapsed('2026-10-30T15:00:00.000Z', now)).toBe('time unknown');
  });

  it('pairs each source with its quote and names no employee in the request', async () => {
    const f = fixture(true, { status: 200, json: { success: true, data: { entryId: 1, turnId: 'm-turn', replayed: false, payloadSha256: 'a'.repeat(64) } } });
    expect(await agentJournalSave(f.deps, { room: 'room-one', turn: 'm-turn', text: 'T', tag: ['lesson'], source: ['m-a', 'm-b'], quote: ['qa', 'qb'], reason: 'why' })).toBe(0);
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/agent/journal/save', body: { roomId: 'room-one', turnId: 'm-turn',
      draft: { sources: [{ roomId: 'room-one', id: 'm-a', quote: 'qa' }, { roomId: 'room-one', id: 'm-b', quote: 'qb' }], annotations: { reason: 'why' } } } });
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('employee');
    const unpaired = fixture(true, { status: 200, json: { success: true } });
    expect(await agentJournalSave(unpaired.deps, { room: 'r', turn: 't', text: 'T', tag: ['lesson'], source: ['m-a'], quote: [] })).toBe(4);
    expect(unpaired.calls).toHaveLength(0);
  });

  it('prints refusals with their gates, and recall rows with source status and the unverified interpretation', async () => {
    const refused = fixture(false, { status: 403, json: { success: false, error: 'save_needs_reason_this_turn',
      gates: [{ gate: 'reason', outcome: 'fail', detail: 'save_needs_reason_this_turn' }] } });
    expect(await agentJournalSave(refused.deps, { room: 'r', turn: 't', text: 'T', tag: ['lesson'], source: ['m'], quote: ['q'] })).toBe(4);
    expect(refused.errors.join('\n')).toContain('reason: fail');
    const recall = fixture(false, { status: 200, json: { success: true, data: { entries: [entry] } } });
    expect(await agentJournalRecall(recall.deps, ['re-test'])).toBe(0);
    expect(recall.output[0]).toContain('#4 2026-10-30T04:00:00.000Z (10 h ago) [lesson]');
    expect(recall.output[0]).toContain('source room-one/m-source: checked (quote matches)');
    expect(recall.output[0]).toContain("interpretation: the agent's own account, not verified");
    const map = fixture(false, { status: 200, json: { success: true, data: { more: true, entries: [
      { entryId: 4, committedAt: entry.committedAt, roomId: 'room-one', tags: ['lesson'], topics: ['Work'], superseded: true }] } } });
    expect(await agentJournalMap(map.deps, [], {})).toBe(0);
    expect(map.output[0]).toBe('#4 2026-10-30T04:00:00.000Z (10 h ago) lesson · Work [superseded]\nmore: older entries exist (--before 4)');
  });
});
