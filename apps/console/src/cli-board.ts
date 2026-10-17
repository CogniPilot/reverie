/**
 * @fileoverview `reverie board …` — the server board from inside a session: show it, file and move issues, add
 * milestones, wins, blockers and decisions, and import a schedule-data.json.
 *
 * A thin client over /api/board with the same transport, guard and exit codes as `agent` (cli-agent.ts). Every write is
 * checked, audited and refused on the server; the CLI only turns names into ids and wall times into epoch ms.
 *
 * @module cli-board
 */
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { EXIT, describeFailure, resolveChatRoom, runAgentVerb, type AgentDeps, type RequestOptions } from './cli-agent.js';
import { GLYPH, palette } from './cli-style.js';
import { zonedMs, zonedStamp } from './board-logic.js';
import { ISSUE_STATUSES, type BoardView, type Issue } from './board-types.js';

type Result = { ok: true; data: unknown } | { ok: false; code: number };

async function call(deps: AgentDeps, options: RequestOptions): Promise<Result> {
  const res = await deps.request(deps.ctx, options);
  if (res.json?.success) return { ok: true, data: res.json.data };
  fail(deps, describeFailure(res));
  return { ok: false, code: EXIT.error };
}

function fail(deps: AgentDeps, message: string): number {
  if (deps.json) deps.io.out(JSON.stringify({ success: false, error: message }));
  else deps.io.err(palette.err(`${GLYPH.fail} ${message}`));
  return EXIT.error;
}

/** Print a write's result: the item as JSON, or one line naming it and the new rev. */
function done(deps: AgentDeps, result: Result, what: (item: Record<string, unknown>) => string): number {
  if (!result.ok) return result.code;
  const data = result.data as { rev: number; item: Record<string, unknown> };
  if (deps.json) deps.io.out(JSON.stringify(data, null, 2));
  else deps.io.out(palette.ok(`${GLYPH.ok} ${what(data.item)} (rev ${data.rev})`));
  return EXIT.ok;
}

async function view(deps: AgentDeps): Promise<BoardView | undefined> {
  const result = await call(deps, { method: 'GET', path: '/api/board' });
  return result.ok ? (result.data as BoardView) : undefined;
}

/** A roster member by id or name (case-insensitive); an unknown name is an error, never a guess. */
export function memberRef(board: Pick<BoardView, 'roster'>, ref: string): string | { error: string } {
  const wanted = ref.trim().toLowerCase();
  const hits = board.roster.filter((m) => m.id === ref || m.name.toLowerCase() === wanted);
  if (hits.length === 1) return hits[0].id;
  return { error: hits.length ? `"${ref}" names ${hits.length} members; use the id` : `no member is called "${ref}"` };
}

/** 'YYYY-MM-DD' (07:00 for a start, 22:00 for an end, as the schedule draws day bars) or 'YYYY-MM-DDTHH:MM', in `timeZone`. */
export function wallTime(value: string, edge: 'start' | 'end', timeZone: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? zonedMs(value, edge === 'start' ? 7 : 22, timeZone) : zonedStamp(value, timeZone);
}

export interface IssueAddOptions {
  title: string;
  owner?: string;
  status?: string;
  reason?: string;
  tag?: string[];
  milestone?: string;
  link?: string[];
  start?: string;
  end?: string;
  scale?: 'hour' | 'day';
  from?: string;
}

export async function boardIssueAdd(deps: AgentDeps, options: IssueAddOptions): Promise<number> {
  const body: Record<string, unknown> = { title: options.title };
  if (options.status) body.status = options.status;
  if (options.reason) body.reason = options.reason;
  if (options.tag?.length) body.tags = options.tag;
  if (options.milestone) body.milestoneId = options.milestone;
  if (options.link?.length) body.links = options.link.map((url) => ({ url }));
  if (options.scale) body.scale = options.scale;
  if (options.owner || options.start || options.end) {
    const board = await view(deps);
    if (!board) return EXIT.error;
    if (options.owner) {
      const owner = memberRef(board, options.owner);
      if (typeof owner !== 'string') return fail(deps, owner.error);
      body.owner = owner;
    }
    try {
      if (options.start) body.start = wallTime(options.start, 'start', board.timeZone);
      if (options.end) body.end = wallTime(options.end, 'end', board.timeZone);
    } catch (err) {
      return fail(deps, (err as Error).message);
    }
  }
  if (options.from) {
    const at = options.from.lastIndexOf(':');
    if (at <= 0 || at === options.from.length - 1) return fail(deps, '--from takes ROOM:MESSAGE_ID');
    const room = await resolveChatRoom(deps, options.from.slice(0, at));
    if ('error' in room) return fail(deps, room.error);
    body.source = { roomId: room.room.id, messageId: options.from.slice(at + 1) };
  }
  const result = await call(deps, { method: 'POST', path: '/api/board/issues', body });
  return done(deps, result, (i) => `${i.id} "${i.title}" filed as ${i.status}`);
}

