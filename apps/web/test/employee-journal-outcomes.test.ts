/**
 * Promises and outcomes in the employee journal: a promise may carry a due time, and a later entry records how a promise
 * or decision turned out. The state is derived, never stored on the promise, and every view derives it only from the
 * entries it may see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EmployeeJournalStore, JOURNAL_OUTCOMES_SHOWN, isJournalDue, normalizeJournalDue,
  type JournalAnnotations, type JournalMessage, type ReadVisibleMessage,
} from '../src/employee-journal.js';

const require = createRequire(import.meta.url);
const OWNER = 'owner';
const SELF = 'employee-one';
const ROOM = 'room-a';
const OTHER_ROOM = 'room-b';
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'journal-outcomes-'));
  dirs.push(dir);
  const file = join(dir, 'journal.sqlite');
  let now = Date.parse('2026-11-01T12:00:00Z');
  let n = 0;
  const messages = new Map<string, JournalMessage>();
  const read: ReadVisibleMessage = (room, id) => { const message = messages.get(`${room}/${id}`); return message && { ...message }; };
  let store = EmployeeJournalStore.open(file, () => now);
  /** A "Remember this" turn quoting `text`, then the save; returns the entry id or throws the refusal. */
  const save = (text: string, options: { tags?: string[]; annotations?: JournalAnnotations; room?: string; employee?: string; owner?: string; project?: string; turnAt?: number } = {}) => {
    n += 1; now += HOUR;
    const room = options.room ?? ROOM, turn = `t-${n}`;
    messages.set(`${room}/${turn}`, { id: turn, roomId: room, at: options.turnAt ?? now, text: `Remember this: ${text}`, fromSelf: false });
    return store.save(options.owner ?? OWNER, options.employee ?? SELF, { roomId: room, turnId: turn, ...(options.project ? { project: options.project } : {}),
      draft: { text, tags: options.tags ?? ['decision'], sources: [{ roomId: room, id: turn, quote: text.slice(0, 30) }],
        ...(options.annotations ? { annotations: options.annotations } : {}) } }, read).entryId;
  };
  const refusal = (work: () => unknown) => { try { work(); } catch (err) { return err as { status: number; code: string; message: string }; } throw new Error('expected a refusal'); };
  const recall = (words: string, room?: string) => store.recall(OWNER, SELF, words, read, room);
  const rows = () => {
    const db = new (require('node:sqlite').DatabaseSync)(file);
    try { return db.prepare('SELECT entry_id, target_id, status FROM journal_outcomes ORDER BY entry_id').all() as Array<{ entry_id: number; target_id: number; status: string }>; }
    finally { db.close(); }
  };
  return { file, read, save, refusal, recall, rows, messages, store: () => store, now: () => now, setNow: (ms: number) => { now = ms; },
    restart: () => { store.close(); store = EmployeeJournalStore.open(file, () => now); }, close: () => store.close() };
}

