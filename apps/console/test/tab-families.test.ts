/**
 * Desktop tab strip folding: which spawned tabs fold, and under which visible tab.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/tab-families.js'), 'utf8'), context);
const compute = vm.runInContext('computeTabFamilies', context) as (
  rows: Array<{ id: string; parentId?: string | null }>,
  activeId: string | null
) => { hidden: Set<string>; families: Map<string, string[]> };
const plain = (r: ReturnType<typeof compute>) => ({
  hidden: [...r.hidden].sort(),
  families: Object.fromEntries(r.families),
});

describe('computeTabFamilies', () => {
  const rows = [
    { id: 'orch' },
    { id: 'a', parentId: 'orch' },
    { id: 'b', parentId: 'orch' },
    { id: 'a1', parentId: 'a' },
    { id: 'solo' },
  ];

  it('folds every descendant under the top visible ancestor, in strip order', () => {
    expect(plain(compute(rows, 'solo'))).toEqual({ hidden: ['a', 'a1', 'b'], families: { orch: ['a', 'b', 'a1'] } });
  });

  it('never folds the active tab; its own children fold under it', () => {
    expect(plain(compute(rows, 'a'))).toEqual({ hidden: ['a1', 'b'], families: { orch: ['b'], a: ['a1'] } });
  });

  it('keeps a child whose parent has no tab, and survives a parent cycle', () => {
    expect(plain(compute([{ id: 'x', parentId: 'gone' }, { id: 'y' }], null))).toEqual({ hidden: [], families: {} });
    const cycle = compute(
      [
        { id: 'p', parentId: 'q' },
        { id: 'q', parentId: 'p' },
      ],
      null
    );
    expect(cycle.hidden.size).toBeLessThan(2);
  });

  it('ignores a session listing itself as its parent', () => {
    expect(plain(compute([{ id: 'me', parentId: 'me' }], null))).toEqual({ hidden: [], families: {} });
  });
});
