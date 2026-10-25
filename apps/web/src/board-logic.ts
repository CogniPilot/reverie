/**
 * @fileoverview Pure board logic: ahead/behind (pace) and the importers for the pre-console board files
 * (runtime/board/content.json and reports/schedule/schedule-data.json). No IO here.
 */
import { createHash } from 'node:crypto';
import type { BoardState, Issue, IssueStatus, Mark, Pace, RosterRow } from './board-types.js';

const HOUR = 3600_000;

/** Ahead/behind for a set of issues at `now`. Behind if anything is overdue; ahead if something finished early. */
export function paceOf(issues: readonly Issue[], now: number): Pace {
  let plannedToDate = 0;
  let doneOfPlanned = 0;
  let overdue = 0;
  let overdueMs = 0;
  let early = 0;
  for (const issue of issues) {
    if (issue.status === 'wontdo' || issue.end === undefined) continue;
    if (issue.status === 'done' && issue.doneAt !== undefined && issue.doneAt < issue.end) early++;
    if (issue.end > now) continue;
    plannedToDate++;
    if (issue.status === 'done') doneOfPlanned++;
    else {
      overdue++;
      overdueMs += now - issue.end;
    }
  }
  const verdict = overdue > 0 ? 'behind' : early > 0 ? 'ahead' : 'on-track';
  return { plannedToDate, doneOfPlanned, overdue, overdueHours: Math.round((overdueMs / HOUR) * 10) / 10, early, verdict };
}

/** Resolve display ownership only; ambiguous names stay unresolved and stored ownership is unchanged. */
export function boardOwnerIds(
  issues: readonly Pick<Issue, 'id' | 'owner' | 'ownerLabel'>[],
  roster: readonly Pick<RosterRow, 'id' | 'name'>[]
): Record<string, string> {
  const ids = new Set(roster.map(person => person.id));
  const names = new Map<string, string | null>();
  for (const person of roster) {
    const name = person.name.trim().toLowerCase();
    names.set(name, names.has(name) && names.get(name) !== person.id ? null : person.id);
  }
  return Object.fromEntries(issues.flatMap(issue => {
    const raw = issue.owner || issue.ownerLabel;
    if (!raw) return [];
    const id = ids.has(raw) ? raw : names.get(raw.trim().toLowerCase());
    return id ? [[issue.id, id]] : [];
  }));
}

/** Pace per owner and per milestone (milestones also get done/total over their non-wontdo issues). */
export function boardPace(state: Pick<BoardState, 'issues' | 'milestones'>, now: number, ownerIds: Readonly<Record<string, string>> = {}) {
  const byOwner = new Map<string, Issue[]>();
  const byMilestone = new Map<string, Issue[]>();
  for (const issue of state.issues) {
    const owner = Object.hasOwn(ownerIds, issue.id) ? ownerIds[issue.id] : issue.owner ?? issue.ownerLabel;
    if (owner) byOwner.set(owner, [...(byOwner.get(owner) ?? []), issue]);
    if (issue.milestoneId) byMilestone.set(issue.milestoneId, [...(byMilestone.get(issue.milestoneId) ?? []), issue]);
  }
  const owners: Record<string, Pace> = {};
  for (const [owner, list] of byOwner) owners[owner] = paceOf(list, now);
  const milestones: Record<string, Pace & { done: number; total: number }> = {};
  for (const m of state.milestones) {
    const list = (byMilestone.get(m.id) ?? []).filter((i) => i.status !== 'wontdo');
    milestones[m.id] = { ...paceOf(list, now), done: list.filter((i) => i.status === 'done').length, total: list.length };
  }
  return { owners, milestones };
}

