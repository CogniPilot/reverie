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
import { agentJournalReceipt, agentJournalSave } from '../src/cli-agent-journal.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';

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
function remember(key: string, text: string, extra: { tags?: string[]; annotations?: Record<string, unknown>; project?: string; room?: string } = {}) {
  n += 1; clock += HOUR;
  const source = `s-${n}`, turn = `t-${n}`, room = extra.room ?? ROOM;
  messages.set(`${room}/${source}`, { id: source, roomId: room, at: clock - 1000, text, fromSelf: false });
  messages.set(`${room}/${turn}`, { id: turn, roomId: room, at: clock, text: `Remember this: ${text}`, fromSelf: false });
  const saved = store.save(OWNER, SELF, { roomId: room, turnId: turn, ...(extra.project ? { project: extra.project } : {}), draft: {
    text, tags: extra.tags ?? ['decision'], sources: [{ roomId: room, id: source, quote: text.slice(0, 40) }],
    ...(extra.annotations ? { annotations: extra.annotations } : {}) } }, read);
  ids[key] = saved.entryId;
  return saved.entryId;
}
const recall = (query: string) => store.recall(OWNER, SELF, query, read);

/** What the server answers for the two journal calls the CLI makes here, from the real store. */
function serve(request: RequestOptions): { status: number; json: never } {
  const reply = (work: () => unknown) => {
    try { return { status: 200, json: { success: true, data: work() } as never }; }
    catch (err) { return { status: 400, json: { success: false, error: (err as Error).message } as never }; }
  };
  if (request.method === 'POST' && request.path === '/api/agent/journal/save')
    return reply(() => store.save(OWNER, SELF, request.body as never, read));
  const receipt = request.path.match(/^\/api\/agent\/journal\/receipt\/(.+)$/);
  if (request.method === 'GET' && receipt) return reply(() => store.receipt(OWNER, SELF, decodeURIComponent(receipt[1])));
  throw new Error(`unexpected ${request.method} ${request.path}`);
}
/** The journal CLI over a transport that answers the save call through `send`; text output, collected. */
function cli(send: (request: RequestOptions) => Promise<{ status: number; json: never }>) {
  const lines: string[] = [];
  const deps: AgentDeps = { ctx: { selfId: 'self-session', apiUrl: 'http://synthetic.test' }, json: false, now: () => clock,
    io: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
    request: async (_ctx, request) => (request.path.endsWith('/save') ? send(request) : serve(request)) as never };
  return { deps, lines };
}
/** A "Remember this" turn and its source message, ready for a save through the CLI. */
function turn(key: string, text: string) {
  n += 1; clock += HOUR;
  messages.set(`${ROOM}/s-${key}`, { id: `s-${key}`, roomId: ROOM, at: clock - 1000, text, fromSelf: false });
  messages.set(`${ROOM}/t-${key}`, { id: `t-${key}`, roomId: ROOM, at: clock, text: `Remember this: ${text}`, fromSelf: false });
  return { room: ROOM, turn: `t-${key}`, text, tag: ['decision'], source: [`s-${key}`], quote: [text.slice(0, 30)] };
}

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
  // A chain of corrections whose later links share no words with the first entry.
  const c1 = remember('c1', 'The standup meeting is at 9 AM daily.');
  const c2 = remember('c2', 'Correction: moved to 10.', { tags: ['decision', 'correction'], annotations: { supersedes: [c1], reason: 'moved' } });
  remember('c3', 'Correction again: now 11.', { tags: ['decision', 'correction'], annotations: { supersedes: [c2], reason: 'moved again' } });
  // A correction saved while acting in another room.
  const r1 = remember('r1', 'The lab printer is on floor two.');
  remember('r2', 'Correction: it is on floor three.', { room: 'room-two', tags: ['decision', 'correction'], annotations: { supersedes: [r1], reason: 'moved' } });
  // A chain whose second correction was saved in another room.
  const p1 = remember('p1', 'The coffee machine is in the kitchen.');
  const p2 = remember('p2', 'Correction: it is in the lounge.', { tags: ['decision', 'correction'], annotations: { supersedes: [p1], reason: 'moved' } });
  remember('p3', 'Correction: it is in the lobby now.', { room: 'room-two', tags: ['decision', 'correction'], annotations: { supersedes: [p2], reason: 'moved again' } });
  // The restart: a new store on the same file, with nothing carried over in memory.
  store.close();
  store = EmployeeJournalStore.open(file, () => clock);
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('memory restart drill (baseline 2026-11-02; cases 2, 3b, 4 and 6d closed since)', () => {
  it('1. the latest owner decision survives the restart, and the replaced one is not briefed', () => {
    const brief = store.brief(OWNER, SELF).entries.map((e) => e.entryId);
    expect(brief).toContain(ids.d2);
    expect(brief).not.toContain(ids.d1);
    expect(brief[0]).toBe(ids.d2); // keystone first, newest first
  });

  it('2. a correction beats the old fact it supersedes', () => {
    const top = recall('deploy window');
    expect(top[0]?.entryId).toBe(ids.f2);
    expect(top.some((e) => e.entryId === ids.f1 && e.supersededBy.length === 0)).toBe(false);
  });

  it('2c. the newest correction in a chain comes first, even when only the oldest entry matches the words', () => {
    const top = recall('standup meeting');
    expect(top.map((e) => e.entryId)).toEqual([ids.c3, ids.c1]);
    expect(top[1].supersededBy).toEqual([ids.c2]);
  });

  it("2d. a correction never crosses into another employee's journal or another room's filter", () => {
    expect(store.recall(OWNER, 'employee-two', 'deploy window', read)).toEqual([]);
    expect(store.recall(OWNER, SELF, 'deploy window', read, 'another-room')).toEqual([]);
    // Filtered to the first room, the correction saved in another room is not pulled in; unfiltered, it leads.
    expect(store.recall(OWNER, SELF, 'lab printer', read, ROOM).map((e) => e.entryId)).toEqual([ids.r1]);
    expect(recall('lab printer').map((e) => e.entryId)).toEqual([ids.r2, ids.r1]);
    // Every step of a chain stays inside the filter, not just the first.
    expect(store.recall(OWNER, SELF, 'coffee machine', read, ROOM).map((e) => e.entryId)).toEqual([ids.p2, ids.p1]);
    expect(recall('coffee machine').map((e) => e.entryId)).toEqual([ids.p3, ids.p1]);
  });

  it('2b. a superseded fact is at least marked as superseded when recalled', () => {
    const old = recall('deploy window').find((e) => e.entryId === ids.f1);
    expect(old?.supersededBy).toEqual([ids.f2]);
  });

  // KNOWN GAP: word matching only; a reworded question that shares no word with the rule finds nothing.
  it.fails('3. a reworded rule is still found', () => {
    expect(recall('do not press keys in a colleague terminal').map((e) => e.entryId)).toContain(ids.rule);
  });

  it('3b. a stray letter from an apostrophe is not enough to match', () => {
    expect(recall("a colleague's terminal").map((e) => e.entryId)).not.toContain(ids.rule);
    expect(recall('a colleague\u2019s terminal').map((e) => e.entryId)).not.toContain(ids.rule);
  });

  it("3c. the word before an apostrophe still matches, written with or without one", () => {
    expect(recall("the seat's pane").map((e) => e.entryId)).toContain(ids.rule);
    expect(recall('seat\u2019s').map((e) => e.entryId)).toContain(ids.rule);
    expect(recall("pane's").map((e) => e.entryId)).toContain(ids.rule);
    expect(recall('seat').map((e) => e.entryId)).toContain(ids.rule);
    // A one-character word on its own is still a word.
    expect(recall('6').map((e) => e.entryId)).toContain(ids.f2);
  });

  it('4. another form of a word still matches', () => {
    expect(recall('decide').map((e) => e.entryId).some((id) => id === ids.morph || id === ids.d3)).toBe(true);
    expect(recall('deploying').map((e) => e.entryId)).toContain(ids.f1);
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

  // Unknown transport outcomes, at the CLI boundary: the save call fails on the client's side, whatever the server did.
  it('6b. a lost acknowledgement is reported as unknown, the receipt finds the write, and the same save replays', async () => {
    const save = turn('lost-ack', 'The lost acknowledgement case was written.');
    const lost = cli(async (request) => { serve(request); throw new Error('connection reset'); });
    expect(await agentJournalSave(lost.deps, save)).not.toBe(0);
    expect(lost.lines.join('\n')).toMatch(/outcome unknown/);
    expect(lost.lines.join('\n')).not.toMatch(/\bSaved\b|not saved/i);
    const check = cli(async () => { throw new Error('unused'); });
    expect(await agentJournalReceipt(check.deps, save.turn)).toBe(0);
    expect(check.lines[0]).toMatch(/^committed #\d+/);
    const again = cli(async (request) => serve(request));
    expect(await agentJournalSave(again.deps, save)).toBe(0);
    expect(again.lines[0]).toMatch(/^Already saved entry #\d+/);
  });

  it('6c. after an unknown outcome, a receipt miss is not proof: the write can still land', async () => {
    const save = turn('late-write', 'The late write case was written.');
    let land = () => {};
    const late = cli(async (request) => { land = () => { serve(request); }; throw new Error('timed out'); });
    expect(await agentJournalSave(late.deps, save)).not.toBe(0);
    expect(late.lines.join('\n')).toMatch(/outcome unknown/);
    const before = cli(async () => { throw new Error('unused'); });
    await agentJournalReceipt(before.deps, save.turn);
    expect(before.lines[0]).toMatch(/^not_found: .*at lookup time/);
    expect(before.lines.join('\n')).not.toMatch(/not saved|was not written|never saved/i);
    land(); // the request that timed out on the client reaches the store after all
    const after = cli(async () => { throw new Error('unused'); });
    await agentJournalReceipt(after.deps, save.turn);
    expect(after.lines[0]).toMatch(/^committed #\d+/);
  });

  it('6d. after an unknown outcome, a receipt miss is reported as unresolved', async () => {
    const save = turn('unresolved', 'The unresolved case was written.');
    const lost = cli(async () => { throw new Error('timed out'); });
    await agentJournalSave(lost.deps, save);
    const check = cli(async () => { throw new Error('unused'); });
    await agentJournalReceipt(check.deps, save.turn);
    expect([...lost.lines, ...check.lines].join('\n')).toMatch(/unresolved|does not prove|not proof/i);
    // Each message says it on its own, and a retry is only ever the identical save.
    expect(lost.lines.join('\n')).toMatch(/unresolved/);
    expect(lost.lines.join('\n')).toMatch(/repeat the identical save/);
    expect(lost.lines.join('\n')).toContain(`receipt ${save.turn}`);
    expect(check.lines[0]).toMatch(/does not prove the save failed/);
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