export async function boardIssueMove(deps: AgentDeps, options: { id: string; status: string; reason?: string }): Promise<number> {
  if (!(ISSUE_STATUSES as readonly string[]).includes(options.status)) {
    return fail(deps, `status is one of ${ISSUE_STATUSES.join('|')}`);
  }
  const body: Record<string, unknown> = { status: options.status };
  if (options.reason) body.reason = options.reason;
  const result = await call(deps, { method: 'PATCH', path: `/api/board/issues/${encodeURIComponent(options.id)}`, body });
  return done(deps, result, (i) => `${i.id} is now ${i.status}`);
}

/** Add (or with `remove`, drop) tags; sends the whole tag list with the rev it was read at, so a race is a 409. */
export async function boardIssueTag(deps: AgentDeps, options: { id: string; tags: string[]; remove?: boolean }): Promise<number> {
  const board = await view(deps);
  if (!board) return EXIT.error;
  const issue = board.issues.find((i: Issue) => i.id === options.id);
  if (!issue) return fail(deps, `no issue ${options.id}`);
  const tags = options.remove ? issue.tags.filter((t) => !options.tags.includes(t)) : [...new Set([...issue.tags, ...options.tags])];
  const result = await call(deps, {
    method: 'PATCH',
    path: `/api/board/issues/${encodeURIComponent(options.id)}`,
    body: { tags, ifRev: board.rev },
  });
  return done(deps, result, (i) => `${i.id} tags: ${(i.tags as string[]).join(', ') || '(none)'}`);
}

export async function boardShow(deps: AgentDeps): Promise<number> {
  const board = await view(deps);
  if (!board) return EXIT.error;
  if (deps.json) {
    deps.io.out(JSON.stringify(board, null, 2));
    return EXIT.ok;
  }
  const out = deps.io.out;
  const name = (id?: string, label?: string) => board.roster.find((m) => m.id === id)?.name ?? label ?? id ?? '-';
  out(palette.emph(`Board rev ${board.rev} · ${board.timeZone}`));
  for (const status of ISSUE_STATUSES) {
    const list = board.issues.filter((i) => i.status === status);
    if (status === 'wontdo' || status === 'done') {
      out(`${status}: ${list.length}`);
      continue;
    }
    out(palette.emph(`${status} (${list.length})`));
    for (const i of list) {
      out(`  ${i.id}  ${i.title}  · ${name(i.owner, i.ownerLabel)}${i.tags.length ? `  [${i.tags.join(', ')}]` : ''}${i.reason ? `  — ${i.reason}` : ''}`);
    }
  }
  for (const m of board.milestones) {
    const p = board.pace.milestones[m.id];
    out(`milestone ${m.id}  ${m.title}  due ${m.due}  ${p ? `${p.done}/${p.total} ${p.verdict}` : ''}`);
  }
  for (const [owner, p] of Object.entries(board.pace.owners)) {
    if (p.plannedToDate || p.early) out(`pace ${name(owner)}: ${p.verdict} (${p.doneOfPlanned}/${p.plannedToDate} due done, ${p.overdueHours} h overdue, ${p.early} early)`);
  }
  for (const b of board.blockers.filter((x) => !x.clearedAt)) out(palette.err(`blocker ${b.id}  [${b.sev}] ${b.text} · ${b.owner}`));
  for (const d of board.decisions.filter((x) => !x.clearedAt)) out(`decision ${d.id}  ${d.text}${d.where ? ` · ${d.where}` : ''}`);
  return EXIT.ok;
}

