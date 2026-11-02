/**
 * Memory restart drill: after a restart, can an agent's journal still answer the questions its next action depends on?
 * A fixed journal is written, the store is closed and reopened on the same file, and every question goes through the
 * surfaces an agent uses (brief, recall, map, receipt).
 *
 * Each case states the contract we want. A case marked KNOWN GAP is `it.fails`: it records today's baseline without
 * hiding it, and it starts failing (asking to be reclassified) as soon as the journal meets the contract.
 * Cases follow LongMemEval's knowledge-update, temporal and abstention categories, adapted to restart and receipt cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmployeeJournalStore, type JournalMessage, type ReadVisibleMessage } from '../src/employee-journal.js';

const ROOM = 'room-one';
const OWNER = 'owner';
const SELF = 'employee-one';
const HOUR = 60 * 60_000;

let dir: string;
let store: EmployeeJournalStore;
const messages = new Map<string, JournalMessage>();
const read: ReadVisibleMessage = (roomId, id) => { const m = messages.get(`${roomId}/${id}`); return m && { ...m }; };
let clock = Date.parse('2026-10-20T14:00:00Z');
const ids: Record<string, number> = {};
let n = 0;

/** Save `text` as the answer to a "Remember this" turn, with the text itself as the checked chat source. */
function remember(key: string, text: string, extra: { tags?: string[]; annotations?: Record<string, unknown>; project?: string } = {}) {
  n += 1; clock += HOUR;
  const source = `s-${n}`, turn = `t-${n}`;
  messages.set(`${ROOM}/${source}`, { id: source, roomId: ROOM, at: clock - 1000, text, fromSelf: false });
  messages.set(`${ROOM}/${turn}`, { id: turn, roomId: ROOM, at: clock, text: `Remember this: ${text}`, fromSelf: false });
  const saved = store.save(OWNER, SELF, { roomId: ROOM, turnId: turn, ...(extra.project ? { project: extra.project } : {}), draft: {
    text, tags: extra.tags ?? ['decision'], sources: [{ roomId: ROOM, id: source, quote: text.slice(0, 40) }],
    ...(extra.annotations ? { annotations: extra.annotations } : {}) } }, read);
  ids[key] = saved.entryId;
  return saved.entryId;
}
const recall = (query: string) => store.recall(OWNER, SELF, query, read);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-drill-'));
  const file = join(dir, 'journal.sqlite');
  store = EmployeeJournalStore.open(file, () => clock);
  const d1 = remember('d1', 'Owner decision: we ship releases on Fridays.', { annotations: { importance: 'keystone' } });
  remember('d2', 'Owner decision: we ship releases on Thursdays from now on.', { tags: ['decision', 'correction'],
    annotations: { importance: 'keystone', supersedes: [d1], reason: 'the owner changed the release day' } });
  const f1 = remember('f1', 'The deploy window starts at 5 PM, and the deploy window is fixed.', { tags: ['decision'] });
  remember('f2', 'Correction: the window moved to 6 PM.', { tags: ['decision', 'correction'], annotations: { supersedes: [f1], reason: 'corrected' } });
  remember('rule', "Never type into another seat's pane.", { tags: ['preference'], annotations: { importance: 'important' } });
  remember('morph', 'Decided to keep the capacity rule for scratch cleanup.');
  remember('t1', 'Release notes use the short template.', { tags: ['preference'] });
  remember('t2', 'Release notes use the long template.', { tags: ['preference'] });
  remember('promise', 'I will send the coordinator the weekly report by 3 PM Friday.', { tags: ['promise'] });
  const d3 = remember('d3', 'Decided to enable the nightly cleanup.');
  remember('o3', 'Outcome: the nightly cleanup freed 40 GB on its first run.', { tags: ['lesson'], annotations: { related: [d3] } });
  remember('done', 'Finished and merged the stalled-seat alert; done.', { tags: ['decision'] });
  remember('proj', 'Project note: the compiler baseline is green.', { project: 'rumoca', tags: ['decision'] });
  // The restart: a new store on the same file, with nothing carried over in memory.
  store.close();
  store = EmployeeJournalStore.open(file, () => clock);
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('memory restart drill (baseline 2026-11-02)', () => {
  it('1. the latest owner decision survives the restart, and the replaced one is not briefed', () => {
    const brief = store.brief(OWNER, SELF).entries.map((e) => e.entryId);
    expect(brief).toContain(ids.d2);
    expect(brief).not.toContain(ids.d1);
    expect(brief[0]).toBe(ids.d2); // keystone first, newest first
  });

  // KNOWN GAP: recall ranks by text match only and returns superseded entries; the replaced fact wins here.
  it.fails('2. a correction beats the old fact it supersedes', () => {
    const top = recall('deploy window');
    expect(top[0]?.entryId).toBe(ids.f2);
    expect(top.some((e) => e.entryId === ids.f1 && e.supersededBy.length === 0)).toBe(false);
  });

  it('2b. a superseded fact is at least marked as superseded when recalled', () => {
    const old = recall('deploy window').find((e) => e.entryId === ids.f1);
    expect(old?.supersededBy).toEqual([ids.f2]);
  });

  // KNOWN GAP: word matching only; a reworded question that shares no word with the rule finds nothing.
  it.fails('3. a reworded rule is still found', () => {
    expect(recall('do not press keys in a colleague terminal').map((e) => e.entryId)).toContain(ids.rule);
  });

  // KNOWN GAP: the stray "s" of an apostrophe ("colleague's", "seat's") is a search token, so a question whose only
  // shared token is that letter still "finds" the rule: a match by noise, not meaning.
  it.fails('3b. a stray letter from an apostrophe is not enough to match', () => {
    expect(recall("a colleague's terminal").map((e) => e.entryId)).not.toContain(ids.rule);
  });

  // KNOWN GAP: no stemming; "decide" does not match "Decided".
  it.fails('4. another form of a word still matches', () => {
    expect(recall('decide').map((e) => e.entryId).some((id) => id === ids.morph || id === ids.d3)).toBe(true);
  });

  it('5. of two answers on the same topic, the newer comes first', () => {
    expect(recall('release notes template')[0]?.entryId).toBe(ids.t2);
  });

  it('6. a refused save leaves a positive record that nothing was committed', () => {
    messages.set(`${ROOM}/t-refused`, { id: 't-refused', roomId: ROOM, at: clock, text: 'Remember this: unsupported claim.', fromSelf: false });
    expect(() => store.save(OWNER, SELF, { roomId: ROOM, turnId: 't-refused', draft: {
      text: 'unsupported claim', tags: ['decision'], sources: [{ roomId: ROOM, id: 't-refused', quote: 'not in the message' }] } }, read)).toThrow();
    const receipt = store.receipt(OWNER, SELF, 't-refused');
    expect(JSON.stringify(receipt)).toContain('refused');
    expect(JSON.stringify(receipt)).not.toMatch(/"entryId":\s*\d/);
  });

  it('7. a topic never saved returns nothing (the agent can say it has no memory of it)', () => {
    expect(recall('quarterly budget forecast spreadsheet')).toEqual([]);
  });

  // KNOWN GAP: a promise can be tagged 'promise', but it has no open/done status or due time, and the brief does not list
  // open ones as such.
  it.fails('8. an unfinished promise is listed as open, with its due time', () => {
    const entry = store.brief(OWNER, SELF).entries.find((e) => e.entryId === ids.promise) as Record<string, unknown> | undefined;
    expect(entry?.status).toBe('open');
    expect(entry?.due).toBeTruthy();
  });

  // KNOWN GAP: "done" is only text; no structured outcome or status on the task.
  it.fails('9. finished work is recognisable as done, so it is not redone', () => {
    const [task] = recall('stalled-seat alert');
    expect((task?.annotations as Record<string, unknown> | undefined)?.status).toBe('done');
  });

  // KNOWN GAP: `related` points from the outcome back to the decision, but recalling the decision does not show it.
  it.fails('10. recalling a decision shows its recorded outcome', () => {
    const decision = recall('enable nightly cleanup').find((e) => e.entryId === ids.d3) as Record<string, unknown> | undefined;
    expect(decision?.relatedBy ?? decision?.outcomes).toContain(ids.o3);
  });

  it('11. project entries are shared by project, private ones stay private', () => {
    expect(store.recall(OWNER, 'employee-two', 'compiler baseline', read, undefined, 'rumoca').map((e) => e.entryId)).toEqual([ids.proj]);
    expect(store.recall(OWNER, 'employee-two', 'release Thursdays', read)).toEqual([]);
  });
});
