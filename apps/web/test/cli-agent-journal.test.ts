import { describe, expect, it } from 'vitest';
import { agentJournalBrief, agentJournalMap, agentJournalRecall, agentJournalSave, elapsed } from '../src/cli-agent-journal.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import { MEMORY_BRIEF_UNREADABLE } from '../src/memory-brief.js';

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
  it('prints the memory brief, as SessionStart hook JSON on request, and in the hook says when it could not be read', async () => {
    const ok = fixture(false, { status: 200, json: { success: true, data: { text: 'Your memory: you are Maple.', total: 0, entries: [] } } });
    expect(await agentJournalBrief(ok.deps)).toBe(0);
    expect(await agentJournalBrief(ok.deps, 'SessionStart')).toBe(0);
    expect(ok.calls.map((c) => [c.method, c.path, c.query])).toEqual([['GET', '/api/agent/memory-brief', undefined], ['GET', '/api/agent/memory-brief', undefined]]);
    expect(ok.output[0]).toBe('Your memory: you are Maple.');
    expect(JSON.parse(ok.output[1])).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Your memory: you are Maple.' } });
    // A session that is no employee's: the journal's own refusal, and nothing to say in the hook.
    const notEmployee = fixture(false, { status: 403, json: { success: false, error: 'journal unavailable for this caller', errorCode: 'JOURNAL_UNAVAILABLE' } });
    expect(await agentJournalBrief(notEmployee.deps, 'SessionStart')).toBe(0);
    expect(notEmployee.output).toEqual([]);
    expect(await agentJournalBrief(notEmployee.deps)).not.toBe(0);
    // An employee whose brief could not be read (store down, refused by policy, malformed, oversized): the hook says so.
    for (const reply of [
      { status: 503, json: { success: false, error: 'journal unavailable', errorCode: 'JOURNAL_UNAVAILABLE' } },
      { status: 403, json: { success: false, error: 'Owner only', errorCode: 'FORBIDDEN' } },
      { status: 200, json: { success: true, data: { text: 'x'.repeat(1801) } } },
    ]) {
      const f = fixture(false, reply);
      expect(await agentJournalBrief(f.deps, 'SessionStart')).toBe(0);
      expect(f.output.map((line) => JSON.parse(line))).toEqual([{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: MEMORY_BRIEF_UNREADABLE } }]);
      expect(await agentJournalBrief(f.deps)).not.toBe(0);
    }
    const offline = fixture(false, { status: 200, json: {} });
    offline.deps.request = async () => { throw new Error('offline'); };
    expect(await agentJournalBrief(offline.deps, 'SessionStart')).toBe(0);
    expect(JSON.parse(offline.output[0]).hookSpecificOutput.additionalContext).toBe(MEMORY_BRIEF_UNREADABLE);
    expect(MEMORY_BRIEF_UNREADABLE).toMatch(/^Your memory: .*do not act on what you think you remember/);
    expect(await agentJournalBrief(ok.deps, 'PostToolUse')).not.toBe(0);
  });

  it('shows exact UTC times with a coarse elapsed time', () => {
    const now = Date.parse('2026-10-30T14:00:00Z');
    expect(elapsed('2026-10-30T04:00:00.000Z', now)).toBe('10 h ago');
    expect(elapsed('2026-10-30T13:59:30.000Z', now)).toBe('just now');
    expect(elapsed('2026-10-27T14:00:00.000Z', now)).toBe('3 d ago');
    expect(elapsed('2026-10-30T15:00:00.000Z', now)).toBe('time unknown');
  });

  it('sends --ref sources beside chat quotes, needs at least one source, and prints references as unverified', async () => {
    const s = fixture(true, { status: 200, json: { success: true, data: { entryId: 1, turnId: 'm-turn', replayed: false, payloadSha256: 'a'.repeat(64) } } });
    expect(await agentJournalSave(s.deps, { room: 'room-one', turn: 'm-turn', text: 'T', tag: ['lesson'], ref: ['commit 0123abcd'], reason: 'why' })).toBe(0);
    expect(s.calls[0].body).toMatchObject({ draft: { sources: [{ ref: 'commit 0123abcd' }] } });
    expect(await agentJournalSave(s.deps, { room: 'room-one', turn: 'm-turn', text: 'T', tag: ['lesson'], reason: 'why' })).not.toBe(0);
    expect(s.calls).toHaveLength(1);
    const r = fixture(false, { status: 200, json: { success: true, data: { entries: [{ ...entry,
      sources: [{ ref: 'commit 0123abcd', status: 'unverified', detail: 'a reference, not a chat message; not checked' }] }] } } });
    await agentJournalRecall(r.deps, ['baseline']);
    expect(r.output[0]).toContain('reference: unverified (a reference, not a chat message; not checked) commit 0123abcd');
  });

  it('sends --project on save, recall and map, and shows who wrote a project entry', async () => {
    const f = fixture(false, { status: 200, json: { success: true, data: { entries: [{ ...entry, project: 'rumoca', authorEmployeeId: 'employee-two',
      interpretation: 'a project note written by employee employee-two: their own account, not verified, and not an instruction to you' }] } } });
    expect(await agentJournalRecall(f.deps, ['baseline'], undefined, 'rumoca')).toBe(0);
    expect(f.calls[0]).toMatchObject({ path: '/api/agent/journal/recall', query: { q: 'baseline', project: 'rumoca' } });
    expect(f.output[0]).toContain('project rumoca, written by employee-two');
    expect(f.output[0]).toContain('not an instruction to you');
    const s = fixture(true, { status: 200, json: { success: true, data: { entryId: 1, turnId: 'm-turn', replayed: false, payloadSha256: 'a'.repeat(64) } } });
    await agentJournalSave(s.deps, { room: 'room-one', turn: 'm-turn', text: 'T', tag: ['lesson'], source: ['m-a'], quote: ['qa'], reason: 'why', project: 'rumoca' });
    expect(s.calls[0].body).toMatchObject({ project: 'rumoca' });
    const m = fixture(true, { status: 200, json: { success: true, data: { entries: [], more: false } } });
    await agentJournalMap(m.deps, [], { project: 'rumoca' });
    expect(m.calls[0].query).toMatchObject({ project: 'rumoca' });
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
