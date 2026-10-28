/**
 * Delivery receipts: a room message counts as SEEN by an agent only when its CLI was seen to submit the line
 * (the composer emptied), and Codex's folded paste no longer hides a stranded line from the composer check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeholderHoldsPrompt, promptStillInComposer, SubmitVerifier, type SubmitOutcome } from '../src/session-submit-verifier.js';
import { ChatroomDelivery, type DeliveredMessage, type DeliverySession } from '../src/chatroom-delivery.js';
import { LastSeenStore } from '../src/chatroom-last-seen.js';

const FOOTER = 'GPT-6.1-Sol high · /owned/fixture';
const LINE = '[Reverie chat "general"] "Reviewer" (coordinator): "@Verifier BLOCKING review: please fix the exporter before the commit"';

describe('a folded paste in the composer', () => {
  it('is recognised as our prompt when its size matches what we typed, Codex style', () => {
    const screen = `• Working\n› [Pasted Content ${LINE.length} chars]\n  GPT-6.1-Sol medium · /owned/fixture`;
    expect(promptStillInComposer(screen, LINE, '›', true)).toBe(true);
    expect(placeholderHoldsPrompt(`[Pasted Content ${LINE.length + 2} chars]`, LINE, true)).toBe(true); // line-ending slack
  });

  it('refuses a matching chip next to an older stranded one because the whole buffer is not ours', () => {
    const both = `› [Pasted Content 1801 chars][Pasted Content ${LINE.length} chars]`;
    expect(promptStillInComposer(both, LINE, '›', true)).toBeUndefined();
    expect(promptStillInComposer('› [Pasted Content 1801 chars]', LINE, '›')).toBeUndefined(); // a person's own paste
    expect(placeholderHoldsPrompt(`[Pasted Content ${LINE.length + 10} chars]`, LINE)).toBe(false);
  });

  it('leaves the plain cases as they were', () => {
    expect(promptStillInComposer(`› ${LINE}\n\n${FOOTER}`, LINE, '›')).toBe(true);
    expect(promptStillInComposer(`› \n\n${FOOTER}`, LINE, '›')).toBe(false);
    expect(promptStillInComposer(`[Pasted Content ${LINE.length} chars]`, LINE, '')).toBeUndefined();
  });
});

describe('SubmitVerifier outcomes', () => {
  let screen: string;
  let sends: number;
  const outcomes: SubmitOutcome[] = [];
  const make = (glyph = '›', delaysMs: readonly number[] = [1_000, 1_000, 1_000]) =>
    new SubmitVerifier({
      capture: () => screen.includes('GPT-6.1-Sol') ? screen : `${screen}\n\n${FOOTER}`,
      sendEnter: () => {
        sends++;
      },
      glyph: () => glyph,
      delaysMs,
    });
  beforeEach(() => {
    vi.useFakeTimers();
    sends = 0;
    outcomes.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('reports submitted once the composer empties, after pressing Enter through a folded paste', async () => {
    screen = `› [Pasted Content ${LINE.length} chars]`;
    const v = make();
    v.arm(LINE, (o) => outcomes.push(o), true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(1); // the Enter the old check never sent
    screen = '› ';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcomes).toEqual(['submitted']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcomes).toEqual(['submitted']); // exactly once
  });

  it('reports stranded only after a final look past the last Enter', async () => {
    screen = `› ${LINE}`;
    const v = make('›', [1_000, 1_000]);
    v.arm(LINE, (o) => outcomes.push(o), true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sends).toBe(2);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcomes).toEqual(['stranded']);
  });

  it('the final look turns a last-moment submit into submitted, not stranded', async () => {
    screen = `› ${LINE}`;
    const v = make('›', [1_000]);
    v.arm(LINE, (o) => outcomes.push(o), true);
    await vi.advanceTimersByTimeAsync(1_000);
    screen = '› ';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcomes).toEqual(['submitted']);
  });

  it('says unverified with no composer to read, and when a newer write replaces the check', async () => {
    screen = 'plain shell output';
    const v = make();
    v.arm(LINE, (o) => outcomes.push(o), true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcomes).toEqual(['unverified']);
    expect(sends).toBe(0);
    screen = `› ${LINE}`;
    v.arm(LINE, (o) => outcomes.push(o), true);
    v.arm('a newer prompt', (o) => outcomes.push(o));
    expect(outcomes).toEqual(['unverified', 'unverified']);
  });
});

function pane(outcome: SubmitOutcome | 'none'): DeliverySession & { writes: string[] } {
  const writes: string[] = [];
  return {
    id: 'p',
    name: 'p',
    mode: 'codex',
    isWorking: false,
    pid: 1,
    writes,
    writeViaMux: async (data, options) => {
      writes.push(data);
      if (outcome !== 'none') options?.onOutcome?.(outcome);
      return true;
    },
  };
}
const R1 = { id: 'room-1', name: 'One' };

describe('delivery receipts', () => {
  it('reports every chat message of a line, held ones included, only when the line was submitted', async () => {
    const submitted: DeliveredMessage[][] = [];
    const stranded: DeliveredMessage[][] = [];
    for (const outcome of ['submitted', 'stranded', 'unverified', 'none'] as const) {
      submitted.length = 0;
      stranded.length = 0;
      const s = pane(outcome);
      const delivery = new ChatroomDelivery({
        getSession: () => s,
        onSubmitted: (_id, m) => submitted.push(m),
        onStranded: (_id, m) => stranded.push(m),
      });
      delivery.enqueue('p', R1, '"a" -> everyone: "held"', { messageId: 'm1', passive: true });
      delivery.enqueue('p', R1, '"b" -> you: "wake"', { messageId: 'm2' });
      await delivery.flushAll();
      expect(s.writes).toHaveLength(1);
      const expected = [
        { roomId: 'room-1', messageId: 'm1' },
        { roomId: 'room-1', messageId: 'm2' },
      ];
      expect(submitted).toEqual(outcome === 'submitted' ? [expected] : []);
      expect(stranded).toEqual(outcome === 'stranded' ? [expected] : []);
    }
  });
});

describe('LastSeenStore', () => {
  it('only moves forward, survives a restart, and forgets a deleted room', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'seen-')), 'chat-last-seen.json');
    const a = new LastSeenStore(file);
    expect(a.advance('s1', 'r1', { messageId: 'm2', at: 200 })).toBe(true);
    expect(a.advance('s1', 'r1', { messageId: 'm1', at: 100 })).toBe(false); // older: ignored
    a.advance('s1', 'r2', { messageId: 'x', at: 50 });
    await a.flush();
    expect(JSON.parse(readFileSync(file, 'utf-8')).s1.r1.messageId).toBe('m2');
    const b = new LastSeenStore(file);
    await b.load();
    expect(b.get('s1', 'r1')).toEqual({ messageId: 'm2', at: 200 });
    b.forget(undefined, 'r2');
    expect(b.get('s1', 'r2')).toBeUndefined();
    expect(b.get('s1', 'r1')).toBeDefined();
  });

  it('starts empty on a missing or broken file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seen-'));
    const s = new LastSeenStore(join(dir, 'nope.json'));
    await s.load();
    expect(s.get('s', 'r')).toBeUndefined();
  });
});
