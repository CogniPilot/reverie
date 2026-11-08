/**
 * A Claude delivery the pane could not confirm is confirmed only by a new turn in the session's own transcript that carries
 * the whole delivered line. Nothing is ever typed again, and without that turn the line stays held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomDelivery, WAKE_LINE, type DeliverySession } from '../src/chatroom-delivery.js';

type Options = Parameters<DeliverySession['writeViaMux']>[1];
type Outcome = 'submitted' | 'stranded' | 'unverified';
const turn = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'delivery-transcript-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
/** Real timers: each check reads the file, so the schedule is shortened rather than faked. */
const DELAYS = [5, 10, 20, 40];
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function fixture(outcome: Outcome, options: { transcript?: boolean } = {}) {
  mkdirSync(join(dir, 'p'), { recursive: true });
  const file = join(dir, 'p', 'conversation.jsonl');
  writeFileSync(file, turn('an older turn'));
  const writes: string[] = [];
  const submitted: string[][] = [];
  const uncertain: string[][] = [];
  const session: DeliverySession = {
    id: 's', name: 'Agent', mode: 'claude', pid: 42, isWorking: false,
    composerProvablyIdle: () => true,
    claudeTranscript: async () => options.transcript === false ? undefined : file,
    writeViaMux: async (text: string, opts: Options) => {
      writes.push(text);
      opts?.onOutcome?.(outcome);
      return true;
    },
  };
  const delivery = new ChatroomDelivery({
    getSession: () => session, now: () => 1_000_000 + writes.length * 60_000, transcriptCheckDelaysMs: DELAYS,
    onSubmitted: (_id, messages) => submitted.push(messages.map((m) => m.messageId)),
    onUncertain: (_id, messages) => uncertain.push(messages.map((m) => m.messageId)),
  });
  const send = async (text: string, messageId: string) => {
    delivery.enqueue('s', { id: 'office', name: 'office' }, text, { messageId });
    (delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear();
    await delivery.flush('s');
  };
  const runChecks = settle;
  return { file, writes, submitted, uncertain, send, runChecks, delivery };
}

describe('transcript evidence for an unconfirmed Claude delivery', () => {
  it('confirms an unverified wake found in a new turn, without typing it again, however long the message is', async () => {
    const f = fixture('unverified');
    const long = `@Agent ${'review the attached plan carefully '.repeat(40)}`;
    await f.send(long, 'm-1');
    expect(f.uncertain).toEqual([['m-1']]);
    const line = f.writes[0].replace(/\r$/, '');
    expect(line).toBe(WAKE_LINE);
    appendFileSync(f.file, turn(`[Pasted text #1]\n${line}\n`));
    await f.runChecks();
    expect(f.submitted).toEqual([['m-1']]);
    expect(f.writes).toHaveLength(1);
  });

  it('confirms a stranded line when its turn appears, and a later line is typed normally', async () => {
    const f = fixture('stranded');
    await f.send('@Agent first', 'm-1');
    appendFileSync(f.file, turn(f.writes[0].replace(/\r$/, '')));
    await f.runChecks();
    expect(f.submitted).toEqual([['m-1']]);
  });

  it('keeps the line held when the transcript only has it from before the write, or a prefix of it', async () => {
    const f = fixture('unverified');
    await f.send('@Agent please check', 'm-1');
    const line = f.writes[0].replace(/\r$/, '');
    appendFileSync(f.file, turn(line.slice(0, -2)));
    await f.runChecks();
    expect(f.submitted).toEqual([]);
    const g = fixture('unverified');
    writeFileSync(g.file, turn(line));
    await g.send('@Agent please check', 'm-1');
    await g.runChecks();
    expect(g.submitted).toEqual([]);
    expect(g.writes).toHaveLength(1);
  });

  it('needs one turn per identical line', async () => {
    const f = fixture('unverified');
    await f.send('@Agent same words', 'm-1');
    // Let a second identical line go out while the first still waits for its turn.
    const holds = (f.delivery as unknown as { inspectionHolds: Map<string, unknown> }).inspectionHolds;
    holds.clear();
    await f.send('@Agent same words', 'm-2');
    f.delivery.holdForInspection('s', [{ roomId: 'office', messageId: 'm-1' }]);
    expect(f.writes[1]).toBe(f.writes[0]);
    const line = f.writes[0].replace(/\r$/, '');
    appendFileSync(f.file, turn(line));
    await f.runChecks();
    expect(f.submitted).toHaveLength(1);
    const g = fixture('unverified');
    await g.send('@Agent same words', 'm-1');
    holds.clear();
    (g.delivery as unknown as { inspectionHolds: Map<string, unknown> }).inspectionHolds.clear();
    await g.send('@Agent same words', 'm-2');
    g.delivery.holdForInspection('s', [{ roomId: 'office', messageId: 'm-1' }]);
    appendFileSync(g.file, turn(line) + turn(line));
    await g.runChecks();
    expect(g.submitted.flat().sort()).toEqual(['m-1', 'm-2']);
  });

  it('stays held with no transcript, and stops looking after the last check', async () => {
    const f = fixture('unverified', { transcript: false });
    await f.send('@Agent please check', 'm-1');
    appendFileSync(f.file, turn(f.writes[0].replace(/\r$/, '')));
    await f.runChecks();
    expect(f.submitted).toEqual([]);
    const g = fixture('unverified');
    await g.send('@Agent please check', 'm-1');
    await g.runChecks();
    appendFileSync(g.file, turn(g.writes[0].replace(/\r$/, '')));
    await settle();
    expect(g.submitted).toEqual([]);
  });

  it('a submit the pane saw is not looked for again', async () => {
    const f = fixture('submitted');
    await f.send('@Agent please check', 'm-1');
    expect(f.submitted).toEqual([['m-1']]);
    appendFileSync(f.file, turn(f.writes[0].replace(/\r$/, '')));
    await f.runChecks();
    expect(f.submitted).toEqual([['m-1']]);
  });
});
