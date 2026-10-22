/**
 * `plan-usage-marks.json` beside the usage history names readings filed under the wrong account; the history load flags them
 * `misattributed` and saves through the normal path. The console never writes the marks file. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanService } from '../src/plan-accounts.js';

const A = 'acct-one';
const B = 'acct-two';

describe('plan usage marks', () => {
  let dir: string;
  let history: string;
  let marks: string;

  const service = () =>
    new PlanService({
      reader: { read: async () => ({ id: '', label: '', provider: 'anthropic', status: 'ready', updatedAt: 0, usage: null }) as never },
      sessions: () => [],
      coordinatorIds: () => [],
      historyFile: history,
      home: dir,
    });
  const samples = (id: string) => (JSON.parse(readFileSync(history, 'utf8')) as Record<string, { at: number; misattributed?: boolean }[]>)[id];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-marks-'));
    history = join(dir, 'plan-usage-history.json');
    marks = join(dir, 'plan-usage-marks.json');
    writeFileSync(history, JSON.stringify({ [A]: [{ at: 1000, weekly: 27 }, { at: 2000, weekly: 28 }], [B]: [{ at: 1000, weekly: 5 }] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('flags exactly the listed readings, in memory and in the saved history', async () => {
    writeFileSync(marks, JSON.stringify([{ account: A, at: 1000 }]));
    const history1 = await service().usageHistory();
    expect(history1[A].map((s) => s.misattributed)).toEqual([true, undefined]);
    expect(history1[B][0].misattributed).toBeUndefined(); // same time, other account
    await vi.waitFor(() => expect(samples(A)[0].misattributed).toBe(true));
    expect(samples(A)[1].misattributed).toBeUndefined();
  });

  it('a mark that matches nothing changes nothing and writes nothing', async () => {
    writeFileSync(marks, JSON.stringify([{ account: A, at: 1500 }, { account: 'nobody', at: 1000 }]));
    const before = statSync(history).mtimeMs;
    const loaded = await service().usageHistory();
    expect(Object.values(loaded).flat().some((s) => s.misattributed)).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(statSync(history).mtimeMs).toBe(before);
  });

  it('ignores a missing, unreadable or wrongly shaped marks file', async () => {
    for (const text of [null, 'not json', '{"account":"acct-one","at":1000}', '[null, 3, {"account":7,"at":"x"}, {"account":"acct-one"}]']) {
      if (text !== null) writeFileSync(marks, text);
      const loaded = await service().usageHistory();
      expect(Object.values(loaded).flat().some((s) => s.misattributed)).toBe(false);
    }
  });

  it('a second load is idempotent, and the marks file is never written', async () => {
    writeFileSync(marks, JSON.stringify([{ account: A, at: 1000 }]));
    const marksText = readFileSync(marks, 'utf8');
    const marksTime = statSync(marks).mtimeMs;
    await service().usageHistory();
    await vi.waitFor(() => expect(samples(A)[0].misattributed).toBe(true));
    const savedTime = statSync(history).mtimeMs;
    const again = await service().usageHistory();
    expect(again[A].map((s) => s.misattributed)).toEqual([true, undefined]);
    await new Promise((r) => setTimeout(r, 30));
    expect(statSync(history).mtimeMs).toBe(savedTime); // nothing new to save
    expect(readFileSync(marks, 'utf8')).toBe(marksText);
    expect(statSync(marks).mtimeMs).toBe(marksTime);
  });
});