describe('journal promises and outcomes', () => {
  it('closes a promise once, records the outcome in the same commit, and replays without a second row', () => {
    const f = fixture();
    const promise = f.save('I will ship the parser fix.', { tags: ['promise'] });
    const done = f.save('Shipped the parser fix.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } });
    expect(f.rows()).toEqual([{ entry_id: done, target_id: promise, status: 'done' }]);
    // The same turn again replays the entry and writes no second outcome row.
    const replay = f.store().save(OWNER, SELF, { roomId: ROOM, turnId: `t-${2}`, draft: { text: 'Shipped the parser fix.', tags: ['decision'],
      sources: [{ roomId: ROOM, id: 't-2', quote: 'Shipped the parser fix.'.slice(0, 30) }], annotations: { outcomeOf: { entry: promise, status: 'done' } } } }, f.read);
    expect(replay).toMatchObject({ entryId: done, replayed: true });
    expect(f.rows()).toHaveLength(1);
    expect(f.recall('parser fix').find((e) => e.entryId === promise)?.outcome).toMatchObject({ state: 'done', stateScope: 'journal', outcomesTotal: 1 });
    f.close();
  });

  it('refuses a second plain close, and leaves no entry or row behind', () => {
    const f = fixture();
    const promise = f.save('I will write the release notes.', { tags: ['promise'] });
    f.save('Wrote the release notes.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } });
    const conflict = f.refusal(() => f.save('Dropped the release notes.', { annotations: { outcomeOf: { entry: promise, status: 'dropped' }, reason: 'changed plan' } }));
    expect(conflict).toMatchObject({ status: 409, code: 'JOURNAL_OUTCOME_CONFLICT' });
    expect(f.rows()).toHaveLength(1);
    expect(JSON.stringify(f.store().receipt(OWNER, SELF, 't-3'))).toContain('"status":"not_found"');
    f.close();
  });

  it('decides a close again under the write lock, so a stale first check cannot commit a second close', () => {
    const f = fixture();
    const promise = f.save('I will rotate the deploy key.', { tags: ['promise'] });
    f.save('Rotated the deploy key.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } });
    // A first check that ran before another save closed the promise: it saw the promise open.
    const store = f.store() as unknown as { outcomeRefusal: (...args: unknown[]) => unknown };
    const real = store.outcomeRefusal.bind(store);
    vi.spyOn(store, 'outcomeRefusal').mockImplementationOnce(() => undefined).mockImplementation(real);
    const raced = f.refusal(() => f.save('Rotated it again.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } }));
    expect(raced).toMatchObject({ status: 409, code: 'JOURNAL_OUTCOME_CONFLICT' });
    expect(f.rows()).toHaveLength(1);
    f.close();
  });

  it('changes a close only by a same-target correction with a reason, and refuses a competing correction', () => {
    const f = fixture();
    const promise = f.save('I will migrate the build cache.', { tags: ['promise'] });
    const other = f.save('I will clean the old runners.', { tags: ['promise'] });
    const done = f.save('Migrated the build cache.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } });
    expect(f.refusal(() => f.save('Actually dropped.', { tags: ['decision', 'correction'], annotations: { supersedes: [done], outcomeOf: { entry: other, status: 'dropped' }, reason: 'wrong promise' } })))
      .toMatchObject({ code: 'JOURNAL_OUTCOME_CONFLICT' });
    expect(f.refusal(() => f.save('Actually not done.', { tags: ['decision', 'correction'], annotations: { supersedes: [done] } })))
      .toMatchObject({ code: 'JOURNAL_OUTCOME_CONFLICT' });
    expect(f.refusal(() => f.save('Actually done again.', { tags: ['decision', 'correction'], annotations: { supersedes: [done], outcomeOf: { entry: promise, status: 'done' } } })))
      .toMatchObject({ code: 'JOURNAL_OUTCOME_CONFLICT' });
    const dropped = f.save('The cache migration was rolled back.', { tags: ['decision', 'correction'],
      annotations: { supersedes: [done], outcomeOf: { entry: promise, status: 'dropped' }, reason: 'rolled back' } });
    // A second correction of the same, now replaced close loses instead of silently winning by id.
    expect(f.refusal(() => f.save('No, it was done.', { tags: ['decision', 'correction'], annotations: { supersedes: [done], outcomeOf: { entry: promise, status: 'done' }, reason: 'race' } })))
      .toMatchObject({ code: 'JOURNAL_OUTCOME_CONFLICT' });
    f.restart();
    const view = f.store().ownerPage(OWNER, SELF).entries.find((e) => e.entryId === promise);
    expect(view?.outcome).toMatchObject({ state: 'dropped', outcomes: [{ entryId: dropped, status: 'dropped' }, { entryId: done, status: 'done' }], outcomesTotal: 2 });
    f.close();
  });

  it('never reopens: a later result keeps the close, and a closed promise is not corrected', () => {
    const f = fixture();
    const promise = f.save('I will publish the benchmark.', { tags: ['promise'] });
    const done = f.save('Published the benchmark.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } });
    const result = f.save('The benchmark drew 40 comments.', { tags: ['lesson'], annotations: { outcomeOf: { entry: promise, status: 'result' } } });
    expect(f.recall('publish benchmark').find((e) => e.entryId === promise)?.outcome).toMatchObject({ state: 'done',
      outcomes: [{ entryId: done, status: 'done' }, { entryId: result, status: 'result' }] });
    expect(f.refusal(() => f.save('I will publish the benchmark on Friday.', { tags: ['promise', 'correction'], annotations: { supersedes: [promise], reason: 'new date' } })))
      .toMatchObject({ code: 'JOURNAL_OUTCOME_CLOSED' });
    f.close();
  });

  it('moves an open promise to its correction', () => {
    const f = fixture();
    const promise = f.save('I will send the report on Monday.', { tags: ['promise'], annotations: { due: '2026-11-09T14:00:00.000Z' } });
    const moved = f.save('I will send the report on Tuesday.', { tags: ['promise', 'correction'], annotations: { supersedes: [promise], due: '2026-11-10T14:00:00.000Z', reason: 'moved' } });
    expect(f.store().brief(OWNER, SELF).open.map((p) => p.entryId)).toEqual([moved]);
    expect(f.refusal(() => f.save('Sent the Monday report.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } })))
      .toMatchObject({ code: 'JOURNAL_OUTCOME_TARGET' });
    f.close();
  });

  it('refuses outcomes outside this private journal, on later turns, on the wrong kind of entry, and dropped without a reason', () => {
    const f = fixture();
    const mine = f.save('I will review the patch.', { tags: ['promise'] });
    const lesson = f.save('Reviews go faster in the morning.', { tags: ['lesson'] });
    const decision = f.save('We review patches in pairs.');
    const theirs = f.save('I will fix the flaky test.', { tags: ['promise'], employee: 'employee-two' });
    const otherOwner = f.save('I will water the plants.', { tags: ['promise'], owner: 'owner-two' });
    const shared = f.save('The project will cut a release.', { tags: ['promise'], project: 'rumoca' });
    expect(f.refusal(() => f.save('Fixed it.', { annotations: { outcomeOf: { entry: theirs, status: 'done' } } }))).toMatchObject({ code: 'JOURNAL_LINK' });
    expect(f.refusal(() => f.save('Watered.', { annotations: { outcomeOf: { entry: otherOwner, status: 'done' } } }))).toMatchObject({ code: 'JOURNAL_LINK' });
    expect(f.refusal(() => f.save('Released.', { annotations: { outcomeOf: { entry: shared, status: 'done' } } }))).toMatchObject({ code: 'JOURNAL_OUTCOME_SCOPE' });
    expect(f.refusal(() => f.save('Reviewed for the project.', { project: 'rumoca', annotations: { outcomeOf: { entry: mine, status: 'done' } } }))).toMatchObject({ code: 'JOURNAL_OUTCOME_SCOPE' });
    expect(f.refusal(() => f.save('A shared promise.', { tags: ['promise'], project: 'rumoca', annotations: { due: '2026-11-09T14:00:00.000Z' } }))).toMatchObject({ code: 'JOURNAL_OUTCOME_SCOPE' });
    expect(f.refusal(() => f.save('Pairs worked.', { annotations: { outcomeOf: { entry: decision, status: 'done' } } }))).toMatchObject({ code: 'JOURNAL_OUTCOME_TARGET' });
    expect(f.refusal(() => f.save('Mornings held.', { annotations: { outcomeOf: { entry: lesson, status: 'result' } } }))).toMatchObject({ code: 'JOURNAL_OUTCOME_TARGET' });
    expect(f.refusal(() => f.save('Dropped the review.', { annotations: { outcomeOf: { entry: mine, status: 'dropped' } } }))).toMatchObject({ code: 'JOURNAL_INVALID' });
    expect(f.refusal(() => f.save('Reviewed it, from an older turn.', { turnAt: Date.parse('2026-11-01T00:00:00Z'), annotations: { outcomeOf: { entry: mine, status: 'done' } } })))
      .toMatchObject({ code: 'JOURNAL_LINK' });
    expect(f.save('Pairs cut review time by half.', { tags: ['lesson'], annotations: { outcomeOf: { entry: decision, status: 'result' } } })).toBeGreaterThan(0);
    expect(f.rows()).toHaveLength(1);
    f.close();
  });

  it('accepts a past due time and marks it overdue, and refuses non-canonical times', () => {
    const f = fixture();
    const late = f.save('I will file the expense report.', { tags: ['promise'], annotations: { due: '2026-10-30T21:00:00.000Z' } });
    const soon = f.save('I will book the room.', { tags: ['promise'], annotations: { due: '2026-11-20T15:00:00.000Z' } });
    const undated = f.save('I will tidy the wiki.', { tags: ['promise'] });
    expect(f.store().brief(OWNER, SELF).open).toEqual([
      expect.objectContaining({ entryId: late, overdue: true }), expect.objectContaining({ entryId: soon, overdue: false }),
      expect.objectContaining({ entryId: undated, overdue: false })]);
    expect(f.store().map(OWNER, SELF).entries.find((e) => e.entryId === late)).toMatchObject({ state: 'open', overdue: true });
    for (const due of ['2026-11-20T15:00:00Z', '2026-11-20T10:00:00.000-05:00', '2026-02-30T12:00:00.000Z', '2101-01-01T00:00:00.000Z', 'soon'])
      expect(f.refusal(() => f.save('I will do it.', { tags: ['promise'], annotations: { due } }))).toMatchObject({ code: 'JOURNAL_INVALID' });
    expect(f.refusal(() => f.save('A due time on a decision.', { annotations: { due: '2026-11-20T15:00:00.000Z' } }))).toMatchObject({ code: 'JOURNAL_INVALID' });
    f.close();
  });

  it('derives state from the view\'s own room: hidden outcomes neither close, count nor show', () => {
    const f = fixture();
    const promise = f.save('I will repair the lab printer.', { tags: ['promise'] });
    const done = f.save('Repaired the lab printer.', { annotations: { outcomeOf: { entry: promise, status: 'done' } } });
    const dropped = f.save('The printer repair is dropped; it was replaced.', { room: OTHER_ROOM, tags: ['decision', 'correction'],
      annotations: { supersedes: [done], outcomeOf: { entry: promise, status: 'dropped' }, reason: 'replaced' } });
    const roomView = f.recall('repair lab printer', ROOM).find((e) => e.entryId === promise);
    expect(roomView?.outcome).toEqual({ state: 'done', stateScope: 'room', outcomes: [{ entryId: done, status: 'done', committedAt: expect.any(String) }],
      outcomesTotal: 1, outcomesTruncated: false });
    expect(f.store().map(OWNER, SELF, { roomId: ROOM }).entries.find((e) => e.entryId === promise)?.state).toBe('done');
    expect(f.store().ownerPage(OWNER, SELF).entries.find((e) => e.entryId === promise)?.outcome).toMatchObject({ state: 'dropped', stateScope: 'journal',
      outcomes: [{ entryId: dropped }, { entryId: done }], outcomesTotal: 2 });
    // A promise closed only from the other room is open in this room's view, and says whose view that is.
    const second = f.save('I will label the cables.', { tags: ['promise'] });
    f.save('Labelled the cables.', { room: OTHER_ROOM, annotations: { outcomeOf: { entry: second, status: 'done' } } });
    expect(f.recall('label cables', ROOM).find((e) => e.entryId === second)?.outcome).toEqual({ state: 'open', stateScope: 'room', outcomes: [], outcomesTotal: 0, outcomesTruncated: false });
    expect(f.recall('label cables', ROOM).map((e) => e.entryId)).toEqual([second]);
    f.close();
  });

  it('bounds outcomes on a view and pulls in only one outcome entry after its target', () => {
    const f = fixture();
    const decision = f.save('We adopt the nightly benchmark.');
    const results = Array.from({ length: 6 }, (_, i) => f.save(`Nightly benchmark result ${i}.`, { tags: ['lesson'], annotations: { outcomeOf: { entry: decision, status: 'result' } } }));
    const view = f.store().ownerPage(OWNER, SELF).entries.find((e) => e.entryId === decision);
    expect(view?.outcome).toMatchObject({ outcomesTotal: 6, outcomesTruncated: true });
    expect(view?.outcome?.outcomes.map((o) => o.entryId)).toEqual(results.slice(-JOURNAL_OUTCOMES_SHOWN).reverse());
    expect(f.recall('adopt nightly').map((e) => e.entryId)).toEqual([decision, results.at(-1)]);
    f.close();
  });

  it('keeps the current correction first when its outcome is pulled in, and the obsolete entry is what is cut', () => {
    const f = fixture();
    const old = f.save('I will migrate the wiki to markdown.', { tags: ['promise'] });
    const current = f.save('I will migrate the docs site instead.', { tags: ['promise', 'correction'], annotations: { supersedes: [old], reason: 'scope' } });
    const done = f.save('Docs site migrated.', { annotations: { outcomeOf: { entry: current, status: 'done' } } });
    expect(f.recall('migrate wiki markdown').map((e) => e.entryId)).toEqual([current, done]);
    f.close();
  });

  it('opens an old journal with no outcome table and invents no closes', () => {
    const f = fixture();
    const promise = f.save('I will archive the old logs.', { tags: ['promise'] });
    f.close();
    const db = new (require('node:sqlite').DatabaseSync)(f.file);
    db.exec('DROP TABLE journal_outcomes');
    db.close();
    const reopened = EmployeeJournalStore.open(f.file, () => f.now());
    // A promise saved before this change is now presented as open; nothing closes it.
    expect(reopened.brief(OWNER, SELF).open.map((p) => p.entryId)).toEqual([promise]);
    expect(reopened.recall(OWNER, SELF, 'archive old logs', f.read)[0]?.outcome).toMatchObject({ state: 'open', outcomesTotal: 0 });
    reopened.close();
  });

  it('shares one due-time boundary between the CLI and the store', () => {
    expect(normalizeJournalDue('2026-11-03T15:00-05:00')).toBe('2026-11-03T20:00:00.000Z');
    expect(normalizeJournalDue('2026-11-03T20:00Z')).toBe('2026-11-03T20:00:00.000Z');
    expect(normalizeJournalDue('2026-10-30T09:00:00.000Z')).toBe('2026-10-30T09:00:00.000Z');
    for (const bad of ['2026-11-03T15:00', '2026-02-30T12:00Z', '2026-11-03', 'tomorrow', '2101-01-01T00:00Z', '1999-12-31T23:59Z'])
      expect(normalizeJournalDue(bad)).toBeUndefined();
    for (const good of ['2026-11-03T15:00-05:00', '2000-01-01T00:00Z', '2100-12-31T23:59Z']) expect(isJournalDue(normalizeJournalDue(good))).toBe(true);
  });
});