/** Import schedule-data.json (and optionally content.json); `--dry-run` reports counts and unmatched names only. */
export async function boardScheduleSet(deps: AgentDeps, options: { file: string; content?: string; dryRun?: boolean }): Promise<number> {
  let schedule: unknown;
  let content: unknown;
  try {
    schedule = JSON.parse(await readFile(options.file, 'utf8'));
    if (options.content) content = JSON.parse(await readFile(options.content, 'utf8'));
  } catch (err) {
    return fail(deps, `cannot read the import file: ${(err as Error).message}`);
  }
  const body: Record<string, unknown> = { schedule };
  if (content !== undefined) body.content = content;
  if (options.dryRun) body.dryRun = true;
  const result = await call(deps, { method: 'POST', path: '/api/board/import', body, timeoutMs: 60_000 });
  return done(deps, result, (s) => `${options.dryRun ? 'would import' : 'imported'} ${JSON.stringify(s)}`);
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Register `reverie board …` on the program. */
export function registerBoardCommands(program: Command): Command {
  const board = program.command('board').description("The server board: issues (timeline + kanban), milestones, wins, blockers, decisions");
  const json = (o: { json?: boolean }) => Boolean(o.json);
  const post = (path: string, what: (i: Record<string, unknown>) => string) => (deps: AgentDeps, body: Record<string, unknown>) =>
    call(deps, { method: 'POST', path, body }).then((r) => done(deps, r, what));

  board
    .command('show')
    .description('Print the board (issues by status, milestones, pace, open blockers and decisions)')
    .option('--json', 'The whole GET /api/board view')
    .action((o: { json?: boolean }) => runAgentVerb(json(o), boardShow));

  const issue = board.command('issue').alias('card').description('File, move and tag issues');
  issue
    .command('add')
    .description('File an issue (a non-coordinator always files into triage)')
    .requiredOption('--title <text>', 'Title')
    .option('--owner <member>', 'Owner: member id or name')
    .option('--status <status>', ISSUE_STATUSES.join('|'))
    .option('--reason <text>', 'Required for blocked and wontdo')
    .option('--tag <tag>', 'Tag (repeatable)', collect)
    .option('--milestone <id>', 'Milestone id')
    .option('--link <url>', 'Link (repeatable)', collect)
    .option('--start <when>', 'YYYY-MM-DD or YYYY-MM-DDTHH:MM, company time')
    .option('--end <when>', 'YYYY-MM-DD or YYYY-MM-DDTHH:MM, company time')
    .option('--scale <scale>', 'hour|day')
    .option('--from <room:msg>', 'The chat message this came from')
    .option('--json', 'Machine-readable output')
    .action((o: IssueAddOptions & { json?: boolean }) => runAgentVerb(json(o), (d) => boardIssueAdd(d, o)));
  issue
    .command('move <id> <status>')
    .description(`Move an issue (${ISSUE_STATUSES.join('|')}); done stamps doneAt`)
    .option('--reason <text>', 'Required for blocked and wontdo')
    .option('--json', 'Machine-readable output')
    .action((id: string, status: string, o: { reason?: string; json?: boolean }) =>
      runAgentVerb(json(o), (d) => boardIssueMove(d, { id, status, reason: o.reason }))
    );
  issue
    .command('tag <id> <tags...>')
    .description('Add tags to an issue (--remove drops them)')
    .option('--remove', 'Remove these tags instead')
    .option('--json', 'Machine-readable output')
    .action((id: string, tags: string[], o: { remove?: boolean; json?: boolean }) =>
      runAgentVerb(json(o), (d) => boardIssueTag(d, { id, tags, remove: o.remove }))
    );

  board
    .command('milestone')
    .description('Milestones')
    .command('add')
    .description('Add a milestone (coordinators)')
    .requiredOption('--title <text>', 'Title')
    .requiredOption('--due <date>', 'YYYY-MM-DD, company time')
    .option('--json', 'Machine-readable output')
    .action((o: { title: string; due: string; json?: boolean }) =>
      runAgentVerb(json(o), (d) => post('/api/board/milestones', (m) => `milestone ${m.id} "${m.title}" due ${m.due}`)(d, { title: o.title, due: o.due }))
    );

  board
    .command('win')
    .description('Wins')
    .command('add <text...>')
    .description('Record a win (any member)')
    .option('--who <name>', 'Who it is credited to')
    .option('--json', 'Machine-readable output')
    .action((words: string[], o: { who?: string; json?: boolean }) =>
      runAgentVerb(json(o), (d) => post('/api/board/wins', (w) => `win ${w.id}`)(d, { text: words.join(' '), ...(o.who ? { who: o.who } : {}) }))
    );

  for (const kind of ['blocker', 'decision'] as const) {
    const group = board.command(kind).description(`${kind === 'blocker' ? 'Blockers' : 'Decisions'} (coordinators; cleared, never deleted)`);
    const add = group.command('add <text...>').description(`Add a ${kind}`).option('--json', 'Machine-readable output');
    if (kind === 'blocker') {
      add
        .requiredOption('--owner <name>', 'Who can unblock it')
        .option('--who <name>', 'Who is blocked', 'All')
        .option('--sev <sev>', 'low|med|high', 'med');
    } else add.option('--where <text>', 'Where it is decided', '').option('--id <id>', 'A stable id');
    add.action((words: string[], o: Record<string, string | boolean | undefined>) => {
      const { json: asJson, ...rest } = o;
      return runAgentVerb(Boolean(asJson), (d) => post(`/api/board/${kind}s`, (x) => `${kind} ${x.id}`)(d, { text: words.join(' '), ...rest }));
    });
    group
      .command('clear <id>')
      .description(`Clear a ${kind}`)
      .option('--json', 'Machine-readable output')
      .action((id: string, o: { json?: boolean }) =>
        runAgentVerb(json(o), (d) => post(`/api/board/${kind}s/${encodeURIComponent(id)}/clear`, (x) => `${kind} ${x.id} cleared`)(d, {}))
      );
  }

  board
    .command('schedule')
    .description('The timeline')
    .command('set <file>')
    .description('Import a schedule-data.json as issues (coordinators); re-importing updates, never duplicates')
    .option('--content <file>', 'Also import a content.json (plans, focus, wins, blockers, decisions)')
    .option('--dry-run', 'Report what would change; write nothing')
    .option('--json', 'Machine-readable output')
    .action((file: string, o: { content?: string; dryRun?: boolean; json?: boolean }) =>
      runAgentVerb(json(o), (d) => boardScheduleSet(d, { file, ...o }))
    );
  return board;
}
