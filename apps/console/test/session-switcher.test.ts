/**
 * Phone session switcher: which session the header points at as needing help.
 * Order: permission prompt / question, then waiting for input, then error; the
 * longest-waiting first within a level; working, idle and stopped never count.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = { id: string; state: string; hooks?: string[]; since?: number };
type Ranked = Array<{ id: string; level: number; reason: string }>;

function load(): { rank(rows: Row[]): Ranked } {
  const context = vm.createContext({ CodemanApp: class {} });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/session-switcher.js'), 'utf8'), context);
  return { rank: (rows) => JSON.parse(JSON.stringify(context.rankSessionsNeedingHelp(rows))) };
}

describe('rankSessionsNeedingHelp', () => {
  const { rank } = load();

  it('puts a blocked session first, then waiting, then errored, and ignores healthy ones', () => {
    const ranked = rank([
      { id: 'err', state: 'error', since: 1 },
      { id: 'busy', state: 'working', since: 1 },
      { id: 'wait', state: 'waiting', hooks: ['idle_prompt'], since: 1 },
      { id: 'idle', state: 'idle', since: 1 },
      { id: 'perm', state: 'needs', hooks: ['permission_prompt'], since: 5 },
      { id: 'done', state: 'done', since: 1 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['perm', 'wait', 'err']);
    expect(ranked.map((r) => r.reason)).toEqual(['permission', 'waiting for input', 'error']);
  });

  it('ranks an open dialog just below a permission prompt and above waiting or errored', () => {
    const ranked = rank([
      { id: 'err', state: 'error', since: 1 },
      { id: 'wait', state: 'waiting', since: 1 },
      { id: 'dialog', state: 'dialog', since: 9 },
      { id: 'perm', state: 'needs', hooks: ['permission_prompt'], since: 9 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['perm', 'dialog', 'wait', 'err']);
    expect(ranked[1].reason).toBe('dialog open');
  });

  it('names a question (elicitation) distinctly from a permission prompt', () => {
    expect(rank([{ id: 'q', state: 'needs', hooks: ['elicitation_dialog'] }])[0].reason).toBe('question');
  });

  it('prefers the one waiting longest within a level, unknown times last', () => {
    const ranked = rank([
      { id: 'recent', state: 'waiting', since: 300 },
      { id: 'unknown', state: 'waiting', since: 0 },
      { id: 'oldest', state: 'waiting', since: 100 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['oldest', 'recent', 'unknown']);
  });

  it('returns nothing when every session is fine', () => {
    expect(
      rank([
        { id: 'a', state: 'working' },
        { id: 'b', state: 'idle' },
      ])
    ).toEqual([]);
    expect(rank([])).toEqual([]);
  });
});

describe('switcher rows', () => {
  it('turns a quiet session with an open dialog into a "dialog" row, never over a permission prompt', () => {
    class App {}
    const context = vm.createContext({ CodemanApp: App });
    vm.runInContext(
      readFileSync(resolve(import.meta.dirname, '../src/web/public/session-switcher.js'), 'utf8'),
      context
    );
    const app = new App() as Record<string, unknown> & { _sessionSwitcherRows(): Array<{ id: string; state: string }> };
    app.sessionOrder = ['a', 'b', 'c'];
    app.sessions = new Map([
      ['a', { id: 'a', status: 'idle', paneDialog: 'Enter to continue · Esc to cancel' }],
      ['b', { id: 'b', status: 'idle', paneDialog: 'Enter to confirm · Esc to cancel' }],
      ['c', { id: 'c', status: 'idle', paneDialog: null }],
    ]);
    app.pendingHooks = new Map([['b', new Set(['permission_prompt'])]]);
    app._mobileOverviewState = (session: { id: string }, hooks?: Set<string>) =>
      hooks?.has('permission_prompt') ? 'needs' : 'idle';
    expect(app._sessionSwitcherRows().map((r) => `${r.id}:${r.state}`)).toEqual(['a:dialog', 'b:needs', 'c:idle']);
  });
});