/** Offset of `timeZone` from UTC at instant `at`, in ms. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000;
}

/** Wall-clock `date` (YYYY-MM-DD) plus `hours` in `timeZone` -> epoch ms. */
export function zonedMs(date: string, hours: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Not a date: ${date}`);
  const wall = Date.UTC(y, m - 1, d) + Math.round(hours * HOUR);
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

/** 'YYYY-MM-DDTHH:MM' (or a bare 'YYYY-MM-DD', read as midnight) wall time in `timeZone` -> epoch ms. */
export function zonedStamp(stamp: string, timeZone: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(stamp);
  if (!match) throw new Error(`Not a YYYY-MM-DD or YYYY-MM-DDTHH:MM time: ${stamp}`);
  return zonedMs(match[1], Number(match[2] ?? 0) + Number(match[3] ?? 0) / 60, timeZone);
}

/** Stable id for an imported entry, so a re-import updates instead of duplicating. */
export function importId(prefix: string, ...parts: Array<string | number | undefined>): string {
  return `${prefix}-${createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 10)}`;
}

/** Schedule `kind` -> issue status and tags. */
export function kindToIssue(kind: string, label: string): { status: IssueStatus; tags: string[]; reason?: string } {
  switch (kind) {
    case 'done':
      return { status: 'done', tags: [] };
    case 'now':
      return { status: 'doing', tags: [] };
    case 'blocked':
      return { status: 'blocked', tags: [], reason: label };
    case 'gate':
      return { status: 'todo', tags: ['gate'] };
    case 'cont':
      return { status: 'doing', tags: ['continuous'] };
    case 'sleep':
      return { status: 'todo', tags: ['sleep'] };
    default:
      return { status: 'todo', tags: [] };
  }
}

type Block = [number, number, string, string];
type Bar = [string, string, string, string];
export interface ScheduleFile {
  today?: { date: string; rows?: { who: string; sub?: string; blocks?: Block[] }[]; marks?: [number, string][] };
  twoweek?: { rows?: { who: string; sub?: string; bars?: Bar[] }[] };
}

export interface ImportResult {
  issues: Issue[];
  marks: Mark[];
  unmatched: string[];
}

/**
 * schedule-data.json -> issues. Hour blocks sit on `today.date`; day bars run 07:00 on the first day to 22:00 on the
 * last (the same spans build_board.py drew). Owners are matched by name; an unmatched name is kept as `ownerLabel`.
 */
export function importSchedule(
  file: ScheduleFile,
  memberByName: (name: string) => string | undefined,
  timeZone: string,
  now: number
): ImportResult {
  const issues: Issue[] = [];
  const unmatched = new Set<string>();
  const owner = (who: string) => {
    const id = memberByName(who);
    if (!id) unmatched.add(who);
    return id ? { owner: id } : { ownerLabel: who };
  };
  const add = (who: string, start: number, end: number, label: string, kind: string, scale: 'hour' | 'day') => {
    const mapped = kindToIssue(kind, label);
    issues.push({
      id: importId('i', who, start, end, label),
      title: label.slice(0, 300) || '(untitled)',
      ...owner(who),
      status: mapped.status,
      ...(mapped.reason ? { reason: mapped.reason.slice(0, 500) } : {}),
      tags: mapped.tags,
      links: [],
      start,
      end,
      scale,
      createdAt: now,
      updatedAt: now,
      ...(mapped.status === 'done' ? { doneAt: end } : {}),
    });
  };
  for (const row of file.twoweek?.rows ?? []) {
    for (const [a, b, label, kind] of row.bars ?? []) add(row.who, zonedMs(a, 7, timeZone), zonedMs(b, 22, timeZone), label, kind, 'day');
  }
  const today = file.today;
  if (today?.date) {
    for (const row of today.rows ?? []) {
      for (const [a, b, label, kind] of row.blocks ?? []) {
        add(row.who, zonedMs(today.date, a, timeZone), zonedMs(today.date, Math.max(b, a + 0.08), timeZone), label, kind, 'hour');
      }
    }
  }
  const marks = today?.date ? (today.marks ?? []).map(([h, label]) => ({ t: zonedMs(today.date, h, timeZone), label: label.slice(0, 100) })) : [];
  return { issues, marks, unmatched: [...unmatched] };
}

export interface ContentFile {
  plans?: Record<string, { name?: string; who?: string }>;
  agents?: { who: string; focus?: string; receipts?: string[] }[];
  wins?: { at: string; who: string; text: string }[];
  blockers?: { since: string; who: string; owner: string; sev: string; text: string }[];
  decisions?: { id: string; text: string; where?: string; options?: string[] }[];
}

/** content.json -> the stored parts of the board it carries. */
export function importContent(
  file: ContentFile,
  memberByName: (name: string) => string | undefined,
  timeZone: string,
  now: number,
  by: string
): Pick<BoardState, 'plans' | 'agents' | 'wins' | 'blockers' | 'decisions'> & { unmatched: string[] } {
  const unmatched: string[] = [];
  const agents: BoardState['agents'] = {};
  for (const a of file.agents ?? []) {
    const id = memberByName(a.who);
    if (!id) {
      unmatched.push(a.who);
      continue;
    }
    agents[id] = { focus: (a.focus ?? '').slice(0, 500), receipts: (a.receipts ?? []).slice(0, 20), updatedAt: now, updatedBy: by };
  }
  const sev = (s: string): 'low' | 'med' | 'high' => (s === 'low' || s === 'high' ? s : 'med');
  return {
    plans: Object.fromEntries(Object.entries(file.plans ?? {}).map(([label, p]) => [label, { name: p.name ?? '', who: p.who ?? '' }])),
    agents,
    wins: (file.wins ?? []).map((w) => {
      const at = zonedStamp(w.at, timeZone);
      return { id: importId('w', at, w.who, w.text), at, who: w.who, text: w.text };
    }),
    blockers: (file.blockers ?? []).map((b) => {
      const since = zonedStamp(b.since, timeZone);
      return { id: importId('b', since, b.who, b.text), since, who: b.who, owner: b.owner, sev: sev(b.sev), text: b.text };
    }),
    decisions: (file.decisions ?? []).map((d) => ({ id: d.id, text: d.text, where: d.where ?? '', ...(d.options ? { options: d.options } : {}), at: now })),
    unmatched,
  };
}

/** Upsert by id: replace entries with the same id in place, append new ones. Never removes anything. */
export function upsertById<T extends { id: string }>(list: T[], incoming: readonly T[], keep?: (old: T, next: T) => T): T[] {
  const out = [...list];
  const index = new Map(out.map((item, i) => [item.id, i]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, out.length);
      out.push(item);
    } else out[at] = keep ? keep(out[at], item) : item;
  }
  return out;
}
