/** The Board page's own kanban script, run against a DOM: the Won't do list under the columns. */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { frontendDeclarations } from './helpers/frontend-declarations.js';

const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

type Issue = { id: string; title: string; status: string; owner: string; updatedAt: number; reason?: string };

function fixture(issues: Issue[]) {
  const html = readFileSync(new URL('../src/web/public/board.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const dom = new JSDOM('<div id="kanban"></div>');
  windows.push(dom);
  const context = vm.createContext({
    document: dom.window.document,
    B: { issues },
    tab: 'kanban',
    workIssues: () => issues,
    css: (name: string) => `var(${name})`,
    linksHtml: () => '',
    msTitle: () => '',
    ownerName: (issue: Issue) => issue.owner,
    dayLbl: () => 'Mon, 1 Jan',
  });
  // The page's own open/closed memory and its toggle listener, which sit between kanban() and the column strip.
  const disclosure = script.slice(script.indexOf('let wontdoOpen = false;'), script.indexOf('(function kanbanStrip()'));
  expect(disclosure).toContain("'toggle'");
  new vm.Script(
    `${frontendDeclarations(script, ['H', 'STATUS', 'COLS', 'esc', 'overdue', 'card', 'kanban'])}\n${disclosure}\nkanban();`
  ).runInContext(context);
  const host = dom.window.document.getElementById('kanban')!;
  return {
    host,
    box: () => host.querySelector('details.wontdo') as HTMLDetailsElement | null,
    titles: () => [...host.querySelectorAll('details.wontdo .card > div:first-child')].map((node) => node.textContent),
    refresh: () => new vm.Script('kanban();').runInContext(context),
  };
}

const issue = (id: string, status: string, updatedAt: number): Issue => ({
  id,
  title: `Card ${id}`,
  status,
  owner: 'Alex',
  updatedAt,
});

it("draws the Won't do cards when its summary is opened and keeps the list open across refreshes", async () => {
  const issues = [issue('kept', 'todo', 3), issue('duplicate', 'wontdo', 2), issue('<b>dropped</b>', 'wontdo', 1)];
  const f = fixture(issues);
  const summary = f.box()!.querySelector('summary')!;
  expect(summary.textContent).toBe("Won't do (2)");
  expect(f.box()!.open).toBe(false);
  // Closed, the list holds no cards at all; the columns above it are drawn as before.
  expect(f.titles()).toEqual([]);
  expect([...f.host.querySelectorAll('.kan .card > div:first-child')].map((node) => node.textContent)).toEqual([
    'Card kept',
  ]);

  summary.click();
  await vi.waitFor(() => expect(f.titles()).toEqual(['Card duplicate', 'Card <b>dropped</b>']));
  expect(f.box()!.open).toBe(true);
  expect(f.host.querySelector('details.wontdo b')).toBeNull();

  // A refresh redraws the whole kanban; the list the reader opened stays open, with the new count and cards.
  issues.push(issue('late', 'wontdo', 0));
  f.refresh();
  expect(f.box()!.open).toBe(true);
  expect(f.box()!.querySelector('summary')!.textContent).toBe("Won't do (3)");
  expect(f.titles()).toEqual(['Card duplicate', 'Card <b>dropped</b>', 'Card late']);

  // Closing it is remembered too: the next refresh draws it closed and empty again.
  const closed = new Promise((resolve) => f.box()!.addEventListener('toggle', resolve, { once: true }));
  f.box()!.querySelector('summary')!.click();
  await closed;
  f.refresh();
  expect(f.box()!.open).toBe(false);
  expect(f.titles()).toEqual([]);
});

it("shows no Won't do list when nothing was declined", () => {
  const f = fixture([issue('kept', 'todo', 1)]);
  expect(f.box()).toBeNull();
  expect(f.host.querySelectorAll('.ktabs button')).toHaveLength(5);
});
