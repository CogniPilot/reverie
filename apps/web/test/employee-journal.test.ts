/** Synthetic messages and an in-memory store; ports the hands journal validation, gate and recall cases. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  asksToRemember, EmployeeJournalError, EmployeeJournalStore, JOURNAL_SAVES_PER_HOUR, RECALL_MAX_BYTES, RECALL_MAX_ENTRIES, readOnlyRequest, validateDraft,
  type JournalMessage, type ReadVisibleMessage,
} from '../src/employee-journal.js';

const ROOM = 'room-one';
const OWNER = 'owner';
const SELF = 'employee-one';

describe('employee journal store', () => {
  let clock: number; let store: EmployeeJournalStore; let messages: Map<string, JournalMessage>;
  const read: ReadVisibleMessage = (roomId, id) => { const message = messages.get(`${roomId}/${id}`); return message && { ...message }; };
  const message = (id: string, text: string, at: number, fromSelf = false) => messages.set(`${ROOM}/${id}`, { id, roomId: ROOM, at, text, fromSelf });
  const draft = (extra: Record<string, unknown> = {}) => ({ text: 'Agreed to post review records with exact UTC times.', tags: ['promise'],
    sources: [{ roomId: ROOM, id: 'm-source', quote: 'exact UTC times' }], ...extra });
  const refusal = (work: () => unknown) => { try { work(); } catch (err) { return err as EmployeeJournalError; } throw new Error('expected refusal'); };
  beforeEach(() => {
    clock = Date.parse('2026-10-30T04:00:00Z'); store = EmployeeJournalStore.open(':memory:', () => clock); messages = new Map();
    message('m-source', 'Please use exact UTC times in every record.', 100);
    message('m-turn', 'Remember this: records carry exact UTC times.', 200);
  });
  afterEach(() => store.close());

  it('caps recall at two entries and 8 KB, always keeping the best match', () => {
    for (const [i, at] of [[2, 300], [3, 400], [4, 500]] as const) message(`m-t${i}`, 'Remember this: records carry exact UTC times.', at);
    const long = 'exact UTC times ' + 'x'.repeat(1000);
    for (const turn of ['m-turn', 'm-t2', 'm-t3', 'm-t4'])
      store.save(OWNER, SELF, { roomId: ROOM, turnId: turn, draft: draft({ text: long.slice(0, 1000) }) }, read);
    const found = store.recall(OWNER, SELF, 'exact UTC times', read);
    expect(found.length).toBeLessThanOrEqual(RECALL_MAX_ENTRIES);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(RECALL_MAX_BYTES + 1024);
  });

  it('briefs keystone entries first, then the newest, without superseded ones, and counts every entry', () => {
    const turn = (id: string, at: number) => message(id, 'Remember this: records carry exact UTC times.', at);
    turn('m-t2', 300); turn('m-t3', 400); turn('m-t4', 500);
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn', draft: draft({ annotations: { importance: 'notable' } }) }, read);
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-t2', draft: draft({ text: 'Standing rule: James merges.', tags: ['decision'], annotations: { importance: 'keystone' } }) }, read);
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-t3', draft: draft({ text: 'Plain note.', tags: ['lesson'] }) }, read);
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-t4', draft: draft({ text: 'Corrects the first.', tags: ['correction'], annotations: { supersedes: [1] } }) }, read);
    const brief = store.brief(OWNER, SELF);
    expect(brief.total).toBe(4);
    expect(brief.entries.map((e) => [e.entryId, e.importance ?? null])).toEqual([[2, 'keystone'], [4, null], [3, null]]);
    expect(brief.entries[0]).toMatchObject({ text: 'Standing rule: James merges.', tags: ['decision'] });
    expect(store.brief(OWNER, SELF, 1).entries.map((e) => e.entryId)).toEqual([2]);
    expect(store.brief(OWNER, 'employee-two')).toEqual({ total: 0, entries: [] });
  });

  it('keeps the hands journal limits', () => {
    expect(validateDraft(draft()).tags).toEqual(['promise']);
    for (const bad of [
      draft({ text: 'x'.repeat(1025) }), draft({ text: ' ' }), draft({ tags: [] }), draft({ tags: ['promise', 'promise'] }), draft({ tags: ['rumor'] }),
      draft({ sources: [] }), draft({ sources: [{ roomId: ROOM, id: 'm-source', quote: 'q'.repeat(257) }] }),
      draft({ sources: [{ roomId: ROOM, id: 'm-source', quote: 'a' }, { roomId: ROOM, id: 'm-source', quote: 'b' }] }),
      draft({ sources: [{ id: 'm-source', quote: 'a' }] }), draft({ extra: true }),
      draft({ annotations: {} }), draft({ annotations: { topics: ['Gossip'] } }), draft({ annotations: { importance: 'huge' } }),
      draft({ annotations: { provenance: 'rumor' } }), draft({ annotations: { supersedes: [1] } }),
      draft({ annotations: { related: [0] } }), draft({ annotations: { reason: 'r'.repeat(201) } }),
    ]) expect(() => validateDraft(bad)).toThrow(EmployeeJournalError);
    expect(validateDraft(draft({ tags: ['correction'], annotations: { supersedes: [1], topics: ['Work'], importance: 'keystone', provenance: 'direct' } })).annotations)
      .toMatchObject({ supersedes: [1] });
  });

  it('recognizes explicit read-only and remember phrases only', () => {
    expect(readOnlyRequest('This is read-only, please.')).toBe(true);
    expect(readOnlyRequest("Don't write anything yet")).toBe(true);
    expect(readOnlyRequest('Write it up when you can')).toBe(false);
    expect(asksToRemember('Please remember this')).toBe(true);
    expect(asksToRemember('Do you remember the review?')).toBe(false);
  });

  it('saves with every gate passing, replays the same turn and refuses different content for it', () => {
    const saved = store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn', draft: draft() }, read);
    expect(saved).toMatchObject({ status: 'committed', entryId: 1, turnId: 'm-turn', replayed: false });
    expect(saved.gates.every(gate => gate.outcome === 'pass')).toBe(true);
    expect(store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn', draft: draft() }, read)).toMatchObject({ entryId: 1, replayed: true });
    const conflict = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn', draft: draft({ text: 'Different.' }) }, read));
    expect(conflict.status).toBe(409);
    const receipt = store.receipt(OWNER, SELF, 'm-turn');
    expect(receipt.status).toBe('committed');
    expect(receipt.entry?.payloadSha256).toBe(saved.payloadSha256);
    expect(receipt.attempts.map(attempt => attempt.outcome)).toEqual(['refused', 'replayed', 'committed']);
    expect(receipt.attempts[0]!.gates.find(gate => gate.gate === 'commit')).toMatchObject({ outcome: 'fail' });
  });

  it('applies the turn gates from the turn message and records each refusal', () => {
    message('m-ro', 'Read only: remember this but do not save it.', 300);
    const readOnly = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-ro', draft: draft() }, read));
    expect(readOnly.code).toBe('JOURNAL_READ_ONLY');
    expect(readOnly.gates?.map(gate => `${gate.gate}:${gate.outcome}`)).toEqual(['fields:pass', 'turn_readable:pass', 'read_only:fail',
      'reason:not_evaluated', 'source_window:not_evaluated', 'source_quote:not_evaluated', 'links:not_evaluated', 'commit:not_evaluated']);
    expect(store.receipt(OWNER, SELF, 'm-ro')).toMatchObject({ status: 'not_found', attempts: [{ outcome: 'refused' }] });

    message('m-plain', 'Thanks for the review.', 300);
    expect(refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-plain', draft: draft() }, read)).message).toBe('save_needs_reason_this_turn');
    expect(store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-plain', draft: draft({ annotations: { reason: 'A standing promise.' } }) }, read).status).toBe('committed');

    expect(refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-made-up', draft: draft() }, read)).code).toBe('JOURNAL_TURN_UNREADABLE');
    message('m-mine', 'Remember this, says me.', 300, true);
    expect(refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-mine', draft: draft() }, read)).code).toBe('JOURNAL_TURN_SELF');
  });

  it('checks every quote against the real message, within the turn window', () => {
    message('m-later', 'A later exact UTC times message.', 500);
    const late = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn',
      draft: draft({ sources: [{ roomId: ROOM, id: 'm-later', quote: 'exact UTC times' }] }) }, read));
    expect(late.code).toBe('JOURNAL_SOURCE_WINDOW');
    const missing = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn',
      draft: draft({ sources: [{ roomId: ROOM, id: 'm-nowhere', quote: 'exact' }] }) }, read));
    expect(missing.code).toBe('JOURNAL_SOURCE_WINDOW');
    const misquoted = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn',
      draft: draft({ sources: [{ roomId: ROOM, id: 'm-source', quote: 'approximate times' }] }) }, read));
    expect(misquoted.code).toBe('JOURNAL_SOURCE_QUOTE');
  });

  it('recalls own entries with sources re-checked now and the interpretation never verified', () => {
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn', draft: draft() }, read);
    const [entry] = store.recall(OWNER, SELF, 'UTC records', read);
    expect(entry).toMatchObject({ entryId: 1, committedAt: '2026-10-30T04:00:00.000Z', interpretation: "the agent's own account, not verified",
      sources: [{ status: 'checked', detail: 'quote matches' }] });
    message('m-source', 'Edited: use local times.', 100);
    expect(store.recall(OWNER, SELF, 'UTC', read)[0]!.sources[0]).toMatchObject({ status: 'unverified', detail: 'quote no longer matches' });
    messages.delete(`${ROOM}/m-source`);
    expect(store.recall(OWNER, SELF, 'UTC', read)[0]!.sources[0]).toMatchObject({ status: 'unverified', detail: 'message unavailable' });
    expect(store.recall(OWNER, 'employee-two', 'UTC', read)).toEqual([]);
    expect(store.recall('other-owner', SELF, 'UTC', read)).toEqual([]);
    expect(store.recall(OWNER, SELF, 'UTC', read, 'room-two')).toEqual([]);
  });

  it('links corrections only to earlier entries of the same journal and marks them superseded', () => {
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn', draft: draft() }, read);
    store.save(OWNER, 'employee-two', { roomId: ROOM, turnId: 'm-turn', draft: draft() }, read);
    message('m-fix', 'Remember this correction: it was 10 h, not an hour.', 300);
    const foreign = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-fix',
      draft: draft({ tags: ['correction'], annotations: { supersedes: [2] } }) }, read));
    expect(foreign.code).toBe('JOURNAL_LINK');
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-fix', draft: { text: 'It was 10 h, not an hour.', tags: ['correction'],
      sources: [{ roomId: ROOM, id: 'm-fix', quote: 'it was 10 h' }], annotations: { supersedes: [1], topics: ['Memory and harness'] } } }, read);
    const page = store.map(OWNER, SELF);
    expect(page).toMatchObject({ more: false, entries: [{ entryId: 3, topics: ['Memory and harness'], superseded: false }, { entryId: 1, superseded: true }] });
    expect(store.recall(OWNER, SELF, 'UTC', read)[0]!.supersededBy).toEqual([3]);
    expect(store.ownerPage(OWNER, SELF).entries.map(entry => entry.entryId)).toEqual([3, 1]);
  });

  it('refuses a link to an entry about a later turn than the one being saved', () => {
    message('m-late', 'Remember this: a later decision.', 500);
    store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-late', draft: draft() }, read);
    const backwards = refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-turn',
      draft: draft({ annotations: { related: [1] } }) }, read));
    expect(backwards.code).toBe('JOURNAL_LINK');
    expect(backwards.message).toBe('linked entry 1 is about a later turn than this one');
    expect(backwards.gates?.find(gate => gate.gate === 'links')).toMatchObject({ outcome: 'fail' });
    message('m-after', 'Remember this: it follows the later decision.', 600);
    expect(store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-after', draft: draft({ annotations: { related: [1] } }) }, read).status).toBe('committed');
  });

  it('pages the map and caps saves per hour', () => {
    for (let index = 0; index < JOURNAL_SAVES_PER_HOUR; index++) {
      message(`m-${index}`, 'Remember this.', 300 + index);
      store.save(OWNER, SELF, { roomId: ROOM, turnId: `m-${index}`, draft: draft() }, read);
    }
    message('m-over', 'Remember this.', 400);
    expect(refusal(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-over', draft: draft() }, read)).status).toBe(429);
    const first = store.map(OWNER, SELF);
    expect(first.entries).toHaveLength(20); expect(first.more).toBe(true);
    const second = store.map(OWNER, SELF, { before: first.entries.at(-1)!.entryId });
    expect(second.entries).toHaveLength(10); expect(second.more).toBe(false);
    clock += 3_600_001;
    expect(store.save(OWNER, SELF, { roomId: ROOM, turnId: 'm-over', draft: draft() }, read).status).toBe('committed');
  });
});
