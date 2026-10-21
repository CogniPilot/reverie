/**
 * Member list: a gone session whose name is also held by a live member is folded under "Earlier sessions"
 * (with a Remove action) instead of showing as a dead twin. Coordinators and gone members with no live twin stay listed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.CodemanApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chatroom-ui.js'), 'utf8'), context);
afterAll(() => dom.window.close());

type M = { sessionId: string; name: string; alive: boolean; role?: string };
const m = (sessionId: string, name: string, alive: boolean, role?: string): M => ({ sessionId, name, alive, role });

function fold(members: M[]) {
  const self = vm.runInContext('Object.assign(Object.create(CodemanApp.prototype), {})', context) as {
    _foldGoneMembers(x: M[]): { shown: M[]; folded: M[] };
  };
  return self._foldGoneMembers(members);
}

describe('_foldGoneMembers', () => {
  it('folds an old session whose name a live member now holds', () => {
    const r = fold([m('57cf2d36', 'Coordinator', true), m('cc9158df', 'Coordinator', false), m('2e9d2da3', 'Planner', true), m('15dedf37', 'planner ', false)]);
    expect(r.folded.map((x) => x.sessionId)).toEqual(['cc9158df', '15dedf37']);
    expect(r.shown.map((x) => x.sessionId)).toEqual(['57cf2d36', '2e9d2da3']);
  });

  it('keeps a gone member with no live twin, and any live member', () => {
    const r = fold([m('a', 'Builder', false), m('b', 'Verifier', true), m('c', 'Verifier', true)]);
    expect(r.folded).toEqual([]);
    expect(r.shown).toHaveLength(3);
  });

  it('never folds the admin', () => {
    const r = fold([m('a', 'Reviewer', false, 'coordinator'), m('b', 'Reviewer', true)]);
    expect(r.folded).toEqual([]);
  });
});
